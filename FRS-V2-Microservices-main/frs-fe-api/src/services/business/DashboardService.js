import * as liveRepo from "../../repositories/liveRepository.js";
import { query } from "../../db/pool.js";
import { buildScopeWhere } from "../../repositories/scopeSql.js";

/**
 * DashboardService
 * Aggregates operational and HR metrics for dashboards.
 */
class DashboardService {
  /**
   * Admin overview.
   * @param {{scope:{tenantId:string,customerId?:string,siteId?:string,unitId?:string}}} params
   */
  async getAdminSummary({ scope }) {
    const metrics = await liveRepo.getDashboardMetrics(scope);
    const devices = await liveRepo.listDevices(scope);
    const alerts = await liveRepo.listAlerts(scope);
    return { metrics, deviceCount: devices.length, recentAlerts: alerts.slice(0, 5) };
  }

  /**
   * System health approximation.
   * @returns {Promise<any>}
   */
  async getSystemHealth() {
    return { status: "ok" };
  }

  /**
   * Device status listing.
   * @param {{scope:any}} params
   */
  async getDeviceStatus({ scope }) {
    const devices = await liveRepo.listDevices(scope);
    const byStatus = devices.reduce((acc, d) => {
      acc[d.status] = (acc[d.status] || 0) + 1;
      return acc;
    }, {});
    return { total: devices.length, byStatus, devices };
  }

  /**
   * Active alerts.
   * @param {{scope:any, limit?:number}} params
   */
  async getActiveAlerts({ scope, limit = 100 }) {
    const alerts = await liveRepo.listAlerts(scope);
    return alerts;
  }

  /**
   * HR snapshot summary.
   * @param {{scope:any}} params
   */
  async getHrSummary({ scope }) {
    const metrics = await liveRepo.getDashboardMetrics(scope);
    return metrics;
  }

  /**
   * Current occupancy by unit/site.
   * @param {{scope:any}} params
   */
  async getCurrentOccupancy({ scope }) {
    const { whereSql, values } = buildScopeWhere(scope, "");
    const today = new Date().toISOString().slice(0, 10);
    const dateIdx = values.length + 1;
    values.push(today);
    const rows = await query(
      `select unit_id, count(*)::int as count
       from attendance_record
       where ${whereSql} and attendance_date = $${dateIdx} and check_in is not null and check_out is null
       group by unit_id`,
      values
    );
    return rows.rows;
  }

  /**
   * Occupancy history (simple daily counts).
   * @param {{scope:any, fromDate:string, toDate:string}} params
   */
  async getOccupancyHistory({ scope, fromDate, toDate }) {
    const { whereSql, values } = buildScopeWhere(scope, "");
    const fromIdx = values.length + 1;
    const toIdx = values.length + 2;
    values.push(fromDate, toDate);
    const rows = await query(
      `select attendance_date as day, count(*)::int as count
       from attendance_record
       where ${whereSql} and attendance_date between $${fromIdx} and $${toIdx} and check_in is not null
       group by attendance_date
       order by attendance_date`,
      values
    );
    return rows.rows;
  }

  /**
   * Today attendance details.
   * @param {{scope:any}} params
   */
  async getTodayAttendance({ scope }) {
    const today = new Date().toISOString().slice(0, 10);
    return liveRepo.listAttendance(scope, { fromDate: today, toDate: today, limit: 2000 });
  }

  /**
   * Trends (last N days).
   * @param {{scope:any, days?:number}} params
   */
  async getAttendanceTrends({ scope, days = 14 }) {
    const to = new Date();
    const from = new Date(Date.now() - days * 86400000);
    return this.getOccupancyHistory({
      scope,
      fromDate: from.toISOString().slice(0, 10),
      toDate: to.toISOString().slice(0, 10),
    });
  }

  /**
   * Department summary counts.
   * @param {{scope:any}} params
   */
  async getDepartmentSummary({ scope }) {
    const { whereSql, values } = buildScopeWhere(scope, "e", true);
    const rows = await query(
      `select d.name as department, count(*)::int as count
       from hr_employee e
       left join hr_department d on d.pk_department_id = e.fk_department_id
       where ${whereSql}
       group by d.name
       order by d.name`,
      values
    );
    return rows.rows;
  }

  /**
   * Late arrivals today.
   * @param {{scope:any}} params
   */
  async getLateArrivals({ scope }) {
    const { whereSql, values } = buildScopeWhere(scope, "a");
    const today = new Date().toISOString().slice(0, 10);
    const dateIdx = values.length + 1;
    values.push(today);
    const rows = await query(
      `select e.full_name, a.check_in
       from attendance_record a
       join hr_employee e on e.pk_employee_id = a.fk_employee_id
       where ${whereSql} and a.attendance_date = $${dateIdx} and a.status = 'late'
       order by e.full_name`,
      values
    );
    return rows.rows;
  }

  /**
   * Early departures today.
   * @param {{scope:any}} params
   */
  async getEarlyDepartures({ scope }) {
    const { whereSql, values } = buildScopeWhere(scope, "a");
    const today = new Date().toISOString().slice(0, 10);
    const dateIdx = values.length + 1;
    values.push(today);
    const rows = await query(
      `select e.full_name, a.check_out
       from attendance_record a
       join hr_employee e on e.pk_employee_id = a.fk_employee_id
       where ${whereSql} and a.attendance_date = $${dateIdx} and a.is_early_departure = true
       order by e.full_name`,
      values
    );
    return rows.rows;
  }

  /**
   * Absentees today (no check-in).
   * @param {{scope:any}} params
   */
  async getAbsentees({ scope }) {
    const { whereSql, values } = buildScopeWhere(scope, "e", true);
    const today = new Date().toISOString().slice(0, 10);
    const dateIdx = values.length + 1;
    values.push(today);
    const rows = await query(
      `select e.pk_employee_id, e.full_name
       from hr_employee e
       where ${whereSql}
         and not exists (
           select 1 from attendance_record a
           where a.fk_employee_id = e.pk_employee_id
             and a.attendance_date = $${dateIdx}
         )
       order by e.full_name`,
      values
    );
    return rows.rows;
  }

  /**
   * Live presence proxy.
   * @param {{scope:any}} params
   */
  async getLivePresence({ scope }) {
    return this.getCurrentOccupancy({ scope });
  }

  /**
   * Floor occupancy placeholder.
   * @param {{scope:any}} params
   */
  async getFloorOccupancy({ scope }) {
    return [];
  }

  /**
   * Area counts placeholder.
   * @param {{scope:any}} params
   */
  async getAreaCounts({ scope }) {
    return [];
  }

  /**
   * Heatmap density data for the last 30 days.
   * @param {{scope:any}} params
   */
  async getHeatmapData({ scope }) {
    const { whereSql, values } = buildScopeWhere(scope, "");
    
    const dateLimitIdx = values.length + 1;
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    values.push(thirtyDaysAgo.toISOString().slice(0, 10));

    const rows = await query(
      `SELECT
         to_char(attendance_date, 'YYYY-MM-DD') as date,
         count(*)::int as present,
         count(*) FILTER (WHERE check_out IS NOT NULL)::int as checked_out
       FROM attendance_record
       WHERE ${whereSql}
         AND attendance_date >= $${dateLimitIdx}::date
         AND check_in IS NOT NULL
       GROUP BY attendance_date
       ORDER BY attendance_date ASC`,
      values
    );
    return rows.rows;
  }

  /**
   * Peak hours computation (by hour bins).
   * @param {{scope:any, fromDate:string, toDate:string}} params
   */
  async getPeakHours({ scope, fromDate, toDate }) {
    const { whereSql, values } = buildScopeWhere(scope, "");
    const fromIdx = values.length + 1;
    const toIdx = values.length + 2;
    values.push(fromDate, toDate);
    const rows = await query(
      `select extract(hour from check_in)::int as hour, count(*)::int as count
       from attendance_record
       where ${whereSql} and check_in is not null and attendance_date between $${fromIdx} and $${toIdx}
       group by 1
       order by 1`,
      values
    );
    return rows.rows;
  }

  /**
   * Average duration in office (check_out - check_in).
   * @param {{scope:any, fromDate:string, toDate:string}} params
   */
  async getAverageDuration({ scope, fromDate, toDate }) {
    const { whereSql, values } = buildScopeWhere(scope, "");
    const fromIdx = values.length + 1;
    const toIdx = values.length + 2;
    values.push(fromDate, toDate);
    const rows = await query(
      `select round(avg(extract(epoch from (check_out - check_in)))/3600.0, 2) as hours
       from attendance_record
       where ${whereSql} and check_in is not null and check_out is not null
         and attendance_date between $${fromIdx} and $${toIdx}`,
      values
    );
    return { hours: Number(rows.rows[0]?.hours || 0) };
    }

  /**
   * Employee ranking by presence days in range.
   * @param {{scope:any, fromDate:string, toDate:string, limit?:number}} params
   */
  async getEmployeeRanking({ scope, fromDate, toDate, limit = 20 }) {
    const { whereSql, values } = buildScopeWhere(scope, "a");
    const fromIdx = values.length + 1;
    const toIdx = values.length + 2;
    const limitIdx = values.length + 3;
    values.push(fromDate, toDate, limit);
    const rows = await query(
      `select e.full_name, count(*)::int as days
       from attendance_record a
       join hr_employee e on e.pk_employee_id = a.fk_employee_id
       where ${whereSql} and a.status in ('present','late') and a.attendance_date between $${fromIdx} and $${toIdx}
       group by e.full_name
       order by days desc, e.full_name
       limit $${limitIdx}`,
      values
    );
    return rows.rows;
  }
}

const dashboardService = new DashboardService();
export default dashboardService;

