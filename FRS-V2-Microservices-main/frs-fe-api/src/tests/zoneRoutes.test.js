/**
 * specs/0003-zone-analytics — Task 6: ZoneAnalyticsController + zoneRoutes.
 *
 * `supertest` is not a dependency anywhere in this monorepo (checked: no
 * package.json across frs-core-api/frs-fe-api/frs-edge-api/frs-web-ui
 * references it, no node_modules/supertest) and the "don't introduce a new
 * dependency without reason" rule weighs against adding one just for this
 * spec — so this uses Node's own `http` + native `fetch` (Node 24) to drive
 * real HTTP requests at a real listening server, which is the same thing
 * Supertest does under the hood. Flagged in WALKTHROUGH.md as a deliberate
 * substitution, not a silent scope-down.
 *
 * `zoneRoutes.js` itself wires `router.use(requireAuth)` — real JWT/Keycloak
 * verification — ahead of `requirePermission('zones.read')`. Standing up real
 * auth is out of scope for a route/permission/service-shape test, so this
 * test app mounts the SAME real `requirePermission('zones.read')` (imported,
 * not mocked) directly in front of the real `ZoneAnalyticsController`, with a
 * minimal test-only stand-in for requireAuth that sets `req.auth` the same
 * shape requireAuth produces (`{ scope, memberships }`). `zoneRoutes.js`'s
 * own wiring (that every path is behind requireAuth + requirePermission
 * ('zones.read')) is checked separately below via a structural source read,
 * since ESM named exports can't be monkeypatched from outside the module.
 */
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import express from "express";

process.env.NODE_ENV = "test"; // disable authz.js's NODE_ENV=development permission bypass

const { requirePermission } = await import("../middleware/authz.js");
const { pool } = await import("../db/pool.js");
const ZoneAnalyticsController = (await import("../controllers/ZoneAnalyticsController.js")).default;

function authStub(permissions) {
  return (req, _res, next) => {
    req.auth = {
      scope: { tenantId: "11111111-1111-1111-1111-111111111111", siteId: null },
      memberships: [{ scope: { siteId: null }, permissions }],
    };
    next();
  };
}

function buildApp(permissions) {
  const app = express();
  app.use(express.json());
  app.use(authStub(permissions));
  app.use(requirePermission("zones.read"));
  app.get("/api/zones", (req, res, next) => ZoneAnalyticsController.listZones(req, res).catch(next));
  app.get("/api/zones/analytics/occupancy", (req, res, next) => ZoneAnalyticsController.getOccupancy(req, res).catch(next));
  app.get("/api/zones/compare", (req, res, next) => ZoneAnalyticsController.compareZones(req, res).catch(next));
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function mockPool(rows) {
  const orig = pool.query;
  pool.query = async () => ({ rows });
  return () => { pool.query = orig; };
}

test("GET /api/zones/analytics/occupancy — 403 without zones.read (prerequisite: Task 1's RBAC seed)", async () => {
  const app = buildApp(["attendance.read"]); // holds a different permission, not zones.read
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/zones/analytics/occupancy?fromDate=2026-09-01&toDate=2026-09-02`);
    assert.strictEqual(res.status, 403);
  });
});

test("GET /api/zones/analytics/occupancy — 2xx happy path with zones.read", async () => {
  const restore = mockPool([{ current_occupancy: 2, peak_occupancy: 5, average_occupancy: 3, lowest_occupancy: 0 }]);
  try {
    const app = buildApp(["zones.read"]);
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/zones/analytics/occupancy`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.data.current, 2);
      assert.strictEqual(body.data.peak, 5);
      assert.ok(!("capacity" in body.data));
    });
  } finally {
    restore();
  }
});

test("GET /api/zones/analytics/occupancy — 400 on malformed fromDate", async () => {
  const app = buildApp(["zones.read"]);
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/zones/analytics/occupancy?fromDate=not-a-date&toDate=2026-09-02`);
    assert.strictEqual(res.status, 400);
  });
});

test("GET /api/zones/compare — 400 with fewer than 2 zones (AC 8.2), 2xx with 2", async () => {
  const app = buildApp(["zones.read"]);
  await withServer(app, async (base) => {
    const badRes = await fetch(`${base}/api/zones/compare?zone=Lobby`);
    assert.strictEqual(badRes.status, 400);
  });

  const restore = mockPool([{ current_occupancy: 1, peak_occupancy: 1, average_occupancy: 1, lowest_occupancy: 0 }]);
  try {
    const app2 = buildApp(["zones.read"]);
    await withServer(app2, async (base) => {
      const okRes = await fetch(`${base}/api/zones/compare?zone=Lobby&zone=Cafeteria`);
      assert.strictEqual(okRes.status, 200);
      const body = await okRes.json();
      assert.deepStrictEqual(Object.keys(body.data.zones).sort(), ["Cafeteria", "Lobby"]);
    });
  } finally {
    restore();
  }
});

test("zoneRoutes.js: every /api/zones/* path is gated by requireAuth + requirePermission('zones.read') (structural)", () => {
  const src = fs.readFileSync(new URL("../routes/zoneRoutes.js", import.meta.url), "utf8");
  assert.match(src, /router\.use\(requireAuth\)/);
  assert.match(src, /router\.use\(requirePermission\('zones\.read'\)\)/);
  // No per-route permission override to a different (broader) permission string.
  assert.doesNotMatch(src, /requirePermission\('(?!zones\.read)/);
});
