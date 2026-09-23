import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { motion } from 'motion/react';
import { format, subDays } from 'date-fns';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid
} from 'recharts';
import {
  Users, LogIn, LogOut, AlertTriangle, RefreshCw, Camera, Server, Zap, Building2, TrendingUp, Clock, Activity, ArrowUpRight
} from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';
import { useGlobalRetailStore } from '../../../hooks/useGlobalRetailStore';
import { apiRequest } from '../../../services/http/apiClient';
import { cn } from '../../ui/utils';
import { getTimeFormat, type TimeFormat } from '../../../utils/timeFormat';

const RETAIL_BASE = '/v1/retail';

// Store-timezone-aware date helpers. Using new Date().toISOString() (always
// UTC) to compute "today" mismatches the backend, which scopes "today" by
// the STORE's own timezone (e.g. America/Vancouver, UTC-7) — during the
// ~7-hour daily window where UTC has already rolled to a new calendar day
// but the store's local day hasn't, this sent the wrong date to /history,
// making the dashboard show yesterday's (store-local) data as "Today" or
// vice versa. en-CA locale formats as YYYY-MM-DD, which is what /history
// expects.
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

const DATE_RANGES = ['Today', 'Yesterday', 'Last 7 Days', 'Last 30 Days'] as const;
type DateRangeType = typeof DATE_RANGES[number];

const STORE_COLORS = [
  '#3b82f6', // Bright Blue
  '#10b981', // Emerald Green
  '#f59e0b', // Amber / Orange
  '#ec4899', // Pink / Rose
  '#8b5cf6', // Violet / Purple
  '#06b6d4', // Cyan
  '#f97316', // Deep Orange
  '#14b8a6', // Teal
];

const getDateRangeParams = (range: DateRangeType, tz: string) => {
  const t = todayInTz(tz);
  if (range === 'Today') return { from: t, to: t };
  if (range === 'Yesterday') {
    const y = daysAgoInTz(1, tz);
    return { from: y, to: y };
  }
  if (range === 'Last 7 Days') return { from: daysAgoInTz(6, tz), to: t };
  if (range === 'Last 30 Days') return { from: daysAgoInTz(29, tz), to: t };
  return { from: t, to: t };
};

const formatHourLabel = (h: number, format: TimeFormat) => {
  if (format === '24h') {
    return `${String(h).padStart(2, '0')}:00`;
  }
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  if (h < 12) return `${h} AM`;
  return `${h - 12} PM`;
};

const getPeakHourStr = (hourlyList: Array<{ hour: number; entries: number }>) => {
  if (!hourlyList || !hourlyList.length) return '—';
  const peak = [...hourlyList].sort((a, b) => (b.entries || 0) - (a.entries || 0))[0];
  if (!peak || !peak.entries) return '—';
  const h = peak.hour;
  const start = h > 12 ? `${h - 12} PM` : h === 12 ? '12 PM' : h === 0 ? '12 AM' : `${h} AM`;
  const nextH = (h + 1) % 24;
  const end = nextH > 12 ? `${nextH - 12} PM` : nextH === 12 ? '12 PM' : nextH === 0 ? '12 AM' : `${nextH} AM`;
  return `${start} - ${end}`;
};

interface StatCardProps {
  label: string;
  value: string | number;
  subLabel?: string;
  icon: React.FC<any>;
  accentClass?: string;
}

const StatCard: React.FC<StatCardProps> = ({ label, value, subLabel, icon: Icon, accentClass = "text-foreground" }) => (
  <div className="glass-card border border-border/60 rounded-2xl p-5 flex flex-col justify-between shadow-2xs hover:border-border transition-all">
    <div className="flex items-center justify-between mb-2">
      <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
        <Icon className="w-4 h-4" />
      </div>
    </div>
    <div>
      <p className={cn("text-2xl font-bold font-mono tracking-tight leading-none mb-1", accentClass)}>{value}</p>
      {subLabel && <p className="text-[11px] text-muted-foreground/80 font-medium">{subLabel}</p>}
    </div>
  </div>
);

export const RetailDashboard: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();

  const [stores, setStores] = useState<any[]>([]);
  const { selectedStoreId, setSelectedStoreId } = useGlobalRetailStore();
  const [dateRange, setDateRange] = useState<DateRangeType>('Today');
  const [trafficToggle, setTrafficToggle] = useState<'entries' | 'exits' | 'net'>('entries');

  // Real-time API states
  const [liveDataMap, setLiveDataMap] = useState<Record<string, any>>({});
  const [historyMap, setHistoryMap] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [timeFormat, setTimeFormat] = useState<TimeFormat>(getTimeFormat);

  // ── Live store-timezone clock ──────────────────────────────────────────────
  const [liveClock, setLiveClock] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setLiveClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const storeTimezone = useMemo(() => {
    if (selectedStoreId === 'all') return Intl.DateTimeFormat().resolvedOptions().timeZone;
    return stores.find(s => s.id === selectedStoreId)?.timezone
      || Intl.DateTimeFormat().resolvedOptions().timeZone;
  }, [selectedStoreId, stores]);

  const formattedClock = useMemo(() => {
    try {
      const timePart = liveClock.toLocaleTimeString('en-US', {
        timeZone: storeTimezone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      });
      const datePart = liveClock.toLocaleDateString('en-US', {
        timeZone: storeTimezone,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      const tzAbbr = liveClock.toLocaleTimeString('en-US', {
        timeZone: storeTimezone,
        timeZoneName: 'short',
      }).split(' ').pop() || '';
      return { timePart, datePart, tzAbbr };
    } catch {
      return { timePart: '--:--:--', datePart: '---', tzAbbr: '' };
    }
  }, [liveClock, storeTimezone]);

  // Storage listener for 12h/24h setting
  useEffect(() => {
    const handler = () => setTimeFormat(getTimeFormat());
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  // 1. Fetch store list from backend API
  useEffect(() => {
    if (!accessToken) return;
    apiRequest(`${RETAIL_BASE}/stores`, { method: 'GET', accessToken, scopeHeaders })
      .then((r: any) => {
        if (r.stores) {
          setStores(r.stores);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [accessToken, scopeHeaders]);

  // 2. Fetch real live data & history data for all stores
  const fetchRealData = useCallback(async () => {
    if (!accessToken || !stores.length) {
      setLoading(false);
      return;
    }

    try {
      // Live stats for all stores in parallel
      const liveResults = await Promise.all(
        stores.map(s =>
          apiRequest(`${RETAIL_BASE}/stores/${s.id}/live`, { method: 'GET', accessToken, scopeHeaders })
            .catch(() => null)
        )
      );

      const newLiveMap: Record<string, any> = {};
      stores.forEach((s, idx) => {
        if (liveResults[idx]) {
          newLiveMap[s.id] = liveResults[idx];
        }
      });
      setLiveDataMap(newLiveMap);

      // History data for selected date range
      const { from, to } = getDateRangeParams(dateRange, storeTimezone);
      const targetStores = selectedStoreId === 'all' ? stores : stores.filter(s => s.id === selectedStoreId);

      const historyResults = await Promise.all(
        targetStores.map(s =>
          apiRequest(`${RETAIL_BASE}/stores/${s.id}/history?from=${from}&to=${to}`, { method: 'GET', accessToken, scopeHeaders })
            .catch(() => null)
        )
      );

      const newHistMap: Record<string, any> = {};
      targetStores.forEach((s, idx) => {
        if (historyResults[idx]) {
          newHistMap[s.id] = historyResults[idx];
        }
      });
      setHistoryMap(newHistMap);
      setLastUpdated(new Date());
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [accessToken, stores, selectedStoreId, dateRange, scopeHeaders, storeTimezone]);

  useEffect(() => {
    fetchRealData();
    const interval = setInterval(fetchRealData, 4_000);
    return () => clearInterval(interval);
  }, [fetchRealData]);

  const isAll = selectedStoreId === 'all';

  // ── Derived Metrics from Original Real Data ────────────────────────────────
  const activeStoreObj = useMemo(() => {
    if (isAll) return null;
    return stores.find(s => s.id === selectedStoreId) || null;
  }, [isAll, selectedStoreId, stores]);

  const activeLiveData = useMemo(() => {
    if (isAll || !selectedStoreId) return null;
    return liveDataMap[selectedStoreId] || null;
  }, [isAll, selectedStoreId, liveDataMap]);

  // Whether the selected range is a multi-day range (needs historyMap)
  const isMultiDay = dateRange !== 'Today';

  // Aggregate stats across all stores — use historyMap totals for non-Today ranges
  const storePerformanceRows = useMemo(() => {
    return stores.map(s => {
      const live = liveDataMap[s.id];
      const hist = historyMap[s.id];

      const histEntries = (hist?.daily ?? []).reduce((acc: number, d: any) => acc + (d.entries || 0), 0);
      const histExits = (hist?.daily ?? []).reduce((acc: number, d: any) => acc + (d.exits || 0), 0);

      const entriesToday = isMultiDay ? histEntries : (live?.entries_today ?? histEntries);
      const exitsToday   = isMultiDay ? histExits   : (live?.exits_today   ?? histExits);
      const currentCount = live?.current_count ?? 0;
      const maxCap = live?.max_capacity ?? s.max_capacity ?? 100;
      const occPct = live?.occupancy_pct ?? (maxCap > 0 ? Math.round((currentCount / maxCap) * 100) : 0);

      return {
        id: s.id,
        name: s.name,
        footfall: entriesToday,
        in: currentCount,
        out: exitsToday,
        occupancy: occPct,
        capacity: maxCap,
        hourly: live?.hourly ?? [],
        peak: getPeakHourStr(live?.hourly ?? []),
      };
    });
  }, [stores, liveDataMap, historyMap, isMultiDay]);

  const storeColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    stores.forEach((s, idx) => {
      map[s.id] = STORE_COLORS[idx % STORE_COLORS.length];
    });
    return map;
  }, [stores]);

  const activeStoreColor = storeColorMap[selectedStoreId] || 'var(--primary)';

  const maxFootfall = Math.max(...storePerformanceRows.map(r => r.footfall), 1);
  const totalFootfall = storePerformanceRows.reduce((acc, r) => acc + r.footfall, 0);
  const avgFootfall = storePerformanceRows.length ? Math.round(totalFootfall / storePerformanceRows.length) : 0;
  const totalIn = storePerformanceRows.reduce((acc, r) => acc + r.in, 0);
  const avgIn = storePerformanceRows.length ? Math.round(totalIn / storePerformanceRows.length) : 0;
  const totalOut = storePerformanceRows.reduce((acc, r) => acc + r.out, 0);

  // Period totals for the active single store (used in KPI cards & Customer Traffic)
  const activeHistData = useMemo(() => {
    if (isAll || !selectedStoreId) return null;
    return historyMap[selectedStoreId] || null;
  }, [isAll, selectedStoreId, historyMap]);

  const periodEntries = useMemo(() => {
    if (!isMultiDay) return activeLiveData?.entries_today ?? 0;
    return (activeHistData?.daily ?? []).reduce((s: number, d: any) => s + (d.entries || 0), 0);
  }, [isMultiDay, activeLiveData, activeHistData]);

  const periodExits = useMemo(() => {
    if (!isMultiDay) return activeLiveData?.exits_today ?? 0;
    return (activeHistData?.daily ?? []).reduce((s: number, d: any) => s + (d.exits || 0), 0);
  }, [isMultiDay, activeLiveData, activeHistData]);

  // Peak hour for the active period
  const periodPeakHour = useMemo(() => {
    const hourlyDetail: any[] = activeHistData?.hourly_detail || [];
    const liveHourly: any[] = activeLiveData?.hourly || [];
    const byHour: Record<number, number> = {};

    if (!isMultiDay && liveHourly.length > 0) {
      liveHourly.forEach((r: any) => {
        if (r.entries) byHour[r.hour] = (byHour[r.hour] || 0) + (r.entries || 0);
      });
    } else {
      hourlyDetail.forEach((r: any) => {
        if (r.direction === 'in') byHour[r.hour] = (byHour[r.hour] || 0) + (r.total || 0);
      });
    }

    const hourlyList = Object.entries(byHour).map(([hour, entries]) => ({ hour: Number(hour), entries }));
    return getPeakHourStr(hourlyList);
  }, [isMultiDay, activeLiveData, activeHistData]);

  // Chart series — hourly for Today & Yesterday, daily bars for Last 7/30 Days
  const chartSeries = useMemo(() => {
    if (isAll) {
      // All stores: always show hourly live view
      const hours = Array.from({ length: 24 }, (_, i) => i);
      return hours.map(h => {
        const row: Record<string, any> = { hour: formatHourLabel(h, timeFormat) };
        let total = 0;
        stores.forEach(s => {
          const live = liveDataMap[s.id];
          const match = (live?.hourly || []).find((item: any) => item.hour === h);
          const entries = match?.entries || 0;
          const exits   = match?.exits   || 0;
          const val = trafficToggle === 'entries' ? entries : trafficToggle === 'exits' ? exits : entries - exits;
          row[s.id] = val;
          total += val;
        });
        row.total = total;
        return row;
      });
    }

    // Single store, Today or Yesterday → 24-hour bars
    if (!isMultiDay || dateRange === 'Yesterday') {
      const hourlyDetail: any[] = activeHistData?.hourly_detail || [];
      const liveHourly: any[] = activeLiveData?.hourly || [];

      return Array.from({ length: 24 }, (_, h) => {
        const inRow  = hourlyDetail.find((r: any) => Number(r.hour) === h && r.direction === 'in');
        const outRow = hourlyDetail.find((r: any) => Number(r.hour) === h && r.direction === 'out');
        const liveMatch = !isMultiDay ? liveHourly.find((r: any) => Number(r.hour) === h) : null;

        const entriesVal = !isMultiDay ? (liveMatch?.entries ?? (inRow?.total || 0)) : (inRow?.total || 0);
        const exitsVal   = !isMultiDay ? (liveMatch?.exits   ?? (outRow?.total || 0)) : (outRow?.total || 0);

        return {
          hour: formatHourLabel(h, timeFormat),
          entries: entriesVal,
          exits:   exitsVal,
          count:   entriesVal,
        };
      });
    }

    // Single store, Last 7/30 Days → daily bars from history
    const daily: any[] = activeHistData?.daily || [];
    return daily.map(d => ({
      hour: d.date,
      entries: d.entries || 0,
      exits:   d.exits   || 0,
      count:   d.entries || 0,
    }));
  }, [isAll, isMultiDay, dateRange, stores, liveDataMap, trafficToggle, timeFormat, activeLiveData, activeHistData]);

  // Aggregate Cameras & Devices
  const liveCameras = useMemo(() => {
    if (!isAll && selectedStoreId) {
      return liveDataMap[selectedStoreId]?.cameras || [];
    }
    return Object.values(liveDataMap).flatMap((d: any) => d.cameras || []);
  }, [isAll, selectedStoreId, liveDataMap]);

  const liveDevices = useMemo(() => {
    if (!isAll && selectedStoreId) {
      return liveDataMap[selectedStoreId]?.devices || [];
    }
    return Object.values(liveDataMap).flatMap((d: any) => d.devices || []);
  }, [isAll, selectedStoreId, liveDataMap]);

  const formatTimeAgo = (timeStr: string | null) => {
    if (!timeStr) return '—';
    try {
      const diffMs = new Date().getTime() - new Date(timeStr).getTime();
      const diffSec = Math.floor(diffMs / 1000);
      if (diffSec < 10) return 'Just now';
      if (diffSec < 60) return `${diffSec}s ago`;
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return `${diffMin}m ago`;
      return new Date(timeStr).toLocaleTimeString();
    } catch {
      return '—';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // If tenant has no stores created yet in database
  if (!stores.length) {
    return (
      <div className="flex flex-col items-center justify-center h-80 text-center gap-3 glass-card border border-border/60 rounded-2xl p-8">
        <Building2 className="w-10 h-10 text-muted-foreground/50" />
        <h3 className="text-lg font-bold text-foreground">No Stores Configured</h3>
        <p className="text-sm text-muted-foreground max-w-sm">
          You have not created any retail stores yet. Head to Store Management to set up your first store location.
        </p>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="space-y-6 pb-12"
    >
      {/* ── Top Header Row & Controls ────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <nav className="flex text-xs font-semibold text-muted-foreground/60 mb-1 tracking-wide">
            <span>Store Owner Portal</span>
            <span className="mx-2 text-muted-foreground/30">/</span>
            <span className="text-primary font-semibold">Owner Dashboard</span>
          </nav>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Owner Dashboard</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {isAll
              ? `Real-time analytics across all ${stores.length} store location${stores.length > 1 ? 's' : ''} · ${dateRange}`
              : `Real-time analytics for ${activeStoreObj?.name || 'Store'} · ${dateRange}`}
          </p>
        </div>

        {/* Date Range Selector, Live Clock & Sync Button */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Live store clock */}
          <div className="flex items-center gap-2.5 bg-muted/60 border border-border/40 rounded-xl px-3.5 py-2 shadow-2xs">
            <Clock className="w-3.5 h-3.5 text-primary shrink-0" />
            <div className="flex flex-col leading-none">
              <span className="text-sm font-black font-mono text-foreground tracking-tight">{formattedClock.timePart}</span>
              <span className="text-[10px] font-semibold text-muted-foreground mt-0.5">
                {formattedClock.datePart}{formattedClock.tzAbbr ? ` · ${formattedClock.tzAbbr}` : ''}
              </span>
            </div>
          </div>

          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value as DateRangeType)}
            className="bg-card border border-border rounded-xl px-3.5 py-2 text-xs font-bold text-foreground cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/20 shadow-2xs"
          >
            {DATE_RANGES.map(d => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>

          <button
            onClick={fetchRealData}
            className="flex items-center gap-2 bg-muted/60 hover:bg-muted border border-border/40 rounded-xl px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground transition-all cursor-pointer shadow-2xs"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>{format(lastUpdated, 'HH:mm')}</span>
          </button>
        </div>
      </div>

      {/* ── Inactive Store Warning Banner ─────────────────────────────────── */}
      {!isAll && activeStoreObj?.status === 'inactive' && (
        <div className="flex items-center gap-3 bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 p-4 rounded-2xl shadow-2xs">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <div>
            <p className="text-xs font-bold uppercase tracking-wider">Store Location Marked as Inactive</p>
            <p className="text-xs opacity-90 mt-0.5">
              Live telemetry, camera feeds, and people counting streams are currently paused for <strong>{activeStoreObj.name}</strong>.
            </p>
          </div>
        </div>
      )}

      {/* ── KPI Grid ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
        {isAll ? (
          <>
            <StatCard label="Total Stores" value={stores.length} icon={Building2} />
            <StatCard label="Total Footfall" value={totalFootfall.toLocaleString()} icon={TrendingUp} accentClass="text-primary" />
            <StatCard label="Avg. Footfall / Store" value={avgFootfall.toLocaleString()} icon={Activity} />
            <StatCard label="Avg. Customers In Store" value={avgIn} icon={Users} />
            <StatCard label="Live Customers Inside" value={totalIn.toLocaleString()} icon={LogIn} accentClass="text-emerald-500" />
            <StatCard
              label="Peak Activity"
              value={getPeakHourStr(chartSeries.map((c, i) => ({ hour: i, entries: c.count })))}
              icon={Zap}
              accentClass="text-amber-500"
            />
          </>
        ) : (
          <>
            <StatCard label={isMultiDay ? 'Total Entries' : 'Entries Today'} value={periodEntries.toLocaleString()} icon={TrendingUp} accentClass="text-primary" />
            <StatCard label="Currently Inside" value={activeLiveData?.current_count ?? 0} subLabel="Live store headcount" icon={LogIn} accentClass="text-emerald-500" />
            <StatCard label={isMultiDay ? 'Total Exits' : 'Exits Today'} value={periodExits.toLocaleString()} icon={LogOut} accentClass="text-rose-500" />
            <StatCard label="Occupancy" value={`${activeLiveData?.occupancy_pct ?? 0}%`} icon={Activity} />
            <StatCard
              label="Peak Hour"
              value={periodPeakHour}
              icon={Zap}
              accentClass="text-amber-500"
            />
          </>
        )}
      </div>

      {/* ── Footfall Chart Section ────────────────────────────────────────── */}
      <div className="glass-card border rounded-2xl p-6 shadow-2xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
          <div>
            <h3 className="text-base font-bold text-foreground">
              {isAll ? 'Footfall overview' : `Footfall — ${activeStoreObj?.name} · ${dateRange}`}
            </h3>
            <p className="text-xs text-muted-foreground">{dateRange === 'Last 7 Days' || dateRange === 'Last 30 Days' ? 'Daily customer traffic for selected period' : 'Hourly customer traffic trend'}</p>
          </div>

          {/* Toggle buttons for All Stores */}
          {isAll && (
            <div className="flex bg-muted p-1 rounded-xl border border-border/40 w-max">
              {(['entries', 'exits', 'net'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setTrafficToggle(t)}
                  className={cn(
                    "px-3 py-1.5 text-xs font-bold rounded-lg transition-all border-none cursor-pointer capitalize",
                    trafficToggle === t ? "bg-background text-primary shadow-2xs" : "text-muted-foreground hover:text-foreground bg-transparent"
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="h-[220px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            {isAll ? (
              <AreaChart data={chartSeries}>
                <defs>
                  {stores.map((s) => {
                    const color = storeColorMap[s.id] || 'var(--primary)';
                    return (
                      <linearGradient key={`grad_${s.id}`} id={`gStore_${s.id}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={color} stopOpacity={0.0} />
                      </linearGradient>
                    );
                  })}
                </defs>
                <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                <XAxis dataKey="hour" tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
                <YAxis tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
                <Tooltip contentStyle={{ borderRadius: 8, fontSize: 11, background: 'var(--card)', color: 'var(--foreground)', border: '1px solid var(--border)' }} />
                {stores.map((s) => {
                  const color = storeColorMap[s.id] || 'var(--primary)';
                  return (
                    <Area
                      key={s.id}
                      type="monotone"
                      dataKey={s.id}
                      name={s.name}
                      stroke={color}
                      fill={`url(#gStore_${s.id})`}
                      strokeWidth={2.5}
                    />
                  );
                })}
              </AreaChart>
            ) : (
              <BarChart data={chartSeries}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                <XAxis dataKey="hour" tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
                <YAxis tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
                <Tooltip contentStyle={{ borderRadius: 8, fontSize: 11, background: 'var(--card)', color: 'var(--foreground)' }} />
                <Bar dataKey="entries" fill={activeStoreColor} radius={[3, 3, 0, 0]} name="Entries" barSize={24} />
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>

        {/* Store Legend for All Stores */}
        {isAll && stores.length > 0 && (
          <div className="flex flex-wrap items-center gap-4 mt-4 pt-3 border-t border-border/40">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">Stores Legend:</span>
            {stores.map((s) => {
              const color = storeColorMap[s.id] || 'var(--primary)';
              return (
                <div key={s.id} className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <span className="w-3 h-3 rounded-full shrink-0 shadow-2xs" style={{ backgroundColor: color }} />
                  <span>{s.name}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Store Performance (All Stores mode only) ────────────────────── */}
      {isAll && (
        <div className="glass-card border rounded-2xl p-6 shadow-2xs">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-base font-bold text-foreground">Store performance</h3>
              <p className="text-xs text-muted-foreground">Click a store to drill in and inspect detailed metrics</p>
            </div>
            <span className="text-[10px] font-bold text-muted-foreground/60 uppercase tracking-wider">Footfall ranking</span>
          </div>

          <div className="space-y-3">
            {[...storePerformanceRows].sort((a, b) => b.footfall - a.footfall).map(r => {
              const pct = (r.footfall / maxFootfall * 100).toFixed(1);
              const color = storeColorMap[r.id] || 'var(--primary)';
              return (
                <div
                  key={r.id}
                  onClick={() => setSelectedStoreId(r.id)}
                  className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-muted/40 transition-colors cursor-pointer group border border-transparent hover:border-border/40"
                >
                  <div className="w-32 text-xs font-bold text-foreground group-hover:text-primary transition-colors flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                    <span>{r.name}</span>
                    <ArrowUpRight className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                  <div className="flex-1 bg-muted/60 h-5 rounded-lg overflow-hidden relative border border-border/20">
                    <div
                      className="group-hover:opacity-90 transition-all h-full rounded-lg"
                      style={{ width: `${pct}%`, backgroundColor: color }}
                    />
                  </div>
                  <div className="w-20 text-right font-mono text-xs font-bold text-foreground">
                    {r.footfall.toLocaleString()}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Two Column Layout: Customer Traffic + Occupancy ────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Left: Customer Traffic Card */}
        <div className="glass-card border rounded-2xl p-6 shadow-2xs flex flex-col justify-between">
          <div className="mb-4">
            <h3 className="text-base font-bold text-foreground">Customer traffic</h3>
            <p className="text-xs text-muted-foreground">Real-time entry vs exit volume split</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="bg-emerald-500/10 border border-emerald-500/20 p-4 rounded-xl">
              <p className="text-xs font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 mb-1">Total Entries</p>
              <p className="text-2xl font-black font-mono text-emerald-600 dark:text-emerald-400 leading-none">
                {isAll ? totalFootfall.toLocaleString() : periodEntries.toLocaleString()}
              </p>
            </div>
            <div className="bg-rose-500/10 border border-rose-500/20 p-4 rounded-xl">
              <p className="text-xs font-bold uppercase tracking-wider text-rose-500 mb-1">Total Exits</p>
              <p className="text-2xl font-black font-mono text-rose-500 leading-none">
                {isAll ? totalOut.toLocaleString() : periodExits.toLocaleString()}
              </p>
            </div>
          </div>
        </div>

        {/* Right: Occupancy Gauge / Current Store Occupancy List */}
        <div className="glass-card border rounded-2xl p-6 shadow-2xs flex flex-col justify-between">
          {isAll ? (
            <div>
              <div className="mb-4">
                <h3 className="text-base font-bold text-foreground">Current store occupancy</h3>
                <p className="text-xs text-muted-foreground">{totalIn} total customers currently inside all stores</p>
              </div>
              <div className="space-y-2.5">
                {[...storePerformanceRows].sort((a, b) => b.in - a.in).slice(0, 4).map(r => {
                  const color = storeColorMap[r.id] || 'var(--primary)';
                  return (
                    <div key={r.id} className="flex justify-between items-center text-xs py-1 border-b border-border/30 last:border-none">
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                        <span className="font-semibold text-foreground">{r.name}</span>
                      </div>
                      <span className="font-mono font-bold" style={{ color }}>{r.in} inside</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div>
              <div className="mb-4">
                <h3 className="text-base font-bold text-foreground">Occupancy</h3>
                <p className="text-xs text-muted-foreground">Live capacity threshold utilization</p>
              </div>
              <p className="text-3xl font-black font-mono text-foreground mb-3">{activeLiveData?.occupancy_pct ?? 0}%</p>
              <div className="w-full h-3 bg-muted rounded-full overflow-hidden mb-2">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${activeLiveData?.occupancy_pct ?? 0}%`, backgroundColor: activeStoreColor }}
                />
              </div>
              <p className="text-xs text-muted-foreground font-medium">
                {activeLiveData?.current_count ?? 0} of {activeLiveData?.max_capacity ?? 100} capacity
              </p>
            </div>
          )}
        </div>

      </div>

      {/* ── Live Monitoring: Cameras & Edge Devices Tables ─────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        
        {/* Left: Camera Monitoring (3 cols) */}
        <div className="glass-card border rounded-2xl p-6 shadow-2xs lg:col-span-3 flex flex-col gap-5">
          <div className="flex items-center justify-between border-b border-border/40 pb-3">
            <div>
              <h3 className="text-sm font-bold text-foreground">Camera Monitoring</h3>
              <p className="text-[11px] text-muted-foreground">Connected RTSP streams & object detection</p>
            </div>
            <div className="flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-full">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase">Live</span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="border-b border-border/60 text-[10px] font-bold text-muted-foreground/60 uppercase">
                  <th className="pb-2.5">Camera Name</th>
                  <th className="pb-2.5">Position</th>
                  <th className="pb-2.5">Status</th>
                  <th className="pb-2.5 text-right">Last Seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {liveCameras.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-muted-foreground font-semibold">
                      No cameras configured for this store location
                    </td>
                  </tr>
                ) : (
                  liveCameras.map((c: any, i: number) => (
                    <tr key={c.id || i} className="hover:bg-muted/20">
                      <td className="py-2.5 font-semibold text-foreground flex items-center gap-2">
                        <Camera className="w-3.5 h-3.5 text-primary/70" />
                        <span>{c.name}</span>
                      </td>
                      <td className="py-2.5 text-muted-foreground">{c.position || 'Main Area'}</td>
                      <td className="py-2.5">
                        <span className={cn(
                          "text-[9px] font-bold px-2 py-0.5 rounded-full uppercase",
                          c.status === 'online' ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-rose-500/15 text-rose-500"
                        )}>
                          {c.status}
                        </span>
                      </td>
                      <td className="py-2.5 text-right font-mono text-muted-foreground">
                        {formatTimeAgo(c.last_seen)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right: Edge Device Monitoring (2 cols) */}
        <div className="glass-card border rounded-2xl p-6 shadow-2xs lg:col-span-2 flex flex-col gap-5">
          <div className="flex items-center justify-between border-b border-border/40 pb-3">
            <div>
              <h3 className="text-sm font-bold text-foreground">Edge Device Monitoring</h3>
              <p className="text-[11px] text-muted-foreground">Jetson / Edge Node connection status</p>
            </div>
            <Server className="w-4 h-4 text-muted-foreground" />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="border-b border-border/60 text-[10px] font-bold text-muted-foreground/60 uppercase">
                  <th className="pb-2.5">Device ID</th>
                  <th className="pb-2.5">Status</th>
                  <th className="pb-2.5 text-right">Heartbeat</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {liveDevices.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="py-8 text-center text-muted-foreground font-semibold">
                      No edge devices registered for this store location
                    </td>
                  </tr>
                ) : (
                  liveDevices.map((d: any, i: number) => (
                    <tr key={d.id || i} className="hover:bg-muted/20">
                      <td className="py-2.5 font-semibold text-foreground font-mono">{d.external_id || d.id}</td>
                      <td className="py-2.5">
                        <span className={cn(
                          "text-[9px] font-bold px-2 py-0.5 rounded-full uppercase",
                          d.status === 'online' ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-rose-500/15 text-rose-500"
                        )}>
                          {d.status === 'online' ? 'Connected' : 'Offline'}
                        </span>
                      </td>
                      <td className="py-2.5 text-right text-muted-foreground font-medium">{formatTimeAgo(d.last_heartbeat)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>

      {/* ── Zone Traffic Heatmap (coming soon, single store only) ──────── */}
      {!isAll && (
        <div className="glass-card border rounded-2xl p-6 shadow-2xs" style={{ background: '#0b1120', borderColor: 'rgba(255,255,255,0.08)' }}>
          <div className="flex items-center justify-between mb-5">
            <div>
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-300">Fisheye Store View — Live Traffic Heatmap</h3>
              <p className="text-[11px] text-slate-400 mt-0.5">Zone-by-zone customer density for {activeStoreObj?.name || 'this store'}</p>
            </div>
            <span className="text-[10px] font-black uppercase tracking-wide px-2.5 py-1 rounded-full bg-amber-100 text-amber-700">Coming Soon</span>
          </div>

          <div className="relative mx-auto" style={{ width: '100%', maxWidth: 380, aspectRatio: '1 / 1' }}>
            <div
              className="absolute inset-0 rounded-full overflow-hidden"
              style={{
                background: 'radial-gradient(circle, #131b2e 0%, #0b1120 70%, #060a14 100%)',
                border: '1px solid rgba(255,255,255,0.06)',
                opacity: 0.9,
              }}
            >
              <div
                className="absolute inset-0"
                style={{
                  background:
                    'linear-gradient(to right, transparent 49.5%, rgba(255,255,255,0.06) 50%, transparent 50.5%),' +
                    'linear-gradient(to bottom, transparent 49.5%, rgba(255,255,255,0.06) 50%, transparent 50.5%)',
                }}
              />
              <div
                className="absolute rounded-full"
                style={{ top: '50%', left: '50%', width: '55%', height: '55%', transform: 'translate(-50%, -50%)', border: '1px solid rgba(255,255,255,0.08)' }}
              />

              {/* Zone blobs — illustrative placeholder positions */}
              <div className="absolute rounded-full" style={{ width: '38%', height: '38%', top: '14%', left: '10%', filter: 'blur(10px)', background: 'radial-gradient(circle, rgba(239,68,68,0.55), transparent 70%)' }} />
              <span className="absolute text-[11px] font-bold text-white/85" style={{ top: '30%', left: '20%', textShadow: '0 1px 3px rgba(0,0,0,0.6)' }}>Entrance Aisle</span>

              <div className="absolute rounded-full" style={{ width: '32%', height: '32%', top: '10%', right: '8%', filter: 'blur(10px)', background: 'radial-gradient(circle, rgba(217,119,6,0.5), transparent 70%)' }} />
              <span className="absolute text-[11px] font-bold text-white/85" style={{ top: '24%', right: '10%', textShadow: '0 1px 3px rgba(0,0,0,0.6)' }}>Promo Endcap</span>

              <div className="absolute rounded-full" style={{ width: '30%', height: '30%', bottom: '14%', left: '6%', filter: 'blur(10px)', background: 'radial-gradient(circle, rgba(217,119,6,0.5), transparent 70%)' }} />
              <span className="absolute text-[11px] font-bold text-white/85" style={{ bottom: '22%', left: '12%', textShadow: '0 1px 3px rgba(0,0,0,0.6)' }}>Browsing Area</span>

              <div className="absolute rounded-full" style={{ width: '40%', height: '40%', bottom: '4%', left: '30%', filter: 'blur(10px)', background: 'radial-gradient(circle, rgba(239,68,68,0.55), transparent 70%)' }} />
              <span className="absolute text-[11px] font-bold text-white/85" style={{ bottom: '10%', left: '38%', textShadow: '0 1px 3px rgba(0,0,0,0.6)' }}>Checkout</span>

              <div className="absolute rounded-full" style={{ width: '30%', height: '30%', bottom: '18%', right: '6%', filter: 'blur(10px)', background: 'radial-gradient(circle, rgba(37,99,235,0.5), transparent 70%)' }} />

              {[
                { top: '38%', left: '38%' }, { top: '42%', left: '42%' }, { top: '58%', left: '55%' },
                { top: '62%', left: '50%' }, { top: '55%', right: '25%' }, { top: '48%', left: '50%' },
              ].map((pos, i) => (
                <div key={i} className="absolute rounded-full" style={{ width: 6, height: 6, background: '#fff', boxShadow: '0 0 4px rgba(255,255,255,0.8)', ...pos }} />
              ))}

              <div
                className="absolute left-1/2 bottom-0 -translate-x-1/2 text-[9px] font-black uppercase tracking-wide px-2.5 py-1 rounded"
                style={{ background: '#10b981', color: '#04140d' }}
              >
                Entrance
              </div>

              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-6 rounded-full" style={{ background: 'rgba(6,10,20,0.55)' }}>
                <span className="text-[10px] font-black uppercase tracking-wide px-2.5 py-1 rounded-full bg-amber-100 text-amber-800">Coming Soon</span>
                <span className="text-sm font-bold text-white">Zone-wise heatmap not yet available</span>
                <span className="text-[11px] text-slate-300 max-w-[260px] leading-relaxed">
                  Per-zone foot-traffic tracking requires camera zone mapping, which isn't wired up on the edge devices yet.
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-5 mt-5">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400"><span className="w-2.5 h-2.5 rounded-full" style={{ background: '#ef4444' }} /> High traffic</span>
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400"><span className="w-2.5 h-2.5 rounded-full" style={{ background: '#d97706' }} /> Medium</span>
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400"><span className="w-2.5 h-2.5 rounded-full" style={{ background: '#2563eb' }} /> Low</span>
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400"><span className="w-2.5 h-2.5 rounded-full bg-white" /> Live shopper</span>
          </div>
        </div>
      )}

    </motion.div>
  );
};
