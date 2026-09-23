import React from 'react';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Flame, Moon, Users } from 'lucide-react';
import type { PeakHoursData } from '../lib/types';
import { fmtDateTime, hourLabel, windowLabel } from '../lib/format';
import { KPI_COPY } from '../lib/copy';
import { WidgetState } from '../lib/ViewHeader';

interface Props {
  data: PeakHoursData | null;
  error?: string | null;
  loading?: boolean;
}

/** Peak Hours & Traffic: 3 computed insight cards + hourly traffic bars with average and peak headcount lines (Req 6.5). */
export const PeakHoursAnalysis: React.FC<Props> = ({ data, error, loading }) => {
  const hourly = (data?.hourly ?? []).map((h) => ({ ...h, label: hourLabel(h.hour) }));
  const high = data?.highestWindow ?? null;
  const low = data?.lowestWindow ?? null;
  const moment = data?.peakHeadcountMoment ?? null;
  const topInbound = hourly.length ? hourly.reduce((a, b) => (b.entries > a.entries ? b : a)) : null;
  const topOutbound = hourly.length ? hourly.reduce((a, b) => (b.exits > a.exits ? b : a)) : null;

  return (
    <div id="chart-peak-hours-analysis" className="bg-white rounded-xl border border-slate-200 p-5 shadow-2xs hover:shadow-xs transition-all flex flex-col justify-between">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-slate-100">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-amber-500"></div>
            <h3 className="text-sm font-bold text-slate-900 tracking-tight">Peak Hours & Traffic Distribution Analysis</h3>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">How busy the entrances are through the day and how many employees are inside</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 my-3">
        <div className="p-3 rounded-lg bg-amber-50/70 border border-amber-200/80 flex flex-col justify-between" title={KPI_COPY.highestTraffic.description}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-amber-900 uppercase tracking-wider flex items-center gap-1">
              <Flame className="w-3.5 h-3.5 text-amber-600" />
              {KPI_COPY.highestTraffic.title}
            </span>
            <span className="font-mono text-xs font-bold text-amber-700">{high ? `${high.count} movements` : '—'}</span>
          </div>
          <div data-testid="peak-highest" className="text-base font-extrabold text-slate-900 mt-1">{windowLabel(high)}</div>
          <p className="text-[10px] text-amber-800/80 mt-1 leading-snug">{KPI_COPY.highestTraffic.description}</p>
        </div>

        <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 flex flex-col justify-between" title={KPI_COPY.lowestTraffic.description}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-slate-600 uppercase tracking-wider flex items-center gap-1">
              <Moon className="w-3.5 h-3.5 text-slate-500" />
              {KPI_COPY.lowestTraffic.title}
            </span>
            <span className="font-mono text-xs font-bold text-slate-600">{low ? `${low.count} movements` : '—'}</span>
          </div>
          <div data-testid="peak-lowest" className="text-base font-extrabold text-slate-900 mt-1">{windowLabel(low)}</div>
          <p className="text-[10px] text-slate-500 mt-1 leading-snug">{KPI_COPY.lowestTraffic.description}</p>
        </div>

        <div className="p-3 rounded-lg bg-blue-50/70 border border-blue-200/80 flex flex-col justify-between" title={KPI_COPY.peakMoment.description}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-blue-900 uppercase tracking-wider flex items-center gap-1">
              <Users className="w-3.5 h-3.5 text-blue-600" />
              {KPI_COPY.peakMoment.title}
            </span>
            <span className="font-mono text-xs font-bold text-blue-700">{moment ? `${moment.count} employees inside` : '—'}</span>
          </div>
          <div data-testid="peak-moment" className="text-base font-extrabold text-slate-900 mt-1">{moment ? fmtDateTime(moment.at) : '—'}</div>
          <p className="text-[10px] text-blue-800/80 mt-1 leading-snug">{KPI_COPY.peakMoment.description}</p>
        </div>
      </div>

      <div className="h-64 w-full mt-2">
        {hourly.length === 0 ? (
          <WidgetState error={error} loading={loading} empty emptyText="No entrance activity recorded for this selection." />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={hourly} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
              <XAxis dataKey="label" stroke="#94A3B8" fontSize={11} tickLine={false} axisLine={{ stroke: '#CBD5E1' }} />
              <YAxis stroke="#94A3B8" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip
                content={({ active, payload, label }: any) => {
                  if (active && payload && payload.length) {
                    const d = payload[0].payload;
                    return (
                      <div className="bg-slate-900 text-white p-3 rounded-lg shadow-xl text-xs border border-slate-700">
                        <div className="font-bold text-slate-200 border-b border-slate-700 pb-1 mb-1.5 flex justify-between gap-4">
                          <span>Window: {label}</span>
                          <span className="text-amber-400 font-mono">Traffic</span>
                        </div>
                        <div className="space-y-1">
                          <div className="flex justify-between gap-4 text-amber-300"><span>Total Movements:</span><span className="font-mono font-bold">{d.traffic}</span></div>
                          <div className="flex justify-between gap-4 text-emerald-400"><span>Entries:</span><span className="font-mono">{d.entries}</span></div>
                          <div className="flex justify-between gap-4 text-orange-400"><span>Exits:</span><span className="font-mono">{d.exits}</span></div>
                          <div className="flex justify-between gap-4 text-blue-300 pt-1 border-t border-slate-800"><span>Avg Headcount:</span><span className="font-mono font-bold">{d.avgOccupancy}</span></div>
                          <div className="flex justify-between gap-4 text-purple-300"><span>Peak Headcount:</span><span className="font-mono font-bold">{d.peakOccupancy}</span></div>
                        </div>
                      </div>
                    );
                  }
                  return null;
                }}
              />
              <Legend verticalAlign="top" align="right" iconType="circle" wrapperStyle={{ fontSize: '11px', paddingBottom: '8px' }} />
              <Bar dataKey="traffic" name="Hourly Movements" fill="#F59E0B" radius={[4, 4, 0, 0]} maxBarSize={20} />
              <Line type="monotone" dataKey="avgOccupancy" name="Average Headcount" stroke="#2563EB" strokeWidth={2.5} dot={{ r: 3, fill: '#2563EB' }} />
              <Line type="monotone" dataKey="peakOccupancy" name="Peak Headcount" stroke="#8B5CF6" strokeWidth={2} strokeDasharray="4 4" dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="flex items-center justify-between text-[11px] text-slate-500 pt-3 border-t border-slate-100 mt-2">
        <span>Busiest Entry Window: <strong className="text-slate-800">{topInbound && topInbound.entries > 0 ? `${topInbound.label} (${topInbound.entries} entries)` : '—'}</strong></span>
        <span>Busiest Exit Window: <strong className="text-slate-800">{topOutbound && topOutbound.exits > 0 ? `${topOutbound.label} (${topOutbound.exits} exits)` : '—'}</strong></span>
      </div>
    </div>
  );
};
