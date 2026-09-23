import express from "express";
import { requireAuth, requirePermission } from "../middleware/authz.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import DashboardController from "../controllers/DashboardController.js";

const router = express.Router();
router.use(requireAuth);

const dc = (fn) => asyncHandler(fn.bind(DashboardController));

router.get("/admin/summary",          requirePermission("analytics.read"), dc(DashboardController.getAdminSummary));
router.get("/admin/system-health",    requirePermission("analytics.read"), dc(DashboardController.getSystemHealth));
router.get("/admin/device-status",    requirePermission("analytics.read"), dc(DashboardController.getDeviceStatus));
router.get("/admin/alerts",           requirePermission("analytics.read"), dc(DashboardController.getActiveAlerts));

router.get("/hr/summary",             requirePermission("analytics.read"), dc(DashboardController.getHrSummary));
router.get("/hr/occupancy",           requirePermission("analytics.read"), dc(DashboardController.getCurrentOccupancy));
router.get("/hr/occupancy/history",   requirePermission("analytics.read"), dc(DashboardController.getOccupancyHistory));
router.get("/hr/attendance-today",    requirePermission("analytics.read"), dc(DashboardController.getTodayAttendance));
router.get("/hr/attendance-trends",   requirePermission("analytics.read"), dc(DashboardController.getAttendanceTrends));
router.get("/hr/department-summary",  requirePermission("analytics.read"), dc(DashboardController.getDepartmentSummary));
router.get("/hr/late-arrivals",       requirePermission("analytics.read"), dc(DashboardController.getLateArrivals));
router.get("/hr/early-departures",    requirePermission("analytics.read"), dc(DashboardController.getEarlyDepartures));
router.get("/hr/absentees",           requirePermission("analytics.read"), dc(DashboardController.getAbsentees));

router.get("/live/presence",          requirePermission("analytics.read"), dc(DashboardController.getLivePresence));
router.get("/live/floor/:floorId",    requirePermission("analytics.read"), dc(DashboardController.getFloorOccupancy));
router.get("/live/areas",             requirePermission("analytics.read"), dc(DashboardController.getAreaCounts));
router.get("/live/heatmap",           requirePermission("analytics.read"), dc(DashboardController.getHeatmapData));

router.get("/analytics/peak-hours",       requirePermission("analytics.read"), dc(DashboardController.getPeakHours));
router.get("/analytics/average-duration", requirePermission("analytics.read"), dc(DashboardController.getAverageDuration));
router.get("/analytics/employee-ranking", requirePermission("analytics.read"), dc(DashboardController.getEmployeeRanking));

export { router as dashboardRoutes };

