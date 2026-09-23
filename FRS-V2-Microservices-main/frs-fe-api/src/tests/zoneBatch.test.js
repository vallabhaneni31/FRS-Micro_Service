/**
 * specs/0003-zone-analytics — Task 28 (AC 12.1, 12.2, 12.3, 12.4, 12.5): batch
 * endpoints and the in-process cache. The repository is replaced by a counted,
 * delayed mock so the tests can prove each function runs once and concurrently;
 * the HTTP tests mock pool.query. No isolated Postgres exists (WALKTHROUGH.md).
 */
import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import express from "express";

process.env.NODE_ENV = "test";

const { pool } = await import("../db/pool.js");
const repo = await import("../repositories/zoneRepository.js");
const batch = await import("../services/business/ZoneBatchService.js");
const cacheMod = await import("../services/business/zoneCache.js");
const svc = await import("../services/business/ZoneAnalyticsService.js");
const { requirePermission } = await import("../middleware/authz.js");
const ZoneAnalyticsController = (await import("../controllers/ZoneAnalyticsController.js")).default;

const SCOPE = { tenantId: "t1", siteId: null };
const DELAY = 40;

/** Counted, delayed repository: records calls (name + args) and the peak number of calls in flight. */
function mockRepo(overrides = {}) {
  const calls = [];
  let inflight = 0;
  let peak = 0;
  const wrap = (name, value) => async (...args) => {
    calls.push({ name, args });
    inflight += 1;
    peak = Math.max(peak, inflight);
    try {
      await new Promise((r) => setTimeout(r, DELAY));
      if (overrides[name] === "throw") throw new Error("boom " + name);
      return typeof value === "function" ? value(...args) : value;
    } finally { inflight -= 1; }
  };
  const values = {
    listZones: [{ zone: "Lobby", zoneType: "x", siteId: null, liveHeadcount: 1, peak: 2, entries: 5 }],
    listEntryPoints: [{ deviceId: "C1", deviceLabel: "Front", zone: "Lobby" }],
    listDepartments: [{ departmentId: 1, name: "Sales" }],
    listCameras: [{ cameraId: "C1", name: "Front", entrance: "Front", zone: "Lobby" }],
    getCameraCounts: { online: 1, total: 2 },
    getOccupancy: { current_occupancy: 3, peak_occupancy: 5, average_occupancy: 2, lowest_occupancy: 1 },
    getOccupancySeries: [{ ts: "2026-09-21T09:00:00", zone: "Lobby", count: 3 }],
    getTraffic: { totalEntries: 4, totalExits: 3, peakTraffic: 5, series: [] },
    getUniqueEmployees: 4,
    getHeadcountTrend: { now: 3, hourAgo: 2, minutesIntoDay: 600 },
    getHeatmap: { maxCell: 1, cells: [] },
    getHourlyProfile: { hourly: [{ hour: 9, entries: 2, exits: 1, traffic: 3, avgOccupancy: 1, peakOccupancy: 2 }], byZone: [], peakMoment: null },
    getEntryPointTraffic: [],
    getDepartmentDistribution: [],
    getVisits: { totalVisits: 2, avgVisitDurationMinutes: 10, avgTimeInsideMinutes: 20 },
    getTimeSpentBuckets: [],
    getRecentEvents: { rows: [], total: 0 },
    getEmployees: { rows: [], total: 0, summary: {} },
    getMovementMatrix: { matrix: [], mostVisited: [] },
    getZoneExtras: { entrances: 1, primaryDepartment: "Sales" },
    getComparisonSeries: [],
    getEmployeeMovementTimeline: [],
    getEmployeeEvents: [],
    getEmployeeDailyPhotos: [],
  };
  const fake = { ...repo };
  for (const [name, value] of Object.entries(values)) fake[name] = wrap(name, value);
  return { repository: fake, calls, get peak() { return peak; }, count: (n) => calls.filter((c) => c.name === n).length };
}

const Q = { fromDate: "2026-09-21", toDate: "2026-09-21", tz: "Asia/Kolkata" };
const fresh = () => cacheMod.createZoneCache();
const run = (view, part, query, m, cache = fresh(), scope = SCOPE) => batch.getBatch({ view, part, query: { ...Q, ...query }, scope, repository: m.repository, cache });

// ── AC 12.1 / 12.2: one call per repository function, all at once ───────────
test("AC 12.1/12.2: overview core calls each repository function once (identical calls shared) and concurrently", async () => {
  const m = mockRepo();
  const t0 = Date.now();
  const out = await run("overview", "core", {}, m);
  const elapsed = Date.now() - t0;
  assert.deepStrictEqual(Object.keys(out.data).sort(), ["departments", "occDaily", "occHourly", "occWeekly", "peak", "summary", "zones"]);
  assert.deepStrictEqual(out.errors, {});
  assert.match(out.computedAt, /^\d{4}-\d{2}-\d{2}T/);
  // summary + occHourly share today's getOccupancy; summary + peak share getHourlyProfile
  assert.strictEqual(m.count("getOccupancy"), 3, "today / daily / weekly windows, not 5");
  assert.strictEqual(m.count("getHourlyProfile"), 1);
  for (const fn of ["getTraffic", "getVisits", "getUniqueEmployees", "getHeadcountTrend", "getCameraCounts", "listZones", "getDepartmentDistribution"]) assert.strictEqual(m.count(fn), 1, fn);
  assert.strictEqual(m.count("getRecentEvents"), 0, "events belong to the detail part");
  assert.ok(m.peak >= 6, `queries ran concurrently (peak in flight ${m.peak})`);
  assert.ok(elapsed < DELAY * 4, `not sequential: ${elapsed} ms for ${m.calls.length} calls of ${DELAY} ms`);
});

test("AC 12.1: the daily and weekly trend windows are derived on the server (7 days and 4 weeks back from toDate)", async () => {
  const m = mockRepo();
  await run("overview", "core", {}, m);
  const froms = m.calls.filter((c) => c.name === "getOccupancy").map((c) => c.args[0].fromDate).sort();
  assert.deepStrictEqual(froms, ["2026-08-25", "2026-09-15", "2026-09-21"]);
});

test("AC 12.1: overview detail = events only (pageSize 5, personType forwarded, NO photo flag) - AC 12.3", async () => {
  const m = mockRepo();
  const out = await run("overview", "detail", { personType: "visitor" }, m);
  assert.deepStrictEqual(Object.keys(out.data), ["events"]);
  assert.strictEqual(m.calls.length, 1);
  const [, opts] = m.calls[0].args;
  assert.strictEqual(opts.pageSize, 5);
  assert.strictEqual(opts.personType, "visitor");
  assert.ok(!opts.withPhotos, "list loads never run the photo match");
});

test("AC 12.3: even ?withPhotos=1 on a list batch does not enable photos", async () => {
  const m = mockRepo();
  await run("deep-dive", "detail", { withPhotos: "1", page: "2", pageSize: "10", eventType: "entry", status: "verified", q: "x" }, m);
  const [, opts] = m.calls[0].args;
  assert.ok(!opts.withPhotos);
  assert.deepStrictEqual([opts.page, opts.pageSize, opts.eventType, opts.status, opts.q], [2, 10, "entry", "verified", "x"]);
});

test("AC 12.1: deep-dive core = summary, peak, heatmap, entrances, timeSpent, matrix; each function once, concurrent", async () => {
  const m = mockRepo();
  const out = await run("deep-dive", "core", {}, m);
  assert.deepStrictEqual(Object.keys(out.data).sort(), ["entrances", "heatmap", "matrix", "peak", "summary", "timeSpent"]);
  for (const fn of ["getOccupancy", "getHourlyProfile", "getHeatmap", "getEntryPointTraffic", "getTimeSpentBuckets", "getMovementMatrix"]) assert.strictEqual(m.count(fn), 1, fn);
  assert.ok(m.peak >= 6);
});

test("AC 12.1: compare core = zones + comparison; fewer than 2 zones selected returns only the zone list", async () => {
  const a = mockRepo();
  const one = await run("compare", "core", { zone: ["Lobby"] }, a);
  assert.deepStrictEqual(Object.keys(one.data), ["zones"]);
  const b = mockRepo();
  const two = await run("compare", "core", { zone: ["Lobby", "ODC"], metric: "traffic", granularity: "dow" }, b);
  assert.deepStrictEqual(Object.keys(two.data).sort(), ["compare", "zones"]);
  assert.strictEqual(two.data.compare.metric, "traffic");
  assert.strictEqual(b.count("getComparisonSeries"), 2, "once per selected zone");
  assert.deepStrictEqual((await run("compare", "detail", {}, mockRepo())).data, {});
});

test("AC 12.1/12.3: movement core = employees + top; movement detail needs employeeId and only fetches photos with withPhotos=1", async () => {
  const m = mockRepo();
  const core = await run("movement", "core", {}, m);
  assert.deepStrictEqual(Object.keys(core.data).sort(), ["employees", "top"]);
  assert.strictEqual(m.count("getEmployees"), 2);
  await assert.rejects(() => run("movement", "detail", {}, mockRepo()), svc.ValidationError);
  const noPhotos = mockRepo();
  await run("movement", "detail", { employeeId: "7" }, noPhotos);
  assert.strictEqual(noPhotos.calls.find((c) => c.name === "getEmployeeEvents").args[0].withPhotos, false);
  const withPhotos = mockRepo();
  const d = await run("movement", "detail", { employeeId: "7", withPhotos: "1" }, withPhotos);
  assert.strictEqual(withPhotos.calls.find((c) => c.name === "getEmployeeEvents").args[0].withPhotos, true);
  assert.deepStrictEqual(Object.keys(d.data.movement).sort(), ["dailyPhotos", "events", "transitions"]);
});

test("AC 12.1: filters batch = zones, entryPoints, departments, cameras in one call, concurrently", async () => {
  const m = mockRepo();
  const out = await batch.getBatch({ view: "filters", query: { tz: "Asia/Kolkata" }, scope: SCOPE, repository: m.repository, cache: fresh() });
  assert.deepStrictEqual(Object.keys(out.data).sort(), ["cameras", "departments", "entryPoints", "zones"]);
  assert.ok(m.peak >= 4);
});

test("AC 12.1: unknown view/part -> ValidationError (400); bad filter input fails the whole request", async () => {
  await assert.rejects(() => run("nope", "core", {}, mockRepo()), svc.ValidationError);
  await assert.rejects(() => run("overview", "middle", {}, mockRepo()), svc.ValidationError);
  await assert.rejects(() => run("overview", "core", { fromDate: "yesterday" }, mockRepo()), svc.ValidationError);
  await assert.rejects(() => run("overview", "detail", { personType: "guest" }, mockRepo()), svc.ValidationError);
});

// ── partial failure ─────────────────────────────────────────────────────────
test("AC 12.1: one failing widget is reported under errors and the rest still return; the partial result is not cached", async () => {
  const cache = fresh();
  const failing = mockRepo({ getHeatmap: "throw" });
  const out = await run("deep-dive", "core", {}, failing, cache);
  assert.deepStrictEqual(Object.keys(out.errors), ["heatmap"]);
  assert.match(out.errors.heatmap, /Could not load/);
  assert.ok(!JSON.stringify(out.errors).includes("boom"), "no internal message leaks");
  assert.ok(out.data.summary && out.data.peak && out.data.entrances, "other widgets returned");
  assert.ok(!("heatmap" in out.data));
  // next call recomputes (errors are not cached) and now succeeds
  const healthy = mockRepo();
  const again = await run("deep-dive", "core", {}, healthy, cache);
  assert.deepStrictEqual(again.errors, {});
  assert.strictEqual(healthy.count("getHeatmap"), 1);
});

// ── cache ───────────────────────────────────────────────────────────────────
test("AC 12.4: cache hit serves the stored result without touching the repository; miss on different params", async () => {
  const cache = fresh();
  const m = mockRepo();
  const first = await run("overview", "core", {}, m, cache);
  const calls = m.calls.length;
  const second = await run("overview", "core", {}, m, cache);
  assert.strictEqual(m.calls.length, calls, "hit: no repository calls");
  assert.strictEqual(second.computedAt, first.computedAt, "computedAt is when the data was computed, not when it was served");
  await run("overview", "core", { toDate: "2026-09-20", fromDate: "2026-09-20" }, m, cache);
  assert.ok(m.calls.length > calls, "different params -> miss");
  assert.strictEqual(cache.size, 2);
});

test("AC 12.4: TTL - aggregates expire after 60 s, filter lists after 10 min", async () => {
  let t = 1_000_000;
  const cache = cacheMod.createZoneCache({ now: () => t });
  const m = mockRepo();
  await run("overview", "core", {}, m, cache);
  const n1 = m.calls.length;
  t += 59_000;
  await run("overview", "core", {}, m, cache);
  assert.strictEqual(m.calls.length, n1, "still cached at 59 s");
  t += 2_000;
  await run("overview", "core", {}, m, cache);
  assert.ok(m.calls.length > n1, "expired after 61 s");

  const f = mockRepo();
  const args = { view: "filters", query: { tz: "UTC" }, scope: SCOPE, repository: f.repository, cache };
  await batch.getBatch(args);
  const nf = f.calls.length;
  t += 9 * 60_000;
  await batch.getBatch(args);
  assert.strictEqual(f.calls.length, nf, "filter lists still cached at 9 min");
  t += 2 * 60_000;
  await batch.getBatch(args);
  assert.ok(f.calls.length > nf, "filter lists expired after 11 min");
});

test("AC 12.5: refresh=1 bypasses the cache and replaces the entry (computedAt moves forward)", async () => {
  const cache = fresh();
  const m = mockRepo();
  const first = await run("overview", "core", {}, m, cache);
  await new Promise((r) => setTimeout(r, 5));
  const n = m.calls.length;
  const refreshed = await run("overview", "core", { refresh: "1" }, m, cache);
  assert.ok(m.calls.length > n, "recomputed");
  assert.notStrictEqual(refreshed.computedAt, first.computedAt);
  const after = await run("overview", "core", {}, m, cache);
  assert.strictEqual(after.computedAt, refreshed.computedAt, "the refreshed value is what is cached now");
  assert.strictEqual(cache.size, 1, "refresh does not create a second entry (refresh is not part of the key)");
});

test("AC 12.4: single-flight - identical concurrent requests share one execution", async () => {
  const cache = fresh();
  const m = mockRepo();
  const results = await Promise.all(Array.from({ length: 6 }, () => run("deep-dive", "core", {}, m, cache)));
  assert.strictEqual(m.count("getHeatmap"), 1);
  assert.ok(results.every((r) => r.computedAt === results[0].computedAt));
});

test("AC 12.4: bounded size - oldest entry is evicted first", async () => {
  const cache = cacheMod.createZoneCache({ maxEntries: 2 });
  const m = mockRepo();
  for (const d of ["2026-09-01", "2026-09-02", "2026-09-03"]) await run("deep-dive", "core", { fromDate: d, toDate: d }, m, cache);
  assert.strictEqual(cache.size, 2);
  const k = (d) => cacheMod.buildCacheKey({ tenantId: "t1", siteId: null, view: "deep-dive", part: "core", query: { ...Q, fromDate: d, toDate: d } });
  assert.strictEqual(cache.has(k("2026-09-01")), false, "oldest gone");
  assert.strictEqual(cache.has(k("2026-09-03")), true);
});

test("AC 12.4: errors are never cached (loader rejection, then success)", async () => {
  const cache = fresh();
  let n = 0;
  await assert.rejects(() => cache.getOrCompute("k", 1000, async () => { n += 1; throw new Error("x"); }));
  const ok = await cache.getOrCompute("k", 1000, async () => { n += 1; return "v"; });
  assert.deepStrictEqual([ok.value, ok.hit, n], ["v", false, 2]);
  assert.strictEqual((await cache.getOrCompute("k", 1000, async () => "other")).hit, true);
});

test("AC 12.4: tenant isolation - the tenant and site are part of the key; identical params for two tenants never share an entry", async () => {
  const a = cacheMod.buildCacheKey({ tenantId: "tenant-A", siteId: null, view: "overview", part: "core", query: Q });
  const b = cacheMod.buildCacheKey({ tenantId: "tenant-B", siteId: null, view: "overview", part: "core", query: Q });
  const c = cacheMod.buildCacheKey({ tenantId: "tenant-A", siteId: "5", view: "overview", part: "core", query: Q });
  assert.ok(a !== b && a !== c);
  // a tenantId smuggled in the query string neither changes the key nor the scope
  assert.strictEqual(cacheMod.buildCacheKey({ tenantId: "tenant-A", siteId: null, view: "overview", part: "core", query: { ...Q, tenantId: "tenant-B" } }), a);

  const cache = fresh();
  const m = mockRepo();
  await run("overview", "core", {}, m, cache, { tenantId: "tenant-A", siteId: null });
  const n = m.calls.length;
  await run("overview", "core", {}, m, cache, { tenantId: "tenant-B", siteId: null });
  assert.ok(m.calls.length > n, "tenant B recomputed instead of reading tenant A's entry");
  assert.ok(m.calls.some((c2) => (c2.args[0]?.tenantId ?? c2.args[0]?.tenantId) === "tenant-B"));
  assert.strictEqual(cache.size, 2);
});

test("AC 12.4: key normalisation - parameter order and refresh do not split the key; array order is kept", () => {
  const k = (query) => cacheMod.buildCacheKey({ tenantId: "t", siteId: null, view: "v", part: "core", query });
  assert.strictEqual(k({ a: "1", b: "2" }), k({ b: "2", a: "1", refresh: "1" }));
  assert.notStrictEqual(k({ zone: ["A", "B"] }), k({ zone: ["A"] }));
  assert.strictEqual(k({ a: "1", q: "" }), k({ a: "1" }));
});

// ── HTTP: still gated by zones.read, scope from req.auth ────────────────────
async function withServer(perms, fn) {
  const app = express();
  app.use((req, _res, next) => { req.auth = { scope: { tenantId: "t1", siteId: null }, memberships: [{ scope: { siteId: null }, permissions: perms }] }; next(); });
  app.use(requirePermission("zones.read"));
  app.get("/api/zones/batch/filters", (req, res, next) => ZoneAnalyticsController.getFiltersBatch(req, res).catch(next));
  app.get("/api/zones/batch/:view/:part", (req, res, next) => ZoneAnalyticsController.getViewBatch(req, res).catch(next));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

test("AC 12.1/2.4: batch endpoints 403 without zones.read; with it {data,errors,computedAt}, tenant from req.auth (query tenantId ignored), 400 on bad input", async () => {
  batch.clearZoneCache();
  const orig = pool.query;
  const seen = [];
  pool.query = async (sql, params) => { seen.push(params ?? []); return { rows: [] }; };
  try {
    await withServer(["attendance.read"], async (base) => {
      assert.strictEqual((await fetch(`${base}/api/zones/batch/filters`)).status, 403);
      assert.strictEqual((await fetch(`${base}/api/zones/batch/overview/core`)).status, 403);
    });
    await withServer(["zones.read"], async (base) => {
      const res = await fetch(`${base}/api/zones/batch/filters?tz=Asia/Kolkata&tenantId=EVIL`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.deepStrictEqual(Object.keys(body).sort(), ["computedAt", "data", "errors"]);
      assert.deepStrictEqual(Object.keys(body.data).sort(), ["cameras", "departments", "entryPoints", "zones"]);
      assert.ok(seen.length > 0 && seen.every((p) => p[0] === "t1" && !p.includes("EVIL")), "every query is scoped by req.auth.scope.tenantId");
      assert.strictEqual((await fetch(`${base}/api/zones/batch/nope/core`)).status, 400);
      assert.strictEqual((await fetch(`${base}/api/zones/batch/overview/core?fromDate=bad`)).status, 400);
    });
  } finally { pool.query = orig; batch.clearZoneCache(); }
});

test("AC 12.1: batch routes are GET-only, registered behind the zones.read router gate, and ahead of nothing that could shadow them", async () => {
  const fs = await import("node:fs");
  const routes = fs.readFileSync(new URL("../routes/zoneRoutes.js", import.meta.url), "utf8");
  assert.match(routes, /router\.use\(requirePermission\('zones\.read'\)\);[\s\S]*router\.get\('\/batch\/filters'/);
  assert.match(routes, /router\.get\('\/batch\/:view\/:part'/);
  assert.doesNotMatch(routes, /router\.(post|put|patch|delete)\(/);
  const src = fs.readFileSync(new URL("../services/business/ZoneBatchService.js", import.meta.url), "utf8") + fs.readFileSync(new URL("../services/business/zoneCache.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|audit_log)\b/i);
});
