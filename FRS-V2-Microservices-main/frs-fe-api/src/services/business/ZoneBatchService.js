/**
 * ZoneBatchService.js — specs/0003-zone-analytics, Requirement 12 (design.md 2.8).
 *
 * One HTTP request per part of a view instead of one per widget:
 *   filters                      -> zones, entry points, departments, cameras
 *   <view>/core, <view>/detail   -> for view in overview | deep-dive | compare | movement
 * Each returns { data: { <widgetKey>: <same shape as the single endpoint> },
 *                errors: { <widgetKey>: message }, computedAt }.
 *
 * All widgets of a batch start at once (concurrent queries). A widget that fails is
 * reported under `errors` and the others still return (the server-side equivalent of
 * Promise.allSettled). A ValidationError (bad client input) fails the whole request
 * with 400, exactly like the single endpoints. Repository calls are memoised per
 * batch, so a function asked for twice with identical arguments (e.g. the summary
 * card and the occupancy trend both need today's occupancy) runs once.
 *
 * Results are cached by zoneCache.js (tenant-scoped keys, 60 s / 10 min, single-flight,
 * `refresh=1` bypass). A batch that contained a widget error is not cached.
 * Read-only: nothing here writes to any table.
 */
import * as repo from '../../repositories/zoneRepository.js';
import * as svc from './ZoneAnalyticsService.js';
import { AGGREGATE_TTL_MS, FILTER_LIST_TTL_MS, buildCacheKey, zoneCache } from './zoneCache.js';
import logger from '../../utils/logger.js';

const { ValidationError } = svc;

export const VIEWS = ['overview', 'deep-dive', 'compare', 'movement'];
export const PARTS = ['core', 'detail'];

const WIDGET_ERROR_MESSAGE = 'Could not load this section';

/** Memoise every repository function by (name + arguments) for the lifetime of one batch. */
export function memoRepository(base = repo) {
  const cache = new Map();
  const out = {};
  for (const key of Object.keys(base)) {
    const fn = base[key];
    if (typeof fn !== 'function') { out[key] = fn; continue; }
    out[key] = (...args) => {
      const k = key + JSON.stringify(args);
      if (!cache.has(k)) cache.set(k, fn(...args));
      return cache.get(k);
    };
  }
  return out;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const intOr = (v, d, min, max) => Math.min(max, Math.max(min, Number(v) || d));

/** Widgets of a view part: key -> () => Promise. Same functions the single endpoints call. */
function widgetsFor(view, part, { query, scope, r }) {
  const filters = () => svc.parseFilters(query, scope);
  const tz = query.tz ? String(query.tz) : 'UTC';
  const page = intOr(query.page, 1, 1, 1e6);
  const events = (defaultSize) => {
    const f = filters();
    return svc.getRecentEvents(f, {
      page,
      pageSize: intOr(query.pageSize, defaultSize, 1, 200),
      eventType: query.eventType,
      status: query.status,
      q: query.q,
      personType: query.personType,
      // never true from a batch: photos are only for Employee Movement (AC 12.3)
    }, r);
  };

  if (view === 'overview') {
    if (part === 'core') {
      const f = filters();
      const to = f.toDate || repo.localToday(tz);
      const range = (from) => svc.parseFilters({ ...query, fromDate: from, toDate: to }, scope);
      return {
        summary: () => svc.getSummary(f, r),
        zones: () => svc.listZones(scope, { tz }, r),
        occHourly: () => svc.getOccupancy(f, 'hour', r),
        occDaily: () => svc.getOccupancy(range(addDays(to, -6)), 'day', r),
        occWeekly: () => svc.getOccupancy(range(addDays(to, -27)), 'week', r),
        departments: () => svc.getDepartmentDistribution(f, r),
        peak: () => svc.getPeakHours(f, r),
      };
    }
    return { events: () => events(5) };
  }

  if (view === 'deep-dive') {
    if (part === 'core') {
      const f = filters();
      return {
        summary: () => svc.getSummary(f, r),
        peak: () => svc.getPeakHours(f, r),
        heatmap: () => svc.getHeatmap(f, r),
        entrances: () => svc.getEntryPointTraffic(f, r),
        timeSpent: () => svc.getTimeSpent(f, r),
        matrix: () => svc.getMovementMatrix({ ...f, employeeId: null, departmentId: null }, r),
      };
    }
    return { events: () => events(10) };
  }

  if (view === 'compare') {
    if (part === 'core') {
      const f = filters();
      const zones = [...new Set(toArray(query.zone))];
      const w = { zones: () => svc.listZones(scope, { tz, fromDate: query.fromDate, toDate: query.toDate }, r) };
      // fewer than 2 zones selected: the page asks the user to pick, so there is nothing to compare yet
      if (zones.length >= 2) {
        w.compare = () => svc.compareZones({ ...f, zones }, { metric: query.metric || 'occupancy', granularity: query.granularity || 'hour' }, r);
      }
      return w;
    }
    return {};
  }

  if (view === 'movement') {
    if (part === 'core') {
      const f = filters();
      const pageSize = intOr(query.pageSize, 12, 1, 200);
      return {
        employees: () => svc.getEmployees(f, {
          q: query.q, status: query.status, sort: query.sort, dir: query.dir, page, pageSize,
        }, r),
        top: () => svc.getEmployees(f, {
          q: query.topQ, sort: query.topSort || 'visits', dir: 'desc', page: 1, pageSize: intOr(query.topPageSize, 10, 1, 50),
        }, r),
      };
    }
    if (!query.employeeId) throw new ValidationError('employeeId is required');
    return {
      movement: () => svc.getMovementTimeline(scope, query.employeeId, {
        fromDate: query.fromDate || null,
        toDate: query.toDate || null,
        tz: query.tz ? String(query.tz) : undefined,
        // the event stream / drilldown are the only places evidence photos are shown
        withPhotos: query.withPhotos === '1' || query.withPhotos === 1 || query.withPhotos === true,
      }, r),
    };
  }
  throw new ValidationError(`view must be one of ${VIEWS.join(', ')}`);
}

function filterWidgets({ query, scope, r }) {
  const tz = query.tz ? String(query.tz) : 'UTC';
  return {
    zones: () => svc.listZones(scope, { tz }, r),
    entryPoints: () => svc.listEntryPoints(scope, null, r),
    departments: () => svc.listDepartments(scope, r),
    cameras: () => svc.listCameras(scope, r),
  };
}

/** Run the widgets concurrently with per-widget failure isolation. */
export async function runWidgets(widgets) {
  const keys = Object.keys(widgets);
  const settled = await Promise.allSettled(keys.map((k) => widgets[k]()));
  const data = {};
  const errors = {};
  settled.forEach((res, i) => {
    if (res.status === 'fulfilled') { data[keys[i]] = res.value; return; }
    if (res.reason instanceof ValidationError) throw res.reason; // client input: whole request is a 400
    logger.error({ err: res.reason, widget: keys[i] }, 'zone batch widget failed');
    errors[keys[i]] = WIDGET_ERROR_MESSAGE;
  });
  return { data, errors };
}

function validate(view, part) {
  if (view === 'filters') return;
  if (!VIEWS.includes(view)) throw new ValidationError(`view must be one of filters, ${VIEWS.join(', ')}`);
  if (!PARTS.includes(part)) throw new ValidationError(`part must be one of ${PARTS.join(', ')}`);
}

/**
 * @param {{ view: string, part?: string, query?: object, scope: {tenantId, siteId}, repository?: object, cache?: object }} args
 *   `query.refresh === '1'` bypasses the cache. `repository` / `cache` are injectable for tests.
 */
export async function getBatch({ view, part = null, query = {}, scope, repository = repo, cache = zoneCache }) {
  if (!scope?.tenantId) throw new ValidationError('tenant scope required');
  validate(view, part);
  const refresh = String(query.refresh) === '1';
  const isFilters = view === 'filters';
  const key = buildCacheKey({ tenantId: scope.tenantId, siteId: scope.siteId, view, part, query });

  const compute = async () => {
    const r = memoRepository(repository);
    const widgets = isFilters ? filterWidgets({ query, scope, r }) : widgetsFor(view, part, { query, scope, r });
    const { data, errors } = await runWidgets(widgets);
    return { data, errors, computedAt: new Date().toISOString() };
  };

  const { value } = await cache.getOrCompute(key, isFilters ? FILTER_LIST_TTL_MS : AGGREGATE_TTL_MS, compute, {
    refresh,
    shouldCache: (v) => Object.keys(v.errors).length === 0,
  });
  return value;
}

export function clearZoneCache() {
  zoneCache.clear();
}
