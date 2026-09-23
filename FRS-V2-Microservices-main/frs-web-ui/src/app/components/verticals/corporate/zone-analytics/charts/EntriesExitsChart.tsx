import React, { useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { ArrowUpRight, ArrowDownLeft, MapPin, Activity, Clock } from 'lucide-react';
import type { PeakHoursData } from '../lib/types';
import { hourLabel, zoneColor } from '../lib/format';
import { CustomChartTooltip } from './CustomChartTooltip';
import { WidgetState } from '../lib/ViewHeader';

interface Props {
  data: PeakHoursData | null;
  /** Zone names in scope (drives the zone chips and the compare view). */
  zones: string[];
  error?: string | null;
  loading?: boolean;
}

type ViewMode = 'hourly' | 'by-zone';

/** Entries vs Exits: Hourly Timeline / Compare All Zones toggle with zone chips (Req 7.2). */
export const EntriesExitsChart: React.FC<Props> = ({ data, zones, error, loading }) => {
  const [viewMode, setViewMode] = useState<ViewMode>('hourly');
  const [localZone, setLocalZone] = useState<string>('');

  const byZone = data?.byZone ?? [];
  const names = useMemo(() => [...new Set([...zones, ...byZone.map((r) => r.zone)])], [zones, byZone]);

  const hourlyData = useMemo(() => {
    const rows = localZone ? byZone.filter((r) => r.zone === localZone) : byZone;
    const byHour = new Map<number, { hour: number; time: string; entries: number; exits: number }>();
    for (const r of rows) {
      const cur = byHour.get(r.hour) ?? { hour: r.hour, time: hourLabel(r.hour), entries: 0, exits: 0 };
      cur.entries += r.entries;
      cur.exits += r.exits;
      byHour.set(r.hour, cur);
    }
    return [...byHour.values()].sort((a, b) => a.hour - b.hour);
  }, [byZone, localZone]);

  const zoneData = useMemo(() => names.map((zone) => ({
    zone,
    entries: byZone.filter((r) => r.zone === zone).reduce((s, r) => s + r.entries, 0),
    exits: byZone.filter((r) => r.zone === zone).reduce((s, r) => s + r.exits, 0),
  })).filter((z) => z.entries + z.exits > 0), [names, byZone]);

  const rows = viewMode === 'hourly' ? hourlyData : zoneData;
  const totalEntries = rows.reduce((s, d: any) => s + d.entries, 0);
  const totalExits = rows.reduce((s, d: any) => s + d.exits, 0);
  const net = totalEntries - totalExits;

  const toggle = (mode: ViewMode, id: string, label: string) => (
    <button
      id={id}
      type="button"
      aria-pressed={viewMode === mode}
      onClick={() => setViewMode(mode)}
      className={`px-3 py-1 rounded-md font-semibold transition-all cursor-pointer ${viewMode === mode ? 'bg-white text-emerald-700 shadow-xs' : 'text-slate-600 hover:text-slate-900'}`}
    >
      {label}
    </button>
  );

  return (
    <div id="chart-entries-vs-exits" className="bg-white rounded-xl border border-slate-200 p-5 shadow-2xs hover:shadow-xs transition-all flex flex-col justify-between">
      <div className="flex flex-col gap-3 pb-4 border-b border-slate-100">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-500"></div>
              <h3 className="text-sm font-bold text-slate-900 tracking-tight">Entries Versus Exits</h3>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-semibold border bg-blue-50 border-blue-200 text-blue-800">
                <span className="w-2 h-2 rounded-full bg-blue-600" />
                {viewMode === 'by-zone' ? 'All zones in scope' : localZone || 'All zones in scope'}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">How many people came in and left, hour by hour, for the selected zones</p>
          </div>
          <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs self-start sm:self-auto" role="group" aria-label="Entries versus exits view">
            {toggle('hourly', 'entries-view-hourly', 'Hourly Timeline')}
            {toggle('by-zone', 'entries-view-byzone', 'Compare All Zones')}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-2 text-xs flex-wrap">
            <span className="text-slate-500 font-medium flex items-center gap-1"><MapPin className="w-3.5 h-3.5 text-slate-400" />Zone:</span>
            <button type="button" aria-pressed={localZone === ''} onClick={() => setLocalZone('')} className={`px-2 py-0.5 rounded-md border text-[11px] font-semibold cursor-pointer ${localZone === '' ? 'bg-slate-800 text-white border-slate-800' : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'}`}>All</button>
            {names.map((z, i) => (
              <button key={z} type="button" aria-pressed={localZone === z} onClick={() => { setLocalZone(z); setViewMode('hourly'); }} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-semibold cursor-pointer ${localZone === z ? 'bg-white shadow-xs' : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'}`} style={localZone === z ? { borderColor: zoneColor(i), color: zoneColor(i) } : undefined}>
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: zoneColor(i) }} />{z}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <div className="flex items-center gap-1.5 bg-emerald-50 text-emerald-700 px-2.5 py-1 rounded-lg border border-emerald-200 font-semibold"><ArrowUpRight className="w-3.5 h-3.5" /><span>In: <strong data-testid="entries-total">{totalEntries.toLocaleString()}</strong></span></div>
            <div className="flex items-center gap-1.5 bg-orange-50 text-orange-700 px-2.5 py-1 rounded-lg border border-orange-200 font-semibold"><ArrowDownLeft className="w-3.5 h-3.5" /><span>Out: <strong data-testid="exits-total">{totalExits.toLocaleString()}</strong></span></div>
            <div className="flex items-center gap-1 bg-slate-100 text-slate-700 px-2 py-1 rounded-lg border border-slate-200 font-mono text-[11px]"><span>Net: <strong>{net > 0 ? `+${net}` : net}</strong></span></div>
          </div>
        </div>
      </div>

      <div className="h-64 w-full mt-4">
        {rows.length === 0 ? (
          <WidgetState error={error} loading={loading} empty emptyText="No entries or exits recorded for this selection." />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows as any[]} margin={{ top: 10, right: 10, left: -20, bottom: 0 }} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
              <XAxis dataKey={viewMode === 'hourly' ? 'time' : 'zone'} stroke="#94A3B8" fontSize={11} tickLine={false} axisLine={{ stroke: '#CBD5E1' }} />
              <YAxis stroke="#94A3B8" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip
                cursor={{ fill: 'rgba(16, 185, 129, 0.08)', radius: 4 }}
                content={({ active, payload, label }: any) => {
                  if (active && payload && payload.length) {
                    const entryVal = Number(payload.find((p: any) => p.dataKey === 'entries')?.value ?? 0);
                    const exitVal = Number(payload.find((p: any) => p.dataKey === 'exits')?.value ?? 0);
                    const n = entryVal - exitVal;
                    const total = entryVal + exitVal;
                    const inRatio = Math.round((entryVal / (total || 1)) * 100);
                    return (
                      <CustomChartTooltip
                        title={viewMode === 'hourly' ? `Time: ${label}` : `Zone: ${label}`}
                        subtitle={viewMode === 'hourly' ? (localZone || 'All zones in scope') : 'Entries and exits in the period'}
                        icon={Clock}
                        accentColor={n >= 0 ? '#10B981' : '#F97316'}
                        badge={n > 0 ? { text: `More came in +${n}`, variant: 'emerald' } : n < 0 ? { text: `More left ${n}`, variant: 'amber' } : { text: 'Balanced', variant: 'slate' }}
                        metrics={[
                          { label: 'Entries', value: entryVal, color: '#34D399', icon: ArrowUpRight },
                          { label: 'Exits', value: exitVal, color: '#FB923C', icon: ArrowDownLeft },
                          { label: 'Net Flow', value: n > 0 ? `+${n}` : n, color: n >= 0 ? '#10B981' : '#F43F5E' },
                          { label: 'Total Movements', value: total, color: '#60A5FA', icon: Activity },
                        ]}
                        progress={{ label: 'Share coming in', value: inRatio, displayValue: `${inRatio}% in / ${100 - inRatio}% out`, color: '#10B981' }}
                      />
                    );
                  }
                  return null;
                }}
              />
              <Legend verticalAlign="top" align="right" iconType="circle" wrapperStyle={{ fontSize: '11px', paddingBottom: '8px' }} />
              <Bar dataKey="entries" name="Entries" fill="#10B981" radius={[4, 4, 0, 0]} maxBarSize={18} />
              <Bar dataKey="exits" name="Exits" fill="#F97316" radius={[4, 4, 0, 0]} maxBarSize={18} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="flex items-center justify-between text-[11px] text-slate-500 pt-3 border-t border-slate-100 mt-2">
        <span>{viewMode === 'hourly' ? 'One bar pair per hour of the day' : 'One bar pair per zone'}</span>
        <span className="text-slate-400">Entries are green, exits are orange</span>
      </div>
    </div>
  );
};
