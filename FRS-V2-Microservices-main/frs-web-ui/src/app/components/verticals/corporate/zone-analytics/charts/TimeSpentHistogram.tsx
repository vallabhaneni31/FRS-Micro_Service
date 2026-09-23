import React, { useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Users, Timer } from 'lucide-react';
import type { TimeSpentBucket } from '../lib/types';
import { CustomChartTooltip } from './CustomChartTooltip';
import { WidgetState } from '../lib/ViewHeader';

interface Props {
  data: TimeSpentBucket[];
  error?: string | null;
  loading?: boolean;
}

const BUCKET_LABELS: Record<string, string> = { '<1h': 'Under 1 hour', '1-3h': '1 – 3 hours', '3-6h': '3 – 6 hours', '6-9h': '6 – 9 hours', '>9h': 'Over 9 hours' };
const BUCKET_KIND: Record<string, { type: string; variant: 'slate' | 'cyan' | 'indigo' | 'emerald' | 'amber' }> = {
  '<1h': { type: 'Quick stay', variant: 'slate' },
  '1-3h': { type: 'Short visit', variant: 'cyan' },
  '3-6h': { type: 'Medium visit', variant: 'indigo' },
  '6-9h': { type: 'Long visit', variant: 'emerald' },
  '>9h': { type: 'Extended visit', variant: 'amber' },
};
const COLORS = ['#60A5FA', '#3B82F6', '#2563EB', '#1D4ED8', '#1E40AF'];

/** Time Spent Inside Zone histogram over the five duration buckets (Req 7.2, 3.5). */
export const TimeSpentHistogram: React.FC<Props> = ({ data, error, loading }) => {
  const [hovered, setHovered] = useState<string | null>(null);
  const rows = data.map((d) => ({ ...d, label: BUCKET_LABELS[d.bucket] ?? d.bucket }));
  const total = rows.reduce((s, r) => s + r.count, 0);
  const modal = total > 0 ? rows.reduce((p, c) => (c.count > p.count ? c : p)) : null;
  const short = rows.find((r) => r.bucket === '<1h');
  const extended = rows.find((r) => r.bucket === '>9h');

  return (
    <div id="chart-time-spent-histogram" className="bg-white rounded-xl border border-slate-200 p-5 shadow-2xs hover:shadow-xs transition-all flex flex-col justify-between">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-slate-100">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-cyan-600"></div>
            <h3 className="text-sm font-bold text-slate-900 tracking-tight">Time Spent Inside Zone</h3>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">How long each completed visit lasted, from walking in to walking out</p>
        </div>
        <div data-testid="modal-range" className="text-xs bg-cyan-50 text-cyan-800 px-2.5 py-1 rounded-md border border-cyan-200">
          Most common: <strong>{modal ? `${modal.label} (${modal.pct}%)` : '—'}</strong>
        </div>
      </div>

      <div className="h-64 w-full mt-4">
        {total === 0 ? (
          <WidgetState error={error} loading={loading} empty emptyText="No completed visits recorded for this selection." />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={rows}
              margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              onMouseMove={(state: any) => { if (state && state.activeLabel) setHovered(state.activeLabel as string); }}
              onMouseLeave={() => setHovered(null)}
            >
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
              <XAxis dataKey="label" stroke="#64748B" fontSize={11} fontWeight={500} tickLine={false} axisLine={{ stroke: '#CBD5E1' }} />
              <YAxis stroke="#94A3B8" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip
                cursor={{ fill: 'rgba(6, 182, 212, 0.08)', radius: 4 }}
                content={({ active, payload }: any) => {
                  if (active && payload && payload.length) {
                    const d = payload[0].payload as TimeSpentBucket & { label: string };
                    const kind = BUCKET_KIND[d.bucket] ?? { type: 'Visit', variant: 'slate' as const };
                    return (
                      <CustomChartTooltip
                        title={`Duration: ${d.label}`}
                        subtitle="Length of a single visit"
                        icon={Timer}
                        accentColor="#06B6D4"
                        badge={{ text: `${d.pct}% of visits`, variant: kind.variant }}
                        metrics={[
                          { label: 'Visits in this range', value: d.count, unit: 'visits', color: '#38BDF8', icon: Users },
                          { label: 'Share of all visits', value: `${d.pct}%`, color: '#67E8F9' },
                          { label: 'Visit type', value: kind.type, color: '#F1F5F9' },
                        ]}
                        progress={{ label: 'Share of visits', value: d.pct, displayValue: `${d.pct}% (${d.count} visits)`, color: '#06B6D4' }}
                      />
                    );
                  }
                  return null;
                }}
              />
              <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                {rows.map((entry, index) => {
                  const isHovered = entry.label === hovered;
                  return <Cell key={`cell-${index}`} fill={isHovered ? '#0284C7' : COLORS[index % COLORS.length]} opacity={hovered ? (isHovered ? 1 : 0.45) : 1} className="transition-all duration-150 cursor-pointer" />;
                })}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="flex items-center justify-between text-[11px] text-slate-500 pt-3 border-t border-slate-100 mt-2">
        <span>Short Stays (&lt;1h): <strong className="text-slate-800">{short ? `${short.count} visits` : '—'}</strong></span>
        <span>Extended Stays (&gt;9h): <strong className="text-slate-800">{extended ? `${extended.count} visits` : '—'}</strong></span>
      </div>
    </div>
  );
};
