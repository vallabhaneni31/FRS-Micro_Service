import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ViewHeader } from './lib/ViewHeader';
import { buildQuery, latestOf, useZoneBatch } from './lib/api';
import { DATE_PRESET_LABELS, presetRange } from './lib/format';
import { downloadCsv } from './lib/csv';
import type { CompareData, CompareGranularity, CompareMetric, DatePreset, ZoneListItem } from './lib/types';
import { CompareZonesDashboard } from './compare/CompareZonesDashboard';

/**
 * Compare Zones (Req 8). Weekly and day-of-week groupings need more than one day,
 * so this view has its own date range (default This Month) — a documented
 * deviation from the prototype, which had no range control here.
 */
export const CompareZonesPage: React.FC = () => {
  const [preset, setPreset] = useState<DatePreset>('month');
  const [range, setRange] = useState(() => presetRange('month'));
  const [selected, setSelected] = useState<string[]>([]);
  const [metric, setMetric] = useState<CompareMetric>('occupancy');
  const [granularity, setGranularity] = useState<CompareGranularity>('hour');
  const seeded = useRef(false);

  // One batch request carries the zone list (range-scoped) and, once 2+ zones are chosen, the comparison.
  const canCompare = selected.length >= 2;
  const coreQuery = useMemo(
    () => buildQuery({ selectedZones: selected, fromDate: range.fromDate, toDate: range.toDate }, canCompare ? { metric, granularity } : {}),
    [selected, range.fromDate, range.toDate, metric, granularity, canCompare],
  );
  const core = useZoneBatch('compare', 'core', ['zones', 'compare'] as const, coreQuery);
  const zones = (core.results.zones.data ?? []) as ZoneListItem[];

  // Default selection: the two busiest zones by entries (data-driven), once.
  useEffect(() => {
    if (seeded.current || zones.length < 2) return;
    seeded.current = true;
    setSelected([...zones].sort((a, b) => b.entries - a.entries).slice(0, 2).map((z) => z.zone));
  }, [zones]);

  // Drop selections that disappeared from the list (range change).
  useEffect(() => {
    if (!zones.length) return;
    const names = new Set(zones.map((z) => z.zone));
    setSelected((cur) => (cur.every((n) => names.has(n)) ? cur : cur.filter((n) => names.has(n))));
  }, [zones]);

  const data = canCompare ? (core.results.compare.data as CompareData | null) : null;
  const lastUpdatedAt = latestOf(core.computedAt);
  const refresh = () => core.refresh();

  const choose = (p: DatePreset) => {
    setPreset(p);
    if (p !== 'custom') setRange(presetRange(p));
  };

  const handleExport = () => {
    if (!data) return;
    downloadCsv('compare-zones.csv', [
      { title: `Key metrics (${data.metric}, ${data.granularity})`, rows: data.matrix.map((m) => ({ zone: m.zone, live_headcount: m.liveHeadcount, peak: m.peak, entries: m.entries, exits: m.exits, net_flow: m.net, avg_dwell_minutes: m.avgDwellMinutes })) },
      { title: 'Combined', rows: [{ live_headcount: data.aggregate.liveHeadcount, peak: data.aggregate.peak, entries: data.aggregate.entries, exits: data.aggregate.exits, net_flow: data.aggregate.net, avg_dwell_minutes: data.aggregate.avgDwellMinutes }] },
      { title: 'Series', rows: Object.entries(data.zones).flatMap(([zone, z]) => z.series.map((s) => ({ zone, bucket: s.bucket, value: s.value ?? '', entries: s.entries ?? '', exits: s.exits ?? '' }))) },
    ]);
  };

  const rangeControls = (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="compare-range">
      <div role="group" aria-label="Date range" className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs">
        {(['today', 'week', 'month', 'custom'] as DatePreset[]).map((p) => (
          <button key={p} type="button" aria-pressed={preset === p} onClick={() => choose(p)} className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer ${preset === p ? 'bg-white text-blue-700 shadow-xs font-semibold' : 'text-slate-600 hover:text-slate-900'}`}>
            {DATE_PRESET_LABELS[p]}
          </button>
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

  return (
    <div className="space-y-6" id="subview-compare-zones">
      <ViewHeader
        title="Zone Analytics - Compare Zones"
        subtitle="Compare zones side by side."
        breadcrumb="Compare Zones"
        loading={core.loading}
        lastUpdatedAt={lastUpdatedAt}
        onRefresh={refresh}
        onExport={handleExport}
      />
      <CompareZonesDashboard
        zones={zones}
        selected={selected}
        onSelectedChange={setSelected}
        metric={metric}
        onMetricChange={setMetric}
        granularity={granularity}
        onGranularityChange={setGranularity}
        data={data}
        error={core.results.compare.error ?? core.results.zones.error}
        loading={core.loading}
        rangeControls={rangeControls}
      />
    </div>
  );
};

export default CompareZonesPage;
