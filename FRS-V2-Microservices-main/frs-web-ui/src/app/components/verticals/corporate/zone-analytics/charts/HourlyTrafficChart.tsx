import React, { useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Activity, Flame, Moon, Clock } from 'lucide-react';
import type { HourlyRow } from '../lib/types';
import { hourLabel } from '../lib/format';
import { CustomChartTooltip } from './CustomChartTooltip';
import { WidgetState } from '../lib/ViewHeader';

interface Props {
  hourly: HourlyRow[];
  error?: string | null;
  loading?: boolean;
}

/** Hourly Zone Traffic: bars per hour with computed peak / low chips (Req 7.2). */
export const HourlyTrafficChart: React.FC<Props> = ({ hourly, error, loading }) => {
  const [hoveredHour, setHoveredHour] = useState<string | null>(null);
  const data = hourly.map((h) => ({ hour: hourLabel(h.hour), traffic: h.traffic, entries: h.entries, exits: h.exits }));
  const active = data.filter((d) => d.traffic > 0);
  const peakItem = active.length ? active.reduce((p, c) => (c.traffic > p.traffic ? c : p)) : null;
  const lowestItem = active.length ? active.reduce((p, c) => (c.traffic < p.traffic ? c : p)) : null;
  const totalMovements = data.reduce((s, d) => s + d.traffic, 0);

  return (
    <div id="chart-hourly-zone-traffic" className="bg-white rounded-xl border border-slate-200 p-5 shadow-2xs hover:shadow-xs transition-all flex flex-col justify-between">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-indigo-600"></div>
            <h3 className="text-sm font-bold text-slate-900 tracking-tight">Hourly Zone Traffic</h3>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">Everyone who came in or left, by hour of the day, with the busiest and quietest hours highlighted</p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span data-testid="chip-peak" className="flex items-center gap-1 bg-amber-50 text-amber-700 px-2.5 py-1 rounded-md border border-amber-200 font-semibold">
            <Flame className="w-3.5 h-3.5 text-amber-500" />
            Peak: {peakItem ? `${peakItem.hour} (${peakItem.traffic})` : '—'}
          </span>
          <span data-testid="chip-low" className="flex items-center gap-1 bg-slate-100 text-slate-600 px-2.5 py-1 rounded-md border border-slate-200 font-medium">
            <Moon className="w-3.5 h-3.5 text-slate-400" />
            Low: {lowestItem ? `${lowestItem.hour} (${lowestItem.traffic})` : '—'}
          </span>
        </div>
      </div>

      <div className="h-64 w-full mt-4">
        {data.length === 0 ? (
          <WidgetState error={error} loading={loading} empty emptyText="No traffic recorded for this selection." />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              onMouseMove={(state: any) => { if (state && state.activeLabel) setHoveredHour(state.activeLabel as string); }}
              onMouseLeave={() => setHoveredHour(null)}
            >
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
              <XAxis dataKey="hour" stroke="#94A3B8" fontSize={10} interval={0} tickLine={false} axisLine={{ stroke: '#CBD5E1' }} />
              <YAxis stroke="#94A3B8" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip
                cursor={{ fill: 'rgba(99, 102, 241, 0.08)', radius: 4 }}
                content={({ active, payload, label }: any) => {
                  if (active && payload && payload.length) {
                    const d = payload[0].payload;
                    const isPeak = peakItem && label === peakItem.hour;
                    const isLow = lowestItem && label === lowestItem.hour;
                    const share = peakItem ? Math.round((d.traffic / (peakItem.traffic || 1)) * 100) : 0;
                    return (
                      <CustomChartTooltip
                        title={`Window: ${label}`}
                        subtitle="Movements in this hour"
                        icon={Clock}
                        accentColor={isPeak ? '#F59E0B' : isLow ? '#64748B' : '#6366F1'}
                        badge={isPeak ? { text: 'Busiest Hour', variant: 'amber' } : isLow ? { text: 'Quietest Hour', variant: 'slate' } : { text: 'Regular Flow', variant: 'indigo' }}
                        metrics={[
                          { label: 'Total Movements', value: d.traffic, unit: 'movements', color: isPeak ? '#FBBF24' : '#60A5FA', icon: Activity },
                          { label: 'Entries', value: d.entries, color: '#34D399' },
                          { label: 'Exits', value: d.exits, color: '#FB923C' },
                        ]}
                        progress={{ label: 'Share of busiest hour', value: share, color: isPeak ? '#F59E0B' : '#6366F1', displayValue: `${share}% of peak` }}
                      />
                    );
                  }
                  return null;
                }}
              />
              <Bar dataKey="traffic" radius={[4, 4, 0, 0]}>
                {data.map((entry, index) => {
                  const isPeak = peakItem !== null && entry.hour === peakItem.hour;
                  const isLowest = lowestItem !== null && entry.hour === lowestItem.hour && entry.traffic > 0;
                  const isHovered = entry.hour === hoveredHour;
                  let fill = isPeak ? '#F59E0B' : isLowest ? '#94A3B8' : '#3B82F6';
                  if (hoveredHour) {
                    fill = isHovered ? (isPeak ? '#D97706' : '#4F46E5') : isPeak ? 'rgba(245, 158, 11, 0.45)' : isLowest ? 'rgba(148, 163, 184, 0.35)' : 'rgba(59, 130, 246, 0.45)';
                  }
                  return <Cell key={`cell-${index}`} fill={fill} className="transition-colors duration-150 cursor-pointer" />;
                })}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="flex items-center justify-between text-[11px] text-slate-500 pt-3 border-t border-slate-100 mt-2">
        <span className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-sm bg-blue-500"></span> Regular Flow
          <span className="w-2.5 h-2.5 rounded-sm bg-amber-500 ml-2"></span> Busiest Hour
          <span className="w-2.5 h-2.5 rounded-sm bg-slate-400 ml-2"></span> Quietest Hour
        </span>
        <span className="text-slate-500 font-medium">Total: <strong className="text-slate-800 font-mono">{totalMovements.toLocaleString()}</strong></span>
      </div>
    </div>
  );
};
