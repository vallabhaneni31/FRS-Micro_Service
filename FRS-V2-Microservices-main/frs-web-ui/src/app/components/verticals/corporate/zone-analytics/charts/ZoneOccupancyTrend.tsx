import React, { useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Layers } from 'lucide-react';
import type { OccupancySeriesPoint, ZoneListItem } from '../lib/types';
import { seriesLabel, zoneColor } from '../lib/format';
import { KPI_COPY } from '../lib/copy';
import { WidgetState } from '../lib/ViewHeader';

export type TrendMode = 'hourly' | 'daily' | 'weekly';
const MODE_TO_GRANULARITY = { hourly: 'hour', daily: 'day', weekly: 'week' } as const;

interface Props {
  zones: ZoneListItem[];
  /** Real occupancy series per view mode (one row per zone per bucket). */
  series: Record<TrendMode, OccupancySeriesPoint[]>;
  cameras: { online: number; total: number } | null;
  error?: string | null;
  loading?: boolean;
  /** Called when the toggle changes so the page can (re)load that series. */
  onModeChange?: (mode: TrendMode) => void;
}

/** Zone Occupancy Trend: Hourly/Daily/Weekly toggle, one line per zone, zone chips, stat tiles (Req 6.3). */
export const ZoneOccupancyTrend: React.FC<Props> = ({ zones, series, cameras, error, loading, onModeChange }) => {
  const [viewMode, setViewMode] = useState<TrendMode>('hourly');
  const [highlighted, setHighlighted] = useState<string | null>(null);

  const colorOf = useMemo(() => new Map(zones.map((z, i) => [z.zone, zoneColor(i)])), [zones]);
  const points = series[viewMode] ?? [];
  const granularity = MODE_TO_GRANULARITY[viewMode];

  // One row per bucket, one key per zone.
  const data = useMemo(() => {
    const byTs = new Map<string, Record<string, number | string>>();
    for (const p of points) {
      const row = byTs.get(p.ts) ?? { time: seriesLabel(p.ts, granularity), _ts: p.ts };
      row[p.zone] = p.count;
      byTs.set(p.ts, row);
    }
    return [...byTs.values()].sort((a, b) => String(a._ts).localeCompare(String(b._ts)));
  }, [points, granularity]);

  const plotted = zones.filter((z) => points.some((p) => p.zone === z.zone));
  const activeCount = zones.reduce((s, z) => s + (z.liveHeadcount || 0), 0);
  const peakZone = zones.length ? [...zones].sort((a, b) => b.peak - a.peak)[0] : null;
  const activeZones = zones.filter((z) => z.liveHeadcount > 0).length;

  const changeMode = (m: TrendMode) => {
    setViewMode(m);
    onModeChange?.(m);
  };

  return (
    <div id="chart-zone-occupancy-trend" className="bg-white rounded-xl border border-slate-200 p-5 shadow-2xs hover:shadow-xs transition-all flex flex-col justify-between">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-blue-600"></div>
            <h3 className="text-sm font-bold text-slate-900 tracking-tight">Zone Occupancy Trend</h3>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200">
              {plotted.length === 1 ? plotted[0].zone : `${plotted.length} Zones Plotted`}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">Employees inside each zone over time, one line per zone</p>
        </div>

        <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs self-start sm:self-auto" role="group" aria-label="Trend period">
          {(['hourly', 'daily', 'weekly'] as TrendMode[]).map((m) => (
            <button
              key={m}
              id={`trend-view-${m}`}
              type="button"
              aria-pressed={viewMode === m}
              onClick={() => changeMode(m)}
              className={`px-3 py-1 rounded-md font-semibold transition-all cursor-pointer ${viewMode === m ? 'bg-white text-blue-700 shadow-xs' : 'text-slate-600 hover:text-slate-900'}`}
            >
              {m === 'hourly' ? 'Hourly' : m === 'daily' ? 'Daily' : 'Weekly'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-3 pb-1">
        <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
          <Layers className="w-3.5 h-3.5" />
          Zones:
        </span>
        {zones.map((zone) => {
          const color = colorOf.get(zone.zone) || '#2563EB';
          const isHighlighted = highlighted === zone.zone;
          const isDimmed = highlighted !== null && !isHighlighted;
          return (
            <button
              key={zone.zone}
              type="button"
              aria-pressed={isHighlighted}
              onClick={() => setHighlighted(highlighted === zone.zone ? null : zone.zone)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition-all border cursor-pointer ${
                isHighlighted ? 'ring-2 ring-offset-1 bg-white shadow-xs' : isDimmed ? 'opacity-40 bg-slate-50 border-slate-200 text-slate-500' : 'bg-slate-50 hover:bg-white border-slate-200 text-slate-700'
              }`}
              style={{ borderColor: isHighlighted ? color : undefined, boxShadow: isHighlighted ? `0 0 0 1px ${color}` : undefined }}
              title={`Click to isolate ${zone.zone}`}
            >
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
              <span className="truncate max-w-[130px]">{zone.zone}</span>
              <span className="font-mono text-[10px] font-bold px-1 rounded" style={{ backgroundColor: `${color}15`, color }}>
                {zone.liveHeadcount}
              </span>
            </button>
          );
        })}
        {highlighted && (
          <button type="button" onClick={() => setHighlighted(null)} className="text-[11px] font-medium text-slate-500 hover:text-slate-800 underline px-1 cursor-pointer">
            Reset highlight
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 my-3 bg-slate-50 p-3 rounded-lg border border-slate-200">
        <div title={KPI_COPY.activeCount.description}>
          <span className="text-[11px] text-slate-500 font-medium block">{KPI_COPY.activeCount.title}</span>
          <span data-testid="stat-active-count" className="text-base font-extrabold text-slate-900">{activeCount}</span>
          <span className="text-[10px] text-slate-400 block">{KPI_COPY.activeCount.description}</span>
        </div>
        <div title={KPI_COPY.highestPeak.description}>
          <span className="text-[11px] text-amber-600 font-medium block">{KPI_COPY.highestPeak.title}</span>
          <span data-testid="stat-highest-peak" className="text-base font-extrabold text-amber-700">{peakZone ? peakZone.peak : '—'}</span>
          <span className="text-[10px] text-slate-400 block truncate">{peakZone ? peakZone.zone : KPI_COPY.highestPeak.description}</span>
        </div>
        <div title={KPI_COPY.activeZones.description}>
          <span className="text-[11px] text-blue-600 font-medium block">{KPI_COPY.activeZones.title}</span>
          <span data-testid="stat-active-zones" className="text-base font-extrabold text-blue-700">{activeZones}</span>
          <span className="text-[10px] text-slate-400 block">{KPI_COPY.activeZones.description}</span>
        </div>
        <div title={KPI_COPY.camerasOnline.description}>
          <span className="text-[11px] text-emerald-600 font-medium block">{KPI_COPY.camerasOnline.title}</span>
          <span data-testid="stat-cameras-online" className="text-base font-extrabold text-emerald-700">
            {cameras ? `${cameras.online} of ${cameras.total}` : '—'}
          </span>
          <span className="text-[10px] text-slate-400 block">{KPI_COPY.camerasOnline.description}</span>
        </div>
      </div>

      <div className="h-64 w-full">
        {data.length === 0 ? (
          <WidgetState error={error} loading={loading} empty emptyText="No zone activity recorded for this period." />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 10, right: 12, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
              <XAxis dataKey="time" stroke="#94A3B8" fontSize={11} tickLine={false} axisLine={{ stroke: '#CBD5E1' }} />
              <YAxis stroke="#94A3B8" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip
                content={({ active, payload, label }: any) => {
                  if (active && payload && payload.length) {
                    return (
                      <div className="bg-slate-900 text-white p-3 rounded-lg shadow-xl text-xs border border-slate-700 min-w-[200px]">
                        <div className="font-bold text-slate-200 border-b border-slate-700 pb-1 mb-2 flex justify-between items-center">
                          <span>Interval: {label}</span>
                          <span className="text-slate-400 font-mono text-[10px]">Headcount</span>
                        </div>
                        <div className="space-y-1.5">
                          {payload.map((entry: any) => (
                            <div key={entry.dataKey as string} className="flex items-center justify-between gap-3 text-xs">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
                                <span className="text-slate-300 font-medium truncate max-w-[130px]">{entry.name}:</span>
                              </div>
                              <span className="font-mono font-bold text-white shrink-0">{entry.value}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  }
                  return null;
                }}
              />
              <Legend verticalAlign="top" align="right" iconType="circle" wrapperStyle={{ fontSize: '11px', paddingBottom: '8px' }} formatter={(value) => <span className="text-[11px] font-medium text-slate-700">{value}</span>} />
              {plotted.map((zone) => {
                const isHighlighted = highlighted === zone.zone;
                const isDimmed = highlighted !== null && !isHighlighted;
                const color = colorOf.get(zone.zone) || '#2563EB';
                return (
                  <Line
                    key={zone.zone}
                    type="monotone"
                    dataKey={zone.zone}
                    name={zone.zone}
                    stroke={color}
                    strokeWidth={isHighlighted ? 3.5 : 2.2}
                    strokeOpacity={isDimmed ? 0.25 : 1}
                    dot={false}
                    connectNulls
                    activeDot={{ r: 5, fill: color, stroke: '#FFFFFF', strokeWidth: 2 }}
                  />
                );
              })}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between text-[11px] text-slate-500 pt-3 border-t border-slate-100 mt-2 gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-slate-400">Legend:</span>
          {plotted.map((zone) => (
            <span key={zone.zone} className="inline-flex items-center gap-1 font-medium text-slate-600">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: colorOf.get(zone.zone) }} />
              {zone.zone}
            </span>
          ))}
        </div>
        <span className="text-slate-400">Peak headcount per {granularity === 'hour' ? 'hour' : granularity === 'day' ? 'day' : 'week'}</span>
      </div>
    </div>
  );
};
