import React, { useMemo } from 'react';
import { Layers, Check, LogIn, LogOut, Users, BarChart3, Clock, CheckSquare, Activity } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import type { CompareData, CompareGranularity, CompareMetric, ZoneListItem } from '../lib/types';
import { DOW_LABELS, fmtMinutes, hourLabel, zoneColor } from '../lib/format';
import { WidgetState } from '../lib/ViewHeader';

export interface CompareZonesDashboardProps {
  zones: ZoneListItem[];
  selected: string[];
  onSelectedChange: (zones: string[]) => void;
  metric: CompareMetric;
  onMetricChange: (m: CompareMetric) => void;
  granularity: CompareGranularity;
  onGranularityChange: (g: CompareGranularity) => void;
  data: CompareData | null;
  error?: string | null;
  loading?: boolean;
  /** Date-range control rendered in the header (owned by the page). */
  rangeControls?: React.ReactNode;
}

const bucketLabel = (b: number | string, g: CompareGranularity) => {
  if (g === 'hour') return hourLabel(Number(b));
  if (g === 'dow') return DOW_LABELS[Number(b)] ?? String(b);
  const d = new Date(`${String(b).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? String(b) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

/** Compare Zones — side by side (Req 8): selector, profile cards, metric/granularity tabs, chart, KPI matrix. */
export const CompareZonesDashboard: React.FC<CompareZonesDashboardProps> = ({
  zones, selected, onSelectedChange, metric, onMetricChange, granularity, onGranularityChange, data, error, loading, rangeControls,
}) => {
  const byEntries = useMemo(() => [...zones].sort((a, b) => b.entries - a.entries), [zones]);
  const canCompare = selected.length >= 2;
  const colorOf = (name: string) => zoneColor(Math.max(0, zones.findIndex((z) => z.zone === name)));

  const toggle = (name: string) => onSelectedChange(selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name]);
  const selectAll = () => onSelectedChange(zones.map((z) => z.zone));
  const busiest = () => onSelectedChange(byEntries.slice(0, 3).map((z) => z.zone));
  const defaultTwo = () => onSelectedChange(byEntries.slice(0, 2).map((z) => z.zone));

  const compared = data ? selected.filter((n) => data.zones[n]) : [];
  const rows = useMemo(() => {
    if (!data) return [] as Record<string, any>[];
    const byBucket = new Map<string, Record<string, any>>();
    for (const name of Object.keys(data.zones)) {
      for (const p of data.zones[name].series) {
        const key = String(p.bucket);
        const row = byBucket.get(key) ?? { bucket: p.bucket, label: bucketLabel(p.bucket, data.granularity) };
        row[name] = p.value ?? null;
        row[`${name}__in`] = p.entries ?? null;
        row[`${name}__out`] = p.exits ?? null;
        byBucket.set(key, row);
      }
    }
    return [...byBucket.values()].sort((a, b) => (typeof a.bucket === 'number' ? a.bucket - b.bucket : String(a.bucket).localeCompare(String(b.bucket))));
  }, [data]);

  const gridCls = compared.length <= 2 ? 'grid-cols-1 md:grid-cols-2' : compared.length === 3 ? 'grid-cols-1 md:grid-cols-3' : compared.length === 4 ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4' : 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6';
  const tab = (m: CompareMetric, id: string, label: string, Icon: React.ComponentType<{ className?: string }>) => (
    <button type="button" id={id} aria-pressed={metric === m} onClick={() => onMetricChange(m)} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-all cursor-pointer ${metric === m ? 'bg-white text-blue-600 shadow-xs' : 'text-slate-600 hover:text-slate-900'}`}>
      <Icon className="w-3.5 h-3.5 text-blue-600" /><span>{label}</span>
    </button>
  );
  const gran = (g: CompareGranularity, label: string) => (
    <button type="button" aria-pressed={granularity === g} onClick={() => onGranularityChange(g)} className={`px-3 py-1 rounded-md font-medium transition-all cursor-pointer ${granularity === g ? 'bg-white text-blue-600 shadow-xs' : 'text-slate-600 hover:text-slate-900'}`}>
      {label}
    </button>
  );
  const net = (n: number) => (n >= 0 ? `+${n}` : String(n));

  return (
    <div id="compare-zones-dashboard-container" className="glass-card rounded-2xl p-5 sm:p-6 space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-200/60">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-blue-600 flex items-center justify-center text-white shadow-sm shadow-blue-500/25"><Layers className="w-5 h-5 text-white" /></div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base sm:text-lg font-medium text-slate-900 tracking-tight">Compare Zones – Side-by-Side</h2>
              <span data-testid="selected-count" className="text-[10px] font-bold uppercase tracking-wider bg-blue-500/10 text-blue-600 px-2 py-0.5 rounded-full border border-blue-500/20">{selected.length} Zones Selected</span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">Compare how busy each zone is, how many people come and go, and how long they stay</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg border border-slate-200 text-xs">
            <span className="text-[10px] font-bold text-slate-400 uppercase px-2">Presets:</span>
            <button type="button" id="btn-preset-all" onClick={selectAll} className="px-2 py-0.5 rounded hover:bg-white text-slate-600 hover:text-slate-900 text-xs font-medium transition-colors cursor-pointer">All ({zones.length})</button>
            <button type="button" id="btn-preset-busiest" onClick={busiest} className="px-2 py-0.5 rounded hover:bg-white text-slate-600 hover:text-slate-900 text-xs font-medium transition-colors cursor-pointer">Busiest zones</button>
          </div>
          {rangeControls}
        </div>
      </div>

      <div className="bg-slate-50 border border-slate-200/90 rounded-xl p-3 sm:p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            <CheckSquare className="w-4 h-4 text-blue-600" />
            <span className="text-xs font-bold text-slate-800 uppercase tracking-wide">Select Zones to Compare ({selected.length} of {zones.length})</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <button type="button" onClick={selectAll} className="text-blue-600 hover:text-blue-800 font-semibold cursor-pointer">Select All</button>
            <span className="text-slate-300">•</span>
            <button type="button" onClick={defaultTwo} className="text-slate-500 hover:text-slate-700 font-medium cursor-pointer">Default (2)</button>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
          {zones.map((zone, i) => {
            const isSelected = selected.includes(zone.zone);
            return (
              <button
                key={zone.zone}
                type="button"
                id={`compare-zone-toggle-${i}`}
                aria-pressed={isSelected}
                data-zone={zone.zone}
                onClick={() => toggle(zone.zone)}
                className={`flex flex-col p-2.5 rounded-xl text-left border transition-all relative cursor-pointer ${isSelected ? 'bg-white border-blue-500 shadow-sm ring-2 ring-blue-500/20' : 'bg-white/60 border-slate-200 hover:bg-white hover:border-slate-300 opacity-70 hover:opacity-100'}`}
              >
                <div className="flex items-center justify-between gap-1 mb-1.5">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: zoneColor(i) }} />
                  <div className={`w-4 h-4 rounded flex items-center justify-center text-[10px] transition-colors ${isSelected ? 'bg-blue-600 text-white' : 'border border-slate-300 bg-slate-50'}`}>{isSelected && <Check className="w-3 h-3 stroke-[3]" />}</div>
                </div>
                <div className="font-semibold text-xs text-slate-900 truncate">{zone.zone}</div>
                <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-slate-100 text-[10px] text-slate-500">
                  <span>Live: <strong className="text-slate-800">{zone.liveHeadcount}</strong></span>
                  <span>Peak: <strong className="text-slate-700">{zone.peak}</strong></span>
                </div>
              </button>
            );
          })}
          {zones.length === 0 && <WidgetState loading={loading} empty emptyText="No zones with recorded activity." />}
        </div>
      </div>

      {!canCompare ? (
        <div data-testid="compare-zones-empty-state" className="rounded-2xl border border-slate-200 bg-white flex flex-col items-center justify-center gap-2 py-16 text-slate-400">
          <Layers className="w-8 h-8 opacity-30" />
          <p className="text-sm font-semibold text-slate-500">Select at least 2 zones to compare.</p>
        </div>
      ) : (
        <>
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2"><BarChart3 className="w-4 h-4 text-blue-600" /><h3 className="text-sm font-bold text-slate-900 tracking-tight">Zone Profiles</h3></div>
              <div className="text-xs text-slate-400 font-medium">
                Combined Headcount: <strong data-testid="aggregate-live">{data?.aggregate.liveHeadcount ?? '—'}</strong> • Highest Peak: <strong>{data?.aggregate.peak ?? '—'}</strong>
              </div>
            </div>
            {!data ? (
              <WidgetState error={error} loading={loading} empty emptyText="No comparison data yet." />
            ) : (
              <div className={`grid gap-3 ${gridCls}`}>
                {compared.map((name) => {
                  const p = data.zones[name].profile;
                  const color = colorOf(name);
                  return (
                    <div key={name} data-testid="zone-profile" data-zone={name} className="bg-white border rounded-xl p-4 shadow-2xs hover:shadow-xs transition-all relative overflow-hidden flex flex-col justify-between" style={{ borderColor: `${color}40` }}>
                      <div className="absolute top-0 left-0 right-0 h-1" style={{ backgroundColor: color }} />
                      <div>
                        <h4 className="font-bold text-sm text-slate-900 leading-tight mt-1">{name}</h4>
                        <p className="text-[11px] text-slate-400 line-clamp-1 mt-0.5">{p.primaryDepartment ?? '—'}</p>
                        <div className="mt-3.5 space-y-1">
                          <div className="flex justify-between items-center text-xs"><span className="text-slate-500 font-medium">Headcount</span><span className="font-bold text-slate-900">{p.liveHeadcount ?? '—'} <span className="text-slate-400 font-normal">inside</span></span></div>
                          <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden"><div className="h-full rounded-full transition-all duration-500" style={{ width: `${p.pctOfPeak ?? 0}%`, backgroundColor: color }} /></div>
                          <div className="flex justify-between items-center text-[10px] text-slate-400"><span>Peak: {p.peak ?? '—'}</span><span className="font-semibold text-slate-600">{p.pctOfPeak === null ? '—' : `${p.pctOfPeak}% of Peak`}</span></div>
                        </div>
                        <div className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-slate-100 text-xs">
                          <div className="bg-slate-50 p-2 rounded-lg"><div className="text-[10px] text-slate-400 uppercase font-semibold flex items-center gap-1"><LogIn className="w-3 h-3 text-emerald-600" />Entries</div><div className="text-xs font-bold text-slate-900 mt-0.5">{p.entries.toLocaleString()}</div></div>
                          <div className="bg-slate-50 p-2 rounded-lg"><div className="text-[10px] text-slate-400 uppercase font-semibold flex items-center gap-1"><LogOut className="w-3 h-3 text-amber-600" />Exits</div><div className="text-xs font-bold text-slate-900 mt-0.5">{p.exits.toLocaleString()}</div></div>
                          <div className="bg-slate-50 p-2 rounded-lg"><div className="text-[10px] text-slate-400 uppercase font-semibold flex items-center gap-1"><Clock className="w-3 h-3 text-blue-600" />Avg Stay</div><div className="text-xs font-bold text-slate-900 mt-0.5">{fmtMinutes(p.avgDwellMinutes)}</div></div>
                        </div>
                      </div>
                      <div className="mt-3 pt-2 border-t border-slate-100 flex items-center justify-between text-[10px] text-slate-400">
                        <span>Entrances: {p.entrances}</span>
                        <span className="font-semibold text-slate-700 font-mono">{p.entries + p.exits} Total</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4 border-b border-slate-100">
              <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg border border-slate-200 text-xs" role="group" aria-label="Metric">
                {tab('occupancy', 'compare-tab-occupancy', 'Concurrent Occupancy', Users)}
                {tab('traffic', 'compare-tab-traffic', 'Traffic Influx/Egress', Activity)}
                {tab('dwell', 'compare-tab-dwell', 'Average Dwell Time', Clock)}
              </div>
              <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg border border-slate-200 text-xs" role="group" aria-label="Time grouping">
                {gran('hour', '24-Hour')}
                {gran('dow', 'Day of Week')}
                {gran('week', 'Multi-Week')}
              </div>
            </div>
            <div className="mt-4">
              <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
                <span className="font-semibold text-slate-800">
                  {metric === 'occupancy' ? 'Side-by-Side Headcount (peak employees inside)' : metric === 'traffic' ? 'Comparative Entries and Exits' : 'Comparative Average Stay (minutes)'}
                </span>
                <span className="text-[11px] text-slate-400">Comparing {compared.length} zones</span>
              </div>
              <div className="h-80 w-full">
                {rows.length === 0 ? (
                  <WidgetState error={error} loading={loading} empty emptyText="No activity recorded for these zones in this period." />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    {metric === 'traffic' ? (
                      <BarChart data={rows} margin={{ top: 10, right: 20, left: -10, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                        <XAxis dataKey="label" stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={{ stroke: '#cbd5e1' }} />
                        <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={{ stroke: '#cbd5e1' }} allowDecimals={false} />
                        <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderRadius: '8px', border: 'none', color: '#fff', fontSize: '11px' }} />
                        <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                        {compared.flatMap((name) => [
                          <Bar key={`${name}-in`} dataKey={`${name}__in`} name={`${name} entries`} fill={colorOf(name)} radius={[4, 4, 0, 0]} />,
                          <Bar key={`${name}-out`} dataKey={`${name}__out`} name={`${name} exits`} fill={colorOf(name)} fillOpacity={0.45} radius={[4, 4, 0, 0]} />,
                        ])}
                      </BarChart>
                    ) : (
                      <LineChart data={rows} margin={{ top: 10, right: 20, left: -10, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                        <XAxis dataKey="label" stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={{ stroke: '#cbd5e1' }} />
                        <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={{ stroke: '#cbd5e1' }} unit={metric === 'dwell' ? 'm' : ''} allowDecimals={false} />
                        <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderRadius: '8px', border: 'none', color: '#fff', fontSize: '11px' }} />
                        <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                        {compared.map((name) => <Line key={name} type="monotone" dataKey={name} name={name} stroke={colorOf(name)} strokeWidth={2.5} dot={false} connectNulls activeDot={{ r: 5, strokeWidth: 1, stroke: '#fff' }} />)}
                      </LineChart>
                    )}
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 overflow-x-auto">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">Key Performance Metrics Matrix</span>
              <span className="text-[11px] text-slate-500">Side-by-side zone comparison</span>
            </div>
            <table className="w-full text-left text-xs border-collapse" data-testid="metrics-matrix">
              <thead>
                <tr className="border-b border-slate-200 text-slate-400 text-[10px] uppercase font-bold tracking-wider">
                  <th className="py-2 px-3">Zone</th><th className="py-2 px-3">Live Headcount</th><th className="py-2 px-3">Peak</th><th className="py-2 px-3">Total Entries</th><th className="py-2 px-3">Total Exits</th><th className="py-2 px-3">Net Flow</th><th className="py-2 px-3">Average Dwell</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/60 font-medium text-slate-700">
                {(data?.matrix ?? []).map((z) => (
                  <tr key={z.zone} data-testid="matrix-row" className="hover:bg-white transition-colors">
                    <td className="py-2.5 px-3"><div className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: colorOf(z.zone) }} /><span className="font-bold text-slate-900">{z.zone}</span></div></td>
                    <td className="py-2.5 px-3 font-bold text-slate-900">{z.liveHeadcount ?? '—'}</td>
                    <td className="py-2.5 px-3 font-semibold text-slate-700">{z.peak ?? '—'}</td>
                    <td className="py-2.5 px-3 font-semibold text-emerald-700">+{z.entries.toLocaleString()}</td>
                    <td className="py-2.5 px-3 font-semibold text-amber-700">-{z.exits.toLocaleString()}</td>
                    <td className="py-2.5 px-3 font-semibold"><span className={z.net >= 0 ? 'text-emerald-600' : 'text-amber-600'}>{net(z.net)}</span></td>
                    <td className="py-2.5 px-3">{fmtMinutes(z.avgDwellMinutes)}</td>
                  </tr>
                ))}
              </tbody>
              {data && (
                <tfoot>
                  <tr data-testid="matrix-aggregate" className="border-t-2 border-slate-300 font-bold text-slate-900 bg-slate-100/70">
                    <td className="py-2.5 px-3">Selected Zones Combined ({data.matrix.length})</td>
                    <td className="py-2.5 px-3">{data.aggregate.liveHeadcount ?? '—'}</td>
                    <td className="py-2.5 px-3" title="Highest peak of any single selected zone">{data.aggregate.peak ?? '—'}</td>
                    <td className="py-2.5 px-3 text-emerald-700">+{data.aggregate.entries.toLocaleString()}</td>
                    <td className="py-2.5 px-3 text-amber-700">-{data.aggregate.exits.toLocaleString()}</td>
                    <td className="py-2.5 px-3"><span className={data.aggregate.net >= 0 ? 'text-emerald-700' : 'text-amber-700'}>{net(data.aggregate.net)}</span></td>
                    <td className="py-2.5 px-3">{fmtMinutes(data.aggregate.avgDwellMinutes)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      )}
    </div>
  );
};
