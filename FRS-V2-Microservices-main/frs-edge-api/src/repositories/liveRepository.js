import { query } from '../db/pool.js';
import { buildScopeWhere } from './scopeSql.js';
import logger from '../utils/logger.js';

// --- 1. CORE ANALYTICS (With Joining Date Fix) ---

// Cache site timezones in memory with 5-minute TTL to prevent hitting DB on every query
const tzCache = new Map();
const TZ_CACHE_TTL_MS = 5 * 60 * 1000;

export async function getSiteTimezone(siteId, tenantId) {
  const now = Date.now();
  const key = siteId || tenantId || 'default';
  const cached = tzCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.timezone;
  }
  try {
    let queryText = '';
    let params = [];
    if (siteId) {
      queryText = `SELECT timezone FROM frs_site WHERE pk_site_id::text = $1 LIMIT 1`;
      params = [String(siteId)];
    } else if (tenantId) {
      // frs_site has no direct tenant_id column — it goes through frs_customer
      // (see siteRoutes.js's own comment on this same pattern).
      queryText = `SELECT s.timezone FROM frs_site s
                   JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
                   WHERE c.fk_tenant_id = $1::uuid AND s.timezone IS NOT NULL LIMIT 1`;
      params = [String(tenantId)];
    } else {
      queryText = `SELECT timezone FROM frs_site WHERE timezone IS NOT NULL LIMIT 1`;
      params = [];
    }

    const { rows } = await query(queryText, params);
    const timezone = rows[0]?.timezone || process.env.DEFAULT_TIMEZONE || 'Asia/Kolkata';
    tzCache.set(key, { timezone, expiresAt: now + TZ_CACHE_TTL_MS });
    return timezone;
  } catch (err) {
    logger.warn({ err: err.message, siteId, tenantId }, '[getSiteTimezone] Fallback to default timezone');
    return process.env.DEFAULT_TIMEZONE || 'Asia/Kolkata';
  }
}

export async function getDashboardMetrics(scope) {
  const tz = await getSiteTimezone(scope?.siteId, scope?.tenantId);
  const { whereSql: wEmp, values: vEmp } = buildScopeWhere(scope, "e", true);

  const tenantId = scope?.tenantId;
  const todayExpr = `(NOW() AT TIME ZONE $${vEmp.length + 1})::date`;
  const [totalRes, presentRes, lateRes, earlyDepRes, avgWorkRes, avgOverRes, onTimeRes, absentRes] = await Promise.all([
    query(`SELECT COUNT(*)::int as cnt FROM hr_employee e WHERE ${wEmp} AND LOWER(COALESCE(e.status, 'active')) = 'active'`, [...vEmp]),
    query(`SELECT COUNT(DISTINCT a.fk_employee_id)::int as cnt FROM hr_employee e JOIN attendance_record a ON a.fk_employee_id = e.pk_employee_id WHERE ${wEmp} AND LOWER(COALESCE(e.status, 'active')) = 'active' AND a.attendance_date = ${todayExpr} AND COALESCE(a.status, 'present') != 'absent'`, [...vEmp, tz]),
    query(`SELECT COUNT(DISTINCT a.fk_employee_id)::int as cnt FROM hr_employee e JOIN attendance_record a ON a.fk_employee_id = e.pk_employee_id LEFT JOIN hr_shift s ON s.pk_shift_id = e.fk_shift_id WHERE ${wEmp} AND LOWER(COALESCE(e.status, 'active')) = 'active' AND a.attendance_date = ${todayExpr} AND (a.is_late = true OR a.status = 'late' OR (s.is_flexible = false AND s.start_time IS NOT NULL AND (a.check_in AT TIME ZONE $${vEmp.length + 1})::time > (s.start_time + (COALESCE(s.grace_period_minutes,0) || ' minutes')::interval))) AND COALESCE(a.status, 'present') != 'absent'`, [...vEmp, tz]),
    query(`SELECT COUNT(DISTINCT a.fk_employee_id)::int as cnt FROM hr_employee e JOIN attendance_record a ON a.fk_employee_id = e.pk_employee_id WHERE ${wEmp} AND LOWER(COALESCE(e.status, 'active')) = 'active' AND a.attendance_date = ${todayExpr} AND a.is_early_departure = true`, [...vEmp, tz]),
    query(`SELECT AVG(a.duration_minutes - COALESCE(a.break_duration_minutes, 0))::numeric / 60 as cnt FROM hr_employee e JOIN attendance_record a ON a.fk_employee_id = e.pk_employee_id WHERE ${wEmp} AND LOWER(COALESCE(e.status, 'active')) = 'active' AND a.attendance_date = ${todayExpr} AND (a.duration_minutes - COALESCE(a.break_duration_minutes, 0)) > 0`, [...vEmp, tz]),
    query(`SELECT ROUND(AVG(a.overtime_hours)::numeric, 1) as cnt FROM hr_employee e JOIN attendance_record a ON a.fk_employee_id = e.pk_employee_id WHERE ${wEmp} AND LOWER(COALESCE(e.status, 'active')) = 'active' AND a.attendance_date = ${todayExpr}`, [...vEmp, tz]),
    query(`SELECT COUNT(DISTINCT a.fk_employee_id)::int as cnt FROM hr_employee e JOIN attendance_record a ON a.fk_employee_id = e.pk_employee_id JOIN hr_shift s ON s.pk_shift_id = e.fk_shift_id WHERE ${wEmp} AND LOWER(COALESCE(e.status, 'active')) = 'active' AND a.attendance_date = ${todayExpr} AND s.is_flexible = false AND (a.check_in AT TIME ZONE $${vEmp.length + 1})::time <= (s.start_time + (COALESCE(s.grace_period_minutes,0) || ' minutes')::interval) AND COALESCE(a.status, 'present') != 'absent'`, [...vEmp, tz]),
    // Direct count of employees who have NOT checked in today — matches calendar's absent definition
    query(`SELECT COUNT(*)::int as cnt FROM hr_employee e WHERE ${wEmp} AND LOWER(COALESCE(e.status, 'active')) = 'active' AND NOT EXISTS (SELECT 1 FROM attendance_record a WHERE a.fk_employee_id = e.pk_employee_id AND a.attendance_date = ${todayExpr} AND COALESCE(a.status, 'present') != 'absent')`, [...vEmp, tz])
  ]);

  const total   = totalRes.rows[0]?.cnt   || 0;
  const present = presentRes.rows[0]?.cnt || 0;
  const late    = lateRes.rows[0]?.cnt    || 0;
  const earlyDepartures = earlyDepRes.rows[0]?.cnt || 0;
  const onTime  = onTimeRes.rows[0]?.cnt || 0;
  const absent  = absentRes.rows[0]?.cnt  ?? Math.max(0, total - present);
  const avgWorkingHours = parseFloat(avgWorkRes.rows[0]?.cnt || 0);
  const totalOvertimeHours = parseFloat(avgOverRes.rows[0]?.cnt || 0);
  return {
    totalEmployees:    total,
    presentToday:      present,
    lateToday:         late,
    earlyDeparturesToday: earlyDepartures,
    absentToday:       absent,
    attendanceRate:    total > 0 ? Math.min(100, Math.round((present / total) * 100)) : 0,
    avgWorkingHours:   avgWorkingHours,
    totalOvertimeHours: totalOvertimeHours,
    punctualityRate:   present > 0 ? Math.min(100, Math.round((onTime / present) * 100)) : 0,
  };
}

export async function getAttendanceTrends(scope) {
  const { whereSql: wEmp, values } = buildScopeWhere(scope, "e", true);

  const { rows } = await query(`
    WITH dates AS (
      SELECT generate_series(CURRENT_DATE - INTERVAL '29 days', CURRENT_DATE, '1 day')::date as date
    )
    SELECT
      d.date::text as full_date,
      (SELECT COUNT(DISTINCT a.fk_employee_id)::int FROM hr_employee e JOIN attendance_record a ON a.fk_employee_id = e.pk_employee_id WHERE ${wEmp} AND e.status = 'active' AND (e.join_date IS NULL OR e.join_date <= d.date) AND a.attendance_date = d.date AND COALESCE(a.status, 'present') != 'absent') as present,
      (SELECT COUNT(*)::int FROM hr_employee e WHERE ${wEmp} AND e.status = 'active' AND (e.join_date IS NULL OR e.join_date <= d.date)) as total
    FROM dates d
    ORDER BY d.date ASC
  `, values);
  return rows.map(r => ({
    date: r.full_date,
    present: r.present,
    absent: r.total > 0 ? Math.max(0, r.total - r.present) : 0,
    rate: r.total > 0 ? Math.min(100, Math.round((r.present / r.total) * 100)) : 0
  }));
}

// --- 2. DATA LISTINGS (The current culprits) ---

export async function listEmployees(scope) {
  const { whereSql, values } = buildScopeWhere(scope, "e", true);
  const { rows } = await query(`
    SELECT e.*, 
           d.name as department_name,
           s.name as shift_name,
           s.shift_type,
           s.start_time,
           s.end_time,
           s.grace_period_minutes,
           EXISTS(SELECT 1 FROM employee_face_embeddings ef WHERE ef.employee_id = e.pk_employee_id) as face_enrolled
    FROM hr_employee e
    LEFT JOIN hr_department d ON e.fk_department_id = d.pk_department_id
    LEFT JOIN hr_shift s ON s.pk_shift_id = e.fk_shift_id
    WHERE ${whereSql}
    ORDER BY e.full_name ASC
  `, values);
  return rows;
}

export async function listDevices(scope) {
  const siteId   = scope?.siteId   ? Number(scope.siteId)   : null;
  const tenantId = scope?.tenantId || null;

  const params = [];
  let queryText = `
    SELECT
      fd.pk_device_id::text  AS pk_device_id,
      fd.external_device_id  AS external_device_id,
      fd.name,
      dt.model               AS model,
      fd.ip_address,
      fd.recognition_accuracy,
      fd.total_scans,
      fd.error_rate,
      fd.last_active,
      fd.location_label,
      CASE 
        WHEN dt.category = 'edge_node' OR dt.type_code LIKE 'jetson%' OR dt.type_code LIKE 'node%' OR dt.type_code LIKE 'nug%' THEN 'AI'
        WHEN dt.category = 'camera' OR dt.type_code LIKE 'cam%' OR fd.parent_device_id IS NOT NULL THEN 'Camera'
        ELSE 'AI'
      END                    AS device_type,
      fd.status
    FROM facility_device fd
    LEFT JOIN device_type dt ON dt.pk_device_type_id = fd.device_type_id
    LEFT JOIN site_device_assignment sda ON sda.device_id = fd.pk_device_id AND sda.is_active = TRUE
    WHERE fd.decommissioned_at IS NULL
  `;

  if (siteId) {
    params.push(siteId);
    queryText += ` AND sda.site_id = $${params.length}`;
  } else if (tenantId) {
    params.push(tenantId);
    queryText += ` AND fd.tenant_id = $${params.length}::uuid`;
  }

  const { rows } = await query(queryText, params);
  return rows;
}

export async function listAttendance(scope, opts = {}) {
  const { fromDate, toDate, limit } = opts;
  const tz = await getSiteTimezone(scope?.siteId, scope?.tenantId);
  const limitClause = limit ? `LIMIT ${Math.min(Number(limit), 50000)}` : 'LIMIT 500';

  // ── "Today" path: LEFT JOIN from hr_employee so every active employee
  //    appears in the result, even if they have no attendance record.
  //    Status is derived as: present | late | weekend | absent.
  if (!fromDate || fromDate === toDate) {
    const { whereSql: wEmp, values: vEmp } = buildScopeWhere(scope, 'e', true);
    console.log("[Attendance Scope]", scope);
    console.log("[Attendance WHERE]", wEmp);
    console.log("[Attendance VALUES]", vEmp);
    const empParams = [...vEmp, tz];
    const tzEmpIdx = empParams.length;
    let dateExpr = `(NOW() AT TIME ZONE $${tzEmpIdx})::date`;
    if (fromDate) {
      empParams.push(fromDate);
      dateExpr = `$${empParams.length}::date`;
    }

    const { rows } = await query(`
      SELECT
        -- attendance fields (NULL when no record exists today)
        a.pk_attendance_id,
        a.check_in,
        a.check_out,
        a.break_start,
        a.break_end,
        a.working_hours,
        a.duration_minutes,
        a.break_duration_minutes,
        a.overtime_hours,
        a.is_early_departure,
        a.location_label,
        a.recognition_accuracy,
        a.device_id,
        a.checkin_photo_url,
        a.checkout_photo_url,
        a.created_at,
        COALESCE(a.attendance_date, ${dateExpr})::text AS attendance_date,
        -- employee fields
        e.pk_employee_id   AS fk_employee_id,
        e.tenant_id,
        e.full_name,
        e.employee_code,
        e.position_title,
        d.name             AS department_name,
        fd.location_label  AS floor,
        COALESCE(
          (SELECT NULLIF(COUNT(*)::int, 0)
           FROM device_events de 
           LEFT JOIN frs_site s ON s.pk_site_id = COALESCE(a.site_id, e.site_ids[1])
           WHERE de.tenant_id = e.tenant_id 
             AND de.event_type = 'EMPLOYEE_ENTRY' 
             AND COALESCE(de.payload_json->>'employee_id', de.payload_json->>'employeeId') = e.pk_employee_id::text
             AND (de.occurred_at AT TIME ZONE COALESCE(s.timezone, 'UTC'))::date = COALESCE(a.attendance_date, ${dateExpr})
          ),
          CASE WHEN a.check_in IS NOT NULL THEN 1 ELSE 0 END
        ) AS check_in_count,
        COALESCE(
          (SELECT NULLIF(COUNT(*)::int, 0)
           FROM device_events de 
           LEFT JOIN frs_site s ON s.pk_site_id = COALESCE(a.site_id, e.site_ids[1])
           WHERE de.tenant_id = e.tenant_id 
             AND de.event_type = 'EMPLOYEE_EXIT' 
             AND COALESCE(de.payload_json->>'employee_id', de.payload_json->>'employeeId') = e.pk_employee_id::text
             AND (de.occurred_at AT TIME ZONE COALESCE(s.timezone, 'UTC'))::date = COALESCE(a.attendance_date, ${dateExpr})
          ),
          CASE WHEN a.check_out IS NOT NULL THEN 1 ELSE 0 END
        ) AS check_out_count,
        COALESCE(
          (SELECT json_agg(json_build_object('time', de.occurred_at, 'photo_url', CASE WHEN de.payload_json->>'event_time_raw' IS NOT NULL THEN NULL ELSE de.payload_json->>'photo_url' END) ORDER BY de.occurred_at ASC)
           FROM device_events de 
           LEFT JOIN frs_site s ON s.pk_site_id = COALESCE(a.site_id, e.site_ids[1])
           WHERE de.tenant_id = e.tenant_id 
             AND de.event_type = 'EMPLOYEE_ENTRY' 
             AND COALESCE(de.payload_json->>'employee_id', de.payload_json->>'employeeId') = e.pk_employee_id::text
             AND (de.occurred_at AT TIME ZONE COALESCE(s.timezone, 'UTC'))::date = COALESCE(a.attendance_date, ${dateExpr})
          ),
          CASE WHEN a.check_in IS NOT NULL THEN json_build_array(json_build_object('time', a.check_in, 'photo_url', a.checkin_photo_url)) ELSE '[]'::json END
        ) AS all_check_ins,
        COALESCE(
          (SELECT json_agg(json_build_object('time', de.occurred_at, 'photo_url', CASE WHEN de.payload_json->>'event_time_raw' IS NOT NULL THEN NULL ELSE de.payload_json->>'photo_url' END) ORDER BY de.occurred_at ASC)
           FROM device_events de 
           LEFT JOIN frs_site s ON s.pk_site_id = COALESCE(a.site_id, e.site_ids[1])
           WHERE de.tenant_id = e.tenant_id 
             AND de.event_type = 'EMPLOYEE_EXIT' 
             AND COALESCE(de.payload_json->>'employee_id', de.payload_json->>'employeeId') = e.pk_employee_id::text
             AND (de.occurred_at AT TIME ZONE COALESCE(s.timezone, 'UTC'))::date = COALESCE(a.attendance_date, ${dateExpr})
          ),
          CASE WHEN a.check_out IS NOT NULL THEN json_build_array(json_build_object('time', a.check_out, 'photo_url', a.checkout_photo_url)) ELSE '[]'::json END
        ) AS all_check_outs,
        -- is_late
        CASE
          WHEN s.is_flexible = true OR s.start_time IS NULL THEN false
          WHEN a.check_in IS NULL THEN false
          WHEN (a.check_in AT TIME ZONE $${tzEmpIdx})::time
               > (s.start_time + (COALESCE(s.grace_period_minutes,0) || ' minutes')::interval)
          THEN true
          ELSE false
        END AS is_late_computed,
        -- Derived status:
        --   • existing record  → keep its stored status
        --   • no record + weekend shift-day not configured → 'weekend'
        --   • no record + weekday (or shift includes today) → 'absent'
        CASE
          WHEN a.pk_attendance_id IS NOT NULL
            THEN COALESCE(a.status, 'present')
          WHEN EXTRACT(DOW FROM ${dateExpr})
               IN (0, 6)
               AND (
                 s.pk_shift_id IS NULL
                 OR NOT (
                   COALESCE(s.work_days, ARRAY['Mon','Tue','Wed','Thu','Fri']::text[])
                   && ARRAY[
                       CASE EXTRACT(DOW FROM ${dateExpr})::int
                         WHEN 0 THEN 'Sun'
                         WHEN 6 THEN 'Sat'
                       END
                     ]::text[]
                 )
               )
            THEN 'weekend'
          ELSE 'absent'
        END AS status
      FROM hr_employee e
      LEFT JOIN attendance_record a
             ON a.fk_employee_id = e.pk_employee_id
            AND a.attendance_date = ${dateExpr}
            AND a.tenant_id = e.tenant_id
      LEFT JOIN hr_shift      s  ON s.pk_shift_id = e.fk_shift_id
      LEFT JOIN hr_department d  ON d.pk_department_id = e.fk_department_id
      LEFT JOIN facility_device fd ON a.device_id = fd.external_device_id
      WHERE ${wEmp}
        AND e.status = 'active'
        AND (a.pk_attendance_id IS NOT NULL OR e.join_date IS NULL OR e.join_date <= ${dateExpr})
      ORDER BY
        CASE WHEN a.pk_attendance_id IS NOT NULL THEN 0 ELSE 1 END,
        a.check_in ASC NULLS LAST,
        e.full_name ASC
      ${limitClause}
    `, empParams);

    return rows.map(r => ({
      ...r,
      is_late: r.is_late ?? r.is_late_computed ?? false,
    }));
  }

  // ── Date-range path: original behaviour (attendance_record rows only) ──
  const { whereSql, values } = buildScopeWhere(scope, 'a');
  const params = [...values, tz];
  const tzIdx = values.length + 1;
  params.push(fromDate);
  params.push(toDate || fromDate);
  const fIdx = tzIdx + 1;
  const tIdx = tzIdx + 2;
  const dateClause = `AND a.attendance_date >= $${fIdx}::date AND a.attendance_date <= $${tIdx}::date`;

  const { rows } = await query(`
    SELECT
      a.*,
      a.attendance_date::text as attendance_date,
      e.full_name,
      e.position_title,
      d.name as department_name,
      fd.location_label as floor,
      COALESCE(
        (SELECT NULLIF(COUNT(*)::int, 0)
         FROM device_events de 
         LEFT JOIN frs_site s ON s.pk_site_id = COALESCE(a.site_id, e.site_ids[1])
         WHERE de.tenant_id = a.tenant_id 
           AND de.event_type = 'EMPLOYEE_ENTRY' 
           AND COALESCE(de.payload_json->>'employee_id', de.payload_json->>'employeeId') = a.fk_employee_id::text
           AND (de.occurred_at AT TIME ZONE COALESCE(s.timezone, $${tzIdx}))::date = a.attendance_date
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
           AND (de.occurred_at AT TIME ZONE COALESCE(s.timezone, $${tzIdx}))::date = a.attendance_date
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
           AND (de.occurred_at AT TIME ZONE COALESCE(s.timezone, $${tzIdx}))::date = a.attendance_date
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
           AND (de.occurred_at AT TIME ZONE COALESCE(s.timezone, $${tzIdx}))::date = a.attendance_date
        ),
        CASE WHEN a.check_out IS NOT NULL THEN json_build_array(json_build_object('time', a.check_out, 'photo_url', a.checkout_photo_url)) ELSE '[]'::json END
      ) AS all_check_outs,
      CASE
        WHEN s.is_flexible = true OR s.start_time IS NULL THEN false
        WHEN a.check_in IS NULL THEN false
        WHEN (a.check_in AT TIME ZONE $${tzIdx})::time
             > (s.start_time + (COALESCE(s.grace_period_minutes,0) || ' minutes')::interval)
          THEN true
        ELSE false
      END as is_late_computed
    FROM attendance_record a
    JOIN hr_employee e ON a.fk_employee_id = e.pk_employee_id
    LEFT JOIN hr_shift s ON s.pk_shift_id = e.fk_shift_id
    LEFT JOIN hr_department d ON e.fk_department_id = d.pk_department_id
    LEFT JOIN facility_device fd ON a.device_id = fd.external_device_id
    WHERE ${whereSql}
    ${dateClause}
    ORDER BY a.check_in ASC
    ${limitClause}
  `, params);
  return rows.map(r => ({
    ...r,
    is_late: r.is_late ?? r.is_late_computed ?? false,
  }));
}

export async function listAlerts(scope, { unreadOnly = false, limit = 50 } = {}) {
  const { whereSql, values } = buildScopeWhere(scope, "");
  
  let queryStr = `SELECT * FROM system_alert WHERE ${whereSql}`;
  
  // Filter for today's notifications only, preventing stale notifications from cluttering
  queryStr += ` AND created_at >= CURRENT_DATE`;

  if (unreadOnly) {
    queryStr += ` AND is_read = false`;
  }

  queryStr += ` ORDER BY created_at DESC LIMIT $${values.length + 1}`;
  values.push(limit);

  const { rows } = await query(queryStr, values);
  return rows;
}

// --- 3. LIVE FEED & ADDITIONAL ANALYTICS ---

export async function getLiveFeed(scope) {
  return await listAttendance(scope);
}

export async function getDepartmentAnalytics(tenantId) {
  const { rows } = await query(`
    SELECT d.name, COUNT(e.pk_employee_id)::int as total, COUNT(a.pk_attendance_id)::int as present
    FROM hr_employee e
    JOIN hr_department d ON e.fk_department_id = d.pk_department_id
    LEFT JOIN attendance_record a ON a.fk_employee_id = e.pk_employee_id AND a.attendance_date = CURRENT_DATE
    WHERE e.tenant_id = $1::uuid GROUP BY d.name
  `, [tenantId]);
  return rows;
}

export async function getWeeklyAnalytics(tenantId, siteId) {
  const tz = await getSiteTimezone(siteId);
  const { rows } = await query(`
    WITH dates AS (
      SELECT generate_series(
        (NOW() AT TIME ZONE $2)::date - INTERVAL '6 days',
        (NOW() AT TIME ZONE $2)::date,
        '1 day'
      )::date as date
    ),
    total_employees AS (
      SELECT COUNT(*)::int as cnt FROM hr_employee 
      WHERE tenant_id = $1::uuid AND status = 'active'
    )
    SELECT 
      TO_CHAR(d.date, 'Dy') as name,
      d.date,
      (
        COUNT(DISTINCT CASE WHEN a.pk_attendance_id IS NOT NULL AND COALESCE(a.status, 'present') != 'absent' THEN a.fk_employee_id END)::int
        - 
        COUNT(DISTINCT CASE 
          WHEN a.pk_attendance_id IS NOT NULL 
            AND s.is_flexible = false
            AND (a.check_in AT TIME ZONE $2)::time > (s.start_time + (COALESCE(s.grace_period_minutes,0) || ' minutes')::interval)
          THEN a.fk_employee_id END
        )::int
      ) as present,
      COUNT(DISTINCT CASE 
        WHEN a.pk_attendance_id IS NOT NULL 
          AND s.is_flexible = false
          AND (a.check_in AT TIME ZONE $2)::time > (s.start_time + (COALESCE(s.grace_period_minutes,0) || ' minutes')::interval)
        THEN a.fk_employee_id END
      )::int as late,
      GREATEST(0, (SELECT cnt FROM total_employees) - COUNT(DISTINCT CASE WHEN a.pk_attendance_id IS NOT NULL AND COALESCE(a.status, 'present') != 'absent' THEN a.fk_employee_id END)::int) as absent
    FROM dates d
    LEFT JOIN attendance_record a ON a.attendance_date = d.date AND a.tenant_id = $1::uuid
    LEFT JOIN hr_employee e ON e.pk_employee_id = a.fk_employee_id
    LEFT JOIN hr_shift s ON s.pk_shift_id = e.fk_shift_id
    GROUP BY d.date ORDER BY d.date ASC
  `, [tenantId, tz]);
  return rows;
}

// --- 4. ALIASES (Failsafes for different route versions) ---
export const getLiveStats = getDashboardMetrics;
export const getMonthlyAttendanceTrend = getAttendanceTrends;
export const listEvents = listAlerts;

export async function getHourlyActivity(scope) {
  const tz = await getSiteTimezone(scope?.siteId || '1');
  const { whereSql, values } = buildScopeWhere(scope, "a");
  const tzIdx = values.length + 1;
  const { rows } = await query(`
    WITH hours AS (
      SELECT generate_series(
        date_trunc('hour', NOW() AT TIME ZONE $${tzIdx}) - INTERVAL '23 hours',
        date_trunc('hour', NOW() AT TIME ZONE $${tzIdx}),
        '1 hour'::interval
      ) AS hr
    )
    SELECT
      to_char(h.hr AT TIME ZONE $${tzIdx}, 'HH24:00') as label,
      COUNT(a.pk_attendance_id)::int as value
    FROM hours h
    LEFT JOIN attendance_record a
      ON date_trunc('hour', a.check_in AT TIME ZONE $${tzIdx}) = h.hr
      AND ${whereSql}
    GROUP BY h.hr
    ORDER BY h.hr ASC
  `, [...values, tz]);
  return rows;
}

// In-memory cache for holidays (TTL: 24 hours)
const holidayCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// Google Calendar ID for Indian public holidays
const GOOGLE_CALENDAR_ID = 'en.indian#holiday@group.v.calendar.google.com';

// Comprehensive Indian festivals and holidays fallback (covers 2025-2027)
// These are used when Google Calendar API fails or returns limited results
const INDIAN_FESTIVALS_FALLBACK = {
  // 2025
  '2025-01-01': 'New Year\'s Day',
  '2025-01-14': 'Makar Sankranti',
  '2025-01-26': 'Republic Day',
  '2025-02-14': 'Vasant Panchami',
  '2025-02-26': 'Maha Shivaratri',
  '2025-03-14': 'Holi',
  '2025-03-15': 'Holi Holiday',
  '2025-03-31': 'Eid al-Fitr',
  '2025-04-06': 'Ram Navami',
  '2025-04-10': 'Mahavir Jayanti',
  '2025-04-14': 'Ambedkar Jayanti',
  '2025-04-18': 'Good Friday',
  '2025-05-01': 'Labour Day',
  '2025-05-12': 'Buddha Purnima',
  '2025-06-07': 'Eid al-Adha (Bakrid)',
  '2025-07-06': 'Muharram',
  '2025-08-09': 'Raksha Bandhan',
  '2025-08-15': 'Independence Day',
  '2025-08-16': 'Janmashtami',
  '2025-08-28': 'Ganesh Chaturthi',
  '2025-09-05': 'Milad un-Nabi',
  '2025-10-02': 'Gandhi Jayanti',
  '2025-10-02': 'Dussehra',
  '2025-10-21': 'Diwali',
  '2025-10-22': 'Diwali Holiday',
  '2025-11-05': 'Guru Nanak Jayanti',
  '2025-12-25': 'Christmas',

  // 2026
  '2026-01-01': 'New Year\'s Day',
  '2026-01-14': 'Makar Sankranti',
  '2026-01-26': 'Republic Day',
  '2026-02-03': 'Vasant Panchami',
  '2026-02-15': 'Maha Shivaratri',
  '2026-03-03': 'Holi',
  '2026-03-04': 'Holi Holiday',
  '2026-03-20': 'Eid al-Fitr',
  '2026-03-26': 'Ram Navami',
  '2026-03-30': 'Mahavir Jayanti',
  '2026-04-14': 'Ambedkar Jayanti',
  '2026-04-03': 'Good Friday',
  '2026-05-01': 'Labour Day',
  '2026-05-01': 'Buddha Purnima',
  '2026-05-27': 'Eid al-Adha (Bakrid)',
  '2026-06-25': 'Muharram',
  '2026-08-15': 'Independence Day',
  '2026-08-26': 'Janmashtami',
  '2026-08-28': 'Raksha Bandhan',
  '2026-09-06': 'Ganesh Chaturthi',
  '2026-09-26': 'Milad un-Nabi',
  '2026-10-02': 'Gandhi Jayanti',
  '2026-10-20': 'Dussehra',
  '2026-11-08': 'Diwali',
  '2026-11-09': 'Diwali Holiday',
  '2026-11-25': 'Guru Nanak Jayanti',
  '2026-12-25': 'Christmas',

  // 2027
  '2027-01-01': 'New Year\'s Day',
  '2027-01-14': 'Makar Sankranti',
  '2027-01-26': 'Republic Day',
  '2027-01-23': 'Vasant Panchami',
  '2027-03-05': 'Maha Shivaratri',
  '2027-03-22': 'Holi',
  '2027-03-23': 'Holi Holiday',
  '2027-03-10': 'Eid al-Fitr',
  '2027-03-15': 'Ram Navami',
  '2027-04-09': 'Mahavir Jayanti',
  '2027-04-14': 'Ambedkar Jayanti',
  '2027-03-26': 'Good Friday',
  '2027-05-01': 'Labour Day',
  '2027-05-20': 'Buddha Purnima',
  '2027-05-17': 'Eid al-Adha (Bakrid)',
  '2027-06-15': 'Muharram',
  '2027-07-24': 'Raksha Bandhan',
  '2027-08-15': 'Independence Day',
  '2027-08-14': 'Janmashtami',
  '2027-08-25': 'Ganesh Chaturthi',
  '2027-09-16': 'Milad un-Nabi',
  '2027-10-02': 'Gandhi Jayanti',
  '2027-10-09': 'Dussehra',
  '2027-10-28': 'Diwali',
  '2027-10-29': 'Diwali Holiday',
  '2027-11-14': 'Guru Nanak Jayanti',
  '2027-12-25': 'Christmas',
};

export async function getCalendarEvents(year, month) {
  const cacheKey = `events_${year}_${month}`;
  const cached = holidayCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) { // 5 min cache
    return cached.data;
  }

  try {
    const apiKey = process.env.GOOGLE_CALENDAR_API_KEY;
    const companyCalendarId = process.env.COMPANY_CALENDAR_ID;
    const holidayCalendarId = process.env.HOLIDAY_CALENDAR_ID || GOOGLE_CALENDAR_ID;

    const startStr = month < 10 ? `0${month}` : `${month}`;
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextMonthStr = nextMonth < 10 ? `0${nextMonth}` : `${nextMonth}`;

    const startDate = `${year}-${startStr}-01T00:00:00Z`;
    const endDate = `${nextYear}-${nextMonthStr}-01T00:00:00Z`;

    let holidays = {};
    let events = {}; // { 'YYYY-MM-DD': [ { summary, time } ] }

    // Helper to fetch calendar
    const fetchCalendar = async (calId, isHoliday) => {
      let url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?` +
                `timeMin=${startDate}&timeMax=${endDate}&singleEvents=true&orderBy=startTime&maxResults=100`;
      
      if (apiKey) url += `&key=${apiKey}`;
      
      const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (response.ok) {
        const data = await response.json();
        if (data.items && Array.isArray(data.items)) {
          data.items.forEach((event) => {
            const date = event.start?.date || event.start?.dateTime?.split('T')[0];
            if (date) {
              if (isHoliday) {
                if (!holidays[date]) holidays[date] = event.summary;
              } else {
                if (!events[date]) events[date] = [];
                let time = null;
                if (event.start?.dateTime) {
                  const d = new Date(event.start.dateTime);
                  time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                }
                events[date].push({ summary: event.summary, time });
              }
            }
          });
        }
      }
    };

    // 1. Fetch holidays
    await fetchCalendar(holidayCalendarId, true);
    
    // 2. Fetch company events (if configured)
    if (companyCalendarId) {
      await fetchCalendar(companyCalendarId, false);
    }

    // Merge with fallback list for holidays
    for (const [date, name] of Object.entries(INDIAN_FESTIVALS_FALLBACK)) {
      if (date.startsWith(`${year}-${startStr}`) && !holidays[date]) {
        holidays[date] = name;
      }
    }

    const result = { holidays, events };
    holidayCache.set(cacheKey, { data: result, timestamp: Date.now() });

    return result;
  } catch (error) {
    logger.error({ err: error }, '[liveRepository] Error fetching calendar events');
    // Return fallback holidays for this month
    const startStr = month < 10 ? `0${month}` : `${month}`;
    const monthFallback = {};
    for (const [date, name] of Object.entries(INDIAN_FESTIVALS_FALLBACK)) {
      if (date.startsWith(`${year}-${startStr}`)) {
        monthFallback[date] = name;
      }
    }
    return { holidays: monthFallback, events: {} };
  }
}






export async function listDepartments(tenantId) {
  const { rows } = await query(`
    SELECT pk_department_id, tenant_id, name, code, color,
           description, head_employee_id
    FROM hr_department
    WHERE tenant_id = $1
    ORDER BY name ASC
  `, [tenantId]);
  return rows;
}

export async function listShifts(tenantId) {
  const { rows } = await query(`
    SELECT pk_shift_id, tenant_id, name, shift_type,
           start_time, end_time, grace_period_minutes,
           is_flexible, break_duration_minutes,
           COALESCE(work_days, '{Mon,Tue,Wed,Thu,Fri}'::text[]) AS work_days
    FROM hr_shift
    WHERE tenant_id = $1
    ORDER BY start_time ASC
  `, [tenantId]);
  return rows;
}

export async function getMonthlyCalendar(tenantId, siteId, year, month) {
  const tz = await getSiteTimezone(siteId, tenantId);
  const { rows } = await query(`
    WITH dates AS (
      SELECT generate_series(
        DATE_TRUNC('month', make_date($2::int, $3::int, 1)),
        DATE_TRUNC('month', make_date($2::int, $3::int, 1)) + INTERVAL '1 month' - INTERVAL '1 day',
        '1 day'
      )::date as date
    ),
    total_emp AS (
      SELECT COUNT(*)::int as cnt 
      FROM hr_employee 
      WHERE tenant_id = $1::uuid AND status = 'active'
    )
    SELECT 
      d.date,
      TO_CHAR(d.date, 'YYYY-MM-DD') as date_str,
      COUNT(CASE WHEN a.pk_attendance_id IS NOT NULL AND COALESCE(a.status, 'present') != 'absent' THEN 1 END)::int as present,
      COUNT(CASE 
        WHEN a.pk_attendance_id IS NOT NULL 
          AND s.is_flexible = false
          AND (a.check_in AT TIME ZONE $4)::time > (s.start_time + (COALESCE(s.grace_period_minutes,0) || ' minutes')::interval)
        THEN 1 END
      )::int as late,
      COUNT(CASE WHEN a.pk_attendance_id IS NOT NULL AND a.is_early_departure = true THEN 1 END)::int as early,
      GREATEST(0, (SELECT cnt FROM total_emp) - COUNT(CASE WHEN a.pk_attendance_id IS NOT NULL AND COALESCE(a.status, 'present') != 'absent' THEN 1 END)::int) as absent,
      (SELECT cnt FROM total_emp) as total,
      CASE WHEN COUNT(CASE WHEN a.pk_attendance_id IS NOT NULL AND COALESCE(a.status, 'present') != 'absent' THEN 1 END) > 0 
        THEN LEAST(100, ROUND((COUNT(CASE WHEN a.pk_attendance_id IS NOT NULL AND COALESCE(a.status, 'present') != 'absent' THEN 1 END)::numeric / (SELECT cnt FROM total_emp)) * 100))
        ELSE 0 
      END as rate
    FROM dates d
    LEFT JOIN attendance_record a ON a.attendance_date = d.date AND a.tenant_id = $1::uuid
    LEFT JOIN hr_employee e ON e.pk_employee_id = a.fk_employee_id
    LEFT JOIN hr_shift s ON s.pk_shift_id = e.fk_shift_id
    GROUP BY d.date
    ORDER BY d.date ASC
  `, [tenantId, year, month, tz]);
  return rows;
}

export async function getDeptShiftAnalytics(scopeOrTenantId, siteId) {
  const scope = typeof scopeOrTenantId === 'object' && scopeOrTenantId !== null
    ? scopeOrTenantId
    : { tenantId: scopeOrTenantId, siteId };

  const tz = await getSiteTimezone(scope.siteId);
  const { whereSql: wEmp, values: vEmp } = buildScopeWhere(scope, "e", true);
  const params = [...vEmp, tz];
  const tzIdx = params.length;

  const { rows } = await query(`
    SELECT 
      d.pk_department_id as dept_id,
      d.name as department,
      d.code,
      d.color,
      s.pk_shift_id as shift_id,
      s.name as shift_name,
      s.shift_type,
      s.start_time::text,
      s.end_time::text,
      s.grace_period_minutes,
      e.pk_employee_id,
      e.full_name,
      e.employee_code,
      e.status as emp_status,
      a.check_in AT TIME ZONE $${tzIdx} as check_in_local,
      a.check_out AT TIME ZONE $${tzIdx} as check_out_local,
      CASE
        WHEN a.status = 'late' OR a.is_late = true THEN true
        WHEN s.is_flexible = true OR s.start_time IS NULL OR a.check_in IS NULL THEN false
        WHEN (a.check_in AT TIME ZONE $${tzIdx})::time > (s.start_time + (COALESCE(s.grace_period_minutes,0) || ' minutes')::interval) THEN true
        ELSE false
      END as is_late,
      a.duration_minutes,
      CASE WHEN a.pk_attendance_id IS NOT NULL THEN COALESCE(a.status, 'present')
           ELSE 'absent' END as today_status
    FROM hr_employee e
    LEFT JOIN hr_department d ON d.pk_department_id = e.fk_department_id
    LEFT JOIN hr_shift s ON s.pk_shift_id = e.fk_shift_id
    LEFT JOIN attendance_record a ON a.fk_employee_id = e.pk_employee_id
      AND a.attendance_date = (NOW() AT TIME ZONE $${tzIdx})::date
    WHERE ${wEmp} AND e.status = 'active'
    ORDER BY d.name, s.start_time, e.full_name
  `, params);
  return rows;
}
