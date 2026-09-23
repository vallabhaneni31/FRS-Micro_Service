/**
 * cache.js — small general-purpose Redis cache helper.
 *
 * FRS-ARCH-002 A2/C7: shared by the WS-broadcast employee/department lookup
 * (C7) and hot-GET response caching (A2). Same connection pattern as
 * rateLimit.js/authCache.js: one dedicated lazyConnect client, fail-closed
 * on any error (a cache miss/error always just falls through to the real
 * DB query — never fabricates or serves wrong data).
 */
import Redis from 'ioredis';
import { env } from '../config/env.js';
import logger from '../utils/logger.js';

let redisClient;

if (env.redis.url) {
  redisClient = new Redis(env.redis.url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    connectTimeout: 5000,
  });

  redisClient.on('error', (err) => {
    logger.error('[Cache] Redis connection error:', err.message);
  });

  redisClient.on('connect', () => {
    logger.info('[Cache] Redis connected — response/lookup caching active');
  });

  redisClient.connect().catch(() => {});
} else {
  logger.warn('[Cache] REDIS_URL not configured — caching disabled, all reads hit the DB.');
}

function ready() {
  return !!redisClient && redisClient.status === 'ready';
}

export async function cacheGet(key) {
  if (!ready()) return null;
  try {
    const raw = await redisClient.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.warn('[Cache] read failed, falling through:', err.message);
    return null;
  }
}

export async function cacheSet(key, value, ttlSeconds) {
  if (!ready()) return;
  try {
    await redisClient.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn('[Cache] write failed (non-fatal):', err.message);
  }
}

export async function cacheDel(key) {
  if (!redisClient) return;
  try {
    await redisClient.del(key);
  } catch (err) {
    logger.warn('[Cache] delete failed:', err.message);
  }
}

export async function cacheDelPattern(pattern) {
  if (!ready()) return;
  try {
    const keys = await redisClient.keys(pattern);
    if (keys.length) await redisClient.del(...keys);
  } catch (err) {
    logger.warn('[Cache] pattern delete failed:', err.message);
  }
}

/**
 * Read-through helper: serve from cache on a hit; on a miss, call fetchFn(),
 * cache its result, and return it. fetchFn's own errors propagate normally
 * (a DB error must still surface as a real error, not a silently empty cache
 * entry).
 */
export async function cacheGetOrSet(key, ttlSeconds, fetchFn) {
  const cached = await cacheGet(key);
  if (cached !== null) return cached;
  const value = await fetchFn();
  cacheSet(key, value, ttlSeconds).catch(() => {});
  return value;
}
