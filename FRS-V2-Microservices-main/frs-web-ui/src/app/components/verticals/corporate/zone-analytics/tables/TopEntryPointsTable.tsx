import React, { useMemo, useState } from 'react';
import { DoorOpen, ArrowUpRight, ArrowDownLeft, Users, Clock } from 'lucide-react';
import type { EntryPointTrafficRow } from '../lib/types';
import { hourLabel } from '../lib/format';
import { InteractiveFloatingTooltip, FloatingTooltipPosition } from '../charts/CustomChartTooltip';
import { WidgetState } from '../lib/ViewHeader';

interface Props {
  data: EntryPointTrafficRow[];
  error?: string | null;
  loading?: boolean;
}

/** Top Entrances by Traffic: Rank, Entrance, Total Entries/Exits, Net Flow, Unique Employees, Share, Peak Activity Time (Req 7.2). */
export const TopEntryPointsTable: React.FC<Props> = ({ data, error, loading }) => {
  const [hovered, setHovered] = useState<EntryPointTrafficRow | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [pos, setPos] = useState<FloatingTooltipPosition | null>(null);
  const sorted = useMemo(() => [...data].sort((a, b) => b.entries + b.exits - (a.entries + a.exits)), [data]);
  const combined = sorted.reduce((s, r) => s + r.entries + r.exits, 0);
  const peakLabel = (h: number | null) => (h === null ? '—' : `${hourLabel(h)} – ${hourLabel((h + 1) % 24)}`);

  return (
    <div id="table-top-entry-points" className="bg-white rounded-xl border border-slate-200 shadow-2xs hover:shadow-xs transition-all overflow-hidden flex flex-col justify-between relative">
      {hovered && (
        <InteractiveFloatingTooltip
          visible
          position={pos}
          title={hovered.deviceLabel}
          subtitle="Entrance"
          icon={DoorOpen}
          accentColor="#0D9488"
          badge={{ text: `Rank #${(hoveredIndex ?? 0) + 1} • ${hovered.contributionPct}% of traffic`, variant: 'cyan' }}
          metrics={[
            { label: 'Entries', value: `+${hovered.entries.toLocaleString()}`, color: '#34D399', icon: ArrowUpRight },
            { label: 'Exits', value: `-${hovered.exits.toLocaleString()}`, color: '#FB923C', icon: ArrowDownLeft },
            { label: 'Net Flow', value: hovered.net > 0 ? `+${hovered.net}` : `${hovered.net}`, color: hovered.net >= 0 ? '#10B981' : '#F43F5E' },
            { label: 'Unique Employees', value: hovered.uniqueEmployees.toLocaleString(), color: '#38BDF8', icon: Users },
            { label: 'Peak Activity Time', value: peakLabel(hovered.peakActivity), color: '#FBBF24', icon: Clock },
          ]}
          progress={{ label: 'Share of all traffic', value: hovered.contributionPct, displayValue: `${hovered.contributionPct}% of all movements`, color: '#0D9488' }}
        />
      )}

      <div className="p-4 sm:p-5 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-teal-600"></div>
            <h3 className="text-sm font-bold text-slate-900 tracking-tight">Top Entrances by Traffic</h3>
            <span className="text-xs bg-slate-100 text-slate-600 font-semibold px-2 py-0.5 rounded-full border border-slate-200">{data.length} Entrances</span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">Entrances ranked by how many people came in and left</p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-slate-200 text-[11px] font-semibold text-slate-500 uppercase tracking-wider bg-slate-50/70">
              <th className="py-3 px-3 w-12 text-center">Rank</th>
              <th className="py-3 px-3">Entrance</th>
              <th className="py-3 px-3 text-right">Total Entries</th>
              <th className="py-3 px-3 text-right">Total Exits</th>
              <th className="py-3 px-3 text-right">Net Flow</th>
              <th className="py-3 px-3 text-right">Unique Employees</th>
              <th className="py-3 px-3">Traffic Share</th>
              <th className="py-3 px-3 text-right">Peak Activity Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sorted.map((item, index) => {
              const isHovered = hoveredIndex === index;
              return (
                <tr
                  key={item.deviceId}
                  data-testid="entrance-row"
                  onMouseEnter={(e) => { setHovered(item); setHoveredIndex(index); setPos({ x: e.clientX, y: e.clientY }); }}
                  onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
                  onMouseLeave={() => { setHovered(null); setHoveredIndex(null); setPos(null); }}
                  className={`transition-colors cursor-pointer ${isHovered ? 'bg-teal-50/70' : 'hover:bg-slate-50'}`}
                >
                  <td className="py-2.5 px-3 text-center font-mono font-bold text-slate-500">#{index + 1}</td>
                  <td className="py-2.5 px-3 font-semibold text-slate-900"><div className="flex items-center gap-2"><DoorOpen className={`w-3.5 h-3.5 ${isHovered ? 'text-teal-700' : 'text-teal-600'} shrink-0`} /><span className={isHovered ? 'text-teal-900' : ''}>{item.deviceLabel}</span></div></td>
                  <td className="py-2.5 px-3 text-right font-mono text-emerald-600 font-medium">+{item.entries.toLocaleString()}</td>
                  <td className="py-2.5 px-3 text-right font-mono text-orange-600 font-medium">-{item.exits.toLocaleString()}</td>
                  <td className="py-2.5 px-3 text-right font-mono font-bold"><span className={item.net >= 0 ? 'text-emerald-700' : 'text-rose-700'}>{item.net > 0 ? `+${item.net}` : item.net}</span></td>
                  <td className="py-2.5 px-3 text-right font-mono text-slate-800 font-medium">{item.uniqueEmployees.toLocaleString()}</td>
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-2">
                      <div className="w-16 bg-slate-100 rounded-full h-2 overflow-hidden"><div className="bg-teal-600 h-full rounded-full transition-all duration-200" style={{ width: `${item.contributionPct}%` }}></div></div>
                      <span className="font-mono text-slate-700 font-semibold text-[11px]">{item.contributionPct}%</span>
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono text-slate-600">{peakLabel(item.peakActivity)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {sorted.length === 0 && <WidgetState error={error} loading={loading} empty emptyText="No entrance activity recorded for this selection." />}
      </div>

      <div className="p-3 bg-slate-50/70 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500">
        <span>Combined movements: <strong>{combined.toLocaleString()}</strong></span>
        <span className="text-slate-400">Hover a row for details</span>
      </div>
    </div>
  );
};
