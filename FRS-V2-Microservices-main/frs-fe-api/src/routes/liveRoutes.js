import express from "express";
import { requireAuth, requirePermission } from "../middleware/authz.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateScopeAccess } from "../middleware/scopeExtractor.js";
import { purgeApiCache } from "../middleware/apiCache.js";
import logger from '../utils/logger.js';
import { buildScopeWhere } from "../repositories/scopeSql.js";
import {
  getDashboardMetrics,
  getAttendanceTrends,
  getMonthlyAttendanceTrend,
  getDepartmentAnalytics,
  getWeeklyAnalytics,
  getDeptShiftAnalytics,
  getMonthlyCalendar,
  listAlerts,
  listAttendance,
  listDevices,
  listEmployees,
  listShifts,
  listDepartments,
  getSiteTimezone,
  getHourlyActivity,
  getCalendarEvents,
} from "../repositories/liveRepository.js";
import {
  listEmployeesSchema,
  listAttendanceSchema,
  listDevicesSchema,
  listAlertsSchema,
  getMetricsSchema,
  validateQuery,
} from "../validators/schemas.js";

import { cacheApi } from "../middleware/apiCache.js";

const router = express.Router();

// Apply auth first, then validate scope access against user's memberships
router.use(requireAuth);
router.use(validateScopeAccess);

/**
 * authScope — extract the validated scope from req.auth.scope.
 *
 * NEVER falls back to request headers here: tenant identity was already
 * locked to the JWT claim (Keycloak mode) or to the membership (API mode)
 * by requireAuth + validateScopeAccess.  Using headers as a fallback would
 * re-open the cross-tenant header-injection vector we closed in authz.js.
 */
function authScope(req) {
  return req.auth?.scope ?? null;
}

router.get(
  "/employees",
  cacheApi(15000),
  requirePermission("employees.read"),
  validateQuery(listEmployeesSchema),
  asyncHandler(async (req, res) => {
    const { limit, department, status } = req.validatedQuery;
    const employees = await listEmployees(authScope(req), { limit, department, status });
    return res.json({ data: employees });
  })
);


router.get("/departments", requirePermission("attendance.read"), asyncHandler(async (req, res) => {
  const scope = authScope(req);
  logger.info("[DEBUG] API Hit: /departments for tenant", scope?.tenantId);
  const rows = await listDepartments(scope?.tenantId);
  logger.info("[DEBUG] API Found", rows?.length, "departments");
  return res.json({ data: rows || [] });
}));

router.get("/shifts", requirePermission("attendance.read"), asyncHandler(async (req, res) => {
  const shifts = await listShifts(authScope(req)?.tenantId);
  return res.json({ data: shifts });
}));

router.get(
  "/attendance",
  cacheApi(15000),
  requirePermission("attendance.read"),
  validateQuery(listAttendanceSchema),
  asyncHandler(async (req, res) => {
    const { fromDate, toDate, limit } = req.validatedQuery;
    const scope = authScope(req);
    const records = await listAttendance(scope, { fromDate, toDate, limit });
    return res.json({ data: records });
  })
);

router.get(
  "/devices",
  cacheApi(15000),
  requirePermission("devices.read"),
  validateQuery(listDevicesSchema),
  asyncHandler(async (req, res) => {
    const { limit } = req.validatedQuery;
    const devices = await listDevices(authScope(req), { limit });
    return res.json({ data: devices });
  })
);

router.get(
  "/alerts",
  cacheApi(15000),
  requirePermission("attendance.read"),
  validateQuery(listAlertsSchema),
  asyncHandler(async (req, res) => {
    const { unreadOnly, limit } = req.validatedQuery;
    const alerts = await listAlerts(authScope(req), { unreadOnly, limit });
    return res.json({ data: alerts });
  })
);

router.get(
  "/metrics",
  cacheApi(15000),
  requirePermission("attendance.read"),
  validateQuery(getMetricsSchema),
  asyncHandler(async (req, res) => {
    const metrics = await getDashboardMetrics(authScope(req));
    return res.json(metrics);
  })
);


const handleLiveAudit = asyncHandler(async (req, res) => {
  const scope = authScope(req);
  const tenantId = scope?.tenantId;

  const userRole = req.auth?.user?.role;
  const memberships = req.auth?.memberships || [];

  const dbHasSuperAdmin = memberships.some(m => m.role === 'super_admin') || userRole === 'super_admin';
  const dbHasTenantAdmin = memberships.some(m => ['tenant_admin', 'admin'].includes(m.role)) || ['tenant_admin', 'admin'].includes(userRole);
  const dbHasSiteAdmin = memberships.some(m => m.role === 'site_admin') || userRole === 'site_admin';

  const isSiteAdmin = dbHasSiteAdmin || (!dbHasSuperAdmin && !dbHasTenantAdmin);

  const siteId = scope?.siteId || req.headers['x-site-id'] || memberships.find(m => m.scope?.siteId)?.scope?.siteId;

  const limit    = Math.min(Number(req.query.limit  || 50), 500);
  const offset   = Number(req.query.offset || 0);
  const search   = req.query.search || req.query.q || '';
  const action   = req.query.action || '';
  const category = req.query.category || '';
  const { pool } = await import("../db/pool.js");
  const categoryMap = {
    'Attendance': ['attendance.%'],
    'Enrollment': ['face.enroll%'],
    'Employee':   ['employee.%'],
    'User':       ['user.%'],
    'Auth':       ['user.login%','user.logout%'],
    'HR':         ['dept.%','shift.%'],
    'Roster':     ['roster.%'],
    'Device':     ['nug.%','camera.%','building.%'],
    'Settings':   ['settings.%'],
  };
  let whereClauses = ["a.tenant_id = $1"];
  let params = [tenantId];

  if (isSiteAdmin) {
    if (siteId) {
      params.push(siteId);
      whereClauses.push(`a.site_id = $${params.length}`);
    } else {
      whereClauses.push(`a.site_id IS NOT NULL`);
    }
    whereClauses.push(
      `LOWER(COALESCE(a.user_role, u.role, '')) NOT IN ('super_admin', 'superadmin', 'super admin', 'tenant_admin', 'tenant admin', 'admin', 'dev_user', 'dev user', 'dev', 'system', 'hr_manager', 'hr manager', 'hr')` +
      ` AND LOWER(COALESCE(a.user_role, u.role, '')) NOT LIKE '%super%'` +
      ` AND LOWER(COALESCE(a.user_role, u.role, '')) NOT LIKE '%tenant%'` +
      ` AND LOWER(COALESCE(a.user_role, u.role, '')) NOT LIKE '%dev%'` +
      ` AND LOWER(COALESCE(a.user_name, u.username, '')) NOT LIKE '%dev user%'` +
      ` AND LOWER(COALESCE(a.user_name, u.username, '')) NOT LIKE '%dev_user%'` +
      ` AND LOWER(COALESCE(a.user_name, u.username, '')) NOT LIKE '%super admin%'` +
      ` AND LOWER(COALESCE(a.user_name, u.username, '')) NOT LIKE '%tenant admin%'`
    );
  } else if (siteId) {
    params.push(siteId);
    whereClauses.push(`(a.site_id = $${params.length} OR a.site_id IS NULL)`);
  }

  if (search) {
    params.push(`%${search}%`);
    whereClauses.push(`(a.action ILIKE $${params.length} OR a.details ILIKE $${params.length} OR COALESCE(a.user_name,'') ILIKE $${params.length} OR COALESCE(a.entity_name,'') ILIKE $${params.length} OR COALESCE(a.ip_address,'') ILIKE $${params.length})`);
  }
  if (action) {
    params.push(action);
    whereClauses.push(`a.action = $${params.length}`);
  }
  if (category && categoryMap[category]) {
    const prefixes = categoryMap[category];
    const clauses = prefixes.map(p => { params.push(p); return `a.action ILIKE $${params.length}`; });
    whereClauses.push(`(${clauses.join(' OR ')})`);
  }
  if (req.query.from) {
    params.push(req.query.from);
    whereClauses.push(`a.created_at >= $${params.length}`);
  }
  if (req.query.to) {
    params.push(req.query.to);
    whereClauses.push(`a.created_at <= $${params.length}::date + interval '1 day'`);
  }
  const where = whereClauses.join(' AND ');

  const { rows } = await pool.query(
    `SELECT
       a.pk_audit_id,
       a.action,
       a.details,
       a.ip_address,
       a.created_at,
       a.user_agent,
       a.method,
       a.entity_type,
       a.entity_id,
       a.entity_name,
       a.before_data,
       a.after_data,
       a.source,
       a.tenant_id,
       COALESCE(a.user_name, u.email, u.username) AS user_name,
       COALESCE(a.user_role, u.role)               AS user_role
     FROM audit_log a
     LEFT JOIN frs_user u ON u.pk_user_id = a.fk_user_id
     WHERE ${where}
     ORDER BY a.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  // Count total
  const countRes = await pool.query(
    `SELECT count(*)::int as total FROM audit_log a LEFT JOIN frs_user u ON u.pk_user_id = a.fk_user_id WHERE ${where}`,
    params
  );

  return res.json({ data: rows, total: countRes.rows[0].total });
});

router.get("/audit", requirePermission("attendance.read"), handleLiveAudit);
router.get("/activity-log", requirePermission("attendance.read"), handleLiveAudit);
router.get("/activity-logs", requirePermission("attendance.read"), handleLiveAudit);
router.get("/activity_log", requirePermission("attendance.read"), handleLiveAudit);

const handleLiveAuditSummary = asyncHandler(async (req, res) => {
  const scope = authScope(req);
  const tenantId = scope?.tenantId;
  const userRole = req.auth?.user?.role;
  const memberships = req.auth?.memberships || [];

  const dbHasSuperAdmin = memberships.some(m => m.role === 'super_admin') || userRole === 'super_admin';
  const dbHasTenantAdmin = memberships.some(m => ['tenant_admin', 'admin'].includes(m.role)) || ['tenant_admin', 'admin'].includes(userRole);
  const dbHasSiteAdmin = memberships.some(m => m.role === 'site_admin') || userRole === 'site_admin';

  const isSiteAdmin = dbHasSiteAdmin || (!dbHasSuperAdmin && !dbHasTenantAdmin);

  const siteId = scope?.siteId || req.headers['x-site-id'] || memberships.find(m => m.scope?.siteId)?.scope?.siteId;

  const { pool } = await import("../db/pool.js");
  let whereClauses = [`a.tenant_id = $1`];
  let params = [tenantId];

  if (isSiteAdmin) {
    if (siteId) {
      params.push(siteId);
      whereClauses.push(`a.site_id = $${params.length}`);
    } else {
      whereClauses.push(`a.site_id IS NOT NULL`);
    }
    whereClauses.push(
      `LOWER(COALESCE(a.user_role, u.role, '')) NOT IN ('super_admin', 'superadmin', 'super admin', 'tenant_admin', 'tenant admin', 'admin', 'dev_user', 'dev user', 'dev', 'system', 'hr_manager', 'hr manager', 'hr')` +
      ` AND LOWER(COALESCE(a.user_role, u.role, '')) NOT LIKE '%super%'` +
      ` AND LOWER(COALESCE(a.user_role, u.role, '')) NOT LIKE '%tenant%'` +
      ` AND LOWER(COALESCE(a.user_role, u.role, '')) NOT LIKE '%dev%'` +
      ` AND LOWER(COALESCE(a.user_name, u.username, '')) NOT LIKE '%dev user%'` +
      ` AND LOWER(COALESCE(a.user_name, u.username, '')) NOT LIKE '%dev_user%'` +
      ` AND LOWER(COALESCE(a.user_name, u.username, '')) NOT LIKE '%super admin%'` +
      ` AND LOWER(COALESCE(a.user_name, u.username, '')) NOT LIKE '%tenant admin%'`
    );
  } else if (siteId) {
    params.push(siteId);
    whereClauses.push(`(a.site_id = $${params.length} OR a.site_id IS NULL)`);
  }

  if (req.query.from) {
    params.push(req.query.from);
    whereClauses.push(`a.created_at >= $${params.length}`);
  }
  if (req.query.to) {
    params.push(req.query.to);
    whereClauses.push(`a.created_at <= $${params.length}::date + interval '1 day'`);
  }
  const where = whereClauses.join(' AND ');
  const { rows } = await pool.query(`
    SELECT
      CASE
        WHEN a.action LIKE 'attendance.%' THEN 'Attendance'
        WHEN a.action LIKE 'face.enroll%' THEN 'Enrollment'
        WHEN a.action LIKE 'employee.%'   THEN 'Employee'
        WHEN a.action LIKE 'user.%'       THEN 'User'
        WHEN a.action LIKE 'dept.%' OR a.action LIKE 'shift.%' THEN 'HR'
        WHEN a.action LIKE 'roster.%'     THEN 'Roster'
        WHEN a.action LIKE 'nug.%' OR a.action LIKE 'camera.%' OR a.action LIKE 'building.%' THEN 'Device'
        WHEN a.action LIKE 'settings.%' OR a.action LIKE 'system.%' OR a.action LIKE 'user.login%' THEN 'System'
        ELSE 'System'
      END as category,
      COUNT(*)::int as count
    FROM audit_log a
    LEFT JOIN frs_user u ON u.pk_user_id = a.fk_user_id
    WHERE ${where}
    GROUP BY category
    ORDER BY count DESC
  `, params);
  return res.json({ data: rows });
});

router.get("/audit/summary", requirePermission("attendance.read"), handleLiveAuditSummary);
router.get("/activity-log/summary", requirePermission("attendance.read"), handleLiveAuditSummary);
router.get("/activity-logs/summary", requirePermission("attendance.read"), handleLiveAuditSummary);
router.get("/activity_log/summary", requirePermission("attendance.read"), handleLiveAuditSummary);

// POST /api/live/alerts/mark-read — mark alert(s) as read
router.post("/alerts/mark-read", requirePermission("attendance.read"), asyncHandler(async (req, res) => {
  const { ids } = req.body; // array of alert IDs, or empty for all
  const scope = authScope(req);
  const { pool } = await import("../db/pool.js");
  if (ids?.length) {
    const { whereSql, values } = buildScopeWhere(scope, "");
    const idsPlaceholder = `$${values.length + 1}`;
    values.push(ids);
    await pool.query(
      `UPDATE system_alert SET is_read = true WHERE pk_alert_id = ANY(${idsPlaceholder}::bigint[]) AND ${whereSql}`,
      values
    );
  } else {
    const { whereSql, values } = buildScopeWhere(scope, "");
    await pool.query(
      `UPDATE system_alert SET is_read = true WHERE ${whereSql}`,
      values
    );
  }
  purgeApiCache('/live');
  return res.json({ success: true });
}));


// DELETE /api/live/alerts — clear all alerts
router.delete("/alerts", requirePermission("attendance.read"), asyncHandler(async (req, res) => {
  const scope = authScope(req);
  const { pool } = await import("../db/pool.js");
  const { whereSql, values } = buildScopeWhere(scope, "");
  await pool.query(
    `DELETE FROM system_alert WHERE ${whereSql}`,
    values
  );
  purgeApiCache('/live');
  return res.json({ success: true, message: 'All alerts cleared' });
}));

// DELETE /api/live/alerts/:id — clear a single alert
router.delete("/alerts/:id", requirePermission("attendance.read"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const scope = authScope(req);
  const { pool } = await import("../db/pool.js");
  const { whereSql, values } = buildScopeWhere(scope, "");
  const idPlaceholder = `$${values.length + 1}`;
  values.push(id);
  await pool.query(
    `DELETE FROM system_alert WHERE pk_alert_id = ${idPlaceholder} AND ${whereSql}`,
    values
  );
  purgeApiCache('/live');
  return res.json({ success: true, message: 'Alert deleted successfully' });
}));


// GET /api/live/accuracy-trend — daily recognition confidence for last 7 days
router.get("/accuracy-trend", requirePermission("devices.read"), asyncHandler(async (req, res) => {
  const scope = authScope(req);
  const tenantId = scope?.tenantId;
  const { pool } = await import("../db/pool.js");
  const { rows } = await pool.query(
    `SELECT
       TO_CHAR(attendance_date, 'Dy') as day,
       attendance_date,
       ROUND(AVG(recognition_accuracy)::numeric, 1) as accuracy,
       COUNT(*) as scans
     FROM attendance_record
     WHERE tenant_id = $1
       AND attendance_date >= CURRENT_DATE - INTERVAL '7 days'
       AND recognition_accuracy IS NOT NULL
     GROUP BY attendance_date
     ORDER BY attendance_date ASC`,
    [tenantId]
  );

  const siteTz = await getSiteTimezone(scope?.siteId || null);
  // Fill missing days with 0
  const result = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: siteTz }).format(d);
    const day = new Intl.DateTimeFormat('en-US', { timeZone: siteTz, weekday: 'short' }).format(d);
    const found = rows.find(r => r.attendance_date?.toISOString?.()?.slice(0,10) === dateStr
                               || String(r.attendance_date).slice(0,10) === dateStr);
    result.push({
      day,
      accuracy: found ? Number(found.accuracy) : 0,
      scans: found ? Number(found.scans) : 0,
    });
  }
  return res.json({ data: result });
}));

// GET /api/live/trends — 30-day attendance trend
router.get("/trends", requirePermission("attendance.read"), asyncHandler(async (req, res) => {
  const rows = await getAttendanceTrends(authScope(req));
  return res.json({ data: rows });
}));


// GET /api/live/trends/monthly — Last 30 days attendance
router.get("/trends/monthly", requirePermission("attendance.read"), asyncHandler(async (req, res) => {
  const rows = await getMonthlyAttendanceTrend(authScope(req));
  return res.json({ data: rows });
}));


router.get("/trends/departments", requirePermission("attendance.read"), asyncHandler(async (req, res) => {
  const rows = await getDepartmentAnalytics(authScope(req)?.tenantId);
  return res.json({ data: rows });
}));

router.get("/trends/weekly", requirePermission("attendance.read"), asyncHandler(async (req, res) => {
  const scope = authScope(req);
  const rows = await getWeeklyAnalytics(scope?.tenantId, scope?.siteId);
  return res.json({ data: rows });
}));

router.get("/calendar", cacheApi(15000), requirePermission("attendance.read"), asyncHandler(async (req, res) => {
  const scope = authScope(req);
  const year  = Number(req.query.year  || new Date().getFullYear());
  const month = Number(req.query.month || new Date().getMonth() + 1);
  const rows = await getMonthlyCalendar(scope?.tenantId, scope?.siteId, year, month);
  return res.json({ data: rows, year, month });
}));

router.get("/dept-shift-analytics", cacheApi(15000), requirePermission("attendance.read"), asyncHandler(async (req, res) => {
  const scope = authScope(req);
  const rows = await getDeptShiftAnalytics(scope);
  return res.json({ data: rows });
}));


router.get("/activity/hourly", cacheApi(15000), requirePermission("attendance.read"), asyncHandler(async (req, res) => {
  const data = await getHourlyActivity(authScope(req));
  return res.json({ data });
}));

// GET /api/live/events - Fetch public holidays and events from Google Calendar
router.get("/events", requirePermission("attendance.read"), asyncHandler(async (req, res) => {
  const year = Number(req.query.year || new Date().getFullYear());
  const month = Number(req.query.month || new Date().getMonth() + 1);
  const data = await getCalendarEvents(year, month);
  return res.json({ data, year, month });
}));

// GET /api/live/visitor-buffer — inspect pending / recent visitor buffer records
// Query params: status (pending|employee_match|promoted), limit (default 50)
router.get("/visitor-buffer", requirePermission("attendance.read"), asyncHandler(async (req, res) => {
  const tenantId = authScope(req)?.tenantId;
  const { pool } = await import("../db/pool.js");
  const status = req.query.status || 'pending';
  const limit  = Math.min(Number(req.query.limit || 50), 200);

  const { rows } = await pool.query(
    `SELECT
       vb.pk_buffer_id,
       vb.device_code,
       vb.tracking_id,
       vb.confidence,
       vb.photo_url,
       vb.status,
       vb.buffered_at,
       vb.validated_at,
       vb.validation_note,
       vb.person_id,
       vb.matched_employee_id,
       e.full_name   AS matched_employee_name,
       e.employee_code AS matched_employee_code
     FROM visitor_buffer vb
     LEFT JOIN hr_employee e ON e.pk_employee_id = vb.matched_employee_id
     WHERE vb.tenant_id = $1::uuid
       AND ($2 = 'all' OR vb.status = $2)
     ORDER BY vb.buffered_at DESC
     LIMIT $3`,
    [tenantId, status, limit]
  );

  const counts = await pool.query(
    `SELECT status, COUNT(*)::int AS cnt
     FROM visitor_buffer WHERE tenant_id = $1::uuid
     GROUP BY status`,
    [tenantId]
  );

  const summary = Object.fromEntries(counts.rows.map(r => [r.status, r.cnt]));
  return res.json({ data: rows, summary, status, limit });
}));

export { router as liveRoutes };
