import { query } from "../../db/pool.js";
import { buildScopeWhere } from "../../repositories/scopeSql.js";

/**
 * ReportService
 * Generates attendance and device reports; basic export utilities.
 */
class ReportService {
  /** @type {Map<string, any>} */
  schedules = new Map();
  /** @type {Map<string, any>} */
  templates = new Map();

  /**
   * Daily attendance report.
   * @param {{scope:any, date:string}} params
   */
  async generateDailyAttendanceReport({ scope, date }) {
    const { whereSql, values } = buildScopeWhere(scope, "a");
    const dateIdx = values.length + 1;
    values.push(date);
    const rows = await query(
      `select a.*, e.full_name, e.employee_code
       from attendance_record a
       join hr_employee e on e.pk_employee_id = a.fk_employee_id
       where ${whereSql} and a.attendance_date = $${dateIdx}
       order by e.full_name`,
      values
    );
    return { type: "dailyAttendance", date, rows: rows.rows };
  }

  /**
   * Monthly attendance report.
   * @param {{scope:any, year:number, month:number}} params
   */
  async generateMonthlyAttendanceReport({ scope, year, month }) {
    const { whereSql, values } = buildScopeWhere(scope, "a");
    const from = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
    const to = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    const fromIdx = values.length + 1;
    const toIdx = values.length + 2;
    values.push(from, to);
    const rows = await query(
      `select a.*, e.full_name, e.employee_code
       from attendance_record a
       join hr_employee e on e.pk_employee_id = a.fk_employee_id
       where ${whereSql} and a.attendance_date between $${fromIdx} and $${toIdx}
       order by a.attendance_date desc, e.full_name`,
      values
    );
    return { type: "monthlyAttendance", year, month, rows: rows.rows };
  }

  /**
   * Yearly attendance report.
   * @param {{scope:any, year:number}} params
   */
  async generateYearlyAttendanceReport({ scope, year }) {
    const { whereSql, values } = buildScopeWhere(scope, "a");
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const fromIdx = values.length + 1;
    const toIdx = values.length + 2;
    values.push(from, to);
    const rows = await query(
      `select a.*, e.full_name
       from attendance_record a
       join hr_employee e on e.pk_employee_id = a.fk_employee_id
       where ${whereSql} and a.attendance_date between $${fromIdx} and $${toIdx}`,
      values
    );
    return { type: "yearlyAttendance", year, rows: rows.rows };
  }

  /**
   * Custom attendance report.
   * @param {{scope:any, fromDate:string, toDate:string}} params
   */
  async generateCustomAttendanceReport({ scope, fromDate, toDate }) {
    const { whereSql, values } = buildScopeWhere(scope, "a");
    const fromIdx = values.length + 1;
    const toIdx = values.length + 2;
    values.push(fromDate, toDate);
    const rows = await query(
      `select a.*, e.full_name
       from attendance_record a
       join hr_employee e on e.pk_employee_id = a.fk_employee_id
       where ${whereSql} and a.attendance_date between $${fromIdx} and $${toIdx}`,
      values
    );
    return { type: "customAttendance", fromDate, toDate, rows: rows.rows };
  }

  /**
   * Attendance summary aggregates.
   * @param {{scope:any, fromDate:string, toDate:string}} params
   */
  async getAttendanceSummary({ scope, fromDate, toDate }) {
    const { whereSql, values } = buildScopeWhere(scope, "");
    const fromIdx = values.length + 1;
    const toIdx = values.length + 2;
    values.push(fromDate, toDate);
    const rows = await query(
      `select status, count(*)::int as count
       from attendance_record
       where ${whereSql} and attendance_date between $${fromIdx} and $${toIdx}
       group by status`,
      values
    );
    return rows.rows;
  }

  async generateEmployeeDirectory({ scope }) {
    const { whereSql, values } = buildScopeWhere(scope, "");
    const rows = await query(
      `select employee_code, full_name, email, position_title, status
       from hr_employee where ${whereSql} order by full_name`,
      values
    );
    return { type: "employeeDirectory", rows: rows.rows };
  }

  async generateTurnoverReport({ scope, fromDate, toDate }) {
    return { type: "turnover", fromDate, toDate, rows: [] };
  }

  async generateTenureReport({ scope }) {
    return { type: "tenure", rows: [] };
  }

  async generateDepartmentReport({ scope }) {
    const { whereSql, values } = buildScopeWhere(scope, "e", true);
    const rows = await query(
      `select d.name as department, count(*)::int as count
       from hr_employee e
       left join hr_department d on d.pk_department_id = e.fk_department_id
       where ${whereSql}
       group by d.name`,
      values
    );
    return { type: "department", rows: rows.rows };
  }

  async generateDeviceHealthReport({ scope }) {
    const { whereSql, values } = buildScopeWhere(scope, "");
    const rows = await query(
      `select status, count(*)::int as count from facility_device where ${whereSql} group by status`,
      values
    );
    return { type: "deviceHealth", rows: rows.rows };
  }

  async generateDeviceActivityReport({ scope, fromDate, toDate }) {
    return { type: "deviceActivity", fromDate, toDate, rows: [] };
  }

  async generateDeviceErrorReport({ scope, fromDate, toDate }) {
    return { type: "deviceErrors", fromDate, toDate, rows: [] };
  }

  async generatePeakHoursReport({ scope, fromDate, toDate }) {
    const { whereSql, values } = buildScopeWhere(scope, "");
    const fromIdx = values.length + 1;
    const toIdx = values.length + 2;
    values.push(fromDate, toDate);
    const rows = await query(
      `select extract(hour from check_in)::int as hour, count(*)::int as count
       from attendance_record
       where ${whereSql} and check_in is not null and attendance_date between $${fromIdx} and $${toIdx}
       group by 1 order by 1`,
      values
    );
    return { type: "peakHours", rows: rows.rows };
  }

  async generateOccupancyReport({ scope, fromDate, toDate }) {
    const { whereSql, values } = buildScopeWhere(scope, "");
    const fromIdx = values.length + 1;
    const toIdx = values.length + 2;
    values.push(fromDate, toDate);
    const rows = await query(
      `select attendance_date as day, count(*)::int as count
       from attendance_record
       where ${whereSql} and check_in is not null and attendance_date between $${fromIdx} and $${toIdx}
       group by attendance_date order by 1`,
      values
    );
    return { type: "occupancy", rows: rows.rows };
  }

  async generateTrendsReport({ scope, fromDate, toDate }) {
    return this.generateOccupancyReport({ scope, fromDate, toDate });
  }

  async generateComplianceReport({ scope, fromDate, toDate }) {
    return { type: "compliance", rows: [] };
  }

  /**
   * Export helpers.
   * @param {{rows:any[]}} params
   */
  exportToCsv({ rows }) {
    if (!rows || rows.length === 0) return "";
    const headers = Object.keys(rows[0]);
    const csv = [headers.join(",")].concat(
      rows.map(r => headers.map(h => {
        const v = r[h] == null ? "" : String(r[h]).replace(/"/g, '""');
        return `"${v}"`;
      }).join(","))
    ).join("\n");
    return csv;
  }

  exportToJson({ rows }) {
    return JSON.stringify(rows || [], null, 2);
  }

  exportToExcel({ rows }) {
    const csv = this.exportToCsv({ rows });
    return Buffer.from(csv, "utf8");
  }

  exportToPdf({ rows }) {
    const text = this.exportToCsv({ rows });
    return Buffer.from(text, "utf8");
  }

  /**
   * Persistent Scheduling & Run History APIs (PostgreSQL backed).
   */
  async getScheduledReports({ tenantId }) {
    const res = await query(
      `SELECT pk_schedule_id as id, name, report_type, frequency, time, recipients, enabled, last_run, created_at, updated_at
       FROM report_schedules
       WHERE tenant_id = $1::uuid
       ORDER BY created_at DESC`,
      [tenantId]
    );
    return res.rows;
  }

  async scheduleReport({ tenantId, name, report_type, frequency, time, recipients, enabled }) {
    const res = await query(
      `INSERT INTO report_schedules (tenant_id, name, report_type, frequency, time, recipients, enabled)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
       RETURNING pk_schedule_id as id, name, report_type, frequency, time, recipients, enabled, last_run, created_at, updated_at`,
      [tenantId, name, report_type, frequency, time, recipients, enabled !== false]
    );
    return res.rows[0];
  }

  async updateScheduledReport({ id, tenantId, name, report_type, frequency, time, recipients, enabled }) {
    const fields = [];
    const values = [id, tenantId];
    let index = 3;

    if (name !== undefined) { fields.push(`name = $${index++}`); values.push(name); }
    if (report_type !== undefined) { fields.push(`report_type = $${index++}`); values.push(report_type); }
    if (frequency !== undefined) { fields.push(`frequency = $${index++}`); values.push(frequency); }
    if (time !== undefined) { fields.push(`time = $${index++}`); values.push(time); }
    if (recipients !== undefined) { fields.push(`recipients = $${index++}`); values.push(recipients); }
    if (enabled !== undefined) { fields.push(`enabled = $${index++}`); values.push(enabled); }

    if (fields.length === 0) return null;

    fields.push(`updated_at = NOW()`);

    const res = await query(
      `UPDATE report_schedules
       SET ${fields.join(", ")}
       WHERE pk_schedule_id = $1::uuid AND tenant_id = $2::uuid
       RETURNING pk_schedule_id as id, name, report_type, frequency, time, recipients, enabled, last_run, created_at, updated_at`,
      values
    );
    return res.rows[0] || null;
  }

  async deleteScheduledReport({ id, tenantId }) {
    await query(
      `DELETE FROM report_schedules
       WHERE pk_schedule_id = $1::uuid AND tenant_id = $2::uuid`,
      [id, tenantId]
    );
    return { success: true };
  }

  async getCompletedRuns({ tenantId }) {
    const res = await query(
      `SELECT pk_run_id as id, name, report_type, file_format, file_path, file_size, run_at, status
       FROM completed_report_runs
       WHERE tenant_id = $1::uuid
       ORDER BY run_at DESC`,
      [tenantId]
    );
    return res.rows;
  }

  async getCompletedRun({ id, tenantId }) {
    const res = await query(
      `SELECT pk_run_id as id, name, report_type, file_format, file_path, file_size, run_at, status, tenant_id
       FROM completed_report_runs
       WHERE pk_run_id = $1::uuid AND tenant_id = $2::uuid`,
      [id, tenantId]
    );
    return res.rows[0] || null;
  }

  async runScheduledReport({ id, tenantId, scope }) {
    const schedRes = await query(
      `SELECT * FROM report_schedules WHERE pk_schedule_id = $1::uuid AND tenant_id = $2::uuid`,
      [id, tenantId]
    );
    if (!schedRes.rows.length) return null;
    const sched = schedRes.rows[0];

    // Generate report data
    let reportData = [];
    const today = new Date().toISOString().slice(0, 10);

    try {
      if (sched.report_type === 'attendance') {
        const data = await this.generateDailyAttendanceReport({ scope, date: today });
        reportData = data.rows || [];
      } else if (sched.report_type === 'employees') {
        const data = await this.generateEmployeeDirectory({ scope });
        reportData = data.rows || [];
      } else if (sched.report_type === 'device_health') {
        const data = await this.generateDeviceHealthReport({ scope });
        reportData = data.rows || [];
      } else {
        const data = await this.generateDailyAttendanceReport({ scope, date: today });
        reportData = data.rows || [];
      }
    } catch (e) {
      reportData = [{ error: "Failed to generate dynamic data", details: e.message }];
    }

    // Export to CSV
    const csvContent = this.exportToCsv({ rows: reportData });
    const fs = await import("fs/promises");
    const path = await import("path");
    const { randomUUID } = await import("crypto");

    const reportsDir = path.resolve(process.env.REPORTS_DIR || path.join(process.cwd(), "uploads/reports"));
    await fs.mkdir(reportsDir, { recursive: true });

    const fileName = `${randomUUID()}.csv`;
    const filePath = path.join(reportsDir, fileName);
    await fs.writeFile(filePath, csvContent, "utf8");

    const fileSize = Buffer.byteLength(csvContent, "utf8");

    // Insert into completed_report_runs
    const runRes = await query(
      `INSERT INTO completed_report_runs (tenant_id, schedule_id, name, report_type, file_format, file_path, file_size)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
       RETURNING pk_run_id as id, name, report_type, file_format, file_size, run_at, status`,
      [tenantId, id, sched.name, sched.report_type, "csv", filePath, fileSize]
    );

    // Update last_run in schedules
    await query(
      `UPDATE report_schedules SET last_run = NOW(), updated_at = NOW() WHERE pk_schedule_id = $1::uuid`,
      [id]
    );

    return runRes.rows[0];
  }

  getReportTemplates() {
    return Array.from(this.templates.values());
  }

  getReportTemplate({ id }) {
    return this.templates.get(id) || null;
  }

  createReportTemplate({ id, template }) {
    this.templates.set(id, template);
    return template;
  }

  updateReportTemplate({ id, template }) {
    if (!this.templates.has(id)) return null;
    this.templates.set(id, template);
    return template;
  }

  deleteReportTemplate({ id }) {
    this.templates.delete(id);
    return { success: true };
  }
}

const reportService = new ReportService();
export default reportService;

