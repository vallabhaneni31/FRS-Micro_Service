/**
 * deviceManagementRoutes.js — Phase 2: Device & Site Management
 * New endpoints for device lifecycle, provisioning, heartbeat
 *
 * Business logic lives in services/business/DeviceManagementService.js,
 * backed by repositories/deviceManagementRepository.js. This file only wires
 * routes -> middleware -> controller.
 *
 * NOTE (frs-fe-api split): the device-JWT (`authenticateDevice`) routes
 * formerly here — POST /devices/:code/heartbeat, GET /device/config/:code,
 * GET /devices/:code/config, GET /devices/:code/commands, POST
 * /devices/:code/commands/:commandId/executed, POST /devices/activate —
 * now live in frs-edge-api. Only the human/`requireAuth` admin routes
 * remain in this repo.
 */
import express from 'express';
import { requireAuth, requirePermission } from '../middleware/authz.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import DeviceManagementController from '../controllers/DeviceManagementController.js';

const router = express.Router();
const ac = (fn) => asyncHandler(fn);

// GET / — device management overview
router.get('/', requireAuth, requirePermission('devices.read'), ac(DeviceManagementController.getSummary));

// ============================================================================
// POST /api/device-management/devices - Register New Device
// ============================================================================
router.post('/devices', requireAuth, requirePermission('devices.write'), ac(DeviceManagementController.registerDevice));

// ============================================================================
// POST /api/device-management/devices/:code/provision - Generate Device Token
// ============================================================================
router.post('/devices/:code/provision', requireAuth, requirePermission('devices.write'), ac(DeviceManagementController.provisionDevice));

// POST /api/device-management/devices/:code/simulate-heartbeat - Admin Test Heartbeat
router.post('/devices/:code/simulate-heartbeat', requireAuth, requirePermission('devices.write'), ac(DeviceManagementController.simulateHeartbeat));

// ============================================================================
// GET /api/device-management/devices - List All Devices
// ============================================================================
router.get('/devices', requireAuth, requirePermission('devices.read'), ac(DeviceManagementController.listDevices));

// ============================================================================
// GET /api/device-management/devices/:code - Get Device Details
// ============================================================================
router.get('/devices/:code', requireAuth, requirePermission('devices.read'), ac(DeviceManagementController.getDeviceDetails));

// ============================================================================
// PATCH /api/device-management/devices/:code - Update Device Config
// ============================================================================
router.patch('/devices/:code', requireAuth, requirePermission('devices.write'), ac(DeviceManagementController.updateDevice));

// ============================================================================
// DELETE /api/device-management/devices/:code - Decommission Device
// ============================================================================
router.delete('/devices/:code', requireAuth, requirePermission('devices.write'), ac(DeviceManagementController.deleteDevice));

// POST /api/device-management/devices/:code/reboot — removed (Jetson polls commands via GET /api/events/commands)
// POST /api/device-management/devices/:code/ping   — removed (AWS cannot reach Jetson on private network)

// ============================================================================
// POST /api/device-management/sites/:siteId/devices - Assign Device to Site
// ============================================================================
router.post('/sites/:siteId/devices', requireAuth, requirePermission('devices.write'), ac(DeviceManagementController.assignDeviceToSite));

// ============================================================================
// GET /api/device-management/sites/:siteId/devices - List Site's Devices
// ============================================================================
router.get('/sites/:siteId/devices', requireAuth, requirePermission('devices.read'), ac(DeviceManagementController.listSiteDevices));

// ============================================================================
// DELETE /api/device-management/sites/:siteId/devices/:deviceCode - Unassign
// ============================================================================
router.delete('/sites/:siteId/devices/:deviceCode', requireAuth, requirePermission('devices.write'), ac(DeviceManagementController.unassignDevice));

// ============================================================================
// GET /api/device-management/config/effective/:deviceCode - Get Merged Config
// ============================================================================
router.get('/config/effective/:deviceCode', requireAuth, requirePermission('devices.read'), ac(DeviceManagementController.getEffectiveConfig));

// ============================================================================
// POST /api/device-management/devices/activation-code - Generate PIN
// ============================================================================
router.post('/devices/activation-code', requireAuth, requirePermission('devices.write'), ac(DeviceManagementController.generateActivationCode));

// ============================================================================
// GET /api/device-management/devices/activation-code/:pin/status - Check PIN Status
// ============================================================================
router.get('/devices/activation-code/:pin/status', requireAuth, requirePermission('devices.read'), ac(DeviceManagementController.getActivationCodeStatus));

export default router;
