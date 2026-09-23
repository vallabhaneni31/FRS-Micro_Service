import React, { useState } from 'react';
import { ArrowRight, Footprints, Flame } from 'lucide-react';
import type { TransitionRow } from '../lib/types';
import { InteractiveFloatingTooltip, FloatingTooltipPosition } from './CustomChartTooltip';
import { WidgetState } from '../lib/ViewHeader';

interface Props {
  transitions: TransitionRow[];
  error?: string | null;
  loading?: boolean;
}

/** Movement Between Zones: transition matrix built from consecutive same-day pings (Req 3.8, 7.2). */
export const EmployeeMovementMatrix: React.FC<Props> = ({ transitions, error, loading }) => {
  const total = transitions.reduce((s, t) => s + t.count, 0);
  const top = transitions[0] ?? null;
  const [hovered, setHovered] = useState<TransitionRow | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [pos, setPos] = useState<FloatingTooltipPosition | null>(null);

  return (
    <div id="chart-employee-movement-matrix" className="bg-white rounded-xl border border-slate-200 p-5 shadow-2xs hover:shadow-xs transition-all flex flex-col justify-between relative">
      {hovered && (
        <InteractiveFloatingTooltip
          visible
          position={pos}
          title={`${hovered.fromZone} → ${hovered.toZone}`}
          subtitle="Moves from one zone straight to another"
          icon={Footprints}
          accentColor="#9333EA"
          badge={hovered.isPrimary ? { text: 'Main Route', variant: 'purple' } : hovered.pct > 10 ? { text: 'Regular Route', variant: 'indigo' } : { text: 'Occasional Route', variant: 'slate' }}
          metrics={[
            { label: 'Moves', value: hovered.count.toLocaleString(), unit: 'moves', color: '#C084FC', icon: Footprints },
            { label: 'Share of all moves', value: `${hovered.pct}%`, color: '#E879F9' },
          ]}
          progress={{ label: 'Share of all moves', value: hovered.pct, displayValue: `${hovered.pct}% of movement between zones`, color: '#9333EA' }}
        />
      )}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-slate-100">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-purple-600"></div>
            <h3 className="text-sm font-bold text-slate-900 tracking-tight">Movement Between Zones</h3>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">Where employees go next: moves from one zone to another, taken from consecutive entries on the same day</p>
        </div>
        <div data-testid="top-flow" className="flex items-center gap-1.5 bg-purple-50 text-purple-800 px-2.5 py-1 rounded-lg border border-purple-200 text-xs font-semibold">
          <Flame className="w-3.5 h-3.5 text-purple-600" />
          <span>Top Flow: <strong>{top ? `${top.fromZone} → ${top.toZone}` : '—'}</strong>{top ? ` (${top.count})` : ''}</span>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-slate-200 text-[11px] font-semibold text-slate-400 uppercase tracking-wider bg-slate-50/50">
              <th className="py-2.5 px-3">From Zone</th>
              <th className="py-2.5 px-3 text-center">Path</th>
              <th className="py-2.5 px-3">To Zone</th>
              <th className="py-2.5 px-3 text-right">Moves</th>
              <th className="py-2.5 px-3">Share</th>
              <th className="py-2.5 px-3 text-right">Route Type</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {transitions.map((item, index) => {
              const isHovered = hoveredIndex === index;
              return (
                <tr
                  key={`${item.fromZone}-${item.toZone}`}
                  data-testid="transition-row"
                  onMouseEnter={(e) => { setHovered(item); setHoveredIndex(index); setPos({ x: e.clientX, y: e.clientY }); }}
                  onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
                  onMouseLeave={() => { setHovered(null); setHoveredIndex(null); setPos(null); }}
                  className={`transition-all duration-150 cursor-pointer ${isHovered ? 'bg-purple-100/70 shadow-xs' : item.isPrimary ? 'bg-purple-50/30 font-medium hover:bg-purple-50/70' : 'hover:bg-slate-50/80'}`}
                >
                  <td className="py-2.5 px-3 text-slate-800 font-medium"><span className="flex items-center gap-1.5"><span className={`w-1.5 h-1.5 rounded-full ${isHovered ? 'bg-purple-600 ring-2 ring-purple-300' : 'bg-slate-300'}`} />{item.fromZone}</span></td>
                  <td className="py-2.5 px-3 text-center text-slate-400"><ArrowRight className={`w-3.5 h-3.5 mx-auto transition-transform ${isHovered ? 'text-purple-700 translate-x-1' : 'text-purple-500'}`} /></td>
                  <td className="py-2.5 px-3 text-slate-800 font-medium">{item.toZone}</td>
                  <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900"><span className={isHovered ? 'text-purple-700 font-extrabold' : ''}>{item.count.toLocaleString()}</span></td>
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-slate-100 rounded-full h-2 overflow-hidden max-w-[100px]"><div className={`h-full rounded-full transition-all duration-200 ${isHovered ? 'bg-purple-700' : 'bg-purple-600'}`} style={{ width: `${item.pct}%` }}></div></div>
                      <span className="font-mono text-slate-600 text-[11px] w-9 font-semibold">{item.pct}%</span>
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-right">
                    {item.isPrimary ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-purple-700 bg-purple-100 px-2 py-0.5 rounded-full border border-purple-200">Main Route</span>
                    ) : item.pct > 10 ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full border border-blue-200">Regular</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full border border-slate-200">Occasional</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {transitions.length === 0 && <WidgetState error={error} loading={loading} empty emptyText="No moves between zones recorded for this selection." />}
      </div>

      <div className="flex items-center justify-between text-[11px] text-slate-500 pt-3 border-t border-slate-100 mt-3">
        <span>Moves between zones: <strong className="text-slate-800 font-mono">{total.toLocaleString()}</strong></span>
        <span className="text-slate-400">Hover a route to see its share</span>
      </div>
    </div>
  );
};
