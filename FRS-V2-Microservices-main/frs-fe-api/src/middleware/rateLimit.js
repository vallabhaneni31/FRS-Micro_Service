/**
 * rateLimit.js — Express rate limiters
 *
 * FIX-009: Uses a Redis store for distributed rate limiting when REDIS_URL is set.
 *
 * PERF-0003: Each limiter gets its OWN store instance with its own key prefix.
 * express-rate-limit forbids sharing a Store across limiters (ERR_ERL_STORE_REUSE):
 * it logs a ValidationError per extra limiter, and — the real defect — `init(options)`
 * runs once per limiter against the same instance, so every limiter's windowMs
 * collapses to the last writer. One shared ioredis *connection* is fine; one shared
 * *Store* is not.
 *
 * Redis-outage policy differs by limiter class:
 *   - Traffic limiters fail OPEN (passOnStoreError) — availability first; device
 *     ingest must keep flowing.
 *   - Auth/activation limiters fail CLOSED (429) — a Redis outage must never hand
 *     an attacker an N× brute-force budget.
 */
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import Redis from 'ioredis';
import crypto from 'crypto';
import { env } from '../config/env.js';
import logger from '../utils/logger.js';

// ── Redis connection (ONE client, shared; stores are per-limiter) ─────────────
let redisClient;

if (env.redis.url) {
  redisClient = new Redis(env.redis.url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    connectTimeout: 5000,
  });

  redisClient.on('error', (err) => {
    // Log but don't crash — each limiter's failure policy decides what happens next.
    logger.error('[RateLimit] Redis connection error:', err.message);
  });

  redisClient.on('connect', () => {
    logger.info('[RateLimit] Redis connected — distributed rate limiting active');
  });
} else {
  logger.warn(
    '[RateLimit] REDIS_URL not configured — using in-memory stores. ' +
    'Rate limits are per-process only (not shared across instances). ' +
    'Set REDIS_URL for production distributed rate limiting.'
  );
}

/**
 * Build a NEW store for a single limiter. Never reuse the returned instance.
 * @param {string} name unique limiter name — becomes the Redis key prefix
 * @returns {import('express-rate-limit').Store|undefined} undefined → in-memory store
 */
export function makeStore(name) {
  if (!redisClient) return undefined;
  return new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix: `frs:rl:${name}:`,
  });
}

// ── FRS-ARCH-002 Phase 7: Redis Lua sliding-window limiter ────────────────────
// Fixed-window counters (the makeRateLimiter/express-rate-limit approach above)
// have a known boundary weakness for brute-force protection specifically: a
// burst timed around a window edge can get ~2x the intended budget (e.g. 10
// attempts in the last second of one 5-minute window, then 10 more in the
// first second of the next). A sliding window — a Redis sorted set of request
// timestamps, trimmed to the trailing window on every check — closes that gap.
// Scoped to just the two brute-force-sensitive limiters below (authRateLimiter,
// accountLoginLimiter), not every limiter in this file: the others aren't
// guarding a brute-forceable secret the same way, so the fixed-window approach
// (simpler, cheaper) remains the right tool for them.
if (redisClient) {
  // Atomic check-and-increment: for limiters where every request counts.
  redisClient.defineCommand('slidingWindowCheck', {
    numberOfKeys: 1,
    lua: `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local window = tonumber(ARGV[2])
      local limit = tonumber(ARGV[3])
      local member = ARGV[4]
      redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
      local count = redis.call('ZCARD', key)
      if count < limit then
        redis.call('ZADD', key, now, member)
        redis.call('PEXPIRE', key, window)
        return {1, limit - count - 1}
      else
        redis.call('PEXPIRE', key, window)
        return {0, 0}
      end
    `,
  });

  // Peek-only (no increment): the pre-request gate for skipSuccessfulRequests
  // limiters, where whether an attempt counts depends on the eventual response.
  redisClient.defineCommand('slidingWindowPeek', {
    numberOfKeys: 1,
    lua: `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local window = tonumber(ARGV[2])
      redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
      return redis.call('ZCARD', key)
    `,
  });

  // Record-only (increment, no gate): called after the fact once the response
  // is known, for skipSuccessfulRequests limiters.
  redisClient.defineCommand('slidingWindowRecord', {
    numberOfKeys: 1,
    lua: `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local window = tonumber(ARGV[2])
      local member = ARGV[3]
      redis.call('ZADD', key, now, member)
      redis.call('PEXPIRE', key, window)
      return redis.call('ZCARD', key)
    `,
  });
}

function setRateLimitHeaders(res, limit, remaining, windowMs) {
  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, remaining)));
  res.setHeader('RateLimit-Reset', String(Math.ceil(windowMs / 1000)));
}

/**
 * Sliding-window limiter, fail-CLOSED (a Redis outage denies rather than
 * lifts throttling — same policy as this file's other auth-class limiters).
 * Every request that reaches this middleware counts toward the limit.
 */
function makeSlidingWindowLimiter(name, windowMs, max, message, keyGenerator) {
  return async (req, res, next) => {
    if (!redisClient) {
      logger.error(`[RateLimit] sliding-window limiter "${name}" has no Redis client — denying request`);
      return res.status(429).json({ message });
    }
    try {
      const key = `frs:rlsw:${name}:${keyGenerator(req)}`;
      const now = Date.now();
      const member = `${now}:${crypto.randomUUID()}`;
      const [allowed, remaining] = await redisClient.slidingWindowCheck(key, now, windowMs, max, member);
      setRateLimitHeaders(res, max, remaining, windowMs);
      if (allowed) return next();
      return res.status(429).json({ message });
    } catch (err) {
      logger.error(`[RateLimit] sliding-window limiter "${name}" store error — denying request:`, err.message);
      return res.status(429).json({ message });
    }
  };
}

/**
 * Sliding-window limiter with skipSuccessfulRequests semantics: gates on the
 * CURRENT count (no increment), then — once the response is known — records
 * the attempt only if it failed. Mirrors accountLoginLimiter's original
 * behavior: a legitimate login never counts against the account's budget.
 */
function makeSlidingWindowLimiterSkipSuccessful(name, windowMs, max, message, keyGenerator) {
  return async (req, res, next) => {
    if (!redisClient) {
      logger.error(`[RateLimit] sliding-window limiter "${name}" has no Redis client — denying request`);
      return res.status(429).json({ message });
    }
    const key = `frs:rlsw:${name}:${keyGenerator(req)}`;
    const now = Date.now();
    try {
      const count = await redisClient.slidingWindowPeek(key, now, windowMs);
      setRateLimitHeaders(res, max, max - count, windowMs);
      if (count >= max) {
        return res.status(429).json({ message });
      }
    } catch (err) {
      logger.error(`[RateLimit] sliding-window limiter "${name}" store error — denying request:`, err.message);
      return res.status(429).json({ message });
    }

    res.on('finish', () => {
      if (res.statusCode >= 400) {
        const member = `${now}:${crypto.randomUUID()}`;
        redisClient.slidingWindowRecord(key, now, windowMs, member).catch((err) => {
          logger.error(`[RateLimit] sliding-window limiter "${name}" failed to record attempt:`, err.message);
        });
      }
    });

    return next();
  };
}

/**
 * Wrap a limiter so a store error becomes 429 instead of bubbling to the error
 * handler as a 500. Used for the fail-CLOSED (abuse-protection) limiters.
 */
function failClosed(limiter, message) {
  return (req, res, next) =>
    limiter(req, res, (err) => {
      if (!err) return next();
      logger.error('[RateLimit] store error on a fail-closed limiter — denying request:', err.message);
      return res.status(429).json({ message });
    });
}

/**
 * Builds an IP-keyed rate limiter with its own store.
 * @param {string}  name      unique limiter name (store prefix)
 * @param {number}  windowMs
 * @param {number}  max
 * @param {string}  message
 * @param {{failOpen?: boolean}} [opts] failOpen=true → serve on store error
 */
function makeRateLimiter(name, windowMs, max, message, { failOpen = true } = {}) {
  const limiter = rateLimit({
    windowMs,
    max,
    message: { message },
    standardHeaders: true,
    legacyHeaders: false,
    // ipKeyGenerator(ip) takes the IP STRING, not the request — passing req itself
    // fails isIPv6() silently and returns req unchanged, which stringifies to
    // "[object Object]" as the Redis key, bucketing every client together under
    // one shared counter. Must be req.ip, not req.
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    passOnStoreError: failOpen,
    store: makeStore(name),
  });
  return failOpen ? limiter : failClosed(limiter, message);
}

// 1. General API Rate Limiter — 600 req / 10 min per IP. Fails OPEN.
//    FRS-ARCH-002 Phase 7: raised from 300 after a live incident (2026-08-04
//    hotfix) — this host's real client IPs are shared office/NAT egress
//    points, and this limiter runs before requireAuth resolves identity, so
//    it can't yet key per-user the way photoDownloadLimiter does. 546
//    requests/10min was observed from one real IP under entirely legitimate
//    multi-source use (jetson device traffic — now separately exempted via
//    isDeviceIngestPath — plus ordinary multi-tab/multi-staff dashboard
//    polling). 600 matches the precedent already set elsewhere in this file
//    for the same "many legitimate things share one identity" problem
//    (photoDownloadLimiter: 600/min per user; deviceIngestLimiter: 300/min
//    per device) — still a real ceiling (600/10min ≈ 1 req/s sustained,
//    well below anything a genuine single-actor abuse pattern would need),
//    just no longer tuned for a single-user assumption this host doesn't
//    match.
//    NOT done here, deliberately deferred: keying this limiter by
//    authenticated user (not raw IP) once identity is known, mirroring
//    photoDownloadLimiter's pattern. That requires either moving this
//    limiter to run after auth resolves in the middleware chain, or a
//    lightweight pre-auth token-sub extraction — either is a real pipeline
//    change deserving its own dedicated design/test pass, not something to
//    bolt on same-day alongside everything else touched in this phase.
export const globalRateLimiter = makeRateLimiter(
  'global',
  10 * 60 * 1000,
  600,
  'Too many requests from this IP, please try again after 10 minutes'
);

// 2. Strict Auth Rate Limiter — 10 req / 5 min per IP (brute-force protection).
//    Fails CLOSED: a Redis outage must not lift login throttling.
//    FRS-ARCH-002 Phase 7: sliding window, not fixed — closes the window-
//    boundary gap a fixed-window counter has (see comment above the Lua
//    scripts). Same limit/keying/message as before.
export const authRateLimiter = makeSlidingWindowLimiter(
  'auth',
  5 * 60 * 1000,
  10,
  'Too many failed login attempts, please try again after 5 minutes',
  (req) => ipKeyGenerator(req.ip)
);

// 2b. Per-Account Login Limiter — 8 attempts / 15 min, keyed by EMAIL (not IP).
//     Complements authRateLimiter (per-IP): a distributed/botnet attack rotating
//     IPs against a single account is still throttled. Fails CLOSED.
//     FRS-ARCH-002 Phase 7: sliding window; skipSuccessfulRequests behavior
//     preserved (only failed attempts count — a legitimate user is never
//     locked out by signing in).
export const accountLoginLimiter = makeSlidingWindowLimiterSkipSuccessful(
  'account-login',
  15 * 60 * 1000,
  8,
  'Too many login attempts for this account, please try again after 15 minutes',
  (req) => {
    const email = (req.body?.email || '').toString().trim().toLowerCase();
    return email ? `acct:${email}` : ipKeyGenerator(req.ip);
  }
);

// 3. Invite Setup Rate Limiter — 5 req / 15 min per IP. Fails OPEN.
export const inviteLimiter = makeRateLimiter(
  'invite',
  15 * 60 * 1000,
  5,
  'Too many invite setup attempts, please try again after 15 minutes'
);

// 4. Photo Upload Rate Limiter (Remediation AP-002) — 20 req / 5 min per IP. Fails OPEN.
export const photoUploadLimiter = makeRateLimiter(
  'photo-upload',
  5 * 60 * 1000,
  20,
  'Too many photo upload attempts, please try again after 5 minutes'
);

// 6. Device Ingest Limiter (PERF-0001) — 300 req / min, keyed by DEVICE, not IP.
//    Mounted AFTER authenticateDevice on the edge ingest routes (frame/bulk-sync/
//    direction, /events, face recognize, camera heartbeat), which are also EXEMPT
//    from the per-IP globalRateLimiter (see server.js). This stops many cameras
//    behind one NAT from throttling each other while still capping a single device.
//    Fails OPEN — a Redis outage must not stop attendance ingest.
export const deviceIngestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { message: 'Too many ingest requests from this device, slow down' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.device?.id ? `dev:${req.device.id}` : ipKeyGenerator(req.ip)),
  passOnStoreError: true,
  store: makeStore('device-ingest'),
});

// 5. Device Activation Limiter — 10 req / 10 min per IP.
//    POST /devices/activate is unauthenticated and gated only by a 6-digit PIN
//    (1M space). Fails CLOSED — this throttle guards a brute-forceable secret.
export const activationLimiter = makeRateLimiter(
  'activation',
  10 * 60 * 1000,
  10,
  'Too many activation attempts, please try again after 10 minutes',
  { failOpen: false }
);

// 7. Enrollment Pose-Check Limiter — POST /enroll/:token/check-pose is public
//    (no auth — the enrollee isn't logged in) and called repeatedly, in real
//    time, while the self-enrollment portal's camera is open (live "turn
//    left/closer/good" feedback before the actual photo is captured), so it
//    needs a much higher ceiling than one-off actions like invite/activation.
//    Fails OPEN — nothing here is persisted or a brute-forceable secret (see
//    EnrollmentController.checkPose), so a Redis outage should never block
//    someone mid-enrollment.
export const poseCheckLimiter = makeRateLimiter(
  'pose-check',
  60 * 1000,
  120,
  'Too many pose-check requests, please slow down'
);
