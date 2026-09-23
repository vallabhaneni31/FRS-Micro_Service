/**
 * jetsonRoutes.js — edge-facing subset of the original jetsonRoutes.js
 * (frs-core-api backend/api). Split per docs/architecture/API_SPLIT_PLAN.md:
 * this file keeps only `ALL /:camId/heartbeat` (authenticateDevice — legacy
 * firmware compat). `GET /photos/:filename` is `requireAuth`, serves photos
 * to the UI despite this file's name, and lives in the frs-fe-api
 * (frontend-facing) sibling instead.
 */
import express from 'express';
import authenticateDevice from '../middleware/authenticateDevice.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { pool } from '../db/pool.js';

const router = express.Router();

// Legacy heartbeat endpoint — kept so existing Jetson firmware still works
// New Jetson firmware should use POST /api/events with event_type='heartbeat' instead
router.all('/:camId/heartbeat', authenticateDevice, asyncHandler(async (req, res) => {
  const { camId } = req.params;
  let body = req.body || {};

  // Handle text body (server.js sanitizes nan → null for /api/jetson/* paths)
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }

  const { status = 'online', metrics = {} } = body;

  // Support both nested ({ metrics: { cpu_percent } }) and flat ({ cpu_percent }) formats.
  const m = (typeof metrics === 'object' && metrics !== null && Object.keys(metrics).length > 0)
    ? metrics
    : body;

  const telemetry = {
    cpu_percent:     m.cpu_percent     ?? null,
    gpu_percent:     m.gpu_percent     ?? null,
    memory_used_mb:  m.memory_used_mb  ?? null,
    memory_total_mb: m.memory_total_mb ?? null,
    temperature_c:   m.temperature_c   ?? m.cpu_temp ?? null,
    disk_used_gb:    m.disk_used_gb    ?? null,
    disk_total_gb:   m.disk_total_gb   ?? null,
    disk_free_gb:    m.disk_free_gb    ?? null,
    uptime_seconds:  m.uptime_seconds  ?? null,
    load_avg_1m:     m.load_avg_1m     ?? null,
    fps:             m.fps             ?? null,
    updated_at: new Date().toISOString()
  };

  await pool.query(
    `UPDATE facility_device
     SET status = $2,
         last_active = NOW(),
         last_heartbeat = NOW(),
         device_config = COALESCE(device_config, '{}'::jsonb) || $3::jsonb
     WHERE external_device_id = $1`,
    [camId, status, JSON.stringify(telemetry)]
  );

  // Also store in device_events for audit
  const { rows: devRows } = await pool.query(
    `SELECT pk_device_id, tenant_id FROM facility_device WHERE external_device_id = $1`,
    [camId]
  );
  if (devRows.length) {
    await pool.query(
      `INSERT INTO device_events (device_code, tenant_id, event_type, payload, received_at)
       VALUES ($1, $2::uuid, 'heartbeat', $3::jsonb, NOW())`,
      [camId, devRows[0].tenant_id, JSON.stringify({ status, metrics })]
    ).catch(() => {});
  }

  return res.json({ success: true });
}));

export { router as jetsonRoutes };
