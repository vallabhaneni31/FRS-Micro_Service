/**
 * ZoneAnalyticsController.js — specs/0003-zone-analytics.
 * Pulls req.auth.scope only (never a client-supplied tenant/site id, Req 2.4),
 * parses shared filter query params via ZoneAnalyticsService.parseFilters,
 * maps service errors to HTTP codes — same shape as DeviceHierarchyController.js.
 * Every handler is a read; none writes to any table.
 */
import * as svc from '../services/business/ZoneAnalyticsService.js';
import { getBatch } from '../services/business/ZoneBatchService.js';

const { NotFoundError, ValidationError } = svc;

// Mirrors DeviceHierarchyController.js:9-14 exactly — req.auth.scope first,
// header fallback only for parity with the rest of this codebase's routes.
const getSiteId = (req) => req.auth?.scope?.siteId ?? req.headers['x-site-id'] ?? null;
const getTenantId = (req) => req.auth?.scope?.tenantId ?? req.headers['x-tenant-id'] ?? null;

function handleKnownError(err, res) {
  if (err instanceof NotFoundError) return res.status(404).json({ message: err.message });
  if (err instanceof ValidationError) return res.status(err.statusCode || 400).json({ error: err.message });
  return null;
}

function scope(req) {
  return { tenantId: getTenantId(req), siteId: getSiteId(req) };
}

function filters(req) {
  return svc.parseFilters(req.query, scope(req));
}

function pagination(req) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20));
  return { page, pageSize };
}

/** Wrap a handler: run it, send `{ data }`, map known errors to 4xx. */
const read = (fn) => async (req, res) => {
  try {
    const data = await fn(req);
    res.json({ data });
  } catch (err) {
    if (handleKnownError(err, res)) return;
    throw err;
  }
};

/**
 * Batch responses are { data, errors, computedAt } (per-widget failure isolation, design.md 2.8);
 * the tenant/site always come from req.auth.scope, never from the query.
 */
const batch = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    if (handleKnownError(err, res)) return;
    throw err;
  }
};

const ZoneAnalyticsController = {
  // Req 12 — batch endpoints
  getFiltersBatch: batch((req) => getBatch({ view: 'filters', query: req.query, scope: scope(req) })),
  getViewBatch: batch((req) => getBatch({ view: req.params.view, part: req.params.part, query: req.query, scope: scope(req) })),

  // Req 2.1-2.3, 2.6 — filter-list sources
  listZones: read((req) => svc.listZones(scope(req), req.query)),
  listEntryPoints: read((req) => svc.listEntryPoints(scope(req), req.query.zone || null)),
  listDepartments: read((req) => svc.listDepartments(scope(req))),
  listCameras: read((req) => svc.listCameras(scope(req))),

  // Req 3 / 6 — analytics
  getSummary: read((req) => svc.getSummary(filters(req))),
  getOccupancy: read((req) => svc.getOccupancy(filters(req), req.query.granularity || 'hour')),
  getTraffic: read((req) => svc.getTraffic(filters(req))),
  getPeakHours: read((req) => svc.getPeakHours(filters(req))),
  getHeatmap: read((req) => svc.getHeatmap(filters(req))),
  getEntryPointTraffic: read((req) => svc.getEntryPointTraffic(filters(req))),
  getDepartmentDistribution: read((req) => svc.getDepartmentDistribution(filters(req))),
  getTimeSpent: read((req) => svc.getTimeSpent(filters(req))),
  getVisits: read((req) => svc.getVisits(filters(req))),

  // Req 5 — events feed: { data: { rows, total } }
  getRecentEvents: read((req) => {
    const { page, pageSize } = pagination(req);
    return svc.getRecentEvents(filters(req), {
      page,
      pageSize,
      eventType: req.query.eventType,
      status: req.query.status,
      q: req.query.q,
      personType: req.query.personType,
      withPhotos: req.query.withPhotos === '1',
    });
  }),

  // Req 9 — employees list: { data: { rows, total, summary } }
  getEmployees: read((req) => {
    const { page, pageSize } = pagination(req);
    return svc.getEmployees(filters(req), {
      q: req.query.q,
      status: req.query.status,
      sort: req.query.sort,
      dir: req.query.dir,
      page,
      pageSize,
    });
  }),

  // Req 9 — one employee: transitions, per-event photos, day-level photos
  getMovementTimeline: read((req) => {
    const f = req.query.tz ? { tz: String(req.query.tz) } : {};
    return svc.getMovementTimeline(scope(req), req.params.employeeId, {
      fromDate: req.query.fromDate || null,
      toDate: req.query.toDate || null,
      withPhotos: req.query.withPhotos === '1',
      ...f,
    });
  }),

  getMovementMatrix: read((req) => {
    const f = filters(req);
    return svc.getMovementMatrix({
      ...f,
      employeeId: req.query.employeeId || null,
      departmentId: req.query.departmentId || null,
    });
  }),

  // Req 8 — compare; HTTP 400 { error: 'Select at least 2 zones' } for < 2 zones
  compareZones: read((req) => svc.compareZones(filters(req), {
    metric: req.query.metric || 'occupancy',
    granularity: req.query.granularity || 'hour',
  })),
};

export default ZoneAnalyticsController;
