import React from 'react';
import { Search, ArrowUpDown, ExternalLink, Layers } from 'lucide-react';
import type { EmployeeZoneRow, EmployeesData } from '../lib/types';
import { fmtConfidence, fmtDateTime, fmtMinutes } from '../lib/format';
import { Avatar } from '../lib/Avatar';
import { WidgetState } from '../lib/ViewHeader';

interface Props {
  data: EmployeesData | null;
  error?: string | null;
  loading?: boolean;
  q: string;
  onQChange: (q: string) => void;
  sort: 'visits' | 'time';
  onSortChange: (field: 'visits' | 'time') => void;
  selectedIds: number[];
  onToggleSelect: (row: EmployeeZoneRow) => void;
  onSelectAll: (rows: EmployeeZoneRow[]) => void;
  onClearAll: () => void;
  onOpenDrilldown: (row: EmployeeZoneRow) => void;
  onOpenComparison: () => void;
}

/** Top Employees by Zone Activity (Req 9.4): ranked by zone visits, with selection, Compare Selected and search. */
export const TopEmployeesTable: React.FC<Props> = ({
  data, error, loading, q, onQChange, sort, onSortChange, selectedIds, onToggleSelect, onSelectAll, onClearAll, onOpenDrilldown, onOpenComparison,
}) => {
  const rows = data?.rows ?? [];
  const allSelected = rows.length > 0 && rows.every((r) => selectedIds.includes(r.employeeId));

  return (
    <div id="table-top-employees-activity" className="bg-white rounded-xl border border-slate-200 shadow-2xs hover:shadow-xs transition-all overflow-hidden flex flex-col">
      <div className="p-4 sm:p-5 border-b border-slate-100 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-blue-600"></div>
            <h3 className="text-sm font-bold text-slate-900 tracking-tight">Top Employees by Zone Activity</h3>
            <span data-testid="top-total" className="text-xs bg-slate-100 text-slate-600 font-semibold px-2 py-0.5 rounded-full border border-slate-200">{data?.total ?? 0} Records</span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">Ranked by zone visits, time spent inside zones and entries and exits</p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {selectedIds.length > 0 && (
            <button type="button" onClick={onOpenComparison} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-xs transition-all cursor-pointer">
              <Layers className="w-3.5 h-3.5" />
              <span>Compare Selected ({selectedIds.length})</span>
            </button>
          )}
          <div className="relative w-48 sm:w-56">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input type="text" aria-label="Search top employees" value={q} onChange={(e) => onQChange(e.target.value)} placeholder="Search by name, ID..." className="w-full pl-8 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500" />
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-slate-200 text-[11px] font-semibold text-slate-500 uppercase tracking-wider bg-slate-50/70">
              <th className="py-3 px-3 w-10 text-center">
                <input type="checkbox" aria-label="Select all for comparison" checked={allSelected} onChange={(e) => (e.target.checked ? onSelectAll(rows) : onClearAll())} className="rounded text-blue-600 accent-blue-600 cursor-pointer" title="Select all for comparison" />
              </th>
              <th className="py-3 px-2 w-12 text-center">Rank</th>
              <th className="py-3 px-3">Employee</th>
              <th className="py-3 px-3">Department</th>
              <th className="py-3 px-3 text-right"><button type="button" aria-label="Sort by zone visits" aria-pressed={sort === 'visits'} onClick={() => onSortChange('visits')} className="inline-flex items-center gap-1 uppercase cursor-pointer hover:text-slate-900"><span>Zone Visits</span><ArrowUpDown className="w-3 h-3 text-slate-400" /></button></th>
              <th className="py-3 px-3 text-right"><button type="button" aria-label="Sort by total time inside" aria-pressed={sort === 'time'} onClick={() => onSortChange('time')} className="inline-flex items-center gap-1 uppercase cursor-pointer hover:text-slate-900"><span>Total Time Inside</span><ArrowUpDown className="w-3 h-3 text-slate-400" /></button></th>
              <th className="py-3 px-3 text-right">Avg Duration</th>
              <th className="py-3 px-3 text-right">Entries</th>
              <th className="py-3 px-3 text-right">Exits</th>
              <th className="py-3 px-3 text-right">Match Confidence</th>
              <th className="py-3 px-3 text-right">Last Seen</th>
              <th className="py-3 px-3 text-center">Drilldown</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((emp, index) => {
              const isSelected = selectedIds.includes(emp.employeeId);
              return (
                <tr key={emp.employeeId} data-testid="top-employee-row" className={`hover:bg-blue-50/40 transition-colors ${isSelected ? 'bg-indigo-50/30' : ''}`}>
                  <td className="py-2.5 px-3 text-center"><input type="checkbox" aria-label={`Select ${emp.name}`} checked={isSelected} onChange={() => onToggleSelect(emp)} className="rounded text-blue-600 accent-blue-600 cursor-pointer" /></td>
                  <td className="py-2.5 px-2 text-center font-mono font-bold text-slate-500">#{index + 1}</td>
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={emp.name} size="sm" seed={emp.employeeId} />
                      <div>
                        <button type="button" onClick={() => onOpenDrilldown(emp)} className="font-semibold text-slate-900 hover:text-blue-600 cursor-pointer text-left">{emp.name}</button>
                        <div className="text-[10px] text-slate-400 font-mono">{emp.employeeCode} • {emp.role ?? '—'}</div>
                      </div>
                    </div>
                  </td>
                  <td className="py-2.5 px-3"><span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium bg-slate-100 text-slate-700">{emp.department ?? '—'}</span></td>
                  <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900">{emp.totalZoneVisits}</td>
                  <td className="py-2.5 px-3 text-right font-mono text-blue-700 font-semibold">{fmtMinutes(emp.totalTimeInsideMinutes)}</td>
                  <td className="py-2.5 px-3 text-right font-mono text-slate-600">{fmtMinutes(emp.avgVisitMinutes)}</td>
                  <td className="py-2.5 px-3 text-right font-mono text-emerald-600 font-medium">+{emp.entries}</td>
                  <td className="py-2.5 px-3 text-right font-mono text-orange-600 font-medium">-{emp.exits}</td>
                  <td className="py-2.5 px-3 text-right"><span className="font-mono text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">{fmtConfidence(emp.avgMatchConfidence)}</span></td>
                  <td className="py-2.5 px-3 text-right font-mono text-slate-500 text-[11px]">{fmtDateTime(emp.lastSeen)}</td>
                  <td className="py-2.5 px-3 text-center"><button type="button" aria-label={`Open drilldown for ${emp.name}`} onClick={() => onOpenDrilldown(emp)} className="p-1 rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors cursor-pointer" title="Open the employee drilldown"><ExternalLink className="w-3.5 h-3.5" /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <WidgetState error={error} loading={loading} empty emptyText="No employee activity recorded for this selection." />}
      </div>

      <div className="p-3 bg-slate-50/70 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between text-[11px] text-slate-500 gap-2">
        <span>Showing <strong>{rows.length}</strong> of {data?.total ?? 0} employees, ranked by {sort === 'visits' ? 'zone visits' : 'time inside'}. Choose a name to open the employee drilldown.</span>
        <span className="text-slate-400">Zone activity only</span>
      </div>
    </div>
  );
};
