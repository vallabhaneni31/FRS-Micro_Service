/**
 * specs/0003-zone-analytics — Task 15: unified events feed (Entry / Exit /
 * Unknown Face / Camera Offline) — AC 4.1-4.4, 5.1-5.5, 3.9.
 * pool.query is mocked (no isolated Postgres — see WALKTHROUGH.md); tests
 * capture the generated SQL + params and check the JS mapping of mocked rows.
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

async function withCapture(fn, { feedRows = [], total = 0 } = {}) {
  const calls = [];
  const orig = pool.query;
  pool.query = async (sql, params) => {
    calls.push({ sql, params: params ?? [] });
    // ONE query: the total rides on every row as COUNT(*) OVER ()
    if (/FROM feed WHERE TRUE/.test(sql)) return { rows: feedRows.map((r) => ({ ...r, total_count: total })) };
    return { rows: [] };
  };
  try { return { result: await fn(), calls }; } finally { pool.query = orig; }
}

const PING = { id: "p10", ping_id: "10", ts: "2026-09-21T09:00:00Z", event_type: "entry", employee_id: "5", employee_code: "E5", employee_name: "Jane Doe", entrance: "Front", zone: "Lobby", status: "verified", confidence: 0.91, camera_id: "CAM-1", details: null, image_url: null };
const UNKNOWN = { id: "u7", ping_id: null, ts: "2026-09-21T09:05:00Z", event_type: "unknown_face", employee_id: null, employee_code: null, employee_name: null, entrance: "Front", zone: "Lobby", status: "unrecognized", confidence: null, camera_id: "CAM-1", details: "Visitor (unregistered)", image_url: "tenant-x/visitor/abc/2026-09-21/in/Visitor_abc.jpg" };
const OFFLINE = { id: "o3", ping_id: null, ts: "2026-09-21T09:10:00Z", event_type: "camera_offline", employee_id: null, employee_code: null, employee_name: null, entrance: "Side", zone: "ODC", status: "system", confidence: null, camera_id: "CAM-2", details: "Camera stopped responding", image_url: null };

test("AC 4.1/5.2: Entry/Exit are Verified with confidence, Unknown Face is Unrecognized, Camera Offline is System", async () => {
  const { result } = await withCapture(() => repo.getRecentEvents(F, { page: 1, pageSize: 20 }), { feedRows: [PING, UNKNOWN, OFFLINE], total: 3 });
  const [p, u, o] = result.rows;
  assert.deepStrictEqual([p.eventType, p.recognitionStatus, p.confidence, p.employeeName, p.employeeId, p.employeeCode], ["entry", "verified", 0.91, "Jane Doe", 5, "E5"]);
  assert.deepStrictEqual([u.eventType, u.recognitionStatus, u.employeeName, u.employeeId, u.details], ["unknown_face", "unrecognized", null, null, "Visitor (unregistered)"]);
  assert.deepStrictEqual([o.eventType, o.recognitionStatus, o.confidence], ["camera_offline", "system", null]);
  assert.strictEqual(result.total, 3);
  assert.deepStrictEqual(Object.keys(p).sort(), ["cameraId", "confidence", "details", "employeeCode", "employeeId", "employeeName", "entrance", "eventType", "id", "photoUrl", "recognitionStatus", "timestamp", "zone"]);
});

test("AC 5.1: unknown-face rows never carry a name or identity", async () => {
  const { result } = await withCapture(() => repo.getRecentEvents(F, {}), { feedRows: [UNKNOWN] });
  const u = result.rows[0];
  assert.strictEqual(u.employeeName, null);
  assert.strictEqual(u.employeeId, null);
  assert.strictEqual(u.employeeCode, null);
});

test("AC 4.3/5.4: no failed-recognition, latency, attempts, SLA or 'unauthorized access' event type or field", async () => {
  assert.deepStrictEqual(repo.EVENT_TYPES, ["entry", "exit", "unknown_face", "camera_offline"]);
  const { result } = await withCapture(() => repo.getRecentEvents(F, {}), { feedRows: [PING, UNKNOWN, OFFLINE] });
  const json = JSON.stringify(result).toLowerCase();
  for (const banned of ["failed", "failure", "latency", "attempt", "sla", "unauthorized_access", "tailgat", "after-hours", "after_hours"]) {
    assert.ok(!json.includes(banned), `events response contains '${banned}'`);
  }
  await assert.rejects(() => svc.getRecentEvents(F, { eventType: "unauthorized_access" }), svc.ValidationError);
});

test("AC 5.1: unknown faces read unauthorized_access_log via the facility_device join (tenant_id is never written there)", async () => {
  const { calls } = await withCapture(() => repo.getRecentEvents(F, {}));
  const sql = calls[0].sql;
  assert.match(sql, /FROM unauthorized_access_log u\s+JOIN dev fd ON fd\.pk_device_id::text = u\.device_id/);
  // the device map (dev) is the tenant-scoped facility_device set, one row per device
  const devCte = sql.split("dev AS (")[1].split("feed AS (")[0];
  assert.match(devCte, /FROM facility_device fd/);
  assert.match(devCte, /fd\.tenant_id = \$\d+::uuid/);
  assert.match(devCte, /DISTINCT ON \(fd\.pk_device_id\)/, "no per-assignment duplicates");
  assert.doesNotMatch(sql.split("FROM unauthorized_access_log u")[1].split("UNION ALL")[0], /u\.tenant_id/);
  assert.match(sql, /FROM device_status_history h\s+JOIN dev fd ON fd\.pk_device_id = h\.device_id/);
  assert.match(sql, /h\.new_status = 'offline'/);
});

test("AC 5.3: event type + status + search + page all reach SQL with a matching total query", async () => {
  const { calls } = await withCapture(() => repo.getRecentEvents(F, { page: 3, pageSize: 10, eventType: "entry", status: "verified", q: "jane" }), { feedRows: [PING], total: 27 });
  assert.strictEqual(calls.length, 1, "page and total come from one query");
  const [page] = calls;
  // type and search are params; paging is LIMIT/OFFSET params in SQL, not slicing in JS
  assert.ok(page.params.includes("entry"));
  assert.ok(page.params.includes("%jane%"));
  assert.deepStrictEqual(page.params.slice(-2), [10, 20]);
  assert.match(page.sql, /LIMIT \$\d+ OFFSET \$\d+/);
  // the total is computed over the same filtered set in the same statement
  assert.match(page.sql, /COUNT\(\*\) OVER \(\)::int AS total_count FROM feed WHERE TRUE/);
  assert.strictEqual(page.sql.split("feed AS (").length, 2, "feed CTE is defined and run once");
  // status=verified can only be satisfied by the ping branch
  assert.doesNotMatch(page.sql, /unauthorized_access_log|device_status_history/);
});

test("AC 5.3: search text is LIKE-escaped, never concatenated into SQL", async () => {
  const { calls } = await withCapture(() => repo.getRecentEvents(F, { q: "100%_x'; DROP TABLE hr_employee;--" }));
  assert.ok(calls[0].params.includes("%100\\%\\_x'; DROP TABLE hr\\_employee;--%"));
  assert.doesNotMatch(calls[0].sql, /DROP TABLE/);
});

test("AC 5.3: type/status combinations that cannot match return an empty page without touching the DB", async () => {
  const { result, calls } = await withCapture(() => repo.getRecentEvents(F, { eventType: "entry", status: "system" }));
  assert.deepStrictEqual(result, { rows: [], total: 0 });
  assert.strictEqual(calls.length, 0);
});

test("AC 5.5: no rows in range -> empty result with total 0, never a placeholder row", async () => {
  const { result } = await withCapture(() => repo.getRecentEvents(F, {}), { feedRows: [], total: 0 });
  assert.deepStrictEqual(result, { rows: [], total: 0 });
});

test("AC 3.9(b): department and confidence filters do not hide unknown-face or camera-offline rows", async () => {
  const { calls } = await withCapture(() => repo.getRecentEvents({ ...F, departmentIds: ["3"], minConfidence: 0.9 }, {}));
  const sql = calls[0].sql;
  const pingBranch = sql.split("UNION ALL")[0];
  assert.match(pingBranch, /he\.fk_department_id = ANY/);
  assert.match(pingBranch, /ap\.confidence >= /);
  for (const branch of sql.split("UNION ALL").slice(1)) {
    assert.doesNotMatch(branch, /fk_department_id/);
    assert.doesNotMatch(branch, /confidence >= /);
  }
});

test("AC 3.9: zone, entrance, camera, date and time interval apply to ALL three sources", async () => {
  const { calls } = await withCapture(() => repo.getRecentEvents({ ...F, zones: ["Lobby"], entryPointIds: ["E1"], cameraIds: ["C1"], timeRange: "morning" }, {}));
  const sql = calls[0].sql;
  // device-level filters (zone, entrance, camera) are applied once in the device map every device-derived branch joins
  const devCte = sql.split("dev AS (")[1].split("feed AS (")[0];
  assert.strictEqual((devCte.match(/= ANY\(\$\d+::text\[\]\)/g) || []).length, 3);
  const branches = sql.split("feed AS (")[1].split("UNION ALL");
  assert.strictEqual(branches.length, 4);
  for (const b of branches) {
    assert.match(b, /::date::timestamp AT TIME ZONE/);
    assert.match(b, /EXTRACT\(HOUR FROM/);
  }
  for (const b of branches.slice(1)) assert.match(b, /JOIN dev fd/);
  assert.match(branches[0], /= ANY\(\$\d+::text\[\]\)/);
});

test("AC 3.9(c): securityOnly returns only unknown_face/camera_offline; ping table is not read", async () => {
  const { calls } = await withCapture(() => repo.getRecentEvents({ ...F, securityOnly: true }, {}));
  assert.doesNotMatch(calls[0].sql, /FROM attendance_ping ap/);
});

test("photoUrl: unknown-face photo is a bare basename inside the 90-day window, null once retention has passed (AC 9.6, 9.7)", async () => {
  const recent = { ...UNKNOWN, ts: new Date().toISOString() };
  const old = { ...UNKNOWN, id: "u8", ts: new Date(Date.now() - 100 * 86400000).toISOString() };
  const { result } = await withCapture(() => repo.getRecentEvents(F, {}), { feedRows: [recent, old] });
  assert.strictEqual(result.rows[0].photoUrl, "Visitor_abc.jpg");
  assert.strictEqual(result.rows[1].photoUrl, null);
  assert.match(result.rows[0].photoUrl, /^[\w-]+\.(jpg|jpeg|png|gif|webp)$/i);
});

test("AC 4.3/5.4: no zone-analytics source performs any write (SQL scan of repository, service, controller, routes)", () => {
  const files = ["../repositories/zoneRepository.js", "../services/business/ZoneAnalyticsService.js", "../controllers/ZoneAnalyticsController.js", "../routes/zoneRoutes.js"];
  for (const f of files) {
    const src = fs.readFileSync(new URL(f, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(src, /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|ALTER\s+TABLE|audit_log)\b/i, f);
  }
  const routes = fs.readFileSync(new URL("../routes/zoneRoutes.js", import.meta.url), "utf8");
  assert.doesNotMatch(routes, /router\.(post|put|patch|delete)\(/);
});

test("GET /api/zones/events/recent: { data: { rows, total } } over HTTP; 400 on unknown eventType", async () => {
  const app = express();
  app.use((req, _res, next) => { req.auth = { scope: { tenantId: "t1", siteId: null }, memberships: [{ scope: { siteId: null }, permissions: ["zones.read"] }] }; next(); });
  app.use(requirePermission("zones.read"));
  app.get("/api/zones/events/recent", (req, res, next) => ZoneAnalyticsController.getRecentEvents(req, res).catch(next));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const orig = pool.query;
  pool.query = async (sql) => (/FROM feed WHERE TRUE/.test(sql) ? { rows: [{ ...PING, total_count: 1 }] } : { rows: [] });
  try {
    const ok = await fetch(`${base}/api/zones/events/recent?fromDate=2026-09-21&toDate=2026-09-21&eventType=entry&page=1&pageSize=5`);
    assert.strictEqual(ok.status, 200);
    const body = await ok.json();
    assert.strictEqual(body.data.total, 1);
    assert.strictEqual(body.data.rows[0].recognitionStatus, "verified");
    assert.strictEqual((await fetch(`${base}/api/zones/events/recent?eventType=bogus`)).status, 400);
  } finally {
    pool.query = orig;
    await new Promise((r) => server.close(r));
  }
});
