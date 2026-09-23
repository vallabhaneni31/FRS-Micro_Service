/**
 * specs/0003-zone-analytics — Task 9 + Task 17: /api/zones/compare with metric +
 * granularity (AC 8.1-8.5). pool.query mocked, SQL/params captured.
 */
import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import express from "express";

process.env.NODE_ENV = "test";

const { pool } = await import("../db/pool.js");
const repo = await import("../repositories/zoneRepository.js");
const svc = await import("../services/business/ZoneAnalyticsService.js");
const { requirePermission } = await import("../middleware/authz.js");
const ZoneAnalyticsController = (await import("../controllers/ZoneAnalyticsController.js")).default;

const F = { tenantId: "t1", tz: "UTC", timeRange: "full", minConfidence: null };

function route(routes) {
  const calls = [];
  const orig = pool.query;
  pool.query = async (sql, params) => {
    calls.push({ sql, params: params ?? [] });
    for (const [needle, rows] of routes) if (sql.includes(needle)) return { rows: typeof rows === "function" ? rows(sql, params) : rows };
    return { rows: [] };
  };
  return { calls, restore: () => { pool.query = orig; } };
}

// Per-zone rows keyed on the zone param each query carries.
const OCC = (zoneRows) => (sql, params) => [zoneRows[params.find((p) => Array.isArray(p) && typeof p[0] === "string" && zoneRows[p[0]]) ?.[0]] ?? { current_occupancy: 0, peak_occupancy: 0, average_occupancy: 0, lowest_occupancy: 0 }];

const ROUTES = [
  ["AS current_occupancy", OCC({
    Lobby: { current_occupancy: 6, peak_occupancy: 12, average_occupancy: 8, lowest_occupancy: 1 },
    ODC: { current_occupancy: 2, peak_occupancy: 4, average_occupancy: 3, lowest_occupancy: 1 },
  })],
  ["AS total_visits", (sql, params) => [params.some((p) => Array.isArray(p) && p[0] === "Lobby")
    ? { total_visits: 30, avg_visit_duration_minutes: 60, avg_time_inside_minutes: 100, avg_visits_per_employee: 1 }
    : { total_visits: 10, avg_visit_duration_minutes: 30, avg_time_inside_minutes: 50, avg_visits_per_employee: 1 }]],
  ["date_trunc('hour', occurred_at AT TIME ZONE", (sql, params) => [params.some((p) => Array.isArray(p) && p[0] === "Lobby")
    ? { ts: "2026-09-21T09:00:00", entries: 30, exits: 20 }
    : { ts: "2026-09-21T09:00:00", entries: 10, exits: 9 }]],
  ["AS primary_department", [{ entrances: 3, primary_department: "Sales" }]],
  ["FROM running", [{ bucket: 9, value: 5 }]],
];

test("AC 8.1/8.2: one profile + series per selected zone; no floor, code or capacity", async () => {
  const { restore } = route(ROUTES);
  try {
    const out = await svc.compareZones({ ...F, zones: ["Lobby", "ODC"] }, { metric: "occupancy", granularity: "hour" });
    assert.deepStrictEqual(Object.keys(out.zones), ["Lobby", "ODC"]);
    assert.deepStrictEqual(out.zones.Lobby.profile, {
      primaryDepartment: "Sales", liveHeadcount: 6, peak: 12, pctOfPeak: 50, entries: 30, exits: 20, avgDwellMinutes: 60, entrances: 3,
    });
    assert.deepStrictEqual(out.zones.Lobby.series, [{ bucket: 9, value: 5 }]);
    assert.ok(!/capacity|floor|"code"/i.test(JSON.stringify(out)));
  } finally { restore(); }
});

test("AC 8.4: KPI matrix rows per zone plus an aggregate row (sum headcount/entries/exits, highest peak, entry-weighted dwell)", async () => {
  const { restore } = route(ROUTES);
  try {
    const out = await svc.compareZones({ ...F, zones: ["Lobby", "ODC"] });
    assert.deepStrictEqual(out.matrix.map((r) => [r.zone, r.liveHeadcount, r.peak, r.entries, r.exits, r.net, r.avgDwellMinutes]), [
      ["Lobby", 6, 12, 30, 20, 10, 60], ["ODC", 2, 4, 10, 9, 1, 30],
    ]);
    assert.deepStrictEqual(out.aggregate, { liveHeadcount: 8, peak: 12, entries: 40, exits: 29, net: 11, avgDwellMinutes: 53 });
  } finally { restore(); }
});

test("AC 8.3: metric and granularity change the series SQL (occupancy/traffic/dwell x hour/dow/week)", async () => {
  const grab = async (metric, granularity) => {
    let sql = "";
    const r = route([["", (s) => { sql = s; return []; }]]);
    try { await repo.getComparisonSeries({ ...F, zones: ["Lobby"] }, metric, granularity); } finally { r.restore(); }
    return sql;
  };
  assert.match(await grab("occupancy", "hour"), /EXTRACT\(HOUR FROM[\s\S]*FROM running/);
  assert.match(await grab("occupancy", "dow"), /EXTRACT\(DOW FROM/);
  assert.match(await grab("occupancy", "week"), /date_trunc\('week'/);
  assert.match(await grab("traffic", "hour"), /FROM zone_pings GROUP BY 1/);
  assert.match(await grab("dwell", "dow"), /FROM visits WHERE exited_at IS NOT NULL/);
});

test("AC 8.3: traffic series is entries+exits; occupancy/dwell series is a single value per bucket", async () => {
  const r1 = route([["FROM zone_pings GROUP BY 1", [{ bucket: 3, entries: 4, exits: 2 }]]]);
  try { assert.deepStrictEqual(await repo.getComparisonSeries({ ...F, zones: ["A"] }, "traffic", "dow"), [{ bucket: 3, entries: 4, exits: 2 }]); } finally { r1.restore(); }
  const r2 = route([["FROM visits WHERE exited_at IS NOT NULL", [{ bucket: "2026-09-14", value: 44 }]]]);
  try { assert.deepStrictEqual(await repo.getComparisonSeries({ ...F, zones: ["A"] }, "dwell", "week"), [{ bucket: "2026-09-14", value: 44 }]); } finally { r2.restore(); }
});

test("AC 8.5: fewer than 2 zones -> ValidationError 'Select at least 2 zones' (and duplicates do not count twice)", async () => {
  for (const zones of [[], ["Lobby"]]) {
    await assert.rejects(() => svc.compareZones({ ...F, zones }), (e) => e instanceof svc.ValidationError && e.message === "Select at least 2 zones");
  }
  const { restore } = route(ROUTES);
  try {
    const out = await svc.compareZones({ ...F, zones: ["Lobby", "Lobby", "ODC"] });
    assert.deepStrictEqual(Object.keys(out.zones), ["Lobby", "ODC"]);
  } finally { restore(); }
});

test("compare validates metric and granularity", async () => {
  await assert.rejects(() => svc.compareZones({ ...F, zones: ["A", "B"] }, { metric: "capacity" }), svc.ValidationError);
  await assert.rejects(() => svc.compareZones({ ...F, zones: ["A", "B"] }, { granularity: "year" }), svc.ValidationError);
});

test("AC 8.1: 'Busiest zones' preset is data-driven — /zones exposes per-zone entries to rank, no hardcoded zone ids", async () => {
  const r = route([
    ["SELECT DISTINCT", [{ zone: "A", zone_type: "work" }, { zone: "B", zone_type: "work" }, { zone: "C", zone_type: "work" }, { zone: "D", zone_type: "work" }]],
    ["FROM live l", [{ zone: "A", live: 1, entries: 5, peak: 2 }, { zone: "B", live: 0, entries: 50, peak: 9 }, { zone: "C", live: 2, entries: 20, peak: 4 }, { zone: "D", live: 0, entries: 1, peak: 1 }]],
  ]);
  try {
    const zones = await svc.listZones({ tenantId: "t1" }, { fromDate: "2026-09-01", toDate: "2026-09-30", tz: "UTC" });
    const top3 = [...zones].sort((a, b) => b.entries - a.entries).slice(0, 3).map((z) => z.zone);
    assert.deepStrictEqual(top3, ["B", "C", "A"]);
    const metricsCall = r.calls.find((c) => /FROM live l/.test(c.sql));
    assert.ok(metricsCall.params.includes("2026-09-01") && metricsCall.params.includes("2026-09-30"), "range reaches the metrics query");
  } finally { r.restore(); }
});

test("GET /api/zones/compare over HTTP: 400 { error: 'Select at least 2 zones' } for <2 zones; 200 with metric/granularity", async () => {
  const app = express();
  app.use((req, _res, next) => { req.auth = { scope: { tenantId: "t1", siteId: null }, memberships: [{ scope: { siteId: null }, permissions: ["zones.read"] }] }; next(); });
  app.use(requirePermission("zones.read"));
  app.get("/api/zones/compare", (req, res, next) => ZoneAnalyticsController.compareZones(req, res).catch(next));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = route(ROUTES);
  try {
    const bad = await fetch(`${base}/api/zones/compare?zone=Lobby`);
    assert.strictEqual(bad.status, 400);
    assert.deepStrictEqual(await bad.json(), { error: "Select at least 2 zones" });
    const none = await fetch(`${base}/api/zones/compare`);
    assert.strictEqual(none.status, 400);
    const ok = await fetch(`${base}/api/zones/compare?zone=Lobby&zone=ODC&metric=traffic&granularity=dow`);
    assert.strictEqual(ok.status, 200);
    const body = await ok.json();
    assert.strictEqual(body.data.metric, "traffic");
    assert.strictEqual(body.data.granularity, "dow");
    assert.strictEqual((await fetch(`${base}/api/zones/compare?zone=A&zone=B&metric=bogus`)).status, 400);
  } finally {
    r.restore();
    await new Promise((res) => server.close(res));
  }
});
