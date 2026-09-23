import React from 'react';
import {
  Users, Clock, LogIn, LogOut, ScanFace, Search, ArrowUpDown, ChevronDown, ChevronUp, ExternalLink, Layers, MapPin,
  Footprints, X, BarChart2, LayoutGrid, Activity, ChevronLeft, ChevronRight,
} from 'lucide-react';
import type { DepartmentOption, EmployeeZoneRow, EmployeesData, MovementDetail } from '../lib/types';
import { fmtConfidence, fmtDateTime, fmtMinutes, fmtTime, zoneColor } from '../lib/format';
import { KPI_COPY } from '../lib/copy';
import { Avatar } from '../lib/Avatar';
import { EvidencePhoto } from '../lib/EvidencePhoto';
import { WidgetState } from '../lib/ViewHeader';

export type ViewMode = 'cards' | 'matrix' | 'compare';
export type SortField = 'time' | 'visits' | 'confidence' | 'firstSeen';
export type StatusFilter = 'all' | 'currently' | 'long' | 'multi';

export interface EmployeeControls {
  q: string;
  department: string;
  status: StatusFilter;
  sort: SortField;
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

interface Props {
  data: EmployeesData | null;
  error?: string | null;
  loading?: boolean;
  controls: EmployeeControls;
  onControlsChange: (next: Partial<EmployeeControls>) => void;
  departments: DepartmentOption[];
  /** Stable colour per zone name across cards. */
  zoneOrder: string[];
  viewMode: ViewMode;
  onViewModeChange: (m: ViewMode) => void;
  selectedIds: number[];
  onToggleSelect: (row: EmployeeZoneRow) => void;
  selectedRows: EmployeeZoneRow[];
  onSelectTop: () => void;
  onOpenDrilldown: (row: EmployeeZoneRow) => void;
  onOpenComparisonModal: () => void;
  expandedId: number | null;
  onExpandedChange: (id: number | null) => void;
  detail: { data: MovementDetail | null; error: string | null; loading: boolean };
  /** Date-range control rendered in the section header (owned by the page). */
  dateControls?: React.ReactNode;
}

/** Employee-Wise Zone Analytics & Movement (Req 9.1-9.3). Every figure is a real query result. */
export const EmployeeZoneAnalytics: React.FC<Props> = ({
  data, error, loading, controls, onControlsChange, departments, zoneOrder, viewMode, onViewModeChange, selectedIds, onToggleSelect,
  selectedRows, onSelectTop, onOpenDrilldown, onOpenComparisonModal, expandedId, onExpandedChange, detail, dateControls,
}) => {
  const rows = data?.rows ?? [];
  const summary = data?.summary;
  const colorOf = (zone: string) => zoneColor(Math.max(0, zoneOrder.indexOf(zone)));
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / controls.pageSize));

  const viewBtn = (mode: ViewMode, id: string, label: string, Icon: React.ComponentType<{ className?: string }>, title: string) => (
    <button
      id={id}
      type="button"
      aria-pressed={viewMode === mode}
      onClick={() => onViewModeChange(mode)}
      className={`px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${viewMode === mode ? 'bg-white text-slate-900 shadow-2xs' : 'text-slate-600 hover:text-slate-900'}`}
      title={title}
    >
      <Icon className="w-3.5 h-3.5" />
      <span>{label}</span>
    </button>
  );

  return (
    <div id="section-employee-zone-analytics" className="glass-card rounded-xl overflow-hidden transition-all">
      <div className="p-4 sm:p-5 border-b border-slate-200/60 bg-slate-50/40">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-600"><Users className="w-4 h-4" /></div>
              <h3 className="text-base font-medium text-slate-900 tracking-tight">Employee-Wise Zone Analytics & Movement</h3>
            </div>
            <p className="text-xs text-slate-500 mt-1">How each employee moves between zones: time spent, zone visits, entrances used and how sure the system was of each match</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 self-start lg:self-auto">
            {dateControls}
            <div className="flex items-center bg-slate-200/70 p-0.5 rounded-lg border border-slate-200 text-slate-600" role="group" aria-label="View">
              {viewBtn('cards', 'btn-view-cards', 'Employee Profiles', LayoutGrid, 'Employee profile cards with the day\'s activity')}
              {viewBtn('matrix', 'btn-view-matrix', 'Zone Time Matrix', BarChart2, 'Time each employee spent in each zone')}
              {viewBtn('compare', 'btn-view-compare', `Compare (${selectedIds.length})`, Layers, 'Side-by-side comparison of selected employees')}
            </div>
            {selectedIds.length > 0 && (
              <button type="button" onClick={onOpenComparisonModal} className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-50 border border-indigo-200 text-indigo-700 hover:bg-indigo-100 text-xs font-semibold transition-colors cursor-pointer">
                <ExternalLink className="w-3.5 h-3.5" />
                <span>Full Comparison</span>
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 pt-3 border-t border-slate-200/60">
          <div className="p-2.5 rounded-lg bg-white border border-slate-200/70 flex items-center justify-between" title={KPI_COPY.trackedEmployees.description}>
            <div>
              <span className="text-[10px] font-semibold uppercase text-slate-500 block">{KPI_COPY.trackedEmployees.title}</span>
              <div className="flex items-baseline gap-1.5 mt-0.5">
                <span data-testid="summary-tracked" className="text-lg font-black font-mono text-slate-900">{summary ? summary.trackedEmployees : '—'}</span>
                <span className="text-[11px] text-slate-500">employees</span>
              </div>
              <span className="text-[10px] text-slate-400 block">{KPI_COPY.trackedEmployees.description}</span>
            </div>
          </div>
          <div className="p-2.5 rounded-lg bg-white border border-slate-200/70 flex items-center justify-between" title={KPI_COPY.meanTime.description}>
            <div>
              <span className="text-[10px] font-semibold uppercase text-slate-500 block">{KPI_COPY.meanTime.title}</span>
              <div className="flex items-baseline gap-1.5 mt-0.5">
                <span data-testid="summary-mean-time" className="text-lg font-black font-mono text-slate-900">{fmtMinutes(summary?.meanTimeInZoneMinutes)}</span>
                <span className="text-[11px] text-slate-500">/ employee</span>
              </div>
              <span className="text-[10px] text-slate-400 block">{KPI_COPY.meanTime.description}</span>
            </div>
            <div className="p-1.5 rounded-md bg-blue-50 text-blue-600"><Clock className="w-4 h-4" /></div>
          </div>
          <div className="p-2.5 rounded-lg bg-white border border-slate-200/70 flex items-center justify-between" title={KPI_COPY.mostActive.description}>
            <div className="min-w-0">
              <span className="text-[10px] font-semibold uppercase text-slate-500 block">{KPI_COPY.mostActive.title}</span>
              <div className="flex items-baseline gap-1.5 mt-0.5 truncate max-w-[130px]"><span data-testid="summary-most-active" className="text-xs font-bold text-slate-900 truncate">{summary?.mostActiveEmployee?.name ?? '—'}</span></div>
              <span className="text-[10px] text-slate-400 font-mono">{summary?.mostActiveEmployee ? `${summary.mostActiveEmployee.zoneVisits} zone visits` : KPI_COPY.mostActive.description}</span>
            </div>
            <div className="p-1.5 rounded-md bg-indigo-50 text-indigo-600"><Footprints className="w-4 h-4" /></div>
          </div>
          <div className="p-2.5 rounded-lg bg-white border border-slate-200/70 flex items-center justify-between" title={KPI_COPY.meanConfidence.description}>
            <div>
              <span className="text-[10px] font-semibold uppercase text-slate-500 block">{KPI_COPY.meanConfidence.title}</span>
              <div className="flex items-baseline gap-1.5 mt-0.5"><span data-testid="summary-mean-confidence" className="text-lg font-black font-mono text-emerald-700">{fmtConfidence(summary?.meanMatchConfidence)}</span></div>
              <span className="text-[10px] text-slate-400 block">{KPI_COPY.meanConfidence.description}</span>
            </div>
            <div className="p-1.5 rounded-md bg-emerald-50 text-emerald-600"><ScanFace className="w-4 h-4" /></div>
          </div>
        </div>
      </div>

      <div className="p-4 border-b border-slate-200/70 bg-white flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="relative w-full md:w-72">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            id="input-search-employee-zone"
            type="text"
            aria-label="Search employees"
            value={controls.q}
            onChange={(e) => onControlsChange({ q: e.target.value, page: 1 })}
            placeholder="Search by employee name or ID..."
            className="w-full pl-8 pr-7 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800 placeholder-slate-400 focus:outline-none focus:bg-white focus:ring-1 focus:ring-blue-500"
          />
          {controls.q && <button type="button" aria-label="Clear search" onClick={() => onControlsChange({ q: '', page: 1 })} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"><X className="w-3 h-3" /></button>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs">
            <span className="text-slate-400 font-medium hidden sm:inline">Dept:</span>
            <select aria-label="Department" value={controls.department} onChange={(e) => onControlsChange({ department: e.target.value, page: 1 })} className="bg-slate-50 border border-slate-200 text-slate-700 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:bg-white focus:ring-1 focus:ring-blue-500 font-medium">
              <option value="">All</option>
              {departments.map((d) => <option key={d.departmentId} value={String(d.departmentId)}>{d.name}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1 text-xs">
            <span className="text-slate-400 font-medium hidden sm:inline">Status:</span>
            <select aria-label="Status" value={controls.status} onChange={(e) => onControlsChange({ status: e.target.value as StatusFilter, page: 1 })} className="bg-slate-50 border border-slate-200 text-slate-700 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:bg-white focus:ring-1 focus:ring-blue-500 font-medium">
              <option value="all">All Employees</option>
              <option value="currently">Currently in Zone</option>
              <option value="long">Long Stay (&gt;4h)</option>
              <option value="multi">Multi-Zone</option>
            </select>
          </label>
          <div className="flex items-center gap-1 text-xs">
            <label className="flex items-center gap-1">
              <span className="text-slate-400 font-medium hidden sm:inline">Sort:</span>
              <select aria-label="Sort by" value={controls.sort} onChange={(e) => onControlsChange({ sort: e.target.value as SortField, page: 1 })} className="bg-slate-50 border border-slate-200 text-slate-700 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:bg-white focus:ring-1 focus:ring-blue-500 font-medium">
                <option value="time">Time in Zone</option>
                <option value="visits">Total Visits</option>
                <option value="confidence">Match Confidence</option>
                <option value="firstSeen">First Seen</option>
              </select>
            </label>
            <button type="button" aria-label="Toggle sort direction" onClick={() => onControlsChange({ dir: controls.dir === 'asc' ? 'desc' : 'asc', page: 1 })} className="p-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-600 transition-colors cursor-pointer" title={`Sorting ${controls.dir === 'desc' ? 'Descending' : 'Ascending'}`}>
              <ArrowUpDown className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {viewMode === 'cards' && (
        <div className="p-4 sm:p-5 bg-slate-50/30 space-y-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Showing <strong data-testid="showing-count">{rows.length}</strong> of <strong>{data?.total ?? 0}</strong> employees matching the criteria</span>
            <span className="hidden sm:inline">Open "View Activity Trail" on a card to see the day's events, entrances used and photos</span>
          </div>
          {rows.length === 0 && <WidgetState error={error} loading={loading} empty emptyText="No employee activity recorded for this selection." />}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {rows.map((emp) => {
              const isExpanded = expandedId === emp.employeeId;
              const isCompared = selectedIds.includes(emp.employeeId);
              const total = emp.zoneMinutes.reduce((s, z) => s + z.minutes, 0);
              return (
                <div key={emp.employeeId} id={`employee-zone-card-${emp.employeeId}`} data-testid="employee-card" className={`bg-white rounded-xl border transition-all ${isExpanded ? 'border-blue-300 ring-1 ring-blue-100 shadow-xs' : 'border-slate-200/90 shadow-2xs hover:shadow-xs'}`}>
                  <div className="p-4 flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="relative shrink-0">
                        <Avatar name={emp.name} seed={emp.employeeId} />
                        <span className={`absolute -bottom-1 -right-1 w-3.5 h-3.5 rounded-full border-2 border-white ${emp.currentlyInZone ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} title={emp.currentlyInZone ? 'Inside a zone right now' : 'Not inside a zone right now'} />
                      </div>
                      <div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <h4 className="text-sm font-bold text-slate-900 leading-tight">{emp.name}</h4>
                          <span className="font-mono text-[10px] px-1.5 rounded bg-slate-100 text-slate-600 font-semibold border border-slate-200">{emp.employeeCode}</span>
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">{emp.role ?? '—'}</p>
                        <div className="flex items-center gap-2 mt-1.5 text-[11px] flex-wrap">
                          <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 font-medium">{emp.department ?? '—'}</span>
                          <span className={`inline-flex items-center gap-1 font-semibold ${emp.currentlyInZone ? 'text-emerald-700' : 'text-slate-500'}`}>
                            <MapPin className="w-3 h-3" />
                            {emp.currentlyInZone ? 'Inside a zone now' : `Primary zone: ${emp.primaryZone ?? '—'}`}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <label className={`cursor-pointer px-2 py-1 rounded-md text-[11px] font-semibold border flex items-center gap-1 transition-all ${isCompared ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'}`} title="Add to side-by-side comparison">
                        <input type="checkbox" aria-label={`Compare ${emp.name}`} checked={isCompared} onChange={() => onToggleSelect(emp)} className="sr-only" />
                        <Layers className="w-3 h-3" />
                        <span>{isCompared ? 'Compared' : 'Compare'}</span>
                      </label>
                      <button type="button" aria-label={`Open drilldown for ${emp.name}`} onClick={() => onOpenDrilldown(emp)} className="p-1 rounded-md text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors cursor-pointer" title="Open the full employee drilldown">
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="px-4 pb-2">
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <span className="text-slate-500 font-medium">Time across zones</span>
                      <span className="font-mono text-slate-700 font-bold">{fmtMinutes(total)} total</span>
                    </div>
                    <div className="h-2.5 w-full bg-slate-100 rounded-full overflow-hidden flex gap-0.5 p-0.5 border border-slate-200/80" data-testid="zone-time-bar">
                      {emp.zoneMinutes.filter((z) => z.minutes > 0).map((z) => (
                        <div key={z.zone} data-zone={z.zone} className="h-full rounded-xs transition-all" style={{ width: `${total > 0 ? (z.minutes / total) * 100 : 0}%`, backgroundColor: colorOf(z.zone) }} title={`${z.zone}: ${fmtMinutes(z.minutes)} (${total > 0 ? Math.round((z.minutes / total) * 100) : 0}%)`} />
                      ))}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-1.5 text-[10px] text-slate-500">
                      {emp.zoneMinutes.map((z) => (
                        <span key={z.zone} className="inline-flex items-center gap-1 font-mono">
                          <span className="w-2 h-2 rounded-xs inline-block" style={{ backgroundColor: colorOf(z.zone) }} />
                          <span>{z.zone}:</span><span>{fmtMinutes(z.minutes)}</span>
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="p-4 pt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
                    <div className="p-2 rounded-lg bg-slate-50 border border-slate-100" title={KPI_COPY.timeInZone.description}>
                      <span className="text-[10px] text-slate-400 uppercase block font-medium">{KPI_COPY.timeInZone.title}</span>
                      <span className="text-xs font-bold font-mono text-slate-900 mt-0.5 block">{fmtMinutes(emp.totalTimeInsideMinutes)}</span>
                      <span className="text-[10px] text-slate-400 block">{KPI_COPY.timeInZone.description}</span>
                    </div>
                    <div className="p-2 rounded-lg bg-slate-50 border border-slate-100" title={KPI_COPY.zoneVisits.description}>
                      <span className="text-[10px] text-slate-400 uppercase block font-medium">{KPI_COPY.zoneVisits.title}</span>
                      <span className="text-xs font-bold font-mono text-slate-900 mt-0.5 block">{emp.totalZoneVisits} visits</span>
                      <span className="text-[10px] text-slate-400 font-mono">+{emp.entries} In / -{emp.exits} Out</span>
                    </div>
                    <div className="p-2 rounded-lg bg-slate-50 border border-slate-100" title={KPI_COPY.matchConfidence.description}>
                      <span className="text-[10px] text-slate-400 uppercase block font-medium">{KPI_COPY.matchConfidence.title}</span>
                      <span className="text-xs font-bold font-mono text-emerald-700 mt-0.5 block">{fmtConfidence(emp.avgMatchConfidence)}</span>
                      <span className="text-[10px] text-slate-400 block">{KPI_COPY.matchConfidence.description}</span>
                    </div>
                    <div className="p-2 rounded-lg bg-slate-50 border border-slate-100" title={KPI_COPY.lastSeen.description}>
                      <span className="text-[10px] text-slate-400 uppercase block font-medium">{KPI_COPY.lastSeen.title}</span>
                      <span className="text-xs font-bold font-mono text-slate-800 mt-0.5 block truncate">{fmtTime(emp.lastSeen)}</span>
                      <span className="text-[10px] text-slate-400 font-mono">{fmtDateTime(emp.lastSeen).split(' ').slice(0, 2).join(' ')}</span>
                    </div>
                  </div>

                  <div className="px-4 py-2 bg-slate-50/60 border-t border-slate-100 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5 text-[11px] text-slate-500 truncate max-w-[280px]">
                      <Footprints className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span data-testid="recent-flow" className="truncate">Recent Flow: {emp.recentFlow.length > 0 ? emp.recentFlow.slice(-3).join(' → ') : '—'}</span>
                    </div>
                    <button type="button" aria-expanded={isExpanded} onClick={() => onExpandedChange(isExpanded ? null : emp.employeeId)} className="text-xs font-bold text-blue-600 hover:text-blue-700 flex items-center gap-1 cursor-pointer">
                      <span>{isExpanded ? 'Hide Activity Trail' : 'View Activity Trail'}</span>
                      {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                  </div>

                  {isExpanded && (
                    <div data-testid="activity-trail" className="p-4 border-t border-slate-200 bg-white space-y-3.5">
                      <div className="flex items-center justify-between pb-1 border-b border-slate-100 text-xs">
                        <span className="font-bold text-slate-800 flex items-center gap-1.5"><Activity className="w-3.5 h-3.5 text-blue-600" />Chronological Event Stream</span>
                        <span className="text-[10px] text-slate-400 font-mono">Camera and match confidence</span>
                      </div>
                      <WidgetState error={detail.error} loading={detail.loading} empty={!detail.loading && !detail.error && (detail.data?.events.length ?? 0) === 0} emptyText="No events recorded for this employee in the selected period." />
                      <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                        {(detail.data?.events ?? []).map((ev) => (
                          <div key={ev.id} data-testid="trail-event" className="flex items-start gap-2.5 p-2 rounded-lg bg-slate-50 border border-slate-100 text-xs">
                            <div className={`w-6 h-6 rounded-md shrink-0 flex items-center justify-center ${ev.eventType === 'entry' ? 'bg-blue-100 text-blue-800 border border-blue-200' : 'bg-slate-200 text-slate-700'}`}>
                              {ev.eventType === 'entry' ? <LogIn className="w-3 h-3" /> : <LogOut className="w-3 h-3" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-1">
                                <span className="font-semibold text-slate-800 truncate">{ev.eventType === 'entry' ? 'Entry' : 'Exit'} • {ev.zone ?? '—'}</span>
                                <span className="font-mono text-xs font-bold text-slate-700">{fmtTime(ev.timestamp)}</span>
                              </div>
                              <div className="flex items-center justify-between text-[11px] text-slate-500 mt-0.5">
                                <span>Entrance: {ev.entrance ?? '—'}</span>
                                <span className="font-mono text-emerald-700 font-semibold">{fmtConfidence(ev.confidence)} ({ev.cameraId ?? '—'})</span>
                              </div>
                            </div>
                            <EvidencePhoto photoUrl={ev.photoUrl} kind="Event photo" compact />
                          </div>
                        ))}
                      </div>
                      <div className="pt-2 border-t border-slate-100">
                        <span className="text-[11px] font-semibold text-slate-700 block mb-1.5">Preferred Entrances:</span>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                          {emp.entranceUsage.map((ep) => (
                            <div key={ep.entrance} className="p-1.5 rounded-md bg-slate-50 border border-slate-100 text-[11px] flex items-center justify-between">
                              <span className="text-slate-600 truncate mr-1">{ep.entrance}</span>
                              <span className="font-mono font-bold text-slate-900 bg-white px-1.5 rounded border border-slate-200">{ep.count}x</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-end gap-2 text-xs text-slate-500">
            <button type="button" aria-label="Previous page" disabled={controls.page <= 1} onClick={() => onControlsChange({ page: controls.page - 1 })} className="p-1 rounded border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"><ChevronLeft className="w-4 h-4" /></button>
            <span className="font-mono font-semibold text-slate-700">{controls.page} / {totalPages}</span>
            <button type="button" aria-label="Next page" disabled={controls.page >= totalPages} onClick={() => onControlsChange({ page: controls.page + 1 })} className="p-1 rounded border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"><ChevronRight className="w-4 h-4" /></button>
          </div>
        </div>
      )}

      {viewMode === 'matrix' && (
        <div className="p-4 sm:p-5 bg-white space-y-4" data-testid="zone-time-matrix">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b border-slate-200 text-xs">
            <div>
              <h4 className="font-bold text-slate-900">Time in Each Zone by Employee</h4>
              <p className="text-slate-500 text-[11px]">Minutes each employee spent inside every zone</p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[11px]">
              {zoneOrder.map((zone) => <div key={zone} className="flex items-center gap-1 font-mono"><span className="w-2.5 h-2.5 rounded-xs" style={{ backgroundColor: colorOf(zone) }} /><span className="text-slate-600">{zone}</span></div>)}
            </div>
          </div>
          {rows.length === 0 && <WidgetState error={error} loading={loading} empty emptyText="No employee activity recorded for this selection." />}
          <div className="space-y-3">
            {rows.map((emp) => {
              const total = emp.zoneMinutes.reduce((s, z) => s + z.minutes, 0);
              return (
                <div key={emp.employeeId} data-testid="matrix-employee" className="p-3 rounded-xl bg-slate-50/70 border border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 hover:bg-slate-50 transition-colors">
                  <div className="flex items-center gap-3 w-56 shrink-0">
                    <Avatar name={emp.name} size="sm" seed={emp.employeeId} />
                    <div className="min-w-0">
                      <div className="font-bold text-xs text-slate-900 truncate">{emp.name}</div>
                      <div className="text-[11px] text-slate-500 truncate">{emp.department ?? '—'} • {emp.employeeCode}</div>
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <span className="font-semibold text-slate-700">Total time in zones: {fmtMinutes(total)}</span>
                      <span className="text-slate-500 font-mono">{emp.totalZoneVisits} visits • {fmtConfidence(emp.avgMatchConfidence)} match</span>
                    </div>
                    <div className="h-3.5 w-full bg-slate-200 rounded-lg overflow-hidden flex gap-0.5 p-0.5">
                      {emp.zoneMinutes.filter((z) => z.minutes > 0).map((z) => {
                        const pct = total > 0 ? Math.round((z.minutes / total) * 100) : 0;
                        return <div key={z.zone} className="h-full rounded-xs transition-all flex items-center justify-center text-[9px] font-mono text-white font-bold overflow-hidden" style={{ width: `${pct}%`, backgroundColor: colorOf(z.zone) }} title={`${z.zone}: ${fmtMinutes(z.minutes)} (${pct}%)`}>{pct > 15 && `${pct}%`}</div>;
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 self-end md:self-auto">
                    <button type="button" onClick={() => onOpenDrilldown(emp)} className="px-2.5 py-1 rounded-lg bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 text-xs font-semibold shadow-2xs transition-colors cursor-pointer">Details</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {viewMode === 'compare' && (
        <div className="p-4 sm:p-5 bg-white space-y-4" data-testid="inline-compare">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b border-slate-200">
            <div>
              <h4 className="font-bold text-slate-900 text-sm">Side-by-Side Employee Comparison</h4>
              <p className="text-slate-500 text-xs">Comparing {selectedRows.length} selected employees</p>
            </div>
            <button type="button" onClick={onSelectTop} className="text-xs text-blue-600 hover:underline font-semibold cursor-pointer">Select the 3 most active</button>
          </div>
          {selectedRows.length === 0 ? (
            <div className="p-8 text-center text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-200">
              <Layers className="w-8 h-8 mx-auto mb-2 text-slate-300" />
              <p className="text-xs font-semibold text-slate-600">No employees selected for comparison</p>
              <p className="text-[11px] text-slate-400 mt-0.5">Choose "Compare" on any employee profile.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4 min-w-[700px]">
                {selectedRows.map((emp) => (
                  <div key={emp.employeeId} data-testid="compare-card" className="bg-slate-50/70 rounded-xl border border-slate-200 p-4 space-y-3.5">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={emp.name} size="sm" seed={emp.employeeId} />
                        <div>
                          <h5 className="font-bold text-xs text-slate-900 truncate max-w-[120px]">{emp.name}</h5>
                          <span className="text-[10px] text-slate-500 font-mono">{emp.employeeCode}</span>
                        </div>
                      </div>
                      <button type="button" aria-label={`Remove ${emp.name} from comparison`} onClick={() => onToggleSelect(emp)} className="text-slate-400 hover:text-slate-600 p-1 cursor-pointer" title="Remove from comparison"><X className="w-3.5 h-3.5" /></button>
                    </div>
                    <div className="space-y-2 pt-2 border-t border-slate-200/80 text-xs">
                      {([
                        ['Department', emp.department ?? '—'],
                        ['Time in Zone', fmtMinutes(emp.totalTimeInsideMinutes)],
                        ['Zone Visits', `${emp.totalZoneVisits} visits`],
                        ['Entries / Exits', `+${emp.entries} In / -${emp.exits} Out`],
                        ['Average Visit', fmtMinutes(emp.avgVisitMinutes)],
                        ['Mean Match Confidence', fmtConfidence(emp.avgMatchConfidence)],
                        ['First Seen', fmtDateTime(emp.firstSeen)],
                        ['Last Seen', fmtDateTime(emp.lastSeen)],
                      ] as [string, string][]).map(([k, v]) => <div key={k} className="flex justify-between py-1 border-b border-slate-200/50"><span className="text-slate-500">{k}</span><span className="font-mono text-slate-800 text-[11px]">{v}</span></div>)}
                    </div>
                    <button type="button" onClick={() => onOpenDrilldown(emp)} className="w-full py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-semibold transition-colors flex items-center justify-center gap-1 cursor-pointer">
                      <span>Individual Drilldown</span><ExternalLink className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
