/**
 * specs/0003-zone-analytics — Task 2: zoneRepository filter-list queries.
 *
 * pool.query is mocked (same pattern as attendanceIngestWorker.test.js's
 * monkeypatch of attendanceService.markAttendance) — this repo has no
 * isolated test database (the only reachable Postgres, DB_HOST in .env, is
 * the shared `attendance_intelligence` dev DB — writing/deleting fixture
 * rows there was judged too risky to do from an automated pass, so these are
 * mocked-pool unit tests, not live-DB integration tests; flagged in
 * WALKTHROUGH.md).
 */
import test from "node:test";
import assert from "node:assert";
import { pool } from "../db/pool.js";
import { listZones, listEntryPoints, listDepartments } from "../repositories/zoneRepository.js";

function withMockQuery(impl, fn) {
  const orig = pool.query;
  pool.query = impl;
  return fn().finally(() => { pool.query = orig; });
}

test("listZones scopes by tenant, and by site when siteId is supplied (AC 2.5)", async () => {
  const calls = [];
  await withMockQuery(async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ zone: "Cafeteria", zone_type: "break", tenant_id: params[0] }] };
  }, async () => {
    const noSite = await listZones({ tenantId: "t1" });
    assert.strictEqual(noSite[0].siteId, null);
    const namesNoSite = calls.find((c) => /SELECT DISTINCT/.test(c.sql));
    assert.strictEqual(namesNoSite.params.length, 1);

    calls.length = 0;
    const withSite = await listZones({ tenantId: "t1", siteId: 5 });
    assert.strictEqual(withSite[0].siteId, 5);
    const names = calls.find((c) => /SELECT DISTINCT/.test(c.sql));
    assert.deepStrictEqual(names.params, ["t1", 5]);
    assert.match(names.sql, /fd\.site_id = \$2/);
  });
});

test("listZones: adds live headcount, peak and entries per zone from the visit sweep (AC 7.1, 2.1)", async () => {
  await withMockQuery(async (sql) => {
    if (/SELECT DISTINCT/.test(sql)) return { rows: [{ zone: "Lobby", zone_type: "work" }, { zone: "ODC", zone_type: "work" }] };
    return { rows: [{ zone: "Lobby", live: 3, entries: 10, peak: 6 }] };
  }, async () => {
    const out = await listZones({ tenantId: "t1" });
    assert.deepStrictEqual(out.map((z) => [z.zone, z.liveHeadcount, z.peak, z.entries]), [["Lobby", 3, 6, 10], ["ODC", 0, 0, 0]]);
    for (const z of out) assert.ok(!("capacity" in z) && !("code" in z) && !("floor" in z));
  });
});

test("listZones: identical zone_label text in two different sites are two distinct calls, never merged (AC 2.5)", async () => {
  await withMockQuery(async (sql, params) => {
    // Simulate the same zone name existing under two different site scopes —
    // each call is scoped independently (never a single cross-site query).
    return { rows: [{ zone: "Cafeteria", zone_type: "break", tenant_id: params[0] }] };
  }, async () => {
    const siteA = await listZones({ tenantId: "t1", siteId: 1 });
    const siteB = await listZones({ tenantId: "t1", siteId: 2 });
    assert.strictEqual(siteA[0].zone, "Cafeteria");
    assert.strictEqual(siteB[0].zone, "Cafeteria");
    // Distinct by the siteId carried alongside the resolved name — this
    // repository never issues one merged query across sites.
    assert.notStrictEqual(siteA[0].siteId, siteB[0].siteId);
  });
});

test("listEntryPoints filters by zone param when supplied and resolves device role (AC 2.2)", async () => {
  const calls = [];
  await withMockQuery(async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ device_id: "CAM-01", device_label: "Main Entrance", zone: "Lobby" }] };
  }, async () => {
    const out = await listEntryPoints({ tenantId: "t1", zone: "Lobby" });
    assert.deepStrictEqual(out, [{ deviceId: "CAM-01", deviceLabel: "Main Entrance", zone: "Lobby" }]);
    assert.match(calls[0].sql, /site_device_assignment/);
    assert.doesNotMatch(calls[0].sql, /JOINs+site_device_assignment/i);
    assert.match(calls[0].sql, /camera_mode/);
  });
});

// Regression: a device with several active site_device_assignment rows (jetson-box-2 has 4) must not
// repeat its pings. Measured on the dev DB: 3,326 real entries were reported as 5,711 by a JOIN.
test("ping-based queries never JOIN site_device_assignment (would repeat a ping once per assignment)", async () => {
  const { getTraffic, getOccupancySeries, getHeatmap } = await import("../repositories/zoneRepository.js");
  for (const run of [
    () => getTraffic({ tenantId: "t1", siteId: 7, fromDate: "2026-09-01", toDate: "2026-09-21", tz: "UTC" }),
    () => getOccupancySeries({ tenantId: "t1", siteId: 7, fromDate: "2026-09-01", toDate: "2026-09-21", tz: "UTC" }, "hour"),
    () => getHeatmap({ tenantId: "t1", siteId: 7, fromDate: "2026-09-01", toDate: "2026-09-21", tz: "UTC" }),
  ]) {
    const seen = [];
    await withMockQuery(async (sql) => { seen.push(sql); return { rows: [] }; }, run);
    assert.ok(seen.length > 0);
    for (const sql of seen) assert.doesNotMatch(sql, /JOINs+site_device_assignment/i);
  }
});

test("listDepartments joins hr_department scoped by tenant (AC 2.3)", async () => {
  await withMockQuery(async (sql, params) => {
    assert.match(sql, /FROM hr_department/);
    assert.deepStrictEqual(params, ["t1"]);
    return { rows: [{ department_id: 3, name: "Engineering" }] };
  }, async () => {
    const out = await listDepartments({ tenantId: "t1" });
    assert.deepStrictEqual(out, [{ departmentId: 3, name: "Engineering" }]);
  });
});
