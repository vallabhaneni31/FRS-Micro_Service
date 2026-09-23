/**
 * zone-timing.mjs — specs/0003-zone-analytics, Requirement 12.7.
 *
 * READ-ONLY timing of the Zone Analytics repository functions and view loads
 * against the database configured in .env. Every statement this script (or the
 * code it calls) sends is checked before it goes out: only SELECT / WITH / EXPLAIN
 * are allowed, anything else throws. It creates, alters and writes nothing.
 *
 * Usage (from frs-fe-api/):
 *   node scripts/zone-timing.mjs                # tenant = the one with most pings
 *   TENANT_ID=<uuid> TZ_NAME=Asia/Kolkata node scripts/zone-timing.mjs
 *   ZONE_TIMING_SECTIONS=fn,fanout,batch node scripts/zone-timing.mjs   (default: all)
 *
 * Sections
 *   fn      each repository function alone, first call ("cold") and second call
 *           ("warm" = DB buffers hot), for scope today and this month
 *   fanout  a view load the way the UI did it before Requirement 12: one service
 *           call per widget, all started at once (what the browser's parallel HTTP
 *           requests cost on the server, excluding the per-request auth lookups)
 *   batch   the real batch service (ZoneBatchService.js): cold, warm and cache hit
 *           (skipped with a message when that module does not exist yet)
 *
 * Numbers include one network round trip (~225 ms to the shared dev DB) per
 * dependent query: that is the floor, not something the code can remove.
 */
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const base = new URL('../src/', import.meta.url).href;
const { pool } = await import(base + 'db/pool.js');

// ── read-only guard ─────────────────────────────────────────────────────────
const realQuery = pool.query.bind(pool);
let queryCount = 0;
let sqlLog = null;
pool.query = async (...args) => {
  const text = String(args[0]?.text ?? args[0]);
  if (!/^\s*(SELECT|WITH|EXPLAIN|SHOW)\b/i.test(text)) throw new Error('zone-timing.mjs is read-only; refused: ' + text.slice(0, 60));
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT)\b/i.test(text.replace(/'[^']*'/g, "''"))) {
    throw new Error('zone-timing.mjs is read-only; refused a statement containing a write keyword');
  }
  queryCount += 1;
  const s = Date.now();
  try { return await realQuery(...args); } finally { if (sqlLog) sqlLog.push({ ms: Date.now() - s, sql: text.replace(/\s+/g, ' ').slice(0, 100) }); }
};

const sections = (process.env.ZONE_TIMING_SECTIONS || 'fn,fanout,batch').split(',');
const tz = process.env.TZ_NAME || 'Asia/Kolkata';
const pad = (n, w = 6) => String(n).padStart(w);
const time = async (fn) => { queryCount = 0; const s = Date.now(); let error = null; let out; try { out = await fn(); } catch (e) { error = e; } return { ms: Date.now() - s, queries: queryCount, out, error }; };

let tenantId = process.env.TENANT_ID;
if (!tenantId) {
  const t = await pool.query('SELECT tenant_id::text AS t, COUNT(*)::int AS n FROM attendance_ping GROUP BY 1 ORDER BY 2 DESC LIMIT 1');
  tenantId = t.rows[0].t;
}
const rtt = [];
for (let i = 0; i < 4; i++) { const s = Date.now(); await pool.query('SELECT 1'); rtt.push(Date.now() - s); }
console.log(`tenant ${tenantId}  tz ${tz}  pool.max ${pool.options.max}`);
console.log('SELECT 1 round trips (ms):', rtt.join(', '), ' (pool warmed with 8 connections before timing)');
await Promise.all(Array.from({ length: 8 }, () => pool.query('SELECT pg_sleep(0.05)')));

const localToday = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const monthStart = localToday.slice(0, 8) + '01';
const scopeIds = { tenantId, siteId: null };
const svc = await import(base + 'services/business/ZoneAnalyticsService.js');
const repo = await import(base + 'repositories/zoneRepository.js');
const scopes = {
  today: { fromDate: localToday, toDate: localToday },
  month: { fromDate: monthStart, toDate: localToday },
};
const filtersFor = (range) => svc.parseFilters({ ...range, tz }, scopeIds);

// ── section fn: each repository function alone ─────────────────────────────
if (sections.includes('fn')) {
  const fns = ['listZones', 'listEntryPoints', 'listDepartments', 'listCameras', 'getCameraCounts', 'getOccupancy', 'getOccupancySeries', 'getTraffic', 'getUniqueEmployees', 'getHeadcountTrend', 'getHeatmap', 'getHourlyProfile', 'getEntryPointTraffic', 'getDepartmentDistribution', 'getVisits', 'getTimeSpentBuckets', 'getRecentEvents', 'getEmployees', 'getMovementMatrix', 'getZoneExtras', 'getComparisonSeries'];
  const call = (fn, f, range) => {
    if (fn === 'getRecentEvents') return repo[fn](f, { page: 1, pageSize: 20 });
    if (fn === 'getEmployees') return repo[fn](f, { page: 1, pageSize: 50 });
    if (['listEntryPoints', 'listDepartments', 'listCameras', 'getCameraCounts'].includes(fn)) return repo[fn](scopeIds);
    if (fn === 'listZones') return repo[fn]({ ...scopeIds, ...range, tz });
    if (fn === 'getComparisonSeries') return repo[fn](f, 'occupancy', 'hour');
    return repo[fn](f);
  };
  for (const [name, range] of Object.entries(scopes)) {
    console.log(`\n=== repository functions, scope ${name} (${range.fromDate}..${range.toDate}) ===`);
    console.log('  cold ms  warm ms  queries  function');
    const f = filtersFor(range);
    for (const fn of fns) {
      const cold = await time(() => call(fn, f, range));
      const warm = await time(() => call(fn, f, range));
      const tag = cold.error ? ' ERROR ' + String(cold.error.message).slice(0, 60) : '';
      console.log(`  ${pad(cold.ms, 7)}  ${pad(warm.ms, 7)}  ${pad(cold.queries, 7)}  ${fn}${tag}`);
    }
  }
}

// ── view definitions shared by fanout ───────────────────────────────────────
const iso = (d) => d.toISOString().slice(0, 10);
const daysBack = (n) => { const d = new Date(localToday + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return iso(d); };
const fanout = {
  overview: () => {
    const f = filtersFor(scopes.today);
    return {
      summary: () => svc.getSummary(f),
      zones: () => svc.listZones(scopeIds, { tz, ...scopes.today }),
      occHourly: () => svc.getOccupancy(f, 'hour'),
      occDaily: () => svc.getOccupancy(filtersFor({ fromDate: daysBack(6), toDate: localToday }), 'day'),
      occWeekly: () => svc.getOccupancy(filtersFor({ fromDate: daysBack(27), toDate: localToday }), 'week'),
      departments: () => svc.getDepartmentDistribution(f),
      peak: () => svc.getPeakHours(f),
      events: () => svc.getRecentEvents(f, { page: 1, pageSize: 5 }),
    };
  },
  'deep-dive': () => {
    const f = filtersFor(scopes.today);
    return {
      zones: () => svc.listZones(scopeIds, { tz }),
      entryPoints: () => svc.listEntryPoints(scopeIds, null),
      departmentsList: () => svc.listDepartments(scopeIds),
      cameras: () => svc.listCameras(scopeIds),
      summary: () => svc.getSummary(f),
      peak: () => svc.getPeakHours(f),
      heatmap: () => svc.getHeatmap(f),
      entrances: () => svc.getEntryPointTraffic(f),
      timeSpent: () => svc.getTimeSpent(f),
      matrix: () => svc.getMovementMatrix({ ...f, employeeId: null, departmentId: null }),
      events: () => svc.getRecentEvents(f, { page: 1, pageSize: 10 }),
    };
  },
  compare: async () => {
    const f = filtersFor(scopes.month);
    const zones = await svc.listZones(scopeIds, { tz, ...scopes.month });
    const two = [...zones].sort((a, b) => b.entries - a.entries).slice(0, 2).map((z) => z.zone);
    return {
      zones: () => svc.listZones(scopeIds, { tz, ...scopes.month }),
      compare: () => svc.compareZones({ ...f, zones: two }, { metric: 'occupancy', granularity: 'hour' }),
    };
  },
  movement: () => {
    const f = filtersFor(scopes.today);
    return {
      zones: () => svc.listZones(scopeIds, { tz }),
      departmentsList: () => svc.listDepartments(scopeIds),
      employees: () => svc.getEmployees(f, { sort: 'time', dir: 'desc', page: 1, pageSize: 12 }),
      top: () => svc.getEmployees(f, { sort: 'visits', dir: 'desc', page: 1, pageSize: 10 }),
    };
  },
};

if (sections.includes('fanout')) {
  console.log('\n=== fan-out: one service call per widget, all at once (how the UI loaded a view before Requirement 12) ===');
  console.log('  cold ms  warm ms  queries  widgets  view   (slowest widget)');
  for (const view of Object.keys(fanout)) {
    const run = async () => {
      const widgets = await fanout[view]();
      const timings = {};
      await Promise.all(Object.entries(widgets).map(async ([k, fn]) => { const s = Date.now(); try { await fn(); } finally { timings[k] = Date.now() - s; } }));
      return timings;
    };
    const cold = await time(run);
    const warm = await time(run);
    const slow = Object.entries(cold.out || {}).sort((a, b) => b[1] - a[1])[0];
    console.log(`  ${pad(cold.ms, 7)}  ${pad(warm.ms, 7)}  ${pad(warm.queries, 7)}  ${pad(Object.keys(cold.out || {}).length, 7)}  ${view}   (${slow ? slow[0] + ' ' + slow[1] + ' ms' : '-'})`);
  }
}

// ── section batch: the real batch service ──────────────────────────────────
if (sections.includes('batch')) {
  let batch = null;
  try { batch = await import(base + 'services/business/ZoneBatchService.js'); } catch (e) {
    console.log('\n=== batch: skipped (ZoneBatchService.js not present yet: ' + String(e.message).split('\n')[0] + ') ===');
  }
  if (batch) {
    console.log('\n=== batch service (server time only; the HTTP request adds one auth pass, see walkthrough) ===');
    console.log('  cold ms  warm ms  hit ms  queries(cold)  view/part');
    const q = (o) => ({ tz, ...o });
    const cases = [
      ['filters', null, q({})],
      ['overview', 'core', q(scopes.today)],
      ['overview', 'detail', q(scopes.today)],
      ['deep-dive', 'core', q(scopes.today)],
      ['deep-dive', 'detail', q({ ...scopes.today, page: 1, pageSize: 10 })],
      ['deep-dive', 'core', q(scopes.month)],
      ['deep-dive', 'detail', q({ ...scopes.month, page: 1, pageSize: 10 })],
    ];
    const zones = await svc.listZones(scopeIds, { tz, ...scopes.month });
    const two = [...zones].sort((a, b) => b.entries - a.entries).slice(0, 2).map((z) => z.zone);
    cases.push(['compare', 'core', q({ ...scopes.month, zone: two, metric: 'occupancy', granularity: 'hour' })]);
    cases.push(['movement', 'core', q(scopes.today)]);
    for (const [view, part, query] of cases) {
      const run = (refresh) => batch.getBatch({ view, part, query: { ...query, ...(refresh ? { refresh: '1' } : {}) }, scope: scopeIds });
      batch.clearZoneCache?.();
      const cold = await time(() => run(true));
      const warm = await time(() => run(true));
      const hit = await time(() => run(false));
      const errs = Object.keys(cold.out?.errors || {});
      console.log(`  ${pad(cold.ms, 7)}  ${pad(warm.ms, 7)}  ${pad(hit.ms, 6)}  ${pad(cold.queries, 13)}  ${view}/${part ?? '-'} ${query.fromDate ?? ''}..${query.toDate ?? ''}${cold.error ? ' ERROR ' + cold.error.message : ''}${errs.length ? ' WIDGET ERRORS ' + errs.join(',') : ''}`);
    }
  }
}
await pool.end();
