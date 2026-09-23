import React, { useEffect, useState } from 'react';
import { Clock, Building2, SlidersHorizontal, RotateCcw, DoorOpen, X, Layers } from 'lucide-react';
import type { CameraOption, DatePreset, DeepDiveFilters, DepartmentOption, EntryPointOption, TimeRange, ZoneListItem } from '../lib/types';
import { DATE_PRESET_LABELS, presetRange, TIME_RANGE_LABELS, zoneColor } from '../lib/format';
import { DEFAULT_DEEP_DIVE_FILTERS } from '../lib/api';
import { ZoneMultiSelectDropdown } from './ZoneMultiSelectDropdown';

interface Props {
  filters: DeepDiveFilters;
  onChange: (updated: DeepDiveFilters) => void;
  zones: ZoneListItem[];
  entryPoints: EntryPointOption[];
  departments: DepartmentOption[];
  cameras: CameraOption[];
}

const MIN_CONF = 50;
const MAX_CONF = 98;

/** Deep-Dive filter bar (Req 7.1): every control changes the request; "More Filters" commits on Apply. */
export const GlobalFilters: React.FC<Props> = ({ filters, onChange, zones, entryPoints, departments, cameras }) => {
  const [showMore, setShowMore] = useState(false);
  // Draft of the More Filters panel: committed by Apply.
  const [draft, setDraft] = useState({ cameraId: filters.cameraId, minConfidence: filters.minConfidence, securityOnly: filters.securityOnly });
  useEffect(() => { setDraft({ cameraId: filters.cameraId, minConfidence: filters.minConfidence, securityOnly: filters.securityOnly }); }, [filters.cameraId, filters.minConfidence, filters.securityOnly]);

  const isFacilityWide = filters.selectedZones.length === 0;
  const advancedActive = filters.cameraId !== '' || filters.minConfidence !== null || filters.securityOnly;
  const isFiltered = !isFacilityWide || filters.entryPointId !== '' || filters.departmentId !== '' || filters.datePreset !== 'today' || filters.timeRange !== 'full' || advancedActive;
  const liveTotal = zones.reduce((s, z) => s + z.liveHeadcount, 0);

  const setPreset = (preset: DatePreset) => {
    if (preset === 'custom') onChange({ ...filters, datePreset: 'custom' });
    else onChange({ ...filters, datePreset: preset, ...presetRange(preset) });
  };
  const reset = () => onChange({ ...DEFAULT_DEEP_DIVE_FILTERS, ...presetRange('today') });
  const removeZone = (name: string) => onChange({ ...filters, selectedZones: filters.selectedZones.filter((z) => z !== name) });

  const entranceName = entryPoints.find((e) => e.deviceId === filters.entryPointId)?.deviceLabel ?? filters.entryPointId;
  const departmentName = departments.find((d) => String(d.departmentId) === filters.departmentId)?.name ?? filters.departmentId;
  const cameraName = cameras.find((c) => c.cameraId === filters.cameraId)?.name ?? filters.cameraId;

  const selectBox = 'flex items-center bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-all';
  const labelCls = 'text-[10px] font-semibold text-slate-400 uppercase tracking-wider leading-none';
  const selectCls = 'bg-transparent text-xs font-semibold text-slate-800 pr-4 outline-none cursor-pointer mt-0.5';

  return (
    <div id="global-filters-panel" className="glass-panel border border-slate-200/60 rounded-2xl px-4 sm:px-6 py-3.5 shadow-xs">
      <div className="flex flex-col lg:flex-row lg:flex-wrap lg:items-center lg:justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <ZoneMultiSelectDropdown zones={zones} selected={filters.selectedZones} onChange={(selectedZones) => onChange({ ...filters, selectedZones })} />

          <div className={selectBox}>
            <DoorOpen className="w-3.5 h-3.5 text-slate-500 mr-2 shrink-0" />
            <div className="flex flex-col">
              <label htmlFor="filter-entrance-select" className={labelCls}>Entrance</label>
              <select id="filter-entrance-select" value={filters.entryPointId} onChange={(e) => onChange({ ...filters, entryPointId: e.target.value })} className={selectCls}>
                <option value="">All Entrances</option>
                {entryPoints.map((ep) => <option key={ep.deviceId} value={ep.deviceId}>{ep.deviceLabel}</option>)}
              </select>
            </div>
          </div>

          <div className={selectBox}>
            <Building2 className="w-3.5 h-3.5 text-slate-500 mr-2 shrink-0" />
            <div className="flex flex-col">
              <label htmlFor="filter-department-select" className={labelCls}>Department</label>
              <select id="filter-department-select" value={filters.departmentId} onChange={(e) => onChange({ ...filters, departmentId: e.target.value })} className={selectCls}>
                <option value="">All Departments</option>
                {departments.map((d) => <option key={d.departmentId} value={String(d.departmentId)}>{d.name}</option>)}
              </select>
            </div>
          </div>

          <div className={selectBox}>
            <Clock className="w-3.5 h-3.5 text-slate-500 mr-2 shrink-0" />
            <div className="flex flex-col">
              <label htmlFor="filter-time-range-select" className={labelCls}>Time Interval</label>
              <select id="filter-time-range-select" value={filters.timeRange} onChange={(e) => onChange({ ...filters, timeRange: e.target.value as TimeRange })} className={selectCls}>
                {(['full', 'morning', 'afternoon', 'evening', 'peak'] as TimeRange[]).map((t) => <option key={t} value={t}>{TIME_RANGE_LABELS[t]}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div id="date-presets-group" role="group" aria-label="Date range" className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600">
            {(['today', 'week', 'month', 'custom'] as DatePreset[]).map((preset) => (
              <button
                key={preset}
                id={`date-preset-${preset}`}
                type="button"
                aria-pressed={filters.datePreset === preset}
                onClick={() => setPreset(preset)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer ${filters.datePreset === preset ? 'bg-white text-blue-700 shadow-xs font-semibold' : 'text-slate-600 hover:text-slate-900'}`}
              >
                {DATE_PRESET_LABELS[preset]}
              </button>
            ))}
          </div>

          {filters.datePreset === 'custom' && (
            <div className="flex items-center gap-1.5 text-xs">
              <input type="date" aria-label="From date" value={filters.fromDate} max={filters.toDate} onChange={(e) => onChange({ ...filters, fromDate: e.target.value })} className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 text-xs" />
              <span className="text-slate-400">to</span>
              <input type="date" aria-label="To date" value={filters.toDate} min={filters.fromDate} onChange={(e) => onChange({ ...filters, toDate: e.target.value })} className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 text-xs" />
            </div>
          )}

          <div className="relative">
            <button
              id="more-filters-btn"
              type="button"
              aria-expanded={showMore}
              onClick={() => setShowMore(!showMore)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${advancedActive ? 'bg-blue-50 border-blue-300 text-blue-700 font-semibold' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>More Filters</span>
              {advancedActive && <span className="w-2 h-2 rounded-full bg-blue-600"></span>}
            </button>

            {showMore && (
              <div id="more-filters-popover" role="dialog" aria-label="More Filters" className="absolute right-0 mt-2 w-72 max-w-[90vw] bg-white border border-slate-200 rounded-xl shadow-xl z-50 p-4 text-xs space-y-4">
                <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                  <span className="font-bold text-slate-800 text-sm">More Filters</span>
                  <button type="button" aria-label="Close" onClick={() => setShowMore(false)} className="text-slate-400 hover:text-slate-600 p-1 rounded cursor-pointer"><X className="w-4 h-4" /></button>
                </div>

                <div>
                  <label htmlFor="filter-camera-select" className="block text-[11px] font-semibold text-slate-600 mb-1">Specific Camera</label>
                  <select id="filter-camera-select" value={draft.cameraId} onChange={(e) => setDraft({ ...draft, cameraId: e.target.value })} className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs text-slate-800 font-medium outline-none focus:border-blue-500">
                    <option value="">All Cameras</option>
                    {cameras.map((c) => <option key={c.cameraId} value={c.cameraId}>{c.name}</option>)}
                  </select>
                </div>

                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label htmlFor="filter-min-confidence" className="text-[11px] font-semibold text-slate-600">Minimum Match Confidence</label>
                    <span data-testid="min-confidence-value" className="font-mono font-bold text-blue-600 text-xs">{draft.minConfidence === null ? 'Off' : `${draft.minConfidence}%`}</span>
                  </div>
                  <input
                    id="filter-min-confidence"
                    type="range"
                    min={MIN_CONF}
                    max={MAX_CONF}
                    value={draft.minConfidence ?? MIN_CONF}
                    onChange={(e) => setDraft({ ...draft, minConfidence: Number(e.target.value) })}
                    className="w-full accent-blue-600 cursor-pointer"
                  />
                  <div className="flex justify-between items-center text-[10px] text-slate-400 mt-0.5 font-mono">
                    <span>{MIN_CONF}%</span>
                    <button type="button" onClick={() => setDraft({ ...draft, minConfidence: null })} className="text-blue-600 hover:underline cursor-pointer">Turn off</button>
                    <span>{MAX_CONF}%</span>
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-100 flex items-center justify-between gap-2">
                  <div>
                    <label htmlFor="filter-security-only" className="font-semibold text-slate-800 text-xs">Only unknown-face and camera-offline events</label>
                    <div className="text-[10px] text-slate-400">Limits the events table to unknown faces and camera outages</div>
                  </div>
                  <input id="filter-security-only" type="checkbox" checked={draft.securityOnly} onChange={(e) => setDraft({ ...draft, securityOnly: e.target.checked })} className="w-4 h-4 rounded text-blue-600 accent-blue-600 cursor-pointer" />
                </div>

                <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                  <button type="button" onClick={() => setDraft({ cameraId: '', minConfidence: null, securityOnly: false })} className="px-2.5 py-1 text-slate-500 hover:text-slate-800 text-xs font-medium cursor-pointer">Reset</button>
                  <button type="button" onClick={() => { onChange({ ...filters, ...draft }); setShowMore(false); }} className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-xs font-semibold cursor-pointer">Apply</button>
                </div>
              </div>
            )}
          </div>

          {isFiltered && (
            <button id="reset-filters-btn" type="button" onClick={reset} title="Undo all active filters and restore defaults" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-semibold transition-all shadow-2xs cursor-pointer">
              <RotateCcw className="w-3.5 h-3.5 text-rose-600" />
              <span>Reset Filters</span>
            </button>
          )}
        </div>
      </div>

      <div className="mt-2.5 pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-2" data-testid="active-scope">
          <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
            <Layers className="w-3 h-3 text-slate-400" />
            Active Scope:
          </span>

          {isFacilityWide ? (
            <span id="badge-facility-wide-scope" className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200 text-xs font-semibold">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>All Zones ({zones.length} zones • {liveTotal} inside now)</span>
            </span>
          ) : (
            filters.selectedZones.map((name) => {
              const z = zones.find((x) => x.zone === name);
              return (
                <span key={name} data-testid="scope-zone-chip" className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg bg-blue-50 text-blue-900 border border-blue-200/90 text-xs font-semibold shadow-2xs">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: zoneColor(Math.max(0, zones.findIndex((x) => x.zone === name))) }} />
                  <span>{name}</span>
                  {z && <span className="text-[10px] font-normal text-blue-600/80">({z.liveHeadcount} inside)</span>}
                  <button type="button" onClick={() => removeZone(name)} title={`Remove ${name}`} aria-label={`Remove ${name}`} className="ml-0.5 p-0.5 hover:bg-blue-200/60 rounded text-blue-600 hover:text-blue-900 transition-colors cursor-pointer"><X className="w-3 h-3" /></button>
                </span>
              );
            })
          )}

          {filters.entryPointId && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 border border-slate-200 text-xs font-medium">
              Entrance: {entranceName}
              <button type="button" aria-label="Remove entrance filter" onClick={() => onChange({ ...filters, entryPointId: '' })} className="hover:text-slate-900 ml-0.5 cursor-pointer"><X className="w-3 h-3" /></button>
            </span>
          )}
          {filters.departmentId && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-purple-50 text-purple-700 border border-purple-200 text-xs font-medium">
              Dept: {departmentName}
              <button type="button" aria-label="Remove department filter" onClick={() => onChange({ ...filters, departmentId: '' })} className="hover:text-purple-900 ml-0.5 cursor-pointer"><X className="w-3 h-3" /></button>
            </span>
          )}
          {filters.datePreset !== 'today' && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-200 text-xs font-medium">
              Period: {DATE_PRESET_LABELS[filters.datePreset]}
              <button type="button" aria-label="Remove period filter" onClick={() => onChange({ ...filters, datePreset: 'today', ...presetRange('today') })} className="hover:text-amber-900 ml-0.5 cursor-pointer"><X className="w-3 h-3" /></button>
            </span>
          )}
          {filters.timeRange !== 'full' && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-sky-50 text-sky-700 border border-sky-200 text-xs font-medium">
              Time: {TIME_RANGE_LABELS[filters.timeRange]}
              <button type="button" aria-label="Remove time interval filter" onClick={() => onChange({ ...filters, timeRange: 'full' })} className="hover:text-sky-900 ml-0.5 cursor-pointer"><X className="w-3 h-3" /></button>
            </span>
          )}
          {filters.cameraId && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 border border-slate-200 text-xs font-medium">
              Camera: {cameraName}
              <button type="button" aria-label="Remove camera filter" onClick={() => onChange({ ...filters, cameraId: '' })} className="hover:text-slate-900 ml-0.5 cursor-pointer"><X className="w-3 h-3" /></button>
            </span>
          )}
          {filters.minConfidence !== null && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-medium">
              Match confidence ≥ {filters.minConfidence}%
              <button type="button" aria-label="Remove confidence filter" onClick={() => onChange({ ...filters, minConfidence: null })} className="hover:text-emerald-900 ml-0.5 cursor-pointer"><X className="w-3 h-3" /></button>
            </span>
          )}
          {filters.securityOnly && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-red-50 text-red-700 border border-red-200 text-xs font-medium">
              Unknown faces and camera outages only
              <button type="button" aria-label="Remove security filter" onClick={() => onChange({ ...filters, securityOnly: false })} className="hover:text-red-900 ml-0.5 cursor-pointer"><X className="w-3 h-3" /></button>
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          {isFiltered && (
            <button type="button" id="btn-undo-all-filters" onClick={reset} className="text-[11px] font-semibold text-rose-600 hover:text-rose-800 hover:underline flex items-center gap-1 cursor-pointer">
              <RotateCcw className="w-3 h-3" />
              <span>Undo / Reset all</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
