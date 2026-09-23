/**
 * deviceManagementRoutes.js — edge-facing subset of the original
 * deviceManagementRoutes.js (frs-core-api backend/api). Split per
 * docs/architecture/API_SPLIT_PLAN.md: this file keeps only the
 * `authenticateDevice` routes a Jetson edge box calls directly (heartbeat,
 * config polling, command polling/ack), plus the public `POST /devices/activate`
 * ZTP handshake (device-initiated, no requireAuth/authenticateDevice — gated
 * only by activationLimiter + a one-time PIN). All `requireAuth`-gated
 * register/provision/list/update/delete/site-assignment/activation-code-
 * generation/effective-config routes live in the frs-fe-api (frontend-facing)
 * sibling instead.
 */
import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import authenticateDevice from '../middleware/authenticateDevice.js';
import { activationLimiter } from '../middleware/rateLimit.js';
import DeviceManagementController from '../controllers/DeviceManagementController.js';

const router = express.Router();
const ac = (fn) => asyncHandler(fn);

// ============================================================================
// POST /api/device-management/devices/:code/heartbeat - Device Heartbeat
// ============================================================================
router.post('/devices/:code/heartbeat', authenticateDevice, ac(DeviceManagementController.heartbeat));

// Get effective config for a device (device-authenticated polling endpoint)
router.get('/device/config/:code', authenticateDevice, ac(DeviceManagementController.getEffectiveConfigForDevicePolling));
router.get('/devices/:code/config', authenticateDevice, ac(DeviceManagementController.getEffectiveConfigForDevicePolling));

// Get pending commands for a device (device-authenticated endpoint)
router.get('/devices/:code/commands', authenticateDevice, ac(DeviceManagementController.getPendingCommands));

// Mark command as executed (device-authenticated endpoint)
router.post('/devices/:code/commands/:commandId/executed', authenticateDevice, ac(DeviceManagementController.markCommandExecuted));

// ============================================================================
// POST /api/device-management/devices/activate - Edge Box Handshake Activation
// (public — device-initiated, no user/device auth yet; gated by PIN + rate limit)
// ============================================================================
router.post('/devices/activate', activationLimiter, ac(DeviceManagementController.activateDevice));

export default router;
