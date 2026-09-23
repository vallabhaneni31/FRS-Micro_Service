import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { subDays, addDays } from 'date-fns';
import {
  AreaChart, Area, BarChart, Bar, ScatterChart, Scatter,
  XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
} from 'recharts';
import { Users, Calendar, Timer, UserCheck, TrendingUp, Clock, ArrowLeftRight, ChevronLeft, ChevronRight, Zap, Search, Download, Table, CalendarDays, BarChart2, ArrowUpRight } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';
import { useGlobalRetailStore } from '../../../hooks/useGlobalRetailStore';
import { apiRequest } from '../../../services/http/apiClient';
import { Card, CardContent } from '../../../ui/card';
import { cn } from '../../ui/utils';
import RetailCalendar from './RetailCalendar';
import { toast } from 'sonner';

const RETAIL_BASE = '/v1/retail';

// Store-timezone-aware date helpers — see RetailDashboard.tsx for the full
// rationale: new Date().toISOString() is always UTC, but the backend scopes
// "today" by the store's own timezone, so during the daily window where UTC
// has rolled to a new calendar day but the store's local day hasn't yet,
// this sent the wrong date to /history.
const todayInTz = (tz: string) => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
};
const daysAgoInTz = (n: number, tz: string) => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(subDays(new Date(), n));
  } catch {
    return subDays(new Date(), n).toISOString().slice(0, 10);
  }
};
// Browser/UTC fallback — used only before a store's timezone is known yet.
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => subDays(new Date(), n).toISOString().slice(0, 10);

const fmtDate = (d: string) =>
  new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const HOURS = Array.from({ length: 24 }, (_, i) => i); // full day, midnight → 11PM

const HOUR_LABELS = HOURS.map(h => h === 0 ? '12AM' : h < 12 ? `${h}AM` : h === 12 ? '12PM' : `${h - 12}PM`);

// ─── Heatmap ─────────────────────────────────────────────────────────────────
function Heatmap({ daily, hourlyDetail }: { daily: any[]; hourlyDetail: any[] }) {
  const maxCount = hourlyDetail.reduce(
    (max, h) => (h.direction === 'in' && h.total > max ? h.total : max), 0
  ) || 1;

  const getHeatLevel = (count: number) => {
    if (count === 0) return 0;
    return Math.min(Math.ceil((count / maxCount) * 9), 9);
  };

  const getCount = (dateStr: string, hour: number) =>
    hourlyDetail
      .filter(h => h.date === dateStr && h.hour === hour && h.direction === 'in')
      .reduce((s, h) => s + (h.total || 0), 0);

  const rowLabel = (dateStr: string) => {
    const d = new Date(dateStr + 'T12:00:00Z');
    const day = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }).toUpperCase();
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return `${day} ${date}`;
  };

  const slotLabel = (dateStr: string, hour: number) => {
    const d = new Date(dateStr + 'T12:00:00Z');
    const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    const h1 = hour > 12 ? `${hour - 12}PM` : hour === 12 ? '12PM' : `${hour}AM`;
    const h2 = (hour + 1) > 12 ? `${(hour + 1) - 12}PM` : (hour + 1) === 12 ? '12PM' : `${hour + 1}AM`;
    return `${day}, ${h1}–${h2}`;
  };

  const [hovered, setHovered] = useState<{ x: number; y: number; date: string; hour: number; count: number } | null>(null);

  if (!daily.length) {
    return (
      <div className="text-center py-10 text-sm text-muted-foreground">
        No hourly traffic data available for the selected range.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto w-full custom-scrollbar">
      <div style={{ minWidth: 800 }} className="pb-4">
        {/* Hour header row */}
        <div className="grid mb-2 items-center" style={{ gridTemplateColumns: '90px repeat(24, 1fr)', gap: '2px' }}>
          <div />
          {HOUR_LABELS.map(l => (
            <div key={l} className="text-center text-[9px] font-semibold text-muted-foreground/60 tracking-tight leading-tight">{l}</div>
          ))}
        </div>

        {/* Data rows */}
        <div className="space-y-1.5">
          {daily.map(d => (
            <div key={d.date} className="grid items-center" style={{ gridTemplateColumns: '90px repeat(24, 1fr)', gap: '2px', height: 36 }}>
              <div className="text-[10px] font-bold uppercase text-muted-foreground/80 tracking-wide pr-1 truncate">
                {rowLabel(d.date)}
              </div>
              {HOURS.map(h => {
                const count = getCount(d.date, h);
                const level = getHeatLevel(count);
                return (
                  <div
                    key={h}
                    className="heatmap-cell h-full w-full rounded relative border border-border/10"
                    style={{ backgroundColor: `var(--heat-${level})` }}
                    onMouseEnter={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      setHovered({ x: r.left + r.width / 2, y: r.top, date: d.date, hour: h, count });
                    }}
                    onMouseLeave={() => setHovered(null)}
                  />
                );
              })}
            </div>
          ))}
        </div>

        {hovered && createPortal(
          <div
            className="fixed rounded-xl border border-border bg-popover text-popover-foreground p-3 shadow-xl text-left pointer-events-none min-w-[150px] z-50 animate-in fade-in duration-150"
            style={{ left: hovered.x, top: hovered.y - 10, transform: 'translate(-50%, -100%)' }}
          >
            <p className="text-[10px] font-bold text-muted-foreground uppercase border-b border-border pb-1 mb-2">
              {slotLabel(hovered.date, hovered.hour)}
            </p>
            <p className="text-sm font-bold text-foreground">{hovered.count} Customers</p>
          </div>,
          document.body
        )}

        {/* Legend */}
        <div className="flex items-center gap-2 mt-6 justify-end">
          <span className="text-[10px] font-bold text-muted-foreground/60 uppercase tracking-wide">Quiet</span>
          {[0,1,2,3,4,5,6,7,8,9].map(l => (
            <div key={l} className="w-4 h-4 rounded border border-border/10" style={{ backgroundColor: `var(--heat-${l})` }} />
          ))}
          <span className="text-[10px] font-bold text-muted-foreground/60 uppercase tracking-wide">Peak</span>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export const RetailAnalytics: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const { selectedStoreId: globalStoreId } = useGlobalRetailStore();
  const storeId = globalStoreId === 'all' ? null : globalStoreId;
  // Defaults to the browser's own timezone until the store's real timezone
  // loads below — matches RetailDashboard.tsx's pattern.
  const [storeTimezone, setStoreTimezone] = useState<string>(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  const [from, setFrom]     = useState(() => daysAgoInTz(6, storeTimezone));
  const [to, setTo]         = useState(() => todayInTz(storeTimezone));
  const [range, setRange]   = useState<'Today' | 'This Week' | 'Custom'>('This Week');
  const [daily, setDaily]   = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [hourlyDetail, setHourlyDetail] = useState<any[]>([]);

  // Compare mode state
  const [compareMode, setCompareMode] = useState(false);

  // Store ID is driven globally by useGlobalRetailStore; fetch its real
  // timezone once so the date helpers above stop guessing from the browser.
  useEffect(() => {
    if (!storeId || !accessToken) return;
    apiRequest(`${RETAIL_BASE}/stores`, { method: 'GET', accessToken, scopeHeaders })
      .then((r: any) => {
        const match = (r.stores ?? []).find((s: any) => s.id === storeId);
        if (match?.timezone) setStoreTimezone(match.timezone);
      })
      .catch(() => {});
  }, [storeId, accessToken]);

  const applyRange = (r: 'Today' | 'This Week' | 'Custom') => {
    setRange(r);
    setCompareMode(false);
    if (r === 'Today')     { setFrom(todayInTz(storeTimezone)); setTo(todayInTz(storeTimezone)); }
    if (r === 'This Week') { setFrom(daysAgoInTz(6, storeTimezone)); setTo(todayInTz(storeTimezone)); }
  };

  // Once the store's real timezone resolves (from the browser-tz default),
  // recompute the currently-selected range so it reflects the correct
  // calendar days — unless the user already picked a custom range.
  useEffect(() => {
    if (range !== 'Custom') applyRange(range);
  }, [storeTimezone]);

  useEffect(() => {
    if (!storeId || !accessToken) return;
    setLoading(true);
    apiRequest(`${RETAIL_BASE}/stores/${storeId}/history?from=${from}&to=${to}`, {
      method: 'GET', accessToken, scopeHeaders,
    })
      .then((r: any) => {
        setDaily((r.daily ?? []).map((d: any) => ({
          date: d.date,
          label: fmtDate(d.date),
          entries: d.entries,
          exits: d.exits,
          compareEntries: d.entries,
          compareExits: d.exits,
          conversion: d.entries > 0 ? Math.round((d.exits / d.entries) * 100) : 0,
        })));
        setHourlyDetail(r.hourly_detail || []);
      })
      .finally(() => setLoading(false));
  }, [storeId, from, to, accessToken]);

  // ── Date Shifting Helper ──────────────────────────────────────────────────
  const shiftRange = (direction: 'prev' | 'next') => {
    const fromDate = new Date(from + 'T12:00:00Z');
    const toDate = new Date(to + 'T12:00:00Z');
    const diffTime = Math.abs(toDate.getTime() - fromDate.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) || 1;

    if (direction === 'prev') {
      const nextFrom = subDays(fromDate, diffDays + 1).toISOString().slice(0, 10);
      const nextTo = subDays(toDate, diffDays + 1).toISOString().slice(0, 10);
      setFrom(nextFrom);
      setTo(nextTo);
      setRange('Custom');
    } else {
      const nextFrom = addDays(fromDate, diffDays + 1);
      const nextTo = addDays(toDate, diffDays + 1);
      const maxLimit = new Date(todayInTz(storeTimezone) + 'T12:00:00Z');

      if (nextTo.getTime() <= maxLimit.getTime()) {
        setFrom(nextFrom.toISOString().slice(0, 10));
        setTo(nextTo.toISOString().slice(0, 10));
      } else {
        setTo(todayInTz(storeTimezone));
        setFrom(daysAgoInTz(diffDays, storeTimezone));
      }
      setRange('Custom');
    }
  };

  // ── Derived KPIs ──────────────────────────────────────────────────────────
  const totalEntries  = daily.reduce((s, d) => s + d.entries, 0);
  const totalExits    = daily.reduce((s, d) => s + d.exits, 0);
  const peakDay       = daily.reduce((b: any, d) => d.entries > (b?.entries ?? 0) ? d : b, null);

  const busiestDay = peakDay
    ? new Date(peakDay.date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
    : '—';

  const peakHour = (() => {
    if (!hourlyDetail.length) return '—';
    const counts: Record<number, number> = {};
    hourlyDetail.forEach(h => {
      if (h.direction === 'in') counts[h.hour] = (counts[h.hour] || 0) + (h.total || 0);
    });
    const best = Object.entries(counts).sort((a, b) => +b[1] - +a[1])[0];
    if (!best) return '—';
    const h = +best[0];
    return h > 12 ? `${h - 12}:00 PM` : h === 12 ? '12:00 PM' : `${h}:00 AM`;
  })();

  const avgPerHr = daily.length
    ? Math.round(totalEntries / (daily.length * 13))
    : 0;

  // ── Dynamic Peak Window Calculation ───────────────────────────────────────
  const peakWindowInfo = (() => {
    if (!hourlyDetail.length) return { range: '16:00 - 19:00', avg: 242 };
    const hours = Array.from({ length: 22 }, (_, i) => i); // 3-hr windows starting 0..21
    let maxEntries = 0;
    let bestStart = 16;
    
    hours.forEach(start => {
      let sum = 0;
      for (let o = 0; o < 3; o++) {
        const hr = start + o;
        sum += hourlyDetail
          .filter(h => h.hour === hr && h.direction === 'in')
          .reduce((s, m) => s + (m.total || 0), 0);
      }
      if (sum > maxEntries) {
        maxEntries = sum;
        bestStart = start;
      }
    });

    const daysCount = daily.length || 1;
    const avg = Math.round(maxEntries / daysCount);
    const fmt = (h: number) => `${h.toString().padStart(2, '0')}:00`;
    return {
      range: `${fmt(bestStart)} - ${fmt(bestStart + 3)}`,
      avg
    };
  })();

  // ── Dynamic Peak Hour Frequency Chart Data ────────────────────────────────
  const peakHourFreqData = Array.from({ length: 12 }, (_, i) => i * 2).map(h => {
    const match = hourlyDetail.filter(item => item.hour === h && item.direction === 'in');
    const total = match.reduce((sum, m) => sum + (m.total || 0), 0);
    return {
      hour: `${h.toString().padStart(2, '0')}:00`,
      count: total,
    };
  });

  // ── Dynamic Hourly In vs Out Volume Data ──────────────────────────────────
  const hourlyTrafficVolumeData = Array.from({ length: 12 }, (_, i) => i * 2).map(h => {
    const inMatches = hourlyDetail.filter(item => item.hour === h && item.direction === 'in');
    const outMatches = hourlyDetail.filter(item => item.hour === h && item.direction === 'out');
    return {
      hour: `${h.toString().padStart(2, '0')}:00`,
      in: inMatches.reduce((sum, m) => sum + (m.total || 0), 0),
      out: outMatches.reduce((sum, m) => sum + (m.total || 0), 0),
    };
  });

  const stat = (v: number | string) => loading ? '…' : String(v);

  const rangeLabel = (() => {
    if (range === 'Today') return 'Today';
    if (range === 'This Week') return 'This Week';
    const fmtD = (d: string) => {
      const dt = new Date(d + 'T12:00:00Z');
      return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    };
    return `${fmtD(from)} – ${fmtD(to)}`;
  })();

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `
        :root {
          --heat-0: var(--muted);
          --heat-1: color-mix(in srgb, var(--primary) 10%, transparent);
          --heat-2: color-mix(in srgb, var(--primary) 20%, transparent);
          --heat-3: color-mix(in srgb, var(--primary) 35%, transparent);
          --heat-4: color-mix(in srgb, var(--primary) 50%, transparent);
          --heat-5: color-mix(in srgb, var(--primary) 65%, transparent);
          --heat-6: color-mix(in srgb, var(--primary) 80%, transparent);
          --heat-7: var(--primary);
          --heat-8: color-mix(in srgb, var(--primary) 90%, black);
          --heat-9: color-mix(in srgb, var(--primary) 80%, black);
        }
        
        .heatmap-cell { 
          transition: transform .25s ease, box-shadow .25s ease; 
          cursor: pointer; 
          position: relative; 
        }
        .heatmap-cell:hover {
          transform: scale(1.15);
          z-index: 20;
          box-shadow: 0 4px 12px rgba(0,0,0,.15);
          border-radius: 6px;
        }
      ` }} />

      <div className="flex flex-col gap-8 pb-12">

        {/* ── Header & Filters ────────────────────────────────────────────── */}
        <section className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <nav className="flex text-xs font-semibold text-muted-foreground/60 mb-1 tracking-wide">
              <span>Store Owner Portal</span>
              <span className="mx-2 text-muted-foreground/30">/</span>
              <span className="text-primary font-semibold">Insights</span>
            </nav>
            <h2 className="text-2xl font-bold tracking-tight text-foreground">Insights</h2>
          </div>

          {/* Date range filter layout */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            <div className="flex bg-muted rounded-xl p-1 gap-1 border border-border/40">
              {(['Today', 'This Week', 'Custom'] as const).map(r => (
                <button
                  key={r}
                  onClick={() => applyRange(r)}
                  className={cn(
                    "px-4 py-2 text-xs font-bold rounded-lg transition-all border-none cursor-pointer",
                    range === r ? 'bg-background text-primary shadow-xs' : 'text-muted-foreground hover:text-foreground bg-transparent'
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* ── ANALYSIS VIEW ──────────────────────────────────────────────── */}
        <>
          {/* Custom date range fields */}
          <AnimatePresence>
            {range === 'Custom' && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="flex items-center gap-2 overflow-hidden bg-card border border-border p-3 rounded-xl max-w-max shadow-xs"
              >
                <input
                  type="date"
                  value={from}
                  max={to}
                  onChange={e => setFrom(e.target.value)}
                  className="bg-background border border-border rounded px-2.5 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-primary/20 text-foreground"
                />
                <span className="text-muted-foreground text-[10px] font-bold uppercase">to</span>
                <input
                  type="date"
                  value={to}
                  min={from}
                  max={todayInTz(storeTimezone)}
                  onChange={e => setTo(e.target.value)}
                  className="bg-background border border-border rounded px-2.5 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-primary/20 text-foreground"
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* KPI Section */}
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 max-w-sm gap-4">
              <div className="glass-card p-6 rounded-2xl border shadow-xs">
                <p className="text-xs font-bold text-muted-foreground/80 tracking-wide mb-3">Total Entries — {rangeLabel}</p>
                <p className="text-3xl font-bold tracking-tight text-foreground font-mono mb-1">
                  {stat(totalEntries.toLocaleString())}
                </p>
                <p className="text-xs text-muted-foreground">Cumulative entry count</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { label: 'Busiest Day', value: stat(busiestDay), icon: Calendar },
                { label: 'Peak Hour', value: stat(peakHour), icon: Clock },
                { label: 'Avg Customers/Hr', value: stat(avgPerHr), icon: Users },
              ].map(({ label, value, icon: Icon }) => (
                <div key={label} className="bg-muted/40 border border-border/60 p-4 rounded-xl flex items-center gap-3.5 shadow-2xs">
                  <div className="w-9 h-9 rounded-lg bg-card border border-border flex items-center justify-center text-primary/80">
                    <Icon className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-[11px] font-bold text-muted-foreground/85 tracking-wide mb-0.5">{label}</p>
                    <p className="text-sm font-bold tracking-tight text-foreground">{value}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Heatmap */}
          <div className="glass-card p-6 rounded-2xl border shadow-xs w-full">
            <div className="flex flex-col gap-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h3 className="text-lg font-bold tracking-tight text-foreground mb-1">Peak Time Heatmap</h3>
                  <p className="text-xs text-muted-foreground">
                    Showing hourly distribution for {fmtDate(from)} - {fmtDate(to)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex bg-muted p-1 rounded-lg border border-border/40">
                    <button
                      onClick={() => {
                        setFrom(daysAgoInTz(13, storeTimezone));
                        setTo(daysAgoInTz(7, storeTimezone));
                        setRange('Custom');
                        toast.info('Viewing Previous Week');
                      }}
                      className={cn(
                        "px-3 py-1 text-xs rounded transition-colors cursor-pointer border-none",
                        from === daysAgoInTz(13, storeTimezone) && to === daysAgoInTz(7, storeTimezone)
                          ? "font-bold bg-background shadow-2xs text-primary"
                          : "font-semibold hover:bg-background text-muted-foreground"
                      )}
                    >
                      Previous Week
                    </button>
                    <button
                      onClick={() => {
                        setFrom(daysAgoInTz(6, storeTimezone));
                        setTo(todayInTz(storeTimezone));
                        setRange('This Week');
                        toast.info('Viewing Current Week');
                      }}
                      className={cn(
                        "px-3 py-1 text-xs rounded transition-colors cursor-pointer border-none",
                        from === daysAgoInTz(6, storeTimezone) && to === todayInTz(storeTimezone)
                          ? "font-bold bg-background shadow-2xs text-primary"
                          : "font-semibold hover:bg-background text-muted-foreground"
                      )}
                    >
                      Current Week
                    </button>
                    <button
                      onClick={() => {
                        setFrom(daysAgoInTz(29, storeTimezone));
                        setTo(todayInTz(storeTimezone));
                        setRange('Custom');
                        toast.info('Viewing Last 30 Days');
                      }}
                      className={cn(
                        "px-3 py-1 text-xs rounded transition-colors cursor-pointer border-none",
                        from === daysAgoInTz(29, storeTimezone) && to === todayInTz(storeTimezone)
                          ? "font-bold bg-background shadow-2xs text-primary"
                          : "font-semibold hover:bg-background text-muted-foreground"
                      )}
                    >
                      Last 30 Days
                    </button>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => shiftRange('prev')}
                      className="p-1.5 hover:bg-muted border border-transparent hover:border-border rounded-full text-muted-foreground/80 transition-all cursor-pointer bg-transparent"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => shiftRange('next')}
                      className="p-1.5 hover:bg-muted border border-transparent hover:border-border rounded-full text-muted-foreground/80 transition-all cursor-pointer bg-transparent"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
              <Heatmap daily={daily} hourlyDetail={hourlyDetail} />
            </div>
          </div>

          {/* Trend & Peak Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="glass-card p-6 rounded-2xl border shadow-xs lg:col-span-2">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground/80">Entry vs Exit Trend</h3>
                <div className="flex gap-4 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">
                  {compareMode && (
                    <span className="flex items-center gap-1.5 opacity-60">
                      <span className="w-2 h-2 rounded-full border border-dashed border-primary" /> Prev. Entries
                    </span>
                  )}
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-primary" /> Entries
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-muted-foreground/50" /> Exits
                  </span>
                </div>
              </div>
              <div className="h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={daily}>
                    <defs>
                      <linearGradient id="gIn" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.15} />
                        <stop offset="95%" stopColor="var(--primary)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.6} />
                    <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11, color: 'var(--foreground)' }} />
                    <Area type="monotone" dataKey="entries" stroke="var(--primary)" fill="url(#gIn)" strokeWidth={2} dot={false} name="Entries" activeDot={{ r: 4, strokeWidth: 0 }} />
                    {compareMode && (
                      <Area type="monotone" dataKey="compareEntries" stroke="var(--primary)" strokeDasharray="4 4" fill="transparent" strokeWidth={1.5} dot={false} name="Compare Entries" />
                    )}
                    <Area type="monotone" dataKey="exits" stroke="var(--muted-foreground)" fill="transparent" strokeWidth={2} dot={false} name="Exits" activeDot={{ r: 4, strokeWidth: 0 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-2xl p-6 flex flex-col justify-between shadow-xs bg-primary text-primary-foreground relative overflow-hidden">
              <div>
                <div className="flex items-center gap-2 mb-4 opacity-90">
                  <Zap className="w-5 h-5 fill-primary-foreground text-primary-foreground" />
                  <span className="text-xs font-bold uppercase tracking-wider">Peak Window</span>
                </div>
                <h4 className="text-2xl font-bold tracking-tight mb-1">{stat(peakWindowInfo.range)}</h4>
                <p className="text-xs opacity-80">Avg {stat(peakWindowInfo.avg)} customers during this window</p>
              </div>
            </div>
          </div>

          {/* Peak Hour Frequency */}
          <div className="glass-card p-6 rounded-2xl border shadow-xs w-full">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground/80">Peak Hour Frequency</h3>
              <span className="text-[10px] font-semibold text-muted-foreground/60 tracking-wider">Total Occurrences</span>
            </div>
            <div className="h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={peakHourFreqData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.6} />
                  <XAxis dataKey="hour" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} allowDecimals={false} />
                  <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11 }} />
                  <Bar dataKey="count" fill="var(--primary)" radius={[4, 4, 0, 0]} barSize={28} name="Occurrences" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Hourly Traffic Volume */}
          <div className="glass-card p-6 rounded-2xl border shadow-xs">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground/80">Hourly Traffic Volume (In vs Out)</h3>
              <div className="flex gap-4 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-primary" /> In
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-muted-foreground/50" /> Out
                </span>
              </div>
            </div>
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hourlyTrafficVolumeData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.6} />
                  <XAxis dataKey="hour" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} allowDecimals={false} />
                  <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11 }} />
                  <Bar dataKey="in" fill="var(--primary)" radius={[3, 3, 0, 0]} name="In" />
                  <Bar dataKey="out" fill="var(--muted-foreground)" opacity={0.5} radius={[3, 3, 0, 0]} name="Out" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      </div>
    </>
  );
};
