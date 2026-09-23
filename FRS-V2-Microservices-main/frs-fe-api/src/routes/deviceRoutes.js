/**
 * deviceRoutes.js — Device Management APIs
 * Hierarchy: Site → Building → Floor → Zone → NUG Box → Camera
 *
 * Business logic lives in services/business/DeviceHierarchyService.js,
 * backed by repositories/facilityDeviceRepository.js. This file only wires
 * routes -> middleware -> controller.
 *
 * NOTE (frs-fe-api split): the device-JWT (`authenticateDevice`) routes
 * formerly here — POST /:camId/heartbeat, POST /nug-boxes/:code/heartbeat,
 * GET /nug-boxes/:code/pending-enrollments, POST
 * /nug-boxes/:code/enrollment-quality, GET /enrollment-photos/:filename —
 * now live in frs-edge-api. Only the human/`requireAuth` admin routes
 * remain in this repo, so the DEVICE_JWT_PATHS auth-skip regex was removed.
 */
import express from 'express';
import { requireAuth, requirePermission } from '../middleware/authz.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import DeviceHierarchyController from '../controllers/DeviceHierarchyController.js';
import { startMaintenanceTasks } from '../services/business/DeviceHierarchyService.js';
import { cacheApi } from '../middleware/apiCache.js';

const router = express.Router();
const ac = (fn) => asyncHandler(fn);

function requireTenantScopeOrSuperAdmin(req, res, next) {
  const isSuperAdmin = req.auth?.jwtPayload?.realm_access?.roles?.includes('super_admin');
  if (isSuperAdmin) return next();
  // tenantId must come from the JWT-verified scope requireAuth already
  // resolved — checking the raw x-tenant-id header here would let this gate
  // pass on a spoofed header even though req.auth.scope.tenantId is unset.
  const tenantId = req.auth?.scope?.tenantId ?? null;
  if (!tenantId) {
    return res.status(400).json({ error: 'tenant scope required — include x-tenant-id header' });
  }
  return next();
}

router.use((req, res, next) => {
  return requireAuth(req, res, (err) => {
    if (err) return next(err);
    return requireTenantScopeOrSuperAdmin(req, res, next);
  });
});

// --- Background Maintenance Tasks ---
startMaintenanceTasks();

// GET / — list all cameras + NUG boxes for this tenant
router.get('/', requirePermission('devices.read'), ac(DeviceHierarchyController.listAllDevices));

// ── Buildings ─────────────────────────────────────────────────
router.get('/buildings', requirePermission('users.read'), ac(DeviceHierarchyController.listBuildings));
router.post('/buildings', requirePermission('attendance.manage'), ac(DeviceHierarchyController.createBuilding));
router.put('/buildings/:id', requirePermission('attendance.manage'), ac(DeviceHierarchyController.updateBuilding));
router.delete('/buildings/:id', requirePermission('attendance.manage'), ac(DeviceHierarchyController.deleteBuilding));

// ── Floors ────────────────────────────────────────────────────
router.get('/floors', requirePermission('users.read'), ac(DeviceHierarchyController.listFloorsForSite));
router.post('/floors', requirePermission('attendance.manage'), ac(DeviceHierarchyController.createFloorForSite));
router.get('/buildings/:buildingId/floors', requirePermission('users.read'), ac(DeviceHierarchyController.listFloorsForBuilding));
router.post('/buildings/:buildingId/floors', requirePermission('attendance.manage'), ac(DeviceHierarchyController.createFloor));
router.put('/floors/:id', requirePermission('attendance.manage'), ac(DeviceHierarchyController.updateFloor));
router.delete('/floors/:id', requirePermission('attendance.manage'), ac(DeviceHierarchyController.deleteFloor));

// ── Zones ─────────────────────────────────────────────────────
router.get('/floors/:floorId/zones', requirePermission('users.read'), ac(DeviceHierarchyController.listZonesForFloor));
router.post('/floors/:floorId/zones', requirePermission('attendance.manage'), ac(DeviceHierarchyController.createZone));
router.delete('/zones/:id', requirePermission('attendance.manage'), ac(DeviceHierarchyController.deleteZone));

// ── NUG Boxes ─────────────────────────────────────────────────
router.get('/nug-boxes', requirePermission('users.read'), ac(DeviceHierarchyController.listNugBoxes));
router.get('/nug-boxes/:id', requirePermission('users.read'), ac(DeviceHierarchyController.getNugBox));
router.post('/nug-boxes', requirePermission('attendance.manage'), ac(DeviceHierarchyController.createNugBox));
router.put('/nug-boxes/:id', requirePermission('attendance.manage'), ac(DeviceHierarchyController.updateNugBox));
router.delete('/nug-boxes/:id', requirePermission('attendance.manage'), ac(DeviceHierarchyController.deleteNugBox));

// NUG Box — Ping
router.post('/nug-boxes/:id/ping', requirePermission('users.read'), ac(DeviceHierarchyController.pingNugBox));

// NUG Box — Send reboot command
router.post('/nug-boxes/:id/reboot', requirePermission('attendance.manage'), ac(DeviceHierarchyController.rebootNugBox));

// NUG Box — Update thresholds on device
router.post('/nug-boxes/:id/apply-config', requirePermission('attendance.manage'), ac(DeviceHierarchyController.applyNugBoxConfig));

// ── Cameras ───────────────────────────────────────────────────
router.get('/cameras', requirePermission('users.read'), ac(DeviceHierarchyController.listCameras));
router.post('/cameras', requirePermission('attendance.manage'), ac(DeviceHierarchyController.createCamera));
router.put('/cameras/:id', requirePermission('attendance.manage'), ac(DeviceHierarchyController.updateCamera));
router.patch('/cameras/:camId/camera-mode', requirePermission('attendance.manage'), ac(DeviceHierarchyController.updateCameraMode));
router.delete('/cameras/:id', requirePermission('attendance.manage'), ac(DeviceHierarchyController.deleteCamera));

// Camera — capture a single frame (forwarded to Jetson)
router.post('/cameras/:id/capture-frame', requirePermission('users.read'), ac(DeviceHierarchyController.captureFrame));

// Camera — MJPEG stream proxy (accepts token via query param for <img src> compatibility)
router.get('/cameras/:id/stream', ac(DeviceHierarchyController.streamCamera));

// Camera ping (Asynchronous/Non-blocking)
router.post('/cameras/:id/ping', requirePermission('users.read'), ac(DeviceHierarchyController.pingCamera));

// ── Floor plan upload (base64) ───────────────────────────────
router.post('/floors/:id/floor-plan', requirePermission('attendance.manage'), ac(DeviceHierarchyController.uploadFloorPlan));

// ── Full hierarchy (for UI) ───────────────────────────────────
router.get('/hierarchy', requirePermission('users.read'), ac(DeviceHierarchyController.getFullHierarchy));

// ── Unified Edge Management (Edge AI Boxes + Connected Cameras) ─────────────
router.get('/edge-devices', cacheApi(15000), requirePermission('users.read'), ac(DeviceHierarchyController.listEdgeDevices));

// Decommission an edge device by code — tenant-scoped against facility_device
// (the canonical store), and remove any linked frs_nug_box hierarchy.
router.delete('/edge-devices/:code', requirePermission('attendance.manage'), ac(DeviceHierarchyController.decommissionEdgeDevice));

// --- Telemetry History API ---
router.get('/telemetry/history', requirePermission('users.read'), ac(DeviceHierarchyController.getTelemetryHistory));

// GET /activity-heatmap — per-device punch counts bucketed by hour-of-day.
router.get('/activity-heatmap', requirePermission('devices.read'), ac(DeviceHierarchyController.getActivityHeatmap));

// GET /employee-camera-heatmap — per-camera punch counts for a single employee, bucketed by hour-of-day.
router.get('/employee-camera-heatmap', requirePermission('devices.read'), ac(DeviceHierarchyController.getEmployeeCameraHeatmap));

// GET /activity-by-day — per-device punch counts bucketed by calendar day.
router.get('/activity-by-day', requirePermission('devices.read'), ac(DeviceHierarchyController.getActivityByDay));

// GET /zone-heatmap — per-zone unique-employee counts bucketed by hour-of-day.
router.get('/zone-heatmap', requirePermission('attendance.read'), ac(DeviceHierarchyController.getZoneHeatmap));

export { router as deviceRoutes };
