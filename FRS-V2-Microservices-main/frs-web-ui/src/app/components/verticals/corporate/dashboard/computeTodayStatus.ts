import { getSiteTimezone } from '../../../../utils/timezone';
import type { LiveEmployee, LiveAttendanceRecord } from '../../../../hooks/useApiData';

export interface TodayStatus {
  presentCount: number;
  lateCount:    number;
  absentCount:  number;
  totalActive:  number;
}

/**
 * Derive today's present / late / absent / active-headcount from the raw live
 * employee + attendance lists, in the active site timezone.
 *
 * Extracted verbatim from the original HRManagerDashboard so every dashboard
 * widget computes the same numbers from the same (shared) data source instead
 * of each page re-deriving them. See DashboardDataContext for the shared fetch.
 */
export function computeTodayStatus(
  employees: LiveEmployee[],
  attendance: LiveAttendanceRecord[],
): TodayStatus {
  const tz = getSiteTimezone();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());

  const toDateStr = (d: string) =>
    d.includes('T')
      ? new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(d))
      : d.slice(0, 10);

  const todayRecords = attendance.filter(
    (a: any) => a.attendance_date && toDateStr(a.attendance_date) === today,
  );
  const attendedIds = new Set(
    todayRecords.map((r: any) => String(r.fk_employee_id || r.employee_id || r.id))
  );

  const activeEmps = (employees || []).filter((e: any) => {
    const st = (e.status || 'active').toLowerCase();
    if (st === 'terminated' || st === 'deleted') return false;
    return true;
  });

  const totalActive = activeEmps.length;
  const lateCount    = todayRecords.filter((r: any) => r.is_late || r.status === 'late').length;
  const totalAttended = attendedIds.size;
  const presentCount = Math.max(0, totalAttended - lateCount);
  const absentCount  = Math.max(0, totalActive - totalAttended);

  return { presentCount, lateCount, absentCount, totalActive };
}
