/**
 * PERF-0001 AC1/AC2 — deviceIngestLimiter is keyed by DEVICE, not IP.
 * Spins a tiny real express app (in-memory rate-limit store, no Redis needed)
 * and hammers it, so we exercise the actual counting, not a mock.
 */
import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import express from "express";
import { deviceIngestLimiter } from "../middleware/rateLimit.js";

function makeServer() {
  const app = express();
  // Fake authenticateDevice: put the test device id on req.device.
  app.use((req, _res, next) => {
    const id = req.headers["x-test-device"];
    if (id) req.device = { id };
    next();
  });
  app.use(deviceIngestLimiter);
  app.get("/ping", (_req, res) => res.json({ ok: true }));
  return http.createServer(app);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function hammer(base, deviceId, n) {
  let ok = 0, limited = 0;
  for (let i = 0; i < n; i++) {
    const res = await fetch(`${base}/ping`, { headers: deviceId ? { "x-test-device": deviceId } : {} });
    if (res.status === 429) limited++;
    else if (res.status === 200) ok++;
  }
  return { ok, limited };
}

test("AC1 — one device: 300 pass, the 301st in the window is 429", async () => {
  const server = makeServer();
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    const { ok, limited } = await hammer(base, "AC1-device", 301);
    assert.strictEqual(ok, 300, "first 300 should pass");
    assert.strictEqual(limited, 1, "the 301st should be throttled");
  } finally {
    server.close();
  }
});

test("AC2 — two devices sharing one IP each get their own budget (not a combined per-IP limit)", async () => {
  const server = makeServer();
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    // 200 + 200 = 400 from one IP would blow a 300 per-IP limit; per-device it's fine.
    const a = await hammer(base, "AC2-device-A", 200);
    const b = await hammer(base, "AC2-device-B", 200);
    assert.strictEqual(a.limited, 0, "device A not throttled");
    assert.strictEqual(b.limited, 0, "device B not throttled");
    assert.strictEqual(a.ok + b.ok, 400, "all 400 requests succeed across two devices");
  } finally {
    server.close();
  }
});
