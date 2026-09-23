/**
 * securityEventLogger.js — FIX-015: Security event logging middleware
 *
 * Intercepts HTTP responses with status 401, 403, or 429 and writes a
 * structured security event to the audit_log table + Pino logger.
 *
 * Mount AFTER your auth middleware so req.auth is available:
 *   app.use(securityEventLogger);
 *
 * The middleware wraps res.json() so it can inspect the response body
 * without buffering — no performance impact for successful responses.
 */
import { pool } from '../db/pool.js';
import logger from '../utils/logger.js';

// Action labels per status code
const ACTION_MAP = {
  401: 'security.unauthorized',
  403: 'security.forbidden',
  429: 'security.rate_limited',
};

export function securityEventLogger(req, res, next) {
  const originalJson = res.json.bind(res);

  res.json = function (body) {
    const status = res.statusCode;

    if (status === 401 || status === 403 || status === 429) {
      // Fire-and-forget — don't block the response
      _logSecurityEvent(req, res, status, body).catch((err) => {
        logger.warn({ err }, '[securityEventLogger] Failed to persist security event');
      });
    }

    return originalJson(body);
  };

  next();
}

async function _logSecurityEvent(req, res, status, body) {
  let action = ACTION_MAP[status] || `security.http_${status}`;

  const errDetails = typeof body === 'object'
    ? (body?.message || body?.error || JSON.stringify(body))
    : String(body);

  if (status === 401 && (errDetails.includes('temporarily locked') || errDetails.includes('account locked'))) {
    action = 'security.account_locked';
  }

  // Extract context safely (support unauthenticated login endpoints by inspecting req.body)
  const customerId = req.auth?.scope?.customerId || req.headers?.['x-customer-id'] || null;
  const siteId     = req.auth?.scope?.siteId     || req.headers?.['x-site-id']     || null;
  const userId     = req.auth?.user?.id           || req.device?.id                 || null;
  const userName   = req.auth?.user?.name || req.auth?.user?.email || req.auth?.user?.username || req.body?.username || req.body?.email || null;
  const userRole   = req.auth?.user?.role         || req.auth?.user?.roles?.[0]    || null;
  const userAgent  = req.headers?.['user-agent']  || null;
  const rawIp      = req.headers?.['x-forwarded-for']?.split(',')[0]
                  || req.socket?.remoteAddress
                  || null;
  const ip         = rawIp?.replace('::ffff:', '') || rawIp;

  let tenantId = req.auth?.scope?.tenantId || req.headers?.['x-tenant-id'] || null;
  const rawRealm = req.body?.realm || req.body?.workspace || null;

  if (!tenantId && rawRealm) {
    try {
      const tenantRes = await pool.query(
        `SELECT pk_tenant_id FROM frs_tenant WHERE realm_slug = $1 OR pk_tenant_id::text = $1 LIMIT 1`,
        [rawRealm]
      );
      if (tenantRes.rows[0]?.pk_tenant_id) {
        tenantId = tenantRes.rows[0].pk_tenant_id;
      }
    } catch (_) {}
  }

  const details = typeof body === 'object'
    ? (body?.message || body?.error || JSON.stringify(body))
    : String(body);

  // Structured log via Pino
  logger.warn({
    action,
    status,
    ip,
    method:  req.method,
    path:    req.path,
    userId,
    tenantId,
    userAgent: userAgent?.slice(0, 200),
  }, `[SECURITY] ${action} — ${req.method} ${req.path}`);

  // Persist to audit_log (best-effort, swallow DB errors)
  try {
    await pool.query(
      `INSERT INTO audit_log (
         tenant_id, customer_id, site_id, fk_user_id,
         action, details, ip_address,
         user_name, user_role, user_agent, method,
         entity_type, entity_id, source
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        tenantId   || null,
        customerId ? Number(customerId) : null,
        siteId     ? Number(siteId)     : null,
        userId     ? Number(userId)     : null,
        action,
        details.slice(0, 1000),
        ip,
        userName   || null,
        userRole   || null,
        userAgent  ? userAgent.slice(0, 500) : null,
        req.method,
        'security_event',
        String(status),
        'system',
      ]
    );
  } catch (dbErr) {
    // Don't surface DB errors to caller — logging should never break the app
    logger.warn({ err: dbErr }, '[securityEventLogger] DB insert failed');
  }
}
