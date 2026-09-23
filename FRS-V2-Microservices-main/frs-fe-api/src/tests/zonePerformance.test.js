/**
 * specs/0003-zone-analytics — Task 27 (AC 12.2, 12.3, 12.8, 5.6): query rewrites,
 * concurrency-free single queries, opt-in photos and the person-type filter.
 * pool.query is mocked and the generated SQL + params captured; there is no
 * isolated Postgres (the rewrites were also run read-only against the dev DB,
 * see WALKTHROUGH.md).
 */
import test from "node:test";
import assert from "node:assert";

process.env.NODE_ENV = "test";

const { pool } = await import("../db/pool.js");
const repo = await import("../repositories/zoneRepository.js");
const svc = await import("../services/business/ZoneAnalyticsService.js");

const F = { tenantId: "t1", tz: "Asia/Kolkata", fromDate: "2026-09-21", toDate: "2026-09-21", timeRange: "full", minConfidence: null, zones: [], entryPointIds: [], departmentIds: [], cameraIds: [] };

function capture(rowsFor = () => []) {
  const calls = [];
  const orig = pool.query;
  pool.query = async (sql, params) => { calls.push({ sql, params: params ?? [] }); return { rows: rowsFor(sql, params) }; };
  return { calls, restore: () => { pool.query = orig; } };
}

const PING = { id: "p10", ping_id: "10", ts: "2026-09-21T09:00:00Z", event_type: "entry", employee_id: "5", employee_code: "E5", employee_name: "Jane", entrance: "Front", zone: "Lobby", status: "verified", confidence: 0.9, camera_id: "C1", details: null, image_url: null };

const branchesOf = (sql) => {
  const feed = sql.split("feed AS (")[1] || "";
  return {
    ping: /FROM attendance_ping ap/.test(feed),
    unknown: /FROM unauthorized_access_log u/.test(feed),
    offline: /FROM device_status_history h/.test(feed),
    visitor: /FROM person p\s+JOIN device_events de/.test(feed),
  };
};
const feedSqlFor = async (opts, filters = F) => {
  const c = capture();
  try { await repo.getRecentEvents(filters, opts); } finally { c.restore(); }
  return c.calls[0]?.sql ?? null;
};

// ── AC 5.6 person type ───────────────────────────────────────────────────────
test("AC 5.6: personType=all reads all four branches (Entry/Exit, unknown face, camera offline, registered visitor)", async () => {
  assert.deepStrictEqual(branchesOf(await feedSqlFor({})), { ping: true, unknown: true, offline: true, visitor: true });
  assert.deepStrictEqual(branchesOf(await feedSqlFor({ personType: undefined })), { ping: true, unknown: true, offline: true, visitor: true });
});

test("AC 5.6: personType=employee reads only attendance_ping (Camera Offline and visitors hidden)", async () => {
  assert.deepStrictEqual(branchesOf(await feedSqlFor({ personType: "employee" })), { ping: true, unknown: false, offline: false, visitor: false });
});

test("AC 5.6: personType=visitor reads unauthorized_access_log + registered-visitor detections; never pings or Camera Offline", async () => {
  const sql = await feedSqlFor({ personType: "visitor" });
  assert.deepStrictEqual(branchesOf(sql), { ping: false, unknown: true, offline: false, visitor: true });
  // registered visitors: device_events FACE_DETECTED joined through fk_person_id to person_type 'visitor', tenant-scoped
  assert.match(sql, /JOIN device_events de ON de\.fk_person_id = p\.person_id AND de\.event_type = 'FACE_DETECTED'/);
  assert.match(sql, /p\.person_type = 'visitor' AND p\.tenant_id = \$\d+::uuid/);
  assert.match(sql, /JOIN dev fd ON fd\.external_device_id = de\.device_code/, "scoped by tenant through the facility_device device map");
});

test("AC 5.6: visitor rows carry no employee id, code, name or direction; unknown face reads 'Visitor (unregistered)'", async () => {
  const c = capture(() => [
    { id: "u1", ping_id: null, ts: "2026-09-21T09:00:00Z", event_type: "unknown_face", employee_id: null, employee_code: null, employee_name: null, entrance: "Front", zone: "Lobby", status: "unrecognized", confidence: null, camera_id: "C1", details: "Visitor (unregistered)", image_url: null, total_count: 2 },
    { id: "v1", ping_id: null, ts: "2026-09-21T09:01:00Z", event_type: "visitor_detected", employee_id: null, employee_code: null, employee_name: null, entrance: "Front", zone: "Lobby", status: "verified", confidence: 0.8, camera_id: "C1", details: "Registered visitor: Ann", image_url: null, total_count: 2 },
  ]);
  try {
    const out = await repo.getRecentEvents(F, { personType: "visitor" });
    assert.strictEqual(out.total, 2);
    for (const r of out.rows) {
      assert.deepStrictEqual([r.employeeId, r.employeeCode, r.employeeName], [null, null, null]);
      assert.ok(!("direction" in r) && !("department" in r));
    }
    assert.strictEqual(out.rows[0].details, "Visitor (unregistered)");
  } finally { c.restore(); }
  assert.doesNotMatch(await feedSqlFor({ personType: "visitor" }), /Unregistered person/);
});

test("AC 5.6: person type combines with eventType / status / securityOnly (branches intersect; impossible combos never hit the DB)", async () => {
  assert.deepStrictEqual(branchesOf(await feedSqlFor({ personType: "employee", eventType: "entry" })), { ping: true, unknown: false, offline: false, visitor: false });
  assert.deepStrictEqual(branchesOf(await feedSqlFor({ personType: "visitor", eventType: "unknown_face" })), { ping: false, unknown: true, offline: false, visitor: false });
  assert.deepStrictEqual(branchesOf(await feedSqlFor({ personType: "visitor", status: "verified" })), { ping: false, unknown: false, offline: false, visitor: true });
  assert.deepStrictEqual(branchesOf(await feedSqlFor({ personType: "all", status: "unrecognized" })), { ping: false, unknown: true, offline: false, visitor: false });
  // securityOnly = Unknown Face + Camera Offline only
  assert.deepStrictEqual(branchesOf(await feedSqlFor({ personType: "all" }, { ...F, securityOnly: true })), { ping: false, unknown: true, offline: true, visitor: false });
  assert.deepStrictEqual(branchesOf(await feedSqlFor({ personType: "visitor" }, { ...F, securityOnly: true })), { ping: false, unknown: true, offline: false, visitor: false });
  // Camera Offline belongs to neither group: employee/visitor + camera_offline is empty without a query
  for (const personType of ["employee", "visitor"]) {
    const c = capture();
    try { assert.deepStrictEqual(await repo.getRecentEvents(F, { personType, eventType: "camera_offline" }), { rows: [], total: 0 }); } finally { c.restore(); }
    assert.strictEqual(c.calls.length, 0);
  }
  // search still reaches SQL
  const c = capture();
  try { await repo.getRecentEvents(F, { personType: "visitor", q: "lobby" }); } finally { c.restore(); }
  assert.ok(c.calls[0].params.includes("%lobby%"));
});

test("AC 5.6: service validates personType and forwards it (all = no restriction)", async () => {
  await assert.rejects(() => svc.getRecentEvents(F, { personType: "guest" }), svc.ValidationError);
  const c = capture();
  try {
    await svc.getRecentEvents(F, { personType: "employee" });
    await svc.getRecentEvents(F, { personType: "all" });
  } finally { c.restore(); }
  assert.deepStrictEqual(branchesOf(c.calls[0].sql), { ping: true, unknown: false, offline: false, visitor: false });
  assert.deepStrictEqual(branchesOf(c.calls[1].sql), { ping: true, unknown: true, offline: true, visitor: true });
});

test("AC 5.6: the person-type totals are correct: total is the window count of the filtered set, page past the end still reports it", async () => {
  let n = 0;
  const c = capture((sql, params) => {
    n += 1;
    // first call: page 7 is past the end (no rows); second: the fallback first-row read carries the total
    return n === 1 ? [] : [{ ...PING, total_count: 42 }];
  });
  try {
    const out = await repo.getRecentEvents(F, { page: 7, pageSize: 10, personType: "employee" });
    assert.strictEqual(out.total, 42);
    assert.deepStrictEqual(out.rows, []);
    assert.strictEqual(c.calls.length, 2);
    assert.deepStrictEqual(c.calls[1].params.slice(-2), [1, 0]);
  } finally { c.restore(); }
});

test("AC 5.6/12.8: registered-visitor branch is read-only SQL on existing columns", async () => {
  const sql = await feedSqlFor({ personType: "visitor" });
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|CREATE)\b/i);
});

// ── AC 12.2 query counts / duplicate CTE ─────────────────────────────────────
test("AC 12.2: getRecentEvents is ONE query with COUNT(*) OVER () and one feed CTE (was three queries, CTE twice)", async () => {
  const c = capture(() => [{ ...PING, total_count: 5 }]);
  try {
    const out = await repo.getRecentEvents(F, { page: 1, pageSize: 20 });
    assert.strictEqual(out.total, 5);
  } finally { c.restore(); }
  assert.strictEqual(c.calls.length, 1);
  assert.match(c.calls[0].sql, /COUNT\(\*\) OVER \(\)::int AS total_count/);
  assert.strictEqual(c.calls[0].sql.split("feed AS (").length, 2);
});

test("AC 12.2: getEmployees is ONE query (aggregation, page, summary, zone minutes, flow, entrances)", async () => {
  const c = capture(() => []);
  try { await repo.getEmployees(F, {}); } finally { c.restore(); }
  assert.strictEqual(c.calls.length, 1);
  for (const frag of ["page AS (", "summ AS (", "zone_minutes", "entry_flow", "entrances"]) assert.ok(c.calls[0].sql.includes(frag), frag);
});

test("AC 12.2: getEmployees past the last page still returns the summary (one extra read of the first row)", async () => {
  let n = 0;
  const c = capture(() => (++n === 1 ? [] : [{ employee_id: "1", tracked: 3, mean_minutes: "10", mean_conf: "0.5", top_name: "A", top_visits: 2, zone_minutes: [], entry_flow: [], entrances: [], visits: 1, minutes: "1", entries: 1, exits: 0 }]));
  try {
    const out = await repo.getEmployees(F, { page: 5, pageSize: 10 });
    assert.deepStrictEqual(out.rows, []);
    assert.strictEqual(out.total, 3);
    assert.strictEqual(out.summary.trackedEmployees, 3);
  } finally { c.restore(); }
});

test("AC 12.2: getHourlyProfile is ONE query (was three) and returns the same shape", async () => {
  const c = capture(() => [
    { kind: "traffic", zone: "Lobby", hour: 9, entries: 3, exits: 1 },
    { kind: "occ", hour: 9, avg_occ: 2, peak_occ: 3 },
    { kind: "moment", t: "2026-09-21T09:00:00Z", occ: 3 },
  ]);
  try {
    const p = await repo.getHourlyProfile(F);
    assert.deepStrictEqual(p.hourly, [{ hour: 9, entries: 3, exits: 1, traffic: 4, avgOccupancy: 2, peakOccupancy: 3 }]);
    assert.deepStrictEqual(p.byZone, [{ zone: "Lobby", hour: 9, entries: 3, exits: 1 }]);
    assert.deepStrictEqual(p.peakMoment, { at: "2026-09-21T09:00:00Z", count: 3 });
  } finally { c.restore(); }
  assert.strictEqual(c.calls.length, 1);
});

test("AC 12.2: listEntryPoints reduces the pings to distinct devices before the device joins", async () => {
  const c = capture(() => [{ device_id: "C1", device_label: "Front", zone: "Lobby" }]);
  try { assert.deepStrictEqual(await repo.listEntryPoints({ tenantId: "t1" }), [{ deviceId: "C1", deviceLabel: "Front", zone: "Lobby" }]); } finally { c.restore(); }
  assert.strictEqual(c.calls.length, 1);
  assert.match(c.calls[0].sql, /WITH ap AS \(\s+SELECT DISTINCT tenant_id, device_code FROM attendance_ping/);
  assert.match(c.calls[0].sql, /FROM ap\s/);
});

// ── AC 12.3 photos opt-in ────────────────────────────────────────────────────
test("AC 12.3: a list load never queries device_events for photos (Recent Zone Events, default)", async () => {
  const c = capture(() => [{ ...PING, total_count: 1 }]);
  try {
    const out = await repo.getRecentEvents(F, { page: 1, pageSize: 20 });
    assert.strictEqual(out.rows[0].photoUrl, null);
  } finally { c.restore(); }
  assert.strictEqual(c.calls.filter((x) => /JOIN device_events de\s+ON de\.tenant_id/.test(x.sql)).length, 0);
  assert.strictEqual(c.calls.length, 1);
});

test("AC 12.3: withPhotos=1 runs the photo match once, for the page's pings only", async () => {
  const c = capture((sql) => (/JOIN device_events de\s+ON de\.tenant_id/.test(sql)
    ? [{ ping_id: "10", event_id: "E1", photo_url: "t/x/p.jpg", delta_seconds: 1 }]
    : [{ ...PING, total_count: 1 }]));
  try {
    const out = await repo.getRecentEvents(F, { withPhotos: true });
    assert.strictEqual(out.rows[0].photoUrl, "p.jpg");
  } finally { c.restore(); }
  assert.strictEqual(c.calls.length, 2);
});

test("AC 12.3: movement events ask for photos only with withPhotos; the service forwards the flag", async () => {
  const route = (withPhotos) => {
    const c = capture((sql) => (/LIMIT/.test(sql) && /ORDER BY ap\.occurred_at ASC/.test(sql) ? [{ ping_id: "1", ts: "2026-09-21T04:00:00Z", event_type: "entry", zone: "L", entrance: "F", confidence: null, camera_id: "C" }] : []));
    return svc.getMovementTimeline({ tenantId: "t1" }, "7", { fromDate: "2026-09-21", toDate: "2026-09-21", tz: "Asia/Kolkata", withPhotos }).finally(() => c.restore()).then(() => c.calls);
  };
  const without = await route(false);
  assert.strictEqual(without.filter((x) => /JOIN device_events de/.test(x.sql)).length, 0);
  const withIt = await route(true);
  assert.strictEqual(withIt.filter((x) => /JOIN device_events de/.test(x.sql)).length, 1);
});

// ── AC 12.8 no schema change ─────────────────────────────────────────────────
test("AC 12.8: no CREATE/ALTER/INDEX statement anywhere in the zone repository or the timing scripts' SQL", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../repositories/zoneRepository.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /\b(CREATE\s+(INDEX|TABLE|VIEW)|ALTER\s+TABLE|DROP\s+(INDEX|TABLE)|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i);
});

test("AC 12.2: getMovementMatrix starts its two independent queries together (transitions and most-visited)", async () => {
  let started = 0;
  let startedWhenFirstResolved = 0;
  const orig = pool.query;
  pool.query = async () => {
    started += 1;
    await new Promise((r) => setTimeout(r, 20));
    if (!startedWhenFirstResolved) startedWhenFirstResolved = started;
    return { rows: [] };
  };
  try { await repo.getMovementMatrix({ ...F, employeeId: null, departmentId: null }); } finally { pool.query = orig; }
  assert.strictEqual(started, 2);
  assert.strictEqual(startedWhenFirstResolved, 2, "both queries were in flight before the first one finished");
});
