/**
 * cameraRoutes.js — edge-facing subset of the original cameraRoutes.js
 * (frs-core-api backend/api). Split per docs/architecture/API_SPLIT_PLAN.md:
 * this file keeps only the `authenticateDevice`/`authenticateDeviceOptional`
 * routes a Jetson edge box calls directly. The `requireAuth`-gated admin
 * list/register/test/system-config/status/stream/capture-frame routes live
 * in the frs-fe-api (frontend-facing) sibling instead.
 */
import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { pool } from '../db/pool.js';
import authenticateDevice, { authenticateDeviceOptional } from '../middleware/authenticateDevice.js';
import { deviceIngestLimiter } from '../middleware/rateLimit.js';
import * as deviceHierarchySvc from '../services/business/DeviceHierarchyService.js';
import { getCamerasForDevice } from '../repositories/facilityDeviceRepository.js';

const router = express.Router();

// Camera heartbeat from Jetson: POST /api/cameras/:camId/heartbeat
router.post('/:camId/heartbeat', authenticateDevice, deviceIngestLimiter, asyncHandler(async (req, res) => {
  const { camId } = req.params;
  const { status = 'online' } = req.body || {};
  await pool.query(
    `UPDATE facility_device SET status=$2, last_active=NOW(), last_heartbeat=NOW() WHERE external_device_id=$1`,
    [camId, status]
  );
  return res.json({ success: true });
}));

// Camera-sync for the device's local FaceSync client: GET /api/cameras.
// authenticateDeviceOptional lets a valid device JWT be handled here; any
// other caller (human/Keycloak token, or none) would fall through to the
// admin-facing list route on the frontend-facing sibling — since that route
// doesn't exist in this repo, an unauthenticated/human caller simply gets
// no matching device and a 401/next() with nothing further to handle here.
router.get('/', authenticateDeviceOptional, asyncHandler(async (req, res, next) => {
  if (!req.device) return next();

  const cameras = await getCamerasForDevice(req.device.pk_device_id, req.device.tenant_id, req.device.code);

  return res.json({ cameras });
}));

// Edge-box-initiated catch-up sync: POST /api/cameras/device-sync
// The box pushes its own current camera list/settings (same shape GET /
// above hands it) so the app's record catches up to whatever the box
// actually has configured locally. After this, the normal pull-sync
// (device polls GET /) continues as the ongoing mechanism — this route
// exists for the one-time (or occasional) reverse direction, not as a
// replacement for it. Never deletes a camera the box didn't mention this
// round; those are reported back in `notInPayload` for a human to review.
router.post('/device-sync', authenticateDevice, asyncHandler(async (req, res) => {
  const cameras = req.body?.cameras;
  if (!Array.isArray(cameras) || cameras.length === 0) {
    return res.status(400).json({ message: 'cameras array is required' });
  }
  if (cameras.length > 200) {
    return res.status(400).json({ message: 'Maximum 200 cameras per sync' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await deviceHierarchySvc.syncCamerasFromDevice({
      tenantId: req.device.tenant_id,
      parentDeviceId: req.device.pk_device_id,
      cameras,
    }, client);
    await client.query('COMMIT');

    return res.json({
      success: true,
      summary: {
        created: result.created.length,
        updated: result.updated.length,
        failed: result.failed.length,
        notInPayload: result.notInPayload.length,
      },
      ...result,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.name === 'NotFoundError') {
      return res.status(404).json({ message: err.message });
    }
    throw err;
  } finally {
    client.release();
  }
}));

export { router as cameraRoutes };
