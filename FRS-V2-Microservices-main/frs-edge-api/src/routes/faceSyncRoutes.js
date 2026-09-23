/**
 * faceSyncRoutes.js — Data pull endpoints for Jetson
 * Jetson calls these on a schedule to keep its local SQLite DB in sync.
 * All connections are Jetson → AWS (one-way).
 *
 * GET /api/face/sync/embeddings?since=<ISO>&limit=<n>  — face vectors
 * GET /api/face/sync/employees?since=<ISO>             — active employee roster
 * GET /api/face/sync/config                            — device-specific config
 * GET /api/face/sync/cameras                            — this device's own attached cameras
 * GET /api/face/sync/enrollment-pending                 — pending kiosk enrollments
 *
 * Camera topology is NOT here — devices fetch it from GET /api/cameras
 * (cameraRoutes.js), which the admin UI's camera list also serves from the
 * same path via dual auth (authenticateDeviceOptional).
 *
 * Split per docs/architecture/API_SPLIT_PLAN.md: this file is almost
 * entirely edge-facing already — only `POST /trigger-enrollment`
 * (`requireAuth`, an operator clicking "Enroll at Kiosk" in the UI) moved to
 * the frs-fe-api (frontend-facing) sibling instead.
 */
import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import authenticateDevice from '../middleware/authenticateDevice.js';
import requireDeviceScope from '../middleware/requireDeviceScope.js';
import { pool } from '../db/pool.js';

const router = express.Router();

// ─── Device-authenticated sync endpoints ────────────────────────────────────

// GET /api/face/sync/embeddings
// Jetson calls this every 60s with ?since= to get only new/updated records
router.get('/embeddings', authenticateDevice, asyncHandler(async (req, res) => {
  const tenantId = req.device.tenant_id;
  const deviceId = req.device.pk_device_id;
  const since = req.query.since;
  const limit = Math.min(parseInt(req.query.limit || '500', 10), 2000);

  // Look up device's configured model version and ALL assigned sites
  const { rows: devRows } = await pool.query(
    `SELECT device_config FROM facility_device WHERE pk_device_id = $1 LIMIT 1`,
    [deviceId]
  );
  const deviceConfig = devRows[0]?.device_config || {};
  const deviceModel = deviceConfig.embedding_model || 'arcface-r50-fp16';

  // Collect every site this device is assigned to (multi-site support)
  const { rows: siteRows } = await pool.query(
    `SELECT site_id FROM site_device_assignment WHERE device_id = $1 AND is_active = TRUE`,
    [deviceId]
  );
  const assignedSiteIds = siteRows.map(r => r.site_id);

  const params = [tenantId, deviceModel];

  if (since) {
    params.push(since);
  }

  params.push(limit);
  const limitParam = `$${params.length}`;

  // Site filter: employees whose site_id is in the device's assigned sites,
  // plus employees with no site set (available at all sites).
  // When the device has no site assignment at all, fall back to the full tenant.
  const employeeSiteFilter = assignedSiteIds.length > 0
    ? `AND (e.site_ids && ARRAY[${assignedSiteIds.map(id => `'${id}'::bigint`).join(',')}]::bigint[] OR e.site_ids IS NULL)`
    : '';

  const queryText = `
    WITH combined_embeddings AS (
      SELECT
        efe.id,
        efe.employee_id::text as employee_id,
        e.employee_code,
        e.full_name,
        efe.embedding::text as embedding_text,
        efe.quality_score,
        efe.is_primary,
        efe.model_version,
        efe.angle,
        efe.enrolled_at,
        e.status as employee_status
      FROM employee_face_embeddings efe
      JOIN hr_employee e ON e.pk_employee_id = efe.employee_id
      WHERE e.tenant_id = $1::uuid
        AND efe.model_version = $2
        AND e.status = 'active'
        ${employeeSiteFilter}
        ${since ? `AND efe.enrolled_at > $3::timestamptz` : ''}

      UNION ALL

      SELECT
        pfe.id,
        pfe.person_id::text as employee_id,
        p.person_id::text as employee_code,
        p.full_name,
        pfe.embedding::text as embedding_text,
        pfe.quality_score,
        true as is_primary,
        pfe.model_version,
        NULL::character varying(20) as angle,
        pfe.created_at as enrolled_at,
        p.status as employee_status
      FROM person_face_embeddings pfe
      JOIN person p ON p.person_id = pfe.person_id
      WHERE p.tenant_id = $1::uuid
        AND pfe.model_version = $2
        AND p.status = 'active'
        AND p.person_type = 'visitor'
        ${since ? `AND pfe.created_at > $3::timestamptz` : ''}
    )
    SELECT * FROM combined_embeddings
    ORDER BY enrolled_at ASC
    LIMIT ${limitParam}
  `;

  const { rows } = await pool.query(queryText, params);

  // Parse the pgvector text "[x,y,z,...]" back to a float array for Jetson
  const embeddings = rows.map(r => {
    let vec = null;
    try {
      const raw = r.embedding_text;
      if (raw) {
        vec = raw.replace(/^\[|\]$/g, '').split(',').map(Number);
      }
    } catch (_) {}
    return {
      id: r.id,
      employee_id: r.employee_id,
      employee_code: r.employee_code,
      full_name: r.full_name,
      embedding: vec,
      quality_score: r.quality_score,
      is_primary: r.is_primary,
      model_version: r.model_version,
      angle: r.angle,
      enrolled_at: r.enrolled_at,
    };
  });

  const serverTime = new Date().toISOString();
  res.json({
    success: true,
    server_time: serverTime,
    count: embeddings.length,
    has_more: embeddings.length === limit,
    embeddings,
  });
}));

// GET /api/face/sync/employees
// Returns active employees so Jetson can display names locally
router.get('/employees', authenticateDevice, asyncHandler(async (req, res) => {
  const tenantId = req.device.tenant_id;
  const deviceId = req.device.pk_device_id;

  // Collect every site this device is assigned to (multi-site support)
  const { rows: siteRows } = await pool.query(
    `SELECT site_id FROM site_device_assignment WHERE device_id = $1 AND is_active = TRUE`,
    [deviceId]
  );
  const assignedSiteIds = siteRows.map(r => r.site_id);

  // Note: We ignore the 'since' parameter for employees because hr_employee lacks an updated_at column.
  const params = [tenantId];
  const siteFilter = assignedSiteIds.length > 0
    ? `AND (e.site_ids && ARRAY[${assignedSiteIds.map(id => `'${id}'::bigint`).join(',')}]::bigint[] OR e.site_ids IS NULL)`
    : '';

  const { rows } = await pool.query(
    `SELECT
       e.pk_employee_id as id,
       e.employee_code,
       e.full_name,
       d.name as department,
       e.position_title as designation,
       e.status,
       e.kiosk_enrollment_status,
       e.created_at as updated_at
     FROM hr_employee e
     LEFT JOIN hr_department d ON d.pk_department_id = e.fk_department_id
     WHERE e.tenant_id = $1::uuid
       AND e.status IN ('active', 'inactive')
       ${siteFilter}
     ORDER BY e.created_at ASC
     LIMIT 5000`,
    params
  );

  res.json({
    success: true,
    server_time: new Date().toISOString(),
    count: rows.length,
    employees: rows,
  });
}));

// GET /api/face/sync/config
// Returns device-specific config so Jetson knows its thresholds and settings
router.get('/config', authenticateDevice, asyncHandler(async (req, res) => {
  const deviceCode = req.device.code;
  const tenantId = req.device.tenant_id;

  const { rows: devRows } = await pool.query(
    `SELECT
       fd.pk_device_id,
       fd.external_device_id,
       fd.name,
       fd.device_config,
       fd.recognition_accuracy,
       s.timezone,
       s.site_name,
       sda.device_role,
       sda.zone_name
     FROM facility_device fd
     LEFT JOIN site_device_assignment sda ON sda.device_id = fd.pk_device_id AND sda.is_active = TRUE
     LEFT JOIN frs_site s ON s.pk_site_id = sda.site_id
     WHERE fd.external_device_id = $1 AND fd.tenant_id = $2::uuid`,
    [deviceCode, tenantId]
  );

  const device = devRows[0] || {};
  const cfg = device.device_config || {};

  res.json({
    success: true,
    device_code: deviceCode,
    site_name: device.site_name || null,
    timezone: device.timezone || 'UTC',
    device_role: device.device_role || 'entrance',
    zone_name: device.zone_name || null,
    recognition: {
      match_threshold: cfg.match_threshold ?? parseFloat(process.env.FACE_MATCH_THRESHOLD || '0.55'),
      anti_spoof: cfg.anti_spoof ?? true,
      unknown_alert_threshold: cfg.unknown_alert_threshold ?? 0.35,
      embedding_model: cfg.embedding_model || 'arcface-r50-fp16',
    },
    sync: {
      embeddings_interval_sec: cfg.embeddings_sync_interval ?? 60,
      employees_interval_sec: cfg.employees_sync_interval ?? 300,
      heartbeat_interval_sec: cfg.heartbeat_interval ?? 30,
    },
    server_time: new Date().toISOString(),
  });
}));

// GET /api/face/sync/cameras
// Returns only the calling device's own attached cameras — never another
// device's, even within the same tenant (enforced via parent_device_id).
router.get('/cameras', authenticateDevice, requireDeviceScope('cameras:read'), asyncHandler(async (req, res) => {
  const deviceId = req.device.pk_device_id;
  const tenantId = req.device.tenant_id;

  const { rows } = await pool.query(
    `SELECT
       COALESCE(fc.pk_camera_id::text, c.pk_device_id::text) AS id,
       c.name,
       c.external_device_id AS cam_id,
       c.external_device_id AS stream_name,
       c.status,
       c.ip_address,
       COALESCE(fc.rtsp_url, '') AS rtsp_url,
       COALESCE(fc.model, c.model, 'IP Camera') AS model,
       c.last_active,
       COALESCE(c.zone_type, 'unassigned') AS zone_type,
       c.zone_label,
       COALESCE(c.camera_mode, 'MIXED') AS camera_mode
     FROM facility_device c
     LEFT JOIN frs_camera fc ON fc.cam_id = c.external_device_id
     WHERE c.parent_device_id = $1
       AND c.tenant_id = $2::uuid
       AND c.decommissioned_at IS NULL
     ORDER BY c.name`,
    [deviceId, tenantId]
  );

  res.json({
    success: true,
    device_code: req.device.code,
    server_time: new Date().toISOString(),
    count: rows.length,
    cameras: rows,
  });
}));

// GET /api/face/sync/enrollment-pending
// Jetson calls this to check if any employee is pending kiosk enrollment
router.get('/enrollment-pending', authenticateDevice, asyncHandler(async (req, res) => {
  const tenantId = req.device.tenant_id;

  const { rows } = await pool.query(
    `SELECT
       e.pk_employee_id as id,
       e.employee_code,
       e.full_name,
       d.name as department
     FROM hr_employee e
     LEFT JOIN hr_department d ON d.pk_department_id = e.fk_department_id
     WHERE e.tenant_id = $1::uuid
       AND e.kiosk_enrollment_status = 'pending_kiosk'
     ORDER BY e.created_at ASC
     LIMIT 5`,
    [tenantId]
  );

  res.json({
    success: true,
    pending: rows,
  });
}));

export default router;
