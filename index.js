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
 * After a busy period it pops a summary toast ("TT 性能剖析") stating whether
 * the time was spent blocking the main thread (rendering / regex / extension
 * scripts) or waiting on backend requests, plus estimator/guard counters.
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
const EXTENSION_VERSION = '3.0.0';
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
        };
    }

    function noteActivity() {
        lastActivityAt = now();
    }

    function recordAjax(path, ms) {
        const w = windowState;
        w.ajaxCount += 1;
        w.ajaxMs += ms;
        w.ajaxMaxMs = Math.max(w.ajaxMaxMs, ms);
        const entry = w.ajaxByPath.get(path) ?? { count: 0, ms: 0 };
        entry.count += 1;
        entry.ms += ms;
        w.ajaxByPath.set(path, entry);
        noteActivity();
    }

    function recordLongTask(ms) {
        const w = windowState;
        w.longTaskMs += ms;
        w.longTaskCount += 1;
        w.maxLongTaskMs = Math.max(w.maxLongTaskMs, ms);
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
        const elapsedMs = Date.now() - w.startedAt;
        const busyMs = Math.max(w.longTaskMs, w.driftMs);
        const slowestPaths = [...w.ajaxByPath.entries()]
            .sort((a, b) => b[1].ms - a[1].ms)
            .slice(0, 3)
            .map(([path, entry]) => `${path} ×${entry.count} (${fmtSeconds(entry.ms)})`)
            .join('、');

        const lines = [
            `TT 性能剖析（最近 ${(elapsedMs / 1000).toFixed(1)}s）：`,
            `主线程繁忙 ${fmtSeconds(busyMs)}（长任务 ${fmtSeconds(w.longTaskMs)}/${w.longTaskCount} 次，最大 ${fmtSeconds(w.maxLongTaskMs)}；计时漂移 ${fmtSeconds(w.driftMs)}）`,
            `后端请求 ${w.ajaxCount} 次，共 ${fmtSeconds(w.ajaxMs)}（最慢单次 ${fmtSeconds(w.ajaxMaxMs)}）`,
        ];
        if (slowestPaths) {
            lines.push(`最耗时请求：${slowestPaths}`);
        }
        lines.push(`本地估算 ${interceptedDelta} 次｜补丁恢复 ${reassertedDelta} 次｜后端计数 ${backendCountDelta()} 次`);
        return lines.join('<br>');
    }

    function resetWindow() {
        const stats = globalThis.__TT_FRONTEND_TOKENIZER__?.stats;
        if (stats) {
            lastSeenIntercepted = stats.intercepted || 0;
            lastSeenReasserted = stats.reasserted || 0;
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
        const heavy = busyMs >= PROFILE_AUTO_THRESHOLD_MS || w.ajaxMs >= PROFILE_AUTO_THRESHOLD_MS;
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
        };
    }

    return { tick, recordAjax, recordLongTask, snapshot, reportNow };
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
    profileFetch(profiler);
    installProbeButton(profiler);
    // Fast tick: re-assert the interceptor quickly when displaced and drive
    // the profiler window checks.
    const guardTimer = setInterval(() => {
        guard.tick();
        profiler.tick();
    }, PROFILE_TICK_MS);
    // Do not keep Node test contexts alive on account of the watchdog.
    guardTimer?.unref?.();
}
