/**
 * Token Count Batch Coalescer
 *
 * The chat-completion prompt assembly counts tokens one message at a time:
 * every `Message.createAsync` / `setName` call issues its own POST to
 * `/api/tokenizers/openai/count-batch`, which the host executes through a
 * serialized Tauri invoke. On long chats this means hundreds of sequential
 * IPC round trips (and a second full pass when names are sent as completions).
 *
 * This extension patches `jQuery.ajax` at runtime and merges every burst of
 * tokenizer requests (same model, arriving within a short coalescing window)
 * into ONE batched request, deduplicating messages already counted in this
 * session. Results are mapped back per caller, so the tokenizer module sees
 * exactly the responses it expects. No source files are modified.
 *
 * Deliberate pass-throughs (original behavior preserved):
 * - synchronous requests (`async: false`, used by the deprecated sync path)
 * - empty-array requests (tokenizer warm-up must reach the backend)
 * - legacy `/count` calls carrying more than one message (their response is a
 *   single total, not per-message counts)
 * - any request whose body cannot be parsed, and all non-tokenizer requests
 */

const BATCH_ENDPOINT = '/api/tokenizers/openai/count-batch';
const LEGACY_ENDPOINT = '/api/tokenizers/openai/count';
// A burst of per-message counts (e.g. Promise.all over a 12-message chunk)
// fires within one microtask cascade, so a macrotask timer reliably captures
// the whole burst while adding imperceptible latency.
const FLUSH_DELAY_MS = 10;
const SESSION_CACHE_LIMIT = 10_000;
// After a failed coalesced request, stop intercepting for a while so callers
// fall back to their own legacy/guesstimate handling instead of hammering a
// dead endpoint through repeated coalesced retries.
const FAILURE_BYPASS_MS = 5_000;

/**
 * Installs the ajax interceptor on a jQuery-like object.
 * Exposed for testability; the extension auto-installs on the page's jQuery.
 * @param {{ ajax: Function, Deferred?: Function }} jQueryLike
 * @param {{ makeDeferred?: () => { resolve: Function, reject: Function, promise: () => any },
 *           schedule?: (fn: () => void, ms: number) => any,
 *           now?: () => number }} [options]
 * @returns {boolean} True if the interceptor was (or already had been) installed.
 */
export function installTokenCountCoalescer(jQueryLike, options = {}) {
    if (!jQueryLike || typeof jQueryLike.ajax !== 'function') {
        console.warn('Token Count Coalescer: jQuery-like object with an ajax function is required');
        return false;
    }

    if (jQueryLike.ajax.__ttTokenCountCoalescer) {
        return true;
    }

    const originalAjax = jQueryLike.ajax;
    const makeDeferred = options.makeDeferred ?? (() => jQueryLike.Deferred());
    const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    const now = options.now ?? (() => Date.now());

    /** Session-scoped cache: `${model}\u0000${messageJson}` -> token count */
    const sessionCache = new Map();
    let bypassUntil = 0;
    /** model -> { entries: [{messages, legacy, deferred}], timer } */
    const pendingByModel = new Map();

    const cacheKey = (model, messageJson) => `${model}\u0000${messageJson}`;

    function rememberSessionCount(key, count) {
        if (sessionCache.size >= SESSION_CACHE_LIMIT) {
            // Map preserves insertion order; drop the oldest entry.
            sessionCache.delete(sessionCache.keys().next().value);
        }
        sessionCache.set(key, count);
    }

    function extractModel(url) {
        const queryIndex = url.indexOf('?');
        const params = new URLSearchParams(queryIndex >= 0 ? url.slice(queryIndex + 1) : '');
        return params.get('model') ?? '';
    }

    function flush(model) {
        const state = pendingByModel.get(model);
        pendingByModel.delete(model);
        if (!state) {
            return;
        }

        const entries = state.entries;
        const misses = [];
        const missIndexByJson = new Map();

        for (const entry of entries) {
            for (const message of entry.messages) {
                const messageJson = JSON.stringify(message);
                if (sessionCache.has(cacheKey(model, messageJson))) {
                    continue;
                }
                if (!missIndexByJson.has(messageJson)) {
                    missIndexByJson.set(messageJson, misses.length);
                    misses.push(message);
                }
            }
        }

        const resolveEntries = (countsByJson) => {
            for (const entry of entries) {
                const counts = entry.messages.map((message) => {
                    const messageJson = JSON.stringify(message);
                    const cached = sessionCache.get(cacheKey(model, messageJson));
                    if (cached !== undefined) {
                        return cached;
                    }
                    return countsByJson.get(messageJson);
                });
                if (entry.legacy) {
                    entry.deferred.resolve({ token_count: counts[0] });
                } else {
                    entry.deferred.resolve({ token_counts: counts });
                }
            }
        };

        if (misses.length === 0) {
            resolveEntries(new Map());
            return;
        }

        originalAjax.call(jQueryLike, {
            async: true,
            type: 'POST',
            url: `${BATCH_ENDPOINT}?model=${encodeURIComponent(model)}`,
            data: JSON.stringify(misses),
            dataType: 'json',
            contentType: 'application/json',
        }).then(
            (data) => {
                const tokenCounts = Array.isArray(data?.token_counts) ? data.token_counts : null;
                if (!tokenCounts || tokenCounts.length !== misses.length) {
                    for (const entry of entries) {
                        entry.deferred.reject(new Error('Token Count Coalescer: unexpected batch response shape'));
                    }
                    return;
                }
                const countsByJson = new Map();
                missIndexByJson.forEach((index, messageJson) => {
                    const count = Number(tokenCounts[index]);
                    if (Number.isFinite(count)) {
                        countsByJson.set(messageJson, count);
                        rememberSessionCount(cacheKey(model, messageJson), count);
                    }
                });
                resolveEntries(countsByJson);
            },
            (error) => {
                bypassUntil = now() + FAILURE_BYPASS_MS;
                for (const entry of entries) {
                    entry.deferred.reject(error);
                }
            },
        );
    }

    /**
     * @returns {any} A thenable to return from the patched ajax, or null when
     * the call must be passed through untouched.
     */
    function tryIntercept(settings) {
        // Compare the exact path so sibling endpoints such as
        // `/count-prefix-batch` never match the legacy `/count` prefix.
        const url = String(settings.url || '');
        const path = url.split('?')[0].split('#')[0];
        let legacy = false;
        if (path === BATCH_ENDPOINT) {
            legacy = false;
        } else if (path === LEGACY_ENDPOINT) {
            legacy = true;
        } else {
            return null;
        }

        if (String(settings.type || '').toUpperCase() !== 'POST') {
            return null;
        }
        // The deprecated synchronous counting path depends on the request
        // completing before $.ajax returns; never defer those calls.
        if (settings.async === false) {
            return null;
        }

        let messages = null;
        try {
            messages = JSON.parse(settings.data);
        } catch {
            return null;
        }
        // Empty arrays are tokenizer warm-ups that must reach the backend.
        if (!Array.isArray(messages) || messages.length === 0) {
            return null;
        }
        // Only single-message legacy calls have per-message batch semantics.
        if (legacy && messages.length !== 1) {
            return null;
        }

        const model = extractModel(url);
        const deferred = makeDeferred();
        let state = pendingByModel.get(model);
        if (!state) {
            state = { entries: [], timer: null };
            pendingByModel.set(model, state);
        }
        state.entries.push({ messages, legacy, deferred });
        if (state.timer === null) {
            state.timer = schedule(() => {
                state.timer = null;
                flush(model);
            }, FLUSH_DELAY_MS);
        }
        return deferred.promise();
    }

    const patchedAjax = function (urlOrSettings, maybeSettings) {
        let settings = urlOrSettings;
        if (typeof urlOrSettings === 'string' && maybeSettings && typeof maybeSettings === 'object') {
            settings = { ...maybeSettings, url: urlOrSettings };
        }
        if (settings && typeof settings === 'object' && now() >= bypassUntil) {
            try {
                const promise = tryIntercept(settings);
                if (promise) {
                    return promise;
                }
            } catch (error) {
                console.warn('Token Count Coalescer: interception failed, passing request through', error);
            }
        }
        return originalAjax.apply(this, arguments);
    };
    patchedAjax.__ttTokenCountCoalescer = true;
    jQueryLike.ajax = patchedAjax;
    console.debug('Token Count Coalescer: ajax interceptor installed');
    return true;
}

if (typeof globalThis.jQuery !== 'undefined') {
    installTokenCountCoalescer(globalThis.jQuery);
}
