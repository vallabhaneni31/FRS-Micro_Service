import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { ViewHeader } from './lib/ViewHeader';
import { buildQuery, DEFAULT_DEEP_DIVE_FILTERS, latestOf, useZoneBatch, useZoneFilterLists } from './lib/api';
import { downloadCsv } from './lib/csv';
import { ZONE_EVENTS_ANCHOR } from './lib/nav';
import { presetRange } from './lib/format';
import type {
  DeepDiveFilters, EntryPointTrafficRow, EventType, HeatmapData, MovementMatrix, PeakHoursData, PersonType, RecognitionStatus,
  TimeSpentBucket, ZoneEventsPage, ZoneSummary,
} from './lib/types';
import { GlobalFilters } from './filters/GlobalFilters';
import { ZoneHeroKpis } from './kpis/ZoneHeroKpis';
import { HourlyTrafficChart } from './charts/HourlyTrafficChart';
import { ZoneOccupancyHeatmap } from './charts/ZoneOccupancyHeatmap';
import { EntryPointTrafficChart } from './charts/EntryPointTrafficChart';
import { EntriesExitsChart } from './charts/EntriesExitsChart';
import { TimeSpentHistogram } from './charts/TimeSpentHistogram';
import { EmployeeMovementMatrix } from './charts/EmployeeMovementMatrix';
import { TopEntryPointsTable } from './tables/TopEntryPointsTable';
import { RecentEventsTable } from './tables/RecentEventsTable';

const EVENTS_PAGE_SIZE = 10;
const CORE_KEYS = ['summary', 'peak', 'heatmap', 'entrances', 'timeSpent', 'matrix'] as const;
const DETAIL_KEYS = ['events'] as const;

/** Zone Deep-Dive: filter bar + hero cards + 6 charts + Top Entrances + full Recent Zone Events (Req 7). */
export const ZoneDeepDivePage: React.FC = () => {
  const location = useLocation();
  const lists = useZoneFilterLists(true);
  const [filters, setFilters] = useState<DeepDiveFilters>({ ...DEFAULT_DEEP_DIVE_FILTERS, ...presetRange('today') });
  const [eventType, setEventType] = useState<'all' | EventType>('all');
  const [status, setStatus] = useState<'all' | RecognitionStatus>('all');
  const [personType, setPersonType] = useState<PersonType>('all');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const eventsRef = useRef<HTMLDivElement>(null);

  // A committed filter change starts events from page 1.
  const filtersKey = JSON.stringify(filters);
  useEffect(() => { setPage(1); }, [filtersKey]);

  // Two batch requests (core = cards + charts, detail = events); the hook debounces 400 ms,
  // skips unchanged params and aborts a superseded request (AC 12.1, 12.6).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const coreQuery = useMemo(() => buildQuery(filters), [filtersKey]);
  const detailQuery = useMemo(() => buildQuery(filters, {
    page,
    pageSize: EVENTS_PAGE_SIZE,
    eventType: eventType === 'all' ? undefined : eventType,
    status: status === 'all' ? undefined : status,
    q: q || undefined,
    personType: personType === 'all' ? undefined : personType,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [filtersKey, page, eventType, status, q, personType]);
  const analytics = useZoneBatch('deep-dive', 'core', CORE_KEYS, coreQuery);
  const eventsReq = useZoneBatch('deep-dive', 'detail', DETAIL_KEYS, detailQuery);

  // "View all" from the Overview lands here at the events table.
  useEffect(() => {
    if (location.hash === `#${ZONE_EVENTS_ANCHOR}` && eventsRef.current?.scrollIntoView) eventsRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [location.hash]);

  const r = analytics.results;
  const summary = r.summary.data as ZoneSummary | null;
  const peak = r.peak.data as PeakHoursData | null;
  const heatmap = r.heatmap.data as HeatmapData | null;
  const entrances = (r.entrances.data ?? []) as EntryPointTrafficRow[];
  const timeSpent = (r.timeSpent.data ?? []) as TimeSpentBucket[];
  const matrix = (r.matrix.data as MovementMatrix | null)?.matrix ?? [];
  const events = (eventsReq.results.events.data as ZoneEventsPage | null) ?? { rows: [], total: 0 };
  const loading = analytics.loading || eventsReq.loading;
  const lastUpdatedAt = latestOf(analytics.computedAt, eventsReq.computedAt);

  const scopeName = filters.selectedZones.length ? filters.selectedZones.join(', ') : 'All zones';
  const zoneNamesInScope = filters.selectedZones.length ? filters.selectedZones : lists.zones.map((z) => z.zone);

  const refresh = () => { analytics.refresh(); eventsReq.refresh(); };

  const handleExport = () => {
    downloadCsv('zone-deep-dive.csv', [
      {
        title: 'Summary',
        rows: summary ? [{
          headcount_now: summary.headcount.current, peak: summary.headcount.peak, average: summary.headcount.average,
          entries: summary.flow.entries, exits: summary.flow.exits, net: summary.flow.net, unique_employees: summary.flow.uniqueEmployees,
          avg_visit_minutes: summary.dwell.avgVisitMinutes, avg_time_inside_minutes: summary.dwell.avgTimeInsideMinutes, total_visits: summary.dwell.totalVisits,
        }] : [],
      },
      { title: 'Hourly traffic', rows: (peak?.hourly ?? []).map((h) => ({ hour: h.hour, entries: h.entries, exits: h.exits, traffic: h.traffic })) },
      { title: 'Top entrances', rows: entrances.map((e, i) => ({ rank: i + 1, entrance: e.deviceLabel, entries: e.entries, exits: e.exits, net: e.net, unique_employees: e.uniqueEmployees, traffic_share_pct: e.contributionPct, peak_hour: e.peakActivity })) },
      { title: 'Time spent inside zone', rows: timeSpent.map((t) => ({ range: t.bucket, visits: t.count, share_pct: t.pct })) },
      { title: 'Movement between zones', rows: matrix.map((m) => ({ from_zone: m.fromZone, to_zone: m.toZone, moves: m.count, share_pct: m.pct })) },
      { title: 'Recent zone events', rows: events.rows.map((e) => ({ time: e.timestamp, event: e.eventType, employee: e.employeeName, entrance: e.entrance, zone: e.zone, status: e.recognitionStatus, match_confidence: e.confidence, camera: e.cameraId, details: e.details })) },
    ]);
  };

  return (
    <div className="space-y-6" id="subview-zone-deep-dive">
      <ViewHeader
        title="Zone Analytics - Zone Deep-Dive"
        subtitle="Traffic, time spent and movement for the zones you choose."
        breadcrumb="Zone Deep-Dive"
        loading={loading}
        lastUpdatedAt={lastUpdatedAt}
        onRefresh={refresh}
        onExport={handleExport}
      />

      <GlobalFilters filters={filters} onChange={setFilters} zones={lists.zones} entryPoints={lists.entryPoints} departments={lists.departments} cameras={lists.cameras} />

      <section id="section-kpis">
        <ZoneHeroKpis summary={summary} scopeName={scopeName} error={r.summary.error} loading={analytics.loading} />
      </section>

      <section id="section-visualizations" className="space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <HourlyTrafficChart hourly={peak?.hourly ?? []} error={r.peak.error} loading={analytics.loading} />
          <ZoneOccupancyHeatmap data={heatmap} error={r.heatmap.error} loading={analytics.loading} />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <EntryPointTrafficChart data={entrances} error={r.entrances.error} loading={analytics.loading} />
          <EntriesExitsChart data={peak} zones={zoneNamesInScope} error={r.peak.error} loading={analytics.loading} />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <TimeSpentHistogram data={timeSpent} error={r.timeSpent.error} loading={analytics.loading} />
          <EmployeeMovementMatrix transitions={matrix} error={r.matrix.error} loading={analytics.loading} />
        </div>
      </section>

      <TopEntryPointsTable data={entrances} error={r.entrances.error} loading={analytics.loading} />

      <div id={ZONE_EVENTS_ANCHOR} ref={eventsRef} className="scroll-mt-4">
        <RecentEventsTable
          rows={events.rows}
          total={events.total}
          error={eventsReq.results.events.error}
          loading={eventsReq.loading}
          personType={personType}
          onPersonTypeChange={(p) => { setPersonType(p); setPage(1); }}
          controls={{
            eventType, status, q, page, pageSize: EVENTS_PAGE_SIZE,
            onChange: (next) => {
              if (next.eventType !== undefined) setEventType(next.eventType);
              if (next.status !== undefined) setStatus(next.status);
              if (next.q !== undefined) setQ(next.q);
              if (next.page !== undefined) setPage(next.page);
            },
          }}
        />
      </div>
    </div>
  );
};

export default ZoneDeepDivePage;
