/**
 * zoneRepository.js — Zone Analytics (specs/0003-zone-analytics).
 *
 * Read-only repository layer, following the same conventions as
 * facilityDeviceRepository.js: plain async functions doing parameterized
 * pool.query() calls, no ORM, no schema change of any kind. NOTHING in this
 * file writes to any table (a test scans this source for write statements).
 *
 * Zone identity (Req 2.1): a device's own facility_device.zone_label,
 * falling back to the camera-hierarchy frs_zone.zone_name (via
 * frs_camera.fk_zone_id), then a parent device's label, a location label and
 * finally the raw device code — the exact resolution order
 * facilityDeviceRepository.js's getZoneHeatmap already uses. A zone is
 * identified by this resolved NAME STRING, never frs_zone.pk_zone_id; the same
 * name in two sites stays two zones because every query is tenant/site scoped.
 *
 * Verified against the live schema at build time (WALKTHROUGH.md 2026-09-21):
 *  - attendance_ping.direction really holds 'in'/'out' (not 'entry'/'exit'); it is
 *    normalised to 'entry'/'exit' in SQL (DIR below).
 *  - facility_device.camera_mode / zone_label exist (frs_camera has no
 *    camera_mode); hr_employee.person_id exists.
 *  - unauthorized_access_log.tenant_id is never written (bigint), so tenant and
 *    site scope for unknown faces comes from the facility_device join.
 *  - a camera = a non-decommissioned facility_device with camera_mode set and no
 *    child devices (camera_mode defaults to 'MIXED', so "set" alone is not enough).
 *
 * Nothing here returns capacity, floor, map coordinates or zone codes.
 */
import path from 'path';
import { pool } from '../db/pool.js';

// ── Shared resolved-zone join fragments ─────────────────────────────────────
// Mirrors facilityDeviceRepository.js (getZoneHeatmap) exactly.
const ZONE_JOIN = `
  LEFT JOIN facility_device fd
    ON (fd.external_device_id = ap.device_code OR fd.pk_device_id::text = ap.device_code)
   AND (fd.tenant_id = ap.tenant_id OR fd.tenant_id IS NULL)
  LEFT JOIN frs_camera fc
    ON (fc.cam_id = ap.device_code OR fc.pk_camera_id::text = ap.device_code)
  LEFT JOIN frs_zone z
    ON z.pk_zone_id = fc.fk_zone_id
  LEFT JOIN facility_device pfd
    ON pfd.pk_device_id = fd.parent_device_id OR pfd.pk_device_id = fc.fk_nug_id
`;

const RESOLVED_ZONE = `
  COALESCE(
    NULLIF(TRIM(fd.zone_label), ''),
    NULLIF(TRIM(z.zone_name), ''),
    NULLIF(TRIM(pfd.zone_label), ''),
    NULLIF(TRIM(fd.location_label), ''),
    ap.device_code
  )
`;

// Same resolution, starting from a facility_device row (unknown faces, offline).
const DEVICE_ZONE_JOIN = `
  LEFT JOIN frs_camera fc
    ON (fc.cam_id = fd.external_device_id OR fc.pk_camera_id::text = fd.external_device_id)
  LEFT JOIN frs_zone z
    ON z.pk_zone_id = fc.fk_zone_id
  LEFT JOIN facility_device pfd
    ON pfd.pk_device_id = fd.parent_device_id OR pfd.pk_device_id = fc.fk_nug_id
`;

const DEVICE_ZONE = `
  COALESCE(
    NULLIF(TRIM(fd.zone_label), ''),
    NULLIF(TRIM(z.zone_name), ''),
    NULLIF(TRIM(pfd.zone_label), ''),
    NULLIF(TRIM(fd.location_label), ''),
    fd.external_device_id
  )
`;

// Feed variant: no site_device_assignment join. A device with several active assignments
// (jetson-box-2 has 4) would repeat every one of its events once per assignment, inflating
// the rows and the total; the site check uses EXISTS instead (see deviceMapCTE).
const FEED_DEVICE_JOIN = `
  LEFT JOIN frs_camera fc
    ON (fc.cam_id = fd.external_device_id OR fc.pk_camera_id::text = fd.external_device_id)
  LEFT JOIN frs_zone z
    ON z.pk_zone_id = fc.fk_zone_id
  LEFT JOIN facility_device pfd
    ON pfd.pk_device_id = fd.parent_device_id OR pfd.pk_device_id = fc.fk_nug_id
`;

const ENTRY_ROLE = `
  COALESCE(
    (SELECT NULLIF(TRIM(s.device_role), '') FROM site_device_assignment s
      WHERE s.device_id = fd.pk_device_id AND s.is_active = TRUE ORDER BY s.device_role NULLS LAST LIMIT 1),
    CASE fd.camera_mode WHEN 'IN' THEN 'entry_point' WHEN 'OUT' THEN 'entry_point' WHEN 'MIXED' THEN 'entry_point' ELSE NULL END,
    'entry_point'
  )
`;

const EMPLOYEE_JOIN = `LEFT JOIN hr_employee he ON he.pk_employee_id = ap.fk_employee_id`;

// Direction as stored is 'in'/'out' (or the legacy words); everything is exposed as entry/exit.
const DIR = `CASE WHEN LOWER(ap.direction) IN ('exit', 'out') THEN 'exit' ELSE 'entry' END`;

// Filter-definition constants (not data): named windows for the Time Interval control.
export const TIME_RANGE_HOURS = { morning: [5, 12], afternoon: [12, 17], evening: [17, 22] };
export const TIME_RANGES = ['full', 'morning', 'afternoon', 'evening', 'peak'];
const LONG_STAY_MINUTES = 240; // "Long Stay >4h" (Req 9.1)
const PHOTO_RETENTION_DAYS = 90; // RETENTION_DEVICE_EVENTS_DAYS default (dataRetentionCron.js)

/** Shared filters that drive attendance_ping-based queries (AC 3.9a/b). */
export const PING_FILTER_KEYS = [
  'tenantId', 'siteId', 'zones', 'entryPointIds', 'departmentIds', 'cameraIds',
  'fromDate', 'toDate', 'timeRange', 'minConfidence', 'tz',
];
/** Filters that only limit the events table (AC 3.9c). */
export const EVENTS_ONLY_FILTERS = ['securityOnly'];

function push(params, value) {
  params.push(value);
  return params.length;
}

const localToday = (tz) => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
};

/** True when the requested range includes the current local day (Req 3.6). */
function rangeIncludesToday({ fromDate, toDate, tz }) {
  const today = localToday(tz);
  if (fromDate && String(fromDate) > today) return false;
  if (toDate && String(toDate) < today) return false;
  return true;
}

const todayStartSql = (tzIdx) => `((date_trunc('day', NOW() AT TIME ZONE $${tzIdx})) AT TIME ZONE $${tzIdx})`;

/** Bare filename served through /uploads (photoAccess.js regex), else null. */
export function toPhotoBasename(value) {
  if (!value || typeof value !== 'string') return null;
  const name = path.posix.basename(value.split('?')[0]);
  return /^[\w-]+\.(jpg|jpeg|png|gif|webp)$/i.test(name) ? name : null;
}

/** Date + time-of-day clauses for any timestamp expression. */
function dateClauses(tsExpr, { fromDate, toDate, timeRange }, params, tz) {
  const clauses = [];
  const needsTz = fromDate || toDate || (timeRange && timeRange !== 'full');
  const tzIdx = needsTz ? push(params, tz || 'UTC') : null;
  if (fromDate) clauses.push(`${tsExpr} >= ($${push(params, fromDate)}::date::timestamp AT TIME ZONE $${tzIdx})`);
  if (toDate) clauses.push(`${tsExpr} < (($${push(params, toDate)}::date + interval '1 day')::timestamp AT TIME ZONE $${tzIdx})`);
  return { clauses, tzIdx };
}

function timeRangeClause(tsExpr, filters, params, tzIdx) {
  const { timeRange } = filters;
  if (!timeRange || timeRange === 'full') return null;
  const hourExpr = `EXTRACT(HOUR FROM (${tsExpr} AT TIME ZONE $${tzIdx}))`;
  if (TIME_RANGE_HOURS[timeRange]) {
    const [from, to] = TIME_RANGE_HOURS[timeRange];
    return `(${hourExpr} >= ${from} AND ${hourExpr} < ${to})`;
  }
  if (timeRange === 'peak') {
    // The three busiest hours of the otherwise-filtered scope — computed, never hardcoded.
    const innerWhere = buildFilters({ ...filters, timeRange: 'full' }, params);
    return `${hourExpr} IN (SELECT h FROM (
      SELECT EXTRACT(HOUR FROM (ap.occurred_at AT TIME ZONE $${tzIdx}))::int AS h, COUNT(*) AS c
      FROM attendance_ping ap ${ZONE_JOIN} ${EMPLOYEE_JOIN}
      WHERE ${innerWhere}
      GROUP BY 1 ORDER BY c DESC, h LIMIT 3) pk)`;
  }
  return null;
}

/**
 * Build the shared WHERE clause + param list for every ping-based query.
 * Always scopes by tenant (Req 2.4); site further narrows (Req 2.5).
 * `ignoreZones` is used by the transition matrix, where a zone filter would
 * invent transitions if it hid the other end of a move.
 */
function buildFilters(filters, params, { ignoreZones = false } = {}) {
  const {
    tenantId, siteId, zones, entryPointIds, departmentIds, cameraIds,
    minConfidence, tz,
  } = filters;
  const clauses = [`ap.tenant_id = $${push(params, tenantId)}::uuid`, `ap.fk_employee_id IS NOT NULL`];

  if (siteId) {
    clauses.push(`(fd.site_id = $${push(params, Number(siteId))} OR EXISTS (SELECT 1 FROM site_device_assignment s WHERE s.device_id = fd.pk_device_id AND s.is_active = TRUE AND s.site_id = $${params.length}))`);
  }
  if (!ignoreZones && Array.isArray(zones) && zones.length) {
    clauses.push(`${RESOLVED_ZONE} = ANY($${push(params, zones)}::text[])`);
  }
  if (Array.isArray(entryPointIds) && entryPointIds.length) {
    clauses.push(`ap.device_code = ANY($${push(params, entryPointIds)}::text[])`);
  }
  if (Array.isArray(cameraIds) && cameraIds.length) {
    clauses.push(`ap.device_code = ANY($${push(params, cameraIds)}::text[])`);
  }
  if (Array.isArray(departmentIds) && departmentIds.length) {
    clauses.push(`he.fk_department_id = ANY($${push(params, departmentIds.map(Number))}::bigint[])`);
  }
  if (minConfidence !== null && minConfidence !== undefined) {
    clauses.push(`ap.confidence >= $${push(params, Number(minConfidence))}`);
  }
  const { clauses: dateOnly, tzIdx } = dateClauses('ap.occurred_at', filters, params, tz);
  clauses.push(...dateOnly);
  const trc = timeRangeClause('ap.occurred_at', filters, params, tzIdx);
  if (trc) clauses.push(trc);
  return clauses.join(' AND ');
}

/**
 * One row per in-scope device, with its resolved zone, for the feed branches that
 * start from a device (unknown faces, offline cameras, registered visitors). The
 * device-level filters (tenant, site, zone, entrance, camera) are applied once here
 * on ~15 rows instead of once per event row on 400k+.
 */
function deviceMapCTE(filters, params) {
  const { tenantId, siteId, zones, entryPointIds, cameraIds } = filters;
  const clauses = [`fd.tenant_id = $${push(params, tenantId)}::uuid`];
  if (siteId) {
    const idx = push(params, Number(siteId));
    clauses.push(`(fd.site_id = $${idx} OR EXISTS (
      SELECT 1 FROM site_device_assignment sda
      WHERE sda.device_id = fd.pk_device_id AND sda.is_active = TRUE AND sda.site_id = $${idx}))`);
  }
  if (Array.isArray(zones) && zones.length) {
    clauses.push(`${DEVICE_ZONE} = ANY($${push(params, zones)}::text[])`);
  }
  if (Array.isArray(entryPointIds) && entryPointIds.length) {
    clauses.push(`fd.external_device_id = ANY($${push(params, entryPointIds)}::text[])`);
  }
  if (Array.isArray(cameraIds) && cameraIds.length) {
    clauses.push(`fd.external_device_id = ANY($${push(params, cameraIds)}::text[])`);
  }
  return `dev AS (
    SELECT DISTINCT ON (fd.pk_device_id) fd.pk_device_id, fd.name, fd.external_device_id, ${DEVICE_ZONE} AS zone
    FROM facility_device fd
    ${FEED_DEVICE_JOIN}
    WHERE ${clauses.join(' AND ')}
    ORDER BY fd.pk_device_id, ${DEVICE_ZONE}
  )`;
}

/** Date + time-interval clauses for an event timestamp of a device-derived feed branch. */
function eventTimeFilters(filters, params, tsExpr) {
  const { clauses: dateOnly, tzIdx } = dateClauses(tsExpr, filters, params, filters.tz);
  const clauses = [...dateOnly];
  const trc = timeRangeClause(tsExpr, filters, params, tzIdx);
  if (trc) clauses.push(trc);
  return clauses.length ? clauses.join(' AND ') : 'TRUE';
}

// ── Req 2.1 / 2.2 / 2.3 / 2.6 — filter-list queries ─────────────────────────

// A camera: non-decommissioned facility_device with camera_mode set and no child devices.
const CAMERA_PREDICATE = `
  fd.decommissioned_at IS NULL
  AND fd.camera_mode IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM facility_device child
    WHERE child.parent_device_id = fd.pk_device_id AND child.decommissioned_at IS NULL
  )
`;

function siteClauseFor(alias, params, siteId) {
  if (!siteId) return '';
  const idx = push(params, Number(siteId));
  return `AND (${alias}.site_id = $${idx} OR EXISTS (
      SELECT 1 FROM site_device_assignment sda2
      WHERE sda2.device_id = ${alias}.pk_device_id AND sda2.site_id = $${idx} AND sda2.is_active = TRUE
    ))`;
}

/**
 * Zones with per-zone live headcount, peak and entries (Req 2.1, 7.1, 8.1).
 * Live headcount is always "now"; peak/entries follow the optional range
 * (default: today). Only zones whose devices recorded activity in the last 90
 * days are listed, so the dropdown never offers a zone with nothing behind it.
 */
export async function listZones({ tenantId, siteId, fromDate, toDate, tz }) {
  const params = [tenantId];
  const siteFilter = siteClauseFor('fd', params, siteId);
  const names = pool.query(`
    SELECT DISTINCT ${DEVICE_ZONE} AS zone, COALESCE(NULLIF(fd.zone_type, ''), 'unassigned') AS zone_type
    FROM facility_device fd
    ${DEVICE_ZONE_JOIN}
    WHERE fd.tenant_id = $1::uuid
      AND fd.decommissioned_at IS NULL
      AND EXISTS (
        SELECT 1 FROM attendance_ping ap0
        WHERE ap0.tenant_id = fd.tenant_id AND ap0.device_code = fd.external_device_id
          AND ap0.occurred_at >= NOW() - interval '90 days'
      )
      ${siteFilter}
    ORDER BY 1
  `, params);

  const today = localToday(tz);
  const filters = { tenantId, siteId, fromDate: fromDate || today, toDate: toDate || today, tz };
  const mParams = [];
  const cte = visitPairsCTE(filters, mParams);
  const tzIdx = push(mParams, tz || 'UTC');
  const metrics = pool.query(`
    ${cte},
    ${sweepCTE(true)},
    per_zone AS (
      SELECT zone, MAX(occ)::int AS peak FROM running GROUP BY zone
    ),
    live AS (
      SELECT zone, COUNT(*) FILTER (WHERE next_at IS NULL AND entered_at >= ${todayStartSql(tzIdx)})::int AS live,
             COUNT(*)::int AS entries
      FROM visits GROUP BY zone
    )
    SELECT l.zone, l.live, l.entries, COALESCE(p.peak, 0) AS peak
    FROM live l LEFT JOIN per_zone p ON p.zone = l.zone
  `, mParams);

  const [nameRes, metricRes] = await Promise.all([names, metrics]);
  const byZone = new Map((metricRes.rows || []).map((r) => [r.zone, r]));
  const seen = new Set();
  const out = [];
  for (const r of nameRes.rows || []) {
    if (!r.zone || seen.has(r.zone)) continue;
    seen.add(r.zone);
    const m = byZone.get(r.zone);
    out.push({
      zone: r.zone,
      zoneType: r.zone_type,
      siteId: siteId ?? null,
      liveHeadcount: Number(m?.live ?? 0),
      peak: Number(m?.peak ?? 0),
      entries: Number(m?.entries ?? 0),
    });
  }
  return out;
}

export async function listEntryPoints({ tenantId, siteId, zone }) {
  const params = [tenantId];
  let siteFilter = '';
  if (siteId) {
    params.push(Number(siteId));
    siteFilter = `AND (fd.site_id = $${params.length} OR EXISTS (SELECT 1 FROM site_device_assignment s WHERE s.device_id = fd.pk_device_id AND s.is_active = TRUE AND s.site_id = $${params.length}))`;
  }
  let zoneFilter = '';
  if (zone) {
    params.push(zone);
    zoneFilter = `AND ${RESOLVED_ZONE} = $${params.length}`;
  }
  // Distinct devices first (a handful of rows), then the device joins: same result as
  // DISTINCT over the joined 36k pings, without joining every ping.
  const { rows } = await pool.query(`
    WITH ap AS (
      SELECT DISTINCT tenant_id, device_code FROM attendance_ping
      WHERE tenant_id = $1::uuid AND device_code IS NOT NULL
    )
    SELECT DISTINCT ap.device_code AS device_id,
      COALESCE(fd.name, ap.device_code) AS device_label,
      ${RESOLVED_ZONE} AS zone
    FROM ap
    ${ZONE_JOIN}
    WHERE ${ENTRY_ROLE} IS NOT NULL
      ${siteFilter}
      ${zoneFilter}
    ORDER BY 2
  `, params);
  return rows.map((r) => ({ deviceId: r.device_id, deviceLabel: r.device_label, zone: r.zone }));
}

export async function listDepartments({ tenantId }) {
  const { rows } = await pool.query(`
    SELECT pk_department_id AS department_id, name
    FROM hr_department
    WHERE tenant_id = $1::uuid
    ORDER BY name
  `, [tenantId]);
  return rows.map((r) => ({ departmentId: Number(r.department_id), name: r.name }));
}

/**
 * Req 2.6 — camera filter list. In this schema the device that records a ping IS
 * the entrance, so a camera's entrance is its own display name (there is no
 * separate entrance entity to join to); zone uses the standard resolution order.
 */
export async function listCameras({ tenantId, siteId }) {
  const params = [tenantId];
  const siteFilter = siteClauseFor('fd', params, siteId);
  const { rows } = await pool.query(`
    SELECT DISTINCT fd.external_device_id AS camera_id, fd.name AS name,
      fd.name AS entrance, ${DEVICE_ZONE} AS zone
    FROM facility_device fd
    ${DEVICE_ZONE_JOIN}
    WHERE fd.tenant_id = $1::uuid
      AND ${CAMERA_PREDICATE}
      ${siteFilter}
    ORDER BY 2
  `, params);
  return rows.map((r) => ({ cameraId: r.camera_id, name: r.name, entrance: r.entrance, zone: r.zone }));
}

/** Cameras online / total for the Overview tile (computed, never hardcoded). */
export async function getCameraCounts({ tenantId, siteId }) {
  const params = [tenantId];
  const siteFilter = siteClauseFor('fd', params, siteId);
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE fd.status = 'online')::int AS online
    FROM facility_device fd
    WHERE fd.tenant_id = $1::uuid
      AND ${CAMERA_PREDICATE}
      ${siteFilter}
  `, params);
  return { online: rows[0]?.online ?? 0, total: rows[0]?.total ?? 0 };
}

// ── Shared CTEs ─────────────────────────────────────────────────────────────

/**
 * Paired entry -> next-exit visits for one employee within one zone and local
 * day, ordered by time. `exited_at` is set only for a matched exit (durations);
 * `ended_at` is when the person stops counting as inside (matched exit, the
 * next entry, or the end of that local day) so an open entry from a previous
 * day is never treated as someone still inside (Req 3.6). `next_at IS NULL`
 * marks an entry with nothing after it.
 */
function visitPairsCTE(filters, params) {
  const where = buildFilters(filters, params);
  const tzIdx = push(params, filters.tz || 'UTC');
  return `
    WITH zone_pings AS (
      SELECT ap.pk_ping_id, ap.fk_employee_id AS employee_id, he.fk_department_id AS department_id,
        ${RESOLVED_ZONE} AS zone, ap.device_code, COALESCE(fd.name, ap.device_code) AS device_label,
        ${DIR} AS direction,
        ap.confidence, ap.occurred_at,
        (ap.occurred_at AT TIME ZONE $${tzIdx})::date AS day
      FROM attendance_ping ap
      ${ZONE_JOIN}
      ${EMPLOYEE_JOIN}
      WHERE ${where}
    ),
    paired AS (
      SELECT employee_id, department_id, zone, device_code, occurred_at AS entered_at,
        direction,
        LEAD(occurred_at) OVER (PARTITION BY employee_id, zone, day ORDER BY occurred_at) AS next_at,
        LEAD(direction) OVER (PARTITION BY employee_id, zone, day ORDER BY occurred_at) AS next_direction
      FROM zone_pings
    ),
    visits AS (
      SELECT employee_id, department_id, zone, device_code, entered_at, next_at,
        CASE WHEN next_direction = 'exit' THEN next_at ELSE NULL END AS exited_at,
        COALESCE(next_at, ((date_trunc('day', entered_at AT TIME ZONE $${tzIdx}) + interval '1 day') AT TIME ZONE $${tzIdx})) AS ended_at
      FROM paired
      WHERE direction = 'entry' OR direction = '' OR direction IS NULL
    )
  `;
}

/** Occupancy sweep: +1 at each entry, -1 when the person stops counting as inside. */
function sweepCTE(perZone) {
  return `
    sweep AS (
      SELECT zone, entered_at AS t, 1 AS d FROM visits WHERE ended_at > entered_at
      UNION ALL
      SELECT zone, ended_at AS t, -1 AS d FROM visits WHERE ended_at > entered_at
    ),
    running AS (
      SELECT zone, t, d, SUM(d) OVER (${perZone ? 'PARTITION BY zone ' : ''}ORDER BY t, d) AS occ FROM sweep
    )
  `;
}

const minutesBetween = (a, b) => `EXTRACT(EPOCH FROM (${b} - ${a})) / 60.0`;

// ── Req 3.1 / 3.2 — occupancy & traffic ─────────────────────────────────────

export async function getOccupancy(filters) {
  const params = [];
  const cte = visitPairsCTE(filters, params);
  const tzIdx = push(params, filters.tz || 'UTC');
  const { rows } = await pool.query(`
    ${cte},
    ${sweepCTE(false)}
    SELECT
      CASE WHEN EXISTS (SELECT 1 FROM visits)
        THEN (SELECT COUNT(*) FROM visits WHERE next_at IS NULL AND entered_at >= ${todayStartSql(tzIdx)})::int
        ELSE NULL END AS current_occupancy,
      MAX(occ)::int AS peak_occupancy,
      ROUND(AVG(occ) FILTER (WHERE d = 1))::int AS average_occupancy,
      MIN(occ) FILTER (WHERE d = 1 AND occ > 0)::int AS lowest_occupancy
    FROM running
  `, params);
  const row = rows[0] || { current_occupancy: null, peak_occupancy: null, average_occupancy: null, lowest_occupancy: null };
  // A historic range says nothing about who is inside right now.
  if (!rangeIncludesToday(filters)) return { ...row, current_occupancy: null };
  return row;
}

const SERIES_BUCKET = {
  hour: { trunc: 'hour', fmt: `'YYYY-MM-DD"T"HH24:MI:SS'` },
  day: { trunc: 'day', fmt: `'YYYY-MM-DD'` },
  week: { trunc: 'week', fmt: `'YYYY-MM-DD'` },
};

/** Occupancy trend per zone: peak concurrent occupancy per bucket (Req 3.2, 6.3). */
export async function getOccupancySeries(filters, granularity = 'hour') {
  const b = SERIES_BUCKET[granularity] || SERIES_BUCKET.hour;
  const params = [];
  const cte = visitPairsCTE(filters, params);
  const tzIdx = push(params, filters.tz || 'UTC');
  const { rows } = await pool.query(`
    ${cte},
    ${sweepCTE(true)}
    SELECT to_char(date_trunc('${b.trunc}', t AT TIME ZONE $${tzIdx}), ${b.fmt}) AS ts, zone, MAX(occ)::int AS count
    FROM running
    WHERE t <= NOW()
    GROUP BY 1, 2
    ORDER BY 1, 2
  `, params);
  return rows.map((r) => ({ ts: r.ts, zone: r.zone, count: r.count }));
}

export async function getTraffic(filters) {
  const params = [];
  const where = buildFilters(filters, params);
  const tzIdx = push(params, filters.tz || 'UTC');
  const { rows } = await pool.query(`
    WITH zone_pings AS (
      SELECT ${DIR} AS direction, ap.occurred_at
      FROM attendance_ping ap
      ${ZONE_JOIN}
      ${EMPLOYEE_JOIN}
      WHERE ${where}
    )
    SELECT
      to_char(date_trunc('hour', occurred_at AT TIME ZONE $${tzIdx}), 'YYYY-MM-DD"T"HH24:MI:SS') AS ts,
      COUNT(*) FILTER (WHERE direction = 'entry')::int AS entries,
      COUNT(*) FILTER (WHERE direction = 'exit')::int AS exits
    FROM zone_pings
    GROUP BY 1 ORDER BY 1
  `, params);

  const totalEntries = rows.reduce((s, r) => s + r.entries, 0);
  const totalExits = rows.reduce((s, r) => s + r.exits, 0);
  const peakTraffic = rows.reduce((max, r) => Math.max(max, r.entries + r.exits), 0);
  return {
    totalEntries, totalExits, peakTraffic,
    series: rows.map((r) => ({ ts: r.ts, entries: r.entries, exits: r.exits })),
  };
}

export async function getUniqueEmployees(filters) {
  const params = [];
  const where = buildFilters(filters, params);
  const { rows } = await pool.query(`
    SELECT COUNT(DISTINCT ap.fk_employee_id)::int AS unique_employees
    FROM attendance_ping ap
    ${ZONE_JOIN}
    ${EMPLOYEE_JOIN}
    WHERE ${where}
  `, params);
  return rows[0]?.unique_employees ?? 0;
}

/**
 * Occupancy now vs one hour earlier, both from TODAY's pings (Req 6.1). The
 * caller supplies the shared filters; the date range is forced to today.
 */
export async function getHeadcountTrend(filters) {
  const today = localToday(filters.tz);
  const f = { ...filters, fromDate: today, toDate: today };
  const params = [];
  const cte = visitPairsCTE(f, params);
  const { rows } = await pool.query(`
    ${cte},
    ${sweepCTE(false)}
    SELECT
      (SELECT occ FROM running WHERE t <= NOW() ORDER BY t DESC, d DESC LIMIT 1)::int AS now_count,
      (SELECT occ FROM running WHERE t <= NOW() - interval '1 hour' ORDER BY t DESC, d DESC LIMIT 1)::int AS hour_ago_count
  `, params);
  const nowCount = rows[0]?.now_count ?? 0;
  const hourAgo = rows[0]?.hour_ago_count ?? 0;
  // Minutes elapsed in the local day: "—" for the first hour (Req 6.1).
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: filters.tz || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date());
  const minutesIntoDay = Number(parts.find((p) => p.type === 'hour')?.value) * 60 + Number(parts.find((p) => p.type === 'minute')?.value);
  return { now: nowCount, hourAgo, minutesIntoDay };
}

// ── Req 3.3 — day x hour temporal heatmap ───────────────────────────────────

export async function getHeatmap(filters) {
  const params = [];
  const where = buildFilters(filters, params);
  const tzIdx = push(params, filters.tz || 'UTC');
  const { rows } = await pool.query(`
    SELECT
      EXTRACT(DOW FROM (ap.occurred_at AT TIME ZONE $${tzIdx}))::int AS dow,
      EXTRACT(HOUR FROM (ap.occurred_at AT TIME ZONE $${tzIdx}))::int AS hour,
      COUNT(*)::int AS count
    FROM attendance_ping ap
    ${ZONE_JOIN}
    ${EMPLOYEE_JOIN}
    WHERE ${where}
    GROUP BY 1, 2
    ORDER BY 1, 2
  `, params);
  const maxCell = rows.reduce((m, r) => Math.max(m, r.count), 0);
  return {
    maxCell,
    // pctOfPeak = share of the observed busiest cell (never a capacity).
    cells: rows.map((r) => ({
      dow: r.dow, hour: r.hour, count: r.count,
      pctOfPeak: maxCell > 0 ? Math.round((r.count / maxCell) * 100) : 0,
    })),
  };
}

/**
 * Hour-of-day profile for Peak Hours & Traffic (Req 3.7): traffic, average and
 * peak occupancy per hour, per-zone entries/exits per hour and the moment of
 * peak headcount. Nothing here is a hardcoded hour.
 */
export async function getHourlyProfile(filters) {
  // ONE query: per-zone hourly traffic (from zone_pings), hourly occupancy and the peak
  // moment (from the visits sweep) all come from the same paired-visit CTE, tagged by kind.
  const params = [];
  const cte = visitPairsCTE(filters, params);
  const tzIdx = push(params, filters.tz || 'UTC');
  const { rows } = await pool.query(`
    ${cte},
    ${sweepCTE(false)},
    traffic AS (
      SELECT zone, EXTRACT(HOUR FROM (occurred_at AT TIME ZONE $${tzIdx}))::int AS hour,
        COUNT(*) FILTER (WHERE direction = 'entry')::int AS entries,
        COUNT(*) FILTER (WHERE direction = 'exit')::int AS exits
      FROM zone_pings GROUP BY 1, 2
    ),
    occ AS (
      SELECT EXTRACT(HOUR FROM (t AT TIME ZONE $${tzIdx}))::int AS hour,
        ROUND(AVG(occ))::int AS avg_occ, MAX(occ)::int AS peak_occ
      FROM running WHERE t <= NOW() GROUP BY 1
    ),
    moment AS (
      SELECT t, occ::int AS occ FROM running WHERE t <= NOW() ORDER BY occ DESC, t ASC LIMIT 1
    )
    SELECT 'traffic' AS kind, zone, hour, entries, exits, NULL::int AS avg_occ, NULL::int AS peak_occ, NULL::timestamptz AS t, NULL::int AS occ FROM traffic
    UNION ALL
    SELECT 'occ', NULL, hour, NULL, NULL, avg_occ, peak_occ, NULL, NULL FROM occ
    UNION ALL
    SELECT 'moment', NULL, NULL, NULL, NULL, NULL, NULL, t, occ FROM moment
  `, params);
  const traffic = { rows: rows.filter((r) => r.kind === 'traffic') };
  const occ = { rows: rows.filter((r) => r.kind === 'occ') };
  const moment = { rows: rows.filter((r) => r.kind === 'moment') };
  const hours = new Map();
  const byZone = [];
  for (const r of traffic.rows) {
    byZone.push({ zone: r.zone, hour: r.hour, entries: r.entries, exits: r.exits });
    const h = hours.get(r.hour) || { hour: r.hour, entries: 0, exits: 0, traffic: 0, avgOccupancy: 0, peakOccupancy: 0 };
    h.entries += r.entries;
    h.exits += r.exits;
    h.traffic = h.entries + h.exits;
    hours.set(r.hour, h);
  }
  for (const r of occ.rows) {
    const h = hours.get(r.hour) || { hour: r.hour, entries: 0, exits: 0, traffic: 0, avgOccupancy: 0, peakOccupancy: 0 };
    h.avgOccupancy = r.avg_occ ?? 0;
    h.peakOccupancy = r.peak_occ ?? 0;
    hours.set(r.hour, h);
  }
  const m = moment.rows[0];
  return {
    hourly: [...hours.values()].sort((x, y) => x.hour - y.hour),
    byZone,
    peakMoment: m ? { at: m.t, count: m.occ } : null,
  };
}

// ── Req 3.4 — entry-point-wise traffic ──────────────────────────────────────

export async function getEntryPointTraffic(filters) {
  const params = [];
  const where = buildFilters(filters, params);
  const tzIdx = push(params, filters.tz || 'UTC');
  const { rows } = await pool.query(`
    WITH zone_pings AS (
      SELECT ap.device_code, COALESCE(fd.name, ap.device_code) AS device_label,
        ${DIR} AS direction,
        ap.fk_employee_id,
        EXTRACT(HOUR FROM (ap.occurred_at AT TIME ZONE $${tzIdx}))::int AS hour
      FROM attendance_ping ap
      ${ZONE_JOIN}
      ${EMPLOYEE_JOIN}
      WHERE ${where}
    ),
    per_device AS (
      SELECT device_code, MAX(device_label) AS device_label,
        COUNT(*) FILTER (WHERE direction = 'entry')::int AS entries,
        COUNT(*) FILTER (WHERE direction = 'exit')::int AS exits,
        COUNT(DISTINCT fk_employee_id)::int AS unique_employees
      FROM zone_pings GROUP BY device_code
    ),
    peak AS (
      SELECT device_code, hour, COUNT(*)::int AS cnt
      FROM zone_pings GROUP BY device_code, hour
    ),
    peak_per_device AS (
      SELECT DISTINCT ON (device_code) device_code, hour AS peak_hour, cnt
      FROM peak ORDER BY device_code, cnt DESC, hour ASC
    ),
    total AS (
      SELECT SUM(entries + exits)::numeric AS grand_total FROM per_device
    )
    SELECT d.device_code, d.device_label, d.entries, d.exits, d.unique_employees,
      p.peak_hour AS peak_hour,
      CASE WHEN t.grand_total > 0
        THEN ROUND(((d.entries + d.exits)::numeric / t.grand_total) * 100, 2)
        ELSE 0 END AS contribution_pct
    FROM per_device d
    LEFT JOIN peak_per_device p ON p.device_code = d.device_code
    CROSS JOIN total t
    ORDER BY (d.entries + d.exits) DESC
  `, params);
  return rows.map((r) => ({
    deviceId: r.device_code,
    deviceLabel: r.device_label,
    entries: r.entries,
    exits: r.exits,
    net: r.entries - r.exits,
    uniqueEmployees: r.unique_employees,
    contributionPct: Number(r.contribution_pct),
    peakActivity: r.peak_hour,
  }));
}

// ── Req 3.7 / 6.4 — department-wise zone distribution ──────────────────────

export async function getDepartmentDistribution(filters) {
  const params = [];
  const cte = visitPairsCTE(filters, params);
  const { rows } = await pool.query(`
    ${cte}
    SELECT d.pk_department_id AS department_id, d.name,
      COUNT(DISTINCT v.employee_id)::int AS employees_detected,
      COUNT(*)::int AS visits,
      AVG(${minutesBetween('v.entered_at', 'v.exited_at')}) FILTER (WHERE v.exited_at IS NOT NULL) AS avg_time_spent_minutes
    FROM visits v
    JOIN hr_department d ON d.pk_department_id = v.department_id
    GROUP BY d.pk_department_id, d.name
    ORDER BY visits DESC, d.name
  `, params);
  const totalVisits = rows.reduce((s, r) => s + r.visits, 0);
  return rows.map((r) => ({
    departmentId: Number(r.department_id),
    name: r.name,
    employeesDetected: r.employees_detected,
    visits: r.visits,
    avgTimeSpentMinutes: r.avg_time_spent_minutes === null ? null : Math.round(Number(r.avg_time_spent_minutes)),
    trafficPct: totalVisits > 0 ? Number(((r.visits / totalVisits) * 100).toFixed(2)) : 0,
  }));
}

// ── Req 3.5 / 3.6 — visits, average time inside, duration histogram ────────

export async function getVisits(filters) {
  const params = [];
  const cte = visitPairsCTE(filters, params);
  const { rows } = await pool.query(`
    ${cte},
    matched AS (
      SELECT * FROM visits WHERE exited_at IS NOT NULL
    ),
    durations AS (
      SELECT employee_id, entered_at, ${minutesBetween('entered_at', 'exited_at')} AS minutes
      FROM matched
    ),
    per_employee_day AS (
      SELECT employee_id, entered_at::date AS day, SUM(minutes) AS total_minutes
      FROM durations GROUP BY employee_id, entered_at::date
    )
    SELECT
      (SELECT COUNT(*) FROM visits)::int AS total_visits,
      (SELECT COUNT(DISTINCT employee_id) FROM visits)::int AS unique_visitors,
      (SELECT COALESCE(SUM(cnt - 1), 0) FROM (
        SELECT employee_id, COUNT(*) AS cnt FROM visits GROUP BY employee_id HAVING COUNT(*) > 1
      ) rep)::int AS repeat_visits,
      (SELECT AVG(minutes) FROM durations)::numeric AS avg_visit_duration_minutes,
      (SELECT AVG(total_minutes) FROM per_employee_day)::numeric AS avg_time_inside_minutes,
      (SELECT CASE WHEN COUNT(DISTINCT employee_id) > 0
        THEN (COUNT(*)::numeric / COUNT(DISTINCT employee_id)) ELSE 0 END FROM visits)::numeric AS avg_visits_per_employee
  `, params);
  const r = rows[0] || {};
  const rounded = (v) => (v === null || v === undefined ? null : Math.round(Number(v)));
  return {
    totalVisits: r.total_visits || 0,
    uniqueVisitors: r.unique_visitors || 0,
    repeatVisits: r.repeat_visits || 0,
    avgVisitsPerEmployee: Number(r.avg_visits_per_employee || 0),
    avgVisitDurationMinutes: rounded(r.avg_visit_duration_minutes),
    avgTimeInsideMinutes: rounded(r.avg_time_inside_minutes),
  };
}

const TIME_SPENT_BUCKETS = [
  { bucket: '<1h', min: 0, max: 60 },
  { bucket: '1-3h', min: 60, max: 180 },
  { bucket: '3-6h', min: 180, max: 360 },
  { bucket: '6-9h', min: 360, max: 540 },
  { bucket: '>9h', min: 540, max: Infinity },
];

export async function getTimeSpentBuckets(filters) {
  const params = [];
  const cte = visitPairsCTE(filters, params);
  const { rows } = await pool.query(`
    ${cte}
    SELECT ${minutesBetween('entered_at', 'exited_at')} AS minutes
    FROM visits WHERE exited_at IS NOT NULL
  `, params);
  const counts = TIME_SPENT_BUCKETS.map((b) => ({ bucket: b.bucket, count: 0 }));
  for (const row of rows) {
    const idx = TIME_SPENT_BUCKETS.findIndex((b) => row.minutes >= b.min && row.minutes < b.max);
    if (idx >= 0) counts[idx].count += 1;
  }
  const total = counts.reduce((s, c) => s + c.count, 0);
  return counts.map((c) => ({ ...c, pct: total > 0 ? Number(((c.count / total) * 100).toFixed(1)) : 0 }));
}

// ── Req 5 / 4 — unified events feed (Entry / Exit / Unknown Face / Camera Offline / registered visitor) ──

const EVENT_TYPES = ['entry', 'exit', 'unknown_face', 'camera_offline'];
const EVENT_STATUSES = ['verified', 'unrecognized', 'system'];
// AC 5.6: person-type selector of Recent Zone Activity.
const PERSON_TYPES = ['all', 'employee', 'visitor'];
// Event type of a registered-visitor detection (device_events FACE_DETECTED of a
// person whose person_type is 'visitor'). It is not a filterable type of its own:
// it is reached through personType=visitor (or All).
const VISITOR_EVENT_TYPE = 'visitor_detected';
export { EVENT_TYPES, EVENT_STATUSES, PERSON_TYPES, VISITOR_EVENT_TYPE };

const escapeLike = (s) => String(s).replace(/[\\%_]/g, '\\$&');

/**
 * Which UNION branches can satisfy the selection (AC 5.3, 5.6, 3.9c).
 *  ping     = Entry/Exit rows (attendance_ping)      -> the Employees group
 *  unknown  = Unknown Face rows (unauthorized_access_log) -> Visitors group
 *  visitor  = registered-visitor detections (device_events + person) -> Visitors group
 *  offline  = Camera Offline rows (device_status_history) -> only under All
 */
function feedBranches({ eventType, status, securityOnly, personType }) {
  let branches = ['ping', 'unknown', 'offline', 'visitor'];
  if (personType === 'employee') branches = branches.filter((b) => b === 'ping');
  if (personType === 'visitor') branches = branches.filter((b) => b === 'unknown' || b === 'visitor');
  // "Only unknown-face and camera-offline events": a registered visitor is neither.
  if (securityOnly) branches = branches.filter((b) => b === 'unknown' || b === 'offline');
  if (eventType) {
    const allowed = { entry: 'ping', exit: 'ping', unknown_face: 'unknown', camera_offline: 'offline', [VISITOR_EVENT_TYPE]: 'visitor' }[eventType];
    branches = branches.filter((b) => b === allowed);
  }
  if (status) {
    const allowed = { verified: ['ping', 'visitor'], unrecognized: ['unknown'], system: ['offline'] }[status] || [];
    branches = branches.filter((b) => allowed.includes(b));
  }
  return branches;
}

function feedCTE(filters, opts, params) {
  const branches = feedBranches({ eventType: opts.eventType, status: opts.status, securityOnly: filters.securityOnly, personType: opts.personType });
  const parts = [];
  if (branches.includes('ping')) {
    const where = buildFilters(filters, params);
    let typeFilter = '';
    if (opts.eventType === 'entry' || opts.eventType === 'exit') typeFilter = `AND ${DIR} = $${push(params, opts.eventType)}`;
    parts.push(`
      SELECT 'p' || ap.pk_ping_id::text AS id, ap.pk_ping_id AS ping_id, ap.occurred_at AS ts, ${DIR} AS event_type,
        ap.fk_employee_id AS employee_id, he.employee_code::text AS employee_code, he.full_name::text AS employee_name,
        COALESCE(fd.name, ap.device_code)::text AS entrance, ${RESOLVED_ZONE}::text AS zone,
        'verified'::text AS status, ap.confidence::float8 AS confidence, ap.device_code::text AS camera_id,
        NULL::text AS details, NULL::text AS image_url
      FROM attendance_ping ap
      ${ZONE_JOIN}
      ${EMPLOYEE_JOIN}
      WHERE ${where} ${typeFilter}`);
  }
  if (branches.includes('unknown')) {
    const where = eventTimeFilters(filters, params, 'u.event_timestamp');
    parts.push(`
      SELECT 'u' || u.pk_log_id::text AS id, NULL::bigint AS ping_id, u.event_timestamp AS ts, 'unknown_face'::text AS event_type,
        NULL::bigint AS employee_id, NULL::text AS employee_code, NULL::text AS employee_name,
        fd.name::text AS entrance, fd.zone::text AS zone,
        'unrecognized'::text AS status, NULLIF(u.confidence_score, 0)::float8 AS confidence, fd.external_device_id::text AS camera_id,
        'Visitor (unregistered)'::text AS details, u.image_url::text AS image_url
      FROM unauthorized_access_log u
      JOIN dev fd ON fd.pk_device_id::text = u.device_id
      WHERE ${where}`);
  }
  if (branches.includes('offline')) {
    const where = eventTimeFilters(filters, params, 'h.changed_at');
    parts.push(`
      SELECT 'o' || h.pk_history_id::text AS id, NULL::bigint AS ping_id, h.changed_at AS ts, 'camera_offline'::text AS event_type,
        NULL::bigint AS employee_id, NULL::text AS employee_code, NULL::text AS employee_name,
        fd.name::text AS entrance, fd.zone::text AS zone,
        'system'::text AS status, NULL::float8 AS confidence, fd.external_device_id::text AS camera_id,
        'Camera stopped responding'::text AS details, NULL::text AS image_url
      FROM device_status_history h
      JOIN dev fd ON fd.pk_device_id = h.device_id
      WHERE h.new_status = 'offline' AND ${where}`);
  }
  if (branches.includes('visitor')) {
    // Registered visitors: person.person_type = 'visitor' (none exist today; rows appear once
    // visitors are registered or converted). Scope comes from the device map (tenant/site via
    // facility_device on the device code), like the other device-derived branches.
    const tenantIdx = push(params, filters.tenantId);
    const where = eventTimeFilters(filters, params, 'de.occurred_at');
    parts.push(`
      SELECT 'v' || de.pk_event_id::text AS id, NULL::bigint AS ping_id, de.occurred_at AS ts, '${VISITOR_EVENT_TYPE}'::text AS event_type,
        NULL::bigint AS employee_id, NULL::text AS employee_code, NULL::text AS employee_name,
        fd.name::text AS entrance, fd.zone::text AS zone,
        'verified'::text AS status, de.confidence_score::float8 AS confidence, fd.external_device_id::text AS camera_id,
        ('Registered visitor: ' || COALESCE(p.full_name, ''))::text AS details, NULL::text AS image_url
      FROM person p
      JOIN device_events de ON de.fk_person_id = p.person_id AND de.event_type = 'FACE_DETECTED'
      JOIN dev fd ON fd.external_device_id = de.device_code
      WHERE p.person_type = 'visitor' AND p.tenant_id = $${tenantIdx}::uuid AND ${where}`);
  }
  if (!parts.length) return null;
  const needsDevices = branches.some((b) => b !== 'ping');
  return `${needsDevices ? deviceMapCTE(filters, params) + ',\n  ' : ''}feed AS (${parts.join('\n      UNION ALL\n')}
  )`;
}

function feedSearch(q, params) {
  if (!q) return '';
  const idx = push(params, `%${escapeLike(q)}%`);
  return `AND (COALESCE(employee_name, '') ILIKE $${idx} OR COALESCE(employee_code, '') ILIKE $${idx}
      OR COALESCE(zone, '') ILIKE $${idx} OR COALESCE(entrance, '') ILIKE $${idx}
      OR COALESCE(camera_id, '') ILIKE $${idx} OR COALESCE(details, '') ILIKE $${idx}
      OR REPLACE(event_type, '_', ' ') ILIKE $${idx})`;
}

function feedSql({ feed, search, limitIdx, offsetIdx }) {
  // COUNT(*) OVER () is the total of the filtered feed: one run of the feed CTE instead of two.
  return `
    WITH ${feed}
    SELECT *, COUNT(*) OVER ()::int AS total_count FROM feed WHERE TRUE ${search}
    ORDER BY ts DESC, id DESC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;
}

/**
 * Real, filtered, paginated events. Unknown faces are 419k rows in the live
 * data, so branches that cannot match the selection are left out of the UNION;
 * pagination and the total are done in SQL with ONE query (COUNT(*) OVER ()).
 * Photos are opt-in (`withPhotos`, AC 12.3): the device_events photo match costs
 * ~2 s and no list view shows it, so a list load never runs it. Unknown-face rows
 * keep their own image_url (no extra query).
 */
export async function getRecentEvents(filters, { page = 1, pageSize = 20, eventType, status, q, personType, withPhotos = false } = {}) {
  const params = [];
  const feed = feedCTE(filters, { eventType, status, personType }, params);
  if (!feed) return { rows: [], total: 0 };
  const search = feedSearch(q, params);
  const limitIdx = push(params, pageSize);
  const offsetIdx = push(params, (page - 1) * pageSize);
  const { rows } = await pool.query(feedSql({ feed, search, limitIdx, offsetIdx }), params);
  let total = rows[0]?.total_count ?? 0;

  if (!rows.length && page > 1) {
    // Page past the end: the window count has no row to ride on, so ask for the first row.
    const cParams = [];
    const cFeed = feedCTE(filters, { eventType, status, personType }, cParams);
    const cSearch = feedSearch(q, cParams);
    const cLimit = push(cParams, 1);
    const cOffset = push(cParams, 0);
    const { rows: first } = await pool.query(feedSql({ feed: cFeed, search: cSearch, limitIdx: cLimit, offsetIdx: cOffset }), cParams);
    total = first[0]?.total_count ?? 0;
  }

  const photoByPing = withPhotos ? await matchEventPhotos(rows.filter((r) => r.ping_id)) : new Map();
  const cutoff = Date.now() - PHOTO_RETENTION_DAYS * 86400000;
  return {
    rows: rows.map((r) => ({
      id: r.id,
      timestamp: r.ts,
      eventType: r.event_type,
      employeeId: r.employee_id === null || r.employee_id === undefined ? null : Number(r.employee_id),
      employeeCode: r.employee_code ?? null,
      employeeName: r.employee_name ?? null,
      entrance: r.entrance,
      zone: r.zone,
      recognitionStatus: r.status,
      confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
      cameraId: r.camera_id,
      details: r.details,
      // Unknown-face rows carry their own image_url; it only passes the /uploads
      // ownership gate while its device_events row exists (90-day retention).
      photoUrl: r.event_type === 'unknown_face'
        ? (new Date(r.ts).getTime() >= cutoff ? toPhotoBasename(r.image_url) : null)
        : (photoByPing.get(String(r.ping_id)) ?? null),
    })),
    total,
  };
}

/**
 * Per-event photo match (design.md 2.1, AC 9.6). Run ONLY for one page / one
 * employee-day. Candidate device_events rows are joined with a sargable +-60 s
 * window (an unbounded ABS(...) predicate times out on 437k rows), excluding
 * replayed/stale events (event_time_raw) and requiring the same person via the
 * raw-payload key OR-list; each photo is then attached to at most one ping
 * (closest first).
 */
export async function matchEventPhotos(pingRows) {
  const result = new Map();
  const ids = [...new Set(pingRows.map((r) => r.ping_id).filter((v) => v !== null && v !== undefined))];
  if (!ids.length) return result;
  const idList = `he.employee_code, he.pk_employee_id::text, he.person_id::text`;
  const { rows } = await pool.query(`
    SELECT ap.pk_ping_id AS ping_id, de.pk_event_id AS event_id,
      de.payload_json->>'photo_url' AS photo_url,
      ABS(EXTRACT(EPOCH FROM (de.occurred_at - ap.occurred_at))) AS delta_seconds
    FROM attendance_ping ap
    JOIN hr_employee he ON he.pk_employee_id = ap.fk_employee_id
    JOIN device_events de
      ON de.tenant_id = ap.tenant_id
     AND de.device_code = ap.device_code
     AND de.event_type IN ('EMPLOYEE_ENTRY', 'EMPLOYEE_EXIT')
     AND de.occurred_at BETWEEN ap.occurred_at - interval '60 seconds' AND ap.occurred_at + interval '60 seconds'
     AND de.payload_json->>'photo_url' IS NOT NULL
     AND de.payload_json->>'event_time_raw' IS NULL
     AND (de.payload_json->>'employee_code' IN (${idList})
       OR de.payload_json->>'employeeCode' IN (${idList})
       OR de.payload_json->>'employee_id' IN (${idList})
       OR de.payload_json->>'employeeId' IN (${idList}))
    WHERE ap.pk_ping_id = ANY($1::bigint[])
    ORDER BY delta_seconds, ap.pk_ping_id
  `, [ids]);
  const usedEvents = new Set();
  for (const r of rows) {
    const key = String(r.ping_id);
    if (result.has(key) || usedEvents.has(String(r.event_id))) continue;
    const name = toPhotoBasename(r.photo_url);
    if (!name) continue;
    result.set(key, name);
    usedEvents.add(String(r.event_id));
  }
  return result;
}

// ── Req 9.1-9.4 — employees list (cards + table + summary) ──────────────────

const EMPLOYEE_SORTS = {
  time: 'minutes',
  visits: 'visits',
  confidence: 'avg_conf',
  firstSeen: 'first_seen',
};
export const EMPLOYEE_STATUSES = ['all', 'currently', 'long', 'multi'];

function employeeAggCTE(filters, { q, status }, params) {
  const cte = visitPairsCTE(filters, params);
  const tzIdx = push(params, filters.tz || 'UTC');
  let where = 'TRUE';
  if (q) {
    const idx = push(params, `%${escapeLike(q)}%`);
    where += ` AND (he.full_name ILIKE $${idx} OR he.employee_code ILIKE $${idx})`;
  }
  if (status === 'currently') where += ' AND a.currently_in';
  if (status === 'long') where += ` AND a.minutes >= ${LONG_STAY_MINUTES}`;
  if (status === 'multi') where += ' AND a.zones > 1';
  return `
    ${cte},
    vagg AS (
      SELECT employee_id, COUNT(*)::int AS visits,
        COALESCE(SUM(${minutesBetween('entered_at', 'exited_at')}) FILTER (WHERE exited_at IS NOT NULL), 0) AS minutes,
        AVG(${minutesBetween('entered_at', 'exited_at')}) FILTER (WHERE exited_at IS NOT NULL) AS avg_visit
      FROM visits GROUP BY employee_id
    ),
    pagg AS (
      SELECT employee_id,
        COUNT(*) FILTER (WHERE direction = 'entry')::int AS entries,
        COUNT(*) FILTER (WHERE direction = 'exit')::int AS exits,
        AVG(confidence) AS avg_conf, MIN(occurred_at) AS first_seen, MAX(occurred_at) AS last_seen,
        COUNT(DISTINCT zone)::int AS zones,
        (ARRAY_AGG(direction ORDER BY occurred_at DESC))[1] AS last_direction
      FROM zone_pings GROUP BY employee_id
    ),
    agg AS (
      SELECT p.employee_id, p.entries, p.exits, p.avg_conf, p.first_seen, p.last_seen, p.zones,
        COALESCE(v.visits, 0) AS visits, COALESCE(v.minutes, 0) AS minutes, v.avg_visit,
        (p.last_direction = 'entry' AND p.last_seen >= ${todayStartSql(tzIdx)}) AS currently_in
      FROM pagg p LEFT JOIN vagg v ON v.employee_id = p.employee_id
    ),
    filtered AS (
      SELECT a.*, he.employee_code, he.full_name, he.position_title, d.name AS department
      FROM agg a
      JOIN hr_employee he ON he.pk_employee_id = a.employee_id
      LEFT JOIN hr_department d ON d.pk_department_id = he.fk_department_id
      WHERE ${where}
    )
  `;
}

export async function getEmployees(filters, { q, status, sort = 'time', dir = 'desc', page = 1, pageSize = 20 } = {}) {
  const sortCol = EMPLOYEE_SORTS[sort] || EMPLOYEE_SORTS.time;
  const sortDir = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  // ONE query (was four, in two dependent stages): the aggregation, the requested page, the
  // summary of the whole filtered set, and each page employee's per-zone minutes, recent entry
  // flow and entrance usage are all derived from the same paired-visit CTE. Entrance counts and
  // the flow are computed in SQL so the API no longer downloads every ping of the page's employees.
  const run = async (pg, size) => {
    const params = [];
    const agg = employeeAggCTE(filters, { q, status }, params);
    const limitIdx = push(params, size);
    const offsetIdx = push(params, (pg - 1) * size);
    return pool.query(`
    ${agg},
    page AS (
      SELECT * FROM filtered
      ORDER BY ${sortCol} ${sortDir} NULLS LAST, employee_id
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    ),
    summ AS (
      SELECT COUNT(*)::int AS tracked, AVG(minutes) AS mean_minutes, AVG(avg_conf) AS mean_conf,
        (ARRAY_AGG(full_name ORDER BY visits DESC, employee_id))[1] AS top_name,
        MAX(visits)::int AS top_visits
      FROM filtered
    )
    SELECT p.*, s.tracked, s.mean_minutes, s.mean_conf, s.top_name, s.top_visits,
      (SELECT COALESCE(json_agg(json_build_object('zone', v.zone, 'visits', v.visits, 'minutes', v.minutes)), '[]'::json)
         FROM (SELECT zone, COUNT(*)::int AS visits,
                 COALESCE(SUM(${minutesBetween('entered_at', 'exited_at')}) FILTER (WHERE exited_at IS NOT NULL), 0) AS minutes
               FROM visits WHERE employee_id = p.employee_id GROUP BY zone) v) AS zone_minutes,
      (SELECT COALESCE(json_agg(f.zone ORDER BY f.occurred_at), '[]'::json)
         FROM (SELECT zone, occurred_at FROM (
                 SELECT zone, occurred_at, LAG(zone) OVER (ORDER BY occurred_at) AS prev_zone
                 FROM zone_pings WHERE employee_id = p.employee_id AND direction = 'entry') e
               WHERE prev_zone IS DISTINCT FROM zone) f) AS entry_flow,
      (SELECT COALESCE(json_agg(json_build_object('entrance', c.device_label, 'count', c.n) ORDER BY c.n DESC), '[]'::json)
         FROM (SELECT device_label, COUNT(*)::int AS n FROM zone_pings WHERE employee_id = p.employee_id GROUP BY device_label) c) AS entrances
    FROM page p CROSS JOIN summ s
    ORDER BY ${sortCol.replace(/^/, 'p.')} ${sortDir} NULLS LAST, p.employee_id
  `, params);
  };

  let res = await run(page, pageSize);
  let summaryRow = res.rows[0];
  if (!summaryRow && page > 1) {
    // Page past the end: no row carries the summary, so read it from the first row.
    summaryRow = (await run(1, 1)).rows[0];
  }
  const s = summaryRow || {};

  return {
    rows: res.rows.map((r) => {
      const zm = (r.zone_minutes || [])
        .map((z) => ({ zone: z.zone, minutes: Math.round(Number(z.minutes)), visits: z.visits }))
        .sort((a, b) => b.minutes - a.minutes || b.visits - a.visits);
      return {
        employeeId: Number(r.employee_id),
        employeeCode: r.employee_code,
        name: r.full_name,
        role: r.position_title || null,
        department: r.department || null,
        primaryZone: zm[0]?.zone ?? null,
        totalZoneVisits: r.visits,
        totalTimeInsideMinutes: Math.round(Number(r.minutes)),
        avgVisitMinutes: r.avg_visit === null || r.avg_visit === undefined ? null : Math.round(Number(r.avg_visit)),
        entries: r.entries,
        exits: r.exits,
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
        avgMatchConfidence: r.avg_conf === null || r.avg_conf === undefined ? null : Number(Number(r.avg_conf).toFixed(3)),
        currentlyInZone: Boolean(r.currently_in),
        zoneMinutes: zm.map(({ zone, minutes }) => ({ zone, minutes })),
        recentFlow: (r.entry_flow || []).slice(-4),
        entranceUsage: (r.entrances || []).map((e) => ({ entrance: e.entrance, count: e.count })),
      };
    }),
    total: s.tracked ?? 0,
    summary: {
      trackedEmployees: s.tracked ?? 0,
      meanTimeInZoneMinutes: s.mean_minutes === null || s.mean_minutes === undefined ? null : Math.round(Number(s.mean_minutes)),
      mostActiveEmployee: s.top_name ? { name: s.top_name, zoneVisits: s.top_visits } : null,
      meanMatchConfidence: s.mean_conf === null || s.mean_conf === undefined ? null : Number(Number(s.mean_conf).toFixed(3)),
    },
  };
}

// ── Req 9 — employee movement timeline, events with photos, daily photos ───

export async function getEmployeeMovementTimeline({ tenantId, employeeId, fromDate, toDate, tz }) {
  const params = [tenantId, Number(employeeId)];
  const { clauses } = dateClauses('ap.occurred_at', { fromDate, toDate }, params, tz);
  const dateFilter = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`
    SELECT ${RESOLVED_ZONE} AS zone,
      ${DIR} AS direction,
      ap.occurred_at
    FROM attendance_ping ap
    ${ZONE_JOIN}
    WHERE ap.tenant_id = $1::uuid AND ap.fk_employee_id = $2
      ${dateFilter}
    ORDER BY ap.occurred_at ASC
  `, params);

  const transitions = [];
  const openByZone = new Map();
  for (const row of rows) {
    if (row.direction === 'entry' || row.direction === '' || row.direction == null) {
      openByZone.set(row.zone, row.occurred_at);
    } else if (row.direction === 'exit') {
      const enteredAt = openByZone.get(row.zone) ?? null;
      transitions.push({ zone: row.zone, enteredAt, exitedAt: row.occurred_at });
      openByZone.delete(row.zone);
    }
  }
  for (const [zone, enteredAt] of openByZone.entries()) {
    transitions.push({ zone, enteredAt, exitedAt: null });
  }
  transitions.sort((a, b) => new Date(a.enteredAt || a.exitedAt) - new Date(b.enteredAt || b.exitedAt));
  return transitions;
}

/** Chronological Entry/Exit stream for one employee with per-event photos (Req 9.3, 9.6). */
export async function getEmployeeEvents({ tenantId, employeeId, fromDate, toDate, tz, limit = 200, withPhotos = false }) {
  const params = [tenantId, Number(employeeId)];
  const { clauses } = dateClauses('ap.occurred_at', { fromDate, toDate }, params, tz);
  const dateFilter = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
  const limitIdx = push(params, Math.min(500, Math.max(1, Number(limit) || 200)));
  const { rows } = await pool.query(`
    SELECT ap.pk_ping_id AS ping_id, ap.occurred_at AS ts, ${DIR} AS event_type,
      ${RESOLVED_ZONE} AS zone, COALESCE(fd.name, ap.device_code) AS entrance,
      ap.confidence, ap.device_code AS camera_id
    FROM attendance_ping ap
    ${ZONE_JOIN}
    WHERE ap.tenant_id = $1::uuid AND ap.fk_employee_id = $2
      ${dateFilter}
    ORDER BY ap.occurred_at ASC
    LIMIT $${limitIdx}
  `, params);
  // The device_events photo match is opt-in (AC 12.3): only the Employee Movement stream/drilldown asks for it.
  const photos = withPhotos ? await matchEventPhotos(rows) : new Map();
  return rows.map((r) => ({
    id: `p${r.ping_id}`,
    timestamp: r.ts,
    eventType: r.event_type,
    zone: r.zone,
    entrance: r.entrance,
    confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
    cameraId: r.camera_id,
    photoUrl: photos.get(String(r.ping_id)) ?? null,
  }));
}

/**
 * Day-level check-in/check-out photos (AC 9.6 fallback), from
 * attendance_record.checkin_photo_url/checkout_photo_url. Returned as bare
 * filenames that pass the existing /uploads gate; anything else becomes null.
 */
export async function getEmployeeDailyPhotos({ tenantId, employeeId, fromDate, toDate }) {
  const params = [tenantId, Number(employeeId)];
  let dateFilter = '';
  if (fromDate) dateFilter += ` AND attendance_date >= $${push(params, fromDate)}::date`;
  if (toDate) dateFilter += ` AND attendance_date <= $${push(params, toDate)}::date`;
  const { rows } = await pool.query(`
    SELECT to_char(attendance_date, 'YYYY-MM-DD') AS date, checkin_photo_url, checkout_photo_url
    FROM attendance_record
    WHERE tenant_id = $1::uuid AND fk_employee_id = $2
      ${dateFilter}
    ORDER BY attendance_date ASC
  `, params);
  return rows.map((r) => ({
    date: r.date,
    checkInPhotoUrl: toPhotoBasename(r.checkin_photo_url),
    checkOutPhotoUrl: toPhotoBasename(r.checkout_photo_url),
  }));
}

// ── Req 3.8 — transition matrix & most-visited zones ────────────────────────

export async function getMovementMatrix(filters) {
  const { employeeId, departmentId, zones } = filters;
  const scope = { ...filters, departmentIds: departmentId ? [departmentId] : filters.departmentIds };
  const params = [];
  const where = buildFilters(scope, params, { ignoreZones: true });
  const tzIdx = push(params, filters.tz || 'UTC');
  let extra = '';
  if (employeeId) extra += ` AND ap.fk_employee_id = $${push(params, Number(employeeId))}`;
  let zoneEnds = '';
  if (Array.isArray(zones) && zones.length) {
    const zIdx = push(params, zones);
    zoneEnds = `WHERE (prev_zone = ANY($${zIdx}::text[]) OR zone = ANY($${zIdx}::text[]))`;
  }
  const movesQ = pool.query(`
    WITH zone_pings AS (
      SELECT ap.fk_employee_id AS employee_id, ${RESOLVED_ZONE} AS zone,
        ${DIR} AS direction, ap.occurred_at,
        (ap.occurred_at AT TIME ZONE $${tzIdx})::date AS day
      FROM attendance_ping ap
      ${ZONE_JOIN}
      ${EMPLOYEE_JOIN}
      WHERE ${where}
        ${extra}
    ),
    sequenced AS (
      SELECT employee_id, zone, direction,
        LAG(zone) OVER (PARTITION BY employee_id, day ORDER BY occurred_at) AS prev_zone
      FROM zone_pings
    ),
    moves AS (
      SELECT prev_zone, zone FROM sequenced
      WHERE direction = 'entry' AND prev_zone IS NOT NULL AND prev_zone != zone
    )
    SELECT prev_zone AS from_zone, zone AS to_zone, COUNT(*)::int AS count
    FROM moves ${zoneEnds}
    GROUP BY prev_zone, zone
    ORDER BY count DESC, prev_zone, zone
  `, params);

  // The transitions and the most-visited zones are independent: run them together (AC 12.2).
  const vParams = [];
  const vWhere = buildFilters(scope, vParams);
  let vExtra = '';
  if (employeeId) vExtra += ` AND ap.fk_employee_id = $${push(vParams, Number(employeeId))}`;
  const visitedQ = pool.query(`
    SELECT ${RESOLVED_ZONE} AS zone, COUNT(*)::int AS visits
    FROM attendance_ping ap
    ${ZONE_JOIN}
    ${EMPLOYEE_JOIN}
    WHERE ${vWhere} AND ${DIR} = 'entry'
      ${vExtra}
    GROUP BY 1 ORDER BY visits DESC
  `, vParams);
  const [{ rows }, { rows: visitedRows }] = await Promise.all([movesQ, visitedQ]);

  const total = rows.reduce((s, r) => s + r.count, 0);
  const primaryFor = new Map();
  for (const r of rows) if (!primaryFor.has(r.from_zone)) primaryFor.set(r.from_zone, r.to_zone);

  return {
    matrix: rows.map((r) => ({
      fromZone: r.from_zone,
      toZone: r.to_zone,
      count: r.count,
      pct: total > 0 ? Number(((r.count / total) * 100).toFixed(1)) : 0,
      isPrimary: primaryFor.get(r.from_zone) === r.to_zone,
    })),
    mostVisited: visitedRows.map((r) => ({ zone: r.zone, visits: r.visits })),
  };
}

// ── Req 8 — compare zones ───────────────────────────────────────────────────

const COMPARE_METRICS = ['occupancy', 'traffic', 'dwell'];
const COMPARE_GRANULARITIES = ['hour', 'dow', 'week'];
export { COMPARE_METRICS, COMPARE_GRANULARITIES };

/** Entrances (distinct devices) and the department that visits the zone most. */
export async function getZoneExtras(filters) {
  const params = [];
  const cte = visitPairsCTE(filters, params);
  const { rows } = await pool.query(`
    ${cte},
    dept AS (
      SELECT d.name, COUNT(*) AS c FROM zone_pings zp
      JOIN hr_department d ON d.pk_department_id = zp.department_id
      GROUP BY d.name ORDER BY c DESC, d.name LIMIT 1
    )
    SELECT (SELECT COUNT(DISTINCT device_code) FROM zone_pings)::int AS entrances,
      (SELECT name FROM dept) AS primary_department
  `, params);
  return { entrances: rows[0]?.entrances ?? 0, primaryDepartment: rows[0]?.primary_department ?? null };
}

/**
 * One zone's comparison series (Req 8.3). metric: occupancy (peak concurrent
 * headcount per bucket), traffic (entries and exits) or dwell (mean matched
 * visit minutes). granularity: hour (0-23), dow (0-6) or week (week start date).
 */
export async function getComparisonSeries(filters, metric = 'occupancy', granularity = 'hour') {
  const params = [];
  const cte = visitPairsCTE(filters, params);
  const tzIdx = push(params, filters.tz || 'UTC');
  const bucket = (expr) => {
    if (granularity === 'dow') return `EXTRACT(DOW FROM (${expr} AT TIME ZONE $${tzIdx}))::int`;
    if (granularity === 'week') return `to_char(date_trunc('week', ${expr} AT TIME ZONE $${tzIdx}), 'YYYY-MM-DD')`;
    return `EXTRACT(HOUR FROM (${expr} AT TIME ZONE $${tzIdx}))::int`;
  };
  let sql;
  if (metric === 'traffic') {
    sql = `${cte}
      SELECT ${bucket('occurred_at')} AS bucket,
        COUNT(*) FILTER (WHERE direction = 'entry')::int AS entries,
        COUNT(*) FILTER (WHERE direction = 'exit')::int AS exits
      FROM zone_pings GROUP BY 1 ORDER BY 1`;
  } else if (metric === 'dwell') {
    sql = `${cte}
      SELECT ${bucket('entered_at')} AS bucket,
        ROUND(AVG(${minutesBetween('entered_at', 'exited_at')}))::int AS value
      FROM visits WHERE exited_at IS NOT NULL GROUP BY 1 ORDER BY 1`;
  } else {
    sql = `${cte}, ${sweepCTE(false)}
      SELECT ${bucket('t')} AS bucket, MAX(occ)::int AS value
      FROM running WHERE t <= NOW() GROUP BY 1 ORDER BY 1`;
  }
  const { rows } = await pool.query(sql, params);
  return rows.map((r) => (metric === 'traffic'
    ? { bucket: r.bucket, entries: r.entries, exits: r.exits }
    : { bucket: r.bucket, value: r.value }));
}

export { buildFilters, visitPairsCTE, localToday, rangeIncludesToday, LONG_STAY_MINUTES };
