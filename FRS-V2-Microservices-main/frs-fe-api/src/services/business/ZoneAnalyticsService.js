/**
 * ZoneAnalyticsService.js — specs/0003-zone-analytics.
 * Reshapes zoneRepository rows into the response shapes documented in
 * design.md §2.1, owning validation errors — same layering convention as
 * DeviceHierarchyService.js (repository -> service -> controller -> routes).
 * Read-only: nothing here writes to any table.
 */
import * as repo from '../../repositories/zoneRepository.js';

const { TIME_RANGES } = repo;

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.statusCode = 404;
  }
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validate/normalize the shared filter query params (Req 2.1-2.4, 3.9). */
export function parseFilters(query, { tenantId, siteId }) {
  if (!tenantId) throw new ValidationError('tenant scope required');

  const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const fromDate = query.fromDate;
  const toDate = query.toDate;
  if (fromDate && !ISO_DATE.test(String(fromDate))) {
    throw new ValidationError('fromDate must be YYYY-MM-DD');
  }
  if (toDate && !ISO_DATE.test(String(toDate))) {
    throw new ValidationError('toDate must be YYYY-MM-DD');
  }
  if (fromDate && toDate && String(fromDate) > String(toDate)) {
    throw new ValidationError('fromDate must not be after toDate');
  }

  const timeRange = query.timeRange ? String(query.timeRange) : 'full';
  if (!TIME_RANGES.includes(timeRange)) {
    throw new ValidationError(`timeRange must be one of ${TIME_RANGES.join(', ')}`);
  }

  // Off by default (Revision 8): a confidence floor only applies when the user sets one.
  let minConfidence = null;
  if (query.minConfidence !== undefined && query.minConfidence !== '') {
    minConfidence = Number(query.minConfidence);
    if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
      throw new ValidationError('minConfidence must be a number between 0 and 1');
    }
  }

  const tz = query.tz ? String(query.tz) : 'UTC';
  if (!validTimeZone(tz)) throw new ValidationError('tz must be a valid IANA time zone');

  return {
    tenantId,
    siteId: siteId ?? null,
    zones: toArray(query.zone),
    entryPointIds: toArray(query.entryPointId),
    departmentIds: toArray(query.departmentId),
    cameraIds: toArray(query.cameraId),
    fromDate: fromDate ?? null,
    toDate: toDate ?? null,
    timeRange,
    minConfidence,
    securityOnly: String(query.securityOnly).toLowerCase() === 'true',
    tz,
  };
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

export async function listZones(scope, query = {}, r = repo) {
  const tz = query.tz ? String(query.tz) : 'UTC';
  if (!validTimeZone(tz)) throw new ValidationError('tz must be a valid IANA time zone');
  for (const key of ['fromDate', 'toDate']) {
    if (query[key] && !ISO_DATE.test(String(query[key]))) throw new ValidationError(`${key} must be YYYY-MM-DD`);
  }
  return r.listZones({ ...scope, fromDate: query.fromDate, toDate: query.toDate, tz });
}

export async function listEntryPoints(scope, zone, r = repo) {
  return r.listEntryPoints({ ...scope, zone });
}

export async function listDepartments(scope, r = repo) {
  return r.listDepartments(scope);
}

export async function listCameras(scope, r = repo) {
  return r.listCameras(scope);
}

const GRANULARITY = { hour: 'hour', day: 'day', week: 'week' };

export async function getOccupancy(filters, granularity = 'hour', r = repo) {
  if (!GRANULARITY[granularity]) throw new ValidationError('granularity must be hour, day or week');
  const [summary, series] = await Promise.all([
    r.getOccupancy(filters),
    r.getOccupancySeries(filters, granularity),
  ]);
  return {
    current: num(summary.current_occupancy),
    peak: num(summary.peak_occupancy),
    average: num(summary.average_occupancy),
    lowest: num(summary.lowest_occupancy),
    series,
  };
}

export async function getTraffic(filters, r = repo) {
  return r.getTraffic(filters);
}

export async function getHeatmap(filters, r = repo) {
  return r.getHeatmap(filters);
}

export async function getEntryPointTraffic(filters, r = repo) {
  return r.getEntryPointTraffic(filters);
}

export async function getDepartmentDistribution(filters, r = repo) {
  return r.getDepartmentDistribution(filters);
}

export async function getTimeSpent(filters, r = repo) {
  return r.getTimeSpentBuckets(filters);
}

export async function getVisits(filters, r = repo) {
  return r.getVisits(filters);
}

/** Busiest / quietest one-hour windows, computed from the hourly profile (Req 3.7). */
function pickWindow(hours, pick, { max = true, nonZero = false } = {}) {
  const candidates = hours.filter((h) => (nonZero ? pick(h) > 0 : true));
  if (!candidates.length) return null;
  const best = candidates.reduce((a, b) => {
    const better = max ? pick(b) > pick(a) : pick(b) < pick(a);
    return better ? b : a;
  });
  return { startHour: best.hour, endHour: (best.hour + 1) % 24, count: pick(best) };
}

export async function getPeakHours(filters, r = repo) {
  const profile = await r.getHourlyProfile(filters);
  const { hourly } = profile;
  return {
    highestWindow: pickWindow(hourly, (h) => h.traffic, { max: true, nonZero: true }),
    // Quietest hour that still had activity (a zero hour would just be "closed").
    lowestWindow: pickWindow(hourly, (h) => h.traffic, { max: false, nonZero: true }),
    peakHeadcountMoment: profile.peakMoment,
    hourly,
    byZone: profile.byZone,
  };
}

/**
 * Feeds the 3 hero cards and the Overview stat tiles (Req 6.1, 6.3). No
 * recognition / security totals, no capacity (Req 4.3).
 */
export async function getSummary(filters, r = repo) {
  const [occ, traffic, visits, unique, trend, cameras, profile] = await Promise.all([
    r.getOccupancy(filters),
    r.getTraffic(filters),
    r.getVisits(filters),
    r.getUniqueEmployees(filters),
    r.getHeadcountTrend(filters),
    r.getCameraCounts({ tenantId: filters.tenantId, siteId: filters.siteId }),
    r.getHourlyProfile(filters),
  ]);
  const hasData = traffic.totalEntries + traffic.totalExits > 0;
  const current = num(occ.current_occupancy);
  const peak = num(occ.peak_occupancy);
  let changeVs1hPct = null;
  if (trend.minutesIntoDay >= 60 && trend.hourAgo > 0) {
    changeVs1hPct = Math.round(((trend.now - trend.hourAgo) / trend.hourAgo) * 100);
  }
  const total = traffic.totalEntries + traffic.totalExits;
  const pct = (n) => (total > 0 ? Math.round((n / total) * 100) : null);
  return {
    hasData,
    headcount: {
      current,
      peak,
      average: num(occ.average_occupancy),
      lowest: num(occ.lowest_occupancy),
      pctOfPeak: current !== null && peak ? Math.round((current / peak) * 100) : null,
      changeVs1hPct,
    },
    flow: {
      entries: hasData ? traffic.totalEntries : null,
      exits: hasData ? traffic.totalExits : null,
      net: hasData ? traffic.totalEntries - traffic.totalExits : null,
      pctIn: hasData ? pct(traffic.totalEntries) : null,
      pctOut: hasData ? pct(traffic.totalExits) : null,
      uniqueEmployees: hasData ? unique : null,
    },
    dwell: {
      avgVisitMinutes: visits.avgVisitDurationMinutes,
      avgTimeInsideMinutes: visits.avgTimeInsideMinutes,
      peakInflowWindow: pickWindow(profile.hourly, (h) => h.entries, { max: true, nonZero: true }),
      peakEgressWindow: pickWindow(profile.hourly, (h) => h.exits, { max: true, nonZero: true }),
      totalVisits: hasData ? visits.totalVisits : null,
    },
    cameras,
  };
}

export async function getRecentEvents(filters, { page, pageSize, eventType, status, q, personType, withPhotos } = {}, r = repo) {
  if (personType && !repo.PERSON_TYPES.includes(personType)) {
    throw new ValidationError(`personType must be one of ${repo.PERSON_TYPES.join(', ')}`);
  }
  if (eventType && eventType !== 'all' && !repo.EVENT_TYPES.includes(eventType)) {
    throw new ValidationError(`eventType must be one of all, ${repo.EVENT_TYPES.join(', ')}`);
  }
  if (status && status !== 'all' && !repo.EVENT_STATUSES.includes(status)) {
    throw new ValidationError(`status must be one of all, ${repo.EVENT_STATUSES.join(', ')}`);
  }
  return r.getRecentEvents(filters, {
    page,
    pageSize,
    eventType: eventType && eventType !== 'all' ? eventType : undefined,
    status: status && status !== 'all' ? status : undefined,
    q: q ? String(q).slice(0, 100) : undefined,
    personType: personType && personType !== 'all' ? personType : undefined,
    withPhotos: withPhotos === true,
  });
}

export async function getEmployees(filters, { q, status, sort, dir, page, pageSize } = {}, r = repo) {
  if (status && !repo.EMPLOYEE_STATUSES.includes(status)) {
    throw new ValidationError(`status must be one of ${repo.EMPLOYEE_STATUSES.join(', ')}`);
  }
  return r.getEmployees(filters, {
    q: q ? String(q).slice(0, 100) : undefined,
    status: status && status !== 'all' ? status : undefined,
    sort,
    dir,
    page,
    pageSize,
  });
}

export async function getMovementTimeline(scope, employeeId, { fromDate, toDate, tz, withPhotos = false }, r = repo) {
  if (!employeeId || !/^\d+$/.test(String(employeeId))) throw new ValidationError('employeeId must be a number');
  const zone = tz || 'UTC';
  if (!validTimeZone(zone)) throw new ValidationError('tz must be a valid IANA time zone');
  const args = { tenantId: scope.tenantId, employeeId, fromDate, toDate, tz: zone, withPhotos: withPhotos === true };
  const [transitions, events, dailyPhotos] = await Promise.all([
    r.getEmployeeMovementTimeline(args),
    r.getEmployeeEvents(args),
    r.getEmployeeDailyPhotos(args),
  ]);
  return { transitions, events, dailyPhotos };
}

export async function getMovementMatrix(filters, r = repo) {
  return r.getMovementMatrix(filters);
}

/**
 * Side-by-side zone comparison (Req 8). The aggregate row sums headcount,
 * entries and exits, takes the highest single-zone peak (peaks of different
 * zones are not simultaneous, so summing them would overstate) and weights
 * average dwell by each zone's entries.
 */
export async function compareZones(filters, { metric = 'occupancy', granularity = 'hour' } = {}, r = repo) {
  if (!filters.zones || filters.zones.length < 2) {
    throw new ValidationError('Select at least 2 zones');
  }
  if (!repo.COMPARE_METRICS.includes(metric)) throw new ValidationError('metric must be occupancy, traffic or dwell');
  if (!repo.COMPARE_GRANULARITIES.includes(granularity)) throw new ValidationError('granularity must be hour, dow or week');
  const zones = [...new Set(filters.zones)];
  const entries = await Promise.all(
    zones.map(async (zone) => {
      const zoneFilters = { ...filters, zones: [zone] };
      const [occupancy, visits, traffic, extras, series] = await Promise.all([
        r.getOccupancy(zoneFilters),
        r.getVisits(zoneFilters),
        r.getTraffic(zoneFilters),
        r.getZoneExtras(zoneFilters),
        r.getComparisonSeries(zoneFilters, metric, granularity),
      ]);
      const current = num(occupancy.current_occupancy);
      const peak = num(occupancy.peak_occupancy);
      const profile = {
        primaryDepartment: extras.primaryDepartment,
        liveHeadcount: current,
        peak,
        pctOfPeak: current !== null && peak ? Math.round((current / peak) * 100) : null,
        entries: traffic.totalEntries,
        exits: traffic.totalExits,
        avgDwellMinutes: visits.avgVisitDurationMinutes,
        entrances: extras.entrances,
      };
      return [zone, { profile, series }];
    })
  );
  const byZone = Object.fromEntries(entries);
  const matrix = entries.map(([zone, { profile }]) => ({
    zone,
    liveHeadcount: profile.liveHeadcount,
    peak: profile.peak,
    entries: profile.entries,
    exits: profile.exits,
    net: profile.entries - profile.exits,
    avgDwellMinutes: profile.avgDwellMinutes,
  }));
  const dwellRows = matrix.filter((r) => r.avgDwellMinutes !== null && r.entries > 0);
  const dwellWeight = dwellRows.reduce((s, r) => s + r.entries, 0);
  const aggregate = {
    liveHeadcount: matrix.some((r) => r.liveHeadcount !== null) ? matrix.reduce((s, r) => s + (r.liveHeadcount ?? 0), 0) : null,
    peak: matrix.some((r) => r.peak !== null) ? Math.max(...matrix.map((r) => r.peak ?? 0)) : null,
    entries: matrix.reduce((s, r) => s + r.entries, 0),
    exits: matrix.reduce((s, r) => s + r.exits, 0),
    net: matrix.reduce((s, r) => s + r.net, 0),
    avgDwellMinutes: dwellWeight > 0 ? Math.round(dwellRows.reduce((s, r) => s + r.avgDwellMinutes * r.entries, 0) / dwellWeight) : null,
  };
  return { zones: byZone, matrix, aggregate, metric, granularity };
}
