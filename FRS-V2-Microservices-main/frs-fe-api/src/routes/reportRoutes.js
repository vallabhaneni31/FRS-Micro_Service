import express from "express";
import { requireAuth, requirePermission } from "../middleware/authz.js";
import { paginationGuard, dateRangeGuard } from "../middleware/paginationGuard.js";
import ReportController from "../controllers/ReportController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

const router = express.Router();
router.use(requireAuth);

const ac = (fn) => asyncHandler(fn);

// S-06: Max rows cap for any export/generation query
export const MAX_EXPORT_ROWS = 50000;

// S-06: Date range guards — handle both from/to and startDate/endDate param conventions
const fromToGuard      = dateRangeGuard({ maxDays: 365, fromParam: "from",      toParam: "to"      });
const startEndGuard    = dateRangeGuard({ maxDays: 365, fromParam: "startDate", toParam: "endDate" });

router.get(
  "/attendance/daily",
  requirePermission("analytics.read"),
  fromToGuard, startEndGuard,
  ac(ReportController.generateDailyAttendanceReport)
);

router.get(
  "/attendance/monthly",
  requirePermission("analytics.read"),
  fromToGuard, startEndGuard,
  ac(ReportController.generateMonthlyAttendanceReport)
);

router.get(
  "/attendance/yearly",
  requirePermission("analytics.read"),
  fromToGuard, startEndGuard,
  ac(ReportController.generateYearlyAttendanceReport)
);

router.get(
  "/attendance/custom",
  requirePermission("analytics.read"),
  fromToGuard, startEndGuard,
  ac(ReportController.generateCustomAttendanceReport)
);

router.get(
  "/attendance/summary",
  requirePermission("analytics.read"),
  fromToGuard, startEndGuard,
  ac(ReportController.getAttendanceSummary)
);

router.get("/employees/directory", requirePermission("analytics.read"), ac(ReportController.generateEmployeeDirectory));

router.get(
  "/employees/turnover",
  requirePermission("analytics.read"),
  fromToGuard, startEndGuard,
  ac(ReportController.generateTurnoverReport)
);

router.get(
  "/employees/tenure",
  requirePermission("analytics.read"),
  fromToGuard, startEndGuard,
  ac(ReportController.generateTenureReport)
);

router.get("/employees/department", requirePermission("analytics.read"), ac(ReportController.generateDepartmentReport));

router.get("/devices/health", requirePermission("analytics.read"), ac(ReportController.generateDeviceHealthReport));

router.get(
  "/devices/activity",
  requirePermission("analytics.read"),
  fromToGuard, startEndGuard,
  ac(ReportController.generateDeviceActivityReport)
);

router.get(
  "/devices/errors",
  requirePermission("analytics.read"),
  fromToGuard, startEndGuard,
  ac(ReportController.generateDeviceErrorReport)
);

router.get(
  "/analytics/peak-hours",
  requirePermission("analytics.read"),
  fromToGuard, startEndGuard,
  ac(ReportController.generatePeakHoursReport)
);

router.get(
  "/analytics/occupancy",
  requirePermission("analytics.read"),
  fromToGuard, startEndGuard,
  ac(ReportController.generateOccupancyReport)
);

router.get(
  "/analytics/trends",
  requirePermission("analytics.read"),
  fromToGuard, startEndGuard,
  ac(ReportController.generateTrendsReport)
);

router.get(
  "/analytics/compliance",
  requirePermission("analytics.read"),
  fromToGuard, startEndGuard,
  ac(ReportController.generateComplianceReport)
);

router.get("/export/:reportId/csv",   requirePermission("analytics.read"), ac(ReportController.exportToCsv));
router.get("/export/:reportId/pdf",   requirePermission("analytics.read"), ac(ReportController.exportToPdf));
router.get("/export/:reportId/excel", requirePermission("analytics.read"), ac(ReportController.exportToExcel));
router.get("/export/:reportId/json",  requirePermission("analytics.read"), ac(ReportController.exportToJson));

router.get(
  "/scheduled",
  requirePermission("analytics.read"),
  paginationGuard({ defaultLimit: 25, maxLimit: 200 }),
  ac(ReportController.getScheduledReports)
);
router.post("/scheduled",                 requirePermission("analytics.read"), ac(ReportController.scheduleReport));
router.put("/scheduled/:scheduleId",      requirePermission("analytics.read"), ac(ReportController.updateScheduledReport));
router.patch("/scheduled/:scheduleId",    requirePermission("analytics.read"), ac(ReportController.updateScheduledReport));
router.delete("/scheduled/:scheduleId",   requirePermission("analytics.read"), ac(ReportController.deleteScheduledReport));
router.post("/scheduled/:scheduleId/run", requirePermission("analytics.read"), ac(ReportController.runScheduledReport));

// /schedules aliases (frontend uses this path)
router.get(
  "/schedules",
  requirePermission("analytics.read"),
  paginationGuard({ defaultLimit: 25, maxLimit: 200 }),
  ac(ReportController.getScheduledReports)
);
router.post("/schedules",                 requirePermission("analytics.read"), ac(ReportController.scheduleReport));
router.put("/schedules/:scheduleId",      requirePermission("analytics.read"), ac(ReportController.updateScheduledReport));
router.patch("/schedules/:scheduleId",    requirePermission("analytics.read"), ac(ReportController.updateScheduledReport));
router.delete("/schedules/:scheduleId",   requirePermission("analytics.read"), ac(ReportController.deleteScheduledReport));
router.post("/schedules/:scheduleId/run", requirePermission("analytics.read"), ac(ReportController.runScheduledReport));

// Completed runs
router.get(
  "/completed",
  requirePermission("analytics.read"),
  paginationGuard({ defaultLimit: 25, maxLimit: 200 }),
  ac(ReportController.getCompletedRuns)
);
router.get("/completed/:runId/download", requirePermission("analytics.read"), ac(ReportController.downloadCompletedRun));

router.get(
  "/templates",
  requirePermission("analytics.read"),
  paginationGuard({ defaultLimit: 25, maxLimit: 200 }),
  ac(ReportController.getReportTemplates)
);
router.get("/templates/:templateId",    requirePermission("analytics.read"), ac(ReportController.getReportTemplate));
router.post("/templates",               requirePermission("analytics.read"), ac(ReportController.createReportTemplate));
router.put("/templates/:templateId",    requirePermission("analytics.read"), ac(ReportController.updateReportTemplate));
router.delete("/templates/:templateId", requirePermission("analytics.read"), ac(ReportController.deleteReportTemplate));

export { router as reportRoutes };
