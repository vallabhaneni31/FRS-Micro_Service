import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { DoorOpen, ArrowUpRight, ArrowDownLeft, Users, Clock, Activity } from 'lucide-react';
import type { EntryPointTrafficRow } from '../lib/types';
import { hourLabel } from '../lib/format';
import { CustomChartTooltip } from './CustomChartTooltip';
import { WidgetState } from '../lib/ViewHeader';

interface Props {
  data: EntryPointTrafficRow[];
  error?: string | null;
  loading?: boolean;
}

/** Entrance-wise Traffic: grouped entries / exits per entrance (Req 7.2). */
export const EntryPointTrafficChart: React.FC<Props> = ({ data, error, loading }) => {
  const rows = data.map((d) => ({ ...d, name: d.deviceLabel }));
  const top = rows.length ? [...rows].sort((a, b) => b.contributionPct - a.contributionPct)[0] : null;
  const busiestHour = top && top.peakActivity !== null ? `${hourLabel(top.peakActivity)} – ${hourLabel((top.peakActivity + 1) % 24)}` : '—';

  return (
    <div id="chart-entrypoint-traffic" className="bg-white rounded-xl border border-slate-200 p-5 shadow-2xs hover:shadow-xs transition-all flex flex-col justify-between">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-slate-100">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-teal-600"></div>
            <h3 className="text-sm font-bold text-slate-900 tracking-tight">Entrance-wise Traffic Flow</h3>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">How many people came in and left through each entrance</p>
        </div>
        <div className="text-xs text-slate-500 font-medium bg-slate-50 px-2.5 py-1 rounded-md border border-slate-200">
          <strong className="text-slate-800">{rows.length}</strong> Entrances Monitored
        </div>
      </div>

      <div className="h-64 w-full mt-4">
        {rows.length === 0 ? (
          <WidgetState error={error} loading={loading} empty emptyText="No entrance activity recorded for this selection." />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart layout="vertical" data={rows} margin={{ top: 5, right: 30, left: 20, bottom: 5 }} barCategoryGap={6}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#E2E8F0" />
              <XAxis type="number" stroke="#94A3B8" fontSize={11} tickLine={false} axisLine={{ stroke: '#CBD5E1' }} allowDecimals={false} />
              <YAxis type="category" dataKey="name" stroke="#475569" fontSize={11} fontWeight={600} tickLine={false} axisLine={false} width={100} />
              <Tooltip
                cursor={{ fill: 'rgba(13, 148, 136, 0.08)', radius: 4 }}
                content={({ active, payload }: any) => {
                  if (active && payload && payload.length) {
                    const item = payload[0].payload as EntryPointTrafficRow & { name: string };
                    const total = item.entries + item.exits;
                    return (
                      <CustomChartTooltip
                        title={item.name}
                        subtitle="Entrance"
                        icon={DoorOpen}
                        accentColor="#0D9488"
                        badge={{ text: `${item.contributionPct}% of traffic`, variant: 'cyan' }}
                        metrics={[
                          { label: 'Entries', value: `+${item.entries.toLocaleString()}`, color: '#34D399', icon: ArrowUpRight },
                          { label: 'Exits', value: `-${item.exits.toLocaleString()}`, color: '#FB923C', icon: ArrowDownLeft },
                          { label: 'Net Flow', value: item.net > 0 ? `+${item.net}` : `${item.net}`, color: item.net >= 0 ? '#10B981' : '#F43F5E', subtext: item.net >= 0 ? 'More came in than left' : 'More left than came in' },
                          { label: 'Total Movements', value: total.toLocaleString(), color: '#60A5FA', icon: Activity },
                          { label: 'Unique Employees', value: item.uniqueEmployees, color: '#38BDF8', icon: Users },
                          { label: 'Busiest Hour', value: item.peakActivity === null ? '—' : hourLabel(item.peakActivity), color: '#FBBF24', icon: Clock },
                        ]}
                        progress={{ label: 'Share of all traffic', value: item.contributionPct, displayValue: `${item.contributionPct}% of all movements`, color: '#0D9488' }}
                      />
                    );
                  }
                  return null;
                }}
              />
              <Legend verticalAlign="top" align="right" iconType="circle" wrapperStyle={{ fontSize: '11px', paddingBottom: '8px' }} />
              <Bar dataKey="entries" name="Entries" fill="#0D9488" radius={[0, 4, 4, 0]} maxBarSize={14} />
              <Bar dataKey="exits" name="Exits" fill="#F59E0B" radius={[0, 4, 4, 0]} maxBarSize={14} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="flex items-center justify-between text-[11px] text-slate-500 pt-3 border-t border-slate-100 mt-2">
        <span>Highest Volume: <strong className="text-slate-800">{top ? `${top.name} (${top.contributionPct}% of all movements)` : '—'}</strong></span>
        <span>Its Busiest Hour: <strong className="text-slate-800">{busiestHour}</strong></span>
      </div>
    </div>
  );
};
