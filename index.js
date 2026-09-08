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
 * The host bootstrap (and possibly sibling extensions) re-apply their own
 * `jQuery.ajax` patch after this extension loads, burying the interceptor.
 * A watchdog re-asserts it whenever displaced.
 *
 * Performance profiler (v3.0.0): because slow prompt assembly is not always
 * caused by token counting, the extension also measures where page time goes:
 *   - main-thread long tasks (PerformanceObserver) and timer drift
 *   - wall time of every ajax/fetch request passed through to the host
 * v3.1.0 closes the two remaining invisible async sinks:
 *   - Tauri invokes (`window.__TAURI__.core.invoke`): the native regex batch,
 *     chat saves, etc. bypass the fetch patch because the Tauri runtime holds
 *     its own transport; each invoke is now timed by command name
 *   - IndexedDB reads/writes (localforage token cache / settings buckets)
 * v3.2.0 closes the last ones:
 *   - the host ABI's invoke broker (`__TAURITAVERN__.invoke.broker.invoke`):
 *     patching `__TAURI__.core.invoke` can silently fail (the injected `core`
 *     object may expose getters) or be bypassed by early-bound references,
 *     while every `safeInvoke` in the app resolves `broker.invoke` dynamically
 *     on a plain writable object — wrapping it catches all routed traffic
 *   - long `setTimeout` delays and throttled `requestAnimationFrame` gaps,
 *     which are pure waiting time invisible to every other meter
 * After a busy period it pops a summary toast ("TT 性能剖析") stating whether
 * the time was spent blocking the main thread, waiting on HTTP requests,
 * waiting on Tauri invokes (with per-command totals), or in IndexedDB.
 * A small floating "Σ" button re-shows the report on demand
 * (double-tap hides it).
 *
 * Runtime controls (desktop console):
 *   __TT_FRONTEND_TOKENIZER__.enabled = false  // disable estimator, reload
 *   __TT_FRONTEND_TOKENIZER__.stats             // { intercepted, passedThrough, reasserted, ... }
 *   __TT_FRONTEND_TOKENIZER__.profile()         // profiler snapshot object
 */

const COUNT_ENDPOINT = '/api/tokenizers/openai/count';
const BATCH_ENDPOINT = '/api/tokenizers/openai/count-batch';
const CJK_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g;
const EXTENSION_VERSION = '3.4.0';
/** Invoke-broker commands whose counters reveal backend-side token counting. */
const BACKEND_COUNT_COMMANDS = ['count_openai_tokens', 'count_openai_tokens_batch'];
/** Profiler: report once a window accumulates this much busy time (ms). */
const PROFILE_AUTO_THRESHOLD_MS = 2_000;
/** Profiler: report only after activity has been quiet for this long (ms). */
const PROFILE_QUIET_MS = 3_000;
/** Profiler: minimum spacing between automatic reports (ms). */
const PROFILE_MIN_INTERVAL_MS = 30_000;
/** Profiler: watchdog tick interval (ms); also drives the drift meter. */
const PROFILE_TICK_MS = 300;
/** Profiler: timer lateness below this is treated as jitter, not blocking. */
const PROFILE_DRIFT_MIN_MS = 100;

/** @type {{ recordAjax: (path: string, ms: number) => void } | null} Set by page init. */
let activeProfiler = null;

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

/** Request path without query/hash, for endpoint labels. */
function requestPathOf(url) {
    return String(url || '').split('?')[0].split('#')[0];
}

/**
 * Best-effort user-visible notification.
 * @param {string} message
 * @param {number} [timeOut]
 */
function showNotification(message, timeOut = 10_000) {
    try {
        const toastr = globalThis.toastr;
        if (toastr && typeof toastr.info === 'function') {
            toastr.info(message, 'Frontend Token Estimator', { timeOut, escapeHtml: false });
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
        const path = requestPathOf(settings.url);
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
        const path = requestPathOf(settings?.url);
        const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const elapsed = () => Math.max(0, (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt);
        let result;
        try {
            result = originalAjax.apply(this, arguments);
        } catch (error) {
            activeProfiler?.recordAjax(path, elapsed());
            throw error;
        }
        if (activeProfiler) {
            try {
                // jqXHR and promises settle later; measure until then. For
                // sync (async:false) XHRs the deferred is already resolved,
                // so the timing is equally accurate on the microtask.
                Promise.resolve(result).finally(() => {
                    activeProfiler?.recordAjax(path, elapsed());
                }).catch(() => {
                    // Only silences the timing chain, not the caller's promise.
                });
            } catch {
                // Non-thenable result: record synchronously.
                activeProfiler.recordAjax(path, elapsed());
            }
        }
        return result;
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
            // Log a snippet of the displacer to help identify who buried us.
            try {
                const displacer = String(jQueryLike.ajax).slice(0, 120).replace(/\s+/g, ' ');
                console.warn('[Frontend Tokenizer] jQuery.ajax patch was displaced by:', displacer);
            } catch {
                console.warn('[Frontend Tokenizer] jQuery.ajax patch was displaced');
            }
            installFrontendTokenizer(jQueryLike);
            const stats = getStats();
            stats.reasserted = (stats.reasserted || 0) + 1;
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

/** @param {number} ms */
function fmtSeconds(ms) {
    return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Measures where page time goes during slow operations so the actual
 * bottleneck can be identified without dev tools.
 *
 * @param {{
 *   notify?: (message: string) => void,
 *   backendCountDelta?: () => number,
 *   now?: () => number,
 *   isHidden?: () => boolean,
 *   tickMs?: number,
 * }} [options]
 * @returns {{
 *   tick: () => void,
 *   recordAjax: (path: string, ms: number) => void,
 *   recordLongTask: (ms: number) => void,
 *   recordInvoke: (command: string, ms: number) => void,
 *   recordIdb: (op: string, ms: number) => void,
 *   snapshot: () => object,
 *   reportNow: () => string,
 * }}
 */
export function createProfiler(options = {}) {
    const notify = options.notify ?? (() => {});
    const backendCountDelta = options.backendCountDelta ?? (() => 0);
    const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    const isHidden = options.isHidden ?? (() => typeof document !== 'undefined' && document.hidden);
    const tickMs = options.tickMs ?? PROFILE_TICK_MS;

    let windowState = emptyWindow();
    let lastTickAt = null;
    let lastActivityAt = null;
    let lastReportAt = -Infinity;
    let lastSeenIntercepted = 0;
    let lastSeenReasserted = 0;
    let lastSeenRegexCacheHits = 0;

    function emptyWindow() {
        return {
            startedAt: Date.now(),
            longTaskMs: 0,
            longTaskCount: 0,
            maxLongTaskMs: 0,
            driftMs: 0,
            ajaxCount: 0,
            ajaxMs: 0,
            ajaxMaxMs: 0,
            ajaxByPath: new Map(),
            invokeCount: 0,
            invokeMs: 0,
            invokeByCommand: new Map(),
            idbCount: 0,
            idbMs: 0,
            idbByOp: new Map(),
            timerCount: 0,
            timerMs: 0,
            timerByDelay: new Map(),
            rafCount: 0,
            rafGapMs: 0,
        };
    }

    function noteActivity() {
        lastActivityAt = now();
    }

    /**
     * @param {Map<string, {count: number, ms: number, maxMs: number}>} map
     * @param {string} key
     * @param {number} ms
     */
    function bumpEntry(map, key, ms) {
        const entry = map.get(key) ?? { count: 0, ms: 0, maxMs: 0 };
        entry.count += 1;
        entry.ms += ms;
        entry.maxMs = Math.max(entry.maxMs, ms);
        map.set(key, entry);
    }

    /**
     * @param {Map<string, {count: number, ms: number, maxMs: number}>} map
     * @param {number} limit
     * @returns {string} "cmd ×N (Xs, max Ys)" fragments joined by 、
     */
    function topEntries(map, limit) {
        return [...map.entries()]
            .sort((a, b) => b[1].ms - a[1].ms)
            .slice(0, limit)
            .map(([key, entry]) => `${key} ×${entry.count} (${fmtSeconds(entry.ms)}${entry.count > 1 ? `, 最长 ${fmtSeconds(entry.maxMs)}` : ''})`)
            .join('、');
    }

    function recordAjax(path, ms) {
        const w = windowState;
        w.ajaxCount += 1;
        w.ajaxMs += ms;
        w.ajaxMaxMs = Math.max(w.ajaxMaxMs, ms);
        bumpEntry(w.ajaxByPath, path, ms);
        noteActivity();
    }

    function recordLongTask(ms) {
        const w = windowState;
        w.longTaskMs += ms;
        w.longTaskCount += 1;
        w.maxLongTaskMs = Math.max(w.maxLongTaskMs, ms);
        noteActivity();
    }

    function recordInvoke(command, ms) {
        const w = windowState;
        w.invokeCount += 1;
        w.invokeMs += ms;
        bumpEntry(w.invokeByCommand, String(command || 'unknown'), ms);
        noteActivity();
    }

    function recordIdb(op, ms) {
        const w = windowState;
        w.idbCount += 1;
        w.idbMs += ms;
        bumpEntry(w.idbByOp, String(op || 'idb'), ms);
        noteActivity();
    }

    /**
     * A scheduled timer finally fired after `ms` of requested delay.
     * Pure waiting time (delays, backoff, polling) is invisible elsewhere.
     * @param {number} scheduledMs
     * @param {number} actualMs
     */
    function recordTimer(scheduledMs, actualMs) {
        const w = windowState;
        w.timerCount += 1;
        w.timerMs += actualMs;
        bumpEntry(w.timerByDelay, `${Math.round(scheduledMs)}ms`, actualMs);
        noteActivity();
    }

    /** A requestAnimationFrame callback fired `gapMs` after scheduling. */
    function recordRafGap(gapMs) {
        const w = windowState;
        w.rafCount += 1;
        w.rafGapMs += gapMs;
        noteActivity();
    }

    /**
     * @param {ReturnType<typeof emptyWindow>} w
     * @returns {string} Multi-line report using <br> for toastr.
     */
    function buildReport(w) {
        const stats = globalThis.__TT_FRONTEND_TOKENIZER__?.stats
            ?? { intercepted: 0, passedThrough: 0, reasserted: 0 };
        const interceptedDelta = (stats.intercepted || 0) - lastSeenIntercepted;
        const reassertedDelta = (stats.reasserted || 0) - lastSeenReasserted;
        const regexCacheHitsDelta = (stats.regexCacheHits || 0) - lastSeenRegexCacheHits;
        const elapsedMs = Date.now() - w.startedAt;
        const busyMs = Math.max(w.longTaskMs, w.driftMs);

        const lines = [
            `TT 性能剖析（最近 ${(elapsedMs / 1000).toFixed(1)}s）：`,
            `主线程繁忙 ${fmtSeconds(busyMs)}（长任务 ${fmtSeconds(w.longTaskMs)}/${w.longTaskCount} 次，最大 ${fmtSeconds(w.maxLongTaskMs)}；计时漂移 ${fmtSeconds(w.driftMs)}）`,
            `HTTP 请求 ${w.ajaxCount} 次，共 ${fmtSeconds(w.ajaxMs)}（最慢单次 ${fmtSeconds(w.ajaxMaxMs)}）`,
        ];
        if (w.ajaxByPath.size > 0) {
            lines.push(`最耗时请求：${topEntries(w.ajaxByPath, 3)}`);
        }
        lines.push(`Tauri 调用 ${w.invokeCount} 次，共 ${fmtSeconds(w.invokeMs)}`);
        if (w.invokeByCommand.size > 0) {
            lines.push(`最耗时调用：${topEntries(w.invokeByCommand, 4)}`);
        }
        if (w.idbCount > 0) {
            lines.push(`IndexedDB ${w.idbCount} 次，共 ${fmtSeconds(w.idbMs)}${w.idbByOp.size > 0 ? `（${topEntries(w.idbByOp, 2)}）` : ''}`);
        }
        if (w.timerCount > 0) {
            lines.push(`定时器等待 ${w.timerCount} 次，共 ${fmtSeconds(w.timerMs)}${w.timerByDelay.size > 0 ? `（${topEntries(w.timerByDelay, 4)}）` : ''}`);
        }
        if (w.rafCount > 0) {
            lines.push(`rAF 延迟 ${w.rafCount} 次，共 ${fmtSeconds(w.rafGapMs)}`);
        }
        lines.push(`本地估算 ${interceptedDelta} 次｜补丁恢复 ${reassertedDelta} 次｜后端计数 ${backendCountDelta()} 次`);
        if (regexCacheHitsDelta > 0) {
            lines.push(`正则批处理缓存命中 ${regexCacheHitsDelta} 次（跳过 Rust 调用）`);
        }
        return lines.join('<br>');
    }

    function resetWindow() {
        const stats = globalThis.__TT_FRONTEND_TOKENIZER__?.stats;
        if (stats) {
            lastSeenIntercepted = stats.intercepted || 0;
            lastSeenReasserted = stats.reasserted || 0;
            lastSeenRegexCacheHits = stats.regexCacheHits || 0;
        }
        windowState = emptyWindow();
    }

    function reportNow() {
        const message = buildReport(windowState);
        notify(message);
        return message;
    }

    function tick() {
        const t = now();

        // Timer lateness approximates main-thread blocking that individual
        // long tasks below the 50ms threshold still cause in aggregate.
        if (lastTickAt !== null) {
            const lateness = t - lastTickAt - tickMs;
            if (lateness >= PROFILE_DRIFT_MIN_MS && !isHidden()) {
                windowState.driftMs += lateness;
                noteActivity();
            }
        }
        lastTickAt = t;

        const w = windowState;
        const busyMs = Math.max(w.longTaskMs, w.driftMs);
        const heavy = busyMs >= PROFILE_AUTO_THRESHOLD_MS
            || w.ajaxMs >= PROFILE_AUTO_THRESHOLD_MS
            || w.invokeMs >= PROFILE_AUTO_THRESHOLD_MS
            || w.idbMs >= PROFILE_AUTO_THRESHOLD_MS
            || w.timerMs >= PROFILE_AUTO_THRESHOLD_MS;
        const quiet = lastActivityAt !== null && (t - lastActivityAt) >= PROFILE_QUIET_MS;
        const spaced = (t - lastReportAt) >= PROFILE_MIN_INTERVAL_MS;

        if (heavy && quiet && spaced) {
            lastReportAt = t;
            reportNow();
            resetWindow();
        }
    }

    function snapshot() {
        const w = windowState;
        return {
            windowStartedAt: w.startedAt,
            longTaskMs: w.longTaskMs,
            longTaskCount: w.longTaskCount,
            maxLongTaskMs: w.maxLongTaskMs,
            driftMs: w.driftMs,
            ajaxCount: w.ajaxCount,
            ajaxMs: w.ajaxMs,
            ajaxMaxMs: w.ajaxMaxMs,
            ajaxByPath: [...w.ajaxByPath.entries()].map(([path, entry]) => ({ path, ...entry })),
            invokeCount: w.invokeCount,
            invokeMs: w.invokeMs,
            invokeByCommand: [...w.invokeByCommand.entries()].map(([command, entry]) => ({ command, ...entry })),
            idbCount: w.idbCount,
            idbMs: w.idbMs,
            idbByOp: [...w.idbByOp.entries()].map(([op, entry]) => ({ op, ...entry })),
            timerCount: w.timerCount,
            timerMs: w.timerMs,
            timerByDelay: [...w.timerByDelay.entries()].map(([delay, entry]) => ({ delay, ...entry })),
            rafCount: w.rafCount,
            rafGapMs: w.rafGapMs,
        };
    }

    return { tick, recordAjax, recordLongTask, recordInvoke, recordIdb, recordTimer, recordRafGap, snapshot, reportNow };
}

/** Starts observing main-thread long tasks (browser only, best-effort). */
function observeLongTasks(profiler) {
    try {
        if (typeof PerformanceObserver === 'undefined') {
            return;
        }
        const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                profiler.recordLongTask(entry.duration || 0);
            }
        });
        observer.observe({ entryTypes: ['longtask'] });
    } catch {
        // Long Task API unavailable: the drift meter in tick() still works.
    }
}

/** Times fetch() calls the same way ajax pass-throughs are timed. */
function profileFetch(profiler) {
    try {
        const originalFetch = globalThis.fetch;
        if (typeof originalFetch !== 'function' || originalFetch.__ttFteProfiled) {
            return;
        }
        const profiledFetch = function (input, init) {
            const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
            let path = '';
            try {
                path = requestPathOf(typeof input === 'string' ? input : input?.url);
            } catch {
                path = 'fetch';
            }
            const promise = originalFetch.apply(this, arguments);
            promise.then(
                () => profiler.recordAjax(path, (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt),
                () => profiler.recordAjax(path, (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt),
            );
            return promise;
        };
        profiledFetch.__ttFteProfiled = true;
        globalThis.fetch = profiledFetch;
    } catch {
        // Best-effort only.
    }
}

/** Shared instrumentation state so the broker-level and transport-level
 * wrappers do not double-count the same invoke call. */
const INVOKE_INSTRUMENTATION = { insideBroker: false };

/** FNV-1a 32-bit hash (stable across sessions). */
function hashString(input) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

/**
 * LRU cache for native-regex batch results.
 *
 * `apply_native_regex_batch` output is a pure function of each task's text and
 * its (depth-filtered) script list: identical input always yields identical
 * output. Prompt assembly re-runs the whole batch on unchanged chat content on
 * every generation (retries, viewer re-opens, regenerations), so memoizing
 * results turns repeat batches into instant cache hits while preserving
 * exact semantics (cached values are real Rust outputs, never estimates).
 */
function createRegexBatchCache(limitEntries = 4000, limitChars = 16 * 1024 * 1024) {
    const entries = new Map();
    let chars = 0;

    const keyOf = (task) => hashString(JSON.stringify(task));

    const get = (key) => {
        const value = entries.get(key);
        if (value !== undefined) {
            entries.delete(key);
            entries.set(key, value);
            return value;
        }
        return undefined;
    };

    const set = (key, text) => {
        if (entries.has(key)) {
            entries.delete(key);
            entries.set(key, text);
            return;
        }
        entries.set(key, text);
        chars += text.length;
        while ((entries.size > limitEntries || chars > limitChars) && entries.size > 0) {
            const oldestKey = entries.keys().next().value;
            const oldest = entries.get(oldestKey);
            entries.delete(oldestKey);
            chars -= oldest.length;
        }
    };

    return { keyOf, get, set, size: () => entries.size };
}

const REGEX_BATCH_COMMAND = 'apply_native_regex_batch';
const REGEX_BATCH_CACHE = createRegexBatchCache();

/**
 * Plans a regex-batch call against the cache.
 * Hit values are snapshotted so concurrent identical batches cannot make the
 * later merge diverge from the Rust subset response.
 * @param {ReturnType<typeof createRegexBatchCache>} cache
 * @param {any} args
 * @returns {{ kind: 'empty' } | { kind: 'all-hit', texts: string[] } | { kind: 'partial', hitTexts: (string | null)[], missIdx: number[], missTasks: any[] } | { kind: 'miss' }}
 */
function planRegexBatch(cache, args) {
    const tasks = args?.dto?.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) {
        return { kind: 'empty' };
    }

    const hitTexts = new Array(tasks.length);
    const missIdx = [];
    const missTasks = [];
    let hitCount = 0;
    for (let i = 0; i < tasks.length; i += 1) {
        const cached = cache.get(cache.keyOf(tasks[i]));
        if (cached !== undefined) {
            hitTexts[i] = cached;
            hitCount += 1;
        } else {
            hitTexts[i] = null;
            missIdx.push(i);
            missTasks.push(tasks[i]);
        }
    }

    if (hitCount === tasks.length) {
        return { kind: 'all-hit', texts: hitTexts };
    }
    if (hitCount === 0) {
        return { kind: 'miss' };
    }
    return { kind: 'partial', hitTexts, missIdx, missTasks };
}

/**
 * Merges a subset response into the full task order using the snapshot from
 * planning, then memoizes the freshly computed tasks.
 */
function mergePartialRegexResponse(plan, cache, args, response) {
    const results = response?.tasks;
    if (!Array.isArray(results) || results.length !== plan.missIdx.length) {
        throw new Error('Native regex partial response length mismatch');
    }
    storeCachedRegexBatch(cache, { dto: { tasks: plan.missTasks } }, response);

    const tasks = args.dto.tasks;
    const full = new Array(tasks.length);
    for (let i = 0; i < tasks.length; i += 1) {
        if (plan.hitTexts[i] !== null) {
            full[i] = { text: plan.hitTexts[i] };
        }
    }
    for (let k = 0; k < plan.missIdx.length; k += 1) {
        full[plan.missIdx[k]] = results[k];
    }
    return { tasks: full };
}

/** Stores every task result of a completed batch for future calls. */
function storeCachedRegexBatch(cache, args, response) {
    const tasks = args?.dto?.tasks;
    const results = response?.tasks;
    if (!Array.isArray(tasks) || !Array.isArray(results) || tasks.length !== results.length) {
        return;
    }
    for (let i = 0; i < tasks.length; i += 1) {
        const text = results[i]?.text;
        if (typeof text === 'string') {
            cache.set(cache.keyOf(tasks[i]), text);
        }
    }
}

/**
 * Times every Tauri invoke by command name, from the transport level.
 * The Tauri runtime keeps its own transport (it does not go through the
 * patched global fetch), so invokes are otherwise invisible to the profiler —
 * yet single invokes such as the native regex batch or a chat save can hold
 * the prompt pipeline for seconds. `tauri-bridge.js` resolves
 * `window.__TAURI__.core.invoke` on every call, so replacing the property
 * intercepts every transport-level caller.
 *
 * When the broker wrapper (`profileInvokeBroker`) is also installed, calls
 * that reach this wrapper through the broker are counted there, so here they
 * are recorded under a `direct:` label only when the broker did not originate
 * them (e.g. broker calls that sat on a concurrency-limiter queue).
 */
export function profileTauriInvoke(profiler, tauriLike = globalThis.__TAURI__, shared = INVOKE_INSTRUMENTATION) {
    try {
        const core = tauriLike?.core;
        if (!core || typeof core.invoke !== 'function' || core.invoke.__ttFteProfiled) {
            return false;
        }

        const originalInvoke = core.invoke;
        const profiledInvoke = function (command, ...rest) {
            // Snapshot at call time: the broker wrapper clears its flag as soon
            // as `broker.invoke` returns, which happens before this promise
            // settles. Calls that run inside the broker's synchronous section
            // are already counted end-to-end by the broker wrapper (including
            // any limiter-queue wait), so suppress them here to avoid
            // double-counting. Only transport calls that escape the broker
            // section (e.g. queued behind a concurrency limiter) are recorded
            // here, under a `direct:` label.
            const suppressed = shared.insideBroker;
            const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
            const result = originalInvoke.apply(this, [command, ...rest]);
            if (suppressed) {
                return result;
            }
            const label = `direct:${command}`;
            const record = (ms) => profiler.recordInvoke(label, ms);
            try {
                Promise.resolve(result).finally(() => {
                    record((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt);
                }).catch(() => {
                    // Only silences the timing chain, not the caller's promise.
                });
            } catch {
                record((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt);
            }
            return result;
        };
        profiledInvoke.__ttFteProfiled = true;
        try {
            core.invoke = profiledInvoke;
        } catch {
            // Injected `core` may expose read-only accessors (e.g. getter-only
            // `invoke`); the broker wrapper below still covers routed traffic.
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Times every routed Tauri invoke at the host ABI's invoke-broker boundary,
 * and memoizes native-regex batch results (see `createRegexBatchCache`).
 * Every `safeInvoke` in the app (route handlers, native regex batch, chat
 * saves, ...) resolves `invokeBroker.invoke` dynamically on the plain object
 * exposed as `__TAURITAVERN__.invoke.broker`, so replacing that method is the
 * most reliable single choke point and survives read-only `__TAURI__` cores.
 */
export function profileInvokeBroker(profiler, abiLike = globalThis.__TAURITAVERN__, shared = INVOKE_INSTRUMENTATION, regexCache = REGEX_BATCH_CACHE) {
    try {
        const broker = abiLike?.invoke?.broker;
        if (!broker || typeof broker.invoke !== 'function' || broker.invoke.__ttFteProfiled) {
            return false;
        }

        const originalInvoke = broker.invoke;
        const profiledInvoke = function (command, args) {
            // Regex-batch cache: serve fully cached batches locally, and for
            // partially cached batches send only the missing tasks to Rust.
            let regexPlan = null;
            if (command === REGEX_BATCH_COMMAND && regexCache) {
                regexPlan = planRegexBatch(regexCache, args);
                if (regexPlan.kind === 'all-hit') {
                    const stats = globalThis.__TT_FRONTEND_TOKENIZER__?.stats;
                    if (stats) {
                        stats.regexCacheHits = (stats.regexCacheHits || 0) + 1;
                    }
                    return Promise.resolve({ tasks: regexPlan.texts.map((text) => ({ text })) });
                }
            }

            const isPartial = regexPlan?.kind === 'partial';
            const invokeArgs = isPartial ? { dto: { tasks: regexPlan.missTasks } } : args;

            const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
            shared.insideBroker = true;
            let result;
            try {
                result = originalInvoke.call(broker, command, invokeArgs);
            } finally {
                shared.insideBroker = false;
            }

            const settled = Promise.resolve(result);
            // Partial batches: merge the Rust subset response back into the
            // full task order so callers see a complete response; then cache
            // the freshly computed tasks for future calls.
            const returned = isPartial
                ? settled.then((response) => {
                    const merged = mergePartialRegexResponse(regexPlan, regexCache, args, response);
                    profiler.recordInvoke('regex-batch-partial', (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt);
                    return merged;
                }, (error) => {
                    throw error;
                })
                : settled;

            if (command === REGEX_BATCH_COMMAND && regexCache && !isPartial) {
                returned.then((response) => {
                    storeCachedRegexBatch(regexCache, args, response);
                }).catch(() => {
                    // Failed batches are not cached.
                });
            }

            returned.finally(() => {
                profiler.recordInvoke(String(command), (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt);
            }).catch(() => {
                // Only silences the timing chain, not the caller's promise.
            });

            return returned;
        };
        profiledInvoke.__ttFteProfiled = true;
        broker.invoke = profiledInvoke;
        return true;
    } catch {
        return false;
    }
}

/**
 * Records long `setTimeout` waits and throttled `requestAnimationFrame` gaps.
 * Both are pure waiting time that no other meter sees: main-thread idle,
 * no requests, no invokes, no IndexedDB. A 30-second assembly made of
 * `await delay(...)` chains or rAF-throttled UI updates would show up here.
 */
export function profileWaits(profiler, globalObject = globalThis) {
    let changed = false;

    try {
        const originalSetTimeout = globalObject.setTimeout;
        if (typeof originalSetTimeout === 'function' && !originalSetTimeout.__ttFteProfiled) {
            const MIN_DELAY_MS = 500;
            const profiledSetTimeout = function (fn, delay = 0, ...rest) {
                const delayMs = Number(delay) || 0;
                const scheduledAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
                if (delayMs >= MIN_DELAY_MS) {
                    const wrapped = function (...args) {
                        try {
                            return typeof fn === 'function' ? fn.apply(this, args) : fn;
                        } finally {
                            profiler.recordTimer(delayMs, (typeof performance !== 'undefined' ? performance.now() : Date.now()) - scheduledAt);
                        }
                    };
                    return originalSetTimeout.call(this, wrapped, delay, ...rest);
                }
                return originalSetTimeout.call(this, fn, delay, ...rest);
            };
            profiledSetTimeout.__ttFteProfiled = true;
            try {
                globalObject.setTimeout = profiledSetTimeout;
                changed = true;
            } catch {
                // Non-writable binding: skip.
            }
        }
    } catch {
        // Best-effort only.
    }

    try {
        const originalRaf = globalObject.requestAnimationFrame;
        if (typeof originalRaf === 'function' && !originalRaf.__ttFteProfiled) {
            const MIN_GAP_MS = 100;
            const profiledRaf = function (callback) {
                const scheduledAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
                return originalRaf.call(this, (timestamp) => {
                    const gap = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - scheduledAt;
                    if (gap >= MIN_GAP_MS) {
                        profiler.recordRafGap(gap);
                    }
                    return callback(timestamp);
                });
            };
            profiledRaf.__ttFteProfiled = true;
            try {
                globalObject.requestAnimationFrame = profiledRaf;
                changed = true;
            } catch {
                // Non-writable binding: skip.
            }
        }
    } catch {
        // Best-effort only.
    }

    return changed;
}

/**
 * Times IndexedDB object-store reads/writes, the other invisible async sink
 * (localforage token-cache buckets, settings stores). Best-effort: wraps the
 * prototype methods and measures until the request settles.
 */
export function profileIndexedDb(profiler, globalObject = globalThis) {
    try {
        const storeProto = globalObject.IDBObjectStore?.prototype;
        if (!storeProto || storeProto.get.__ttFteProfiled) {
            return false;
        }

        /** @param {'get'|'put'|'add'|'delete'} op */
        const wrap = (op) => {
            const original = storeProto[op];
            if (typeof original !== 'function') {
                return;
            }
            const wrapped = function (...args) {
                const request = original.apply(this, args);
                const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
                const label = `${op}:${this.name ?? '?'}`;
                try {
                    request.addEventListener('success', () => {
                        profiler.recordIdb(label, (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt);
                    }, { once: true });
                    request.addEventListener('error', () => {
                        profiler.recordIdb(label, (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt);
                    }, { once: true });
                } catch {
                    // Request without events: fall through unmeasured.
                }
                return request;
            };
            wrapped.__ttFteProfiled = true;
            storeProto[op] = wrapped;
        };

        for (const op of ['get', 'put', 'add', 'delete']) {
            wrap(op);
        }
        return true;
    } catch {
        return false;
    }
}

/** Floating "Σ" button that re-shows the profiler report (double-tap hides). */
function installProbeButton(profiler) {
    try {
        if (typeof document === 'undefined' || document.getElementById('tt-fte-probe')) {
            return;
        }
        const button = document.createElement('div');
        button.id = 'tt-fte-probe';
        button.textContent = 'Σ';
        button.title = 'Token Estimator 性能剖析（双击隐藏）';
        Object.assign(button.style, {
            position: 'fixed',
            right: '14px',
            bottom: '140px',
            width: '34px',
            height: '34px',
            borderRadius: '50%',
            background: 'rgba(90, 90, 110, 0.55)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '16px',
            fontWeight: 'bold',
            zIndex: '2147483000',
            cursor: 'pointer',
            userSelect: 'none',
            opacity: '0.6',
        });
        let lastTap = 0;
        button.addEventListener('click', () => {
            const now = Date.now();
            if (now - lastTap < 400) {
                button.remove();
                return;
            }
            lastTap = now;
            profiler.reportNow();
        });
        document.body.appendChild(button);
    } catch {
        // Best-effort only.
    }
}

/**
 * Idempotently (re)asserts every instrumentation patch. The host and other
 * extensions replace global bindings during startup, and on mobile the Tauri
 * ABI (`__TAURI__`, `__TAURITAVERN__`) may be injected after this module runs,
 * so the watchdog re-runs this on every tick. Each install checks its own
 * marker and is a no-op when already in place.
 */
function reassertInstrumentation(profiler) {
    profileFetch(profiler);
    profileTauriInvoke(profiler);
    profileInvokeBroker(profiler);
    profileIndexedDb(profiler);
    profileWaits(profiler);
}

if (typeof globalThis.jQuery !== 'undefined') {
    installFrontendTokenizer(globalThis.jQuery);
    const guard = activateFrontendTokenizerGuard(() => globalThis.jQuery, { notify: showNotification });
    const profiler = createProfiler({
        notify: (message) => showNotification(message, 30_000),
        backendCountDelta: () => guard.backendCountDelta(),
    });
    activeProfiler = profiler;
    globalThis.__TT_FRONTEND_TOKENIZER__.profile = () => profiler.snapshot();
    observeLongTasks(profiler);
    reassertInstrumentation(profiler);
    installProbeButton(profiler);
    // Fast tick: re-assert the interceptor quickly when displaced, keep every
    // instrumentation patch outermost, and drive the profiler window checks.
    const guardTimer = setInterval(() => {
        guard.tick();
        reassertInstrumentation(profiler);
        profiler.tick();
    }, PROFILE_TICK_MS);
    // Do not keep Node test contexts alive on account of the watchdog.
    guardTimer?.unref?.();
}
