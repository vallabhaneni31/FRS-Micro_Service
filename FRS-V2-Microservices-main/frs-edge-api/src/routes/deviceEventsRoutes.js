/**
 * deviceEventsRoutes.js — Jetson → AWS event ingestion
 * Jetson is always the TCP initiator. AWS never calls Jetson.
 *
 * POST /api/events/photo-upload-url — mint a presigned S3 PUT url (Option B:
 *                              direct-to-S3, bypasses the API tier for photo
 *                              bytes; requires updated Jetson firmware — old
 *                              firmware keeps using photo_base64 on /events)
 * POST /api/events/photo-upload — upload the JPEG bytes directly in this
 *                              request (Option C: one round trip, no presign
 *                              step); returns image_id/image_url for
 *                              attendance or visitor events, same as Option B
 * POST /api/events          — Jetson pushes a single event
 * POST /api/events/batch    — Jetson pushes multiple events (offline drain)
 * GET  /api/events/commands — Jetson polls for pending commands
 *
 * Business logic lives in services/business/DeviceEventService.js, backed by
 * repositories/deviceEventRepository.js. This file only wires
 * routes -> middleware -> controller.
 */
import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import authenticateDevice from '../middleware/authenticateDevice.js';
import { deviceIngestLimiter } from '../middleware/rateLimit.js';
import { uploadSingle } from '../middleware/upload.js';
import DeviceEventController from '../controllers/DeviceEventController.js';

const router = express.Router();
const ac = (fn) => asyncHandler(fn);

// All device event routes require device JWT auth, and are throttled per-device
// (PERF-0001) rather than per-IP (they're exempt from the global limiter).
router.use(authenticateDevice);
router.use(deviceIngestLimiter);

router.post('/photo', uploadSingle('photo'), ac(DeviceEventController.uploadPhoto));
router.post('/photo-upload-url', ac(DeviceEventController.getPhotoUploadUrl));
router.post('/photo-upload', uploadSingle('image'), ac(DeviceEventController.uploadEventImage));
router.post('/', ac(DeviceEventController.postEvent));
router.post('/batch', ac(DeviceEventController.postBatch));
router.get('/commands', ac(DeviceEventController.getCommands));

export default router;
