import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X, Users, UserCheck, Timer, Calendar, Loader2, Clock } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';
import { apiRequest } from '../../../services/http/apiClient';
import { cn } from '../../ui/utils';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';

interface DayData {
  date_str: string;
  entries: number;
  exits: number;
  net: number;
  conversion: number;
}

interface CalendarProps {
  storeId: string | null;
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

const RETAIL_BASE = '/v1/retail';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

const FALLBACK_HOLIDAYS: Record<string, string> = {
  '2026-01-01': "New Year's Day",
  '2026-01-26': 'Republic Day',
  '2026-08-15': 'Independence Day',
  '2026-10-02': 'Gandhi Jayanti',
  '2026-12-25': 'Christmas',
};

// Client-side cache to avoid repeated requests for events
const eventCache: Record<string, CalendarEventsData> = {};

export default function RetailCalendar({ storeId, onDayClick }: CalendarProps) {
  const { accessToken, isAuthenticated } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [calData, setCalData] = useState<Record<string, DayData>>({});
  const [hourlyDetail, setHourlyDetail] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedDay, setSelectedDay] = useState<{ date: string; data: DayData | null } | null>(null);
  const [holidays, setHolidays] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<Record<string, CalendarEvent[]>>({});
  const [eventsLoading, setEventsLoading] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Fetch calendar/footfall data from backend
  const fetchCalendar = useCallback(async () => {
    if (!isAuthenticated || !storeId) return;
    setLoading(true);
    try {
      const daysInMonth = new Date(year, month, 0).getDate();
      const fromDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const toDate = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

      const res = await apiRequest<{ daily: any[]; hourly_detail?: any[] }>(
        `${RETAIL_BASE}/stores/${storeId}/history?from=${fromDate}&to=${toDate}`,
        { accessToken, scopeHeaders }
      );
      
      const map: Record<string, DayData> = {};
      (res.daily || []).forEach(d => {
        // Handle potentially different date string formats
        const rawDate = d.date ? d.date.split('T')[0] : '';
        if (!rawDate) return;
        
        const entries = d.entries || 0;
        const exits = d.exits || 0;
        const net = entries - exits;
        const conversion = Math.round((exits / Math.max(entries, 1)) * 100);

        map[rawDate] = {
          date_str: rawDate,
          entries,
          exits,
          net,
          conversion
        };
      });

      setCalData(map);
      setHourlyDetail(res.hourly_detail || []);
    } catch (e) {
      console.error('Failed to fetch retail calendar history:', e);
    } finally {
      setLoading(false);
    }
  }, [accessToken, storeId, year, month, isAuthenticated]);

  useEffect(() => {
    fetchCalendar();
  }, [fetchCalendar]);

  // Fetch holidays and events from backend API (optional fallback if unauthorized)
  useEffect(() => {
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
        eventCache[cacheKey] = data;
        setHolidays(data.holidays || {});
        setEvents(data.events || {});
      } catch (error) {
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
  }, [year, month, accessToken, scopeHeaders, isAuthenticated]);

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
  while (cells.length % 7 !== 0) cells.push(null);

  const getDayStr = (d: number) =>
    `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  const isWeekend = (d: number) => {
    const dow = new Date(year, month - 1, d).getDay();
    return dow === 0 || dow === 6;
  };

  const handleDayClick = (d: number) => {
    const dateStr = getDayStr(d);
    const data = calData[dateStr] || null;
    setSelectedDay({ date: dateStr, data });
    onDayClick?.(dateStr, data);
  };

  // Prepare hourly data for the selected day drill-down
  const getSelectedDayHourlyData = () => {
    if (!selectedDay) return [];
    
    // Filter hourly_detail for selectedDay.date (ignoring any timestamp parts)
    const dayHourly = hourlyDetail.filter(h => {
      const hDate = h.date ? h.date.split('T')[0] : '';
      return hDate === selectedDay.date;
    });

    return Array.from({ length: 24 }, (_, h) => {
      const entries = dayHourly.find(x => x.hour === h && x.direction === 'in')?.total || 0;
      const exits = dayHourly.find(x => x.hour === h && x.direction === 'out')?.total || 0;
      return {
        hour: h,
        hourStr: h > 12 ? `${h-12} PM` : h === 12 ? '12 PM' : h === 0 ? '12 AM' : `${h} AM`,
        Entries: entries,
        Exits: exits,
      };
    }).filter(h => h.hour >= 8 && h.hour <= 22); // Focus on active store hours (8 AM - 10 PM)
  };

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden h-full flex flex-col min-h-[460px]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-primary" />
          <span className="font-semibold text-foreground text-sm">
            {MONTHS[month - 1]} {year}
          </span>
          {(loading || eventsLoading) && (
            <span title="Loading calendar data...">
              <Loader2 className="w-3 h-3 text-muted-foreground animate-spin" />
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={prevMonth} className="p-1 rounded-lg hover:bg-muted transition-colors">
            <ChevronLeft className="w-4 h-4 text-muted-foreground" />
          </button>
          <button
            onClick={() => { setYear(now.getFullYear()); setMonth(now.getMonth() + 1); }}
            className="px-2 py-0.5 text-xs font-semibold text-primary hover:bg-primary/10 rounded-md transition-colors"
          >
            Today
          </button>
          <button onClick={nextMonth} className="p-1 rounded-lg hover:bg-muted transition-colors">
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Weekday headers */}
      <div className="grid grid-cols-7 border-b border-border">
        {WEEKDAYS.map(d => (
          <div key={d} className={cn(
            "text-center py-1.5 text-[10px] font-bold uppercase tracking-wider",
            d === 'Sun' || d === 'Sat' ? 'text-rose-500 dark:text-rose-400' : 'text-muted-foreground/60'
          )}>
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="flex-1 grid grid-cols-7 auto-rows-fr">
        {cells.map((d, i) => {
          if (!d) return <div key={`empty-${i}`} className="border-b border-r border-border/30" />;
          const dateStr = getDayStr(d);
          const data = calData[dateStr];
          const isToday = dateStr === todayStr;
          const isWknd = isWeekend(d);
          const holiday = holidays[dateStr];
          const dayEvents = events[dateStr] || [];
          const isSelected = selectedDay?.date === dateStr;
          const hasData = data && (data.entries > 0 || data.exits > 0);
          const hasEventsOrHoliday = holiday || dayEvents.length > 0;

          return (
            <div
              key={dateStr}
              onClick={() => handleDayClick(d)}
              className={cn(
                "border-b border-r border-border/30 p-1 cursor-pointer transition-all duration-150 relative min-h-[56px]",
                isSelected ? "bg-primary/10 ring-1 ring-inset ring-primary" : "hover:bg-muted/40",
                isWknd && !isSelected ? "bg-rose-500/5 dark:bg-rose-500/10 ring-1 ring-inset ring-rose-500/10" : "",
                hasEventsOrHoliday && !isSelected ? "bg-amber-500/5 dark:bg-amber-500/10 ring-1 ring-inset ring-amber-500/15" : "",
              )}
            >
              {/* Day number */}
              <div className={cn(
                "w-5 h-5 flex items-center justify-center rounded-full text-[10px] font-bold mb-0.5",
                isToday ? "bg-primary text-primary-foreground" : isWknd ? "text-rose-500 dark:text-rose-400" : "text-foreground"
              )}>
                {d}
              </div>

              {/* Holiday label */}
              {holiday && (
                <div className="text-[8px] leading-tight text-amber-600 dark:text-amber-400 font-bold truncate mb-0.5 bg-amber-500/10 px-1 rounded">
                  🎊 {holiday}
                </div>
              )}

              {/* Footfall badges */}
              {hasData && !loading && (
                <div className="flex flex-col gap-0.5 mt-0.5">
                  <div className="flex items-center gap-0.5 flex-wrap">
                    <span className="inline-flex items-center px-1 py-0.5 rounded text-[8px] font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" title="Entries">
                      {data.entries} En
                    </span>
                    {data.exits > 0 && (
                      <span className="inline-flex items-center px-1 py-0.5 rounded text-[8px] font-bold bg-rose-500/10 text-rose-500 dark:text-rose-400" title="Exits">
                        {data.exits} Ex
                      </span>
                    )}
                    <span className={cn(
                      "inline-flex items-center px-1 py-0.5 rounded text-[8px] font-bold",
                      data.net >= 0 
                        ? "bg-purple-500/10 text-purple-600 dark:text-purple-400"
                        : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                    )} title="Net Traffic (Entries - Exits)">
                      {data.net > 0 ? `+${data.net}` : data.net} Net
                    </span>
                  </div>
                </div>
              )}

              {/* Empty indicator */}
              {!hasData && !loading && dateStr <= todayStr && (
                <div className="text-[9px] text-muted-foreground/30 pl-1">—</div>
              )}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 px-4 py-2 border-t border-border bg-muted/20 overflow-x-auto flex-wrap shrink-0">
        <span className="flex items-center gap-1 text-[9px] font-bold text-muted-foreground uppercase"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block"/>Entries</span>
        <span className="flex items-center gap-1 text-[9px] font-bold text-muted-foreground uppercase"><span className="w-1.5 h-1.5 rounded-full bg-rose-500 inline-block"/>Exits</span>
        <span className="flex items-center gap-1 text-[9px] font-bold text-muted-foreground uppercase"><span className="w-1.5 h-1.5 rounded-full bg-purple-500 inline-block"/>Net Traffic</span>
        <span className="flex items-center gap-1 text-[9px] font-bold text-muted-foreground uppercase"><span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block"/>Holiday</span>
      </div>

      {/* Day detail popup */}
      {selectedDay && mounted ? (createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setSelectedDay(null)}>
          <div
            className="bg-card rounded-2xl shadow-2xl border border-border w-[min(94vw,640px)] max-h-[88vh] flex flex-col overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            {/* Popup header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <p className="font-bold text-foreground text-base">
                  {new Date(selectedDay.date + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                </p>
                {holidays[selectedDay.date] && (
                  <p className="text-xs text-amber-500 font-semibold mt-0.5">🎊 {holidays[selectedDay.date]}</p>
                )}
                {events[selectedDay.date]?.map((evt, idx) => (
                  <p key={idx} className="text-xs text-primary font-semibold mt-0.5">📅 {evt.time ? `${evt.time} ` : ''}{evt.summary}</p>
                ))}
              </div>
              <button onClick={() => setSelectedDay(null)} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto">
              {(() => {
                const entriesCount = selectedDay.data?.entries || 0;
                const exitsCount = selectedDay.data?.exits || 0;
                const netCount = selectedDay.data?.net || 0;
                const convRate = selectedDay.data?.conversion || 0;
                const hasDayData = entriesCount > 0 || exitsCount > 0;

                if (!hasDayData) {
                  return (
                    <div className="p-8 text-center bg-muted/10">
                      <Calendar className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
                      <p className="text-sm font-semibold text-muted-foreground">No footfall data for this day</p>
                    </div>
                  );
                }

                return (
                  <div className="p-5 space-y-5">
                    {/* Conversion Rate bar */}
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Conversion Rate</span>
                        <span className="text-sm font-bold text-foreground">{convRate}%</span>
                      </div>
                      <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className={cn("h-full rounded-full transition-all duration-300",
                            convRate >= 45 ? "bg-emerald-500" :
                            convRate >= 25 ? "bg-amber-500" : "bg-rose-500"
                          )}
                          style={{ width: `${convRate}%` }}
                        />
                      </div>
                    </div>

                    {/* Stats grid */}
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-emerald-500/5 dark:bg-emerald-500/10 border border-emerald-500/10 rounded-xl p-3 flex items-center gap-3">
                        <Users className="w-5 h-5 text-emerald-500 shrink-0" />
                        <div>
                          <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider">Entries</p>
                          <p className="text-xl font-bold text-emerald-600 dark:text-emerald-400">{entriesCount}</p>
                        </div>
                      </div>
                      <div className="bg-rose-500/5 dark:bg-rose-500/10 border border-rose-500/10 rounded-xl p-3 flex items-center gap-3">
                        <UserCheck className="w-5 h-5 text-rose-500 shrink-0" />
                        <div>
                          <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider">Exits</p>
                          <p className="text-xl font-bold text-rose-600 dark:text-rose-400">{exitsCount}</p>
                        </div>
                      </div>
                      <div className="bg-purple-500/5 dark:bg-purple-500/10 border border-purple-500/10 rounded-xl p-3 flex items-center gap-3">
                        <Clock className="w-5 h-5 text-purple-500 shrink-0" />
                        <div>
                          <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider">Net Traffic</p>
                          <p className="text-xl font-bold text-purple-600 dark:text-purple-400">
                            {netCount > 0 ? `+${netCount}` : netCount}
                          </p>
                        </div>
                      </div>
                      <div className="bg-blue-500/5 dark:bg-blue-500/10 border border-blue-500/10 rounded-xl p-3 flex items-center gap-3">
                        <Timer className="w-5 h-5 text-blue-500 shrink-0" />
                        <div>
                          <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider">Conversion</p>
                          <p className="text-xl font-bold text-blue-600 dark:text-blue-400">{convRate}%</p>
                        </div>
                      </div>
                    </div>

                    {/* Hourly footfall graph */}
                    <div className="pt-4 border-t border-border">
                      <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-3">Hourly Traffic Trend</p>
                      <div className="h-[180px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={getSelectedDayHourlyData()}>
                            <XAxis dataKey="hourStr" axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: 'var(--muted-foreground)' }} />
                            <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: 'var(--muted-foreground)' }} allowDecimals={false} />
                            <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11 }} />
                            <Bar dataKey="Entries" fill="var(--primary)" radius={[2, 2, 0, 0]} name="Entries" />
                            <Bar dataKey="Exits" fill="var(--muted-foreground)" opacity={0.4} radius={[2, 2, 0, 0]} name="Exits" />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>,
        document.body
      ) as any) : null}
    </div>
  );
}
