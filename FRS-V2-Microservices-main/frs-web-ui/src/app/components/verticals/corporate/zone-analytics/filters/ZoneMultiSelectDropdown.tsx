import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MapPin, ChevronDown, Check, X, Search, Layers } from 'lucide-react';
import type { ZoneListItem } from '../lib/types';
import { zoneColor } from '../lib/format';

interface Props {
  zones: ZoneListItem[];
  /** Selected zone names. Empty = all zones. */
  selected: string[];
  onChange: (zones: string[]) => void;
  className?: string;
}

/** Zone multi-select: search, "All Zones", per-zone live headcount and peak, "Only" isolate (Req 7.1). */
export const ZoneMultiSelectDropdown: React.FC<Props> = ({ zones, selected, onChange, className = '' }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const allNames = useMemo(() => zones.map((z) => z.zone), [zones]);
  const active = selected.length === 0 ? allNames : selected.filter((n) => allNames.includes(n));
  const isAllSelected = selected.length === 0 || (allNames.length > 0 && allNames.every((n) => active.includes(n)));
  const isPartialSelected = !isAllSelected && active.length > 0;

  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    searchRef.current?.focus();
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [isOpen]);

  const commit = (next: string[]) => onChange(next.length === 0 || next.length === allNames.length ? [] : next);
  const toggle = (name: string) => {
    if (isAllSelected) return commit(allNames.filter((n) => n !== name));
    commit(active.includes(name) ? active.filter((n) => n !== name) : [...active, name]);
  };
  const only = (name: string, e: React.MouseEvent) => { e.stopPropagation(); onChange([name]); };

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return q ? zones.filter((z) => z.zone.toLowerCase().includes(q)) : zones;
  }, [zones, searchQuery]);

  const chosen = zones.filter((z) => isAllSelected || active.includes(z.zone));
  const totals = { live: chosen.reduce((s, z) => s + z.liveHeadcount, 0), peak: chosen.reduce((s, z) => Math.max(s, z.peak), 0) };
  const triggerLabel = isAllSelected ? 'All Zones' : active.length === 1 ? active[0] : `${active.length} Zones Selected`;

  return (
    <div ref={ref} className={`relative inline-block ${className}`} id="zone-multiselect-container">
      <button
        type="button"
        id="zone-multiselect-trigger"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        className={`group flex items-center bg-slate-50 hover:bg-slate-100/90 border rounded-lg px-3 py-1.5 transition-all text-left outline-none focus:ring-2 focus:ring-blue-500/20 cursor-pointer ${
          isOpen ? 'border-blue-500 ring-2 ring-blue-500/20 bg-blue-50/20' : isPartialSelected ? 'border-blue-300 bg-blue-50/40' : 'border-slate-200'
        }`}
      >
        <div className="flex items-center gap-2">
          <div className={`p-1 rounded-md transition-colors ${isPartialSelected ? 'bg-blue-600 text-white shadow-xs' : 'bg-blue-100 text-blue-700'}`}>
            <MapPin className="w-3.5 h-3.5" />
          </div>
          <div className="flex flex-col pr-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider leading-none">Zones</span>
              {isPartialSelected && (
                <span className="text-[9px] font-extrabold text-blue-700 bg-blue-100 border border-blue-200 px-1.5 py-0.5 rounded-full leading-none">
                  {active.length} of {allNames.length} Active
                </span>
              )}
              {isAllSelected && allNames.length > 0 && (
                <span className="text-[9px] font-semibold text-slate-500 bg-slate-200/80 px-1.5 py-0.5 rounded-full leading-none">All {allNames.length}</span>
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5 max-w-[200px] sm:max-w-[240px] truncate">
              <span data-testid="zone-trigger-label" className="text-xs font-semibold text-slate-800 truncate">{triggerLabel}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 ml-2 pl-2 border-l border-slate-200 text-slate-400 group-hover:text-slate-600">
          {isPartialSelected && (
            <span role="button" tabIndex={0} aria-label="Reset to all zones" onClick={(e) => { e.stopPropagation(); onChange([]); }} title="Reset to All Zones" className="p-0.5 hover:text-slate-800 hover:bg-slate-200/70 rounded transition-colors">
              <X className="w-3 h-3 text-slate-400 hover:text-slate-700" />
            </span>
          )}
          <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isOpen ? 'rotate-180 text-blue-600' : ''}`} />
        </div>
      </button>

      {isOpen && (
        <div id="zone-multiselect-dropdown" role="listbox" aria-label="Zones" className="absolute left-0 mt-1.5 w-80 sm:w-96 max-w-[90vw] bg-white rounded-xl shadow-2xl border border-slate-200 p-0 z-50">
          <div className="p-3 pb-2.5 border-b border-slate-100 bg-slate-50/60 rounded-t-xl">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-1.5">
                <Layers className="w-4 h-4 text-blue-600" />
                <h4 className="text-xs font-bold text-slate-900 tracking-tight">Select Zones</h4>
                <span className="text-[10px] font-semibold px-1.5 rounded bg-blue-100 text-blue-800">{isAllSelected ? 'All Active' : `${active.length} Active`}</span>
              </div>
              <div className="flex items-center gap-1 text-[11px]">
                <button type="button" onClick={() => onChange([])} className="px-2 py-0.5 rounded text-blue-600 hover:text-blue-800 hover:bg-blue-100/60 font-semibold transition-colors cursor-pointer">Select All</button>
                <span className="text-slate-300">|</span>
                <button type="button" onClick={() => onChange([])} className="px-2 py-0.5 rounded text-slate-500 hover:text-slate-800 hover:bg-slate-200/60 font-medium transition-colors cursor-pointer">Reset</button>
              </div>
            </div>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                ref={searchRef}
                type="text"
                aria-label="Search zones"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search zone name..."
                className="w-full bg-white border border-slate-200 rounded-lg pl-8 pr-7 py-1 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
              {searchQuery && (
                <button type="button" aria-label="Clear search" onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5 cursor-pointer"><X className="w-3 h-3" /></button>
              )}
            </div>
          </div>

          {!searchQuery && (
            <div className="p-2 border-b border-slate-100">
              <div
                role="option"
                aria-selected={isAllSelected}
                onClick={() => onChange([])}
                className={`flex items-center justify-between px-2.5 py-2 rounded-lg cursor-pointer transition-colors border ${isAllSelected ? 'bg-blue-50/70 border-blue-200 text-blue-900' : 'hover:bg-slate-50 border-transparent text-slate-700'}`}
              >
                <div className="flex items-center gap-2.5">
                  <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${isAllSelected ? 'bg-blue-600 border-blue-600 text-white' : 'border-slate-300 bg-white'}`}>
                    {isAllSelected && <Check className="w-3 h-3 stroke-[3]" />}
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-bold">All Zones</span>
                      <span className="text-[10px] font-semibold text-blue-700 bg-blue-100/80 px-1.5 rounded">Full Scope</span>
                    </div>
                    <p className="text-[11px] text-slate-500">Combined figures across every zone</p>
                  </div>
                </div>
                <div className="text-right text-[11px] text-slate-500"><span className="font-semibold text-slate-700">{zones.reduce((s, z) => s + z.liveHeadcount, 0)}</span> inside now</div>
              </div>
            </div>
          )}

          <div className="p-2 max-h-64 overflow-y-auto space-y-1">
            <div className="px-2 py-1 flex items-center justify-between text-[10px] font-bold text-slate-400 uppercase tracking-wider">
              <span>Zones ({filtered.length})</span>
              <span>Headcount / Peak</span>
            </div>
            {filtered.map((zone, idx) => {
              const isChecked = isAllSelected || active.includes(zone.zone);
              return (
                <div
                  key={zone.zone}
                  role="option"
                  aria-selected={isChecked}
                  data-zone={zone.zone}
                  onClick={() => toggle(zone.zone)}
                  className={`group flex items-center justify-between px-2.5 py-2 rounded-lg cursor-pointer transition-all border ${isChecked ? 'bg-slate-50/90 border-slate-200/90 text-slate-900 font-medium' : 'hover:bg-slate-50/60 border-transparent text-slate-600'}`}
                >
                  <div className="flex items-center gap-2.5 min-w-0 pr-2">
                    <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${isChecked ? 'bg-blue-600 border-blue-600 text-white shadow-2xs' : 'border-slate-300 bg-white group-hover:border-slate-400'}`}>
                      {isChecked && <Check className="w-3 h-3 stroke-[3]" />}
                    </div>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: zoneColor(zones.indexOf(zone)) }} />
                      <span className="text-xs font-semibold truncate text-slate-900">{zone.zone}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="text-right">
                      <div className="text-xs font-bold text-slate-800" data-testid={`zone-live-${idx}`}>{zone.liveHeadcount} <span className="text-[10px] font-normal text-slate-400">inside</span></div>
                      <div className="text-[10px] text-slate-400">Peak: {zone.peak}</div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => only(zone.zone, e)}
                      title={`Show ${zone.zone} only`}
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600 hover:text-white hover:bg-blue-600 rounded border border-blue-200 transition-all cursor-pointer"
                    >
                      Only
                    </button>
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 && <div className="text-center py-6 text-slate-400 text-xs">No zones match "{searchQuery}"</div>}
          </div>

          <div className="p-3 border-t border-slate-100 bg-slate-50/70 rounded-b-xl flex items-center justify-between text-xs">
            <div className="flex flex-col">
              <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Selection Summary</span>
              <div className="flex items-center gap-2 text-slate-700 font-semibold mt-0.5">
                <span><strong className="text-slate-900">{totals.live}</strong> inside now</span>
                <span className="text-slate-300">•</span>
                <span><strong className="text-slate-900">{totals.peak}</strong> highest peak</span>
              </div>
            </div>
            <button type="button" id="btn-apply-zone-multiselect" onClick={() => setIsOpen(false)} className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white rounded-lg text-xs font-semibold transition-colors shadow-xs cursor-pointer">Done</button>
          </div>
        </div>
      )}
    </div>
  );
};
