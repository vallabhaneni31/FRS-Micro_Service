import React from 'react';
import { UserCheck, Clock, LogIn, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { ZoneSummary } from '../lib/types';
import { fmtMinutes, fmtNumber, windowLabel } from '../lib/format';
import { KPI_COPY } from '../lib/copy';
import { WidgetState } from '../lib/ViewHeader';

interface Props {
  summary: ZoneSummary | null;
  /** Names the scope shown, e.g. "All zones" or the selected zone names. */
  scopeName: string;
  error?: string | null;
  loading?: boolean;
}

/** The 3 hero cards — Zone Headcount, Net Entry/Exit Flow, Average Time Inside (Req 6.1). Every figure is computed. */
export const ZoneHeroKpis: React.FC<Props> = ({ summary, scopeName, error, loading }) => {
  const h = summary?.headcount;
  const f = summary?.flow;
  const d = summary?.dwell;
  const change = h?.changeVs1hPct ?? null;
  const pctOfPeak = h?.pctOfPeak ?? null;

  return (
    <div id="kpi-metrics-section" className="space-y-4">
      <div>
        <div className="flex items-center justify-between pb-2 mb-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-slate-900 tracking-tight">Core Vital Indicators</h2>
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live
            </span>
          </div>
          <span className="text-xs text-slate-500 hidden sm:inline">
            Monitored: <strong className="text-slate-800">{scopeName}</strong>
          </span>
        </div>

        {error && !summary ? (
          <WidgetState error={error} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Card 1 — Zone Headcount */}
            <div id="hero-kpi-occupancy" data-testid="hero-headcount" className="glass-card rounded-xl p-4 transition-all flex flex-col justify-between">
              <div>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-600"><UserCheck className="w-4 h-4" /></div>
                    <div>
                      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider block">{KPI_COPY.headcount.title}</span>
                      <span className="text-[11px] text-slate-400 font-medium">{KPI_COPY.headcount.description}</span>
                    </div>
                  </div>
                  <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 border border-blue-500/20 whitespace-nowrap">
                    {pctOfPeak === null ? '—' : `${pctOfPeak}% of Peak`}
                  </span>
                </div>
                <div className="mt-3.5 flex items-baseline gap-2">
                  <span data-testid="hero-headcount-value" className="text-3xl font-black text-slate-900 tracking-tight font-mono">{fmtNumber(h?.current)}</span>
                  <span className="text-xs text-slate-500 font-medium">employees inside</span>
                </div>
                <div className="mt-3 space-y-1">
                  <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden p-0.5 border border-slate-200/60">
                    <div className="h-full rounded-full transition-all duration-500 bg-blue-600" style={{ width: `${pctOfPeak ?? 0}%` }} />
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono">
                    <span>Live Headcount</span>
                    <span>Avg: {fmtNumber(h?.average)}</span>
                    <span>Peak: {fmtNumber(h?.peak)}</span>
                  </div>
                </div>
              </div>
              <div className="mt-4 pt-2.5 border-t border-slate-100 flex items-center justify-between text-xs">
                <span data-testid="hero-change" className={`inline-flex items-center gap-1 text-[11px] font-medium ${change === null ? 'text-slate-400' : change >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                  {change === null ? <Minus className="w-3.5 h-3.5" /> : change >= 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                  {change === null ? '—' : `${change >= 0 ? '+' : ''}${change}%`}
                </span>
                <span className="text-[11px] text-slate-400 font-medium">vs. 1h ago</span>
              </div>
            </div>

            {/* Card 2 — Net Entry/Exit Flow */}
            <div id="hero-kpi-flow" data-testid="hero-flow" className="glass-card rounded-xl p-4 transition-all flex flex-col justify-between">
              <div>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-600"><LogIn className="w-4 h-4" /></div>
                    <div>
                      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider block">{KPI_COPY.flow.title}</span>
                      <span className="text-[11px] text-slate-400 font-medium">{KPI_COPY.flow.description}</span>
                    </div>
                  </div>
                  <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 border border-emerald-500/20 whitespace-nowrap">
                    {f?.net === null || f?.net === undefined ? '—' : `${f.net > 0 ? '+' : ''}${f.net} Net`}
                  </span>
                </div>
                <div className="mt-3.5 grid grid-cols-2 gap-2">
                  <div className="p-2 rounded-lg bg-slate-50 border border-slate-100">
                    <span className="text-[10px] font-semibold text-slate-500 uppercase block">Entries</span>
                    <div data-testid="hero-entries" className="text-xl font-extrabold text-slate-900 font-mono mt-0.5">{fmtNumber(f?.entries)}</div>
                  </div>
                  <div className="p-2 rounded-lg bg-slate-50 border border-slate-100">
                    <span className="text-[10px] font-semibold text-slate-500 uppercase block">Exits</span>
                    <div data-testid="hero-exits" className="text-xl font-extrabold text-slate-900 font-mono mt-0.5">{fmtNumber(f?.exits)}</div>
                  </div>
                </div>
                <div className="mt-3 space-y-1">
                  <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden flex">
                    <div className="bg-blue-600 h-full transition-all" style={{ width: `${f?.pctIn ?? 0}%` }} title={`Entries: ${f?.pctIn ?? 0}%`} />
                    <div className="bg-slate-400 h-full transition-all" style={{ width: `${f?.pctOut ?? 0}%` }} title={`Exits: ${f?.pctOut ?? 0}%`} />
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-slate-500">
                    <span className="text-blue-600 font-medium">{f?.pctIn === null || f?.pctIn === undefined ? '—' : `${f.pctIn}% Entries`}</span>
                    <span className="text-slate-500 font-medium">{f?.pctOut === null || f?.pctOut === undefined ? '—' : `${f.pctOut}% Exits`}</span>
                  </div>
                </div>
              </div>
              <div className="mt-4 pt-2.5 border-t border-slate-100 flex items-center justify-between text-xs">
                <span className="text-[11px] text-slate-400 font-medium">Unique: {fmtNumber(f?.uniqueEmployees)} employees</span>
              </div>
            </div>

            {/* Card 3 — Average Time Inside */}
            <div id="hero-kpi-dwell" data-testid="hero-dwell" className="glass-card rounded-xl p-4 transition-all flex flex-col justify-between">
              <div>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-600"><Clock className="w-4 h-4" /></div>
                    <div>
                      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider block">{KPI_COPY.dwell.title}</span>
                      <span className="text-[11px] text-slate-400 font-medium">{KPI_COPY.dwell.description}</span>
                    </div>
                  </div>
                  <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200">Per visit</span>
                </div>
                <div className="mt-3.5 flex items-baseline gap-2">
                  <span data-testid="hero-dwell-value" className="text-3xl font-black text-slate-900 tracking-tight font-mono">{fmtMinutes(d?.avgVisitMinutes)}</span>
                  <span className="text-xs text-slate-400 font-medium">/ visit</span>
                </div>
                <div className="mt-3 p-2 rounded-lg bg-slate-50 border border-slate-100/80 space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-500">Busiest Entry Time:</span>
                    <span data-testid="hero-peak-inflow" className="font-mono font-semibold text-slate-800">{windowLabel(d?.peakInflowWindow)}</span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-500">Busiest Exit Time:</span>
                    <span data-testid="hero-peak-egress" className="font-mono font-semibold text-slate-800">{windowLabel(d?.peakEgressWindow)}</span>
                  </div>
                </div>
              </div>
              <div className="mt-4 pt-2.5 border-t border-slate-100 flex items-center justify-between text-xs">
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600">
                  <TrendingDown className="w-3.5 h-3.5 text-blue-600" />
                  Per day: {fmtMinutes(d?.avgTimeInsideMinutes)}
                </span>
                <span className="text-[11px] text-slate-400 font-medium">{d?.totalVisits === null || d?.totalVisits === undefined ? '—' : `${d.totalVisits.toLocaleString()} visits`}</span>
              </div>
            </div>
          </div>
        )}
        {loading && !summary && <div className="text-center text-xs text-slate-400 py-2">Loading…</div>}
      </div>
    </div>
  );
};
