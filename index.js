/**
 * Native Regex Batch Cache for TauriTavern (v4.0.0)
 *
 * A pure, silent fix for the Rust Regex Backend's worst property: every
 * prompt assembly re-runs the whole regex batch over the chat, even when the
 * message texts and the (depth-filtered) script sets are unchanged. On long
 * chats with many scripts the `regress` engine takes tens of seconds per
 * batch, and repeats cost the same every time because upstream only caches
 * compiled patterns, never results.
 *
 * `apply_native_regex_batch` output is a pure function of each task's text and
 * script list: identical input always yields identical output. This extension
 * memoizes completed batches at the host ABI invoke-broker boundary
 * (`__TAURITAVERN__.invoke.broker.invoke`, the single choke point every
 * `safeInvoke` resolves dynamically):
 *
 *   - fully cached batch  -> answered locally, no Rust round trip
 *   - partially cached    -> only the missing tasks go to Rust, results are
 *                             merged back in the original task order
 *   - otherwise           -> normal Rust call; the outputs are memoized for
 *                             the next time
 *
 * The cache is an LRU (16MB in memory) persisted to localStorage (4MB budget,
 * versioned bucket), so repeat assemblies stay fast across app restarts. Keys
 * embed the full task payload (message text + every script definition), so
 * editing messages or regex scripts invalidates naturally and World Info
 * activation is untouched: any change that could alter an output necessarily
 * changes the key. Cached values are real Rust outputs, never estimates.
 *
 * Everything else was removed: no token-count estimation, no diagnostics, no
 * notifications, no floating UI. Console introspection:
 *
 *   __TT_REGEX_CACHE__.stats        // { hits, partials }
 *   __TT_REGEX_CACHE__.size()       // in-memory entry count
 *   __TT_REGEX_CACHE__.clear()      // wipe memory + persisted bucket
 */

const EXTENSION_VERSION = '4.0.0';
const REGEX_BATCH_COMMAND = 'apply_native_regex_batch';
const REGEX_BATCH_STORAGE_KEY = `tt:regex-cache:${EXTENSION_VERSION}`;

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
 * LRU cache for native-regex batch results. Optional persistence adapter:
 * `attachPersistence` loads synchronously, debounces saves, and flushes on
 * pagehide; saves evict the oldest entries beyond the byte budget.
 */
export function createRegexBatchCache(limitEntries = 4000, limitChars = 16 * 1024 * 1024) {
    const entries = new Map();
    let chars = 0;
    /** @type {{ schedule: () => void, flush: () => void } | null} */
    let persistence = null;

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

    const deleteKey = (key) => {
        const existing = entries.get(key);
        if (existing !== undefined) {
            entries.delete(key);
            chars -= existing.length;
        }
    };

    const set = (key, text) => {
        if (entries.has(key)) {
            entries.delete(key);
            entries.set(key, text);
        } else {
            entries.set(key, text);
            chars += text.length;
        }
        while ((entries.size > limitEntries || chars > limitChars) && entries.size > 0) {
            const oldestKey = entries.keys().next().value;
            const oldest = entries.get(oldestKey);
            entries.delete(oldestKey);
            chars -= oldest.length;
        }
        persistence?.schedule();
    };

    const clear = () => {
        entries.clear();
        chars = 0;
    };

    /** @returns {[string, string][]} Entries in LRU order (oldest first). */
    const snapshotEntries = () => [...entries.entries()];

    /**
     * @param {{
     *   load: () => [string, string][] | null,
     *   save: (entries: [string, string][]) => void,
     *   debounceMs?: number,
     *   autoSchedule?: boolean,
     *   maxBytes?: number,
     * }} adapter
     * @returns {{ flush: () => void }}
     */
    const attachPersistence = (adapter) => {
        const debounceMs = adapter.debounceMs ?? 1500;
        const autoSchedule = adapter.autoSchedule !== false;
        const maxBytes = adapter.maxBytes ?? 4 * 1024 * 1024;
        // Capture before any other wrapper could replace setTimeout.
        const timerFn = globalThis.setTimeout;
        let timer = null;

        const loaded = adapter.load?.();
        if (Array.isArray(loaded)) {
            for (const [key, text] of loaded) {
                if (typeof key === 'string' && typeof text === 'string') {
                    // persistence is null during load, so set() does not schedule.
                    set(key, text);
                }
            }
        }

        const flush = () => {
            if (typeof adapter.save !== 'function') {
                return;
            }
            let snapshot = snapshotEntries();
            if (snapshot.length === 0) {
                return;
            }
            while (snapshot.length > 0) {
                const bytes = snapshot.reduce((total, [, text]) => total + text.length, 0);
                if (bytes <= maxBytes) {
                    break;
                }
                deleteKey(snapshot[0][0]);
                snapshot = snapshotEntries();
            }
            try {
                adapter.save(snapshot);
            } catch {
                const drop = Math.max(1, Math.floor(snapshot.length / 4));
                for (let i = 0; i < drop && snapshot.length > 0; i += 1) {
                    deleteKey(snapshot[0][0]);
                    snapshot = snapshotEntries();
                }
                try {
                    adapter.save(snapshotEntries());
                } catch {
                    // Persistence is best-effort; the in-memory cache still works.
                }
            }
        };

        const schedule = () => {
            if (!autoSchedule || timer !== null || typeof timerFn !== 'function') {
                return;
            }
            timer = timerFn(() => {
                timer = null;
                flush();
            }, debounceMs);
        };

        persistence = { schedule, flush };
        return { flush };
    };

    return { keyOf, get, set, deleteKey, clear, size: () => entries.size, snapshotEntries, attachPersistence };
}

/**
 * Plans a batch against the cache. Hit values are snapshotted so concurrent
 * identical batches cannot make the later merge diverge from the subset
 * response.
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

/** Merges a subset response into the full task order, then memoizes misses. */
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

/** Module-level stats exposed for introspection (never surfaced in the UI). */
const STATS = { hits: 0, partials: 0, misses: 0 };

/**
 * Installs the cache wrapper on the host ABI invoke broker. Non-regex
 * commands pass through untouched (no promise churn). Idempotent.
 */
export function installRegexBatchCacheBroker(abiLike = globalThis.__TAURITAVERN__, cache = REGEX_BATCH_CACHE) {
    try {
        const broker = abiLike?.invoke?.broker;
        if (!broker || typeof broker.invoke !== 'function' || broker.invoke.__ttRegexBatchCached) {
            return false;
        }

        const originalInvoke = broker.invoke;
        const wrappedInvoke = function (command, args) {
            if (command !== REGEX_BATCH_COMMAND || !cache) {
                return originalInvoke.call(broker, command, args);
            }

            const plan = planRegexBatch(cache, args);
            if (plan.kind === 'all-hit') {
                STATS.hits += 1;
                return Promise.resolve({ tasks: plan.texts.map((text) => ({ text })) });
            }
            if (plan.kind === 'empty') {
                return originalInvoke.call(broker, command, args);
            }

            const isPartial = plan.kind === 'partial';
            const invokeArgs = isPartial ? { dto: { tasks: plan.missTasks } } : args;
            const result = originalInvoke.call(broker, command, invokeArgs);

            if (isPartial) {
                STATS.partials += 1;
                return Promise.resolve(result).then(
                    (response) => mergePartialRegexResponse(plan, cache, args, response),
                    (error) => { throw error; },
                );
            }

            STATS.misses += 1;
            Promise.resolve(result).then((response) => {
                storeCachedRegexBatch(cache, args, response);
            }).catch(() => {
                // Failed batches are not cached.
            });
            return result;
        };
        wrappedInvoke.__ttRegexBatchCached = true;
        broker.invoke = wrappedInvoke;
        return true;
    } catch {
        return false;
    }
}

/** Shared default cache instance (module-level for the page). */
const REGEX_BATCH_CACHE = createRegexBatchCache();

/**
 * Persists the cache in localStorage (4MB budget, versioned bucket). Entries
 * are keyed by task text + script definitions, so content/script edits
 * invalidate naturally; an extension update changes the bucket.
 */
function installRegexCachePersistence(cache) {
    try {
        if (typeof globalThis.localStorage === 'undefined') {
            return null;
        }
        const adapter = {
            load: () => {
                const raw = globalThis.localStorage.getItem(REGEX_BATCH_STORAGE_KEY);
                return raw ? JSON.parse(raw) : null;
            },
            save: (entries) => {
                globalThis.localStorage.setItem(REGEX_BATCH_STORAGE_KEY, JSON.stringify(entries));
            },
            remove: () => {
                globalThis.localStorage.removeItem(REGEX_BATCH_STORAGE_KEY);
            },
        };
        const { flush } = cache.attachPersistence(adapter);
        if (typeof window !== 'undefined') {
            window.addEventListener('pagehide', flush);
        }
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') {
                    flush();
                }
            });
        }
        return { flush, clear: () => { cache.clear(); adapter.remove?.(); } };
    } catch {
        return null;
    }
}

// Browser-only bootstrap: the extension only ever runs inside the app page.
if (typeof globalThis.document !== 'undefined') {
    const persistence = installRegexCachePersistence(REGEX_BATCH_CACHE);
    globalThis.__TT_REGEX_CACHE__ = {
        version: EXTENSION_VERSION,
        stats: STATS,
        size: () => REGEX_BATCH_CACHE.size(),
        clear: () => {
            REGEX_BATCH_CACHE.clear();
            persistence?.clear();
        },
    };

    const ensureInstalled = () => {
        const installed = installRegexBatchCacheBroker();
        if (installed) {
            console.log(`[Rust Regex Batch Cache] active (v${EXTENSION_VERSION})`);
        }
        return installed;
    };
    if (!ensureInstalled()) {
        // The ABI may be injected after this module runs; retry silently.
        const retryTimer = setInterval(() => {
            if (ensureInstalled()) {
                clearInterval(retryTimer);
            }
        }, 1000);
        retryTimer?.unref?.();
    }

    // Re-assert if the broker wrapper ever gets displaced; cheap marker check.
    const guardTimer = setInterval(() => {
        const broker = globalThis.__TAURITAVERN__?.invoke?.broker;
        if (broker && typeof broker.invoke === 'function' && !broker.invoke.__ttRegexBatchCached) {
            ensureInstalled();
        }
    }, 2000);
    guardTimer?.unref?.();
}
