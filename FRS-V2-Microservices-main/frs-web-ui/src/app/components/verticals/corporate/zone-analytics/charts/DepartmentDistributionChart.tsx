import React from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import type { DepartmentDistributionRow } from '../lib/types';
import { fmtMinutes, zoneColor } from '../lib/format';
import { WidgetState } from '../lib/ViewHeader';

interface Props {
  data: DepartmentDistributionRow[];
  error?: string | null;
  loading?: boolean;
}

/** Department-wise Zone Distribution donut with legend, tooltip and a computed leading-department footer (Req 6.4). */
export const DepartmentDistributionChart: React.FC<Props> = ({ data, error, loading }) => {
  const leader = data.length ? [...data].sort((a, b) => b.trafficPct - a.trafficPct)[0] : null;

  return (
    <div id="chart-department-zone-distribution" className="bg-white rounded-xl border border-slate-200 p-5 shadow-2xs hover:shadow-xs transition-all flex flex-col justify-between">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-slate-100">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-blue-600"></div>
            <h3 className="text-sm font-bold text-slate-900 tracking-tight">Department-wise Zone Distribution</h3>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">Share of zone visits and average time spent inside a zone, by department</p>
        </div>
      </div>

      {data.length === 0 ? (
        <WidgetState error={error} loading={loading} empty emptyText="No department activity recorded for this period." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center mt-3">
          <div className="md:col-span-6 h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Tooltip
                  content={({ active, payload }: any) => {
                    if (active && payload && payload.length) {
                      const d = payload[0].payload as DepartmentDistributionRow;
                      return (
                        <div className="bg-slate-900 text-white p-3 rounded-lg shadow-xl text-xs border border-slate-700">
                          <div className="font-bold text-slate-200 border-b border-slate-700 pb-1 mb-1.5 flex items-center justify-between gap-4">
                            <span>{d.name}</span>
                            <span className="font-mono text-blue-400">{d.trafficPct}%</span>
                          </div>
                          <div className="space-y-1">
                            <div className="flex justify-between gap-3 text-slate-300"><span>Employees Detected:</span><span className="font-bold font-mono text-white">{d.employeesDetected}</span></div>
                            <div className="flex justify-between gap-3 text-slate-300"><span>Zone Visits:</span><span className="font-bold font-mono text-white">{d.visits}</span></div>
                            <div className="flex justify-between gap-3 text-amber-300"><span>Avg. Time Spent:</span><span className="font-bold font-mono">{fmtMinutes(d.avgTimeSpentMinutes)}</span></div>
                          </div>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Pie data={data} dataKey="trafficPct" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={80} paddingAngle={3}>
                  {data.map((entry, index) => (
                    <Cell key={`dept-${entry.departmentId}`} fill={zoneColor(index)} stroke="#FFFFFF" strokeWidth={2} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>

          <div className="md:col-span-6 space-y-2 text-xs" data-testid="department-legend">
            {data.map((dept, index) => (
              <div key={dept.departmentId} className="flex items-center justify-between p-2 rounded-lg bg-slate-50 hover:bg-slate-100/80 border border-slate-150 transition-colors">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: zoneColor(index) }}></span>
                  <div>
                    <span className="font-semibold text-slate-800">{dept.name}</span>
                    <div className="text-[10px] text-slate-500">{dept.employeesDetected} employees • {dept.visits} zone visits</div>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <span className="font-bold text-slate-900 font-mono">{dept.trafficPct}%</span>
                  <div className="text-[10px] text-slate-500 font-mono">{dept.avgTimeSpentMinutes === null ? '—' : `~${fmtMinutes(dept.avgTimeSpentMinutes)} avg`}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between text-[11px] text-slate-500 pt-3 border-t border-slate-100 mt-2">
        <span data-testid="leading-department">
          Leading Dept:{' '}
          <strong className="text-slate-800">{leader ? `${leader.name} (${leader.trafficPct}% of zone visits)` : '—'}</strong>
        </span>
        <span className="text-slate-400">Zone activity only</span>
      </div>
    </div>
  );
};
