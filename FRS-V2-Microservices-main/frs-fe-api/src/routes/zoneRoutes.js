/**
 * zoneRoutes.js — specs/0003-zone-analytics.
 * Mounted at /api/zones in server.js, every route gated by the
 * `zones.read` permission (seeded in frs-core-api, see
 * specs/0003-zone-analytics/tasks.md Task 1 — every route here 403s until
 * that permission is seeded/deployed). All routes are GET (read-only).
 */
import express from 'express';
import { requireAuth, requirePermission } from '../middleware/authz.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import ZoneAnalyticsController from '../controllers/ZoneAnalyticsController.js';

const router = express.Router();
router.use(requireAuth);
router.use(requirePermission('zones.read'));

const ac = (fn) => asyncHandler(fn.bind(ZoneAnalyticsController));

// Req 12 — batch endpoints (one request per view part instead of one per widget).
// Same zones.read gate as every route here (router.use above).
router.get('/batch/filters', ac(ZoneAnalyticsController.getFiltersBatch));
router.get('/batch/:view/:part', ac(ZoneAnalyticsController.getViewBatch));

// Req 2.1-2.3, 2.6 — filter-list sources
router.get('/', ac(ZoneAnalyticsController.listZones));
router.get('/entry-points', ac(ZoneAnalyticsController.listEntryPoints));
router.get('/departments', ac(ZoneAnalyticsController.listDepartments));
router.get('/cameras', ac(ZoneAnalyticsController.listCameras));

// Req 3 / 6 — occupancy, traffic, visit and summary analytics
router.get('/analytics/summary', ac(ZoneAnalyticsController.getSummary));
router.get('/analytics/occupancy', ac(ZoneAnalyticsController.getOccupancy));
router.get('/analytics/traffic', ac(ZoneAnalyticsController.getTraffic));
router.get('/analytics/peak-hours', ac(ZoneAnalyticsController.getPeakHours));
router.get('/analytics/heatmap', ac(ZoneAnalyticsController.getHeatmap));
router.get('/analytics/entry-points', ac(ZoneAnalyticsController.getEntryPointTraffic));
router.get('/analytics/departments', ac(ZoneAnalyticsController.getDepartmentDistribution));
router.get('/analytics/time-spent', ac(ZoneAnalyticsController.getTimeSpent));
router.get('/analytics/visits', ac(ZoneAnalyticsController.getVisits));

// Req 5 / 9 — events feed and employees list
router.get('/employees', ac(ZoneAnalyticsController.getEmployees));
router.get('/events/recent', ac(ZoneAnalyticsController.getRecentEvents));

// Req 9 / 3.8 — employee movement (matrix must stay before :employeeId)
router.get('/movement/matrix', ac(ZoneAnalyticsController.getMovementMatrix));
router.get('/movement/:employeeId', ac(ZoneAnalyticsController.getMovementTimeline));

// Req 8 — compare zones
router.get('/compare', ac(ZoneAnalyticsController.compareZones));

export { router as zoneRoutes };
