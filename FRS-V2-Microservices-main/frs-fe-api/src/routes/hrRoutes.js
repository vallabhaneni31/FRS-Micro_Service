/**
 * hrRoutes.js — HR management: departments, shifts
 */
import express from 'express';
import { requireAuth, requirePermission } from '../middleware/authz.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { pool } from '../db/pool.js';
import { validateBody } from '../validators/schemas.js';
import {
  createDepartmentSchema, updateDepartmentSchema, assignEmployeesSchema,
  createShiftSchema, updateShiftSchema,
  createRosterSchema, createRecurringRosterSchema, swapRosterSchema,
} from '../validators/hrSchemas.js';

const router = express.Router();
router.use(requireAuth);

import { writeAudit } from '../middleware/auditLog.js';
const getTenant = (req) => req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || null;

const validateIdParam = (paramName = 'id') => (req, res, next) => {
  const val = req.params[paramName];
  if (!val || !/^\d+$/.test(val)) {
    return res.status(400).json({ message: `Invalid ${paramName}: must be a positive integer` });
  }
  next();
};

// ── Departments ────────────────────────────────────────────────
router.get('/departments', requirePermission('users.read'), asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pk_department_id as id, name, code, color, description, head_employee_id,
       (SELECT count(*)::int FROM hr_employee e WHERE e.fk_department_id = d.pk_department_id AND e.status='active') as employee_count,
       (SELECT full_name FROM hr_employee WHERE pk_employee_id = d.head_employee_id) as head_employee_name
     FROM hr_department d WHERE d.tenant_id = $1 ORDER BY name`,
    [getTenant(req)]
  );
  return res.json({ data: rows });
}));

router.post('/departments', requirePermission('shifts.write'), validateBody(createDepartmentSchema), asyncHandler(async (req, res) => {
  const { name, code, color, description, head_employee_id } = req.validatedBody;
  const { rows } = await pool.query(
    `INSERT INTO hr_department (tenant_id, name, code, color, description, head_employee_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, code) DO UPDATE SET
       name=EXCLUDED.name, color=EXCLUDED.color,
       description=EXCLUDED.description, head_employee_id=EXCLUDED.head_employee_id
     RETURNING pk_department_id as id, name, code, color, description, head_employee_id`,
    [getTenant(req), name, code.toUpperCase(), color || null, description || null, head_employee_id || null]
  );
  await writeAudit({ req, action: 'dept.create', details: `Department created: ${name} (${code})` });
  return res.status(201).json(rows[0]);
}));

router.put('/departments/:id', requirePermission('shifts.write'), validateIdParam(), validateBody(updateDepartmentSchema), asyncHandler(async (req, res) => {
  const { name, code, color, description, head_employee_id } = req.validatedBody;
  const { rows } = await pool.query(
    `UPDATE hr_department SET
       name=COALESCE($2,name), code=COALESCE($3,code), color=COALESCE($4,color),
       description=COALESCE($5,description),
       head_employee_id=CASE WHEN $6::bigint IS NOT NULL THEN $6::bigint ELSE head_employee_id END
     WHERE pk_department_id=$1 AND tenant_id=$7
     RETURNING pk_department_id as id, name, code, color, description, head_employee_id`,
    [req.params.id, name, code, color, description, head_employee_id ?? null, getTenant(req)]
  );
  if (!rows.length) return res.status(404).json({ message: 'Not found' });
  return res.json(rows[0]);
}));

router.delete('/departments/:id', requirePermission('shifts.write'), validateIdParam(), asyncHandler(async (req, res) => {
  const force = req.query.force === 'true';
  if (!force) {
    const { rows: empCheck } = await pool.query(
      `SELECT count(*)::int as cnt FROM hr_employee WHERE fk_department_id=$1 AND status='active'`,
      [req.params.id]
    );
    if (empCheck[0].cnt > 0) {
      return res.status(409).json({
        message: `Cannot delete: ${empCheck[0].cnt} active employee(s) are assigned to this department.`,
        employee_count: empCheck[0].cnt,
      });
    }
  }
  await pool.query(
    `UPDATE hr_employee SET fk_department_id=NULL WHERE fk_department_id=$1`,
    [req.params.id]
  );
  await pool.query(
    `DELETE FROM hr_department WHERE pk_department_id=$1 AND tenant_id=$2`,
    [req.params.id, getTenant(req)]
  );
  await writeAudit({ req, action: 'dept.delete', details: `Department ${req.params.id} deleted` });
  return res.json({ success: true });
}));


// Assign employees to a department
router.post('/departments/:id/assign', requirePermission('employees.write'), validateIdParam(), validateBody(assignEmployeesSchema), asyncHandler(async (req, res) => {
  const { employee_ids } = req.validatedBody;
  const tenantId = getTenant(req);
  const deptId = req.params.id;

  await pool.query(
    `UPDATE hr_employee SET fk_department_id = NULL WHERE fk_department_id = $1 AND tenant_id = $2 AND NOT (pk_employee_id = ANY($3::bigint[]))`,
    [deptId, tenantId, employee_ids]
  );
  if (employee_ids.length > 0) {
    await pool.query(
      `UPDATE hr_employee SET fk_department_id = $1 WHERE pk_employee_id = ANY($2::bigint[]) AND tenant_id = $3`,
      [deptId, employee_ids, tenantId]
    );
  }
  await writeAudit({ req, action: 'dept.assign',
      details: `Department ${deptId} assigned to ${employee_ids.length} employee(s): [${employee_ids.join(',')}]` });
  return res.json({ success: true, updated: employee_ids.length });
}));

// ── Shifts ─────────────────────────────────────────────────────
router.get('/shifts', requirePermission('users.read'), asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pk_shift_id as id, name, shift_type, start_time, end_time,
            grace_period_minutes, is_flexible,
            COALESCE(break_duration_minutes, 0) as break_duration_minutes,
            COALESCE(work_days, '{Mon,Tue,Wed,Thu,Fri}'::text[]) as work_days,
       (SELECT count(*)::int FROM hr_employee e WHERE e.fk_shift_id = s.pk_shift_id AND e.status='active') as employee_count
     FROM hr_shift s WHERE s.tenant_id = $1 ORDER BY name`,
    [getTenant(req)]
  );
  return res.json({ data: rows });
}));

router.post('/shifts', requirePermission('shifts.write'), validateBody(createShiftSchema), asyncHandler(async (req, res) => {
  const {
    name, shift_type, start_time, end_time,
    grace_period_minutes, is_flexible,
    break_duration_minutes, work_days,
  } = req.validatedBody;
  const workDaysArr = Array.isArray(work_days) && work_days.length
    ? work_days
    : ['Mon','Tue','Wed','Thu','Fri'];
  const { rows } = await pool.query(
    `INSERT INTO hr_shift (tenant_id, name, shift_type, start_time, end_time,
                           grace_period_minutes, is_flexible, break_duration_minutes, work_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [getTenant(req), name, shift_type, start_time || null, end_time || null,
     grace_period_minutes, is_flexible, break_duration_minutes, workDaysArr]
  );
  return res.status(201).json(rows[0]);
}));

router.put('/shifts/:id', requirePermission('shifts.write'), validateIdParam(), validateBody(updateShiftSchema), asyncHandler(async (req, res) => {
  const {
    name, shift_type, start_time, end_time,
    grace_period_minutes, is_flexible,
    break_duration_minutes, work_days,
  } = req.validatedBody;
  const workDaysVal = Array.isArray(work_days) && work_days.length ? work_days : null;
  const { rows } = await pool.query(
    `UPDATE hr_shift SET
       name=COALESCE($2,name), shift_type=COALESCE($3,shift_type),
       start_time=COALESCE($4::time,start_time), end_time=COALESCE($5::time,end_time),
       grace_period_minutes=COALESCE($6,grace_period_minutes), is_flexible=COALESCE($7,is_flexible),
       break_duration_minutes=COALESCE($8,break_duration_minutes),
       work_days=COALESCE($9::text[],work_days)
     WHERE pk_shift_id=$1 AND tenant_id=$10 RETURNING *`,
    [req.params.id, name, shift_type, start_time, end_time,
     grace_period_minutes, is_flexible, break_duration_minutes ?? null, workDaysVal, getTenant(req)]
  );
  if (!rows.length) return res.status(404).json({ message: 'Not found' });
  return res.json(rows[0]);
}));

router.delete('/shifts/:id', requirePermission('shifts.write'), validateIdParam(), asyncHandler(async (req, res) => {
  // Unassign employees from this shift before deleting
  await pool.query(`UPDATE hr_employee SET fk_shift_id=NULL WHERE fk_shift_id=$1`, [req.params.id]);
  await pool.query(`DELETE FROM hr_shift WHERE pk_shift_id=$1 AND tenant_id=$2`, [req.params.id, getTenant(req)]);
  return res.json({ success: true });
}));

// Assign shift to employees
router.post('/shifts/:id/assign', requirePermission('employees.write'), validateIdParam(), validateBody(assignEmployeesSchema), asyncHandler(async (req, res) => {
  const { employee_ids } = req.validatedBody;
  const tenantId = getTenant(req);
  const shiftId = req.params.id;

  await pool.query(
    `UPDATE hr_employee SET fk_shift_id = NULL WHERE fk_shift_id = $1 AND tenant_id = $2 AND NOT (pk_employee_id = ANY($3::bigint[]))`,
    [shiftId, tenantId, employee_ids]
  );
  if (employee_ids.length > 0) {
    await pool.query(
      `UPDATE hr_employee SET fk_shift_id = $1 WHERE pk_employee_id = ANY($2::bigint[]) AND tenant_id = $3`,
      [shiftId, employee_ids, tenantId]
    );
  }
  await writeAudit({ req, action: 'shift.assign',
      details: `Shift ${shiftId} assigned to ${employee_ids.length} employee(s): [${employee_ids.join(',')}]` });
  return res.json({ success: true, updated: employee_ids.length });
}));



// ── Employee attendance for profile ───────────────────────────
router.get('/employees/:id/attendance', requirePermission('attendance.read'), validateIdParam(), asyncHandler(async (req, res) => {
  const { fromDate, toDate } = req.query;
  const tenantId = getTenant(req);
  const employeeId = req.params.id;

  let query = `
    SELECT a.*, e.full_name, e.employee_code,
            hs.is_flexible AS hs_is_flexible,
            hs.start_time AS hs_start_time,
            hs.grace_period_minutes AS hs_grace_period_minutes,
            COALESCE(

              (SELECT NULLIF(COUNT(*)::int, 0)
               FROM device_events de 
               LEFT JOIN frs_site s ON s.pk_site_id = COALESCE(a.site_id, e.site_ids[1])
               WHERE de.tenant_id = a.tenant_id 
                 AND de.event_type = 'EMPLOYEE_ENTRY' 
                 AND COALESCE(de.payload_json->>'employee_id', de.payload_json->>'employeeId') = a.fk_employee_id::text
                 AND (de.occurred_at AT TIME ZONE COALESCE(s.timezone, 'UTC'))::date = a.attendance_date
              ),
              CASE WHEN a.check_in IS NOT NULL THEN 1 ELSE 0 END
            ) AS check_in_count,
            COALESCE(
              (SELECT NULLIF(COUNT(*)::int, 0)
               FROM device_events de 
               LEFT JOIN frs_site s ON s.pk_site_id = COALESCE(a.site_id, e.site_ids[1])
               WHERE de.tenant_id = a.tenant_id 
                 AND de.event_type = 'EMPLOYEE_EXIT' 
                 AND COALESCE(de.payload_json->>'employee_id', de.payload_json->>'employeeId') = a.fk_employee_id::text
                 AND (de.occurred_at AT TIME ZONE COALESCE(s.timezone, 'UTC'))::date = a.attendance_date
              ),
              CASE WHEN a.check_out IS NOT NULL THEN 1 ELSE 0 END
            ) AS check_out_count,
            COALESCE(
              (SELECT json_agg(json_build_object('time', de.occurred_at, 'photo_url', CASE WHEN de.payload_json->>'event_time_raw' IS NOT NULL THEN NULL ELSE de.payload_json->>'photo_url' END) ORDER BY de.occurred_at ASC)
               FROM device_events de 
               LEFT JOIN frs_site s ON s.pk_site_id = COALESCE(a.site_id, e.site_ids[1])
               WHERE de.tenant_id = a.tenant_id 
                 AND de.event_type = 'EMPLOYEE_ENTRY' 
                 AND COALESCE(de.payload_json->>'employee_id', de.payload_json->>'employeeId') = a.fk_employee_id::text
                 AND (de.occurred_at AT TIME ZONE COALESCE(s.timezone, 'UTC'))::date = a.attendance_date
              ),
              CASE WHEN a.check_in IS NOT NULL THEN json_build_array(json_build_object('time', a.check_in, 'photo_url', a.checkin_photo_url)) ELSE '[]'::json END
            ) AS all_check_ins,
            COALESCE(
              (SELECT json_agg(json_build_object('time', de.occurred_at, 'photo_url', CASE WHEN de.payload_json->>'event_time_raw' IS NOT NULL THEN NULL ELSE de.payload_json->>'photo_url' END) ORDER BY de.occurred_at ASC)
               FROM device_events de 
               LEFT JOIN frs_site s ON s.pk_site_id = COALESCE(a.site_id, e.site_ids[1])
               WHERE de.tenant_id = a.tenant_id 
                 AND de.event_type = 'EMPLOYEE_EXIT' 
                 AND COALESCE(de.payload_json->>'employee_id', de.payload_json->>'employeeId') = a.fk_employee_id::text
                 AND (de.occurred_at AT TIME ZONE COALESCE(s.timezone, 'UTC'))::date = a.attendance_date
              ),
              CASE WHEN a.check_out IS NOT NULL THEN json_build_array(json_build_object('time', a.check_out, 'photo_url', a.checkout_photo_url)) ELSE '[]'::json END
            ) AS all_check_outs
     FROM attendance_record a
     JOIN hr_employee e ON e.pk_employee_id = a.fk_employee_id
     LEFT JOIN hr_shift hs ON hs.pk_shift_id = e.fk_shift_id
  `;

  let params = [employeeId, tenantId];

  if (fromDate && toDate) {
    query = `
      WITH date_range AS (
        SELECT generate_series($3::date, $4::date, '1 day'::interval)::date AS d
      ),
      employee_info AS (
        SELECT e.pk_employee_id, e.full_name, e.employee_code, e.site_ids[1] AS site_id, e.tenant_id, s.timezone
        FROM hr_employee e
        LEFT JOIN frs_site s ON s.pk_site_id = e.site_ids[1]
        WHERE e.pk_employee_id = $1 AND e.tenant_id = $2
      ),
      base_attendance AS (
        ${query}
        WHERE a.fk_employee_id=$1 AND a.tenant_id=$2 AND a.attendance_date >= $3::date AND a.attendance_date <= $4::date
      )
      SELECT 
        dr.d AS attendance_date,
        COALESCE(ba.pk_attendance_id, 0) AS pk_attendance_id,
        $1 AS fk_employee_id,
        $2 AS tenant_id,
        COALESCE(ba.status, CASE WHEN extract(dow from dr.d) IN (0,6) THEN 'weekly-off' ELSE 'absent' END) AS status,
        ba.check_in,
        ba.check_out,
        ba.duration_minutes,
        ba.working_hours,
        ba.break_duration_minutes,
        ba.recognition_accuracy,
        CASE
          WHEN ba.hs_is_flexible = true OR ba.hs_start_time IS NULL THEN false
          WHEN ba.check_in IS NULL THEN false
          WHEN (ba.check_in AT TIME ZONE COALESCE(ei.timezone, 'Asia/Kolkata'))::time > 
               (ba.hs_start_time + (COALESCE(ba.hs_grace_period_minutes,0) || ' minutes')::interval)
          THEN true
          ELSE false
        END AS is_late,
        ba.checkin_photo_url,
        ba.checkout_photo_url,
        ei.full_name,
        ei.employee_code,
        COALESCE(ba.check_in_count, 0) AS check_in_count,
        COALESCE(ba.check_out_count, 0) AS check_out_count,
        COALESCE(ba.all_check_ins, '[]'::json) AS all_check_ins,
        COALESCE(ba.all_check_outs, '[]'::json) AS all_check_outs
      FROM date_range dr
      CROSS JOIN employee_info ei
      LEFT JOIN base_attendance ba ON ba.attendance_date = dr.d
      ORDER BY dr.d DESC
    `;
    params.push(fromDate, toDate);
  } else {
    query += ` WHERE a.fk_employee_id=$1 AND a.tenant_id=$2 ORDER BY a.attendance_date DESC LIMIT 60`;
  }

  const { rows } = await pool.query(query, params);
  return res.json({ data: rows });
}));



// ── Roster Routes ──────────────────────────────────────────────
// GET /hr/roster?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get('/roster', requirePermission('users.read'), asyncHandler(async (req, res) => {
  const { start, end } = req.query;
  const tenantId = getTenant(req);
  if (!start || !end) return res.status(400).json({ message: 'start and end dates required' });
  const { rows } = await pool.query(`
    SELECT r.*, 
           e.full_name, e.employee_code,
           s.name as shift_name, s.shift_type, s.start_time, s.end_time,
           d.name as department_name,
           sw.full_name as swapped_with_name
    FROM hr_roster r
    JOIN hr_employee e ON e.pk_employee_id = r.fk_employee_id
    JOIN hr_shift s ON s.pk_shift_id = r.fk_shift_id
    LEFT JOIN hr_department d ON d.pk_department_id = e.fk_department_id
    LEFT JOIN hr_employee sw ON sw.pk_employee_id = r.swapped_with
    WHERE r.tenant_id = $1 AND r.roster_date BETWEEN $2 AND $3
    ORDER BY r.roster_date, e.full_name
  `, [tenantId, start, end]);
  return res.json({ data: rows });
}));

// POST /hr/roster — create single or bulk roster entries
router.post('/roster', requirePermission('attendance.write'), validateBody(createRosterSchema), asyncHandler(async (req, res) => {
  const { entries } = req.validatedBody; // [{employee_id, shift_id, date, notes}]
  const tenantId = getTenant(req);
  const results = [];
  for (const entry of entries) {
    const { rows } = await pool.query(`
      INSERT INTO hr_roster (tenant_id, fk_employee_id, fk_shift_id, roster_date, notes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (tenant_id, fk_employee_id, roster_date) 
      DO UPDATE SET fk_shift_id = EXCLUDED.fk_shift_id, notes = EXCLUDED.notes
      RETURNING *
    `, [tenantId, entry.employee_id, entry.shift_id, entry.date, entry.notes || null, req.auth?.user?.id || null]);
    results.push(rows[0]);
  }
  await writeAudit({ req, action: 'roster.create',
    details: `Roster created: ${results.length} entries`,
    entityType: 'roster', source: 'ui'
  });
  return res.status(201).json({ data: results, count: results.length });
}));

// POST /hr/roster/recurring — set weekly recurring schedule
router.post('/roster/recurring', requirePermission('attendance.write'), validateBody(createRecurringRosterSchema), asyncHandler(async (req, res) => {
  const { employee_id, shift_id, day_of_week, weeks_ahead, notes } = req.validatedBody;
  const tenantId = getTenant(req);
  const entries = [];
  const today = new Date();
  for (let w = 0; w < weeks_ahead; w++) {
    const d = new Date(today);
    d.setDate(d.getDate() + (7 * w) + ((day_of_week - d.getDay() + 7) % 7));
    if (d < today) d.setDate(d.getDate() + 7);
    entries.push(d.toISOString().slice(0, 10));
  }
  const results = [];
  for (const date of entries) {
    const { rows } = await pool.query(`
      INSERT INTO hr_roster (tenant_id, fk_employee_id, fk_shift_id, roster_date, is_recurring, recur_day_of_week, notes, created_by)
      VALUES ($1, $2, $3, $4, true, $5, $6, $7)
      ON CONFLICT (tenant_id, fk_employee_id, roster_date)
      DO UPDATE SET fk_shift_id = EXCLUDED.fk_shift_id, is_recurring = true, recur_day_of_week = EXCLUDED.recur_day_of_week
      RETURNING *
    `, [tenantId, employee_id, shift_id, date, day_of_week, notes || null, req.auth?.user?.id || null]);
    results.push(rows[0]);
  }
  return res.status(201).json({ data: results, count: results.length });
}));

// PATCH /hr/roster/:id/swap — swap shift between employees
router.patch('/roster/:id/swap', requirePermission('attendance.write'), validateIdParam(), validateBody(swapRosterSchema), asyncHandler(async (req, res) => {
  const { swap_with_employee_id } = req.validatedBody;
  const tenantId = getTenant(req);
  const { rows: original } = await pool.query('SELECT * FROM hr_roster WHERE pk_roster_id=$1 AND tenant_id=$2', [req.params.id, tenantId]);
  if (!original.length) return res.status(404).json({ message: 'Roster entry not found' });
  const orig = original[0];
  // Create swap entry for the other employee
  await pool.query(`
    INSERT INTO hr_roster (tenant_id, fk_employee_id, fk_shift_id, roster_date, status, swapped_with, notes)
    VALUES ($1, $2, $3, $4, 'swapped', $5, 'Swapped shift')
    ON CONFLICT (tenant_id, fk_employee_id, roster_date) DO UPDATE SET fk_shift_id=EXCLUDED.fk_shift_id, status='swapped', swapped_with=EXCLUDED.swapped_with
  `, [tenantId, swap_with_employee_id, orig.fk_shift_id, orig.roster_date, orig.fk_employee_id]);
  // Update original
  const { rows } = await pool.query('UPDATE hr_roster SET status=$1, swapped_with=$2 WHERE pk_roster_id=$3 RETURNING *', ['swapped', swap_with_employee_id, req.params.id]);
  await writeAudit({ req, action: 'roster.swap',
    details: `Roster ${req.params.id} swapped with employee ${swap_with_employee_id} on ${orig.roster_date}`,
    entityType: 'roster', entityId: req.params.id, source: 'ui'
  }).catch(() => {});
  return res.json(rows[0]);
}));

// DELETE /hr/roster/:id
router.delete('/roster/:id', requirePermission('attendance.write'), validateIdParam(), asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM hr_roster WHERE pk_roster_id=$1 AND tenant_id=$2', [req.params.id, getTenant(req)]);
  await writeAudit({ req, action: 'roster.delete',
    details: `Roster entry ${req.params.id} deleted`,
    entityType: 'roster', entityId: req.params.id, source: 'ui'
  });
  return res.json({ success: true });
}));
export { router as hrRoutes };
