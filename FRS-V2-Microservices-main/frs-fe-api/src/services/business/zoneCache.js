/**
 * zoneCache.js — specs/0003-zone-analytics, Requirement 12.4 (design.md 2.8).
 *
 * A small in-process TTL cache for the Zone Analytics batch results. Not Redis:
 * REDIS_URL is unset in dev and this data is cheap to recompute once a minute.
 *
 *  - key       tenantId|siteId|view|part|sorted-normalised-params, so one tenant's
 *              entry can never be served to another (the tenant is always taken
 *              from req.auth.scope, never from the query)
 *  - TTL       60 s for aggregates, 10 min for filter lists (per call)
 *  - single-flight  concurrent identical requests share one execution
 *  - refresh   `refresh: true` skips the lookup and replaces the entry
 *  - errors    a rejected loader (or a value `shouldCache` refuses) is never stored
 *  - bounded   at most `maxEntries` entries, oldest inserted evicted first
 *
 * Holds only what the batch endpoints already return (aggregated widgets); no
 * photo lookups and no per-person rows beyond those endpoints' own shapes.
 */

export const AGGREGATE_TTL_MS = 60 * 1000;
export const FILTER_LIST_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_ENTRIES = 500;

/** Parameters that never affect the result and must not split the key. */
const NON_KEY_PARAMS = new Set(['refresh', 'tenantId', 'siteId']);

/** tenantId|siteId|view|part|normalised params (keys sorted; array order kept). */
export function buildCacheKey({ tenantId, siteId, view, part, query = {} }) {
  const norm = {};
  for (const k of Object.keys(query).sort()) {
    if (NON_KEY_PARAMS.has(k)) continue;
    const v = query[k];
    if (v === undefined || v === null || v === '') continue;
    norm[k] = Array.isArray(v) ? v.map(String) : String(v);
  }
  return [tenantId ?? '', siteId ?? '', view, part ?? '', JSON.stringify(norm)].join('|');
}

export function createZoneCache({ maxEntries = DEFAULT_MAX_ENTRIES, now = () => Date.now() } = {}) {
  const store = new Map(); // key -> { value, expiresAt }
  const inflight = new Map(); // key -> Promise<value>

  function evict() {
    const t = now();
    for (const [k, e] of store) if (e.expiresAt <= t) store.delete(k);
    while (store.size > maxEntries) store.delete(store.keys().next().value); // oldest first
  }

  /**
   * @returns {Promise<{ value: any, hit: boolean }>}
   */
  async function getOrCompute(key, ttlMs, loader, { refresh = false, shouldCache = () => true } = {}) {
    if (!refresh) {
      const e = store.get(key);
      if (e && e.expiresAt > now()) return { value: e.value, hit: true };
      if (e) store.delete(key);
    }
    if (inflight.has(key)) return { value: await inflight.get(key), hit: false };

    const p = (async () => {
      const value = await loader();
      if (shouldCache(value)) {
        store.delete(key); // re-insert so a refreshed entry counts as newest
        store.set(key, { value, expiresAt: now() + ttlMs });
        evict();
      }
      return value;
    })();
    inflight.set(key, p);
    try {
      return { value: await p, hit: false };
    } finally {
      inflight.delete(key);
    }
  }

  return {
    getOrCompute,
    clear() { store.clear(); },
    get size() { return store.size; },
    has(key) { const e = store.get(key); return Boolean(e && e.expiresAt > now()); },
  };
}

/** Process-wide cache used by the batch service. */
export const zoneCache = createZoneCache();
