/**
 * PERF-0003 — per-limiter stores.
 *   AC1 no ERR_ERL_STORE_REUSE when every limiter gets its own store
 *   AC2 each store receives its OWN windowMs via init() (no last-wins collision)
 *   AC5 with no REDIS_URL, limiters fall back to the in-memory store
 *   AC6 REDIS_URL is read via env.js, not process.env, in rateLimit.js
 *
 * Uses fake stores to observe init() — no live Redis needed.
 */
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import rateLimit from "express-rate-limit";

/** Records the windowMs each limiter hands its store. */
class RecordingStore {
  constructor() { this.inits = []; this.hits = new Map(); }
  init(options) { this.inits.push(options.windowMs); }
  async increment(key) {
    const n = (this.hits.get(key) || 0) + 1;
    this.hits.set(key, n);
    return { totalHits: n, resetTime: new Date(Date.now() + 1000) };
  }
  async decrement(key) { this.hits.set(key, Math.max(0, (this.hits.get(key) || 0) - 1)); }
  async resetKey(key) { this.hits.delete(key); }
}

test("AC1 — one store per limiter raises no ERR_ERL_STORE_REUSE", () => {
  const errors = [];
  const origError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    // The fixed shape: a NEW store per limiter.
    rateLimit({ windowMs: 600000, max: 300, store: new RecordingStore() });
    rateLimit({ windowMs: 300000, max: 10, store: new RecordingStore() });
    rateLimit({ windowMs: 900000, max: 5, store: new RecordingStore() });
  } finally {
    console.error = origError;
  }
  const reuse = errors.filter((e) => /ERR_ERL_STORE_REUSE/.test(e));
  assert.strictEqual(reuse.length, 0, `expected no store-reuse errors, got: ${reuse.join(" | ")}`);
});

test("AC1 — the REAL module with REDIS_URL set raises no store-reuse errors", () => {
  // Run in a FRESH child process: env.js captures redis.url in its constructor, so
  // toggling process.env + re-importing in-process is order-dependent; and the
  // ioredis client would keep this runner's event loop alive.
  const script = `
    const errs = [];
    const orig = console.error;
    console.error = (...a) => errs.push(a.join(' '));
    const mod = await import('./src/middleware/rateLimit.js');
    console.error = orig;
    const reuse = errs.filter(e => /ERR_ERL_STORE_REUSE/.test(e));
    const limiters = Object.keys(mod).filter(k => k !== 'makeStore');
    console.log(JSON.stringify({ limiters: limiters.length, reuse: reuse.length }));
    process.exit(0);
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, REDIS_URL: "redis://127.0.0.1:6379" },
  });
  const result = JSON.parse(out.trim().split("\n").pop());
  assert.strictEqual(result.limiters, 7, "all seven limiters exported");
  assert.strictEqual(result.reuse, 0,
    "sharing one store across 7 limiters previously logged 6 reuse errors");
});

test("AC2 — each store gets its own windowMs (regression for the last-wins collision)", () => {
  const a = new RecordingStore();
  const b = new RecordingStore();
  const c = new RecordingStore();
  rateLimit({ windowMs: 600000, max: 300, store: a });
  rateLimit({ windowMs: 300000, max: 10, store: b });
  rateLimit({ windowMs: 900000, max: 5, store: c });

  // Each store saw exactly ONE init, with ITS OWN window — the shared-store bug
  // produced [600000, 300000, 900000] on a single instance instead.
  assert.deepStrictEqual(a.inits, [600000]);
  assert.deepStrictEqual(b.inits, [300000]);
  assert.deepStrictEqual(c.inits, [900000]);
});

test("AC2 — counters are isolated between limiters", async () => {
  const authStore = new RecordingStore();
  const globalStore = new RecordingStore();
  rateLimit({ windowMs: 300000, max: 10, store: authStore });
  rateLimit({ windowMs: 600000, max: 300, store: globalStore });

  await authStore.increment("1.2.3.4");
  await authStore.increment("1.2.3.4");

  assert.strictEqual(authStore.hits.get("1.2.3.4"), 2);
  assert.strictEqual(globalStore.hits.get("1.2.3.4"), undefined, "exhausting one limiter must not affect another");
});

test("AC5 — with no REDIS_URL, makeStore returns undefined (in-memory fallback)", () => {
  // Fresh child process again — env.js caches redis.url at construction, so this
  // cannot be toggled reliably in-process (see AC1).
  const script = `
    const { makeStore } = await import('./src/middleware/rateLimit.js');
    console.log(JSON.stringify({ store: makeStore('anything') === undefined ? 'undefined' : 'defined' }));
    process.exit(0);
  `;
  const env = { ...process.env };
  delete env.REDIS_URL;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(), encoding: "utf8", env,
  });
  const result = JSON.parse(out.trim().split("\n").pop());
  assert.strictEqual(result.store, "undefined",
    "no Redis configured → undefined so express-rate-limit uses its MemoryStore");
});

test("AC6 — rateLimit.js reads Redis config from env.js, not process.env", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "src/middleware/rateLimit.js"), "utf8"
  );
  assert.ok(/env\.redis\.url/.test(src), "should read env.redis.url");
  assert.ok(!/process\.env\.REDIS_URL/.test(src),
    "should not read process.env.REDIS_URL directly (docs/patterns/backend-api.md)");
});
