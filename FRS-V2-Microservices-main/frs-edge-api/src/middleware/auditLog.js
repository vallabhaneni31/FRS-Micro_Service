/**
 * auditLog.js — writes micro-level audit events to audit_log table + WebSocket
 *
 * FIX-020: sanitizeAuditData() — redacts passwords, tokens, and biometric
 *          embeddings from before/after JSON before persisting to audit_log.
 *          Prevents sensitive data leaking into the append-only audit trail.
 */
import { pool } from '../db/pool.js';
import logger from '../utils/logger.js';

let _wsManager = null;

export function setAuditWsManager(wsManager) {
  _wsManager = wsManager;
}

// ── FIX-020: Sensitive field redaction ───────────────────────────────────────
const SENSITIVE_PATTERNS = [
  /^password$/i,
  /^passwd$/i,
  /secret/i,
  /token/i,
  /api.?key/i,
  /authorization/i,
  /embedding/i,
  /face.?data/i,
  /biometric/i,
  /credit.?card/i,
  /card.?number/i,
  /\bssn\b/i,
  /\bcvv\b/i,
];

/**
 * Recursively redacts sensitive fields from an object before audit logging.
 * Arrays are walked element-by-element. Primitives are returned as-is.
 *
 * @param {*}      data        - Object, Array, or primitive to sanitize
 * @param {number} [depth=0]  - Current recursion depth (max 8 for safety)
 * @returns {*} sanitized copy
 */
export function sanitizeAuditData(data, depth = 0) {
  if (depth > 8) return '[DEPTH_LIMIT]';
  if (data === null || data === undefined) return data;
  if (Array.isArray(data)) return data.map(item => sanitizeAuditData(item, depth + 1));
  if (typeof data !== 'object') return data;

  const result = {};
  for (const [key, value] of Object.entries(data)) {
    const isSensitive = SENSITIVE_PATTERNS.some(pat => pat.test(key));
    if (isSensitive) {
      result[key] = '[REDACTED]';
    } else if (value && typeof value === 'object') {
      result[key] = sanitizeAuditData(value, depth + 1);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Log an audit event with full context
 * @param {Object} params
 * @param {Object} params.req - Express request
 * @param {string} params.action - e.g. 'attendance.mark', 'employee.view'
 * @param {string} params.details - Human readable description
 * @param {string} [params.entityType] - 'employee', 'device', 'roster', etc.
 * @param {string} [params.entityId] - ID of affected entity
 * @param {string} [params.entityName] - Name of affected entity
 * @param {Object} [params.before] - State before change (will be sanitized)
 * @param {Object} [params.after] - State after change (will be sanitized)
 * @param {string} [params.source] - 'ui', 'api', 'device', 'system'
 */
export async function writeAudit({ req, action, details, entityType, entityId, entityName, before, after, source, tenantId: overrideTenantId }) {
  try {
    const tenantId   = overrideTenantId || req?.auth?.scope?.tenantId   || req?.headers?.['x-tenant-id']   || null;
    const customerId = req?.auth?.scope?.customerId || req?.headers?.['x-customer-id'] || null;
    const siteId     = req?.auth?.scope?.siteId     || req?.headers?.['x-site-id']     || null;
    const userId     = req?.auth?.user?.id           || null;
    const userName   = req?.auth?.user?.name || req?.auth?.user?.email || req?.auth?.user?.username || null;
    const userRole   = req?.auth?.user?.role         || req?.auth?.user?.roles?.[0]    || null;
    const userAgent  = req?.headers?.['user-agent']  || null;
    const method     = req?.method                   || null;

    // Determine source
    const detectedSource = source ||
      (req?.headers?.['x-device-id'] || req?.body?.deviceId ? 'device' :
       req?.headers?.['user-agent']?.includes('frs-runner') ? 'device' : 'ui');

    // Clean IP
    const rawIp = req?.headers?.['x-forwarded-for']?.split(',')[0]
               || req?.socket?.remoteAddress
               || null;
    const ip = rawIp?.replace('::ffff:', '') || rawIp;

    // FIX-020: Sanitize before/after data to strip sensitive fields
    const safeBefore = before ? sanitizeAuditData(before) : null;
    const safeAfter  = after  ? sanitizeAuditData(after)  : null;

    const { rows } = await pool.query(
      `INSERT INTO audit_log (
        tenant_id, customer_id, site_id, fk_user_id,
        action, details, ip_address,
        user_name, user_role, user_agent, method,
        entity_type, entity_id, entity_name,
        before_data, after_data, source
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING *`,
      [
        tenantId   ? tenantId   : null,
        customerId ? Number(customerId) : null,
        siteId     ? Number(siteId)     : null,
        userId     ? Number(userId)     : null,
        action,
        typeof details === 'string' ? details : JSON.stringify(details),
        ip,
        userName,
        userRole,
        userAgent ? userAgent.slice(0, 500) : null,
        method,
        entityType  || null,
        entityId    ? String(entityId)   : null,
        entityName  || null,
        safeBefore  ? JSON.stringify(safeBefore) : null,
        safeAfter   ? JSON.stringify(safeAfter)  : null,
        detectedSource,
      ]
    );

    const entry = rows[0];

    // Push to WebSocket
    if (_wsManager && tenantId) {
      try { _wsManager.emitAuditEvent(String(tenantId), entry); } catch (_) {}
    }

    return entry;
  } catch (e) {
    logger.warn({ err: e }, '[Audit] Write failed');
  }
}
