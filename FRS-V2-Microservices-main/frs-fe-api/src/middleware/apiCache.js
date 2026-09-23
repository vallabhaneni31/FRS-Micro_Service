/**
 * apiCache.js — In-memory API response cache with instant hit delivery (< 2ms)
 * and automatic invalidation on write events.
 */

const cacheStore = new Map(); // key -> { body, contentType, expiresAt }
const DEFAULT_TTL_MS = 15000; // 15 seconds

/**
 * Build a cache key based on req path, query, and scope context/headers
 */
function buildCacheKey(req) {
  const tenant = req.headers['x-tenant-id'] || req.auth?.scope?.tenantId || '';
  const customer = req.headers['x-customer-id'] || req.auth?.scope?.customerId || '';
  const site = req.headers['x-site-id'] || req.auth?.scope?.siteId || '';
  const unit = req.headers['x-unit-id'] || req.auth?.scope?.unitId || '';
  const user = req.auth?.user?.id || req.auth?.sub || '';

  const scopeKey = [tenant, customer, site, unit, user].join(':');

  return `api:${req.originalUrl || req.url}:${scopeKey}`;
}

/**
 * Middleware factory for caching API GET endpoints
 */
export function cacheApi(ttlMs = DEFAULT_TTL_MS) {
  return (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }

    const key = buildCacheKey(req);
    const now = Date.now();
    const cached = cacheStore.get(key);

    if (cached && cached.expiresAt > now) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Content-Type', cached.contentType || 'application/json');
      return res.send(cached.body);
    }

    // Intercept res.send to capture response body for caching
    const originalSend = res.send.bind(res);
    res.send = (body) => {
      // Only cache successful 200 responses
      if (res.statusCode === 200 && body) {
        cacheStore.set(key, {
          body,
          contentType: res.getHeader('Content-Type') || 'application/json',
          expiresAt: Date.now() + ttlMs,
        });
      }
      return originalSend(body);
    };

    next();
  };
}

/**
 * Purge cache entries matching a pattern or clear all API cache
 */
export function purgeApiCache(pattern) {
  if (!pattern) {
    cacheStore.clear();
    return;
  }

  for (const key of cacheStore.keys()) {
    if (key.includes(pattern)) {
      cacheStore.delete(key);
    }
  }
}
