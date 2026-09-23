/**
 * specs/0003-zone-analytics — Task 16: /api/zones/employees and per-event
 * photos (AC 9.1-9.4, 9.6, 9.7, 9.9). pool.query is mocked and the generated
 * SQL + params are captured (no isolated Postgres — see WALKTHROUGH.md).
 * photoAccess.js and photoResolverService.js are NOT modified (human decision).
 */
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import express from "express";

process.env.NODE_ENV = "test";

const { pool } = await import("../db/pool.js");
const repo = await import("../repositories/zoneRepository.js");
const svc = await import("../services/business/ZoneAnalyticsService.js");
const { requirePermission } = await import("../middleware/authz.js");
const ZoneAnalyticsController = (await import("../controllers/ZoneAnalyticsController.js")).default;

const F = { tenantId: "t1", tz: "Asia/Kolkata", fromDate: "2026-09-21", toDate: "2026-09-21", timeRange: "full", minConfidence: null, zones: [], entryPointIds: [], departmentIds: [], cameraIds: [] };

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

const EMP_ROW = {
  employee_id: "7", employee_code: "E7", full_name: "Asha Rao", position_title: "Engineer", department: "Sales",
  visits: 4, minutes: "250.4", avg_visit: "62.6", entries: 4, exits: 3, avg_conf: "0.912345",
  first_seen: "2026-09-21T04:00:00Z", last_seen: "2026-09-21T09:00:00Z", zones: 2, currently_in: true,
  // summary columns + per-employee aggregates come back on the same row (ONE query)
  tracked: 12, mean_minutes: "90.4", mean_conf: "0.61", top_name: "Asha Rao", top_visits: 4,
  zone_minutes: [{ zone: "Lobby", visits: 3, minutes: 200 }, { zone: "ODC", visits: 1, minutes: 50 }],
  entry_flow: ["Lobby", "ODC"],
  entrances: [{ entrance: "Front", count: 2 }, { entrance: "Side", count: 2 }],
};
const LIST_NEEDLE = "FROM page p CROSS JOIN summ s";

test("AC 9.1/9.2: /employees rows carry totals, time-across-zones, recent flow, entrance usage and currentlyInZone", async () => {
  const { restore, calls } = route([[LIST_NEEDLE, [EMP_ROW]]]);
  try {
    const out = await repo.getEmployees(F, {});
    const r = out.rows[0];
    assert.strictEqual(r.employeeId, 7);
    assert.deepStrictEqual([r.name, r.role, r.department, r.primaryZone], ["Asha Rao", "Engineer", "Sales", "Lobby"]);
    assert.deepStrictEqual([r.totalZoneVisits, r.totalTimeInsideMinutes, r.avgVisitMinutes, r.entries, r.exits], [4, 250, 63, 4, 3]);
    assert.strictEqual(r.avgMatchConfidence, 0.912);
    assert.strictEqual(r.currentlyInZone, true);
    assert.deepStrictEqual(r.zoneMinutes, [{ zone: "Lobby", minutes: 200 }, { zone: "ODC", minutes: 50 }]);
    // consecutive same-zone entries collapse: Lobby -> ODC
    assert.deepStrictEqual(r.recentFlow, ["Lobby", "ODC"]);
    assert.deepStrictEqual(r.entranceUsage, [{ entrance: "Front", count: 2 }, { entrance: "Side", count: 2 }]);
    assert.strictEqual(out.total, 12);
    assert.deepStrictEqual(out.summary, { trackedEmployees: 12, meanTimeInZoneMinutes: 90, mostActiveEmployee: { name: "Asha Rao", zoneVisits: 4 }, meanMatchConfidence: 0.61 });
    // no initials/photo/avatar/spatial fields
    assert.ok(!/avatar|photo|floor|map_|capacity/i.test(JSON.stringify(out)));
    assert.strictEqual(calls.length, 1, "aggregation, page, summary, zone minutes, flow and entrances come from ONE query");
  } finally { restore(); }
});

test("AC 9.1: search / status / sort / paging are applied in SQL over the full result set", async () => {
  const { calls, restore } = route([]);
  try {
    await repo.getEmployees(F, { q: "asha", status: "long", sort: "confidence", dir: "asc", page: 2, pageSize: 10 });
  } finally { restore(); }
  const list = calls.find((c) => c.sql.includes(LIST_NEEDLE));
  assert.ok(list.params.includes("%asha%"));
  assert.match(list.sql, /a\.minutes >= 240/);
  assert.match(list.sql, /ORDER BY avg_conf ASC NULLS LAST, employee_id/);
  assert.deepStrictEqual(list.params.slice(-2), [10, 10]);
  assert.match(list.sql, /summ AS \(\s+SELECT COUNT\(\*\)::int AS tracked[\s\S]*FROM filtered/, "summary is over the whole filtered set, not just the page");
  for (const [status, frag] of [["currently", /AND a\.currently_in/], ["multi", /a\.zones > 1/]]) {
    const r = route([]);
    try { await repo.getEmployees(F, { status }); } finally { r.restore(); }
    assert.match(r.calls.find((c) => c.sql.includes(LIST_NEEDLE)).sql, frag);
  }
});

test("AC 9.1: sort column is whitelisted (no SQL injection through sort/dir)", async () => {
  const { calls, restore } = route([]);
  try { await repo.getEmployees(F, { sort: "1; DROP TABLE hr_employee", dir: "desc; --" }); } finally { restore(); }
  const list = calls.find((c) => c.sql.includes(LIST_NEEDLE));
  assert.doesNotMatch(list.sql, /DROP TABLE/);
  assert.match(list.sql, /ORDER BY minutes DESC NULLS LAST/);
});

test("AC 3.6/9.2: 'currently in zone' = last ping is an Entry AND it happened today; a previous-day open entry never counts", async () => {
  const { calls, restore } = route([]);
  try { await repo.getEmployees(F, {}); } finally { restore(); }
  const sql = calls.find((c) => c.sql.includes(LIST_NEEDLE)).sql;
  assert.match(sql, /p\.last_direction = 'entry' AND p\.last_seen >= \(\(date_trunc\('day', NOW\(\) AT TIME ZONE \$\d+\)\) AT TIME ZONE \$\d+\)/);
});

test("AC 9.9: employees honours the shared date range (Today / Week / Month / Custom are just fromDate/toDate)", async () => {
  const a = route([]);
  try { await repo.getEmployees({ ...F, fromDate: "2026-09-21", toDate: "2026-09-21" }, {}); } finally { a.restore(); }
  const b = route([]);
  try { await repo.getEmployees({ ...F, fromDate: "2026-09-01", toDate: "2026-09-30" }, {}); } finally { b.restore(); }
  assert.ok(a.calls[0].params.includes("2026-09-21"));
  assert.ok(b.calls[0].params.includes("2026-09-01") && b.calls[0].params.includes("2026-09-30"));
});

// ── per-event photos ────────────────────────────────────────────────────────

const PHOTO_SQL_NEEDLE = "JOIN device_events de";

test("AC 9.6: photo match SQL follows design.md 2.1 (tenant, device, type, +-60s sargable window, photo present, replay excluded, employee-id OR-list)", async () => {
  const { calls, restore } = route([[PHOTO_SQL_NEEDLE, []]]);
  try { await repo.matchEventPhotos([{ ping_id: 10 }, { ping_id: 11 }]); } finally { restore(); }
  const { sql, params } = calls[0];
  assert.deepStrictEqual(params, [["10", "11"].map(Number)]);
  assert.match(sql, /de\.tenant_id = ap\.tenant_id/);
  assert.match(sql, /de\.device_code = ap\.device_code/);
  assert.match(sql, /de\.event_type IN \('EMPLOYEE_ENTRY', 'EMPLOYEE_EXIT'\)/);
  assert.match(sql, /de\.occurred_at BETWEEN ap\.occurred_at - interval '60 seconds' AND ap\.occurred_at \+ interval '60 seconds'/);
  assert.match(sql, /de\.payload_json->>'photo_url' IS NOT NULL/);
  assert.match(sql, /de\.payload_json->>'event_time_raw' IS NULL/);
  for (const key of ["employee_code", "employeeCode", "employee_id", "employeeId"]) {
    assert.match(sql, new RegExp(`de\\.payload_json->>'${key}' IN \\(he\\.employee_code, he\\.pk_employee_id::text, he\\.person_id::text\\)`));
  }
  assert.doesNotMatch(sql, /ABS\(EXTRACT\(EPOCH FROM \(de\.occurred_at - ap\.occurred_at\)\)\) <= 60/, "un-sargable predicate times out on the live table");
  assert.doesNotMatch(sql, /INSERT|UPDATE |DELETE /);
});

test("AC 9.6: each photo is attached to at most one ping (closest first), and unmatched pings get none (AC 9.7)", async () => {
  const { restore } = route([[PHOTO_SQL_NEEDLE, [
    // ping 1 and ping 2 both see event E1; ping 1 is closer, so ping 2 must NOT reuse E1's photo
    { ping_id: "1", event_id: "E1", photo_url: "tenant-x/employee/E/2026-09-21/in/a_1.jpg", delta_seconds: 2 },
    { ping_id: "2", event_id: "E1", photo_url: "tenant-x/employee/E/2026-09-21/in/a_1.jpg", delta_seconds: 9 },
    { ping_id: "2", event_id: "E2", photo_url: "tenant-x/employee/E/2026-09-21/out/b_2.png", delta_seconds: 30 },
  ]]]);
  try {
    const m = await repo.matchEventPhotos([{ ping_id: 1 }, { ping_id: 2 }, { ping_id: 3 }]);
    assert.strictEqual(m.get("1"), "a_1.jpg");
    assert.strictEqual(m.get("2"), "b_2.png");
    assert.strictEqual(m.has("3"), false);
  } finally { restore(); }
});

test("AC 9.6: a replayed/stale event (event_time_raw) is excluded in SQL, so it can never produce a photo", async () => {
  const { calls, restore } = route([[PHOTO_SQL_NEEDLE, []]]);
  try { await repo.matchEventPhotos([{ ping_id: 5 }]); } finally { restore(); }
  assert.match(calls[0].sql, /event_time_raw' IS NULL/);
});

test("AC 9.6: photoUrl is a bare basename that passes the existing verifyPhotoAccess regex; anything else becomes null", () => {
  const gate = /^[\w-]+\.(jpg|jpeg|png|gif|webp)$/i; // photoAccess.js:66
  const photoAccessSrc = fs.readFileSync(new URL("../middleware/photoAccess.js", import.meta.url), "utf8");
  assert.ok(photoAccessSrc.includes("/^[\\w-]+\\.(jpg|jpeg|png|gif|webp)$/i"), "regex copied from the real gate");
  const stored = "tenant-5aa1dbdd-d15f-4766-bdd7-6ca864cbd065/employee/MLI1527/2026-09-21/in/Pavani_Manne_2026-09-21_07-56-14-794.jpg";
  assert.strictEqual(repo.toPhotoBasename(stored), "Pavani_Manne_2026-09-21_07-56-14-794.jpg");
  assert.ok(gate.test(repo.toPhotoBasename(stored)));
  assert.strictEqual(repo.toPhotoBasename("/uploads/x.jpg?sig=1"), "x.jpg");
  for (const bad of [null, undefined, "", "folder/", "no-extension", "evil name.jpg", "../../etc/passwd", "a.exe", "https://h/x/y.jpg#frag "]) {
    assert.strictEqual(repo.toPhotoBasename(bad), null, String(bad));
  }
});

test("AC 9.6/9.7: employee events carry photoUrl per ping; unmatched -> null ('No photo recorded'); run only for one employee", async () => {
  const r = route([
    ["ORDER BY ap.occurred_at ASC\n    LIMIT", [
      { ping_id: "1", ts: "2026-09-21T04:00:00Z", event_type: "entry", zone: "Lobby", entrance: "Front", confidence: "0.8", camera_id: "C1" },
      { ping_id: "2", ts: "2026-09-21T05:00:00Z", event_type: "exit", zone: "Lobby", entrance: "Front", confidence: null, camera_id: "C1" },
    ]],
    [PHOTO_SQL_NEEDLE, [{ ping_id: "1", event_id: "E1", photo_url: "t/employee/x/d/in/p1.jpg", delta_seconds: 1 }]],
  ]);
  try {
    const ev = await repo.getEmployeeEvents({ tenantId: "t1", employeeId: 7, fromDate: "2026-09-21", toDate: "2026-09-21", tz: "Asia/Kolkata", withPhotos: true });
    assert.deepStrictEqual(ev.map((e) => e.photoUrl), ["p1.jpg", null]);
    assert.strictEqual(ev[0].confidence, 0.8);
    const q = r.calls.find((c) => /LIMIT/.test(c.sql));
    assert.ok(q.params.includes(7), "scoped to the one employee");
    assert.ok(q.params.includes("t1"));
    assert.ok(q.params.some((p) => p === 200), "capped at 200 events");
  } finally { r.restore(); }
});

test("AC 9.6: day-level check-in / check-out photos are the fallback, as bare filenames", async () => {
  const { calls, restore } = route([["FROM attendance_record", [
    { date: "2026-09-21", checkin_photo_url: "tenant-x/employee/E/2026-09-21/in/in_1.jpg", checkout_photo_url: null },
  ]]]);
  try {
    const out = await repo.getEmployeeDailyPhotos({ tenantId: "t1", employeeId: 7, fromDate: "2026-09-21", toDate: "2026-09-21" });
    assert.deepStrictEqual(out, [{ date: "2026-09-21", checkInPhotoUrl: "in_1.jpg", checkOutPhotoUrl: null }]);
    assert.match(calls[0].sql, /FROM attendance_record/);
    assert.doesNotMatch(calls[0].sql, /attendance_ping/);
  } finally { restore(); }
});

test("AC 9.5: movement timeline returns transitions + events + dailyPhotos and validates employeeId", async () => {
  const { restore } = route([
    ["ORDER BY ap.occurred_at ASC\n    LIMIT", [{ ping_id: "1", ts: "2026-09-21T04:00:00Z", event_type: "entry", zone: "Lobby", entrance: "Front", confidence: null, camera_id: "C1" }]],
    ["AS direction,\n      ap.occurred_at", [{ zone: "Lobby", direction: "entry", occurred_at: "2026-09-21T04:00:00Z" }]],
  ]);
  try {
    const out = await svc.getMovementTimeline({ tenantId: "t1" }, "7", { fromDate: "2026-09-21", toDate: "2026-09-21", tz: "Asia/Kolkata" });
    assert.deepStrictEqual(Object.keys(out).sort(), ["dailyPhotos", "events", "transitions"]);
    assert.strictEqual(out.events[0].photoUrl, null);
    await assert.rejects(() => svc.getMovementTimeline({ tenantId: "t1" }, "abc", {}), svc.ValidationError);
    await assert.rejects(() => svc.getMovementTimeline({ tenantId: "t1" }, "7", { tz: "Nope/Zone" }), svc.ValidationError);
  } finally { restore(); }
});

test("hard constraint: photoAccess.js and photoResolverService.js carry no zone-analytics branch (unmodified, re-checked by git diff at final acceptance)", async () => {
  // Human decision (Revision 8): the /uploads gate stays as shipped. The files keep their original markers.
  const pa = fs.readFileSync(new URL("../middleware/photoAccess.js", import.meta.url), "utf8");
  const pr = fs.readFileSync(new URL("../services/photoResolverService.js", import.meta.url), "utf8");
  assert.ok(pa.includes("export async function tenantOwnsPhoto") && !/unauthorized_access_log/.test(pa));
  assert.ok(pr.includes("export async function resolvePhotoByFilename") && !/unauthorized_access_log/.test(pr));
});

test("GET /api/zones/employees over HTTP: { data: { rows, total, summary } }, 400 on bad status", async () => {
  const app = express();
  app.use((req, _res, next) => { req.auth = { scope: { tenantId: "t1", siteId: null }, memberships: [{ scope: { siteId: null }, permissions: ["zones.read"] }] }; next(); });
  app.use(requirePermission("zones.read"));
  app.get("/api/zones/employees", (req, res, next) => ZoneAnalyticsController.getEmployees(req, res).catch(next));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = route([[LIST_NEEDLE, [{ ...EMP_ROW, tracked: 1 }]]]);
  try {
    const ok = await fetch(`${base}/api/zones/employees?fromDate=2026-09-21&toDate=2026-09-21&status=currently&sort=visits&dir=desc`);
    assert.strictEqual(ok.status, 200);
    const body = await ok.json();
    assert.strictEqual(body.data.total, 1);
    assert.strictEqual(body.data.rows[0].name, "Asha Rao");
    assert.ok(body.data.summary.trackedEmployees === 1);
    assert.strictEqual((await fetch(`${base}/api/zones/employees?status=bogus`)).status, 400);
  } finally {
    r.restore();
    await new Promise((res) => server.close(res));
  }
});
