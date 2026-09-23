import React, { useMemo, useState } from 'react';
import { MapPin, ArrowRight } from 'lucide-react';
import { ViewHeader } from './lib/ViewHeader';
import { buildQuery, latestOf, useZoneBatch } from './lib/api';
import { presetRange } from './lib/format';
import { downloadCsv } from './lib/csv';
import { useZoneNav } from './lib/nav';
import type { DepartmentDistributionRow, OccupancyData, PeakHoursData, PersonType, ZoneEventsPage, ZoneListItem, ZoneSummary } from './lib/types';
import { ZoneHeroKpis } from './kpis/ZoneHeroKpis';
import { ZoneOccupancyTrend } from './charts/ZoneOccupancyTrend';
import { DepartmentDistributionChart } from './charts/DepartmentDistributionChart';
import { PeakHoursAnalysis } from './charts/PeakHoursAnalysis';
import { RecentEventsTable } from './tables/RecentEventsTable';

/**
 * Overview Dashboard — facility-wide, no filter bar, always "today" (Req 6.1, 6.2).
 * The trend widget's Daily / Weekly views use their own look-back windows
 * (7 days / 4 weeks, worked out by the server) so a daily or weekly line has more than one point.
 * Two batch requests load the view: core (cards + charts) and detail (recent activity).
 */
const CORE_KEYS = ['summary', 'zones', 'occHourly', 'occDaily', 'occWeekly', 'departments', 'peak'] as const;
const DETAIL_KEYS = ['events'] as const;

export const ZoneAnalyticsOverviewPage: React.FC = () => {
  const nav = useZoneNav();
  const today = useMemo(() => presetRange('today'), []);

  const [personType, setPersonType] = useState<PersonType>('all');

  const coreQuery = useMemo(() => buildQuery({ fromDate: today.fromDate, toDate: today.toDate }), [today.fromDate, today.toDate]);
  const detailQuery = useMemo(
    () => buildQuery({ fromDate: today.fromDate, toDate: today.toDate }, { page: 1, pageSize: 5, personType: personType === 'all' ? undefined : personType }),
    [today.fromDate, today.toDate, personType],
  );
  const core = useZoneBatch('overview', 'core', CORE_KEYS, coreQuery);
  const detail = useZoneBatch('overview', 'detail', DETAIL_KEYS, detailQuery);
  const results = { ...core.results, ...detail.results };
  const loading = core.loading || detail.loading;
  const lastUpdatedAt = latestOf(core.computedAt, detail.computedAt);
  const refresh = () => { core.refresh(); detail.refresh(); };

  const summary = results.summary.data as ZoneSummary | null;
  const zones = (results.zones.data ?? []) as ZoneListItem[];
  const series = {
    hourly: ((results.occHourly.data as OccupancyData | null)?.series ?? []),
    daily: ((results.occDaily.data as OccupancyData | null)?.series ?? []),
    weekly: ((results.occWeekly.data as OccupancyData | null)?.series ?? []),
  };
  const departments = (results.departments.data ?? []) as DepartmentDistributionRow[];
  const peak = results.peak.data as PeakHoursData | null;
  const events = (results.events.data as ZoneEventsPage | null) ?? { rows: [], total: 0 };

  const handleExport = () => {
    downloadCsv('zone-overview.csv', [
      {
        title: 'Summary (today)',
        rows: summary ? [{
          headcount_now: summary.headcount.current, peak: summary.headcount.peak, average: summary.headcount.average,
          entries: summary.flow.entries, exits: summary.flow.exits, net: summary.flow.net, unique_employees: summary.flow.uniqueEmployees,
          avg_visit_minutes: summary.dwell.avgVisitMinutes, avg_time_inside_minutes: summary.dwell.avgTimeInsideMinutes,
          total_visits: summary.dwell.totalVisits, cameras_online: summary.cameras.online, cameras_total: summary.cameras.total,
        }] : [],
      },
      { title: 'Zones', rows: zones.map((z) => ({ zone: z.zone, live_headcount: z.liveHeadcount, peak: z.peak, entries: z.entries })) },
      { title: 'Departments', rows: departments.map((d) => ({ department: d.name, employees_detected: d.employeesDetected, zone_visits: d.visits, avg_time_spent_minutes: d.avgTimeSpentMinutes, share_pct: d.trafficPct })) },
      { title: 'Hourly traffic', rows: (peak?.hourly ?? []).map((h) => ({ hour: h.hour, entries: h.entries, exits: h.exits, traffic: h.traffic, avg_headcount: h.avgOccupancy, peak_headcount: h.peakOccupancy })) },
      { title: 'Recent zone activity', rows: events.rows.map((e) => ({ time: e.timestamp, event: e.eventType, employee: e.employeeName, entrance: e.entrance, zone: e.zone, status: e.recognitionStatus, match_confidence: e.confidence, camera: e.cameraId, details: e.details })) },
    ]);
  };

  return (
    <div className="space-y-6" id="subview-overview-dashboard">
      <ViewHeader
        title="Zone Analytics - Overview Dashboard"
        subtitle="How employees are using the campus zones today."
        breadcrumb="Overview Dashboard"
        loading={loading}
        lastUpdatedAt={lastUpdatedAt}
        onRefresh={refresh}
        onExport={handleExport}
      />

      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-3.5 rounded-xl bg-blue-50/70 border border-blue-200/70 text-xs shadow-2xs">
        <div className="flex items-center gap-2.5 text-blue-900 font-medium">
          <div className="w-7 h-7 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center shrink-0">
            <MapPin className="w-4 h-4" />
          </div>
          <div>
            <span className="font-semibold text-slate-900">Facility-Wide Overview</span>
            <span className="text-slate-600 ml-1.5">— Showing today's activity across all zones. Need to filter by zone, entrance or department?</span>
          </div>
        </div>
        <button
          type="button"
          id="btn-goto-zone-deep-dive"
          onClick={nav.toDeepDive}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs transition-colors shrink-0 shadow-2xs cursor-pointer"
        >
          <span>Open Zone Deep-Dive</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>

      <section id="section-kpis">
        <ZoneHeroKpis summary={summary} scopeName="All zones" error={results.summary.error} loading={core.loading} />
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ZoneOccupancyTrend zones={zones} series={series} cameras={summary?.cameras ?? null} error={results.occHourly.error} loading={core.loading} />
        <DepartmentDistributionChart data={departments} error={results.departments.error} loading={core.loading} />
      </div>

      <PeakHoursAnalysis data={peak} error={results.peak.error} loading={core.loading} />

      <div className="space-y-3">
        <div className="flex items-center justify-between pb-1 border-b border-slate-200">
          <div>
            <h3 className="text-sm font-bold text-slate-900 tracking-tight">Recent Zone Activity</h3>
            <p className="text-xs text-slate-500">Latest entries, exits, unknown faces and camera outages today</p>
          </div>
          <button type="button" onClick={nav.toDeepDiveEvents} className="text-xs font-semibold text-blue-600 hover:text-blue-700 flex items-center gap-1 cursor-pointer">
            <span>View all</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
        <RecentEventsTable rows={events.rows} total={events.total} error={results.events.error} loading={detail.loading} title="Recent Zone Activity" personType={personType} onPersonTypeChange={setPersonType} />
      </div>
    </div>
  );
};

export default ZoneAnalyticsOverviewPage;
