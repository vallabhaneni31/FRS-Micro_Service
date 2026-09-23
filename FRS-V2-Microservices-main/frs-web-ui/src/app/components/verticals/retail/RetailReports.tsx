import React, { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  format, parseISO, startOfMonth, endOfMonth, eachDayOfInterval,
  addMonths, subMonths, getDay,
} from 'date-fns';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  AreaChart, Area,
} from 'recharts';
import {
  ChevronLeft, ChevronRight, TrendingUp, Download, X,
  RefreshCw, TrendingDown,
} from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';
import { useGlobalRetailStore } from '../../../hooks/useGlobalRetailStore';
import { apiRequest } from '../../../services/http/apiClient';
import { cn } from '../../ui/utils';

const RETAIL_BASE = '/v1/retail';
const DAY_LABELS  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
type ViewMode = 'TABLE' | 'TIMELINE' | 'CALENDAR' | 'GRAPH';

/* ─── helpers ─────────────────────────────────────── */
function dayLetter(date: string) {
  const d = new Date(date + 'T12:00:00Z');
  return ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][d.getUTCDay()];
}
function fmtShort(date: string) {
  const d = new Date(date + 'T12:00:00Z');
  return format(d, 'MMM d');
}

/* ─── Traffic Pulse bar ────────────────────────────── */
function TrafficPulse({ entries, exits }: { entries: number; exits: number }) {
  const total = entries + exits;
  const entryPct = total ? Math.round((entries / total) * 100) : 50;
  const exitPct  = 100 - entryPct;
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-2.5 rounded-full overflow-hidden bg-muted flex">
        <motion.div
          className="h-full bg-emerald-500 rounded-l-full"
          initial={{ width: 0 }}
          animate={{ width: `${entryPct}%` }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        />
        <motion.div
          className="h-full bg-rose-400 rounded-r-full"
          initial={{ width: 0 }}
          animate={{ width: `${exitPct}%` }}
          transition={{ duration: 0.6, ease: 'easeOut', delay: 0.1 }}
        />
      </div>
      <span className="text-sm font-bold text-foreground w-8 text-right shrink-0">{total}</span>
    </div>
  );
}

/* ─── Timeline row card ────────────────────────────── */
function TimelineRow({
  row, index, onClick, isSelected,
}: {
  row: any; index: number; onClick: () => void; isSelected: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25, delay: index * 0.04 }}
      className="flex items-stretch gap-0"
    >
      {/* date + timeline stem */}
      <div className="flex flex-col items-center w-16 shrink-0 pt-1">
        <span className="text-[10px] font-bold text-muted-foreground">{dayLetter(row.date)}</span>
        <div className={cn(
          'w-4 h-4 rounded-full border-2 mt-1 transition-colors',
          isSelected ? 'bg-primary border-primary' : 'bg-card border-border'
        )} />
        <div className="flex-1 w-px bg-border mt-1" />
      </div>

      {/* card */}
      <div
        onClick={onClick}
        className={cn(
          'flex-1 mb-3 ml-2 rounded-2xl border cursor-pointer transition-all duration-200 hover:shadow-md',
          isSelected ? 'border-primary/40 bg-primary/5 shadow-md' : 'border-border bg-card hover:border-primary/30'
        )}
      >
        {/* date label row */}
        <div className="px-5 pt-3 pb-1">
          <span className="text-[11px] font-bold text-muted-foreground">{fmtShort(row.date)}</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 px-5 pb-4 pt-1">
          {/* Traffic Pulse */}
          <div>
            <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-muted-foreground mb-2">Traffic Pulse</p>
            <TrafficPulse entries={row.entries} exits={row.exits} />
          </div>

          {/* Peak Hour */}
          <div>
            <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-muted-foreground mb-2">Peak Hour</p>
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-emerald-500" />
              <span className="text-sm font-semibold text-foreground">
                {row.peak_hour != null ? `${row.peak_hour}:00` : '—'}
              </span>
            </div>
          </div>

          {/* In vs Out */}
          <div>
            <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-muted-foreground mb-2">In vs Out</p>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-emerald-600">+{row.entries}</span>
              <span className="text-sm font-bold text-rose-500">-{row.exits}</span>
            </div>
          </div>

          {/* Avg Occupancy */}
          <div>
            <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-muted-foreground mb-2">Avg Occupancy</p>
            <span className="inline-flex items-center px-3 py-1 rounded-full bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-400 text-xs font-bold border border-indigo-200/60 dark:border-indigo-800/60">
              {row.avg_occupancy ?? 0} customers
            </span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

/* ─── Calendar view ────────────────────────────────── */
function CalendarView({ rows, onSelect, selected }: { rows: any[]; onSelect: (d: string) => void; selected: string | null }) {
  const [month, setMonth] = useState(new Date());
  const start = startOfMonth(month);
  const end   = endOfMonth(month);
  const days  = eachDayOfInterval({ start, end });
  const pad   = getDay(start);
  const maxCount = Math.max(1, ...rows.map(r => r.entries));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-base font-bold text-foreground">{format(month, 'MMMM yyyy')}</h3>
        <div className="flex gap-1">
          <button onClick={() => setMonth(subMonths(month, 1))} className="p-2 rounded-lg hover:bg-muted transition-colors">
            <ChevronLeft className="w-4 h-4 text-muted-foreground" />
          </button>
          <button onClick={() => setMonth(addMonths(month, 1))} className="p-2 rounded-lg hover:bg-muted transition-colors">
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-2 mb-2">
        {DAY_LABELS.map(d => (
          <div key={d} className="text-[10px] font-bold text-muted-foreground uppercase text-center">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-2">
        {Array(pad).fill(null).map((_, i) => <div key={`p${i}`} />)}
        {days.map(day => {
          const key = format(day, 'yyyy-MM-dd');
          const row = rows.find(r => r.date === key);
          const isFuture = day > new Date();
          const intensity = row ? row.entries / maxCount : 0;
          const isSel = selected === key;
          return (
            <motion.button
              key={key}
              whileHover={row && !isFuture ? { scale: 1.08 } : {}}
              whileTap={row && !isFuture ? { scale: 0.96 } : {}}
              disabled={!row || isFuture}
              onClick={() => row && onSelect(key)}
              className={cn(
                'h-14 rounded-xl flex flex-col items-center justify-center border text-sm font-semibold transition-colors',
                isSel
                  ? 'bg-primary text-primary-foreground border-primary shadow-md'
                  : row && !isFuture
                    ? 'border-border hover:border-primary cursor-pointer text-foreground'
                    : 'border-border/40 text-muted-foreground/30 cursor-default'
              )}
              style={row && !isSel && !isFuture ? {
                background: `color-mix(in srgb, var(--primary) ${Math.round(intensity * 28)}%, var(--card))`,
              } : undefined}
            >
              <span>{format(day, 'd')}</span>
              {row && !isFuture && (
                <span className={cn('text-[9px] font-bold mt-0.5', isSel ? 'text-primary-foreground/80' : 'text-primary')}>
                  {row.entries}
                </span>
              )}
            </motion.button>
          );
        })}
      </div>
      <div className="flex items-center justify-center gap-3 mt-6 pt-4 border-t border-border">
        <span className="text-[9px] font-bold text-muted-foreground uppercase">Low</span>
        {[8, 16, 24, 32].map(p => (
          <div key={p} className="w-5 h-5 rounded border border-border/30"
            style={{ background: `color-mix(in srgb, var(--primary) ${p}%, var(--card))` }} />
        ))}
        <span className="text-[9px] font-bold text-muted-foreground uppercase">Peak</span>
      </div>
    </div>
  );
}

/* ─── Graph view ──────────────────────────────────── */
function GraphView({ rows }: { rows: any[] }) {
  const data = [...rows].reverse().map(r => ({
    date: fmtShort(r.date),
    entries: r.entries,
    exits: r.exits,
  }));
  return (
    <div className="space-y-6">
      <div className="bg-card border border-border rounded-2xl p-6">
        <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground mb-6">Daily Entries & Exits</p>
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={data} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
            <defs>
              <linearGradient id="gEn" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#22c55e" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} />
            <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} allowDecimals={false} />
            <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 11 }} />
            <Area type="monotone" dataKey="entries" stroke="#22c55e" fill="url(#gEn)" strokeWidth={2} dot={false} name="Entries" activeDot={{ r: 4, strokeWidth: 0 }} />
            <Area type="monotone" dataKey="exits"   stroke="#f43f5e" fill="transparent"  strokeWidth={2} dot={false} name="Exits"   activeDot={{ r: 4, strokeWidth: 0 }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="bg-card border border-border rounded-2xl p-6">
        <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground mb-6">Net Traffic (Entries − Exits)</p>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} />
            <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} allowDecimals={false} />
            <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 11 }} />
            <Bar dataKey="entries" fill="var(--primary)" radius={[4, 4, 0, 0]} name="Entries" barSize={20} />
            <Bar dataKey="exits"   fill="#f43f5e"        radius={[4, 4, 0, 0]} name="Exits"   barSize={20} opacity={0.7} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ─── Table view ─────────────────────────────────── */
function TableView({ rows, onSelect, selected }: { rows: any[]; onSelect: (d: string) => void; selected: string | null }) {
  return (
    <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 text-left text-[9px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
              <th className="px-5 py-3">Date</th>
              <th className="px-5 py-3">Day</th>
              <th className="px-5 py-3 text-emerald-600">Entries</th>
              <th className="px-5 py-3 text-rose-500">Exits</th>
              <th className="px-5 py-3">Peak Hour</th>
              <th className="px-5 py-3">Avg Occ %</th>
              <th className="px-5 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map(r => (
              <motion.tr
                key={r.date}
                onClick={() => onSelect(r.date)}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                className={cn('cursor-pointer transition-colors group', selected === r.date ? 'bg-primary/5' : 'hover:bg-muted/40')}
              >
                <td className="px-5 py-3 font-semibold">{r.date}</td>
                <td className="px-5 py-3 text-muted-foreground">{r.day}</td>
                <td className="px-5 py-3 text-emerald-600 font-bold">{r.entries}</td>
                <td className="px-5 py-3 text-rose-500 font-bold">{r.exits}</td>
                <td className="px-5 py-3 text-muted-foreground">{r.peak_hour != null ? `${r.peak_hour}:00` : '—'}</td>
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <div className="w-14 h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-primary rounded-full" style={{ width: `${Math.min(r.avg_occupancy_pct, 100)}%` }} />
                    </div>
                    <span className="text-[10px] text-muted-foreground">{r.avg_occupancy_pct}%</span>
                  </div>
                </td>
                <td className="px-5 py-3">
                  <span className="text-[10px] font-bold text-primary opacity-0 group-hover:opacity-100 transition-opacity uppercase tracking-wide">Details →</span>
                </td>
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── Day drill-down panel ────────────────────────── */
function DrillDown({ storeId, date, accessToken, scopeHeaders, onClose }: any) {
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setDetail(null);
    apiRequest(`${RETAIL_BASE}/stores/${storeId}/reports/${date}`, { method: 'GET', accessToken, scopeHeaders })
      .then(setDetail).catch(() => {}).finally(() => setLoading(false));
  }, [storeId, date]);

  const hourlyChart = (detail?.hourly ?? []).map((h: any) => ({ hour: `${h.hour}:00`, entries: h.entries, exits: h.exits }));

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
      className="bg-card border border-border rounded-2xl shadow-lg p-5"
    >
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-[9px] font-bold text-muted-foreground uppercase tracking-widest">Day Breakdown</p>
          <p className="text-base font-bold text-foreground">{format(new Date(date + 'T12:00:00Z'), 'EEE, MMM d')}</p>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-32">
          <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : detail ? (
        <>
          <div className="grid grid-cols-3 gap-3 mb-4">
            {[
              { label: 'Entries', value: detail.totals?.entries, color: 'text-emerald-600' },
              { label: 'Exits',   value: detail.totals?.exits,   color: 'text-rose-500' },
              { label: 'Avg Occ', value: `${detail.avg_occupancy_pct}%`, color: 'text-primary' },
            ].map(({ label, value, color }) => (
              <div key={label} className="text-center p-3 rounded-xl bg-muted/50">
                <p className="text-[9px] text-muted-foreground mb-1">{label}</p>
                <p className={cn('text-xl font-bold', color)}>{value}</p>
              </div>
            ))}
          </div>

          {detail.vs_last_week?.change_pct != null && (
            <div className={cn(
              'flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold mb-4',
              detail.vs_last_week.change_pct >= 0
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-400'
                : 'bg-rose-50 text-rose-600 dark:bg-rose-950/20 dark:text-rose-400'
            )}>
              {detail.vs_last_week.change_pct >= 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
              {Math.abs(detail.vs_last_week.change_pct)}% vs last week ({detail.vs_last_week.entries} entries)
            </div>
          )}

          <div className="h-[160px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hourlyChart} margin={{ top: 0, right: 0, left: -28, bottom: 0 }}>
                <XAxis dataKey="hour" axisLine={false} tickLine={false} tick={{ fontSize: 8, fill: 'var(--muted-foreground)' }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 8, fill: 'var(--muted-foreground)' }} allowDecimals={false} />
                <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 10 }} />
                <Bar dataKey="entries" fill="#22c55e"              radius={[3, 3, 0, 0]} name="Entries" barSize={14} />
                <Bar dataKey="exits"   fill="#f43f5e" opacity={0.7} radius={[3, 3, 0, 0]} name="Exits"   barSize={14} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground text-center py-6">No detail data available</p>
      )}
    </motion.div>
  );
}

/* ─── Main component ──────────────────────────────── */
export const RetailReports: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const { selectedStoreId: globalStoreId } = useGlobalRetailStore();

  const [storeId, setStoreId]   = useState<string | null>(null);
  const [rows, setRows]         = useState<any[]>([]);
  const [days, setDays]         = useState(30);
  const [view, setView]         = useState<ViewMode>('TIMELINE');
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading]   = useState(false);
  const [streaming, setStreaming] = useState(false);

  useEffect(() => {
    if (!accessToken) return;
    apiRequest(`${RETAIL_BASE}/stores`, { method: 'GET', accessToken, scopeHeaders })
      .then((r: any) => {
        if (r.stores?.length) {
          if (globalStoreId && globalStoreId !== 'all') {
            setStoreId(globalStoreId);
          } else {
            setStoreId(r.stores[0].id);
          }
        }
      })
      .catch(() => {});
  }, [accessToken, scopeHeaders, globalStoreId]);

  const loadRows = useCallback(() => {
    if (!storeId || !accessToken) return;
    setLoading(true);
    setStreaming(true);
    apiRequest(`${RETAIL_BASE}/stores/${storeId}/reports?days=${days}`, {
      method: 'GET', accessToken, scopeHeaders,
    })
      .then((r: any) => setRows(r.reports ?? []))
      .finally(() => { setLoading(false); setTimeout(() => setStreaming(false), 1200); });
  }, [storeId, days, accessToken]);

  useEffect(() => { loadRows(); }, [loadRows]);

  const totals   = rows.reduce((a, r) => ({ entries: a.entries + r.entries, exits: a.exits + r.exits }), { entries: 0, exits: 0 });
  const peakRow  = rows.reduce((b: any, r) => r.entries > (b?.entries ?? 0) ? r : b, null);
  const avgEntry = rows.length ? Math.round(totals.entries / rows.length) : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-primary mb-1">Data Logs</div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Reports</h1>
            <div className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[9px] font-bold uppercase tracking-widest border transition-colors',
              streaming
                ? 'bg-blue-50 border-blue-200 text-blue-600 dark:bg-blue-950/30 dark:border-blue-800 dark:text-blue-400'
                : 'bg-muted border-border text-muted-foreground'
            )}>
              <span className={cn('w-1.5 h-1.5 rounded-full', streaming ? 'bg-blue-500 animate-pulse' : 'bg-muted-foreground/50')} />
              {streaming ? 'Streaming' : 'Ready'}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* days toggle */}
          <div className="flex bg-muted rounded-xl p-1 gap-0.5">
            {[30, 60, 90].map(d => (
              <button key={d} onClick={() => setDays(d)}
                className={cn('px-3 py-1.5 text-[11px] font-semibold rounded-lg transition-colors',
                  days === d ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                )}>{d}d</button>
            ))}
          </div>

          {/* view tabs */}
          <div className="flex bg-muted rounded-xl p-1 gap-0.5">
            {(['TABLE', 'TIMELINE', 'CALENDAR', 'GRAPH'] as ViewMode[]).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={cn('px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide rounded-lg transition-colors',
                  view === v ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                )}>{v}</button>
            ))}
          </div>

          {/* Export */}
          <button onClick={loadRows}
            className="flex items-center gap-2 px-4 py-2 bg-foreground text-background rounded-xl text-[10px] font-bold uppercase tracking-widest hover:opacity-90 transition-all active:scale-95">
            <Download className="w-3.5 h-3.5" /> Export
          </button>
        </div>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Total Entries', value: loading ? '…' : totals.entries.toLocaleString(), color: 'text-emerald-600 dark:text-emerald-400' },
          { label: 'Avg / Day',     value: loading ? '…' : avgEntry.toLocaleString(),         color: 'text-primary' },
          { label: 'Peak Day',      value: loading ? '…' : (peakRow?.day ?? '—'),              color: 'text-foreground', sub: peakRow ? `${peakRow.entries} entries` : '' },
        ].map(({ label, value, color, sub }: any) => (
          <div key={label} className="bg-card border border-border rounded-2xl p-5 shadow-sm text-center">
            <p className="text-[9px] font-bold text-muted-foreground uppercase tracking-[0.08em] mb-2">{label}</p>
            <p className={cn('text-2xl font-bold', color)}>{value}</p>
            {sub && <p className="text-[10px] text-muted-foreground mt-1">{sub}</p>}
          </div>
        ))}
      </div>

      {/* Main content */}
      {loading ? (
        <div className="flex items-center justify-center h-48">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground text-sm">No data for this period.</div>
      ) : (
        <AnimatePresence mode="wait">
          <motion.div key={view} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
            {view === 'TIMELINE' && (
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5 items-start">
                <div className="space-y-0">
                  {rows.map((row, i) => (
                    <TimelineRow
                      key={row.date} row={row} index={i}
                      onClick={() => setSelected(sel => sel === row.date ? null : row.date)}
                      isSelected={selected === row.date}
                    />
                  ))}
                </div>
                <AnimatePresence>
                  {selected && storeId && (
                    <div className="lg:sticky lg:top-6">
                      <DrillDown
                        storeId={storeId} date={selected}
                        accessToken={accessToken} scopeHeaders={scopeHeaders}
                        onClose={() => setSelected(null)}
                      />
                    </div>
                  )}
                </AnimatePresence>
              </div>
            )}

            {view === 'TABLE' && (
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5 items-start">
                <TableView rows={rows} onSelect={d => setSelected(s => s === d ? null : d)} selected={selected} />
                <AnimatePresence>
                  {selected && storeId && (
                    <div className="lg:sticky lg:top-6">
                      <DrillDown
                        storeId={storeId} date={selected}
                        accessToken={accessToken} scopeHeaders={scopeHeaders}
                        onClose={() => setSelected(null)}
                      />
                    </div>
                  )}
                </AnimatePresence>
              </div>
            )}

            {view === 'CALENDAR' && (
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5 items-start">
                <div className="bg-card border border-border rounded-2xl p-6 shadow-sm">
                  <CalendarView rows={rows} onSelect={d => setSelected(s => s === d ? null : d)} selected={selected} />
                </div>
                <AnimatePresence>
                  {selected && storeId && (
                    <div className="lg:sticky lg:top-6">
                      <DrillDown
                        storeId={storeId} date={selected}
                        accessToken={accessToken} scopeHeaders={scopeHeaders}
                        onClose={() => setSelected(null)}
                      />
                    </div>
                  )}
                </AnimatePresence>
              </div>
            )}

            {view === 'GRAPH' && <GraphView rows={rows} />}
          </motion.div>
        </AnimatePresence>
      )}
    </div>
  );
};
