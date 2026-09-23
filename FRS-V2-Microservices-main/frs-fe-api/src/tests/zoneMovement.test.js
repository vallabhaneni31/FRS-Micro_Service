/**
 * specs/0003-zone-analytics — Task 8: /api/zones/movement/:employeeId and
 * /api/zones/movement/matrix, incl. AC 9.5's dailyPhotos follow-up (added to
 * the spec mid-build — see WALKTHROUGH.md).
 */
import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import express from "express";

process.env.NODE_ENV = "test";

const { requirePermission } = await import("../middleware/authz.js");
const { pool } = await import("../db/pool.js");
const ZoneAnalyticsController = (await import("../controllers/ZoneAnalyticsController.js")).default;
const repo = await import("../repositories/zoneRepository.js");

function authStub() {
  return (req, _res, next) => {
    req.auth = { scope: { tenantId: "t1", siteId: null }, memberships: [{ scope: { siteId: null }, permissions: ["zones.read"] }] };
    next();
  };
}

function buildApp() {
  const app = express();
  app.use(authStub());
  app.use(requirePermission("zones.read"));
  app.get("/api/zones/movement/matrix", (req, res, next) => ZoneAnalyticsController.getMovementMatrix(req, res).catch(next));
  app.get("/api/zones/movement/:employeeId", (req, res, next) => ZoneAnalyticsController.getMovementTimeline(req, res).catch(next));
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try { await fn(`http://127.0.0.1:${port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
}

function mockPoolSequence(sequence) {
  const orig = pool.query;
  const queue = [...sequence];
  pool.query = async () => (queue.length ? queue.shift() : { rows: [] });
  return () => { pool.query = orig; };
}

test("GET /api/zones/movement/:employeeId — empty timeline for an employee with zero transitions is not an error", async () => {
  const restore = mockPoolSequence([{ rows: [] }, { rows: [] }]);
  try {
    const app = buildApp();
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/zones/movement/9999`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.deepStrictEqual(body.data.transitions, []);
      assert.deepStrictEqual(body.data.dailyPhotos, []);
    });
  } finally {
    restore();
  }
});

test("GET /api/zones/movement/:employeeId — AC 9.5: dailyPhotos includes a day with no check-out yet (null, not an error)", async () => {
  // The timeline now issues three reads (transitions, events, day photos) in parallel — route by SQL.
  const orig = pool.query;
  pool.query = async (sql) => {
    if (/FROM attendance_record/.test(sql)) return { rows: [{ date: "2026-09-01", checkin_photo_url: "/uploads/checkin-abc.jpg", checkout_photo_url: null }] };
    if (/LIMIT/.test(sql)) return { rows: [] };
    return { rows: [{ zone: "Lobby", direction: "entry", occurred_at: "2026-09-01T09:00:00Z" }] };
  };
  const restore = () => { pool.query = orig; };
  try {
    const app = buildApp();
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/zones/movement/42?fromDate=2026-09-01&toDate=2026-09-01`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.data.dailyPhotos.length, 1);
      assert.strictEqual(body.data.dailyPhotos[0].checkInPhotoUrl, "checkin-abc.jpg", "bare filename that passes the /uploads gate");
      assert.strictEqual(body.data.dailyPhotos[0].checkOutPhotoUrl, null);
    });
  } finally {
    restore();
  }
});

test("getEmployeeDailyPhotos queries attendance_record.checkin_photo_url/checkout_photo_url, never attendance_ping (AC 9.5)", async () => {
  let capturedSql = "";
  const orig = pool.query;
  pool.query = async (sql) => { capturedSql = sql; return { rows: [] }; };
  try {
    await repo.getEmployeeDailyPhotos({ tenantId: "t1", employeeId: 1, fromDate: "2026-09-01", toDate: "2026-09-02" });
    assert.match(capturedSql, /FROM attendance_record/);
    assert.match(capturedSql, /checkin_photo_url, checkout_photo_url/);
  } finally {
    pool.query = orig;
  }
});

test("GET /api/zones/movement/matrix — transition matrix + most-visited ranking, no employeeId required", async () => {
  const restore = mockPoolSequence([
    { rows: [{ from_zone: "Lobby", to_zone: "Cafeteria", count: 3 }] },
    { rows: [{ zone: "Lobby", visits: 10 }, { zone: "Cafeteria", visits: 6 }] },
  ]);
  try {
    const app = buildApp();
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/zones/movement/matrix?fromDate=2026-09-01&toDate=2026-09-02`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.deepStrictEqual(body.data.matrix, [{ fromZone: "Lobby", toZone: "Cafeteria", count: 3, pct: 100, isPrimary: true }]);
      assert.strictEqual(body.data.mostVisited[0].zone, "Lobby");
    });
  } finally {
    restore();
  }
});
