import { getSiteTimezone } from '../utils/timezone';
import { useMemo } from 'react';

export type AnomalyKind = 'frequent_late' | 'consecutive_absent';

export interface AttendanceAnomaly {
  employeeId: string;
  employeeName: string;
  kind: AnomalyKind;
  detail: string;
}

function getLast7Days(): string[] {
  const tz = getSiteTimezone();
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const today = new Date(todayStr + 'T12:00:00');

  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (6 - i));
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  });
}

export function useAttendanceAnomalies(
  attendance: any[],
  employees: any[],
): AttendanceAnomaly[] {
  return useMemo(() => {
    const days = getLast7Days();
    const daySet = new Set(days);
    const anomalies: AttendanceAnomaly[] = [];

    // Index: employeeId → name
    const nameMap = new Map<string, string>();
    employees.forEach(e => nameMap.set(String(e.pk_employee_id), e.full_name));

    // Index: employeeId → Map<date, status>
    const recordMap = new Map<string, Map<string, string>>();
    const tz = getSiteTimezone();
    attendance.forEach(r => {
      if (!r.attendance_date) return;
      const day = r.attendance_date.includes('T')
        ? new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(r.attendance_date))
        : r.attendance_date.slice(0, 10);
      if (!day || !daySet.has(day)) return;
      const empId = String(r.fk_employee_id);
      if (!recordMap.has(empId)) recordMap.set(empId, new Map());
      recordMap.get(empId)!.set(day, r.status ?? 'present');
    });

    const activeIds = employees
      .filter(e => e.status === 'active')
      .map(e => String(e.pk_employee_id));

    for (const empId of activeIds) {
      const name = nameMap.get(empId) ?? empId;
      const dayMap = recordMap.get(empId) ?? new Map<string, string>();

      // ── Rule 1: ≥3 late arrivals in last 7 days
      const lateCount = days.filter(d => dayMap.get(d) === 'late').length;
      if (lateCount >= 3) {
        anomalies.push({
          employeeId: empId,
          employeeName: name,
          kind: 'frequent_late',
          detail: `${lateCount} late arrivals in last 7 days`,
        });
      }

      // ── Rule 2: ≥2 consecutive absent days
      let streak = 0;
      let maxStreak = 0;
      for (const day of days) {
        const status = dayMap.get(day);
        const isAbsent = !status || status === 'absent';
        streak = isAbsent ? streak + 1 : 0;
        maxStreak = Math.max(maxStreak, streak);
      }
      if (maxStreak >= 2) {
        anomalies.push({
          employeeId: empId,
          employeeName: name,
          kind: 'consecutive_absent',
          detail: `${maxStreak} consecutive absent days`,
        });
      }
    }

    return anomalies;
  }, [attendance, employees]);
}
