import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticateDevice } from '../middleware/authenticateDevice.js';
import { setSnapshot } from '../services/snapshotStore.js';
import { resolveCameraId } from '../services/cameraResolver.js';

// NOTE: this is a trimmed copy of backend/api-retail/src/routes/snapshotRoutes.js.
// Only the device-authenticated push route (POST /:id/snapshot) lives here.
// The user-facing read routes (GET /:id/snapshot, GET /:id/snapshot/cameras,
// GET /:id/snapshot/stream — all authenticateUser, plus the tokenFromQuery
// helper they needed for EventSource) were intentionally dropped — those
// belong in frs-fe-api. pool/authenticateUser imports removed as unused.

const router = express.Router();

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// POST /devices/:id/snapshot — device pushes latest annotated frame
router.post('/:id/snapshot', authenticateDevice, asyncHandler(async (req, res) => {
  if (req.params.id !== req.device.id) {
    return res.status(403).json({ error: 'device_id_mismatch' });
  }

  const { content_type = 'image/jpeg', captured_at, image_base64, camera_id } = req.body;
  if (!image_base64) {
    return res.status(400).json({ error: 'image_base64 required' });
  }

  let buffer;
  try {
    buffer = Buffer.from(image_base64, 'base64');
  } catch {
    return res.status(400).json({ error: 'invalid_base64' });
  }
  if (!buffer.length) {
    return res.status(400).json({ error: 'invalid_base64' });
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    return res.status(413).json({ error: 'image_too_large' });
  }

  const resolvedCameraId = await resolveCameraId(camera_id, req.device.store_id);

  setSnapshot(
    req.device.id,
    buffer,
    content_type,
    captured_at ? new Date(captured_at) : new Date(),
    resolvedCameraId
  );

  return res.json({ success: true });
}));

export { router as snapshotRoutes };
