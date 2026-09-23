import React, { useState } from 'react';
import { X, Layers, ExternalLink } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import type { EmployeeZoneRow } from '../lib/types';
import { fmtConfidence, fmtMinutes } from '../lib/format';
import { Avatar } from '../lib/Avatar';

interface Props {
  selectedEmployees: EmployeeZoneRow[];
  /** Employees that can still be added (from the current list). */
  candidates: EmployeeZoneRow[];
  onClose: () => void;
  onToggleEmployee: (row: EmployeeZoneRow) => void;
  onSelectEmployeeForDrilldown: (row: EmployeeZoneRow) => void;
}

type Tab = 'traffic' | 'dwell' | 'confidence' | 'matrix';

/** Multi-Employee Compare (Req 9.5): Zone Visits & Movements, Time Spent Inside, Match Confidence (mean only) and a side-by-side matrix. */
export const MultiEmployeeCompareModal: React.FC<Props> = ({ selectedEmployees, candidates, onClose, onToggleEmployee, onSelectEmployeeForDrilldown }) => {
  const [tab, setTab] = useState<Tab>('traffic');
  const chartData = selectedEmployees.map((e) => ({
    fullName: e.name,
    visits: e.totalZoneVisits,
    dwellHours: Number((e.totalTimeInsideMinutes / 60).toFixed(1)),
    entries: e.entries,
    exits: e.exits,
    avgDuration: e.avgVisitMinutes ?? 0,
    confidence: e.avgMatchConfidence === null ? 0 : Math.round(e.avgMatchConfidence * 100),
  }));
  const addable = candidates.filter((c) => !selectedEmployees.some((s) => s.employeeId === c.employeeId));

  const tabBtn = (t: Tab, label: string) => (
    <button type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`pb-2.5 px-3 text-xs font-semibold border-b-2 transition-all cursor-pointer ${tab === t ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{label}</button>
  );

  return (
    <div id="multi-employee-comparison-modal-backdrop" role="presentation" className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div id="multi-employee-comparison-modal-container" role="dialog" aria-modal="true" aria-label="Compare employees" className="bg-white w-full max-w-5xl rounded-2xl shadow-2xl border border-slate-200 overflow-hidden my-6 max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="bg-slate-900 text-white p-5 flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white"><Layers className="w-5 h-5" /></div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-xl font-bold tracking-tight text-white">Compare Employee Zone Activity</h2>
                <span data-testid="compare-modal-count" className="font-mono text-xs px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">{selectedEmployees.length} Selected</span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">Compare zone visits, time spent inside zones and match confidence</p>
            </div>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700 transition-colors cursor-pointer"><X className="w-5 h-5" /></button>
        </div>

        <div className="bg-slate-50 p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-slate-500 font-semibold uppercase text-[10px]">Comparing:</span>
            {selectedEmployees.map((e) => (
              <span key={e.employeeId} className="inline-flex items-center gap-1.5 bg-white border border-slate-200 text-slate-800 px-2.5 py-1 rounded-lg shadow-2xs font-medium">
                <Avatar name={e.name} size="sm" seed={e.employeeId} className="!w-4 !h-4 !text-[7px] !rounded-full" />
                <span>{e.name}</span>
                <button type="button" aria-label={`Remove ${e.name}`} onClick={() => onToggleEmployee(e)} className="text-slate-400 hover:text-rose-600 ml-1 cursor-pointer"><X className="w-3 h-3" /></button>
              </span>
            ))}
          </div>
          <label className="flex items-center gap-2">
            <span className="text-slate-500 font-medium">Add to comparison:</span>
            <select
              aria-label="Add employee"
              value=""
              onChange={(e) => { const row = addable.find((c) => String(c.employeeId) === e.target.value); if (row) onToggleEmployee(row); }}
              className="bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-xs text-slate-800 font-medium outline-none focus:ring-2 focus:ring-indigo-500/20"
            >
              <option value="" disabled>+ Select an employee...</option>
              {addable.map((c) => <option key={c.employeeId} value={String(c.employeeId)}>{c.name} ({c.department ?? '—'})</option>)}
            </select>
          </label>
        </div>

        <div role="tablist" className="px-6 pt-4 border-b border-slate-200 flex gap-2 flex-wrap">
          {tabBtn('traffic', 'Zone Visits & Movements')}
          {tabBtn('dwell', 'Time Spent Inside')}
          {tabBtn('confidence', 'Match Confidence')}
          {tabBtn('matrix', 'Side-by-Side Comparison Matrix')}
        </div>

        <div className="p-6 overflow-y-auto flex-1">
          {tab === 'traffic' && (
            <div className="space-y-4">
              <div><h4 className="text-sm font-bold text-slate-900">Zone Visits and Entries / Exits</h4><p className="text-xs text-slate-500">How often each employee entered a zone and passed the entrances</p></div>
              <div className="h-72 w-full mt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 20, right: 30, left: 0, bottom: 5 }} barGap={4}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
                    <XAxis dataKey="fullName" stroke="#64748B" fontSize={11} tickLine={false} />
                    <YAxis stroke="#94A3B8" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                    <Bar dataKey="visits" name="Zone Visits" fill="#4F46E5" radius={[4, 4, 0, 0]} maxBarSize={28} />
                    <Bar dataKey="entries" name="Entries In" fill="#10B981" radius={[4, 4, 0, 0]} maxBarSize={28} />
                    <Bar dataKey="exits" name="Exits Out" fill="#F97316" radius={[4, 4, 0, 0]} maxBarSize={28} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
          {tab === 'dwell' && (
            <div className="space-y-4">
              <div><h4 className="text-sm font-bold text-slate-900">Time Spent Inside and Average Visit</h4><p className="text-xs text-slate-500">Worked out from matching entries and exits inside zones</p></div>
              <div className="h-72 w-full mt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 20, right: 30, left: 0, bottom: 5 }} barGap={6}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
                    <XAxis dataKey="fullName" stroke="#64748B" fontSize={11} tickLine={false} />
                    <YAxis stroke="#94A3B8" fontSize={11} tickLine={false} axisLine={false} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                    <Bar dataKey="dwellHours" name="Total Hours Inside (h)" fill="#2563EB" radius={[4, 4, 0, 0]} maxBarSize={32} />
                    <Bar dataKey="avgDuration" name="Average Visit (min)" fill="#06B6D4" radius={[4, 4, 0, 0]} maxBarSize={32} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
          {tab === 'confidence' && (
            <div className="space-y-4">
              <div><h4 className="text-sm font-bold text-slate-900">Mean Match Confidence</h4><p className="text-xs text-slate-500">On average, how sure the system was that it matched the right person</p></div>
              <div className="h-72 w-full mt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 20, right: 30, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
                    <XAxis dataKey="fullName" stroke="#64748B" fontSize={11} tickLine={false} />
                    <YAxis domain={[0, 100]} unit="%" stroke="#94A3B8" fontSize={11} tickLine={false} axisLine={false} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                    <Bar dataKey="confidence" name="Mean Match Confidence (%)" fill="#8B5CF6" radius={[4, 4, 0, 0]} maxBarSize={40} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
          {tab === 'matrix' && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse" data-testid="compare-matrix">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                    <th className="py-3 px-3">Measure</th>
                    {selectedEmployees.map((e) => <th key={e.employeeId} className="py-3 px-3"><div className="flex items-center gap-2"><Avatar name={e.name} size="sm" seed={e.employeeId} className="!w-5 !h-5 !text-[8px]" /><span>{e.name}</span></div></th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium">
                  {([
                    ['Employee ID', (e: EmployeeZoneRow) => e.employeeCode],
                    ['Department', (e: EmployeeZoneRow) => e.department ?? '—'],
                    ['Total Zone Visits', (e: EmployeeZoneRow) => String(e.totalZoneVisits)],
                    ['Total Time Inside', (e: EmployeeZoneRow) => fmtMinutes(e.totalTimeInsideMinutes)],
                    ['Average Visit', (e: EmployeeZoneRow) => fmtMinutes(e.avgVisitMinutes)],
                    ['Entries / Exits', (e: EmployeeZoneRow) => `+${e.entries} / -${e.exits}`],
                    ['Mean Match Confidence', (e: EmployeeZoneRow) => fmtConfidence(e.avgMatchConfidence)],
                  ] as [string, (e: EmployeeZoneRow) => string][]).map(([label, get]) => (
                    <tr key={label}>
                      <td className="py-2.5 px-3 text-slate-500 font-semibold">{label}</td>
                      {selectedEmployees.map((e) => <td key={e.employeeId} className="py-2.5 px-3 font-mono text-slate-800">{get(e)}</td>)}
                    </tr>
                  ))}
                  <tr>
                    <td className="py-2.5 px-3 text-slate-500 font-semibold">Individual Drilldown</td>
                    {selectedEmployees.map((e) => (
                      <td key={e.employeeId} className="py-2.5 px-3">
                        <button type="button" onClick={() => { onClose(); onSelectEmployeeForDrilldown(e); }} className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-semibold cursor-pointer"><span>Open Drilldown</span><ExternalLink className="w-3 h-3" /></button>
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between text-xs text-slate-500">
          <span>Comparing {selectedEmployees.length} employee profiles</span>
          <button type="button" onClick={onClose} className="px-4 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-medium text-xs shadow-xs cursor-pointer">Close Comparison</button>
        </div>
      </div>
    </div>
  );
};
