/**
 * authCache.js — Redis-backed cache for the resolved auth bundle
 * ({ user, memberships, mt }) built by authz.js's authenticateWithKeycloak().
 *
 * FRS-ARCH-002 A1: that function makes ~7 sequential/parallel DB round trips
 * per request. Caching its DB-derived output collapses that to one Redis GET
 * for the large majority of requests (cache hits), while leaving JWT
 * signature/expiry verification (the actual security check) uncached and
 * run fresh on every request — only the DB-derived data is ever cached.
 *
 * Fail-closed policy: a Redis outage (or any cache error) must never grant
 * access that the DB wouldn't. On any cache read/write failure this module
 * returns/no-ops so the caller falls through to the real DB lookup — it
 * never fabricates or widens a cached result.
 */
import Redis from 'ioredis';
import { env } from '../config/env.js';
import logger from '../utils/logger.js';

const TTL_SECONDS = 30;
const PREFIX = 'frs:authcache:';

let redisClient;

if (env.redis.url) {
  redisClient = new Redis(env.redis.url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    connectTimeout: 5000,
  });

  redisClient.on('error', (err) => {
    logger.error('[AuthCache] Redis connection error:', err.message);
  });

  redisClient.on('connect', () => {
    logger.info('[AuthCache] Redis connected — auth bundle caching active');
  });

  redisClient.connect().catch(() => {
    // Swallow — every call site already treats "no working client" as a cache miss.
  });
} else {
  logger.warn('[AuthCache] REDIS_URL not configured — auth requests always hit the DB.');
}

function cacheKey(sub, tenantId) {
  return `${PREFIX}${sub}:${tenantId || 'global'}`;
}

/**
 * @returns {Promise<{user: object, memberships: object[], mt: object}|null>}
 *   null on a miss OR on any cache-layer failure — callers must treat both
 *   identically (fall through to the DB).
 */
export async function getCachedAuth(sub, tenantId) {
  if (!redisClient || redisClient.status !== 'ready') return null;
  try {
    const raw = await redisClient.get(cacheKey(sub, tenantId));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.warn('[AuthCache] read failed, falling through to DB:', err.message);
    return null;
  }
}

/** Best-effort write — a failure here just means the next request cache-misses too. */
export async function setCachedAuth(sub, tenantId, payload) {
  if (!redisClient || redisClient.status !== 'ready') return;
  try {
    await redisClient.set(cacheKey(sub, tenantId), JSON.stringify(payload), 'EX', TTL_SECONDS);
  } catch (err) {
    logger.warn('[AuthCache] write failed (non-fatal):', err.message);
  }
}

/**
 * Clear every cached tenant-variant for a user. Call this from any write
 * path that changes what a user is authorized to do (role grant/revoke,
 * account activate/deactivate) so the change takes effect immediately
 * instead of waiting out the TTL.
 */
export async function invalidateAuthCacheBySub(sub) {
  if (!redisClient || !sub || redisClient.status !== 'ready') return;
  try {
    const keys = await redisClient.keys(`${PREFIX}${sub}:*`);
    if (keys.length) await redisClient.del(...keys);
  } catch (err) {
    logger.warn('[AuthCache] invalidation failed:', err.message);
  }
}
