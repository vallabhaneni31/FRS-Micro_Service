/**
 * recognitionThresholdService.js — FIX-038: Server-side recognition threshold lock
 *
 * Prevents client-supplied thresholds from overriding the server-authoritative
 * value. Previously, Jetson devices and API callers could lower the threshold
 * arbitrarily, allowing lower-confidence matches to be accepted.
 *
 * The threshold is read from:
 *   1. Per-tenant override in the DB (facility_config table)
 *   2. Global env var RECOGNITION_THRESHOLD (default 0.60)
 *
 * Client-supplied values are IGNORED in production.
 *
 * Usage in recognition routes:
 *   const threshold = await getThreshold(tenantId);
 *   // use threshold — never req.body.threshold
 */
import { pool }  from '../db/pool.js';
import logger     from '../utils/logger.js';

const GLOBAL_DEFAULT  = Number(process.env.RECOGNITION_THRESHOLD       || 0.60);
const MIN_ALLOWED     = Number(process.env.RECOGNITION_THRESHOLD_MIN    || 0.50);
const MAX_ALLOWED     = Number(process.env.RECOGNITION_THRESHOLD_MAX    || 0.95);
const IS_PROD         = process.env.NODE_ENV === 'production';

// In-memory cache (TTL: 5 minutes) — reduces DB round-trips on every frame
const thresholdCache  = new Map();
const CACHE_TTL_MS    = 5 * 60 * 1000;

/**
 * Get the authoritative recognition threshold for a tenant.
 *
 * @param {string|null} tenantId
 * @returns {Promise<number>} threshold value in [MIN_ALLOWED, MAX_ALLOWED]
 */
export async function getThreshold(tenantId) {
  // Check cache
  const cached = thresholdCache.get(tenantId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.value;
  }

  let threshold = GLOBAL_DEFAULT;

  if (tenantId) {
    try {
      const { rows } = await pool.query(
        `SELECT config_value
         FROM facility_config
         WHERE tenant_id = $1::uuid
           AND config_key = 'recognition_threshold'
         LIMIT 1`,
        [tenantId]
      );
      if (rows.length && rows[0].config_value) {
        const tenantVal = Number(rows[0].config_value);
        if (!isNaN(tenantVal)) threshold = tenantVal;
      }
    } catch (err) {
      // facility_config may not exist — fall back to global
      logger.warn({ err, tenantId }, '[thresholdService] Could not read tenant threshold — using global default');
    }
  }

  // Clamp to allowed range
  threshold = Math.min(Math.max(threshold, MIN_ALLOWED), MAX_ALLOWED);

  thresholdCache.set(tenantId, { value: threshold, ts: Date.now() });
  return threshold;
}

/**
 * Validate and sanitise a client-supplied threshold.
 * In production: always returns the server-authoritative threshold, ignoring clientValue.
 * In dev: allows client override within bounds (for testing).
 *
 * @param {string|null}   tenantId
 * @param {number|null}   clientValue - value supplied by client (ignored in prod)
 * @returns {Promise<number>}
 */
export async function resolveThreshold(tenantId, clientValue) {
  const serverThreshold = await getThreshold(tenantId);

  if (IS_PROD && clientValue !== null && clientValue !== undefined) {
    const client = Number(clientValue);
    if (!isNaN(client) && Math.abs(client - serverThreshold) > 0.001) {
      logger.warn({
        tenantId,
        clientValue: client,
        serverThreshold,
      }, '[thresholdService] Client attempted to override threshold — enforcing server value');
    }
    return serverThreshold; // production: always server value
  }

  if (clientValue !== null && clientValue !== undefined) {
    const client = Number(clientValue);
    if (!isNaN(client)) {
      return Math.min(Math.max(client, MIN_ALLOWED), MAX_ALLOWED);
    }
  }

  return serverThreshold;
}

/**
 * Invalidate cached threshold for a tenant (call after config update).
 * @param {string} tenantId
 */
export function invalidateThresholdCache(tenantId) {
  thresholdCache.delete(tenantId);
}
