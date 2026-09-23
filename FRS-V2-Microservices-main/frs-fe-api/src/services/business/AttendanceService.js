import { query } from "../../db/pool.js";
import * as eventRepo from "../../repositories/eventRepository.js";
import * as liveRepo from "../../repositories/liveRepository.js";
import { env } from "../../config/env.js";
import { buildScopeWhere } from "../../repositories/scopeSql.js";
import logger from "../../utils/logger.js";

/**
 * AttendanceService
 * High-level attendance operations and reports.
 * Integrates with repositories and optional real-time broadcaster.
 */
class AttendanceService {
  /** @type {(event:string,payload:any)=>void|null} */
  broadcaster = null;

  /**
   * Attach a broadcaster callback used for real-time updates.
   * @param {(event:string,payload:any)=>void} fn
   */
  setBroadcaster(fn) {
    this.broadcaster = typeof fn === "function" ? fn : null;
  }

  /**
   * Mark attendance for a single employee.
   * @param {{employeeId:string, deviceId?:string, timestamp?:string, status?:'present'|'late'|'absent'|'on-break', scope:{tenantId:string,customerId?:string,siteId?:string,unitId?:string}}} payload
   */
  async markAttendance(payload) {
    const ts = payload.timestamp || new Date().toISOString();
    const status = payload.status || "present";

    // 1. Determine check_in vs check_out from direction
    // If Jetson sends direction="entry" → check_in
    // If Jetson sends direction="exit"  → check_out
    // If no direction → fallback to MIXED (time-based)
    const direction = payload.direction || '';
    let cameraMode = 'MIXED';
    if (direction === 'entry') {
      cameraMode = 'IN';
    } else if (direction === 'exit') {
      cameraMode = 'OUT';
    } else if (payload.deviceId) {
      try {
        const camRes = await query(
          `SELECT camera_mode FROM facility_device WHERE external_device_id = $1`,
          [payload.deviceId]
        );
        if (camRes.rows.length > 0 && camRes.rows[0].camera_mode) {
          cameraMode = camRes.rows[0].camera_mode;
        }
      } catch (e) {
        logger.warn({ err: e }, '[Attendance] Failed to fetch camera mode');
      }
    }
    logger.debug({ employeeId: payload.employeeId, direction, cameraMode }, '[Attendance] marking attendance');

    // Fetch site timezone for accurate local-date and late-check calculations
    const siteTz = await liveRepo.getSiteTimezone(payload.scope.siteId);
    const localDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: siteTz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ts));

    // 2. Execute Hybrid UPSERT
    const sql = `
      insert into attendance_record(
        tenant_id, customer_id, site_id, unit_id,
        fk_employee_id, attendance_date, check_in, check_out, status, location_label,
        recognition_accuracy, is_late, is_early_departure
      ) values ($1,$2,$3,$4,$5,$6,
        CASE WHEN $11 IN ('IN', 'MIXED') THEN $7::timestamptz ELSE NULL END,
        CASE WHEN $11 IN ('OUT', 'MIXED') THEN $7::timestamptz ELSE NULL END,
        $8,$9,$10,
        CASE
          WHEN $11 IN ('IN', 'MIXED') THEN (
            SELECT CASE
              WHEN s.is_flexible = true OR s.start_time IS NULL THEN false
              WHEN ($7::timestamptz AT TIME ZONE $12)::time > (s.start_time + (COALESCE(s.grace_period_minutes,0) || ' minutes')::interval) THEN true
              ELSE false
            END
            FROM hr_employee e
            LEFT JOIN hr_shift s ON s.pk_shift_id = e.fk_shift_id
            WHERE e.pk_employee_id = $5
          )
          ELSE false
        END,
        CASE
          WHEN $11 IN ('OUT', 'MIXED') THEN (
            SELECT CASE
              WHEN s.is_flexible = true OR s.end_time IS NULL THEN false
              WHEN ($7::timestamptz AT TIME ZONE $12)::time < s.end_time THEN true
              ELSE false
            END
            FROM hr_employee e
            LEFT JOIN hr_shift s ON s.pk_shift_id = e.fk_shift_id
            WHERE e.pk_employee_id = $5
          )
          ELSE false
        END
      )
      on conflict (tenant_id, fk_employee_id, attendance_date)
      do update set
        check_in = CASE
          WHEN excluded.check_in IS NOT NULL THEN LEAST(COALESCE(attendance_record.check_in, excluded.check_in), excluded.check_in)
          ELSE attendance_record.check_in
        END,
        -- Clear stale check_out when a check_in arrives that is after it (midnight-carryover exit or returning from break)
        check_out = CASE
          WHEN excluded.check_in IS NOT NULL
            AND attendance_record.check_out IS NOT NULL
            AND (
              attendance_record.check_out <= LEAST(COALESCE(attendance_record.check_in, excluded.check_in), excluded.check_in)
              OR (excluded.check_in > attendance_record.check_out AND excluded.check_in - attendance_record.check_out >= interval '2 minutes')
            )
          THEN NULL
          WHEN excluded.check_out IS NOT NULL THEN (
            CASE
              -- Reject check_out that is before an already-set check_in
              WHEN attendance_record.check_in IS NOT NULL
                AND GREATEST(COALESCE(attendance_record.check_out, excluded.check_out), excluded.check_out) <= attendance_record.check_in
              THEN attendance_record.check_out
              ELSE GREATEST(COALESCE(attendance_record.check_out, excluded.check_out), excluded.check_out)
            END
          )
          ELSE attendance_record.check_out
        END,
        checkout_photo_url = CASE
          WHEN excluded.check_in IS NOT NULL
            AND attendance_record.check_out IS NOT NULL
            AND (
              attendance_record.check_out <= LEAST(COALESCE(attendance_record.check_in, excluded.check_in), excluded.check_in)
              OR (excluded.check_in > attendance_record.check_out AND excluded.check_in - attendance_record.check_out >= interval '2 minutes')
            )
          THEN NULL
          ELSE attendance_record.checkout_photo_url
        END,
        status = excluded.status,
        is_late = CASE
          WHEN excluded.check_in IS NOT NULL THEN (
            CASE
              WHEN attendance_record.check_in IS NULL THEN excluded.is_late
              WHEN excluded.check_in < attendance_record.check_in THEN excluded.is_late
              ELSE attendance_record.is_late
            END
          )
          ELSE attendance_record.is_late
        END,
        is_early_departure = CASE
          WHEN excluded.check_out IS NOT NULL THEN excluded.is_early_departure
          ELSE attendance_record.is_early_departure
        END,
        recognition_accuracy = GREATEST(COALESCE(attendance_record.recognition_accuracy, 0), COALESCE(excluded.recognition_accuracy, 0)),
        duration_minutes = CASE
          WHEN excluded.check_in IS NOT NULL
            AND attendance_record.check_out IS NOT NULL
            AND (
              attendance_record.check_out <= LEAST(COALESCE(attendance_record.check_in, excluded.check_in), excluded.check_in)
              OR (excluded.check_in > attendance_record.check_out AND excluded.check_in - attendance_record.check_out >= interval '2 minutes')
            )
          THEN NULL
          WHEN (CASE WHEN excluded.check_out IS NOT NULL THEN GREATEST(COALESCE(attendance_record.check_out, excluded.check_out), excluded.check_out) ELSE attendance_record.check_out END)
             > (CASE WHEN excluded.check_in IS NOT NULL THEN LEAST(COALESCE(attendance_record.check_in, excluded.check_in), excluded.check_in) ELSE attendance_record.check_in END)
          THEN ROUND(EXTRACT(EPOCH FROM (
            (CASE WHEN excluded.check_out IS NOT NULL THEN GREATEST(COALESCE(attendance_record.check_out, excluded.check_out), excluded.check_out) ELSE attendance_record.check_out END)
            -
            (CASE WHEN excluded.check_in IS NOT NULL THEN LEAST(COALESCE(attendance_record.check_in, excluded.check_in), excluded.check_in) ELSE attendance_record.check_in END)
          )) / 60)
          ELSE NULL
        END,
        working_hours = CASE
          WHEN excluded.check_in IS NOT NULL
            AND attendance_record.check_out IS NOT NULL
            AND (
              attendance_record.check_out <= LEAST(COALESCE(attendance_record.check_in, excluded.check_in), excluded.check_in)
              OR (excluded.check_in > attendance_record.check_out AND excluded.check_in - attendance_record.check_out >= interval '2 minutes')
            )
          THEN 0.00
          WHEN (CASE WHEN excluded.check_out IS NOT NULL THEN GREATEST(COALESCE(attendance_record.check_out, excluded.check_out), excluded.check_out) ELSE attendance_record.check_out END)
             > (CASE WHEN excluded.check_in IS NOT NULL THEN LEAST(COALESCE(attendance_record.check_in, excluded.check_in), excluded.check_in) ELSE attendance_record.check_in END)
          THEN ROUND(EXTRACT(EPOCH FROM (
            (CASE WHEN excluded.check_out IS NOT NULL THEN GREATEST(COALESCE(attendance_record.check_out, excluded.check_out), excluded.check_out) ELSE attendance_record.check_out END)
            -
            (CASE WHEN excluded.check_in IS NOT NULL THEN LEAST(COALESCE(attendance_record.check_in, excluded.check_in), excluded.check_in) ELSE attendance_record.check_in END)
          )) / 3600, 2)
          ELSE 0.00
        END
      returning *`;

    const params = [
      payload.scope.tenantId,
      payload.scope.customerId || null,
      payload.scope.siteId || null,
      payload.scope.unitId || null,
      Number(payload.employeeId),
      localDate,
      ts,
      status,
      null,
      payload.confidence || null,
      cameraMode,
      siteTz,
    ];

    const res = await query(sql, params);
    const record = res.rows[0];

    // Presence ping for dwell-time / device-activity analytics. attendance_record
    // only keeps first-in/last-out, so we log every recognition here with the real
    // event time + device. device_code may be null (dwell COALESCEs it to the
    // 'unassigned' zone), so always record presence.
    try {
      await query(
        `INSERT INTO attendance_ping (tenant_id, fk_employee_id, device_code, direction, confidence, occurred_at)
         VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
        [payload.scope.tenantId, Number(payload.employeeId), payload.deviceId || null, direction || null, payload.confidence || null, ts]
      );
    } catch (e) {
      logger.warn({ err: e }, '[Attendance] presence ping insert failed');
    }

    // Calculate actual break duration from attendance pings
    try {
      const pingsRes = await query(
        `SELECT direction, occurred_at FROM attendance_ping
         WHERE tenant_id = $1::uuid AND fk_employee_id = $2
           AND (occurred_at AT TIME ZONE $3)::date = $4::date
         ORDER BY occurred_at ASC`,
        [payload.scope.tenantId, Number(payload.employeeId), siteTz, localDate]
      );
      
      let totalBreakMs = 0;
      let lastInTime = null;
      let lastOutTime = null;
      let workStarted = false;
      const MAX_SINGLE_BREAK_MS = 60 * 60 * 1000; // 60 mins max per single break segment

      for (const ping of pingsRes.rows) {
        const dir = (ping.direction || '').toLowerCase();
        const time = new Date(ping.occurred_at);

        if (dir === 'in' || dir === 'entry') {
          if (!workStarted) {
            workStarted = true;
            lastInTime = time;
          } else if (lastOutTime) {
            const breakMs = time - lastOutTime;
            if (breakMs >= 5 * 60 * 1000) {
              totalBreakMs += Math.min(breakMs, MAX_SINGLE_BREAK_MS);
            }
            lastOutTime = null;
            lastInTime = time;
          } else {
            lastInTime = time;
          }
        } else if (dir === 'out' || dir === 'exit') {
          if (workStarted && !lastOutTime) {
            lastOutTime = time;
          }
        }
      }
      
      const breakMinutes = Math.round(totalBreakMs / 60000);
      
      // Update the attendance_record with the computed break duration and net working hours.
      // When ping-based calc finds no break but a complete session (≥60 min) exists,
      // fall back to a 30-min default break. Check-in-only rows only update break_duration_minutes.
      if (record.check_out) {
        await query(
          `UPDATE attendance_record
           SET break_duration_minutes = CASE
                 WHEN $1::integer > 0 THEN $1::integer
                 WHEN check_in IS NOT NULL AND check_out IS NOT NULL
                   AND check_out > check_in
                   AND EXTRACT(EPOCH FROM (check_out - check_in)) / 60 >= 60
                 THEN 30
                 ELSE $1::integer
               END,
               working_hours = GREATEST(0, ROUND(
                 EXTRACT(EPOCH FROM (check_out - check_in)) / 3600.0
                 - (CASE
                      WHEN $1::integer > 0 THEN $1::numeric
                      WHEN EXTRACT(EPOCH FROM (check_out - check_in)) / 60 >= 60 THEN 30::numeric
                      ELSE 0::numeric
                    END) / 60.0,
                 2
               ))
           WHERE pk_attendance_id = $2 AND check_out IS NOT NULL AND check_in IS NOT NULL AND check_out > check_in`,
          [breakMinutes, record.pk_attendance_id]
        );
      } else {
        await query(
          `UPDATE attendance_record
           SET break_duration_minutes = $1::integer
           WHERE pk_attendance_id = $2`,
          [breakMinutes, record.pk_attendance_id]
        );
      }
      
      // Update local record object so the broadcast payload has the correct values
      record.break_duration_minutes = breakMinutes;
      if (record.check_in && record.check_out) {
        const totalDurationHours = (new Date(record.check_out) - new Date(record.check_in)) / 3600000;
        record.working_hours = Math.max(0, Number((totalDurationHours - (breakMinutes / 60)).toFixed(2)));
      }
    } catch (breakErr) {
      logger.error('[Attendance] Failed to calculate break duration:', breakErr.message);
    }

    this.#broadcast("attendance.marked", { record });
    return record;
  }

  /**
   * Batch mark attendance.
   * @param {{items:Array<{employeeId:string,timestamp?:string,status?:string}>,scope:{tenantId:string,customerId?:string,siteId?:string,unitId?:string}}} payload
   */
  async batchMarkAttendance(payload) {
    const results = [];
    for (const item of payload.items || []) {
      // eslint-disable-next-line no-await-in-loop
      const r = await this.markAttendance({ ...item, scope: payload.scope });
      results.push(r);
    }
    this.#broadcast("attendance.batchMarked", { count: results.length });
    return { count: results.length, records: results };
  }

  /**
   * Get today's attendance for scope.
   * @param {{scope:{tenantId:string,customerId?:string,siteId?:string,unitId?:string}, limit?:number}} params
   */
  async getTodayAttendance({ scope, limit = 500 }) {
    const today = new Date().toISOString().slice(0, 10);
    return liveRepo.listAttendance(scope, { fromDate: today, toDate: today, limit });
  }

  /**
   * Get attendance for an employee.
   * @param {{employeeId:string, fromDate?:string, toDate?:string, scope:{tenantId:string,customerId?:string,siteId?:string,unitId?:string}}} params
   */
  async getEmployeeAttendance({ employeeId, fromDate, toDate, scope }) {
    const { whereSql, values } = buildScopeWhere(scope, "a");
    let idx = values.length + 1;
    const filters = [`a.fk_employee_id = $${idx++}`, whereSql];
    values.push(Number(employeeId));
    if (fromDate) {
      filters.push(`a.attendance_date >= $${idx++}`);
      values.push(fromDate);
    }
    if (toDate) {
      filters.push(`a.attendance_date <= $${idx++}`);
      values.push(toDate);
    }
    const sql = `
      select 
        a.*,
        CASE
          WHEN sh.is_flexible = true OR sh.start_time IS NULL THEN false
          WHEN a.check_in IS NULL THEN false
          WHEN (a.check_in AT TIME ZONE COALESCE(st.timezone, 'Asia/Kolkata'))::time
               > (sh.start_time + (COALESCE(sh.grace_period_minutes, 0) || ' minutes')::interval)
          THEN true
          ELSE false
        END AS is_late_computed,
        coalesce(
          (select nullif(count(*)::int, 0)
           from device_events de 
           left join hr_employee emp on emp.pk_employee_id = a.fk_employee_id
           left join frs_site s on s.pk_site_id = coalesce(a.site_id, emp.site_ids[1])
           where de.tenant_id = a.tenant_id 
             and de.event_type = 'EMPLOYEE_ENTRY' 
             and COALESCE(de.payload_json->>'employee_id', de.payload_json->>'employeeId') = a.fk_employee_id::text
             and (de.occurred_at AT TIME ZONE coalesce(s.timezone, 'Asia/Kolkata'))::date = a.attendance_date
          ),
          case when a.check_in is not null then 1 else 0 end
        ) as check_in_count,
        coalesce(
          (select nullif(count(*)::int, 0)
           from device_events de 
           left join hr_employee emp on emp.pk_employee_id = a.fk_employee_id
           left join frs_site s on s.pk_site_id = coalesce(a.site_id, emp.site_ids[1])
           where de.tenant_id = a.tenant_id 
             and de.event_type = 'EMPLOYEE_EXIT' 
             and COALESCE(de.payload_json->>'employee_id', de.payload_json->>'employeeId') = a.fk_employee_id::text
             and (de.occurred_at AT TIME ZONE coalesce(s.timezone, 'Asia/Kolkata'))::date = a.attendance_date
          ),
          case when a.check_out is not null then 1 else 0 end
        ) as check_out_count,
        coalesce(
          (select json_agg(json_build_object('time', de.occurred_at, 'photo_url', CASE WHEN de.payload_json->>'event_time_raw' IS NOT NULL THEN NULL ELSE de.payload_json->>'photo_url' END) ORDER BY de.occurred_at ASC)
           from device_events de 
           left join hr_employee emp on emp.pk_employee_id = a.fk_employee_id
           left join frs_site s on s.pk_site_id = coalesce(a.site_id, emp.site_ids[1])
           where de.tenant_id = a.tenant_id 
             and de.event_type = 'EMPLOYEE_ENTRY' 
             and COALESCE(de.payload_json->>'employee_id', de.payload_json->>'employeeId') = a.fk_employee_id::text
             and (de.occurred_at AT TIME ZONE coalesce(s.timezone, 'Asia/Kolkata'))::date = a.attendance_date
          ),
          case when a.check_in is not null then json_build_array(json_build_object('time', a.check_in, 'photo_url', a.checkin_photo_url)) else '[]'::json end
        ) as all_check_ins,
        coalesce(
          (select json_agg(json_build_object('time', de.occurred_at, 'photo_url', CASE WHEN de.payload_json->>'event_time_raw' IS NOT NULL THEN NULL ELSE de.payload_json->>'photo_url' END) ORDER BY de.occurred_at ASC)
           from device_events de 
           left join hr_employee emp on emp.pk_employee_id = a.fk_employee_id
           left join frs_site s on s.pk_site_id = coalesce(a.site_id, emp.site_ids[1])
           where de.tenant_id = a.tenant_id 
             and de.event_type = 'EMPLOYEE_EXIT' 
             and COALESCE(de.payload_json->>'employee_id', de.payload_json->>'employeeId') = a.fk_employee_id::text
             and (de.occurred_at AT TIME ZONE coalesce(s.timezone, 'Asia/Kolkata'))::date = a.attendance_date
          ),
          case when a.check_out is not null then json_build_array(json_build_object('time', a.check_out, 'photo_url', a.checkout_photo_url)) else '[]'::json END
        ) as all_check_outs
      from attendance_record a
      left join hr_employee e on e.pk_employee_id = a.fk_employee_id
      left join hr_shift sh on sh.pk_shift_id = e.fk_shift_id
      left join frs_site st on st.pk_site_id = coalesce(a.site_id, e.site_ids[1])
      where ${filters.join(" and ")}
      order by a.attendance_date desc`;
    const res = await query(sql, values);
    return res.rows.map(r => ({
      ...r,
      is_late: r.is_late ?? r.is_late_computed ?? false,
    }));
  }

  /**
   * Range query.
   * @param {{fromDate:string,toDate:string,scope:{tenantId:string,customerId?:string,siteId?:string,unitId?:string}, limit?:number}} params
   */
  async getAttendanceByDateRange({ fromDate, toDate, scope, limit = 1000 }) {
    return liveRepo.listAttendance(scope, { fromDate, toDate, limit });
  }

  /**
   * Who is currently present (checked-in without check-out).
   * @param {{scope:{tenantId:string,customerId?:string,siteId?:string,unitId?:string}}} params
   */
  async getCurrentlyPresent({ scope }) {
    const { whereSql, values } = buildScopeWhere(scope, "a");
    let idx = values.length + 1;
    const sql = `
      select a.*, e.full_name
      from attendance_record a
      join hr_employee e on e.pk_employee_id = a.fk_employee_id
      where ${whereSql}
        and a.attendance_date = $${idx}
        and a.check_in is not null
        and a.check_out is null
      order by e.full_name`;
    const today = new Date().toISOString().slice(0, 10);
    values.push(today);
    const res = await query(sql, values);
    return res.rows;
  }

  /**
   * Aggregate stats for dashboard.
   * @param {{scope:{tenantId:string,customerId?:string,siteId?:string,unitId?:string}, forDate?:string}} params
   */
  async getAttendanceStats({ scope, forDate }) {
    return liveRepo.getDashboardMetrics(scope);
  }

  /**
   * Generate a simple daily report.
   * @param {{scope:{tenantId:string,customerId?:string,siteId?:string,unitId?:string}, date?:string}} params
   */
  async generateDailyReport({ scope, date }) {
    const d = date || new Date().toISOString().slice(0, 10);
    const data = await this.getAttendanceByDateRange({ fromDate: d, toDate: d, scope, limit: 2000 });
    return { date: d, total: data.length, data };
  }

  /**
   * Generate a simple monthly report.
   * @param {{scope:{tenantId:string,customerId?:string,siteId?:string,unitId?:string}, year:number, month:number}} params
   */
  async generateMonthlyReport({ scope, year, month }) {
    const from = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
    const to = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    const data = await this.getAttendanceByDateRange({ fromDate: from, toDate: to, scope, limit: 10000 });
    return { year, month, total: data.length, data };
  }

  /**
   * Export selected attendance rows to CSV.
   * @param {{rows:Array<any>}} params
   * @returns {string}
   */
  exportAttendance({ rows }) {
    if (!Array.isArray(rows) || rows.length === 0) return "";
    const headers = Object.keys(rows[0]);
    const csv = [headers.join(",")].concat(
      rows.map(r => headers.map(h => {
        const v = r[h] == null ? "" : String(r[h]).replace(/"/g, '""');
        return `"${v}"`;
      }).join(","))
    ).join("\n");
    return csv;
  }

  /**
   * Correct attendance record fields.
   * @param {{attendanceId:string,patch:Partial<{check_in:string,check_out:string,status:string}>}} params
   */
  async correctAttendance({ attendanceId, patch }) {
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [k, v] of Object.entries(patch || {})) {
      fields.push(`${k} = $${idx++}`);
      values.push(v);
    }
    values.push(Number(attendanceId));
    const sql = `update attendance_record set ${fields.join(", ")}, updated_at = now() where pk_attendance_id = $${idx} returning *`;
    const res = await query(sql, values);
    const row = res.rows[0] || null;
    if (row) this.#broadcast("attendance.corrected", { id: attendanceId });
    return row;
  }

  /**
   * Delete an attendance record.
   * @param {{attendanceId:string}} params
   */
  async deleteAttendance({ attendanceId }) {
    await query(`delete from attendance_record where pk_attendance_id = $1`, [Number(attendanceId)]);
    this.#broadcast("attendance.deleted", { id: attendanceId });
    return { success: true };
  }

  /**
   * Internal broadcaster helper.
   * @param {string} event
   * @param {any} payload
   */
  #broadcast(event, payload) {
    try {
      if (this.broadcaster) this.broadcaster(event, payload);
    } catch {
      /* noop */
    }
  }
}

const attendanceService = new AttendanceService();
export default attendanceService;

