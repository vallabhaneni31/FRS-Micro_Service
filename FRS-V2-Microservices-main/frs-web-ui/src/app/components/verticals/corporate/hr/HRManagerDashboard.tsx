import { getSiteTimezone } from '../../../../utils/timezone';
import { calculateAverageHoursMins } from '../../../../utils/attendanceUtils';
import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { useApiData } from '../../../../hooks/useApiData';
import { apiRequest } from '../../../../services/http/apiClient';
import { PageHeader } from '../../../shared/PageHeader';
import { Button } from '../../../ui/button';
import { cn } from '../../../ui/utils';
import {
  Users, RefreshCw, Loader2, AlertTriangle, AlertCircle
} from 'lucide-react';
import { ZoneHeatmap } from './ZoneHeatmap';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';

export const HRManagerDashboard: React.FC = () => {
  const navigate = useNavigate();
  const { accessToken, isAuthenticated } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const { employees, attendance, metrics, isLoading, error, refresh } = useApiData({ autoRefreshMs: 60000 });

  // ── States ──────────────────────────────────────────────────────────────────
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalDay, setModalDay] = useState('Thursday');
  const [trendView, setTrendView] = useState<'weekly' | 'monthly'>('monthly');

  // Monthly calendar data state
  const [monthlyData, setMonthlyData] = useState<any[]>([]);
  const [monthlyLoading, setMonthlyLoading] = useState(true);

  // Load Material Symbols dynamically for self-containment
  useEffect(() => {
    const link = document.createElement('link');
    link.href = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap';
    link.rel = 'stylesheet';
    document.head.appendChild(link);
    return () => {
      document.head.removeChild(link);
    };
  }, []);

  // ── Today's date calculations ───────────────────────────────────────────────
  const today = useMemo(() => {
    const tz = getSiteTimezone();
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  }, []);

  const todayRecords = useMemo(() => {
    return attendance.filter((a: any) => {
      if (!a.attendance_date) return false;
      const dateStr = a.attendance_date.includes('T')
        ? new Intl.DateTimeFormat('en-CA', { timeZone: getSiteTimezone() }).format(new Date(a.attendance_date))
        : a.attendance_date.slice(0, 10);
      return dateStr === today;
    });
  }, [attendance, today]);

  const activeEmps = useMemo(() => {
    return employees.filter((e: any) => {
      if (e.status !== 'active') return false;
      if (e.join_date) {
        const jd = e.join_date.includes('T') ? e.join_date.slice(0, 10) : e.join_date;
        if (jd > today) return false;
      }
      return true;
    });
  }, [employees, today]);

  // The today path LEFT JOINs ALL active employees — every employee appears in
  // todayRecords with status already computed by the backend:
  //   'present' / 'on-break' → checked in
  //   'late'                  → checked in after grace period (stored in DB)
  //   'absent'                → no attendance record, weekday
  //   'weekend'               → no record, weekend
  // The backend also returns is_late (boolean) for employees whose check_in
  // exceeds the shift grace period. Use that to split on-time vs late.
  const lateCount = useMemo(() => {
    return todayRecords.filter((r: any) => r.is_late === true || r.status === 'late').length;
  }, [todayRecords]);

  const presentCount = useMemo(() => {
    // Employees who are in (present/on-break) but NOT flagged late
    return todayRecords.filter((r: any) =>
      (r.status === 'present' || r.status === 'on-break') && !r.is_late
    ).length;
  }, [todayRecords]);

  // 'absent' is set by the backend for every active employee with no record today
  const absentCount = useMemo(() => {
    return todayRecords.filter((r: any) => r.status === 'absent').length;
  }, [todayRecords]);

  const totalActive = activeEmps.length || employees.length;

  // Percentage widths for status bar
  const onTimePct    = Math.min(100, totalActive > 0 ? Math.round((presentCount / totalActive) * 100) : 0);
  const latePct      = Math.min(100, totalActive > 0 ? Math.round((lateCount  / totalActive) * 100) : 0);
  const notInYetPct  = Math.min(100, totalActive > 0 ? Math.round((absentCount / totalActive) * 100) : 0);

  // Dynamic Metrics
  const calculatedAttendanceRate = totalActive > 0 ? Math.round(((presentCount + lateCount) / totalActive) * 100) : 0;
  const finalAttendanceRate = metrics?.attendanceRate ?? calculatedAttendanceRate;

  const calculatedPunctualityRate = (presentCount + lateCount) > 0 ? Math.round((presentCount / (presentCount + lateCount)) * 100) : 0;
  const finalPunctualityRate = metrics?.punctualityRate ?? calculatedPunctualityRate;

  const avgHoursFormatted = useMemo(() => {
    return calculateAverageHoursMins(attendance, true);
  }, [attendance]);

  const currentlyIn = todayRecords.filter((r: any) => r.status === 'present' || r.status === 'on-break').length || presentCount;

  // ── Monthly Calendar Fetch ──────────────────────────────────────────────────
  useEffect(() => {
    if (!isAuthenticated) return;
    let isMounted = true;

    const fetchMonthlyTrend = async () => {
      setMonthlyLoading(true);
      try {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const tz = getSiteTimezone();
        const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);

        const res = await apiRequest<{ data: any[] }>(
          `/live/calendar?year=${year}&month=${month}`,
          { accessToken, scopeHeaders }
        );

        if (isMounted && res?.data) {
          const points = [];
          for (const d of res.data) {
            if (d.date_str > todayStr) break;
            points.push({
              day: d.date_str.slice(8, 10),
              date: d.date_str,
              rate: Number(d.rate) || 0,
              present: Number(d.present) || 0,
              total: Number(d.total) || 0,
            });
          }
          setMonthlyData(points);
        }
      } catch (err) {
        console.error("Failed to fetch monthly trend", err);
      } finally {
        if (isMounted) setMonthlyLoading(false);
      }
    };

    fetchMonthlyTrend();
    const timer = setInterval(fetchMonthlyTrend, 60000);
    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, [accessToken, isAuthenticated, scopeHeaders]);

  const avgMonthlyAttendance = useMemo(() => {
    return monthlyData.length ? Math.round(monthlyData.reduce((s, d) => s + d.rate, 0) / monthlyData.length) : 0;
  }, [monthlyData]);

  const peakHour = useMemo(() => {
    const hourlyCounts: Record<number, number> = {};
    todayRecords.forEach((r: any) => {
      const tz = getSiteTimezone();
      // Use all_check_ins array (multiple punches per day) if available
      const checkIns: Array<{ time: string }> =
        (r.all_check_ins && r.all_check_ins.length > 0)
          ? r.all_check_ins
          : r.check_in
            ? [{ time: r.check_in }]
            : [];
      checkIns.forEach(ci => {
        const h = Number(
          new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false })
            .format(new Date(ci.time))
        );
        hourlyCounts[h] = (hourlyCounts[h] || 0) + 1;
      });
    });
    const entries = Object.entries(hourlyCounts);
    if (!entries.length) return null;
    const [peakH] = entries.sort((a, b) => Number(b[1]) - Number(a[1]))[0];
    const h = Number(peakH);
    return `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00`;
  }, [todayRecords]);


  // ── Daily Traffic calculations ──────────────────────────────────────────────
  const dailyTraffic = useMemo(() => {
    const daysToRender = ['Mon', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const todayObj = new Date();
    const currentDayIdx = todayObj.getDay();
    const mondayOffset = currentDayIdx === 0 ? -6 : 1 - currentDayIdx;

    return daysToRender.map(dayName => {
      let dayIdx = 1; // Mon
      if (dayName === 'Wed') dayIdx = 3;
      else if (dayName === 'Thu') dayIdx = 4;
      else if (dayName === 'Fri') dayIdx = 5;
      else if (dayName === 'Sat') dayIdx = 6;
      else if (dayName === 'Sun') dayIdx = 0;

      const targetDate = new Date(todayObj);
      targetDate.setDate(todayObj.getDate() + mondayOffset + (dayIdx === 0 ? 6 : dayIdx - 1));
      const dateStr = targetDate.toISOString().split('T')[0];

      const dayRecords = attendance.filter((a: any) => {
        if (!a.attendance_date) return false;
        return a.attendance_date.slice(0, 10) === dateStr;
      });

      const uniquePunches = new Set(dayRecords.map(r => String(r.fk_employee_id))).size;
      const isToday = dateStr === today;

      const count = uniquePunches;

      // Heights style — 0 count shows 0 height (no fake floor)
      const maxVal = Math.max(totalActive || 1, 1);
      const heightPct = Math.min(95, (count / maxVal) * 100);

      return {
        day: dayName,
        count,
        isToday,
        heightStyle: `${heightPct}%`
      };
    });
  }, [attendance, today]);

  // ── Weekly stacked charts data ──────────────────────────────────────────────
  const weeklyStackedData = useMemo(() => {
    const daysOfWeek = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const todayObj = new Date();
    const currentDayIdx = todayObj.getDay();
    const mondayOffset = currentDayIdx === 0 ? -6 : 1 - currentDayIdx;

    return daysOfWeek.map((dayName, idx) => {
      const targetDate = new Date(todayObj);
      targetDate.setDate(todayObj.getDate() + mondayOffset + idx);
      const dateStr = targetDate.toISOString().split('T')[0];

      const dayRecords = attendance.filter((a: any) => {
        if (!a.attendance_date) return false;
        return a.attendance_date.slice(0, 10) === dateStr;
      });

      const activeTotal = activeEmps.length || 0;
      const pCount = dayRecords.filter(r => (r.status === 'present' || r.status === 'on-break') && !r.is_late).length;
      const lCount = dayRecords.filter(r => r.status === 'late' || r.is_late === true).length;
      const aCount = Math.max(0, activeTotal - pCount - lCount);

      const isFuture = targetDate > todayObj;

      const presentRatio = isFuture || activeTotal === 0 ? 0 : (pCount / activeTotal) * 100;
      const lateRatio = isFuture || activeTotal === 0 ? 0 : (lCount / activeTotal) * 100;
      const absentRatio = isFuture || activeTotal === 0 ? 0 : (aCount / activeTotal) * 100;

      const isWeekend = dayName === 'Sat' || dayName === 'Sun';

      return {
        day: dayName,
        present: Math.round(presentRatio),
        late: Math.round(lateRatio),
        absent: Math.round(absentRatio),
        isWeekend,
        isFuture
      };
    });
  }, [attendance, activeEmps, today]);

  // ── Department Breakdown calculations ───────────────────────────────────────
  const deptBreakdown = useMemo(() => {
    if (employees.length === 0) return [];

    const deptMap: Record<string, { present: number; late: number; absent: number; total: number }> = {};

    activeEmps.forEach(emp => {
      const deptName = emp.department_name || 'General';
      if (!deptMap[deptName]) {
        deptMap[deptName] = { present: 0, late: 0, absent: 0, total: 0 };
      }
      deptMap[deptName].total += 1;

      const record = todayRecords.find(r => String(r.fk_employee_id) === String(emp.pk_employee_id));
      if (record) {
        if (record.is_late === true || record.status === 'late') {
          deptMap[deptName].late += 1;
        } else if (record.status === 'present' || record.status === 'on-break') {
          deptMap[deptName].present += 1;
        } else {
          deptMap[deptName].absent += 1;
        }
      } else {
        deptMap[deptName].absent += 1;
      }
    });

    return Object.entries(deptMap).map(([name, counts]) => {
      const total = counts.total;
      return {
        name,
        present: total > 0 ? Math.round((counts.present / total) * 100) : 0,
        late: total > 0 ? Math.round((counts.late / total) * 100) : 0,
        absent: total > 0 ? Math.round((counts.absent / total) * 100) : 0,
        count: total
      };
    }).sort((a, b) => b.count - a.count);
  }, [employees, activeEmps, todayRecords]);

  // ── Face Enrollment stats ───────────────────────────────────────────────────
  const faceEnrollment = useMemo(() => {
    if (employees.length === 0) {
      return { percent: 0, enrolledCount: 0, pendingCount: 0 };
    }
    const enrolled = employees.filter(e => e.face_enrolled).length;
    const total = employees.length;
    const pending = Math.max(0, total - enrolled);
    const percent = total > 0 ? Math.round((enrolled / total) * 100) : 0;
    return { percent, enrolledCount: enrolled, pendingCount: pending };
  }, [employees]);

  // Keyboard and click listener to dismiss modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="space-y-6 pb-12">
      {/* Scope Style overrides for custom elements, using the client theme colors */}
      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar {
            height: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
            background: rgba(0,0,0,0.05);
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
            background: rgba(0,0,0,0.15);
            border-radius: 10px;
        }
        .dark .custom-scrollbar::-webkit-scrollbar-track {
            background: rgba(255,255,255,0.03);
        }
        .dark .custom-scrollbar::-webkit-scrollbar-thumb {
            background: rgba(255,255,255,0.1);
        }
      `}} />

      {/* ── Header ── */}
      <PageHeader
        title="HR Overview"
        icon={Users}
        actions={
          <Button variant="outline" size="sm" onClick={() => refresh()} disabled={isLoading}
            className="gap-2 rounded-xl h-9">
            <RefreshCw className={cn("w-4 h-4", isLoading && "animate-spin")} />
            Refresh
          </Button>
        }
      />

      {/* ── Error Banner ── */}
      {error && (
        <div className="bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 px-4 py-3 rounded-2xl flex items-center justify-between gap-3 text-xs font-semibold">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0" />
            <span>{error}</span>
          </div>
          <Button variant="outline" size="sm" onClick={() => refresh()} className="h-7 text-xs border-rose-500/30 hover:bg-rose-500/20 gap-1.5">
            <RefreshCw className="w-3 h-3" />
            Retry
          </Button>
        </div>
      )}

      {isLoading && (
        <div className="w-full h-1 bg-primary/10 overflow-hidden rounded-full relative">
          <style>{`
            @keyframes loadingBar {
              0% { left: -30%; width: 30%; }
              50% { left: 30%; width: 40%; }
              100% { left: 100%; width: 30%; }
            }
          `}</style>
          <div
            className="absolute top-0 bottom-0 bg-primary rounded-full"
            style={{ animation: 'loadingBar 1.5s infinite linear' }}
          />
        </div>
      )}

      {/* Visitor Detail Modal */}
      {isModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 dark:bg-slate-950/60 backdrop-blur-sm p-4 transition-all"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsModalOpen(false);
          }}
        >
          <div className="glass-card w-full max-w-4xl bg-card border border-slate-200/80 dark:border-white/10 shadow-2xl rounded-2xl overflow-hidden transition-all">
            <div className="p-4 border-b border-slate-100 dark:border-white/10 flex items-center justify-between bg-muted/30">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-primary text-xl leading-none">analytics</span>
                <div>
                  <h4 className="text-sm font-extrabold text-slate-800 dark:text-slate-100 leading-none">Hourly Visitor Flow: {modalDay}</h4>
                  <p className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mt-1">Detailed Breakdown</p>
                </div>
              </div>
              <button
                className="p-1 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-full transition-colors flex items-center justify-center text-slate-400 dark:text-slate-500"
                onClick={() => setIsModalOpen(false)}
              >
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>
            <div className="p-6">
              <div className="h-[280px] flex items-end justify-between gap-1 relative">
                <div className="absolute bottom-1 left-6 right-6 flex justify-between text-[10px] font-bold text-slate-400 dark:text-slate-500">
                  <span>08:00</span><span>12:00</span><span>16:00</span><span>20:00</span>
                </div>
                <div className="w-full h-full pb-6">
                  <svg className="w-full h-full" preserveAspectRatio="none" viewBox="0 0 100 100">
                    <line stroke="rgba(148, 163, 184, 0.2)" strokeDasharray="2,2" x1="0" x2="100" y1="20" y2="20"></line>
                    <line stroke="rgba(148, 163, 184, 0.2)" strokeDasharray="2,2" x1="0" x2="100" y1="50" y2="50"></line>
                    <line stroke="rgba(148, 163, 184, 0.2)" strokeDasharray="2,2" x1="0" x2="100" y1="80" y2="80"></line>
                    <path d="M0 80 L 10 70 L 20 75 L 30 40 L 40 20 L 50 35 L 60 45 L 70 65 L 80 75 L 90 78 L 100 80 V 100 H 0 Z" fill="color-mix(in srgb, var(--primary) 12%, transparent)"></path>
                    <path d="M0 80 L 10 70 L 20 75 L 30 40 L 40 20 L 50 35 L 60 45 L 70 65 L 80 75 L 90 78 L 100 80" fill="none" stroke="var(--primary)" strokeWidth="2.5"></path>
                    <circle cx="40" cy="20" fill="var(--primary)" r="3"></circle>
                  </svg>
                </div>
              </div>
              <div className="mt-6 flex items-center justify-between px-1 border-t border-slate-100 dark:border-white/10 pt-4 flex-wrap gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Density Scale</span>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 bg-primary/10 rounded-sm"></div>
                      <span className="text-[9px] font-bold text-slate-500 dark:text-slate-400">Min</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 bg-primary/40 rounded-sm"></div>
                      <span className="text-[9px] font-bold text-slate-500 dark:text-slate-400">Low</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 bg-primary/70 rounded-sm"></div>
                      <span className="text-[9px] font-bold text-slate-500 dark:text-slate-400">Med</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 bg-primary rounded-sm"></div>
                      <span className="text-[9px] font-bold text-slate-500 dark:text-slate-400">High</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main Dashboard Grid */}
      <div className={cn("grid grid-cols-1 lg:grid-cols-3 gap-6 transition-opacity duration-300", isLoading && "opacity-60 pointer-events-none")}>
        
        {/* SECTION 1: GLOBAL STATUS & KPIs */}
        <div className="lg:col-span-1 flex flex-col gap-6">
          {/* Global Status Card */}
          <div 
            onClick={() => navigate('/dashboard/attendance')}
            className="glass-card rounded-2xl border border-slate-200/60 dark:border-white/10 shadow-sm overflow-hidden flex flex-col bg-card cursor-pointer hover:border-primary/50 transition-colors"
          >
            <div className="flex flex-col items-center text-center space-y-2 border-b border-slate-100 dark:border-white/10 p-5">
              <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Global Status</span>
              <h2 className="text-4xl font-extrabold text-slate-800 dark:text-white leading-tight">{totalActive}</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-semibold">Total Employees</p>
            </div>
            
            {error ? (
              <div className="bg-slate-50/40 dark:bg-slate-900/20 flex-1 p-5 flex flex-col items-center justify-center text-center gap-2">
                <AlertCircle className="w-6 h-6 text-rose-500/80" />
                <p className="text-xs font-semibold text-rose-500">{error}</p>
                <p className="text-[10px] text-slate-400">Attendance service is currently unavailable</p>
              </div>
            ) : (
              <div className="bg-slate-50/40 dark:bg-slate-900/20 flex-1 p-5">
                <div className="grid grid-cols-3 divide-x divide-slate-100 dark:divide-white/10 mb-4">
                  <div 
                    className="flex flex-col items-center gap-1 px-0.5 sm:px-2 hover:bg-slate-50 dark:hover:bg-slate-800/50 rounded-lg py-1 cursor-pointer transition-colors"
                    onClick={(e) => { e.stopPropagation(); navigate('/dashboard/attendance?status=Present'); }}
                  >
                    <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0"></span>
                      <span className="text-[9px] font-bold uppercase tracking-wide">On Time</span>
                    </div>
                    <span className="text-2xl font-black text-slate-800 dark:text-white leading-none tabular-nums">{presentCount}</span>
                  </div>

                  <div 
                    className="flex flex-col items-center gap-1 px-0.5 sm:px-2 hover:bg-slate-50 dark:hover:bg-slate-800/50 rounded-lg py-1 cursor-pointer transition-colors"
                    onClick={(e) => { e.stopPropagation(); navigate('/dashboard/attendance?status=Late'); }}
                  >
                    <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
                      <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0"></span>
                      <span className="text-[9px] font-bold uppercase tracking-wide">Late</span>
                    </div>
                    <span className="text-2xl font-black text-slate-800 dark:text-white leading-none tabular-nums">{lateCount}</span>
                  </div>

                  <div 
                    className="flex flex-col items-center gap-1 px-0.5 sm:px-2 hover:bg-slate-50 dark:hover:bg-slate-800/50 rounded-lg py-1 cursor-pointer transition-colors"
                    onClick={(e) => { e.stopPropagation(); navigate('/dashboard/attendance?status=Absent'); }}
                  >
                    <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
                      <span className="w-2 h-2 rounded-full bg-rose-500 shrink-0"></span>
                      <span className="text-[9px] font-bold uppercase tracking-wide">Not In Yet</span>
                    </div>
                    <span className="text-2xl font-black text-slate-800 dark:text-white leading-none tabular-nums">{absentCount}</span>
                  </div>
                </div>

                {/* Single unified progress bar */}
                <div className="h-2 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden flex">
                  <div className="h-full bg-emerald-500 transition-all duration-500" style={{ width: `${onTimePct}%` }} title={`On time: ${onTimePct}%`} />
                  <div className="h-full bg-amber-400 transition-all duration-500"  style={{ width: `${latePct}%` }}   title={`Late: ${latePct}%`} />
                  <div className="h-full bg-rose-400 transition-all duration-500"   style={{ width: `${notInYetPct}%` }} title={`Not in: ${notInYetPct}%`} />
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-[9px] text-slate-400 font-semibold">{onTimePct + latePct}% in office</span>
                  <span className="text-[9px] text-slate-400 font-semibold">{notInYetPct}% absent</span>
                </div>
              </div>
            )}
          </div>

          {/* Consolidated Metrics */}
          <div className="glass-card rounded-2xl border border-slate-200/60 dark:border-white/10 shadow-sm overflow-hidden divide-y divide-slate-100 dark:divide-white/10 bg-card">
            <div className="flex justify-between items-center py-3.5 px-5">
              <span className="text-[11px] text-slate-400 dark:text-slate-500 uppercase font-bold tracking-wider">Attendance</span>
              {error ? (
                <span className="text-xs font-bold text-rose-500 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" /> N/A
                </span>
              ) : (
                <span className="text-xl font-black text-slate-800 dark:text-white">{finalAttendanceRate}%</span>
              )}
            </div>
            <div className="flex justify-between items-center py-3.5 px-5">
              <span className="text-[11px] text-slate-400 dark:text-slate-500 uppercase font-bold tracking-wider">Avg Hours</span>
              {error ? (
                <span className="text-xs font-bold text-rose-500 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" /> N/A
                </span>
              ) : (
                <span className="text-xl font-black text-slate-800 dark:text-white">{avgHoursFormatted}</span>
              )}
            </div>
          </div>

          {/* Face Enrollment Status */}
          <div className="glass-card rounded-2xl border border-slate-200/60 dark:border-white/10 shadow-sm p-5 bg-card flex flex-col justify-between flex-1">
            <div>
              <h4 className="text-[10px] font-extrabold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-3">Face Enrollment Status</h4>
              <div className="flex items-baseline gap-1.5 mb-2 mt-1">
                <span className="text-4xl font-black text-slate-800 dark:text-white leading-none">{faceEnrollment.percent}%</span>
                <span className="text-[10px] font-extrabold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Enrolled</span>
              </div>
              
              <div className="w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden mb-4">
                <div className="h-full bg-primary" style={{ width: `${faceEnrollment.percent}%` }}></div>
              </div>
            </div>

            <div className="flex justify-between items-center text-[10px] font-bold border-t border-slate-100 dark:border-white/5 pt-3">
              <div className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <span className="material-symbols-outlined text-sm leading-none">check_circle</span>
                <span>{faceEnrollment.enrolledCount} Enrolled</span>
              </div>
              {faceEnrollment.pendingCount > 0 && (
                <div className="flex items-center gap-1 text-rose-500">
                  <span className="material-symbols-outlined text-sm leading-none">warning</span>
                  <span>{faceEnrollment.pendingCount} Pending</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* SECTION 2: VISITOR ANALYTICS & REGIONAL HEATMAP */}
        <div className="lg:col-span-2 flex flex-col gap-6">
          <div className="grid grid-cols-1 gap-6">

            <div className="grid grid-cols-2 gap-4">
              <div className="glass-card p-4 rounded-2xl border border-slate-200/60 dark:border-white/10 shadow-sm flex flex-col gap-1 bg-slate-50/50 dark:bg-slate-900/40">
                <span className="text-[9px] text-slate-400 dark:text-slate-500 uppercase font-bold tracking-wider">Peak Check-in Hour</span>
                <div className="flex items-baseline justify-between mt-1">
                  {error ? (
                    <span className="text-xs font-bold text-rose-500 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> N/A</span>
                  ) : peakHour ? (
                    <>
                      <span className="text-sm font-extrabold text-slate-800 dark:text-white">{peakHour}</span>
                      <div className="flex items-center gap-1.5 px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/20 rounded-full text-emerald-600 dark:text-emerald-400 text-[8px] font-bold">
                        <span className="w-1 h-1 rounded-full bg-emerald-500"></span>
                        <span>TODAY</span>
                      </div>
                    </>
                  ) : (
                    <span className="text-sm font-semibold text-slate-400 dark:text-slate-500">No data yet</span>
                  )}
                </div>
              </div>
            </div>

          </div>

          {/* Regional Heatmap — zone × hour grid — full-width row for consistent tile alignment */}
          <div className="flex-1 flex flex-col [&>*]:flex-1">
            <ZoneHeatmap title="Zone Activity · Today" bizHoursOnly />
          </div>

        </div>

      </div>

      {/* SECTION 2: INTEGRATED TREND ANALYTICS */}
      <div className="glass-card rounded-2xl border border-slate-200/60 dark:border-white/10 shadow-sm p-5 bg-card">
        <div className="flex justify-between items-start mb-6 flex-wrap gap-4">
          <div>
            <h3 className="text-sm font-extrabold text-slate-800 dark:text-slate-100">
              {trendView === 'weekly' ? 'Weekly Attendance Trend' : `Monthly Trend — ${new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`}
            </h3>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
              {trendView === 'weekly' ? 'Current Week Attendance Breakdown' : `Avg ${avgMonthlyAttendance}% · Target 90%`}
            </p>
          </div>
          <div className="flex items-center gap-4">
            {trendView === 'monthly' && (
              <div className={cn(
                "text-[9px] font-bold px-2 py-0.5 rounded-full border uppercase tracking-wider",
                avgMonthlyAttendance >= 90
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                  : "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20"
              )}>
                {avgMonthlyAttendance >= 90 ? 'On track' : 'Below target'}
              </div>
            )}
            <div className="flex bg-slate-50 dark:bg-slate-900 rounded-lg p-1 border border-slate-200 dark:border-slate-800">
              <button
                className={cn(
                  "px-3.5 py-1.5 text-[10px] font-bold rounded-md transition-all",
                  trendView === 'weekly' ? "bg-card text-primary shadow-sm" : "text-slate-400 dark:text-slate-500 hover:text-slate-300"
                )}
                onClick={() => setTrendView('weekly')}
              >
                Weekly
              </button>
              <button
                className={cn(
                  "px-3.5 py-1.5 text-[10px] font-bold rounded-md transition-all",
                  trendView === 'monthly' ? "bg-card text-primary shadow-sm" : "text-slate-400 dark:text-slate-500 hover:text-slate-300"
                )}
                onClick={() => setTrendView('monthly')}
              >
                Monthly
              </button>
            </div>
          </div>
        </div>

        {/* Weekly View */}
        {trendView === 'weekly' && (
          <div>
            <div className="flex h-[200px]">
              <div className="flex flex-col justify-between text-[9px] font-extrabold text-slate-400 dark:text-slate-500 pr-3 h-full pb-6">
                <span>100%</span><span>75%</span><span>50%</span><span>25%</span><span>0%</span>
              </div>
              <div className="flex-1 flex flex-col h-full">
                <div className="flex-1 flex items-end gap-3 pb-6 relative border-l border-b border-slate-100 dark:border-white/10">
                  <div className="absolute inset-0 flex flex-col justify-between pointer-events-none pb-6">
                    <div className="w-full h-px border-t border-slate-100 dark:border-white/5"></div>
                    <div className="w-full h-px border-t border-slate-100 dark:border-white/5"></div>
                    <div className="w-full h-px border-t border-slate-100 dark:border-white/5"></div>
                    <div className="w-full h-px border-t border-slate-100 dark:border-white/5"></div>
                  </div>

                  {weeklyStackedData.map((d) => (
                    <div key={d.day} className="flex-1 flex flex-col items-center group relative h-full justify-end">
                      <div className={cn("flex flex-col justify-end w-full max-w-[20px] h-full rounded-t overflow-hidden bg-slate-100/50 dark:bg-slate-900/10", d.isFuture && "opacity-25", d.isWeekend && "opacity-75")}>
                        {d.absent > 0 && <div className="bg-rose-500" style={{ height: `${d.absent}%` }} title={`Absent: ${d.absent}%`}></div>}
                        {d.late > 0 && <div className="bg-amber-500" style={{ height: `${d.late}%` }} title={`Late: ${d.late}%`}></div>}
                        {d.present > 0 && <div className="bg-emerald-500" style={{ height: `${d.present}%` }} title={`Present: ${d.present}%`}></div>}
                      </div>
                      <span className="absolute -bottom-6 text-[10px] text-slate-400 dark:text-slate-500 font-bold">{d.day}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            
            <div className="flex justify-center gap-6 mt-6 border-t border-slate-100 dark:border-white/5 pt-4">
              <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-emerald-500 rounded-sm"></span><span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase">Present</span></div>
              <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-amber-500 rounded-sm"></span><span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase">Late</span></div>
              <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-rose-500 rounded-sm"></span><span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase">Absent</span></div>
            </div>
          </div>
        )}

        {/* Monthly View */}
        {trendView === 'monthly' && (
          <div>
            <div className="h-[200px]">
              {monthlyLoading && monthlyData.length === 0 ? (
                <div className="flex items-center justify-center h-full text-slate-400 dark:text-slate-500 text-xs font-bold">
                  Loading trend data...
                </div>
              ) : monthlyData.length < 2 ? (
                <div className="flex items-center justify-center h-full text-slate-400 dark:text-slate-500 text-xs font-bold">
                  Not enough data for this month yet.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={monthlyData} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.08)" vertical={false} />
                    <XAxis
                      dataKey="day"
                      tick={{ fontSize: 9, fill: 'currentColor', opacity: 0.6, fontWeight: 'bold' }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      domain={[0, 100]}
                      tick={{ fontSize: 9, fill: 'currentColor', opacity: 0.6, fontWeight: 'bold' }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={v => `${v}%`}
                    />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload;
                        return (
                          <div className="bg-card border border-slate-100 dark:border-slate-800 rounded-xl shadow-lg px-3 py-2 text-xs text-foreground">
                            <p className="font-semibold text-slate-400 dark:text-slate-500 mb-1">Day {d.day}</p>
                            <p className="text-emerald-600 dark:text-emerald-400 font-extrabold">{d.rate}% attendance</p>
                            <p className="text-slate-500 dark:text-slate-400 font-semibold">{d.present} / {d.total} present</p>
                          </div>
                        );
                      }}
                    />
                    <ReferenceLine
                      y={90}
                      stroke="var(--primary)"
                      strokeDasharray="4 4"
                      strokeWidth={1.5}
                      label={{ value: 'Target 90%', position: 'insideTopRight', fontSize: 8, fill: 'var(--primary)', fontWeight: 'extrabold', opacity: 0.8 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="rate"
                      stroke="var(--primary)"
                      strokeWidth={2.5}
                      dot={false}
                      activeDot={{ r: 4, fill: 'var(--primary)' }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
            
            <div className="flex justify-center gap-8 border-t border-slate-100 dark:border-white/5 mt-6 pt-4">
              <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-primary"></span><span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase">Actual Attendance</span></div>
              <div className="flex items-center gap-2"><span className="w-6 h-px border-t border-dashed border-primary/50"></span><span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase">Target (90%)</span></div>
            </div>
          </div>
        )}

      </div>

      {/* SECTION 3: EMPLOYEE ANALYTICS & DEPT BREAKDOWN */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* Department Attendance Breakdown */}
        <div className="glass-card rounded-2xl border border-slate-200/60 dark:border-white/10 shadow-sm p-5 bg-card md:col-span-3">
          <div className="flex justify-between items-center mb-6">
            <div>
              <h4 className="text-xs font-extrabold text-slate-800 dark:text-slate-100 uppercase tracking-wider">Department Attendance Breakdown</h4>
              <p className="text-[9px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider mt-0.5">Today</p>
            </div>
          </div>

          {error ? (
            <div className="flex flex-col items-center justify-center h-[160px] gap-2 text-center text-rose-500">
              <AlertCircle className="w-6 h-6 text-rose-500/80" />
              <p className="text-[11px] font-bold text-rose-500">{error}</p>
            </div>
          ) : deptBreakdown.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-[160px] gap-2 text-center">
              <span className="material-symbols-outlined text-3xl text-slate-300 dark:text-slate-600">business</span>
              <p className="text-[11px] font-bold text-slate-400 dark:text-slate-500">No department data available</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto custom-scrollbar">
                <div className="min-w-[700px] h-[160px] flex items-end gap-5 pb-6 relative">
                  {deptBreakdown.map((dept) => (
                    <div key={dept.name} className="flex-1 flex flex-col items-center group relative h-full justify-end">
                      <div className="flex flex-col items-center mb-1 leading-none">
                        <span className="text-[10px] font-black text-slate-700 dark:text-slate-300">{dept.count}</span>
                      </div>
                      <div className="w-full max-w-[50px] flex flex-col justify-end h-full rounded bg-slate-50/50 dark:bg-slate-900/10 border border-slate-100 dark:border-white/5 overflow-hidden">
                        {dept.absent > 0 && <div className="bg-rose-500" style={{ height: `${dept.absent}%` }} title={`Absent: ${dept.absent}%`}></div>}
                        {dept.late > 0 && <div className="bg-amber-500" style={{ height: `${dept.late}%` }} title={`Late: ${dept.late}%`}></div>}
                        {dept.present > 0 && <div className="bg-emerald-500" style={{ height: `${dept.present}%` }} title={`Present: ${dept.present}%`}></div>}
                      </div>
                      <span className="absolute -bottom-5 text-[9px] font-bold text-slate-400 dark:text-slate-500 text-center truncate w-full" title={dept.name}>
                        {dept.name}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex justify-center gap-5 mt-6 border-t border-slate-100 dark:border-white/5 pt-4">
                <div className="flex items-center gap-1.5"><span className="w-2 h-2 bg-emerald-500 rounded-sm"></span><span className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase">Present</span></div>
                <div className="flex items-center gap-1.5"><span className="w-2 h-2 bg-amber-500 rounded-sm"></span><span className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase">Late</span></div>
                <div className="flex items-center gap-1.5"><span className="w-2 h-2 bg-rose-500 rounded-sm"></span><span className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase">Absent</span></div>
              </div>
            </>
          )}
        </div>



      </div>

    </div>
  );
};
