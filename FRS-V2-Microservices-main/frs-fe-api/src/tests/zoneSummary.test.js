/**
 * specs/0003-zone-analytics — Task 14: summary, peak-hours, weekly series,
 * transitions %, heatmap %-of-peak (AC 3.7, 3.8, 6.1-6.5). pool.query is mocked
 * and routed by SQL text; no isolated Postgres exists (see WALKTHROUGH.md), so
 * these prove the JS reshaping and the SQL/params, not the DB result.
 */
import test, { mock } from "node:test";
import assert from "node:assert";
import http from "node:http";
import express from "express";

process.env.NODE_ENV = "test";

const { pool } = await import("../db/pool.js");
const repo = await import("../repositories/zoneRepository.js");
const svc = await import("../services/business/ZoneAnalyticsService.js");
const { requirePermission } = await import("../middleware/authz.js");
const ZoneAnalyticsController = (await import("../controllers/ZoneAnalyticsController.js")).default;

const F = { tenantId: "t1", tz: "Asia/Kolkata", fromDate: "2020-01-01", toDate: "2099-12-31", timeRange: "full", minConfidence: null };

/** Route mocked rows by a fragment of the SQL text. */
function withPool(routes, fn) {
  const orig = pool.query;
  pool.query = async (sql, params) => {
    for (const [needle, rows] of routes) {
      if (sql.includes(needle)) return { rows: typeof rows === "function" ? rows(sql, params) : rows };
    }
    return { rows: [] };
  };
  return Promise.resolve(fn()).finally(() => { pool.query = orig; });
}

const HOURLY_TRAFFIC = [
  { zone: "Lobby", hour: 9, entries: 30, exits: 2 },
  { zone: "Lobby", hour: 13, entries: 5, exits: 20 },
  { zone: "ODC", hour: 9, entries: 10, exits: 1 },
  { zone: "ODC", hour: 18, entries: 1, exits: 1 },
];

// getHourlyProfile is ONE query returning tagged rows (traffic / occ / moment).
const HOURLY_ONE_QUERY = [
  ...HOURLY_TRAFFIC.map((r) => ({ kind: "traffic", ...r })),
  { kind: "occ", hour: 9, avg_occ: 7, peak_occ: 12 },
  { kind: "occ", hour: 13, avg_occ: 4, peak_occ: 6 },
  { kind: "moment", t: "2026-09-21T09:40:00Z", occ: 12 },
];

const SUMMARY_ROUTES = [
  ["SELECT 'traffic' AS kind", HOURLY_ONE_QUERY],
  ["COUNT(*) FILTER (WHERE fd.status = 'online')", [{ total: 13, online: 6 }]],
  ["COUNT(DISTINCT ap.fk_employee_id)", [{ unique_employees: 40 }]],
  ["AS hour_ago_count", [{ now_count: 12, hour_ago_count: 10 }]],
  ["AS total_visits", [{ total_visits: 45, unique_visitors: 40, repeat_visits: 5, avg_visit_duration_minutes: 62.4, avg_time_inside_minutes: 130.2, avg_visits_per_employee: 1.1 }]],
  ["AS current_occupancy", [{ current_occupancy: 12, peak_occupancy: 20, average_occupancy: 9, lowest_occupancy: 1 }]],
  ["date_trunc('hour', occurred_at AT TIME ZONE", [{ ts: "2026-09-21T09:00:00", entries: 40, exits: 24 }]],
];

test("getSummary: hero-card shape from real rows; windows are computed, cameras from facility_device (AC 6.1, 6.3, 3.7)", async () => {
  await withPool([...SUMMARY_ROUTES], async () => {
    const s = await svc.getSummary(F);
    assert.strictEqual(s.hasData, true);
    assert.deepStrictEqual(s.headcount.current, 12);
    assert.strictEqual(s.headcount.peak, 20);
    assert.strictEqual(s.headcount.pctOfPeak, 60); // 12 / 20, share of the observed peak (not capacity)
    assert.deepStrictEqual(s.flow, { entries: 40, exits: 24, net: 16, pctIn: 63, pctOut: 38, uniqueEmployees: 40 });
    assert.strictEqual(s.dwell.avgVisitMinutes, 62);
    assert.strictEqual(s.dwell.avgTimeInsideMinutes, 130);
    assert.strictEqual(s.dwell.totalVisits, 45);
    // peak inflow = hour with most entries (9 -> 40 entries summed over both zones), egress = hour with most exits (13 -> 20)
    assert.deepStrictEqual(s.dwell.peakInflowWindow, { startHour: 9, endHour: 10, count: 40 });
    assert.deepStrictEqual(s.dwell.peakEgressWindow, { startHour: 13, endHour: 14, count: 20 });
    assert.deepStrictEqual(s.cameras, { online: 6, total: 13 });
  });
});

test("getSummary: no capacity, recognition-attempt, failure, latency, SLA or security-total fields anywhere (AC 4.3)", async () => {
  await withPool([...SUMMARY_ROUTES], async () => {
    const json = JSON.stringify(await svc.getSummary(F));
    for (const banned of ["capacity", "attempt", "failed", "latency", "sla", "unauthorized", "securityEvents"]) {
      assert.ok(!json.toLowerCase().includes(banned.toLowerCase()), `summary contains '${banned}'`);
    }
  });
});

test("getSummary: change vs one hour earlier is null in the first hour of the day and when there is no baseline (AC 6.1)", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-20T18:30:00Z") }); // 00:30 in Asia/Kolkata
  try {
    await withPool([...SUMMARY_ROUTES], async () => {
      const s = await svc.getSummary(F);
      assert.strictEqual(s.headcount.changeVs1hPct, null);
    });
  } finally { mock.timers.reset(); }

  mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-21T05:30:00Z") }); // 11:00 IST
  try {
    await withPool([...SUMMARY_ROUTES], async () => {
      const s = await svc.getSummary(F);
      assert.strictEqual(s.headcount.changeVs1hPct, 20); // (12 - 10) / 10
    });
    await withPool([["AS hour_ago_count", [{ now_count: 5, hour_ago_count: 0 }]], ...SUMMARY_ROUTES], async () => {
      const s = await svc.getSummary(F);
      assert.strictEqual(s.headcount.changeVs1hPct, null, "no baseline -> em dash, never a division by zero");
    });
  } finally { mock.timers.reset(); }
});

test("getSummary: an empty range returns nulls, not zeros presented as facts (AC 7.4)", async () => {
  await withPool([
    ["COUNT(*) FILTER (WHERE fd.status = 'online')", [{ total: 13, online: 6 }]],
    ["AS current_occupancy", [{ current_occupancy: null, peak_occupancy: null, average_occupancy: null, lowest_occupancy: null }]],
    ["AS total_visits", [{ total_visits: 0, unique_visitors: 0, repeat_visits: 0, avg_visit_duration_minutes: null, avg_time_inside_minutes: null, avg_visits_per_employee: 0 }]],
  ], async () => {
    const s = await svc.getSummary(F);
    assert.strictEqual(s.hasData, false);
    assert.strictEqual(s.headcount.current, null);
    assert.strictEqual(s.headcount.peak, null);
    assert.strictEqual(s.flow.entries, null);
    assert.strictEqual(s.flow.net, null);
    assert.strictEqual(s.dwell.avgVisitMinutes, null);
    assert.strictEqual(s.dwell.peakInflowWindow, null);
    assert.strictEqual(s.dwell.totalVisits, null);
    assert.deepStrictEqual(s.cameras, { online: 6, total: 13 }, "camera counts are facts about devices, not activity");
  });
});

test("getPeakHours: highest/lowest traffic windows and peak headcount moment come from the data (AC 3.7, 6.5)", async () => {
  await withPool([["SELECT 'traffic' AS kind", HOURLY_ONE_QUERY]], async () => {
    const p = await svc.getPeakHours(F);
    assert.deepStrictEqual(p.highestWindow, { startHour: 9, endHour: 10, count: 43 });
    assert.deepStrictEqual(p.lowestWindow, { startHour: 18, endHour: 19, count: 2 });
    assert.deepStrictEqual(p.peakHeadcountMoment, { at: "2026-09-21T09:40:00Z", count: 12 });
    assert.deepStrictEqual(p.hourly.map((h) => h.hour), [9, 13, 18]);
    assert.deepStrictEqual(p.hourly[0], { hour: 9, entries: 40, exits: 3, traffic: 43, avgOccupancy: 7, peakOccupancy: 12 });
    assert.strictEqual(p.byZone.length, 4);
  });
});

test("getPeakHours: no traffic at all -> no windows and no moment (empty, not zeros)", async () => {
  await withPool([], async () => {
    const p = await svc.getPeakHours(F);
    assert.strictEqual(p.highestWindow, null);
    assert.strictEqual(p.lowestWindow, null);
    assert.strictEqual(p.peakHeadcountMoment, null);
    assert.deepStrictEqual(p.hourly, []);
  });
});

test("getOccupancySeries: hourly, daily and weekly granularity, one series row per zone (AC 3.2, 6.3)", async () => {
  const seen = [];
  await withPool([["FROM running", (sql) => { seen.push(sql); return [{ ts: "2026-08-31", zone: "Lobby", count: 4 }, { ts: "2026-08-31", zone: "ODC", count: 2 }]; }]], async () => {
    for (const g of ["hour", "day", "week"]) {
      const rows = await repo.getOccupancySeries(F, g);
      assert.deepStrictEqual(rows.map((r) => r.zone), ["Lobby", "ODC"]);
    }
  });
  assert.match(seen[0], /date_trunc\('hour'/);
  assert.match(seen[1], /date_trunc\('day'/);
  assert.match(seen[2], /date_trunc\('week'/);
  assert.match(seen[2], /PARTITION BY zone/);
  await assert.rejects(() => svc.getOccupancy(F, "month"), svc.ValidationError);
});

test("getHeatmap: adds pctOfPeak = share of the observed busiest cell, never a capacity (AC 7.2)", async () => {
  await withPool([["GROUP BY 1, 2", [{ dow: 1, hour: 9, count: 10 }, { dow: 1, hour: 10, count: 40 }]]], async () => {
    const h = await repo.getHeatmap(F);
    assert.strictEqual(h.maxCell, 40);
    assert.deepStrictEqual(h.cells.map((c) => c.pctOfPeak), [25, 100]);
  });
});

test("getMovementMatrix: pct sums to 100 and the biggest move out of each zone is flagged primary (AC 3.8)", async () => {
  await withPool([
    ["FROM moves", [
      { from_zone: "A", to_zone: "B", count: 6 },
      { from_zone: "A", to_zone: "C", count: 2 },
      { from_zone: "B", to_zone: "A", count: 2 },
    ]],
    ["GROUP BY 1 ORDER BY visits DESC", [{ zone: "A", visits: 8 }]],
  ], async () => {
    const m = await repo.getMovementMatrix(F);
    assert.deepStrictEqual(m.matrix.map((r) => [r.fromZone, r.toZone, r.pct, r.isPrimary]), [
      ["A", "B", 60, true], ["A", "C", 20, false], ["B", "A", 20, true],
    ]);
    assert.strictEqual(m.matrix.reduce((s, r) => s + r.pct, 0), 100);
  });
});

test("getMovementMatrix: built from consecutive same-employee same-day pings in different zones (AC 3.8)", async () => {
  let sql = "";
  await withPool([["FROM moves", (s) => { sql = s; return []; }]], () => repo.getMovementMatrix(F));
  assert.match(sql, /LAG\(zone\) OVER \(PARTITION BY employee_id, day ORDER BY occurred_at\)/);
  assert.match(sql, /prev_zone != zone/);
});

test("getEntryPointTraffic: net = entries - exits (AC 3.4, 7.2)", async () => {
  await withPool([["FROM per_device d", [{ device_code: "C1", device_label: "Front", entries: 30, exits: 10, unique_employees: 5, peak_hour: 9, contribution_pct: 100 }]]], async () => {
    const [row] = await repo.getEntryPointTraffic(F);
    assert.strictEqual(row.net, 20);
  });
});

// ── route level: /cameras, /analytics/summary, /analytics/peak-hours ────────

function buildApp(permissions) {
  const app = express();
  app.use((req, _res, next) => {
    req.auth = { scope: { tenantId: "11111111-1111-1111-1111-111111111111", siteId: null }, memberships: [{ scope: { siteId: null }, permissions }] };
    next();
  });
  app.use(requirePermission("zones.read"));
  const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
  app.get("/api/zones/cameras", wrap(ZoneAnalyticsController.listCameras));
  app.get("/api/zones/analytics/summary", wrap(ZoneAnalyticsController.getSummary));
  app.get("/api/zones/analytics/peak-hours", wrap(ZoneAnalyticsController.getPeakHours));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test("GET /api/zones/cameras, /analytics/summary, /analytics/peak-hours: 403 without zones.read, 200 with it", async () => {
  await withServer(buildApp(["attendance.read"]), async (base) => {
    for (const p of ["cameras", "analytics/summary", "analytics/peak-hours"]) {
      assert.strictEqual((await fetch(`${base}/api/zones/${p}`)).status, 403, p);
    }
  });
  await withPool([...SUMMARY_ROUTES, ["FROM facility_device fd", [{ camera_id: "C1", name: "Front", entrance: "Front", zone: "Lobby" }]]], async () => {
    await withServer(buildApp(["zones.read"]), async (base) => {
      const cams = await (await fetch(`${base}/api/zones/cameras`)).json();
      assert.ok(Array.isArray(cams.data));
      const sum = await fetch(`${base}/api/zones/analytics/summary?fromDate=2026-09-01&toDate=2026-09-02&tz=Asia/Kolkata`);
      assert.strictEqual(sum.status, 200);
      const body = await sum.json();
      assert.ok(body.data.headcount && body.data.flow && body.data.dwell && body.data.cameras);
      const ph = await fetch(`${base}/api/zones/analytics/peak-hours`);
      assert.strictEqual(ph.status, 200);
      assert.ok("highestWindow" in (await ph.json()).data);
      const bad = await fetch(`${base}/api/zones/analytics/summary?timeRange=midnight`);
      assert.strictEqual(bad.status, 400);
    });
  });
});
