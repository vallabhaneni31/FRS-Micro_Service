import { pool } from "../db/pool.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { getSiteTimezone, listAttendance } from "../repositories/liveRepository.js";
import express from "express";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import ExcelJS from "exceljs";
import { requireAuth, requirePermission } from "../middleware/authz.js";
import { validateScopeAccess } from "../middleware/scopeExtractor.js";
import { tenantOwnsPhoto } from "../middleware/photoAccess.js";
import { paginationGuard, dateRangeGuard } from "../middleware/paginationGuard.js";
import AttendanceController from "../controllers/AttendanceController.js";
import logger from '../utils/logger.js';
const router = express.Router();

// NOTE (frs-fe-api split): the device-JWT (`authenticateDevice`) ingest
// routes formerly here — POST /frame, POST /bulk-sync, POST /direction —
// now live in frs-edge-api. Only the human/`requireAuth` routes remain in
// this repo.

// GET /api/attendance/photos/:filename — serves attendance proof photos, either by direct filename or by empId_date.jpg convention.
// Supports thumbnail generation via ?w=width query parameter.
// FIX: this route was registered BEFORE this router's own `router.use(requireAuth)`
// below (Express matches routes in registration order), so it was reachable with
// ZERO authentication or tenant scoping at all — worse than the /uploads static
// mount, since this is the endpoint the frontend actually calls for photo display.
router.get('/photos/:filename', requireAuth, validateScopeAccess, requirePermission('attendance.read'), asyncHandler(async (req, res) => {
  const { filename } = req.params;
  const width = req.query.w ? parseInt(req.query.w, 10) : null;
  const tenantId = req.auth?.scope?.tenantId;
  if (!tenantId) return res.status(403).json({ error: 'Forbidden' });

  // Pattern match for empId_date.jpg (e.g. 20_2026-07-02.jpg)
  const match = filename.match(/^(\d+)_(\d{4}-\d{2}-\d{2})\.jpg$/);
  let fileToServe = null;

  if (match) {
    const empId = parseInt(match[1], 10);
    const dateStr = match[2];

    try {
      const { rows } = await pool.query(
        `SELECT checkin_photo_url, checkout_photo_url
         FROM attendance_record
         WHERE fk_employee_id = $1 AND attendance_date = $2 AND tenant_id = $3::uuid LIMIT 1`,
        [empId, dateStr, tenantId]
      );

      if (rows.length > 0) {
        const relUrl = rows[0].checkin_photo_url || rows[0].checkout_photo_url;
        if (relUrl) {
          fileToServe = resolvePhotoPath(relUrl);
        }
      }
    } catch (e) {
      logger.error({ e, filename }, '[attendanceRoutes] Failed to resolve photo from database');
    }
  } else {
    // Treat as direct filename — verify this tenant actually owns a record
    // referencing it before serving (same check used by jetsonRoutes.js and
    // the /uploads static mount; see middleware/photoAccess.js).
    const safeFilename = path.basename(filename);
    const owned = await tenantOwnsPhoto(tenantId, safeFilename);
    if (owned) {
      const uploadsDir = path.join(process.cwd(), 'uploads/attendance-photos');
      const directPath = path.join(uploadsDir, safeFilename);
      if (fs.existsSync(directPath)) {
        fileToServe = directPath;
      }
    }
  }

  if (!fileToServe) {
    return res.status(404).json({ error: 'Photo not found' });
  }

  // Handle on-the-fly thumbnail resizing
  if (width && width > 0 && width <= 2000) {
    const cacheDir = path.join(process.cwd(), 'uploads/.cache');
    try {
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      const cacheKey = `${width}_${path.basename(fileToServe)}`;
      const cachePath = path.join(cacheDir, cacheKey);

      if (fs.existsSync(cachePath)) {
        return res.sendFile(cachePath);
      }

      await sharp(fileToServe)
        .resize(width)
        .jpeg({ quality: 85 })
        .toFile(cachePath);

      return res.sendFile(cachePath);
    } catch (err) {
      logger.error({ err, fileToServe }, 'Failed to generate image thumbnail');
      return res.sendFile(fileToServe); // Fallback to original image
    }
  }

  return res.sendFile(fileToServe);
}));

router.use(requireAuth);

const ac = (fn) => asyncHandler(fn.bind(AttendanceController));

router.post("/mark", requirePermission("attendance.write"), ac(AttendanceController.markAttendance));
router.post("/batch", requirePermission("attendance.write"), ac(AttendanceController.batchMarkAttendance));
router.get("/today", requirePermission("attendance.read"), ac(AttendanceController.getTodayAttendance));
router.get("/employee/:employeeId", requirePermission("attendance.read"), ac(AttendanceController.getEmployeeAttendance));
router.get("/date-range",
  requirePermission("attendance.read"),
  dateRangeGuard({ maxDays: 180, fromParam: 'from', toParam: 'to' }),
  dateRangeGuard({ maxDays: 180, fromParam: 'startDate', toParam: 'endDate' }),
  paginationGuard({ defaultLimit: 50, maxLimit: 500 }),
  ac(AttendanceController.getAttendanceByDateRange));
router.get("/current", requirePermission("attendance.read"), ac(AttendanceController.getCurrentlyPresent));
router.get("/stats", requirePermission("analytics.read"), ac(AttendanceController.getAttendanceStats));
router.get("/reports/daily",
  requirePermission("analytics.read"),
  dateRangeGuard({ maxDays: 180, fromParam: 'from', toParam: 'to' }),
  dateRangeGuard({ maxDays: 180, fromParam: 'startDate', toParam: 'endDate' }),
  ac(AttendanceController.getDailyReport));
router.get("/reports/monthly",
  requirePermission("analytics.read"),
  dateRangeGuard({ maxDays: 180, fromParam: 'from', toParam: 'to' }),
  dateRangeGuard({ maxDays: 180, fromParam: 'startDate', toParam: 'endDate' }),
  ac(AttendanceController.getMonthlyReport));
router.get("/reports/export",
  requirePermission("analytics.read"),
  dateRangeGuard({ maxDays: 180, fromParam: 'from', toParam: 'to' }),
  dateRangeGuard({ maxDays: 180, fromParam: 'startDate', toParam: 'endDate' }),
  paginationGuard({ defaultLimit: 50, maxLimit: 500 }),
  ac(AttendanceController.exportAttendance));
router.put("/:id/correct", requirePermission("attendance.write"), ac(AttendanceController.correctAttendance));
router.delete("/:id", requirePermission("attendance.write"), ac(AttendanceController.deleteAttendance));

// ─── GET /api/attendance/dwell — per-location time spent ("dwell time") ──────────
// Reconstructs one employee's movement for a day from device_events presence
// pings (each face recognition = "seen at this device's location"). The gap
// between arriving at one location and the next = time spent at the first.
// Devices are tagged with a zone_type (work / break / other) via facility_device,
// so totals roll up into productive vs break time.
router.get('/dwell',
  requirePermission('attendance.read'),
  asyncHandler(async (req, res) => {
    const tenantId = req.headers['x-tenant-id'] || req.auth?.scope?.tenantId || null;
    const siteId = req.headers['x-site-id'] || req.auth?.scope?.siteId || null;
    const employeeId = req.query.employeeId;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date)) ? String(req.query.date) : null;
    if (!tenantId) return res.status(400).json({ error: 'tenant scope required' });
    if (!employeeId) return res.status(400).json({ error: 'employeeId is required' });
    if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });

    const tz = await getSiteTimezone(siteId);

    // Resolve the subject — corporate employee or education student — and choose
    // the matching attendance_ping foreign key + day-bounds source.
    const { rows: tRows } = await pool.query(
      `SELECT vertical FROM tenants WHERE pk_tenant_id = $1::uuid`, [tenantId]
    );
    const isEducation = tRows[0]?.vertical === 'education';

    let subject, pingFk, checkOut = null, checkIn = null;
    if (isEducation) {
      const { rows } = await pool.query(
        `SELECT pk_student_id AS id, name AS full_name FROM edu_student
         WHERE fk_tenant_id = $1::uuid AND pk_student_id::text = $2 LIMIT 1`,
        [tenantId, String(employeeId)]
      );
      if (!rows.length) return res.status(404).json({ error: 'student not found' });
      subject = rows[0];
      pingFk = 'fk_student_id';
      const { rows: att } = await pool.query(
        `SELECT check_in_at AS check_in, check_out_at AS check_out FROM student_attendance
         WHERE fk_tenant_id = $1::uuid AND fk_student_id = $2 AND attendance_date = $3 LIMIT 1`,
        [tenantId, subject.id, date]
      );
      checkOut = att[0]?.check_out ? new Date(att[0].check_out) : null;
      checkIn = att[0]?.check_in ? new Date(att[0].check_in) : null;
    } else {
      const { rows } = await pool.query(
        `SELECT pk_employee_id AS id, full_name FROM hr_employee
         WHERE tenant_id = $1::uuid AND pk_employee_id::text = $2 LIMIT 1`,
        [tenantId, String(employeeId)]
      );
      if (!rows.length) return res.status(404).json({ error: 'employee not found' });
      subject = rows[0];
      pingFk = 'fk_employee_id';
      const { rows: att } = await pool.query(
        `SELECT check_in, check_out FROM attendance_record
         WHERE tenant_id = $1::uuid AND fk_employee_id = $2 AND attendance_date = $3 LIMIT 1`,
        [tenantId, subject.id, date]
      );
      checkOut = att[0]?.check_out ? new Date(att[0].check_out) : null;
      checkIn = att[0]?.check_in ? new Date(att[0].check_in) : null;
    }

    // Ordered presence pings for that subject on that day, with each device's
    // location label + zone tag joined in. occurred_at is the real event time
    // (set when the ping was written). pingFk is a fixed whitelist, not user input.
    const { rows: pings } = await pool.query(
      `SELECT
         ap.occurred_at,
         ap.device_code,
         COALESCE(fd.name, ap.device_code)      AS location_name,
         COALESCE(fd.zone_type, 'unassigned')   AS zone_type,
         fd.zone_label
       FROM attendance_ping ap
       LEFT JOIN facility_device fd
         ON fd.external_device_id = ap.device_code AND fd.tenant_id = ap.tenant_id
       WHERE ap.tenant_id = $1::uuid
         AND ap.${pingFk} = $2
         AND (ap.occurred_at AT TIME ZONE $4)::date = $3::date
       ORDER BY ap.occurred_at ASC`,
      [tenantId, subject.id, date, tz]
    );

    // "Ongoing" (still on site) only makes sense for the current day in the site
    // timezone. For a past day with no check-out we simply don't know the leave
    // time — leave it null rather than claiming the person is still there.
    const todayInTz = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    const isToday = todayInTz === date;

    // Collapse consecutive pings at the SAME location into a single arrival.
    const arrivals = [];
    for (const p of pings) {
      const last = arrivals[arrivals.length - 1];
      if (last && last.device_code === p.device_code) continue; // still at same place
      arrivals.push({
        device_code: p.device_code,
        location: p.location_name,
        zoneType: p.zone_type,
        zoneLabel: p.zone_label || null,
        arrivedAt: new Date(p.occurred_at),
      });
    }

    // Build segments: each lasts until the next arrival; the last is capped at
    // check-out, or — if the person is still on site today — at "now" so the
    // current stop still counts elapsed time (flagged ongoing, no fixed leftAt).
    const now = new Date();
    const segments = arrivals.map((a, i) => {
      const next = arrivals[i + 1];
      const ongoing = !next && !checkOut && isToday;
      const closedLeftAt = next ? next.arrivedAt : checkOut;        // null when ongoing
      const effectiveEnd = closedLeftAt || (ongoing ? now : null);
      const minutes = effectiveEnd ? Math.max(0, Math.round((effectiveEnd - a.arrivedAt) / 60000)) : null;
      return {
        location: a.location,
        deviceCode: a.device_code,
        zoneType: a.zoneType,
        zoneLabel: a.zoneLabel,
        arrivedAt: a.arrivedAt.toISOString(),
        leftAt: closedLeftAt ? closedLeftAt.toISOString() : null,
        minutes,
        ongoing,
      };
    });

    // Roll up totals by zone and by location.
    const totalsByZone = { work: 0, break: 0, other: 0, unassigned: 0 };
    const locMap = new Map();
    let totalTrackedMinutes = 0;
    for (const s of segments) {
      if (s.minutes == null) continue;
      totalsByZone[s.zoneType] = (totalsByZone[s.zoneType] || 0) + s.minutes;
      totalTrackedMinutes += s.minutes;
      const key = s.location;
      if (!locMap.has(key)) locMap.set(key, { location: key, zoneType: s.zoneType, minutes: 0 });
      locMap.get(key).minutes += s.minutes;
    }

    // "Worked" = official check-in → check-out span. Tracked can exceed it when
    // a device saw the person before check-in or after check-out; the UI labels
    // that difference instead of conflating the two.
    const workedMinutes = (checkIn && checkOut) ? Math.max(0, Math.round((checkOut - checkIn) / 60000)) : null;

    // Productivity = share of tracked time spent in Work zones.
    const productivityPct = totalTrackedMinutes > 0
      ? Math.round((totalsByZone.work / totalTrackedMinutes) * 100) : null;

    // First/last device sighting vs official check-in/out.
    const firstPing = arrivals.length ? arrivals[0].arrivedAt : null;
    const lastSeg = segments[segments.length - 1];
    const lastActivity = lastSeg ? new Date(lastSeg.leftAt || lastSeg.arrivedAt) : null;
    const arrivedBeforeCheckInMin = (checkIn && firstPing && firstPing < checkIn)
      ? Math.round((checkIn - firstPing) / 60000) : 0;
    const leftAfterCheckOutMin = (checkOut && lastActivity && lastActivity > checkOut)
      ? Math.round((lastActivity - checkOut) / 60000) : 0;

    return res.json({
      employeeId: subject.id,
      employeeName: subject.full_name,
      date,
      tz,
      checkIn: checkIn ? checkIn.toISOString() : null,
      checkOut: checkOut ? checkOut.toISOString() : null,
      firstPingAt: firstPing ? firstPing.toISOString() : null,
      lastActivityAt: lastActivity ? lastActivity.toISOString() : null,
      arrivedBeforeCheckInMin,
      leftAfterCheckOutMin,
      segments,
      totalsByZone,
      totalsByLocation: Array.from(locMap.values()).sort((a, b) => b.minutes - a.minutes),
      totalTrackedMinutes,
      workedMinutes,
      productivityPct,
    });
  })
);

// ─── GET /api/attendance/dwell-summary — per-employee dwell rollup for a range ──
// Aggregates attendance_ping across [fromDate, toDate] into, per employee:
// time per zone, distinct device/location count, top location, total tracked.
// Powers the monthly grid's devices column + the modal's "this month" view.
// Dwell per device = sum of gaps to the next ping that SAME day (LEAD partitioned
// by employee+day); the last ping of each day has no close and is excluded.
router.get('/dwell-summary',
  requirePermission('attendance.read'),
  asyncHandler(async (req, res) => {
    const tenantId = req.headers['x-tenant-id'] || req.auth?.scope?.tenantId || null;
    const siteId = req.headers['x-site-id'] || req.auth?.scope?.siteId || null;
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    const fromDate = iso.test(String(req.query.fromDate)) ? String(req.query.fromDate) : null;
    const toDate = iso.test(String(req.query.toDate)) ? String(req.query.toDate) : null;
    if (!tenantId) return res.status(400).json({ error: 'tenant scope required' });
    if (!fromDate || !toDate) return res.status(400).json({ error: 'fromDate and toDate (YYYY-MM-DD) are required' });

    const tz = await getSiteTimezone(siteId);

    const { rows } = await pool.query(
      `WITH pings AS (
         SELECT fk_employee_id AS emp, device_code, occurred_at AS ts
         FROM attendance_ping
         WHERE tenant_id = $1::uuid AND fk_employee_id IS NOT NULL
           AND (occurred_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
       ),
       seg AS (
         SELECT emp, device_code, ts,
           LEAD(ts) OVER (PARTITION BY emp, (ts AT TIME ZONE $4)::date ORDER BY ts) AS next_ts
         FROM pings
       )
       SELECT s.emp,
              COALESCE(dept.name, 'Unassigned')         AS department,
              s.device_code,
              COALESCE(fd.name, s.device_code)          AS location,
              LOWER(COALESCE(fd.zone_type, 'unassigned')) AS zone_type,
              ROUND(SUM(EXTRACT(EPOCH FROM (s.next_ts - s.ts)) / 60))::int AS minutes
       FROM seg s
       LEFT JOIN facility_device fd
         ON fd.external_device_id = s.device_code AND fd.tenant_id = $1::uuid
       LEFT JOIN hr_employee emp ON emp.pk_employee_id = s.emp
       LEFT JOIN hr_department dept ON dept.pk_department_id = emp.fk_department_id
       WHERE s.next_ts IS NOT NULL
       GROUP BY s.emp, dept.name, s.device_code, fd.name, fd.zone_type`,
      [tenantId, fromDate, toDate, tz]
    );

    const employees = {};
    for (const r of rows) {
      const id = String(r.emp);
      if (!employees[id]) {
        employees[id] = {
          department: (r.department || 'Unassigned').trim(),
          deviceCount: 0, topLocation: null, totalMinutes: 0, productivityPct: null,
          totalsByZone: { work: 0, break: 0, other: 0, unassigned: 0 },
          locations: [],
        };
      }
      const e = employees[id];
      const mins = r.minutes || 0;
      const z = (r.zone_type || 'unassigned').toLowerCase();
      const validZone = (z === 'work' || z === 'break' || z === 'other' || z === 'unassigned') ? z : 'other';
      e.locations.push({ location: r.location, zoneType: validZone, minutes: mins });
      e.totalsByZone[validZone] = (e.totalsByZone[validZone] || 0) + mins;
      e.totalMinutes += mins;
    }
    for (const e of Object.values(employees)) {
      e.locations.sort((a, b) => b.minutes - a.minutes);
      e.deviceCount = e.locations.length;
      e.topLocation = e.locations[0]?.location ?? null;
      e.productivityPct = e.totalMinutes > 0 ? Math.round(((e.totalsByZone.work || 0) / e.totalMinutes) * 100) : null;
    }

    // Roll up by department: summed zone time, headcount, average productivity.
    const byDepartment = {};
    for (const e of Object.values(employees)) {
      const d = e.department || 'Unassigned';
      if (!byDepartment[d]) {
        byDepartment[d] = {
          department: d, employees: 0, totalMinutes: 0,
          totalsByZone: { work: 0, break: 0, other: 0, unassigned: 0 }, avgProductivityPct: null, _prodSum: 0, _prodN: 0
        };
      }
      const g = byDepartment[d];
      g.employees += 1;
      g.totalMinutes += e.totalMinutes;
      for (const k of Object.keys(g.totalsByZone)) g.totalsByZone[k] += e.totalsByZone[k] || 0;
      if (e.productivityPct != null) { g._prodSum += e.productivityPct; g._prodN += 1; }
    }
    const departments = Object.values(byDepartment).map(g => {
      const { _prodSum, _prodN, ...rest } = g;
      const avgProd = g.totalMinutes > 0 ? Math.round(((g.totalsByZone.work || 0) / g.totalMinutes) * 100) : (_prodN ? Math.round(_prodSum / _prodN) : null);
      return { ...rest, avgProductivityPct: avgProd };
    }).sort((a, b) => b.totalMinutes - a.totalMinutes);

    return res.json({ fromDate, toDate, tz, employees, departments });
  })
);


// S-06: Hard cap on export rows to prevent memory exhaustion
const MAX_EXPORT_ROWS = 50_000;

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Parse attendance_date safely without timezone shifting */
const formatDate = (dateVal) => {
  if (!dateVal) return '';
  const str = String(dateVal);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(str);
  if (isNaN(d.getTime())) return '';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

/** Format recognition_accuracy whether stored as 0-1 or 0-100 */
const formatAccuracy = (acc) => {
  if (acc === null || acc === undefined || acc === '') return '';
  const n = Number(acc);
  if (isNaN(n)) return '';
  return (n <= 1.0 ? (n * 100) : n).toFixed(1) + '%';
};

/** Validate and resolve a photo URL to an absolute filesystem path under uploads/ */
function resolvePhotoPath(relativeUrl) {
  if (!relativeUrl) return null;
  if (!relativeUrl.startsWith('/uploads/') && !relativeUrl.startsWith('uploads/')) return null;
  const normalized = path.normalize(relativeUrl);
  if (normalized.includes('..')) return null;
  const rel = normalized.startsWith('/') ? normalized.slice(1) : normalized;
  const fullPath = path.join(process.cwd(), rel);
  const uploadsDir = path.join(process.cwd(), 'uploads');
  if (!fullPath.startsWith(uploadsDir + path.sep)) return null;
  return fs.existsSync(fullPath) ? fullPath : null;
}

/** Build shared query rows for both export formats */
const queryAttendance = async (params, where) => pool.query(
  `SELECT
     e.full_name, e.employee_code, d.name AS department,
     a.attendance_date::text AS attendance_date,
     a.check_in, a.check_out,
     a.status, a.working_hours, a.overtime_hours,
     a.is_late, a.recognition_accuracy,
     a.checkin_photo_url, a.checkout_photo_url
   FROM attendance_record a
   JOIN hr_employee e ON e.pk_employee_id = a.fk_employee_id
   LEFT JOIN hr_department d ON d.pk_department_id = e.fk_department_id
   WHERE ${where.join(' AND ')}
   ORDER BY a.attendance_date DESC, e.full_name
   LIMIT ${MAX_EXPORT_ROWS}`,
  params
);

/** Build scope filter arrays from request */
const buildWhereParams = (req) => {
  const scope = req.auth?.scope || {};
  const { fromDate, toDate, status, department, search } = req.query;
  // x-tenant-id header takes precedence; fall back to JWT scope
  // If tenantId is null it means super_admin (global access) — do NOT filter by tenant
  const tenantId = req.headers['x-tenant-id'] || scope.tenantId || null;
  const siteId = req.headers['x-site-id'] || scope.siteId || null;

  const where = [];
  const params = [];

  // Only add tenant filter if a specific tenantId is known
  // (null = super_admin global access — show all tenants)
  if (tenantId) {
    params.push(tenantId);
    where.push(`a.tenant_id = $${params.length}::uuid`);
  }

  if (siteId) {
    params.push(Number(siteId));
    // Include records with this site_id OR records with no site set (they belong to the tenant)
    where.push(`(a.site_id = $${params.length} OR a.site_id IS NULL)`);
  }
  if (fromDate) { params.push(fromDate); where.push(`a.attendance_date >= $${params.length}`); }
  if (toDate) { params.push(toDate); where.push(`a.attendance_date <= $${params.length}`); }
  if (status) { params.push(status); where.push(`a.status = $${params.length}`); }
  if (department) { params.push(department); where.push(`d.name = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(e.full_name ILIKE $${params.length} OR d.name ILIKE $${params.length})`);
  }

  // Always have at least one condition to keep SQL valid
  if (where.length === 0) where.push('1=1');

  return { where, params, scope, fromDate, toDate };
};



// ─── GET /api/attendance/export/xlsx — Excel export with embedded photo thumbnails ─
// S-06: dateRangeGuard (max 180 days) prevents unbounded exports
router.get('/export/xlsx',
  requireAuth,
  requirePermission('attendance.read'),
  dateRangeGuard({ maxDays: 180, fromParam: 'fromDate', toParam: 'toDate' }),
  asyncHandler(async (req, res) => {
    const { scope, fromDate, toDate } = buildWhereParams(req);
    const siteTz = await getSiteTimezone(scope.siteId);

    // Use the same liveRepository.listAttendance path as the UI dashboard.
    // This fixes the empty-export bug where the old hardcoded queryAttendance SQL
    // diverged from the proven UI data path (LEFT JOIN from hr_employee).
    let rawRows;
    try {
      rawRows = await listAttendance(scope, {
        fromDate: fromDate || undefined,
        toDate: toDate || fromDate || undefined,
        limit: MAX_EXPORT_ROWS,
      });
    } catch (dbErr) {
      logger.error({ err: dbErr }, '[export/xlsx] DB query failed');
      return res.status(500).json({ message: 'Export failed: database error', detail: dbErr.message });
    }

    // Normalise fields — liveRepository returns attendance+employee combined rows
    const rows = rawRows.map(r => ({
      full_name: r.full_name || '',
      employee_code: r.employee_code || '',
      department: r.department_name || '',
      attendance_date: r.attendance_date,
      check_in: r.check_in,
      check_out: r.check_out,
      status: r.status || '',
      working_hours: r.working_hours,
      overtime_hours: r.overtime_hours,
      is_late: r.is_late || r.is_late_computed || false,
      break_duration_minutes: r.break_duration_minutes ?? null,
      checkin_photo_url: r.checkin_photo_url || null,
      checkout_photo_url: r.checkout_photo_url || null,
    }));

    const fmtBreak = (mins) => {
      if (mins == null || mins <= 0) return '';
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };

    const fmtTime = (iso) => {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleTimeString('en-US', { timeZone: siteTz, hour: '2-digit', minute: '2-digit', hour12: true });
    };

    // ── Build workbook ──────────────────────────────────────────────────────
    const wb = new ExcelJS.Workbook();
    wb.creator = 'FRS Attendance System';
    wb.created = new Date();

    const ws = wb.addWorksheet('Attendance', { views: [{ state: 'frozen', ySplit: 1 }] });

    // Column definitions — photos get a fixed wide column
    ws.columns = [
      { header: 'Name', key: 'name', width: 25 },
      { header: 'Code', key: 'code', width: 15 },
      { header: 'Department', key: 'dept', width: 20 },
      { header: 'Date', key: 'date', width: 18 },
      { header: 'Check In', key: 'cin', width: 22 },
      { header: 'Check Out', key: 'cout', width: 22 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Hours', key: 'hours', width: 12 },
      { header: 'Overtime', key: 'ot', width: 12 },
      { header: 'Late', key: 'late', width: 12 },
      { header: 'Break', key: 'brk', width: 12 },
      { header: 'Check-In Photo', key: 'photo_in', width: 20 },
      { header: 'Check-Out Photo', key: 'photo_out', width: 20 },
    ];

    // Style the header row
    const headerRow = ws.getRow(1);
    headerRow.height = 22;
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11, name: 'Calibri' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = {
        bottom: { style: 'thin', color: { argb: 'FF4A90D9' } },
      };
    });

    const STATUS_COLORS = {
      present: 'FFD1FAE5',
      late: 'FFFEF3C7',
      absent: 'FFFFE4E6',
      'on-leave': 'FFE0E7FF',
      'on-break': 'FFE0F2FE',
    };

    // Photo row height (px → points; Excel rows are in points ~0.75pt/px)
    const PHOTO_ROW_HEIGHT = 60;

    // Collect photos to embed AFTER all rows are added.
    // Embedding images inline (before the next ws.addRow call) caused ExcelJS to
    // create a phantom blank row whenever br.row referenced a row not yet in the sheet.
    const photoQueue = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rowNum = i + 2; // 1-indexed, row 1 is header
      const statusKey = (r.status || '').toLowerCase();
      const rowBg = STATUS_COLORS[statusKey] || 'FFFFFFFF';

      const dataRow = ws.addRow({
        name: r.full_name || '',
        code: r.employee_code || '',
        dept: r.department || '',
        date: formatDate(r.attendance_date),
        cin: r.check_in ? fmtTime(r.check_in) : '—',
        cout: r.check_out ? fmtTime(r.check_out) : (r.check_in ? 'Not Checked Out' : '—'),
        status: r.status ? r.status.charAt(0).toUpperCase() + r.status.slice(1) : '',
        hours: r.working_hours != null ? Number(r.working_hours).toFixed(2) : '',
        ot: r.overtime_hours != null ? Number(r.overtime_hours).toFixed(2) : '',
        late: r.is_late ? 'Late' : 'On time',
        brk: fmtBreak(r.break_duration_minutes),
        photo_in: '',
        photo_out: '',
      });

      dataRow.height = PHOTO_ROW_HEIGHT;

      // Style all cells in this row
      dataRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
        cell.font = { name: 'Calibri', size: 10 };
        cell.alignment = { vertical: 'middle', horizontal: colNum <= 3 ? 'left' : 'center' };
        cell.border = { bottom: { style: 'hair', color: { argb: 'FFDDDDDD' } } };
      });

      const inPath = resolvePhotoPath(r.checkin_photo_url);
      const outPath = resolvePhotoPath(r.checkout_photo_url);
      if (inPath) photoQueue.push({ filePath: inPath, col: 11, rowNum });
      if (outPath) photoQueue.push({ filePath: outPath, col: 12, rowNum });
    }

    // All rows now exist — safe to embed images without creating phantom rows
    for (const { filePath, col, rowNum } of photoQueue) {
      try {
        const imgBuf = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase().replace('.', '');
        const imgId = wb.addImage({ buffer: imgBuf, extension: ext === 'png' ? 'png' : 'jpeg' });
        ws.addImage(imgId, {
          tl: { col, row: rowNum - 1 },
          br: { col: col + 1, row: rowNum },
          editAs: 'oneCell',
        });
      } catch (e) {
        logger.warn({ e, filePath }, '[export/xlsx] Failed to embed photo');
      }
    }

    // Apply auto-width logic to prevent ####### on wider content
    ws.columns.forEach(column => {
      let maxLen = column.header ? column.header.length : 10;
      column.eachCell({ includeEmpty: true }, cell => {
        if (cell.value) {
          const str = cell.value.toString();
          if (str.length > maxLen) {
            maxLen = str.length;
          }
        }
      });
      // Widen the column based on max content length, capped at 50, but never narrower than the default setup
      column.width = Math.min(50, Math.max(column.width || 12, maxLen + 4));
    });

    // Auto-filter on header row
    ws.autoFilter = { from: 'A1', to: 'M1' };

    const filename = `attendance-${fromDate || 'all'}-to-${toDate || 'today'}.xlsx`;
    // Buffer the workbook fully in memory before sending — prevents partial/corrupt files
    // if an error occurs mid-stream after headers are already written.
    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.byteLength);
    res.end(Buffer.from(buffer));
  })
);

// ─── GET /api/attendance/export/csv — clean text CSV with photo URL column ───
// Use this if you need plain CSV. Photos are accessible URLs, not binary blobs.
// S-06: dateRangeGuard (max 180 days) prevents unbounded exports
router.get('/export/csv',
  requireAuth,
  requirePermission('attendance.read'),
  dateRangeGuard({ maxDays: 180, fromParam: 'fromDate', toParam: 'toDate' }),
  asyncHandler(async (req, res) => {
    const { scope, fromDate, toDate } = buildWhereParams(req);
    const siteTz = await getSiteTimezone(scope.siteId);

    let rawRows;
    try {
      rawRows = await listAttendance(scope, {
        fromDate: fromDate || undefined,
        toDate: toDate || fromDate || undefined,
        limit: MAX_EXPORT_ROWS,
      });
    } catch (dbErr) {
      logger.error({ err: dbErr }, '[export/csv] DB query failed');
      return res.status(500).json({ message: 'Export failed: database error', detail: dbErr.message });
    }

    // Normalise fields — liveRepository returns attendance+employee combined rows
    const rows = rawRows.map(r => ({
      full_name: r.full_name || '',
      employee_code: r.employee_code || '',
      department: r.department_name || '',
      attendance_date: r.attendance_date,
      check_in: r.check_in,
      check_out: r.check_out,
      status: r.status || '',
      working_hours: r.working_hours,
      overtime_hours: r.overtime_hours,
      is_late: r.is_late || r.is_late_computed || false,
      break_duration_minutes: r.break_duration_minutes ?? null,
      checkin_photo_url: r.checkin_photo_url || null,
      checkout_photo_url: r.checkout_photo_url || null,
    }));

    const fmtBreakCsv = (mins) => {
      if (mins == null || mins <= 0) return '';
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };

    const fmtTime = (iso) => {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleTimeString('en-US', { timeZone: siteTz, hour: '2-digit', minute: '2-digit', hour12: true });
    };

    // Build absolute photo URLs using request host so they are clickable
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const photoUrl = (relUrl) => {
      if (!relUrl) return '';
      // Validate it's an uploads path
      const p = resolvePhotoPath(relUrl);
      if (!p) return '';
      const rel = relUrl.startsWith('/') ? relUrl : '/' + relUrl;
      return baseUrl + rel;
    };

    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

    const headers = ['Name', 'Code', 'Department', 'Date', 'Check In', 'Check Out', 'Status', 'Hours (hrs)', 'Overtime (hrs)', 'Late', 'Break', 'Check-In Photo URL', 'Check-Out Photo URL'];
    const csvRows = rows.map(r => [
      r.full_name, r.employee_code, r.department || '',
      formatDate(r.attendance_date),
      r.check_in ? fmtTime(r.check_in) : '—', r.check_out ? fmtTime(r.check_out) : (r.check_in ? 'Not Checked Out' : '—'),
      r.status,
      r.working_hours != null ? Number(r.working_hours).toFixed(2) : '',
      r.overtime_hours != null ? Number(r.overtime_hours).toFixed(2) : '',
      r.is_late ? 'Late' : 'On time',
      fmtBreakCsv(r.break_duration_minutes),
      photoUrl(r.checkin_photo_url),
      photoUrl(r.checkout_photo_url),
    ].map(q).join(','));

    const csv = [headers.map(q).join(','), ...csvRows].join('\r\n');
    const filename = `attendance-${fromDate || 'all'}-to-${toDate || 'today'}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send('﻿' + csv);  // UTF-8 BOM for Excel
  })
);



// POST /api/attendance/correction — UI-driven attendance correction by employee + date
router.post('/correction', requirePermission('attendance.write'), asyncHandler(async (req, res) => {
  const { employee_id, date, status, check_in, check_out, note } = req.body || {};
  if (!employee_id || !date) return res.status(400).json({ message: 'employee_id and date are required' });

  const rawTenantId = req.headers['x-tenant-id'] || req.auth?.scope?.tenantId || req.auth?.tenantId;
  const tenantId = (rawTenantId && rawTenantId !== 'undefined' && rawTenantId !== 'null') ? rawTenantId : null;

  // The HR portal sends check_in/check_out as bare "HH:MM" strings (plain <input type="time">,
  // no date component), but attendance_record.check_in/check_out are `timestamp with time zone`
  // columns — a bare "HH:MM" is not a valid timestamptz literal and Postgres throws (22007).
  // Combine the time with `date` into a naive local timestamp, then let Postgres interpret it
  // in the site's timezone via `AT TIME ZONE` (same getSiteTimezone() + AT TIME ZONE convention
  // used throughout this file and liveRepository.js) so the stored instant reflects the site's
  // local wall-clock time rather than the API server's own timezone.
  const siteId = req.headers['x-site-id'] || req.auth?.scope?.siteId || null;
  const siteTz = await getSiteTimezone(siteId, tenantId);
  const toLocalTimestamp = (timeStr) => (timeStr ? `${date} ${timeStr}:00` : null);
  const checkInLocal = toLocalTimestamp(check_in);
  const checkOutLocal = toLocalTimestamp(check_out);

  // Find the attendance record
  const selectParams = [employee_id, date];
  let tenantFilter = '';
  if (tenantId) {
    selectParams.push(tenantId);
    tenantFilter = `AND tenant_id = $${selectParams.length}::uuid`;
  }

  const { rows } = await pool.query(
    `SELECT pk_attendance_id FROM attendance_record
     WHERE fk_employee_id = $1 AND attendance_date = $2 ${tenantFilter}
     LIMIT 1`,
    selectParams
  );

  if (!rows.length) {
    // Create the record if it doesn't exist
    const insertCols = ['fk_employee_id', 'attendance_date', 'check_in', 'check_out', 'status'];
    // $3/$4 are naive local timestamps (or NULL); AT TIME ZONE $6 converts them to a proper
    // timestamptz anchored to the site's timezone. `x AT TIME ZONE tz` on a NULL is NULL.
    const insertVals = ['$1', '$2', '$3::timestamp AT TIME ZONE $6', '$4::timestamp AT TIME ZONE $6', '$5'];
    const insertParams = [employee_id, date, checkInLocal, checkOutLocal, status || 'present', siteTz];
    if (tenantId) {
      insertCols.push('tenant_id');
      insertParams.push(tenantId);
      insertVals.push(`$${insertParams.length}::uuid`);
    }

    const { rows: ins } = await pool.query(
      `INSERT INTO attendance_record (${insertCols.join(', ')})
       VALUES (${insertVals.join(', ')})
       RETURNING *`,
      insertParams
    );
    return res.json(ins[0]);
  }

  const sets = [];
  const params = [rows[0].pk_attendance_id];
  let idx = 2;
  // Reserve one param for the site timezone, reused by both check_in/check_out expressions,
  // only when one of those fields is actually being updated.
  let tzParamIdx = null;
  if (check_in !== undefined || check_out !== undefined) {
    tzParamIdx = idx++;
    params.push(siteTz);
  }
  if (status !== undefined) { sets.push(`status = $${idx++}`); params.push(status); }
  if (check_in !== undefined) { sets.push(`check_in = $${idx++}::timestamp AT TIME ZONE $${tzParamIdx}`); params.push(checkInLocal); }
  if (check_out !== undefined) { sets.push(`check_out = $${idx++}::timestamp AT TIME ZONE $${tzParamIdx}`); params.push(checkOutLocal); }

  if (!sets.length) return res.status(400).json({ message: 'No fields to update' });

  const { rows: updated } = await pool.query(
    `UPDATE attendance_record SET ${sets.join(', ')} WHERE pk_attendance_id = $1 RETURNING *`,
    params
  );
  return res.json(updated[0]);
}));


export { router as attendanceRoutes };
