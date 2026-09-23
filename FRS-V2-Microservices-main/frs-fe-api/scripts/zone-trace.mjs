/**
 * zone-trace.mjs — specs/0003-zone-analytics, Requirement 12.7.
 *
 * READ-ONLY per-query trace of the slow Zone Analytics functions: for each one it
 * prints every SQL statement sent, how long it took and whether it ran alongside
 * others, so the sequential depth (the thing that multiplies the ~225 ms round
 * trip) is visible. Only SELECT / WITH / EXPLAIN statements are allowed through;
 * anything else throws. Nothing is created, altered or written.
 *
 * Usage (from frs-fe-api/):  node scripts/zone-trace.mjs
 *   TENANT_ID=<uuid> TZ_NAME=Asia/Kolkata to override.
 */
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const base = new URL('../src/', import.meta.url).href;
const { pool } = await import(base + 'db/pool.js');
const repo = await import(base + 'repositories/zoneRepository.js');

const realQuery = pool.query.bind(pool);
let log = [];
let t0 = 0;
pool.query = async (...a) => {
  const text = String(a[0]?.text ?? a[0]);
  if (!/^\s*(SELECT|WITH|EXPLAIN|SHOW)\b/i.test(text)) throw new Error('zone-trace.mjs is read-only; refused: ' + text.slice(0, 60));
  const start = Date.now() - t0;
  try { return await realQuery(...a); } finally { log.push({ start, end: Date.now() - t0, sql: text.replace(/\s+/g, ' ').slice(0, 100) }); }
};

let tenantId = process.env.TENANT_ID;
if (!tenantId) tenantId = (await realQuery('SELECT tenant_id::text AS t FROM attendance_ping GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1')).rows[0].t;
const tz = process.env.TZ_NAME || 'Asia/Kolkata';
await Promise.all(Array.from({ length: 6 }, () => realQuery('SELECT pg_sleep(0.05)')));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const monthStart = today.slice(0, 8) + '01';
const f = { tenantId, siteId: null, tz, fromDate: monthStart, toDate: today, zones: [], entryPointIds: [], departmentIds: [], cameraIds: [], timeRange: 'full', minConfidence: null };

async function trace(label, fn) {
  log = [];
  t0 = Date.now();
  await fn();
  const total = Date.now() - t0;
  console.log(`\n== ${label}: total ${total} ms, ${log.length} queries`);
  for (const l of log) console.log(`  start ${String(l.start).padStart(5)} end ${String(l.end).padStart(5)} (${String(l.end - l.start).padStart(5)} ms)  ${l.sql}`);
}

await trace('getRecentEvents month', () => repo.getRecentEvents(f, { page: 1, pageSize: 20 }));
await trace('getRecentEvents month, personType=visitor', () => repo.getRecentEvents(f, { page: 1, pageSize: 20, personType: 'visitor' }));
await trace('getEmployees month', () => repo.getEmployees(f, { page: 1, pageSize: 50 }));
await trace('listZones today', () => repo.listZones({ tenantId, siteId: null, tz, fromDate: today, toDate: today }));
await trace('getHourlyProfile today', () => repo.getHourlyProfile({ ...f, fromDate: today }));
await trace('listEntryPoints', () => repo.listEntryPoints({ tenantId }));
await trace('getMovementMatrix month', () => repo.getMovementMatrix({ ...f, employeeId: null, departmentId: null }));
await pool.end();
