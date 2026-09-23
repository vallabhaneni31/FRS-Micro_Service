import React, { useEffect, useMemo, useState } from 'react';
import { ViewHeader } from './lib/ViewHeader';
import { buildQuery, latestOf, useZoneBatch, useZoneFilterLists } from './lib/api';
import { browserTz, DATE_PRESET_LABELS, presetRange } from './lib/format';
import { downloadCsv } from './lib/csv';
import type { DatePreset, EmployeeZoneRow, EmployeesData, MovementDetail } from './lib/types';
import { EmployeeZoneAnalytics, EmployeeControls, ViewMode } from './employee/EmployeeZoneAnalytics';
import { TopEmployeesTable } from './tables/TopEmployeesTable';
import { EmployeeDrilldownModal } from './modals/EmployeeDrilldownModal';
import { MultiEmployeeCompareModal } from './modals/MultiEmployeeCompareModal';

const CARD_PAGE_SIZE = 12;
const TOP_PAGE_SIZE = 10;

/**
 * Employee Movement (Req 9). Uses the same date presets as the Deep-Dive and
 * defaults to Today (AC 9.9); the range applies to the cards, table, drilldown
 * timeline and comparison modal.
 */
export const EmployeeMovementPage: React.FC = () => {
  const lists = useZoneFilterLists(false);
  const [preset, setPreset] = useState<DatePreset>('today');
  const [range, setRange] = useState(() => presetRange('today'));
  const [viewMode, setViewMode] = useState<ViewMode>('cards');
  const [controls, setControls] = useState<EmployeeControls>({ q: '', department: '', status: 'all', sort: 'time', dir: 'desc', page: 1, pageSize: CARD_PAGE_SIZE });
  const [topQ, setTopQ] = useState('');
  const [topSort, setTopSort] = useState<'visits' | 'time'>('visits');
  const [selected, setSelected] = useState<EmployeeZoneRow[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [drilldown, setDrilldown] = useState<EmployeeZoneRow | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);

  const base = useMemo(() => ({ fromDate: range.fromDate, toDate: range.toDate, departmentId: controls.department }), [range.fromDate, range.toDate, controls.department]);
  // core = the employee cards and the Top Employees table in ONE request; the search boxes are
  // debounced by the hook (400 ms), so typing does not fire a request per keystroke.
  const coreQuery = useMemo(() => buildQuery(base, {
    q: controls.q || undefined, status: controls.status === 'all' ? undefined : controls.status,
    sort: controls.sort, dir: controls.dir, page: controls.page, pageSize: controls.pageSize,
    topQ: topQ || undefined, topSort, topPageSize: TOP_PAGE_SIZE,
  }), [base, controls.q, controls.status, controls.sort, controls.dir, controls.page, controls.pageSize, topQ, topSort]);
  const list = useZoneBatch('movement', 'core', ['employees', 'top'] as const, coreQuery);
  const employees = list.results.employees.data as EmployeesData | null;
  const top = list.results.top.data as EmployeesData | null;

  // The event stream and the drilldown are the only places evidence photos are shown: withPhotos=1.
  const detailQuery = (id: number | null) => (id === null ? null : new URLSearchParams({ fromDate: range.fromDate, toDate: range.toDate, tz: browserTz(), employeeId: String(id), withPhotos: '1' }).toString());
  const expanded = useZoneBatch('movement', 'detail', ['movement'] as const, detailQuery(expandedId));
  const drill = useZoneBatch('movement', 'detail', ['movement'] as const, detailQuery(drilldown?.employeeId ?? null));

  const zoneOrder = useMemo(() => lists.zones.map((z) => z.zone), [lists.zones]);
  const selectedIds = selected.map((s) => s.employeeId);

  const toggleSelect = (row: EmployeeZoneRow) => setSelected((cur) => (cur.some((s) => s.employeeId === row.employeeId) ? cur.filter((s) => s.employeeId !== row.employeeId) : [...cur, row]));
  const rangeLabel = preset === 'today' ? 'Today' : `${range.fromDate} to ${range.toDate}`;

  const changeControls = (next: Partial<EmployeeControls>) => setControls((c) => ({ ...c, ...next }));
  const choosePreset = (p: DatePreset) => {
    setPreset(p);
    if (p !== 'custom') setRange(presetRange(p));
    setControls((c) => ({ ...c, page: 1 }));
    setExpandedId(null);
  };

  const dateControls = (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="movement-range">
      <div role="group" aria-label="Date range" className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs">
        {(['today', 'week', 'month', 'custom'] as DatePreset[]).map((p) => (
          <button key={p} type="button" aria-pressed={preset === p} onClick={() => choosePreset(p)} className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer ${preset === p ? 'bg-white text-blue-700 shadow-xs font-semibold' : 'text-slate-600 hover:text-slate-900'}`}>{DATE_PRESET_LABELS[p]}</button>
        ))}
      </div>
      {preset === 'custom' && (
        <div className="flex items-center gap-1.5 text-xs">
          <input type="date" aria-label="From date" value={range.fromDate} max={range.toDate} onChange={(e) => setRange({ ...range, fromDate: e.target.value })} className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 text-xs" />
          <span className="text-slate-400">to</span>
          <input type="date" aria-label="To date" value={range.toDate} min={range.fromDate} onChange={(e) => setRange({ ...range, toDate: e.target.value })} className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 text-xs" />
        </div>
      )}
    </div>
  );

  const handleExport = () => {
    const shape = (r: EmployeeZoneRow) => ({
      employee_id: r.employeeCode, name: r.name, department: r.department, role: r.role, primary_zone: r.primaryZone, zone_visits: r.totalZoneVisits,
      time_inside_minutes: r.totalTimeInsideMinutes, avg_visit_minutes: r.avgVisitMinutes, entries: r.entries, exits: r.exits,
      mean_match_confidence: r.avgMatchConfidence, first_seen: r.firstSeen, last_seen: r.lastSeen, inside_now: r.currentlyInZone,
    });
    downloadCsv('employee-movement.csv', [
      { title: `Employees (${rangeLabel})`, rows: (employees?.rows ?? []).map(shape) },
      { title: 'Top employees by zone activity', rows: (top?.rows ?? []).map(shape) },
    ]);
  };

  return (
    <div className="space-y-6" id="subview-employee-movement">
      <ViewHeader
        title="Zone Analytics - Employee Movement"
        subtitle="How individual employees move through the zones."
        breadcrumb="Employee Movement"
        loading={list.loading}
        lastUpdatedAt={latestOf(list.computedAt)}
        onRefresh={() => { list.refresh(); expanded.refresh(); drill.refresh(); }}
        onExport={handleExport}
      />

      <EmployeeZoneAnalytics
        data={employees}
        error={list.results.employees.error}
        loading={list.loading}
        controls={controls}
        onControlsChange={changeControls}
        departments={lists.departments}
        zoneOrder={zoneOrder}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        selectedIds={selectedIds}
        selectedRows={selected}
        onToggleSelect={toggleSelect}
        onSelectTop={() => setSelected((top?.rows ?? employees?.rows ?? []).slice(0, 3))}
        onOpenDrilldown={setDrilldown}
        onOpenComparisonModal={() => setCompareOpen(true)}
        expandedId={expandedId}
        onExpandedChange={setExpandedId}
        detail={{ data: expandedId === null ? null : (expanded.results.movement.data as MovementDetail | null), error: expanded.results.movement.error, loading: expanded.loading }}
        dateControls={dateControls}
      />

      <TopEmployeesTable
        data={top}
        error={list.results.top.error}
        loading={list.loading}
        q={topQ}
        onQChange={setTopQ}
        sort={topSort}
        onSortChange={setTopSort}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelect}
        onSelectAll={(rows) => setSelected((cur) => [...cur, ...rows.filter((r) => !cur.some((c) => c.employeeId === r.employeeId))])}
        onClearAll={() => setSelected([])}
        onOpenDrilldown={setDrilldown}
        onOpenComparison={() => setCompareOpen(true)}
      />

      {drilldown && (
        <EmployeeDrilldownModal
          employee={drilldown}
          detail={drill.results.movement.data as MovementDetail | null}
          error={drill.results.movement.error}
          loading={drill.loading}
          rangeLabel={rangeLabel}
          onClose={() => setDrilldown(null)}
        />
      )}

      {compareOpen && (
        <MultiEmployeeCompareModal
          selectedEmployees={selected}
          candidates={[...(employees?.rows ?? []), ...(top?.rows ?? [])].filter((r, i, all) => all.findIndex((x) => x.employeeId === r.employeeId) === i)}
          onClose={() => setCompareOpen(false)}
          onToggleEmployee={toggleSelect}
          onSelectEmployeeForDrilldown={(row) => { setCompareOpen(false); setDrilldown(row); }}
        />
      )}
    </div>
  );
};

export default EmployeeMovementPage;
