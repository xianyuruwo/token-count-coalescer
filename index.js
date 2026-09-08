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
 * Toggle at runtime with `__TT_FRONTEND_TOKENIZER__.enabled = false`
 * (then reload) to compare estimates against real counts.
 */

const COUNT_ENDPOINT = '/api/tokenizers/openai/count';
const BATCH_ENDPOINT = '/api/tokenizers/openai/count-batch';
const CJK_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g;

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

        return originalAjax.apply(this, arguments);
    };
    patchedAjax.__ttFrontendTokenizer = true;
    jQueryLike.ajax = patchedAjax;
    console.log('[Frontend Tokenizer] Patched jQuery.ajax; token counting is now estimated locally');
    return true;
}

if (typeof globalThis.jQuery !== 'undefined') {
    installFrontendTokenizer(globalThis.jQuery);
}
