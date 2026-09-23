/**
 * deviceRoutes.js — edge-facing subset of the original deviceRoutes.js
 * (frs-core-api backend/api). Split per docs/architecture/API_SPLIT_PLAN.md:
 * this file keeps only the `authenticateDevice` routes a Jetson edge box
 * calls directly (camera/nug-box heartbeat, enrollment-quality polling,
 * enrollment photo serving). All `requireAuth`-gated building/floor/zone/
 * nug-box CRUD, hierarchy, telemetry, and heatmap routes live in the
 * frs-fe-api (frontend-facing) sibling instead.
 */
import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import authenticateDevice from '../middleware/authenticateDevice.js';
import DeviceHierarchyController from '../controllers/DeviceHierarchyController.js';

const router = express.Router();
const ac = (fn) => asyncHandler(fn);

// Camera-level heartbeat: POST /api/devices/:camId/heartbeat
router.post('/:camId/heartbeat', authenticateDevice, ac(DeviceHierarchyController.cameraHeartbeat));

// NUG Box — Heartbeat (called by Jetson)
router.post('/nug-boxes/:code/heartbeat', authenticateDevice, ac(DeviceHierarchyController.nugBoxHeartbeat));

// ── Enrollment quality: event-driven Jetson polling ───────────────────────────

/**
 * GET /api/devices/nug-boxes/:code/pending-enrollments
 * Jetson polls this to get photos that need quality scoring.
 * Returns at most 20 items so the Jetson can process them in one batch.
 */
router.get('/nug-boxes/:code/pending-enrollments', authenticateDevice, ac(DeviceHierarchyController.listPendingEnrollments));

/**
 * POST /api/devices/nug-boxes/:code/enrollment-quality
 * Jetson pushes quality scores after processing photos.
 * Body: { results: [ { invitation_id, angle, confidence } ] }
 */
router.post('/nug-boxes/:code/enrollment-quality', authenticateDevice, ac(DeviceHierarchyController.pushEnrollmentQuality));

/**
 * GET /api/devices/enrollment-photos/:filename
 * Serves enrollment photos to authenticated Jetson devices.
 */
router.get('/enrollment-photos/:filename', authenticateDevice, ac(DeviceHierarchyController.serveEnrollmentPhoto));

export { router as deviceRoutes };
