import { writeAudit } from '../../middleware/auditLog.js';
import { query } from "../../db/pool.js";
import * as authRepo from "../../repositories/authRepository.js";
import { buildScopeWhere } from "../../repositories/scopeSql.js";
import * as storage from "../storageService.js";
import { buildUserDataKey } from "../../utils/s3KeyBuilder.js";

/**
 * EmployeeService
 * Employee CRUD and activity aggregation.
 */
class EmployeeService {
  /**
   * List employees with optional filters.
   * @param {{scope:{tenantId:string,customerId?:string,siteId?:string,unitId?:string}, limit?:number, department?:string, status?:'active'|'inactive'}} params
   */
  async getAllEmployees({ scope, limit = 200, department, status }) {
    const { whereSql, values } = buildScopeWhere(scope, "e", true);
    let idx = values.length + 1;
    const filters = [whereSql];
    if (department) {
      filters.push(`d.name = $${idx++}`); values.push(department);
    }
    if (status) {
      filters.push(`e.status = $${idx++}`); values.push(status);
    }
    const sql = `
      select e.*,
             d.name as department_name,
             s.name as shift_name,
             s.shift_type,
             mgr.full_name as manager_name,
             mgr.employee_code as manager_code,
             CASE WHEN COUNT(emb.id) > 0 THEN true ELSE false END as enrolled,
             CASE WHEN COUNT(emb.id) > 0 THEN true ELSE false END as face_enrolled,
             COUNT(emb.id)::int as embedding_count
      from hr_employee e
      left join hr_department d on d.pk_department_id = e.fk_department_id
      left join hr_shift s on s.pk_shift_id = e.fk_shift_id
      left join hr_employee mgr on mgr.pk_employee_id = e.fk_manager_id
      left join employee_face_embeddings emb on emb.employee_id = e.pk_employee_id
      where ${filters.join(" and ")}
      group by e.pk_employee_id, d.name, s.name, s.shift_type, mgr.full_name, mgr.employee_code
      order by e.full_name
      limit ${limit}`;
    const res = await query(sql, values);
    return res.rows;
  }

  /**
   * Search employees by name/code/email.
   * @param {{scope:{tenantId:string}, q:string, limit?:number}} params
   */
  async searchEmployees({ scope, q, limit = 50 }) {
    const { whereSql, values } = buildScopeWhere(scope, "", true);
    const like = `%${q}%`;
    const likeIdx = values.length + 1;
    const limitIdx = values.length + 2;
    values.push(like, limit);
    const res = await query(
      `select pk_employee_id, employee_code, full_name, email, position_title, status
       from hr_employee
       where ${whereSql} and (full_name ilike $${likeIdx} or employee_code ilike $${likeIdx} or email ilike $${likeIdx})
       order by full_name
       limit $${limitIdx}`,
      values
    );
    return res.rows;
  }

  /**
   * List employees marked as managers, for the Reporting Manager picker.
   * @param {{scope:{tenantId:string}}} params
   */
  async listManagers({ scope }) {
    const { whereSql, values } = buildScopeWhere(scope, "", true);
    const res = await query(
      `select pk_employee_id, employee_code, full_name
       from hr_employee
       where is_manager = true and status = 'active' and ${whereSql}
       order by full_name`,
      values
    );
    return res.rows;
  }

  /**
   * Get employee by id.
   * @param {{employeeId:string, scope:{tenantId:string}}} params
   */
  async getEmployeeById({ employeeId, scope }) {
    const { whereSql, values } = buildScopeWhere(scope, "e", true);
    const idIdx = values.length + 1;
    values.push(Number(employeeId));
    const res = await query(
      `SELECT e.*,
        d.name as department_name, d.code as department_code, d.color as department_color,
        s.name as shift_name, s.shift_type, s.start_time, s.end_time, s.grace_period_minutes,
        mgr.full_name as manager_name, mgr.employee_code as manager_code
       FROM hr_employee e
       LEFT JOIN hr_department d ON d.pk_department_id = e.fk_department_id
       LEFT JOIN hr_shift s ON s.pk_shift_id = e.fk_shift_id
       LEFT JOIN hr_employee mgr ON mgr.pk_employee_id = e.fk_manager_id
       WHERE e.pk_employee_id = $${idIdx} AND ${whereSql}`,
      values
    );
    return res.rows[0] || null;
  }

  /**
   * Get employee photo from enrollment embeddings.
   * @param {{employeeId:string, scope:{tenantId:string}}} params
   */
  async getEmployeePhoto({ employeeId, scope }) {
    const { whereSql, values } = buildScopeWhere(scope, "e", true);
    const idIdx = values.length + 1;
    values.push(Number(employeeId));
    const owned = await query(
      `SELECT employee_code FROM hr_employee e WHERE e.pk_employee_id = $${idIdx} AND ${whereSql}`,
      values
    );
    if (!owned.rows.length) return { employeeId: Number(employeeId), url: null };

    // Prefer the fixed-location profile/profile.jpg object, populated by the
    // enrollment routes whenever a "front" angle photo is uploaded (see
    // employeeRoutes.js enroll-face/enroll-remote and EnrollmentService.uploadAngle).
    // Its existence is inferred from a front-angle photo having been recorded
    // rather than an extra S3 round trip, since both are written atomically.
    const frontEmbedding = await query(
      `SELECT 1 FROM employee_face_embeddings WHERE employee_id = $1 AND angle = 'front' AND photo_path IS NOT NULL LIMIT 1`,
      [Number(employeeId)]
    );
    const frontInvitation = frontEmbedding.rows.length ? null : await query(
      `SELECT 1 FROM enrollment_invitations
       WHERE fk_employee_id = $1 AND status = 'completed' AND photo_paths->>'front' IS NOT NULL
       LIMIT 1`,
      [Number(employeeId)]
    );
    if (frontEmbedding.rows.length || frontInvitation?.rows.length) {
      return { employeeId: Number(employeeId), url: `/api/employees/${employeeId}/profile-photo` };
    }

    const res = await query(
      `SELECT photo_path
       FROM employee_face_embeddings
       WHERE employee_id = $1
         AND photo_path IS NOT NULL
       ORDER BY is_primary DESC, enrolled_at DESC
       LIMIT 1`,
      [Number(employeeId)]
    );
    const photoPath = res.rows[0]?.photo_path;
    let url = null;
    if (photoPath) {
      if (photoPath.startsWith('http') || photoPath.startsWith('/uploads')) {
        url = photoPath;
      } else {
        url = `/api/jetson/photos/${photoPath.split('/').pop()}`;
      }
    } else {
      // Fallback: look up their completed invitation in the enrollment_invitations table
      const invRes = await query(
        `SELECT photo_paths 
         FROM enrollment_invitations 
         WHERE fk_employee_id = $1 
           AND status = 'completed'
           AND photo_paths IS NOT NULL
         ORDER BY completed_at DESC 
         LIMIT 1`,
        [Number(employeeId)]
      );
      if (invRes.rows.length > 0) {
        let photoPaths = invRes.rows[0].photo_paths;
        if (typeof photoPaths === 'string') {
          try { photoPaths = JSON.parse(photoPaths); } catch {}
        }
        const front = photoPaths.front || photoPaths.left || photoPaths.right || photoPaths.up || photoPaths.down;
        if (front) {
          if (front.startsWith('http') || front.startsWith('/uploads')) {
            url = front;
          } else {
            // front is now an S3 key (see EnrollmentService.uploadAngle) — proxy
            // through the same bare-filename resolver used for embeddings above.
            url = `/api/jetson/photos/${front.split('/').pop()}`;
          }
        }
      }
    }
    return { employeeId: Number(employeeId), url };
  }

  /**
   * Stream the employee's profile/profile.jpg object directly, keyed by their
   * own employee_code — bypasses photoResolverService's bare-filename ILIKE
   * match, which can't disambiguate "profile.jpg" across employees since
   * every employee's profile photo shares that exact filename.
   * @param {{employeeId:string, scope:{tenantId:string}}} params
   * @returns {Promise<{stream, contentType, contentLength} | null>}
   */
  async getProfilePhotoStream({ employeeId, scope }) {
    const { whereSql, values } = buildScopeWhere(scope, "e", true);
    const idIdx = values.length + 1;
    values.push(Number(employeeId));
    const res = await query(
      `SELECT employee_code FROM hr_employee e WHERE e.pk_employee_id = $${idIdx} AND ${whereSql}`,
      values
    );
    if (!res.rows.length) return null;

    const key = buildUserDataKey({
      tenantId: scope.tenantId, employeeCode: res.rows[0].employee_code, section: 'profile', filename: 'profile.jpg',
    });
    try {
      return await storage.getFileStream(storage.USER_DATA_BUCKET, key);
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  /**
   * Attendance overview for employee.
   * @param {{employeeId:string, fromDate?:string, toDate?:string, scope:{tenantId:string}}} params
   */
  async getEmployeeAttendance({ employeeId, fromDate, toDate, scope }) {
    const { whereSql, values } = buildScopeWhere(scope, "a");
    let idx = values.length + 1;
    const filters = [`a.fk_employee_id = $${idx++}`, whereSql];
    values.push(Number(employeeId));
    if (fromDate) { filters.push(`a.attendance_date >= $${idx++}`); values.push(fromDate); }
    if (toDate) { filters.push(`a.attendance_date <= $${idx++}`); values.push(toDate); }
    const res = await query(
      `select a.*,
        COALESCE(
          (
            select array_to_json(array_agg(de.occurred_at ORDER BY de.occurred_at ASC))
            from device_events de 
            left join hr_employee emp on emp.pk_employee_id = a.fk_employee_id
            left join frs_site s on s.pk_site_id = coalesce(a.site_id, emp.site_ids[1])
            where de.tenant_id = a.tenant_id 
              and de.event_type = 'EMPLOYEE_ENTRY' 
              and COALESCE(de.payload_json->>'employee_id', de.payload_json->>'employeeId') = a.fk_employee_id::text
              and (de.occurred_at AT TIME ZONE coalesce(s.timezone, 'Asia/Kolkata'))::date = a.attendance_date
          ),
          CASE WHEN a.check_in IS NOT NULL THEN json_build_array(a.check_in) ELSE '[]'::json END
        ) as all_check_ins,
        COALESCE(
          (
            select array_to_json(array_agg(de.occurred_at ORDER BY de.occurred_at ASC))
            from device_events de 
            left join hr_employee emp on emp.pk_employee_id = a.fk_employee_id
            left join frs_site s on s.pk_site_id = coalesce(a.site_id, emp.site_ids[1])
            where de.tenant_id = a.tenant_id 
              and de.event_type = 'EMPLOYEE_EXIT' 
              and COALESCE(de.payload_json->>'employee_id', de.payload_json->>'employeeId') = a.fk_employee_id::text
              and (de.occurred_at AT TIME ZONE coalesce(s.timezone, 'Asia/Kolkata'))::date = a.attendance_date
          ),
          CASE WHEN a.check_out IS NOT NULL THEN json_build_array(a.check_out) ELSE '[]'::json END
        ) as all_check_outs,
        CASE
          WHEN hs.is_flexible = true OR hs.start_time IS NULL THEN false
          WHEN a.check_in IS NULL THEN false
          WHEN (a.check_in AT TIME ZONE COALESCE(fs.timezone, 'Asia/Kolkata'))::time > 
               (hs.start_time + (COALESCE(hs.grace_period_minutes,0) || ' minutes')::interval)
          THEN true
          ELSE false
        END as is_late
      from attendance_record a
      left join hr_employee e on e.pk_employee_id = a.fk_employee_id
      left join hr_shift hs on hs.pk_shift_id = e.fk_shift_id
      left join frs_site fs on fs.pk_site_id = coalesce(a.site_id, e.site_ids[1])
      where ${filters.join(" and ")} order by a.attendance_date desc`,
      values
    );
    return res.rows;
  }

  /**
   * Recent activity for employee (alerts and device scans).
   * @param {{employeeId:string, scope:{tenantId:string}}} params
   */
  async getEmployeeActivity({ employeeId, scope }) {
    const { whereSql, values } = buildScopeWhere(scope, "");
    const idIdx = values.length + 1;
    values.push(Number(employeeId));
    const alerts = await query(
      `select * from system_alert where fk_employee_id = $${idIdx} and ${whereSql} order by created_at desc limit 50`,
      values
    );
    return { alerts: alerts.rows };
  }

  async createEmployee({ scope, data }) {
    const sIds = data.site_ids || (data.site_id ? [Number(data.site_id)] : (scope.siteId ? [Number(scope.siteId)] : null));
    if (sIds && sIds.length > 0) {
      const inactiveCheck = await query(
        `SELECT pk_site_id, site_name, status FROM frs_site WHERE pk_site_id = ANY($1::bigint[]) AND status = 'inactive'`,
        [sIds.map(Number)]
      );
      if (inactiveCheck.rows.length > 0) {
        throw new Error(
          `Cannot onboard employee to an inactive site: ${inactiveCheck.rows.map(r => r.site_name).join(', ')}. Please activate the site first.`
        );
      }
    }
    const sql = `
      insert into hr_employee(
        tenant_id, customer_id, unit_id, fk_department_id, fk_shift_id, fk_manager_id,
        employee_code, full_name, email, position_title, location_label, status, join_date, phone_number, site_ids, is_manager
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      returning *`;
    const values = [
      scope.tenantId, scope.customerId || null, scope.unitId || null,
      data.fk_department_id || null, data.fk_shift_id || null, data.fk_manager_id || null,
      data.employee_code, data.full_name, data.email, data.position_title,
      data.location_label || null, data.status || "active", data.join_date, data.phone_number || null,
      sIds, data.is_manager ?? false
    ];
    const res = await query(sql, values);
    return res.rows[0];
  }

  /**
   * Update employee.
   * FIX-018: Validates that an employee cannot be set as their own manager.
   * @param {{employeeId:string, patch:any, scope:{tenantId:string}}} params
   */
  async updateEmployee({ employeeId, patch, scope }) {
    if (patch.fk_manager_id && String(patch.fk_manager_id) === String(employeeId)) {
      throw new Error("An employee cannot be their own manager");
    }
    const { whereSql, values } = buildScopeWhere(scope, "", true);
    const fields = [];

    // Ensure site_id is not included in query since hr_employee only has site_ids
    delete patch.site_id;

    if (patch.site_ids !== undefined) {
      if (patch.site_ids && patch.site_ids.length > 0) {
        const inactiveCheck = await query(
          `SELECT pk_site_id, site_name, status FROM frs_site WHERE pk_site_id = ANY($1::bigint[]) AND status = 'inactive'`,
          [patch.site_ids.map(Number)]
        );
        if (inactiveCheck.rows.length > 0) {
          throw new Error(
            `Cannot assign employee to an inactive site: ${inactiveCheck.rows.map(r => r.site_name).join(', ')}. Please activate the site first.`
          );
        }
      }
    }
    
    let idx = values.length + 1;
    for (const [k, v] of Object.entries(patch || {})) {
      fields.push(`${k} = $${idx++}`);
      values.push(v);
    }
    const idIdx = idx;
    values.push(Number(employeeId));
    const res = await query(
      `update hr_employee set ${fields.join(", ")}
       where pk_employee_id = $${idIdx} and ${whereSql}
       returning *`,
      values
    );
    return res.rows[0] || null;
  }

  /**
   * Delete employee.
   * @param {{employeeId:string, scope:{tenantId:string}}} params
   */
  async deleteEmployee({ employeeId, scope }) {
    const { pool } = await import('../../db/pool.js');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const eid = Number(employeeId);

      // Confirm employee belongs to this tenant before touching anything
      const { whereSql, values } = buildScopeWhere(scope, "");
      const idIdx = values.length + 1;
      values.push(eid);
      
      const { rows } = await client.query(
        `SELECT pk_employee_id FROM hr_employee WHERE pk_employee_id = $${idIdx} AND ${whereSql}`,
        values
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        const err = new Error('Employee not found');
        err.statusCode = 404;
        throw err;
      }

      // Cascade-delete all dependent records in FK-safe order
      await client.query(`DELETE FROM employee_face_embeddings WHERE employee_id = $1`, [eid]);
      await client.query(`DELETE FROM enrollment_invitations   WHERE fk_employee_id = $1`, [eid]);
      await client.query(`DELETE FROM attendance_events        WHERE fk_employee_id = $1`, [eid]);
      await client.query(`DELETE FROM attendance_record        WHERE fk_employee_id = $1`, [eid]);
      await client.query(`DELETE FROM hr_roster                WHERE fk_employee_id = $1 OR swapped_with = $1`, [eid]);
      await client.query(`UPDATE system_alert SET fk_employee_id = NULL WHERE fk_employee_id = $1`, [eid]);

      // Finally delete the employee
      await client.query(
        `DELETE FROM hr_employee WHERE pk_employee_id = $${idIdx} AND ${whereSql}`,
        values
      );

      await client.query('COMMIT');
      return { success: true };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Activate employee.
   * @param {{employeeId:string, scope:{tenantId:string}}} params
   */
  async activateEmployee({ employeeId, scope }) {
    return this.updateEmployee({ employeeId, scope, patch: { status: "active" } });
  }

  /**
   * Deactivate employee.
   * @param {{employeeId:string, scope:{tenantId:string}}} params
   */
  async deactivateEmployee({ employeeId, scope }) {
    return this.updateEmployee({ employeeId, scope, patch: { status: "inactive" } });
  }

  /**
   * Assign device (placeholder mapping table).
   * @param {{employeeId:string, deviceId:string}} params
   */
  async assignDevice({ employeeId, deviceId }) {
    return { employeeId, deviceId, assigned: true };
  }

  /**
   * Bulk import basic employees.
   * @param {{rows:Array<any>, scope:{tenantId:string}}} params
   */
  async bulkImport({ rows, scope }) {
    const { query } = await import("../../db/pool.js");
    const results = [];

    // Pre-load departments and shifts for name resolution
    const deptRes = await query(
      `SELECT pk_department_id, name, code FROM hr_department WHERE tenant_id = $1`,
      [scope.tenantId]
    );
    const shiftRes = await query(
      `SELECT pk_shift_id, name FROM hr_shift WHERE tenant_id = $1`,
      [scope.tenantId]
    );
    const deptMap = {};
    deptRes.rows.forEach(d => {
      deptMap[d.name.toLowerCase()] = d.pk_department_id;
      deptMap[d.code?.toLowerCase()] = d.pk_department_id;
    });
    const shiftMap = {};
    shiftRes.rows.forEach(s => { shiftMap[s.name.toLowerCase()] = s.pk_shift_id; });

    for (const r of rows || []) {
      const rowResult = { row: r, status: 'error', message: '' };
      try {
        // Validate required fields
        if (!r.employee_code) { rowResult.message = 'employee_code is required'; results.push(rowResult); continue; }
        if (!r.full_name)     { rowResult.message = 'full_name is required';     results.push(rowResult); continue; }

        // Check for duplicate employee_code
        const { whereSql, values } = buildScopeWhere(scope, "");
        const codeIdx = values.length + 1;
        values.push(r.employee_code);
        const exists = await query(
          `SELECT pk_employee_id FROM hr_employee WHERE employee_code = $${codeIdx} AND ${whereSql}`,
          values
        );
        if (exists.rows.length > 0) {
          rowResult.status = 'skipped';
          rowResult.message = `Employee code ${r.employee_code} already exists`;
          results.push(rowResult);
          continue;
        }

        // Resolve department name → id
        if (r.department_name && !r.fk_department_id) {
          r.fk_department_id = deptMap[r.department_name.toLowerCase()] ?? null;
        }
        // Resolve shift name → id
        if (r.shift_name && !r.fk_shift_id) {
          r.fk_shift_id = shiftMap[r.shift_name.toLowerCase()] ?? null;
        }

        await this.createEmployee({ scope, data: r });
        rowResult.status = 'created';
        rowResult.message = `${r.full_name} created successfully`;
      } catch (e) {
        rowResult.message = e.message ?? 'Unknown error';
      }
      results.push(rowResult);
    }

    const created = results.filter(r => r.status === 'created').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const errors  = results.filter(r => r.status === 'error').length;
    return { created, skipped, errors, results };
  }
}

const employeeService = new EmployeeService();
export default employeeService;

