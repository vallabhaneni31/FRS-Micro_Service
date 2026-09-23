import React, { useMemo, useState } from 'react';
import { Users, Activity, Flame } from 'lucide-react';
import type { HeatmapData } from '../lib/types';
import { DOW_LABELS, hourLabel } from '../lib/format';
import { InteractiveFloatingTooltip, FloatingTooltipPosition, TooltipBadgeVariant } from './CustomChartTooltip';
import { WidgetState } from '../lib/ViewHeader';

interface Props {
  data: HeatmapData | null;
  error?: string | null;
  loading?: boolean;
}

interface Cell { dow: number; hour: number; count: number; pctOfPeak: number }

// Monday-first display order; API dow: 0 = Sunday.
const DISPLAY_DOWS = [1, 2, 3, 4, 5, 6, 0];

/** Zone Occupancy Heatmap: day x hour, "Peak Usage" = share of the observed peak (no capacity) (Req 7.2). */
export const ZoneOccupancyHeatmap: React.FC<Props> = ({ data, error, loading }) => {
  const [hovered, setHovered] = useState<Cell | null>(null);
  const [pos, setPos] = useState<FloatingTooltipPosition | null>(null);

  const cells = data?.cells ?? [];
  const maxCell = data?.maxCell ?? 0;
  // Only the hours that actually have activity in the data.
  const hours = useMemo(() => {
    if (!cells.length) return [] as number[];
    const lo = Math.min(...cells.map((c) => c.hour));
    const hi = Math.max(...cells.map((c) => c.hour));
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  }, [cells]);

  const colorFor = (pct: number, count: number) => {
    if (count === 0) return 'bg-slate-100 text-slate-500 border-slate-200/60';
    const ratio = pct / 100;
    if (ratio < 0.12) return 'bg-slate-100 text-slate-500 border-slate-200/60';
    if (ratio < 0.28) return 'bg-blue-100 text-blue-800 border-blue-200';
    if (ratio < 0.5) return 'bg-blue-300 text-blue-900 border-blue-300 font-semibold';
    if (ratio < 0.75) return 'bg-blue-600 text-white border-blue-600 font-semibold';
    if (ratio < 0.9) return 'bg-indigo-700 text-white border-indigo-700 font-bold';
    return 'bg-amber-500 text-slate-950 font-extrabold border-amber-600 shadow-2xs';
  };

  const badgeFor = (pct: number): { text: string; variant: TooltipBadgeVariant } => {
    if (pct >= 90) return { text: 'Busiest', variant: 'amber' };
    if (pct >= 75) return { text: 'Very Busy', variant: 'indigo' };
    if (pct >= 50) return { text: 'Moderate', variant: 'blue' };
    if (pct >= 25) return { text: 'Regular', variant: 'cyan' };
    return { text: 'Quiet', variant: 'slate' };
  };

  const find = (dow: number, hour: number): Cell => cells.find((c) => c.dow === dow && c.hour === hour) ?? { dow, hour, count: 0, pctOfPeak: 0 };

  return (
    <div id="chart-zone-occupancy-heatmap" className="bg-white rounded-xl border border-slate-200 p-5 shadow-2xs hover:shadow-xs transition-all flex flex-col justify-between relative">
      {hovered && (
        <InteractiveFloatingTooltip
          visible
          position={pos}
          title={`${DOW_LABELS[hovered.dow]} • ${hourLabel(hovered.hour)} – ${hourLabel((hovered.hour + 1) % 24)}`}
          subtitle="Entries and exits in this hour"
          icon={Users}
          accentColor={hovered.pctOfPeak >= 90 ? '#F59E0B' : hovered.pctOfPeak >= 75 ? '#4338CA' : hovered.pctOfPeak >= 50 ? '#2563EB' : '#0284C7'}
          badge={badgeFor(hovered.pctOfPeak)}
          metrics={[
            { label: 'Movements', value: hovered.count, unit: 'entries + exits', color: '#60A5FA', icon: Activity },
            { label: 'Peak Usage', value: `${hovered.pctOfPeak}%`, color: '#A5B4FC', icon: Flame },
          ]}
          progress={{ label: 'Share of the busiest hour', value: hovered.pctOfPeak, displayValue: `${hovered.count} of ${maxCell}`, color: hovered.pctOfPeak >= 90 ? '#F59E0B' : '#4F46E5' }}
        />
      )}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-violet-600"></div>
            <h3 className="text-sm font-bold text-slate-900 tracking-tight">Zone Occupancy Heatmap</h3>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">How busy the selected zones are, hour by hour, across the days of the week (entries and exits)</p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <span className="text-[11px] font-medium mr-1">Low</span>
          <span className="w-3.5 h-3.5 rounded bg-slate-100 border border-slate-200"></span>
          <span className="w-3.5 h-3.5 rounded bg-blue-100 border border-blue-200"></span>
          <span className="w-3.5 h-3.5 rounded bg-blue-300 border border-blue-400"></span>
          <span className="w-3.5 h-3.5 rounded bg-blue-600 border border-blue-700"></span>
          <span className="w-3.5 h-3.5 rounded bg-indigo-700 border border-indigo-800"></span>
          <span className="w-3.5 h-3.5 rounded bg-amber-500 border border-amber-600"></span>
          <span className="text-[11px] font-medium ml-1">Peak ({maxCell})</span>
        </div>
      </div>

      {cells.length === 0 ? (
        <WidgetState error={error} loading={loading} empty emptyText="No activity recorded for this selection." />
      ) : (
        <div className="mt-4 overflow-x-auto">
          <div className="min-w-[640px]">
            <div className="grid gap-1 mb-1.5 text-center" style={{ gridTemplateColumns: `60px repeat(${hours.length}, 1fr)` }}>
              <span className="text-[10px] font-semibold text-slate-400 uppercase text-left pl-1">Day</span>
              {hours.map((h) => <span key={h} className="text-[10px] font-mono text-slate-400">{h}h</span>)}
            </div>
            <div className="space-y-1">
              {DISPLAY_DOWS.map((dow) => (
                <div key={dow} className="grid gap-1 items-center" style={{ gridTemplateColumns: `60px repeat(${hours.length}, 1fr)` }}>
                  <span className={`text-xs font-semibold pl-1 ${dow === 0 || dow === 6 ? 'text-slate-400' : 'text-slate-700'}`}>{DOW_LABELS[dow]}</span>
                  {hours.map((h) => {
                    const cell = find(dow, h);
                    const isHovered = hovered?.dow === dow && hovered?.hour === h;
                    return (
                      <div
                        key={`${dow}-${h}`}
                        data-testid="heatmap-cell"
                        data-count={cell.count}
                        onMouseEnter={(e) => { setHovered(cell); setPos({ x: e.clientX, y: e.clientY }); }}
                        onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
                        onMouseLeave={() => { setHovered(null); setPos(null); }}
                        className={`h-7 rounded flex items-center justify-center text-[10px] font-mono border transition-all cursor-pointer relative ${colorFor(cell.pctOfPeak, cell.count)} ${isHovered ? 'ring-2 ring-indigo-500 ring-offset-1 scale-110 z-20 shadow-md font-bold' : 'hover:scale-105 hover:z-10'}`}
                      >
                        {cell.count}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
        {hovered ? (
          <div className="flex flex-wrap items-center gap-4 text-slate-800">
            <span className="font-semibold text-blue-700">{DOW_LABELS[hovered.dow]} at {hourLabel(hovered.hour)}:</span>
            <span>Movements: <strong className="font-mono">{hovered.count}</strong></span>
            <span className="text-slate-500">Peak Usage: <strong className="font-mono">{hovered.pctOfPeak}%</strong></span>
          </div>
        ) : (
          <span className="text-slate-400 text-[11px]">Hover over any hour to see how busy it was compared with the busiest hour</span>
        )}
        <span className="text-slate-400 text-[11px] font-medium hidden sm:inline">One cell per hour</span>
      </div>
    </div>
  );
};
