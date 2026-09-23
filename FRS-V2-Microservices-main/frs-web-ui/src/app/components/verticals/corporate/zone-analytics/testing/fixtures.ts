// Test-only fixtures for the zone-analytics component tests (never imported by
// production code; the "no mock data in the module" guard exempts only this
// folder's use inside *.test.tsx). Shapes mirror the real /api/zones responses.
import type {
  CompareData, DepartmentDistributionRow, EmployeesData, EntryPointTrafficRow, HeatmapData, MovementDetail,
  MovementMatrix, OccupancyData, PeakHoursData, TimeSpentBucket, ZoneEventRow, ZoneEventsPage, ZoneListItem, ZoneSummary,
} from '../lib/types';

export const ZONES: ZoneListItem[] = [
  { zone: 'Lobby', zoneType: 'work', siteId: null, liveHeadcount: 6, peak: 12, entries: 40 },
  { zone: 'ODC', zoneType: 'work', siteId: null, liveHeadcount: 2, peak: 4, entries: 10 },
  { zone: 'Innovate Area', zoneType: 'work', siteId: null, liveHeadcount: 0, peak: 3, entries: 25 },
];

export const SUMMARY: ZoneSummary = {
  hasData: true,
  headcount: { current: 8, peak: 16, average: 9, lowest: 1, pctOfPeak: 50, changeVs1hPct: 14 },
  flow: { entries: 75, exits: 61, net: 14, pctIn: 55, pctOut: 45, uniqueEmployees: 44 },
  dwell: {
    avgVisitMinutes: 62, avgTimeInsideMinutes: 130,
    peakInflowWindow: { startHour: 9, endHour: 10, count: 30 }, peakEgressWindow: { startHour: 18, endHour: 19, count: 22 }, totalVisits: 75,
  },
  cameras: { online: 6, total: 13 },
};

export const EMPTY_SUMMARY: ZoneSummary = {
  hasData: false,
  headcount: { current: null, peak: null, average: null, lowest: null, pctOfPeak: null, changeVs1hPct: null },
  flow: { entries: null, exits: null, net: null, pctIn: null, pctOut: null, uniqueEmployees: null },
  dwell: { avgVisitMinutes: null, avgTimeInsideMinutes: null, peakInflowWindow: null, peakEgressWindow: null, totalVisits: null },
  cameras: { online: 6, total: 13 },
};

const series = (granularity: 'hour' | 'day' | 'week') => {
  const base = granularity === 'hour' ? ['2026-09-21T09:00:00', '2026-09-21T10:00:00'] : ['2026-09-20', '2026-09-21'];
  return base.flatMap((ts, i) => [
    { ts, zone: 'Lobby', count: 4 + i * 2 },
    { ts, zone: 'ODC', count: 1 + i },
  ]);
};
export const OCCUPANCY = (granularity: 'hour' | 'day' | 'week'): OccupancyData => ({ current: 8, peak: 16, average: 9, lowest: 1, series: series(granularity) });

export const DEPARTMENTS: DepartmentDistributionRow[] = [
  { departmentId: 1, name: 'Sales & Marketing', employeesDetected: 8, visits: 30, avgTimeSpentMinutes: 68, trafficPct: 40 },
  { departmentId: 2, name: 'Application Engineering', employeesDetected: 12, visits: 25, avgTimeSpentMinutes: 107, trafficPct: 33.33 },
  { departmentId: 3, name: 'COE', employeesDetected: 5, visits: 20, avgTimeSpentMinutes: null, trafficPct: 26.67 },
];

export const PEAK_HOURS: PeakHoursData = {
  highestWindow: { startHour: 9, endHour: 10, count: 43 },
  lowestWindow: { startHour: 18, endHour: 19, count: 2 },
  peakHeadcountMoment: { at: '2026-09-21T09:40:00.000Z', count: 12 },
  hourly: [
    { hour: 9, entries: 40, exits: 3, traffic: 43, avgOccupancy: 7, peakOccupancy: 12 },
    { hour: 13, entries: 5, exits: 20, traffic: 25, avgOccupancy: 4, peakOccupancy: 6 },
    { hour: 18, entries: 1, exits: 1, traffic: 2, avgOccupancy: 2, peakOccupancy: 3 },
  ],
  byZone: [
    { zone: 'Lobby', hour: 9, entries: 30, exits: 2 },
    { zone: 'ODC', hour: 9, entries: 10, exits: 1 },
    { zone: 'Lobby', hour: 13, entries: 5, exits: 20 },
  ],
};

export const HEATMAP: HeatmapData = {
  maxCell: 40,
  cells: [
    { dow: 1, hour: 9, count: 10, pctOfPeak: 25 },
    { dow: 1, hour: 10, count: 40, pctOfPeak: 100 },
    { dow: 3, hour: 14, count: 20, pctOfPeak: 50 },
  ],
};

export const ENTRY_POINTS: EntryPointTrafficRow[] = [
  { deviceId: 'CAM-1', deviceLabel: 'Front Camera', entries: 50, exits: 10, net: 40, uniqueEmployees: 30, contributionPct: 70, peakActivity: 9 },
  { deviceId: 'CAM-2', deviceLabel: 'Side Gate', entries: 10, exits: 30, net: -20, uniqueEmployees: 12, contributionPct: 30, peakActivity: 18 },
];

export const TIME_SPENT: TimeSpentBucket[] = [
  { bucket: '<1h', count: 40, pct: 60 }, { bucket: '1-3h', count: 20, pct: 30 }, { bucket: '3-6h', count: 5, pct: 7.5 },
  { bucket: '6-9h', count: 2, pct: 2.5 }, { bucket: '>9h', count: 0, pct: 0 },
];

export const MATRIX: MovementMatrix = {
  matrix: [
    { fromZone: 'Lobby', toZone: 'ODC', count: 6, pct: 60, isPrimary: true },
    { fromZone: 'Lobby', toZone: 'Innovate Area', count: 2, pct: 20, isPrimary: false },
    { fromZone: 'ODC', toZone: 'Lobby', count: 2, pct: 20, isPrimary: true },
  ],
  mostVisited: [{ zone: 'Lobby', visits: 40 }, { zone: 'ODC', visits: 10 }],
};

export const EVENT_ROWS: ZoneEventRow[] = [
  { id: 'p1', timestamp: '2026-09-21T09:00:00.000Z', eventType: 'entry', employeeId: 5, employeeCode: 'E5', employeeName: 'Jane Doe', entrance: 'Front Camera', zone: 'Lobby', recognitionStatus: 'verified', confidence: 0.91, cameraId: 'CAM-1', details: null, photoUrl: null },
  { id: 'p2', timestamp: '2026-09-21T09:05:00.000Z', eventType: 'exit', employeeId: 6, employeeCode: 'E6', employeeName: 'Asha Rao', entrance: 'Side Gate', zone: 'Lobby', recognitionStatus: 'verified', confidence: 0.62, cameraId: 'CAM-2', details: null, photoUrl: null },
  { id: 'u3', timestamp: '2026-09-21T09:10:00.000Z', eventType: 'unknown_face', employeeId: null, employeeCode: null, employeeName: null, entrance: 'Front Camera', zone: 'Lobby', recognitionStatus: 'unrecognized', confidence: null, cameraId: 'CAM-1', details: 'Visitor (unregistered)', photoUrl: null },
  { id: 'o4', timestamp: '2026-09-21T09:15:00.000Z', eventType: 'camera_offline', employeeId: null, employeeCode: null, employeeName: null, entrance: 'Side Gate', zone: 'ODC', recognitionStatus: 'system', confidence: null, cameraId: 'CAM-2', details: 'Camera stopped responding', photoUrl: null },
  { id: 'p5', timestamp: '2026-09-21T09:20:00.000Z', eventType: 'entry', employeeId: 7, employeeCode: 'E7', employeeName: 'Ravi K', entrance: 'Front Camera', zone: 'ODC', recognitionStatus: 'verified', confidence: 0.8, cameraId: 'CAM-1', details: null, photoUrl: 'Ravi_K_2026-09-21_09-20-00-111.jpg' },
];
export const EVENTS = (rows = EVENT_ROWS, total = rows.length): ZoneEventsPage => ({ rows, total });

export const EMPLOYEES: EmployeesData = {
  rows: [
    {
      employeeId: 7, employeeCode: 'E7', name: 'Asha Rao', role: 'Engineer', department: 'Sales', primaryZone: 'Lobby',
      totalZoneVisits: 4, totalTimeInsideMinutes: 250, avgVisitMinutes: 63, entries: 4, exits: 3,
      firstSeen: '2026-09-21T04:00:00.000Z', lastSeen: '2026-09-21T09:00:00.000Z', avgMatchConfidence: 0.912, currentlyInZone: true,
      zoneMinutes: [{ zone: 'Lobby', minutes: 200 }, { zone: 'ODC', minutes: 50 }], recentFlow: ['Lobby', 'ODC', 'Lobby'],
      entranceUsage: [{ entrance: 'Front Camera', count: 5 }, { entrance: 'Side Gate', count: 2 }],
    },
    {
      employeeId: 8, employeeCode: 'E8', name: 'Ravi Kumar', role: 'Analyst', department: 'COE', primaryZone: 'ODC',
      totalZoneVisits: 2, totalTimeInsideMinutes: 300, avgVisitMinutes: 150, entries: 2, exits: 2,
      firstSeen: '2026-09-21T05:00:00.000Z', lastSeen: '2026-09-21T08:00:00.000Z', avgMatchConfidence: 0.7, currentlyInZone: false,
      zoneMinutes: [{ zone: 'ODC', minutes: 300 }], recentFlow: ['ODC'], entranceUsage: [{ entrance: 'Front Camera', count: 4 }],
    },
  ],
  total: 2,
  summary: { trackedEmployees: 2, meanTimeInZoneMinutes: 275, mostActiveEmployee: { name: 'Asha Rao', zoneVisits: 4 }, meanMatchConfidence: 0.806 },
};

export const MOVEMENT: MovementDetail = {
  transitions: [
    { zone: 'Lobby', enteredAt: '2026-09-21T04:00:00.000Z', exitedAt: '2026-09-21T05:00:00.000Z' },
    { zone: 'ODC', enteredAt: '2026-09-21T06:00:00.000Z', exitedAt: null },
  ],
  events: [
    { id: 'p1', timestamp: '2026-09-21T04:00:00.000Z', eventType: 'entry', zone: 'Lobby', entrance: 'Front Camera', confidence: 0.9, cameraId: 'CAM-1', photoUrl: 'Asha_Rao_2026-09-21_04-00-00-111.jpg' },
    { id: 'p2', timestamp: '2026-09-21T05:00:00.000Z', eventType: 'exit', zone: 'Lobby', entrance: 'Side Gate', confidence: null, cameraId: 'CAM-2', photoUrl: null },
  ],
  dailyPhotos: [{ date: '2026-09-21', checkInPhotoUrl: 'in_1.jpg', checkOutPhotoUrl: null }],
};

export const COMPARE = (metric: CompareData['metric'] = 'occupancy', granularity: CompareData['granularity'] = 'hour'): CompareData => ({
  metric, granularity,
  zones: {
    Lobby: { profile: { primaryDepartment: 'Sales', liveHeadcount: 6, peak: 12, pctOfPeak: 50, entries: 30, exits: 20, avgDwellMinutes: 60, entrances: 3 }, series: [{ bucket: 9, value: 5, entries: 4, exits: 1 }, { bucket: 10, value: 8, entries: 6, exits: 2 }] },
    ODC: { profile: { primaryDepartment: 'COE', liveHeadcount: 2, peak: 4, pctOfPeak: 50, entries: 10, exits: 9, avgDwellMinutes: 30, entrances: 1 }, series: [{ bucket: 9, value: 1, entries: 1, exits: 0 }, { bucket: 10, value: 2, entries: 2, exits: 1 }] },
  },
  matrix: [
    { zone: 'Lobby', liveHeadcount: 6, peak: 12, entries: 30, exits: 20, net: 10, avgDwellMinutes: 60 },
    { zone: 'ODC', liveHeadcount: 2, peak: 4, entries: 10, exits: 9, net: 1, avgDwellMinutes: 30 },
  ],
  aggregate: { liveHeadcount: 8, peak: 12, entries: 40, exits: 29, net: 11, avgDwellMinutes: 53 },
});

export interface ApiCall { path: string; options?: unknown }

/** Batch widget -> the single-endpoint path whose route fixture supplies its data. */
const BATCH_WIDGETS: Record<string, Record<string, Record<string, string>>> = {
  overview: {
    core: {
      summary: '/zones/analytics/summary', zones: '/zones', occHourly: '/zones/analytics/occupancy?granularity=hour',
      occDaily: '/zones/analytics/occupancy?granularity=day', occWeekly: '/zones/analytics/occupancy?granularity=week',
      departments: '/zones/analytics/departments', peak: '/zones/analytics/peak-hours',
    },
    detail: { events: '/zones/events/recent' },
  },
  'deep-dive': {
    core: {
      summary: '/zones/analytics/summary', peak: '/zones/analytics/peak-hours', heatmap: '/zones/analytics/heatmap',
      entrances: '/zones/analytics/entry-points', timeSpent: '/zones/analytics/time-spent', matrix: '/zones/movement/matrix',
    },
    detail: { events: '/zones/events/recent' },
  },
  compare: { core: { zones: '/zones', compare: '/zones/compare' }, detail: {} },
  movement: { core: { employees: '/zones/employees', top: '/zones/employees' }, detail: { movement: '/zones/movement/' } },
};
const FILTER_WIDGETS: Record<string, string> = { zones: '/zones', entryPoints: '/zones/entry-points', departments: '/zones/departments', cameras: '/zones/cameras' };

/**
 * Build the fake `apiRequest`. It answers the BATCH endpoints (/zones/batch/...) the pages now call:
 * each widget's data comes from the per-widget route fixtures below (routes by path prefix, first match
 * wins), an Error route value becomes that widget's entry under `errors` (the server's per-widget
 * isolation). `calls` are the real HTTP requests (count them for "requests per view");
 * `widgetCalls` are the equivalent single-endpoint paths with the batch query, so the exact query
 * string reaching each widget can still be asserted.
 */
export function makeApi(routes: Record<string, unknown | ((path: string) => unknown)>) {
  const calls: ApiCall[] = [];
  const widgetCalls: ApiCall[] = [];
  const resolve = (path: string): { found: boolean; data?: unknown } => {
    for (const [prefix, value] of Object.entries(routes)) {
      if (path === prefix || path.startsWith(prefix + '?') || (prefix.endsWith('/') && path.startsWith(prefix))) {
        return { found: true, data: typeof value === 'function' ? (value as (p: string) => unknown)(path) : value };
      }
    }
    return { found: false };
  };
  const widget = (oldPath: string, query: URLSearchParams, into: { data: Record<string, unknown>; errors: Record<string, string> }, key: string) => {
    const full = oldPath + (oldPath.includes('?') ? '&' : '?') + query.toString();
    widgetCalls.push({ path: full });
    const r = resolve(full);
    const data = r.found ? r.data : [];
    if (data instanceof Error) into.errors[key] = data.message;
    else into.data[key] = data;
  };
  const batch = (path: string) => {
    const [pathname, qs = ''] = path.split('?');
    const query = new URLSearchParams(qs);
    const into = { data: {} as Record<string, unknown>, errors: {} as Record<string, string> };
    const parts = pathname.replace('/zones/batch/', '').split('/');
    if (parts[0] === 'filters') {
      for (const [k, old] of Object.entries(FILTER_WIDGETS)) widget(old, query, into, k);
    } else {
      const [view, part] = parts;
      for (const [k, old] of Object.entries(BATCH_WIDGETS[view]?.[part] ?? {})) {
        if (view === 'compare' && k === 'compare' && query.getAll('zone').length < 2) continue;
        const q = new URLSearchParams(query);
        let target = old;
        if (view === 'movement' && part === 'core' && k === 'top') {
          q.set('sort', q.get('topSort') || 'visits'); q.set('dir', 'desc'); q.set('page', '1'); q.set('pageSize', q.get('topPageSize') || '10');
          if (q.get('topQ')) q.set('q', q.get('topQ')!); else q.delete('q');
          q.delete('status');
        }
        for (const drop of ['topQ', 'topSort', 'topPageSize', 'refresh']) q.delete(drop);
        if (view === 'movement' && part === 'detail') { target = old + (q.get('employeeId') ?? ''); q.delete('employeeId'); }
        widget(target, q, into, k);
      }
    }
    return { data: into.data, errors: into.errors, computedAt: new Date().toISOString() };
  };
  const handler = (path: string, options?: unknown) => {
    calls.push({ path, options });
    if (path.startsWith('/zones/batch/')) return Promise.resolve(batch(path));
    const r = resolve(path);
    if (r.data instanceof Error) return Promise.reject(r.data);
    return Promise.resolve({ data: r.found ? r.data : [] });
  };
  return {
    handler, calls, widgetCalls,
    last: (prefix: string) => [...calls].reverse().find((c) => c.path.startsWith(prefix)),
    lastWidget: (prefix: string) => [...widgetCalls].reverse().find((c) => c.path.startsWith(prefix)),
  };
}

export const OVERVIEW_ROUTES = {
  '/zones/analytics/summary': SUMMARY,
  '/zones/analytics/occupancy': (p: string) => OCCUPANCY(/granularity=week/.test(p) ? 'week' : /granularity=day/.test(p) ? 'day' : 'hour'),
  '/zones/analytics/departments': DEPARTMENTS,
  '/zones/analytics/peak-hours': PEAK_HOURS,
  '/zones/events/recent': EVENTS(),
  '/zones/entry-points': [{ deviceId: 'CAM-1', deviceLabel: 'Front Camera', zone: 'Lobby' }],
  '/zones/departments': [{ departmentId: 1, name: 'Sales & Marketing' }],
  '/zones/cameras': [{ cameraId: 'CAM-1', name: 'Front Camera', entrance: 'Front Camera', zone: 'Lobby' }],
  '/zones': ZONES,
};
