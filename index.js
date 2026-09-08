/**
 * Frontend Token Count Estimator for TauriTavern
 *
 * Inspired by ST-Frontend-Tokenizer (https://github.com/GoldenglowMeow/ST-Frontend-Tokenizer, MIT).
 *
 * Chat-completion prompt assembly counts tokens one message at a time through
 * `/api/tokenizers/openai/count-batch`, executed by the host as serialized
 * Tauri invokes. On long chats this means hundreds of sequential IPC round
 * trips. This extension intercepts the OpenAI token-count endpoints and
 * answers them locally with an estimate, so counting becomes instant and no
 * request ever leaves the page.
 *
 * The estimate mirrors the backend contract
 * (`MiktikTokenizerRepository::count_openai_messages`, non-legacy path):
 *     3 tokens per message + 3 reply-priming tokens per request
 *     + the tokenized text of every message field + 1 token for a name field
 * with the tokenizer replaced by the same character-based heuristic the host
 * itself uses as a fallback (`token-count-broker.js`): CJK chars count as one
 * token each, everything else as 1/4 token.
 *
 * Deliberate pass-throughs (original request reaches the backend):
 * - `/api/tokenizers/openai/count-prefix-batch`: World Info path, already a
 *   single-flight batched request, and budget trimming depends on its accuracy
 * - `/api/tokenizers/{name}/encode` and `/decode` endpoints: features like
 *   logit bias need real token ids, which a character heuristic cannot produce
 * - empty-array requests (tokenizer warm-up), non-POST requests, and bodies
 *   that do not parse as an array
 *
 * The host bootstrap also patches `jQuery.ajax` (and re-applies its patch
 * after backend readiness, explicitly to undo third-party replacements), so
 * this extension installs a watchdog that re-asserts its interceptor whenever
 * it gets displaced, plus a one-shot diagnostic notification that reports
 * whether counting is really being answered locally:
 *   - "拦截生效"     -> estimates served locally, backend saw zero counts
 *   - "部分生效"     -> both local estimates and backend counts happened
 *   - "拦截未生效"   -> all counting still reaches the backend
 *
 * Runtime controls (desktop console):
 *   __TT_FRONTEND_TOKENIZER__.enabled = false  // disable, then reload
 *   __TT_FRONTEND_TOKENIZER__.stats             // { intercepted, passedThrough, reasserted, ... }
 */

const COUNT_ENDPOINT = '/api/tokenizers/openai/count';
const BATCH_ENDPOINT = '/api/tokenizers/openai/count-batch';
const CJK_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g;
const EXTENSION_VERSION = '2.2.0';
/** Invoke-broker commands whose counters reveal backend-side token counting. */
const BACKEND_COUNT_COMMANDS = ['count_openai_tokens', 'count_openai_tokens_batch'];

/** Character-level token estimate, identical to the host's fallback heuristic. */
function estimateTextTokens(text) {
    const str = typeof text === 'string' ? text : String(text ?? '');
    if (!str) {
        return 0;
    }
    const cjkMatches = str.match(CJK_REGEX);
    const cjk = cjkMatches ? cjkMatches.length : 0;
    const other = str.length - cjk;
    return Math.max(0, Math.ceil(cjk + other / 4));
}

/** Mirrors the backend's `value_to_text`: strings stay, anything else is JSON. */
function valueToText(value) {
    if (typeof value === 'string') {
        return value;
    }
    if (value === undefined || value === null) {
        return '';
    }
    return JSON.stringify(value) ?? '';
}

/**
 * Token overhead of one message's fields, excluding the per-message wrapper.
 * @param {any} message
 * @returns {number}
 */
function estimateMessageFields(message) {
    if (message && typeof message === 'object' && !Array.isArray(message)) {
        let total = 0;
        for (const [key, value] of Object.entries(message)) {
            total += estimateTextTokens(valueToText(value));
            if (key === 'name') {
                total += 1;
            }
        }
        return total;
    }
    return estimateTextTokens(valueToText(message));
}

/**
 * Estimated count for one counting request over the given messages
 * (3 per message + fields + 3 reply priming).
 * @param {any[]} messages
 * @returns {number}
 */
function estimateMessageRequest(messages) {
    let total = 3;
    for (const message of messages) {
        total += 3 + estimateMessageFields(message);
    }
    return total;
}

/**
 * Best-effort user-visible notification.
 * @param {string} message
 */
function showNotification(message) {
    try {
        const toastr = globalThis.toastr;
        if (toastr && typeof toastr.info === 'function') {
            toastr.info(message, 'Frontend Token Estimator', { timeOut: 10_000 });
        }
    } catch {
        // Best-effort only.
    }
}

/** Announces activation once per page load. */
function announceInstall() {
    const state = globalThis.__TT_FRONTEND_TOKENIZER__;
    if (state?.announced) {
        return;
    }
    if (state) {
        state.announced = true;
    }
    showNotification(`前端 Token 估算已启用（v${EXTENSION_VERSION}）`);
}

/**
 * Installs the interceptor on a jQuery-like object.
 * Exposed for testability; the extension auto-installs on the page's jQuery.
 * @param {{ ajax: Function, Deferred?: Function }} jQueryLike
 * @returns {boolean} True if the interceptor was (or already had been) installed.
 */
export function installFrontendTokenizer(jQueryLike) {
    if (!jQueryLike || typeof jQueryLike.ajax !== 'function') {
        console.warn('[Frontend Tokenizer] jQuery-like object with an ajax function is required');
        return false;
    }

    if (jQueryLike.ajax.__ttFrontendTokenizer) {
        return true;
    }

    const originalAjax = jQueryLike.ajax;

    // Read at call time so the toggle can be flipped after installation.
    const isEnabled = () => globalThis.__TT_FRONTEND_TOKENIZER__?.enabled !== false;

    // Runtime stats for quick verification (see module docs):
    // { intercepted, passedThrough, installedAt, reasserted? }
    const stats = globalThis.__TT_FRONTEND_TOKENIZER__?.stats ?? {
        intercepted: 0,
        passedThrough: 0,
        installedAt: new Date().toISOString(),
    };
    globalThis.__TT_FRONTEND_TOKENIZER__ = {
        ...(globalThis.__TT_FRONTEND_TOKENIZER__ ?? {}),
        stats,
    };

    /**
     * @returns {object|null} Mock response data, or null when the call must
     * be passed through to the real backend.
     */
    function tryIntercept(settings) {
        // Exact-path matching so sibling endpoints (count-prefix-batch) never match.
        const path = String(settings.url || '').split('?')[0].split('#')[0];
        let batch = false;
        if (path === BATCH_ENDPOINT) {
            batch = true;
        } else if (path === COUNT_ENDPOINT) {
            batch = false;
        } else {
            return null;
        }

        const method = String(settings.type || settings.method || 'GET').toUpperCase();
        if (method !== 'POST') {
            return null;
        }

        let body = null;
        try {
            body = JSON.parse(settings.data);
        } catch {
            return null;
        }
        // Empty arrays are tokenizer warm-ups that must reach the backend.
        if (!Array.isArray(body) || body.length === 0) {
            return null;
        }

        if (batch) {
            return { token_counts: body.map((message) => estimateMessageRequest([message])) };
        }
        return { token_count: estimateMessageRequest(body) };
    }

    const patchedAjax = function (urlOrSettings, maybeSettings) {
        let settings = urlOrSettings;
        if (typeof urlOrSettings === 'string' && maybeSettings && typeof maybeSettings === 'object') {
            settings = { ...maybeSettings, url: urlOrSettings };
        }

        if (settings && typeof settings === 'object' && isEnabled()) {
            let responseData = null;
            try {
                responseData = tryIntercept(settings);
            } catch (error) {
                console.warn('[Frontend Tokenizer] interception failed, passing request through', error);
            }

            if (responseData) {
                stats.intercepted += 1;
                if (typeof settings.success === 'function') {
                    // Synchronous invocation also satisfies the deprecated
                    // async:false call sites that read closure variables
                    // immediately after jQuery.ajax returns.
                    settings.success(responseData);
                }
                if (typeof jQueryLike.Deferred === 'function') {
                    const deferred = jQueryLike.Deferred();
                    deferred.resolve(responseData);
                    return deferred.promise();
                }
                return Promise.resolve(responseData);
            }
        }

        stats.passedThrough += 1;
        return originalAjax.apply(this, arguments);
    };
    patchedAjax.__ttFrontendTokenizer = true;
    jQueryLike.ajax = patchedAjax;
    console.log('[Frontend Tokenizer] Patched jQuery.ajax; token counting is now estimated locally');
    announceInstall();
    return true;
}

/**
 * Sums the invoke-broker transport counters for backend token-count commands.
 * @returns {number|null} Total transportInvokes, or null when unavailable.
 */
function readBrokerCountTotals() {
    let stats = null;
    try {
        stats = globalThis.__TAURITAVERN__?.invoke?.broker?.getStats?.();
    } catch {
        return null;
    }
    if (!stats || typeof stats !== 'object') {
        return null;
    }

    let total = 0;
    for (const command of BACKEND_COUNT_COMMANDS) {
        const entry = stats[command];
        if (entry && typeof entry.transportInvokes === 'number') {
            total += entry.transportInvokes;
        }
    }
    return total;
}

/**
 * Watchdog that keeps the interceptor as the outermost jQuery.ajax patch
 * (the host re-applies its own patch after backend readiness, which would
 * otherwise bury ours) and reports once whether counting is actually being
 * answered locally, by cross-checking the invoke-broker counters.
 *
 * @param {() => any} getJQuery Accessor for the current jQuery-like object.
 * @param {{ notify?: (message: string) => void, threshold?: number }} [options]
 * @returns {{ tick: () => void, backendCountDelta: () => number }}
 */
export function activateFrontendTokenizerGuard(getJQuery, { notify = () => {}, threshold = 20 } = {}) {
    if (typeof getJQuery !== 'function') {
        throw new TypeError('activateFrontendTokenizerGuard requires a getJQuery function');
    }

    const baselineTotals = readBrokerCountTotals();
    let burstNotified = false;
    let displacementNotified = false;

    const backendCountDelta = () => {
        const totals = readBrokerCountTotals();
        if (totals === null || baselineTotals === null) {
            return 0;
        }
        return Math.max(0, totals - baselineTotals);
    };

    const getStats = () => globalThis.__TT_FRONTEND_TOKENIZER__?.stats
        ?? { intercepted: 0, passedThrough: 0 };

    /**
     * @param {number} intercepted
     * @param {number} backendDelta
     * @param {number} reasserted
     * @returns {string}
     */
    function burstMessage(intercepted, backendDelta, reasserted) {
        let message;
        if (intercepted === 0 && backendDelta > 0) {
            message = `拦截未生效：后端已计数 ${backendDelta} 次，本地估算 0 次`;
        } else if (backendDelta === 0) {
            message = `拦截生效：已本地估算 ${intercepted} 次，后端计数 0 次`;
        } else {
            message = `部分生效：本地估算 ${intercepted} 次，后端仍在计数 ${backendDelta} 次`;
        }
        if (reasserted > 0) {
            message += `（补丁被覆盖后已自动恢复 ${reasserted} 次）`;
        }
        return message;
    }

    function tick() {
        const jQueryLike = getJQuery();
        if (!jQueryLike || typeof jQueryLike.ajax !== 'function') {
            return;
        }

        // Re-assert the interceptor if anything replaced it (host re-patch,
        // other extensions, page scripts).
        if (jQueryLike.ajax.__ttFrontendTokenizer !== true) {
            installFrontendTokenizer(jQueryLike);
            const stats = getStats();
            stats.reasserted = (stats.reasserted || 0) + 1;
            console.warn('[Frontend Tokenizer] jQuery.ajax patch was displaced; re-asserted');
            if (!displacementNotified) {
                displacementNotified = true;
                notify('检测到 jQuery.ajax 补丁被覆盖，已自动恢复拦截');
            }
        }

        // One-shot diagnostic once a generation-scale burst of counting happened.
        if (!burstNotified) {
            const stats = getStats();
            const intercepted = stats.intercepted || 0;
            const backendDelta = backendCountDelta();
            if (intercepted >= threshold || backendDelta >= threshold) {
                burstNotified = true;
                notify(burstMessage(intercepted, backendDelta, stats.reasserted || 0));
            }
        }
    }

    return { tick, backendCountDelta };
}

if (typeof globalThis.jQuery !== 'undefined') {
    installFrontendTokenizer(globalThis.jQuery);
    const guard = activateFrontendTokenizerGuard(() => globalThis.jQuery, { notify: showNotification });
    const guardTimer = setInterval(() => guard.tick(), 1500);
    // Do not keep Node test contexts alive on account of the watchdog.
    guardTimer?.unref?.();
}
