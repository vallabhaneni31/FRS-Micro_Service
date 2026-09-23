import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X, Users, UserCheck, UserX, Clock, TrendingUp, Calendar, Loader2 } from 'lucide-react';
import { useAuth } from '../../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { apiRequest } from '../../../../services/http/apiClient';
import { cn } from '../../../ui/utils';
import { DeviceActivityHeatmap } from './DeviceActivityHeatmap';

interface DayData {
  date_str: string;
  present: number;
  late: number;
  early?: number;
  absent: number;
  total: number;
  rate: string;
}

interface CalendarProps {
  onDayClick?: (date: string, data: DayData | null) => void;
}

interface CalendarEvent {
  summary: string;
  time: string | null;
}

interface CalendarEventsData {
  holidays: Record<string, string>;
  events: Record<string, CalendarEvent[]>;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

// Minimal fallback holidays (only used if API fails completely)
const FALLBACK_HOLIDAYS: Record<string, string> = {
  '2026-01-01': 'New Year\'s Day',
  '2026-01-26': 'Republic Day',
  '2026-08-15': 'Independence Day',
  '2026-10-02': 'Gandhi Jayanti',
  '2026-12-25': 'Christmas',
};

// Client-side cache to avoid repeated requests
const eventCache: Record<string, CalendarEventsData> = {};

export default function AttendanceCalendar({ onDayClick }: CalendarProps) {
  const { accessToken , isAuthenticated } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [calData, setCalData] = useState<Record<string, DayData>>({});
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState<{ date: string; data: DayData | null } | null>(null);
  const [holidays, setHolidays] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<Record<string, CalendarEvent[]>>({});
  const [eventsLoading, setEventsLoading] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Fetch calendar data from backend
  const fetchCalendar = useCallback(async () => {
    if (!isAuthenticated) return;
    setLoading(true);
    try {
      const res = await apiRequest<{ data: DayData[] }>(
        `/live/calendar?year=${year}&month=${month}`,
        { accessToken, scopeHeaders }
      );
      const map: Record<string, DayData> = {};
      res.data.forEach(d => { map[d.date_str] = d; });
      setCalData(map);
    } catch { }
    setLoading(false);
  }, [accessToken, year, month]);

  useEffect(() => { fetchCalendar(); }, [fetchCalendar]);

  // Fetch holidays and events from backend API
  useEffect(() => {
    // Check client cache first
    const cacheKey = `${year}-${month}`;
    if (eventCache[cacheKey]) {
      setHolidays(eventCache[cacheKey].holidays);
      setEvents(eventCache[cacheKey].events);
      return;
    }

    const fetchEvents = async () => {
      if (!isAuthenticated) return;
      setEventsLoading(true);
      try {
        const res = await apiRequest<{ data: CalendarEventsData; year: number; month: number }>(
          `/live/events?year=${year}&month=${month}`,
          { accessToken, scopeHeaders }
        );

        const data = res.data || { holidays: {}, events: {} };

        // Cache the results client-side
        eventCache[cacheKey] = data;
        setHolidays(data.holidays || {});
        setEvents(data.events || {});
      } catch (error) {
        console.warn('Failed to fetch events:', error);
        // Fallback to static holidays for current year/month
        const fallbackForMonth: Record<string, string> = {};
        Object.entries(FALLBACK_HOLIDAYS).forEach(([date, name]) => {
          const fallbackDate = date.replace('2026', String(year));
          const monthStr = String(month).padStart(2, '0');
          if (fallbackDate.startsWith(`${year}-${monthStr}`)) {
            fallbackForMonth[fallbackDate] = name;
          }
        });
        setHolidays(fallbackForMonth);
        setEvents({});
      } finally {
        setEventsLoading(false);
      }
    };

    fetchEvents();
  }, [year, month, accessToken, scopeHeaders]);

  const prevMonth = () => {
    if (month === 1) { setYear(y => y - 1); setMonth(12); }
    else setMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (month === 12) { setYear(y => y + 1); setMonth(1); }
    else setMonth(m => m + 1);
  };

  // Build calendar grid
  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const todayStr = new Date().toISOString().slice(0, 10);

  const cells: (number | null)[] = [
    ...Array(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  // Pad to complete last row
  while (cells.length % 7 !== 0) cells.push(null);

  const getDayStr = (d: number) =>
    `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  const isWeekend = (d: number) => {
    const dow = new Date(year, month - 1, d).getDay();
    return dow === 0 || dow === 6;
  };

  const handleDayClick = (d: number) => {
    const dateStr = getDayStr(d);
    if (dateStr > todayStr) return;
    const data = calData[dateStr] || null;
    setSelectedDay({ date: dateStr, data });
    onDayClick?.(dateStr, data);
  };

  return (
    <div className="glass-card rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-blue-500" />
          <span className="font-semibold text-slate-900 dark:text-white text-sm">
            {MONTHS[month - 1]} {year}
          </span>
          {eventsLoading && (
            <span title="Loading calendar events...">
              <Loader2 className="w-3 h-3 text-slate-400 animate-spin" />
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={prevMonth} className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
            <ChevronLeft className="w-4 h-4 text-slate-500" />
          </button>
          <button onClick={nextMonth} className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
            <ChevronRight className="w-4 h-4 text-slate-500" />
          </button>
        </div>
      </div>

      {/* Weekday headers */}
      <div className="grid grid-cols-7 border-b border-slate-100 dark:border-slate-800">
        {WEEKDAYS.map(d => (
          <div key={d} className={cn(
            "text-center py-1.5 text-xs font-semibold",
            d === 'Sun' || d === 'Sat' ? 'text-rose-400' : 'text-slate-400 dark:text-slate-500'
          )}>
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="flex-1 grid grid-cols-7 auto-rows-fr">
        {cells.map((d, i) => {
          if (!d) return <div key={`empty-${i}`} className="border-b border-r border-slate-50 dark:border-slate-800/50" />;
          const dateStr = getDayStr(d);
          const data = calData[dateStr];
          const isToday = dateStr === todayStr;
          const isFuture = dateStr > todayStr;
          const isWknd = isWeekend(d);
          const holiday = holidays[dateStr];
          const dayEvents = events[dateStr] || [];
          const isSelected = selectedDay?.date === dateStr;
          const hasData = data && data.present > 0;
          const hasEventsOrHoliday = holiday || dayEvents.length > 0;

          return (
            <div
              key={dateStr}
              onClick={() => !isFuture && handleDayClick(d)}
              className={cn(
                "border-b border-r border-slate-50 dark:border-slate-800/50 p-1 transition-all duration-150 relative",
                isFuture ? "opacity-40 pointer-events-none cursor-not-allowed bg-slate-100/50 dark:bg-slate-900/30" : "cursor-pointer",
                isSelected ? "bg-blue-50 dark:bg-blue-900/30 ring-1 ring-inset ring-blue-400" : !isFuture ? "hover:bg-slate-50 dark:hover:bg-slate-800/50" : "",
                isWknd && !isSelected && !isFuture ? "bg-rose-50 dark:bg-rose-900/15 ring-1 ring-inset ring-rose-100 dark:ring-rose-900/30" : "",
                hasEventsOrHoliday && !isSelected && !isFuture ? "bg-amber-50 dark:bg-amber-900/10 ring-1 ring-inset ring-amber-200 dark:ring-amber-800/50" : "",
              )}
            >
              {/* Day number */}
              <div className={cn(
                "w-6 h-6 flex items-center justify-center rounded-full text-xs font-semibold mb-0.5",
                isToday ? "bg-blue-600 text-white" : isWknd ? "text-rose-400" : "text-slate-700 dark:text-slate-300"
              )}>
                {d}
              </div>

              {/* Holiday label */}
              {holiday && (
                <div className="text-[9px] leading-tight text-amber-700 dark:text-amber-300 font-bold truncate mb-0.5 bg-amber-100 dark:bg-amber-900/30 px-1 rounded">
                  🎊 {holiday}
                </div>
              )}

              {/* Day Events */}
              {dayEvents.map((evt, idx) => (
                <div key={idx} className="text-[9px] leading-tight text-violet-700 dark:text-violet-300 font-semibold truncate mb-0.5 bg-violet-100 dark:bg-violet-900/30 px-1 rounded">
                  📅 {evt.time ? `${evt.time} ` : ''}{evt.summary}
                </div>
              ))}

              {/* Loading indicator for events */}
              {eventsLoading && !hasEventsOrHoliday && i < 7 && (
                <div className="absolute top-0.5 right-0.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                </div>
              )}

              {/* Attendance data */}
              {hasData && !loading && (
                <div className="flex flex-col gap-0.5 mt-0.5">
                  <div className="flex items-center gap-0.5 flex-wrap">
                    <span className="inline-flex items-center px-1 py-0 rounded text-[9px] font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                      {data.present}P
                    </span>
                    {data.late > 0 && (
                      <span className="inline-flex items-center px-1 py-0 rounded text-[9px] font-bold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                        {data.late}L
                      </span>
                    )}

                    {data.absent > 0 && !holiday && !isWknd && (
                      <span className="inline-flex items-center px-1 py-0 rounded text-[9px] font-bold bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-400">
                        {data.absent}A
                      </span>
                    )}
                  </div>

                </div>
              )}

              {/* Weekend/no data indicator */}
              {!hasData && !isWknd && !holiday && !loading && dateStr <= todayStr && (
                <div className="text-[9px] text-slate-300 dark:text-slate-600">—</div>
              )}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 px-4 py-2 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
        <span className="flex items-center gap-1 text-[10px] text-slate-500"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block"/>Present</span>
        <span className="flex items-center gap-1 text-[10px] text-slate-500"><span className="w-2 h-2 rounded-full bg-amber-500 inline-block"/>Late</span>
        <span className="flex items-center gap-1 text-[10px] text-slate-500"><span className="w-2 h-2 rounded-full bg-rose-500 inline-block"/>Absent</span>
        <span className="flex items-center gap-1 text-[10px] text-slate-500"><span className="w-2 h-2 rounded-full bg-amber-100 border border-amber-300 inline-block"/>Holiday</span>
      </div>

      {/* Day detail popup */}
      {selectedDay && mounted && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setSelectedDay(null)}>
          <div
            className="glass-card rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-[min(94vw,720px)] max-h-[88vh] flex flex-col overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            {/* Popup header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
              <div>
                <p className="font-bold text-slate-900 dark:text-white">
                  {new Date(selectedDay.date + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                </p>
                {holidays[selectedDay.date] && (
                  <p className="text-xs text-amber-600 font-medium mt-0.5">🎊 {holidays[selectedDay.date]}</p>
                )}
                {events[selectedDay.date]?.map((evt, idx) => (
                  <p key={idx} className="text-xs text-violet-600 font-medium mt-0.5">📅 {evt.time ? `${evt.time} ` : ''}{evt.summary}</p>
                ))}
              </div>
              <button onClick={() => setSelectedDay(null)} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800">
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto">
            {/* Popup stats */}
            {(() => {
              const isWknd = new Date(selectedDay.date + 'T12:00:00').getDay() === 0 || new Date(selectedDay.date + 'T12:00:00').getDay() === 6;
              const isHoliday = !!holidays[selectedDay.date];
              const presentCount = selectedDay.data?.present || 0;
              const lateCount = selectedDay.data?.late || 0;
              
              if ((isHoliday || isWknd) && presentCount === 0) {
                return (
                  <div className="p-8 text-center bg-slate-50/50 dark:bg-slate-800/30">
                    <p className="text-4xl mb-3">{isHoliday ? '🎊' : '🛋️'}</p>
                    <p className="text-sm font-bold text-slate-700 dark:text-slate-200">{isHoliday ? 'Holiday' : 'Weekend'}</p>
                    <p className="text-xs text-slate-500 mt-1">No attendance expected today.</p>
                  </div>
                );
              }

              if (selectedDay.data && selectedDay.data.total > 0) {
                // If it's a holiday/weekend but someone showed up, don't show the rest as "Absent"
                const displayAbsent = (isHoliday || isWknd) ? 0 : selectedDay.data.absent;
                const displayTotal = (isHoliday || isWknd) ? (presentCount + lateCount) : selectedDay.data.total;
                const displayRate = (isHoliday || isWknd) ? (displayTotal > 0 ? 100 : 0) : selectedDay.data.rate;

                return (
                  <div className="p-5 space-y-4">
                    {/* Rate bar */}
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs text-slate-500 font-medium">Attendance Rate</span>
                        <span className="text-sm font-bold text-slate-900 dark:text-white">{displayRate}%</span>
                      </div>
                      <div className="w-full h-2 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className={cn("h-full rounded-full",
                            Number(displayRate) >= 80 ? "bg-emerald-500" :
                            Number(displayRate) >= 50 ? "bg-amber-500" : "bg-rose-500"
                          )}
                          style={{ width: `${displayRate}%` }}
                        />
                      </div>
                    </div>

                    {/* Stats grid */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-3 flex items-center gap-2">
                        <UserCheck className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                        <div>
                          <p className="text-xs text-emerald-600 font-medium">Present</p>
                          <p className="text-xl font-bold text-emerald-700">{selectedDay.data.present}</p>
                        </div>
                      </div>
                      {(!isHoliday && !isWknd) && (
                        <div className="bg-rose-50 dark:bg-rose-900/20 rounded-xl p-3 flex items-center gap-2">
                          <UserX className="w-5 h-5 text-rose-600 flex-shrink-0" />
                          <div>
                            <p className="text-xs text-rose-600 font-medium">Absent</p>
                            <p className="text-xl font-bold text-rose-700">{displayAbsent}</p>
                          </div>
                        </div>
                      )}
                      <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3 flex items-center gap-2">
                        <Clock className="w-5 h-5 text-amber-600 flex-shrink-0" />
                        <div>
                          <p className="text-xs text-amber-600 font-medium">Late</p>
                          <p className="text-xl font-bold text-amber-700">{selectedDay.data.late}</p>
                        </div>
                      </div>
                      <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-3 flex items-center gap-2">
                        <Users className="w-5 h-5 text-blue-600 flex-shrink-0" />
                        <div>
                          <p className="text-xs text-blue-600 font-medium">Total Tracked</p>
                          <p className="text-xl font-bold text-blue-700">{displayTotal}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }

              return (
                <div className="p-8 text-center">
                  <TrendingUp className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                  <p className="text-sm text-slate-500">No attendance data for this day</p>
                </div>
              );
            })()}

            {/* Per-day device activity */}
            <div className="px-5 pb-5">
              <DeviceActivityHeatmap fixedFrom={selectedDay.date} fixedTo={selectedDay.date} title="Device activity this day" />
            </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
