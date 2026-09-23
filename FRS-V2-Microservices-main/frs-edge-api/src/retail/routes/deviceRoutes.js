import express from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticateDevice } from '../middleware/authenticateDevice.js';
import { resolveCameraId } from '../services/cameraResolver.js';

// NOTE: this is a trimmed copy of backend/api-retail/src/routes/deviceRoutes.js.
// Only the device-authenticated handlers (heartbeat/health) live here.
// POST /register and GET / (both authenticateUser/requireOwner, user-facing
// device management) were intentionally dropped — those belong in frs-fe-api.

const router = express.Router();

// POST /devices/:id/heartbeat — device telemetry ping
router.post('/:id/heartbeat', authenticateDevice, asyncHandler(async (req, res) => {
  const { cpu_pct, mem_used_mb, temp_c, uptime_s, camera_id } = req.body;

  if (req.params.id !== req.device.id) {
    return res.status(403).json({ error: 'device_id_mismatch' });
  }

  const resolvedCameraId = await resolveCameraId(camera_id, req.device.store_id);

  await pool.query(
    `INSERT INTO device_health (device_id, cpu_pct, mem_used_mb, temp_c, uptime_s, camera_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [req.device.id, cpu_pct ?? null, mem_used_mb ?? null,
     temp_c ?? null, uptime_s ?? null, resolvedCameraId]
  );

  return res.json({ success: true });
}));

// POST /devices/:id/health — alias for heartbeat (some firmware uses this path)
router.post('/:id/health', authenticateDevice, asyncHandler(async (req, res) => {
  const { cpu_pct, mem_used_mb, temp_c, uptime_s, camera_id } = req.body;

  const resolvedCameraId = await resolveCameraId(camera_id, req.device.store_id);

  await pool.query(
    `INSERT INTO device_health (device_id, cpu_pct, mem_used_mb, temp_c, uptime_s, camera_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [req.device.id, cpu_pct ?? null, mem_used_mb ?? null,
     temp_c ?? null, uptime_s ?? null, resolvedCameraId]
  );

  return res.json({ success: true });
}));

export { router as deviceRoutes };
