import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '../../../ui/sheet';
import { cn } from '../../../ui/utils';
import { UserCheck, Clock, UserX, CalendarDays, Loader2, X, Camera } from 'lucide-react';
import { useAuth } from '../../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { apiRequest } from '../../../../services/http/apiClient';
import { formatTimeInSiteTz } from '../../../../utils/timezone';
import { fetchAuthedPhotoBlobUrl } from '../../../../services/http/authedPhoto';

interface Props {
  /** Array of { date: 'YYYY-MM-DD', status: 'present'|'late'|'on-break'|'absent', checkInCount?: number, checkOutCount?: number, checkIn?: string, checkOut?: string } */
  records?: any[]; // Allow compatibility
  open: boolean;
  onClose: () => void;
  employeeId: string | null;
  employeeName: string | null;
  attendance: any[];
  /** 'YYYY-MM-DD' — when set, auto-opens that day's punch detail (with photos)
   *  as soon as history loads, instead of requiring a manual click on the
   *  heatmap. Used for deep-linking straight to a specific event, e.g. from
   *  a notification. */
  initialDate?: string | null;
}

// /uploads requires a Bearer token, so a plain <img src>/document.createElement
// approach would 401 — fetch it authenticated first and render the blob.
let isPhotoModalOpen = false;

const openPhotoModal = async (photoUrl: string) => {
  if (isPhotoModalOpen) return;
  isPhotoModalOpen = true;

  try {
    const src = (await fetchAuthedPhotoBlobUrl(photoUrl)) ?? photoUrl;

    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 z-[9999] flex items-center justify-center bg-slate-900/90 backdrop-blur-sm cursor-zoom-out transition-opacity duration-300';
    modal.style.pointerEvents = 'auto';
    // Prevent Radix UI's "click outside" from detecting clicks on this modal
    // which would otherwise close the parent sheet when the photo is closed.
    modal.onpointerdown = (e) => e.stopPropagation();
    modal.onmousedown = (e) => e.stopPropagation();

    const close = () => {
      if (document.body.contains(modal)) document.body.removeChild(modal);
      document.removeEventListener('keydown', onKey);
      isPhotoModalOpen = false;
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    modal.onclick = close;

    const img = document.createElement('img');
    img.src = src;
    // Device-capture photos are often small (a cropped face thumbnail) — set an
    // explicit width so they scale UP to fill the lightbox instead of rendering
    // at their tiny native size, with max-h as a secondary cap for tall images.
    img.className = 'w-[90vw] md:w-[60vw] max-w-[800px] h-auto max-h-[88vh] rounded-xl shadow-[0_0_50px_rgba(0,0,0,0.5)] border border-slate-700/50 object-contain cursor-default';
    img.onclick = (e) => e.stopPropagation();   // clicking the image keeps it open

    const closeBtn = document.createElement('button');
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.className = 'absolute top-4 right-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-3xl font-light leading-none text-white backdrop-blur transition-colors hover:bg-white/25';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = close;

    modal.append(img, closeBtn);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(modal);
  } catch (error) {
    isPhotoModalOpen = false;
    console.error('Failed to open photo modal', error);
  }
};

const STATUS_COLOR: Record<string, string> = {
  present:  'bg-emerald-500',
  'on-break': 'bg-blue-400',
  'late':     'bg-amber-400',
  'absent':   'bg-red-400',
  'weekly-off': 'bg-slate-100',
};

const STATUS_LABEL: Record<string, string> = {
  present:   'Present',
  'on-break': 'On Break',
  'late':      'Late',
  'absent':    'Absent',
  'weekly-off': 'Weekly Off',
};

function toLocalDateString(dateInput: string | Date): string {
  if (!dateInput) return '';
  const d = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (isNaN(d.getTime())) return typeof dateInput === 'string' ? dateInput.slice(0, 10) : '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const date = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${date}`;
}

// Default status for a day with no attendance record: weekends (Sat/Sun) are
// non-working days and must render as weekly-off, never absent.
function defaultStatusForDay(day: string): string {
  const dow = new Date(`${day}T00:00:00`).getDay();
  return dow === 0 || dow === 6 ? 'weekly-off' : 'absent';
}

function getLast30Days(): string[] {
  const days: string[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(toLocalDateString(d));
  }
  return days;
}

export const EmployeeHistoryDrawer: React.FC<Props> = ({
  open, onClose, employeeId, employeeName, attendance, initialDate,
}) => {
  const days = useMemo(() => getLast30Days(), []);
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<any | null>(null);
  const [timingFilter, setTimingFilter] = useState<'all' | 'check-ins' | 'check-outs'>('all');
  // Guards the auto-open-a-day effect below so it fires once per drawer
  // open, not on every re-render while it's open (which would otherwise snap
  // the user back to initialDate after they'd clicked a different day).
  const autoOpenedRef = useRef(false);

  const fetchHistory = useCallback(async () => {
    if (!employeeId) return;
    setLoading(true);
    setError(null);
    try {
      const today = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 29);
      const fromDate = toLocalDateString(start);
      const toDate = toLocalDateString(today);

      const res = await apiRequest<{ data: any[] }>(`/attendance/employee/${employeeId}?fromDate=${fromDate}&toDate=${toDate}`, {
        accessToken,
        scopeHeaders,
        noCache: true,
      });
      setHistory(res.data || []);
    } catch (err: any) {
      console.error('Failed to fetch employee attendance history:', err);
      setError(err?.message || 'Failed to load attendance history');
    } finally {
      setLoading(false);
    }
  }, [employeeId, accessToken, scopeHeaders]);

  useEffect(() => {
    if (!open || !employeeId) {
      setHistory([]);
      setError(null);
      autoOpenedRef.current = false;
      return;
    }
    fetchHistory();
  }, [open, employeeId, fetchHistory]);

  const { dayMap, presentCount, lateCount, absentCount, onBreakCount, checkInCount, checkOutCount } = useMemo(() => {
    const map = new Map<string, { status: string; checkIn: string; checkOut: string; checkInCount: number; checkOutCount: number; allCheckIns: string[]; allCheckOuts: string[] }>();
    if (!employeeId) return { dayMap: map, presentCount: 0, lateCount: 0, absentCount: 0, onBreakCount: 0, weeklyOffCount: 0, checkInCount: 0, checkOutCount: 0 };

    const sourceData = history.length > 0 ? history : attendance.filter(r => String(r.fk_employee_id || r.employeeId || r.id) === String(employeeId));

    sourceData.forEach(r => {
      const day = toLocalDateString(r.attendance_date);
      if (day) {
        const rawCheckIn = r.check_in ?? r.checkInTime;
        const rawCheckOut = r.check_out ?? r.check_out_time;
        
        const checkInTime = rawCheckIn ? (rawCheckIn.includes('T') || rawCheckIn.includes('-') ? formatTimeInSiteTz(rawCheckIn) : rawCheckIn) : '—';
        const checkOutTime = rawCheckOut ? (rawCheckOut.includes('T') || rawCheckOut.includes('-') ? formatTimeInSiteTz(rawCheckOut) : rawCheckOut) : (rawCheckIn && r.status !== 'absent' && r.status !== 'Absent' ? (day === toLocalDateString(new Date()) ? 'Active Session' : 'Not Checked Out') : '—');

        const isLateComputed = (r.is_late_computed ?? r.is_late) === true;
        const rawStatus = (r.status || '').toLowerCase();
        
        map.set(day, {
          status: (isLateComputed || rawStatus === 'late') ? 'late' : (rawStatus || 'present'),
          checkIn: checkInTime,
          checkOut: checkOutTime,
          checkInCount: r.check_in_count ?? r.inCount ?? (rawCheckIn ? 1 : 0),
          checkOutCount: r.check_out_count ?? r.outCount ?? (rawCheckOut ? 1 : 0),
          allCheckIns: r.all_check_ins ?? r.allCheckInsRaw ?? (rawCheckIn ? [rawCheckIn] : []),
          allCheckOuts: r.all_check_outs ?? r.allCheckOutsRaw ?? (rawCheckOut ? [rawCheckOut] : []),
        });
      }
    });

    let present = 0, late = 0, absent = 0, onBreak = 0, weeklyOff = 0;
    let checkInCount = 0, checkOutCount = 0;
    const todayStr = toLocalDateString(new Date());
    days.forEach(d => {
      const record = map.get(d);
      // For days with no record, treat weekends (Sat/Sun) as weekly-off rather
      // than absent so non-working days never inflate the Absent count. Days
      // returned by the API already carry an explicit 'weekly-off' status.
      const s = record?.status ?? defaultStatusForDay(d);
      if (s === 'present')  present++;
      else if (s === 'late') late++;
      else if (s === 'on-break') onBreak++;
      else if (s === 'weekly-off') weeklyOff++;
      else {
        // It's absent. Do not count today as absent since the person might still come in later.
        if (d !== todayStr) {
          absent++;
        }
      }

      if (record) {
        checkInCount += record.checkInCount;
        checkOutCount += record.checkOutCount;
      }
    });

    return { dayMap: map, presentCount: present, lateCount: late, absentCount: absent, onBreakCount: onBreak, weeklyOffCount: weeklyOff, checkInCount, checkOutCount };
  }, [history, attendance, employeeId, days]);



  const filteredTimings = useMemo(() => {
    if (!selectedDay) return [];
    
    const checkIns = (selectedDay.allCheckIns || []).map((t: any) => {
      const timeStr = typeof t === 'string' ? t : t?.time || '';
      const photoUrl = typeof t === 'string' ? null : t?.photo_url || null;
      const formatted = timeStr.includes('T') || timeStr.includes('-') ? formatTimeInSiteTz(timeStr) : timeStr;
      return { type: 'check-in', time: formatted, raw: timeStr, photoUrl };
    });
    const checkOuts = (selectedDay.allCheckOuts || []).map((t: any) => {
      const timeStr = typeof t === 'string' ? t : t?.time || '';
      const photoUrl = typeof t === 'string' ? null : t?.photo_url || null;
      const formatted = timeStr.includes('T') || timeStr.includes('-') ? formatTimeInSiteTz(timeStr) : timeStr;
      return { type: 'check-out', time: formatted, raw: timeStr, photoUrl };
    });
    
    const all = [...checkIns, ...checkOuts].sort((a, b) => a.time.localeCompare(b.time));
    
    if (timingFilter === 'check-ins') return checkIns;
    if (timingFilter === 'check-outs') return checkOuts;
    return all;
  }, [selectedDay, timingFilter]);

  // Group days into weeks (rows of 7)
  const weeks = useMemo(() => {
    const rows: string[][] = [];
    for (let i = 0; i < days.length; i += 7) {
      rows.push(days.slice(i, i + 7));
    }
    return rows;
  }, [days]);

  // Rate is computed over working days only (present + late + on-break + absent),
  // excluding weekly-off/non-working days from the denominator.
  const workingDays = presentCount + lateCount + onBreakCount + absentCount;
  const attendanceRate = workingDays > 0
    ? Math.round(((presentCount + lateCount + onBreakCount) / workingDays) * 100)
    : 0;

  return (
    <Sheet open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader className="pb-2">
          <SheetTitle className="text-lg font-black text-slate-800">{employeeName ?? '—'}</SheetTitle>
          <SheetDescription className="text-xs text-slate-400 flex items-center gap-1.5">
            <CalendarDays className="w-3.5 h-3.5" />
            Last 30 days attendance history
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 space-y-6 mt-2">
          {/* Summary stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { label: 'Present',  value: presentCount,  color: 'text-emerald-600', bg: 'bg-emerald-50',  icon: UserCheck },
              { label: 'Late',     value: lateCount,     color: 'text-amber-600',   bg: 'bg-amber-50',    icon: Clock },
              { label: 'Absent',   value: absentCount,   color: 'text-red-500',     bg: 'bg-red-50',      icon: UserX },
              { label: 'Rate',     value: `${attendanceRate}%`, color: 'text-blue-600', bg: 'bg-blue-50', icon: CalendarDays },
            ].map(({ label, value, color, bg, icon: Icon }) => (
              <div key={label} className={cn('rounded-xl p-3 flex flex-col items-center gap-1', bg)}>
                <Icon className={cn('w-4 h-4', color)} />
                <span className={cn('text-xl font-black', color)}>{value}</span>
                <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide">{label}</span>
              </div>
            ))}
          </div>

          {/* Punch Counts Summary */}
          <div className="bg-slate-50 dark:bg-slate-800/40 rounded-xl p-3 flex justify-around items-center border border-slate-100 text-xs">
            <div className="text-center">
              <span className="block text-slate-400 font-semibold uppercase tracking-wider text-[10px]">Total Check-Ins</span>
              <span className="text-lg font-black text-emerald-600">{checkInCount}</span>
            </div>
            <div className="h-8 w-px bg-slate-200" />
            <div className="text-center">
              <span className="block text-slate-400 font-semibold uppercase tracking-wider text-[10px]">Total Check-Outs</span>
              <span className="text-lg font-black text-blue-600">{checkOutCount}</span>
            </div>
          </div>

          {/* Heatmap grid */}
          <div>
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Daily Attendance Status</p>
            {loading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                <p className="text-xs text-rose-500 font-medium">{error}</p>
                <button
                  type="button"
                  onClick={() => fetchHistory()}
                  className="text-xs font-bold text-primary hover:underline"
                >
                  Retry
                </button>
              </div>
            ) : (
              <div className="space-y-1.5">
                {weeks.map((week, wi) => (
                  <div key={wi} className="flex gap-1.5">
                    {week.map(day => {
                      const record = dayMap.get(day);
                      const rawStatus = record?.status ?? defaultStatusForDay(day);
                      const isFuture = day > toLocalDateString(new Date());
                      const colorClass = isFuture ? 'bg-slate-100' : STATUS_COLOR[rawStatus] ?? 'bg-slate-200';
                      // Weekly-off/future cells use the light-grey (slate-100) background
                      // from the employee profile page, so their text must be slate — not
                      // white — to stay legible. All other statuses use white text.
                      const isLightCell = isFuture || rawStatus === 'weekly-off';
                      const cellText = isLightCell
                        ? { strong: 'text-slate-500', mid: 'text-slate-400', soft: 'text-slate-400' }
                        : { strong: 'text-white/90', mid: 'text-white/80', soft: 'text-white/70' };
                      
                      const todayStr = toLocalDateString(new Date());
                      let displayLabel = STATUS_LABEL[rawStatus] ?? rawStatus;
                      if (day === todayStr && rawStatus === 'absent') {
                        displayLabel = 'Not In Yet';
                      }
                      const label = isFuture ? '—' : displayLabel;
                      
                      const checkInInfo = record && record.checkIn !== '—' ? `\nFirst In: ${record.checkIn}` : '';
                      const checkOutInfo = record && record.checkOut !== '—' ? `\nLast Out: ${record.checkOut}` : '';
                      
                      const inCount = record ? record.checkInCount : 0;
                      const outCount = record ? record.checkOutCount : 0;
                      const tooltip = isFuture ? `${day}: Future` : `${day}: ${label}${checkInInfo}${checkOutInfo}\nTotal Punches: ${inCount} In / ${outCount} Out`;

                      const [, mm, dd] = day.split('-');
                      const weekdayName = new Date(day + 'T12:00:00').toLocaleString('default', { weekday: 'short' });
                      return (
                        <div
                          key={day}
                          title={`${weekdayName}, ${tooltip}`}
                          onClick={() => {
                            if (!isFuture) {
                              setTimingFilter('all');
                              setSelectedDay({
                                date: day,
                                status: rawStatus,
                                checkIn: record?.checkIn || '—',
                                checkOut: record?.checkOut || '—',
                                checkInCount: inCount,
                                checkOutCount: outCount,
                                allCheckIns: record?.allCheckIns || [],
                                allCheckOuts: record?.allCheckOuts || [],
                              });
                            }
                          }}
                          className={cn(
                            'flex-1 rounded-md flex flex-col items-center justify-center py-1.5 gap-0.5 cursor-pointer hover:scale-105 active:scale-95 transition-all',
                            isFuture ? 'opacity-30 cursor-default hover:scale-100' : '',
                            colorClass,
                          )}
                        >
                          <span className={cn('text-[8px] font-bold tracking-tight leading-none', cellText.mid)}>{weekdayName}</span>
                          <span className={cn('text-[9px] font-bold leading-none', cellText.strong)}>{dd}</span>
                          <span className={cn('text-[8px] leading-none', cellText.soft)}>{new Date(day + 'T12:00:00').toLocaleString('default', { month: 'short' })}</span>
                          {!isFuture && (
                            <span className={cn('text-[7px] font-bold tracking-tight leading-none mt-1 whitespace-nowrap', cellText.strong)}>
                              {inCount} In · {outCount} Out
                            </span>
                          )}
                        </div>
                      );
                    })}
                    {/* Pad last row if < 7 days */}
                    {week.length < 7 && Array.from({ length: 7 - week.length }).map((_, pi) => (
                      <div key={`pad-${pi}`} className="flex-1" />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Legend */}
          <div className="flex flex-wrap gap-3 text-xs text-slate-500">
            {Object.entries(STATUS_LABEL)
              .filter(([key]) => key !== 'on-break')
              .map(([key, label]) => (
                <span key={key} className="flex items-center gap-1.5">
                  <span className={cn('w-3 h-3 rounded-full inline-block border border-black', STATUS_COLOR[key])} />
                  {key === 'absent' ? 'Absent / Not In Yet' : label}
                </span>
              ))}
          </div>

          {/* Pop-up dialog overlay for daily details */}
          {selectedDay && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200" onClick={() => setSelectedDay(null)}>
              <div className="relative glass-card border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-2xl w-full max-w-sm max-h-[85vh] overflow-y-auto animate-in zoom-in-95 duration-200 flex flex-col" onClick={e => e.stopPropagation()}>
                <button
                  onClick={() => setSelectedDay(null)}
                  className="absolute top-4 right-4 p-1.5 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                >
                  <X className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                </button>

                <div className="flex items-center gap-3 border-b border-slate-100 dark:border-slate-800 pb-4 mb-4">
                  <div className="p-2 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 rounded-xl">
                    <CalendarDays className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="font-extrabold text-slate-800 dark:text-slate-100 text-sm">
                      {new Date(selectedDay.date + 'T12:00:00').toLocaleDateString('en-US', {
                        weekday: 'long',
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric'
                      })}
                    </h4>
                    <p className="text-[10px] text-slate-400 dark:text-slate-500 font-semibold tracking-wider uppercase mt-0.5">Punch details</p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-400 dark:text-slate-500 font-medium">Status:</span>
                    <span className={cn('px-2.5 py-0.5 rounded-full text-xxs font-extrabold tracking-wide uppercase border', 
                      selectedDay.status === 'present' && 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-200/20',
                      selectedDay.status === 'late' && 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-amber-200/20',
                      selectedDay.status === 'on-break' && 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300 border-blue-200/20',
                      selectedDay.status === 'absent' && 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300 border-rose-200/20',
                      selectedDay.status === 'weekly-off' && 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border-slate-200/20'
                    )}>
                      {selectedDay.date === toLocalDateString(new Date()) && selectedDay.status === 'absent' 
                        ? 'Not In Yet' 
                        : (STATUS_LABEL[selectedDay.status] ?? selectedDay.status)}
                    </span>
                  </div>

                  <div className="bg-slate-50 dark:bg-slate-800/40 rounded-xl p-3 flex justify-around items-center border border-slate-100 dark:border-slate-800/50 text-xs">
                    <div className="text-center">
                      <span className="block text-slate-400 font-semibold uppercase tracking-wider text-[9px] mb-1">Check-Ins</span>
                      <span className="text-lg font-black text-emerald-600 dark:text-emerald-400">{selectedDay.checkInCount}</span>
                    </div>
                    <div className="h-8 w-px bg-slate-200 dark:bg-slate-800" />
                    <div className="text-center">
                      <span className="block text-slate-400 font-semibold uppercase tracking-wider text-[9px] mb-1">Check-Outs</span>
                      <span className="text-lg font-black text-blue-600 dark:text-blue-400">{selectedDay.checkOutCount}</span>
                    </div>
                  </div>

                  {/* Filter Tabs for Timings */}
                  <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl text-xs">
                    {(['all', 'check-ins', 'check-outs'] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setTimingFilter(tab)}
                        className={cn(
                          'flex-1 py-1 rounded-lg font-bold transition-all capitalize',
                          timingFilter === tab
                            ? 'bg-white dark:bg-slate-700 shadow-sm text-slate-800 dark:text-white'
                            : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
                        )}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>

                  {/* Timings List */}
                  <div className="space-y-2 max-h-[160px] overflow-y-auto pt-1">
                    {filteredTimings.length === 0 ? (
                      <p className="text-center text-xs text-slate-400 py-4">No records found</p>
                    ) : (
                  filteredTimings.map((t: any, idx: number) => (
                        <div key={idx} className="flex justify-between items-center text-xs border-b border-slate-100 dark:border-slate-800 pb-2">
                          <span className="text-slate-400 dark:text-slate-500 font-medium flex items-center gap-1.5">
                            <Clock className="w-3.5 h-3.5 text-slate-350" />
                            <span className={cn(
                              'px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider',
                              t.type === 'check-in' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400' : 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400'
                            )}>
                              {t.type === 'check-in' ? 'In' : 'Out'}
                            </span>
                          </span>
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold text-slate-700 dark:text-slate-300">{t.time}</span>
                            {t.photoUrl && (
                              <button
                                type="button"
                                onClick={() => openPhotoModal(t.photoUrl)}
                                className="p-1 rounded bg-slate-50 hover:bg-indigo-50 hover:text-indigo-600 dark:bg-slate-800 dark:hover:bg-slate-750 transition-colors"
                                title="View punch event photo"
                              >
                                <Camera className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <button
                  onClick={() => setSelectedDay(null)}
                  className="mt-6 w-full py-2.5 bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:hover:bg-slate-200 dark:text-slate-900 text-white text-xs font-bold rounded-xl shadow-md transition-all active:scale-[0.98]"
                >
                  Close Details
                </button>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};
