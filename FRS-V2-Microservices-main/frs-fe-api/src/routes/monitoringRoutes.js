/**
 * monitoringRoutes.js — Monitoring & Metrics APIs
 * Phase 2, Task 2.9-2.10: Real-time status and historical metrics
 */
import express from 'express';
import { requireAuth, requirePermission } from '../middleware/authz.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { pool } from '../db/pool.js';
import logger from '../utils/logger.js';
import { validateQuery, validateBody, deviceMetricsQuerySchema, acknowledgeAlertSchema } from '../validators/schemas.js';

const router = express.Router();

// Resolve tenant UUID from JWT scope or x-tenant-id header; never falls back to an integer
const getTenantUuid = (req) => {
  const val = req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || null;
  return (val === 'null' || val === 'undefined' || !val) ? null : val;
};

// ============================================================================
// GET /api/monitoring/devices/status - Real-time Device Status Dashboard
// ============================================================================
router.get('/devices/status', requireAuth, requirePermission('devices.read'), asyncHandler(async (req, res) => {
  const tenantId = getTenantUuid(req);
  const siteId = req.query.site_id;

  // Build tenant filter clause — super_admin with no scope sees all devices
  const tenantClause = tenantId ? 'fd.tenant_id = $1::uuid' : 'TRUE';
  const summaryClause = tenantId ? 'WHERE tenant_id = $1::uuid' : '';
  const params = tenantId ? [tenantId] : [];
  let paramIndex = params.length + 1;

  const summary = await pool.query(`
    SELECT
      COUNT(*) as total_devices,
      COUNT(*) FILTER (WHERE status = 'online') as online_count,
      COUNT(*) FILTER (WHERE status = 'offline') as offline_count,
      COUNT(*) FILTER (WHERE status = 'error') as error_count,
      COUNT(*) FILTER (WHERE decommissioned_at IS NOT NULL) as decommissioned_count
    FROM facility_device
    ${summaryClause}
  `, params);

  let deviceQuery = `
    SELECT
      fd.pk_device_id,
      fd.external_device_id,
      fd.name,
      fd.status,
      fd.ip_address,
      fd.last_active,
      fd.last_heartbeat,
      fd.recognition_accuracy,
      fd.total_scans,
      fd.error_rate,
      dt.type_name as device_type,
      dt.category as device_category,
      s.site_name,
      s.pk_site_id as site_id,
      sda.device_role,
      sda.zone_name,
      CASE
        WHEN fd.last_heartbeat IS NOT NULL
        THEN EXTRACT(EPOCH FROM (NOW() - fd.last_heartbeat))::INTEGER
        ELSE NULL
      END as seconds_since_heartbeat,
      CASE
        WHEN fd.last_heartbeat IS NOT NULL AND fd.last_heartbeat > NOW() - INTERVAL '60 seconds'
        THEN 'healthy'
        WHEN fd.last_heartbeat IS NOT NULL AND fd.last_heartbeat > NOW() - INTERVAL '5 minutes'
        THEN 'degraded'
        WHEN fd.status = 'online'
        THEN 'no_heartbeat'
        ELSE 'offline'
      END as health_status
    FROM facility_device fd
    LEFT JOIN device_type dt ON dt.pk_device_type_id = fd.device_type_id
    LEFT JOIN site_device_assignment sda ON sda.device_id = fd.pk_device_id AND sda.is_active = TRUE
    LEFT JOIN frs_site s ON s.pk_site_id = sda.site_id
    WHERE ${tenantClause}
      AND fd.decommissioned_at IS NULL
  `;

  const deviceParams = [...params];
  if (siteId) {
    deviceQuery += ` AND sda.site_id = $${paramIndex}`;
    deviceParams.push(siteId);
  }
  deviceQuery += ' ORDER BY fd.status ASC, fd.last_active DESC';

  const devices = await pool.query(deviceQuery, deviceParams);

  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    summary: summary.rows[0],
    devices: devices.rows,
    refresh_interval_seconds: 10
  });
}));




// ============================================================================
// GET /api/monitoring/devices/:code/metrics - Historical Device Metrics
// ============================================================================
router.get('/devices/:code/metrics', requireAuth, requirePermission('devices.read'), validateQuery(deviceMetricsQuerySchema), asyncHandler(async (req, res) => {
  const { code } = req.params;
  const { hours } = req.validatedQuery;
  const tenantId = getTenantUuid(req);

  try {
    // Get device
    const tenantFilter = tenantId ? 'AND tenant_id = $2::uuid' : '';
    const deviceParams = tenantId ? [code, tenantId] : [code];
    const device = await pool.query(
      `SELECT pk_device_id FROM facility_device WHERE external_device_id = $1 ${tenantFilter}`,
      deviceParams
    );

    if (device.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const deviceId = device.rows[0].pk_device_id;
    const heartbeats = await pool.query(`
      SELECT 
        timestamp as heartbeat_time,
        status,
        metrics,
        response_time_ms,
        ip_address,
        created_at
      FROM device_heartbeat
      WHERE device_id = $1
        AND timestamp > NOW() - INTERVAL '${parseInt(hours)} hours'
      ORDER BY timestamp DESC
      LIMIT 1000
    `, [deviceId]);

    // Get status change history
    const statusHistory = await pool.query(`
      SELECT 
        changed_at,
        old_status,
        new_status,
        transition_reason
      FROM device_status_history
      WHERE device_id = $1
        AND changed_at > NOW() - INTERVAL '${parseInt(hours)} hours'
      ORDER BY changed_at DESC
      LIMIT 100
    `, [deviceId]);

    res.json({
      success: true,
      device_code: code,
      time_range_hours: parseInt(hours),
      heartbeat_count: heartbeats.rows.length,
      heartbeats: heartbeats.rows,
      status_changes: statusHistory.rows
    });

  } catch (error) {
    logger.error('Get device metrics error:', error);
    res.status(500).json({ error: 'Failed to get device metrics' });
  }
}));




// ============================================================================
// GET /api/monitoring/alerts - Active Alerts
// ============================================================================
router.get('/alerts', requireAuth, requirePermission('devices.read'), asyncHandler(async (req, res) => {
  const tenantUuid = getTenantUuid(req);
  const { acknowledged } = req.query;

  const tenantJoin  = tenantUuid ? `AND e.tenant_id = $1::uuid` : '';
  const tenantWhere = tenantUuid ? `AND (e.tenant_id = $1::uuid OR fd.tenant_id = $1::uuid)` : '';
  const params = tenantUuid ? [tenantUuid] : [];
  let paramIndex = params.length + 1;

  let query = `
    SELECT
      ua.pk_log_id                          AS pk_alert_id,
      'unauthorized_access'                  AS alert_type,
      CASE
        WHEN ua.confidence_score < 0.3  THEN 'critical'
        WHEN ua.confidence_score < 0.35 THEN 'warning'
        ELSE 'info'
      END                                    AS severity,
      COALESCE(
        'Unauthorized access detected'
        || CASE WHEN e.full_name IS NOT NULL THEN ' — ' || e.full_name ELSE '' END
        || CASE WHEN s.site_name  IS NOT NULL THEN ' at ' || s.site_name  ELSE '' END,
        'Unauthorized access detected'
      )                                      AS message,
      ua.event_timestamp                     AS created_at,
      (ua.resolved_at IS NOT NULL)           AS is_read,
      ua.employee_code,
      e.full_name                            AS employee_name,
      fd.name                                AS device_name,
      s.site_name
    FROM unauthorized_access_log ua
    LEFT JOIN hr_employee e
           ON e.employee_code = ua.employee_code ${tenantJoin}
    LEFT JOIN facility_device fd
           ON fd.pk_device_id::text = ua.device_id
    LEFT JOIN frs_site s ON s.pk_site_id = fd.site_id
    WHERE TRUE ${tenantWhere}
  `;

  if (acknowledged === 'false') {
    query += ` AND ua.resolved_at IS NULL`;
  } else if (acknowledged === 'true') {
    query += ` AND ua.resolved_at IS NOT NULL`;
  }

  query += ` ORDER BY ua.event_timestamp DESC LIMIT 100`;

  const { rows } = await pool.query(query, params);

  res.json({
    success: true,
    counts: {
      total: rows.length,
      critical: rows.filter(a => a.severity === 'critical').length,
      warning:  rows.filter(a => a.severity === 'warning').length,
      info:     rows.filter(a => a.severity === 'info').length,
      unread:   rows.filter(a => !a.is_read).length,
    },
    alerts: rows,
  });
}));

// ============================================================================
// POST /api/monitoring/alerts/:alertId/acknowledge - Acknowledge Alert
// ============================================================================
router.post('/alerts/:alertId/acknowledge', requireAuth, requirePermission('devices.write'), validateBody(acknowledgeAlertSchema), asyncHandler(async (req, res) => {
  const { alertId } = req.params;
  const { resolution_notes } = req.validatedBody;
  const userId = req.auth?.user?.id;

  try {
    const result = await pool.query(`
      UPDATE unauthorized_access_log
      SET resolved_at = NOW(),
          resolved_by = $1,
          remarks = $2
      WHERE pk_log_id = $3
      RETURNING pk_log_id, resolved_at as acknowledged_at
    `, [userId, resolution_notes, alertId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    res.json({
      success: true,
      message: 'Alert acknowledged successfully',
      alert_id: alertId,
      acknowledged_at: result.rows[0].acknowledged_at
    });

  } catch (error) {
    logger.error('Acknowledge alert error:', error);
    res.status(500).json({ error: 'Failed to acknowledge alert' });
  }
}));

export default router;
