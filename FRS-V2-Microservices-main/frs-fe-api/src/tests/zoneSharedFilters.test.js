/**
 * specs/0003-zone-analytics — Task 13 (AC 2.6, 3.9): every shared filter must
 * reach every query. pool.query is mocked and the generated SQL + params are
 * captured (there is no isolated Postgres — see WALKTHROUGH.md), so these prove
 * the filter changes the query the database would receive, not the DB result.
 */
import test from "node:test";
import assert from "node:assert";
import { pool } from "../db/pool.js";
import * as repo from "../repositories/zoneRepository.js";
import * as svc from "../services/business/ZoneAnalyticsService.js";

const BASE = { tenantId: "t1", tz: "Asia/Kolkata", fromDate: "2026-09-01", toDate: "2026-09-02" };

async function capture(fn) {
  const calls = [];
  const orig = pool.query;
  pool.query = async (sql, params) => { calls.push({ sql, params: params ?? [] }); return { rows: [] }; };
  try { await fn(); } finally { pool.query = orig; }
  return calls;
}

// Every ping-based repository function that takes the shared filter object.
const PING_QUERIES = {
  getOccupancy: (f) => repo.getOccupancy(f),
  getOccupancySeries: (f) => repo.getOccupancySeries(f, "hour"),
  getTraffic: (f) => repo.getTraffic(f),
  getHeatmap: (f) => repo.getHeatmap(f),
  getEntryPointTraffic: (f) => repo.getEntryPointTraffic(f),
  getDepartmentDistribution: (f) => repo.getDepartmentDistribution(f),
  getVisits: (f) => repo.getVisits(f),
  getTimeSpentBuckets: (f) => repo.getTimeSpentBuckets(f),
  getHourlyProfile: (f) => repo.getHourlyProfile(f),
  getUniqueEmployees: (f) => repo.getUniqueEmployees(f),
  getHeadcountTrend: (f) => repo.getHeadcountTrend(f),
  getEmployees: (f) => repo.getEmployees(f, {}),
  getMovementMatrix: (f) => repo.getMovementMatrix(f),
  getRecentEvents: (f) => repo.getRecentEvents(f, {}),
};

const FILTER_VARIANTS = {
  zones: { zones: ["Cafeteria"] },
  entryPointIds: { entryPointIds: ["CAM-1"] },
  departmentIds: { departmentIds: ["3"] },
  cameraIds: { cameraIds: ["CAM-9"] },
  minConfidence: { minConfidence: 0.7 },
  timeRange: { timeRange: "morning" },
};

for (const [name, run] of Object.entries(PING_QUERIES)) {
  for (const [key, extra] of Object.entries(FILTER_VARIANTS)) {
    test(`${name}: filter '${key}' changes the SQL params/text (AC 3.9)`, async () => {
      const base = await capture(() => run({ ...BASE }));
      const withFilter = await capture(() => run({ ...BASE, ...extra }));
      assert.ok(base.length > 0 && withFilter.length > 0, "query ran");
      const sig = (calls) => JSON.stringify(calls.map((c) => [c.sql.replace(/\s+/g, " "), c.params]));
      assert.notStrictEqual(sig(base), sig(withFilter), `${name} ignored '${key}'`);
    });
  }
}

test("getRecentEvents: department and minimum confidence do NOT hide Unknown Face / Camera Offline rows (AC 3.9b)", async () => {
  const calls = await capture(() => repo.getRecentEvents({ ...BASE, departmentIds: ["3"], minConfidence: 0.9 }, {}));
  const feedSql = calls[0].sql;
  // The ping branch carries both filters...
  assert.match(feedSql, /he\.fk_department_id = ANY/);
  assert.match(feedSql, /ap\.confidence >= /);
  // ...the unknown-face and offline branches must not reference either.
  const unknownBranch = feedSql.split("unauthorized_access_log u")[1].split("UNION ALL")[0];
  const offlineBranch = feedSql.split("device_status_history h")[1];
  for (const b of [unknownBranch, offlineBranch]) {
    assert.doesNotMatch(b, /fk_department_id/);
    assert.doesNotMatch(b, /ap\.confidence/);
    assert.doesNotMatch(b, /minConfidence/);
  }
});

test("getRecentEvents: securityOnly limits the feed to Unknown Face and Camera Offline (AC 3.9c)", async () => {
  const calls = await capture(() => repo.getRecentEvents({ ...BASE, securityOnly: true }, {}));
  assert.doesNotMatch(calls[0].sql, /FROM attendance_ping ap/);
  assert.match(calls[0].sql, /unauthorized_access_log u/);
  assert.match(calls[0].sql, /device_status_history h/);
});

test("securityOnly is the only events-only filter; every other filter is consumed by chart queries (AC 3.9 guard)", () => {
  assert.deepStrictEqual(repo.EVENTS_ONLY_FILTERS, ["securityOnly"]);
  const tested = new Set([...Object.keys(FILTER_VARIANTS), "fromDate", "toDate", "tz", "tenantId", "siteId"]);
  for (const key of repo.PING_FILTER_KEYS) assert.ok(tested.has(key), `filter '${key}' has no test`);
  // A filter accepted by parseFilters must be classified as ping-based or events-only.
  const parsed = Object.keys(svc.parseFilters({}, { tenantId: "t1" }));
  const known = new Set([...repo.PING_FILTER_KEYS, ...repo.EVENTS_ONLY_FILTERS]);
  for (const key of parsed) assert.ok(known.has(key), `parseFilters returns '${key}' but the repository does not classify it`);
});

test("timeRange 'peak' derives the busiest hours from the data, no hardcoded hours (AC 3.9)", async () => {
  const calls = await capture(() => repo.getTraffic({ ...BASE, timeRange: "peak" }));
  assert.match(calls[0].sql, /ORDER BY c DESC, h LIMIT 3/);
});

test("date bounds are timezone-aware (site tz), not the DB session zone", async () => {
  const calls = await capture(() => repo.getTraffic(BASE));
  assert.match(calls[0].sql, /::date::timestamp AT TIME ZONE/);
  assert.ok(calls[0].params.includes("Asia/Kolkata"));
});

test("GET /cameras: listCameras queries facility_device leaf devices scoped by tenant (AC 2.6)", async () => {
  let captured;
  const orig = pool.query;
  pool.query = async (sql, params) => { captured = { sql, params }; return { rows: [{ camera_id: "CAM-1", name: "Front Camera", entrance: "Front Camera", zone: "Lobby" }] }; };
  try {
    const out = await repo.listCameras({ tenantId: "t1", siteId: 5 });
    assert.deepStrictEqual(out, [{ cameraId: "CAM-1", name: "Front Camera", entrance: "Front Camera", zone: "Lobby" }]);
  } finally { pool.query = orig; }
  assert.match(captured.sql, /FROM facility_device fd/);
  assert.match(captured.sql, /decommissioned_at IS NULL/);
  assert.match(captured.sql, /camera_mode IS NOT NULL/);
  assert.deepStrictEqual(captured.params, ["t1", 5]);
  assert.doesNotMatch(captured.sql, /map_x|map_y|map_angle|fk_floor_id/);
});

test("parseFilters: reads cameraId, timeRange, minConfidence, securityOnly and validates them (AC 3.9)", () => {
  const f = svc.parseFilters({ cameraId: "C1", timeRange: "evening", minConfidence: "0.8", securityOnly: "true", tz: "Asia/Kolkata" }, { tenantId: "t1" });
  assert.deepStrictEqual(f.cameraIds, ["C1"]);
  assert.strictEqual(f.timeRange, "evening");
  assert.strictEqual(f.minConfidence, 0.8);
  assert.strictEqual(f.securityOnly, true);
  assert.throws(() => svc.parseFilters({ timeRange: "midnight" }, { tenantId: "t1" }), svc.ValidationError);
  assert.throws(() => svc.parseFilters({ minConfidence: "1.5" }, { tenantId: "t1" }), svc.ValidationError);
  assert.throws(() => svc.parseFilters({ minConfidence: "abc" }, { tenantId: "t1" }), svc.ValidationError);
  assert.throws(() => svc.parseFilters({ tz: "Not/AZone" }, { tenantId: "t1" }), svc.ValidationError);
  const defaults = svc.parseFilters({}, { tenantId: "t1" });
  assert.strictEqual(defaults.minConfidence, null, "confidence filter is off by default (Rev 8), not 80%");
  assert.strictEqual(defaults.timeRange, "full");
  assert.strictEqual(defaults.securityOnly, false);
});

test("no zone endpoint or repository function issues a write statement (AC 4.3, 5.4)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../repositories/zoneRepository.js", import.meta.url), "utf8");
  // Strip comments, then scan every SQL template for write keywords.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+TABLE)\b/i);
});
