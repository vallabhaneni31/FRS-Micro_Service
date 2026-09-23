/**
 * PERF-0003 — Redis-outage failover policy.
 *   AC3 traffic limiters fail OPEN  — keep serving, no 5xx
 *   AC4 auth/activation limiters fail CLOSED — 429, never 500, never unlimited
 *
 * A store that always rejects simulates the outage; no live Redis needed.
 */
import test from "node:test";
import assert from "node:assert";
import rateLimit from "express-rate-limit";

/** Store that behaves as if Redis is down. */
class BrokenStore {
  init() {}
  async increment() { throw new Error("Redis unavailable"); }
  async decrement() {}
  async resetKey() {}
}

/** Minimal req/res/next harness mirroring the express contract we rely on.
 *  `app.get` is needed because express-rate-limit consults `trust proxy`. */
function invoke(
  middleware,
  req = { ip: "1.2.3.4", headers: {}, body: {}, app: { get: () => undefined } }
) {
  return new Promise((resolve) => {
    let status = 200;
    let body = null;
    const res = {
      status(code) { status = code; return this; },
      json(payload) { body = payload; resolve({ outcome: "response", status, body }); return this; },
      setHeader() {}, getHeader() {}, removeHeader() {},
    };
    middleware(req, res, (err) => resolve({ outcome: err ? "error" : "next", err, status }));
  });
}

// Mirrors the failClosed() wrapper in rateLimit.js.
function failClosed(limiter, message) {
  return (req, res, next) =>
    limiter(req, res, (err) => (err ? res.status(429).json({ message }) : next()));
}

test("AC3 — fail-open limiter keeps serving when the store errors (no 5xx)", async () => {
  const limiter = rateLimit({
    windowMs: 600000, max: 300,
    passOnStoreError: true,
    store: new BrokenStore(),
  });
  const result = await invoke(limiter);
  assert.strictEqual(result.outcome, "next", "request should pass through despite the store error");
  assert.ok(!result.err, "no error propagated to the error handler");
});

test("AC4 — fail-closed limiter returns 429 (not 500, not unlimited) when the store errors", async () => {
  const message = "Too many failed login attempts, please try again after 5 minutes";
  const limiter = failClosed(
    rateLimit({ windowMs: 300000, max: 10, passOnStoreError: false, store: new BrokenStore() }),
    message
  );
  const result = await invoke(limiter);
  assert.strictEqual(result.outcome, "response", "must respond, not pass through");
  assert.strictEqual(result.status, 429, "store failure on an auth limiter must deny with 429");
  assert.strictEqual(result.body.message, message);
});

test("AC4 — without the wrapper a fail-closed store error would surface as a 500 (documents why the wrapper exists)", async () => {
  const bare = rateLimit({ windowMs: 300000, max: 10, passOnStoreError: false, store: new BrokenStore() });
  const result = await invoke(bare);
  assert.strictEqual(result.outcome, "error", "bare limiter forwards the store error to next(err) → 500");
  assert.ok(result.err, "an error is propagated");
});

test("AC4 — the real exported limiters carry the right failure policy", async () => {
  const mod = await import("../middleware/rateLimit.js");
  // express-rate-limit attaches .resetKey/.getKey to the middleware it returns.
  // Our failClosed() wrapper is a plain function, so those are absent — that's how
  // we distinguish a wrapped (fail-closed) limiter from a bare (fail-open) one.
  for (const name of ["authRateLimiter", "accountLoginLimiter", "activationLimiter"]) {
    assert.strictEqual(typeof mod[name], "function", `${name} should be middleware`);
    assert.strictEqual(mod[name].resetKey, undefined, `${name} must be wrapped fail-closed`);
  }
  for (const name of ["globalRateLimiter", "deviceIngestLimiter", "inviteLimiter", "photoUploadLimiter"]) {
    assert.strictEqual(typeof mod[name].resetKey, "function", `${name} must be a bare fail-open limiter`);
  }
});
