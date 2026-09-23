/**
 * remainingLoginAttempts.test.js — AB#3267 / AB#2730 (reopened)
 *
 * "Show remaining login attempts before account lockout" — builds on AB#2730's
 * Keycloak brute-force lockout sync. On a fresh bad-credentials login attempt,
 * authRoutes.js makes a best-effort call to Keycloak's Admin API
 * (attack-detection/brute-force) to determine the account's real lockout
 * status and, when not locked, how many attempts remain before the realm's
 * failureFactor locks it. Covers:
 *
 *   1. getBruteForceStatus() correctly computes remainingAttempts from
 *      a mocked Admin API response (numFailures + realm failureFactor).
 *   2. getBruteForceStatus() reports disabled:true (with remainingAttempts
 *      null) when the account is already brute-force-locked — this is the
 *      AB#2730 regression: Keycloak's direct-grant token endpoint was
 *      confirmed live to report the SAME "Invalid user credentials"
 *      error_description for a locked account as for a plain wrong
 *      password, so the route can no longer tell lockout apart from a bad
 *      password by matching description text alone. It must consult this
 *      function's `disabled` field instead — that's what the "bug-world"
 *      tenant repro captured this test suite around.
 *   3. getBruteForceStatus() resolves to null (omitted) when any leg of
 *      the Admin API call fails — never throws, never blocks the caller.
 *   4. isBadCredentialsError() — the route's gate for whether to even attempt
 *      the lookup — is true only for a fresh bad-credentials error, not for
 *      account-disabled/locked/setup-incomplete cases.
 *
 * Uses Node.js built-in test runner and mocks global.fetch, matching the
 * conventions in keycloakBruteForceSync.test.js.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { getBruteForceStatus, isBadCredentialsError } from "../routes/authRoutes.js";
import { pool } from "../db/pool.js";

const originalFetch = global.fetch;
const originalPoolQuery = pool.query;

function restore() {
  global.fetch = originalFetch;
  pool.query = originalPoolQuery;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. getBruteForceStatus() — happy path
// ─────────────────────────────────────────────────────────────────────────────

test("getBruteForceStatus: computes remainingAttempts from mocked Admin API response", async () => {
  pool.query = async () => ({ rows: [{ maxFailedLogins: 5 }] });

  global.fetch = async (url) => {
    if (url.includes("/realms/master/protocol/openid-connect/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "mock-admin-token" }) };
    }
    if (url.includes("/admin/realms/acme/users?username=") && url.includes("exact=true")) {
      return { ok: true, status: 200, json: async () => ([{ id: "kc-user-1" }]) };
    }
    if (url.includes("/admin/realms/acme/attack-detection/brute-force/users/kc-user-1")) {
      return { ok: true, status: 200, json: async () => ({ numFailures: 2, disabled: false }) };
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  };

  try {
    const status = await getBruteForceStatus({ realm: "acme", username: "alice@example.com" });
    // failureFactor (5) - numFailures (2) = 3 remaining
    assert.deepStrictEqual(status, { disabled: false, remainingSeconds: null, remainingAttempts: 3 });
  } finally {
    restore();
  }
});

test("getBruteForceStatus: clamps remainingAttempts to 0 when numFailures already meets/exceeds failureFactor", async () => {
  pool.query = async () => ({ rows: [{ maxFailedLogins: 3 }] });

  global.fetch = async (url) => {
    if (url.includes("/realms/master/protocol/openid-connect/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "mock-admin-token" }) };
    }
    if (url.includes("/admin/realms/acme/users?username=")) {
      return { ok: true, status: 200, json: async () => ([{ id: "kc-user-1" }]) };
    }
    if (url.includes("/attack-detection/brute-force/users/kc-user-1")) {
      return { ok: true, status: 200, json: async () => ({ numFailures: 3, disabled: false }) };
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  };

  try {
    const status = await getBruteForceStatus({ realm: "acme", username: "alice@example.com" });
    assert.deepStrictEqual(status, { disabled: false, remainingSeconds: null, remainingAttempts: 0 });
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. getBruteForceStatus() — the actual AB#2730 regression
// ─────────────────────────────────────────────────────────────────────────────

test("getBruteForceStatus: reports disabled:true with remainingAttempts null when the account is already locked (AB#2730 regression)", async () => {
  pool.query = async () => ({ rows: [{ maxFailedLogins: 3 }] });

  global.fetch = async (url) => {
    if (url.includes("/realms/master/protocol/openid-connect/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "mock-admin-token" }) };
    }
    if (url.includes("/admin/realms/acme/users?username=")) {
      return { ok: true, status: 200, json: async () => ([{ id: "kc-user-1" }]) };
    }
    if (url.includes("/attack-detection/brute-force/users/kc-user-1")) {
      // Confirmed live against a real locked test account: numFailures can
      // exceed failureFactor once locked, and the shape is still {disabled:true}.
      return { ok: true, status: 200, json: async () => ({ numFailures: 4, disabled: true, lastFailure: Date.now() }) };
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  };

  try {
    const status = await getBruteForceStatus({ realm: "acme", username: "alice@example.com" });
    assert.deepStrictEqual(status, { disabled: true, remainingSeconds: 900, remainingAttempts: null });
  } finally {
    restore();
  }
});

test("getBruteForceStatus: unlocks account when lockout duration has elapsed", async () => {
  pool.query = async () => ({ rows: [{ maxFailedLogins: 3 }] });

  global.fetch = async (url) => {
    if (url.includes("/realms/master/protocol/openid-connect/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "mock-admin-token" }) };
    }
    if (url.includes("/admin/realms/acme/users?username=")) {
      return { ok: true, status: 200, json: async () => ([{ id: "kc-user-1" }]) };
    }
    if (url.includes("/attack-detection/brute-force/users/kc-user-1")) {
      // Keycloak brute-force record 16 minutes ago (lockout duration is 15 mins)
      const sixteenMinsAgo = Date.now() - (16 * 60 * 1000);
      return { ok: true, status: 200, json: async () => ({ numFailures: 4, disabled: true, lastFailure: sixteenMinsAgo }) };
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  };

  try {
    const status = await getBruteForceStatus({ realm: "acme", username: "alice@example.com" });
    assert.deepStrictEqual(status, { disabled: false, remainingSeconds: null, remainingAttempts: 0 });
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. getBruteForceStatus() — best-effort failure handling
// ─────────────────────────────────────────────────────────────────────────────

test("getBruteForceStatus: resolves to null (never throws) when the admin token request fails", async () => {
  pool.query = async () => ({ rows: [{ maxFailedLogins: 5 }] });
  global.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });

  try {
    const status = await getBruteForceStatus({ realm: "acme", username: "alice@example.com" });
    assert.strictEqual(status, null);
  } finally {
    restore();
  }
});

test("getBruteForceStatus: resolves to null when the user lookup request fails", async () => {
  pool.query = async () => ({ rows: [{ maxFailedLogins: 5 }] });

  global.fetch = async (url) => {
    if (url.includes("/realms/master/protocol/openid-connect/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "mock-admin-token" }) };
    }
    return { ok: false, status: 404, text: async () => "not found" };
  };

  try {
    const status = await getBruteForceStatus({ realm: "acme", username: "alice@example.com" });
    assert.strictEqual(status, null);
  } finally {
    restore();
  }
});

test("getBruteForceStatus: resolves to null when the user lookup returns no matching user", async () => {
  pool.query = async () => ({ rows: [{ maxFailedLogins: 5 }] });

  global.fetch = async (url) => {
    if (url.includes("/realms/master/protocol/openid-connect/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "mock-admin-token" }) };
    }
    if (url.includes("/admin/realms/acme/users?username=")) {
      return { ok: true, status: 200, json: async () => ([]) };
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  };

  try {
    const status = await getBruteForceStatus({ realm: "acme", username: "ghost@example.com" });
    assert.strictEqual(status, null);
  } finally {
    restore();
  }
});

test("getBruteForceStatus: resolves to null when the attack-detection request fails", async () => {
  pool.query = async () => ({ rows: [{ maxFailedLogins: 5 }] });

  global.fetch = async (url) => {
    if (url.includes("/realms/master/protocol/openid-connect/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "mock-admin-token" }) };
    }
    if (url.includes("/admin/realms/acme/users?username=")) {
      return { ok: true, status: 200, json: async () => ([{ id: "kc-user-1" }]) };
    }
    if (url.includes("/attack-detection/brute-force/users/kc-user-1")) {
      return { ok: false, status: 500, text: async () => "boom" };
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  };

  try {
    const status = await getBruteForceStatus({ realm: "acme", username: "alice@example.com" });
    assert.strictEqual(status, null);
  } finally {
    restore();
  }
});

test("getBruteForceStatus: resolves to null (not a rejected promise) when fetch throws (network error)", async () => {
  pool.query = async () => ({ rows: [{ maxFailedLogins: 5 }] });
  global.fetch = async () => { throw new Error("network down"); };

  try {
    await assert.doesNotReject(
      getBruteForceStatus({ realm: "acme", username: "alice@example.com" })
    );
    const status = await getBruteForceStatus({ realm: "acme", username: "alice@example.com" });
    assert.strictEqual(status, null);
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. isBadCredentialsError() — route-level gate
// ─────────────────────────────────────────────────────────────────────────────

test("isBadCredentialsError: true for Keycloak's 'Invalid user credentials' description", () => {
  assert.strictEqual(isBadCredentialsError("Invalid user credentials"), true);
});

test("isBadCredentialsError: case-insensitive", () => {
  assert.strictEqual(isBadCredentialsError("INVALID USER CREDENTIALS"), true);
});

// AB#2730 regression note: this description text ("Invalid user credentials")
// is ALSO what a real locked account returns (confirmed live) — that's
// exactly why the route can no longer rely on isBadCredentialsError() alone
// to decide the account isn't locked. It only gates whether to bother
// calling getBruteForceStatus() at all; getBruteForceStatus()'s `disabled`
// field is what actually decides the message now.
test("isBadCredentialsError: true even though this exact text is also returned for an already-locked account in some environments", () => {
  assert.strictEqual(isBadCredentialsError("Invalid user credentials"), true);
});

test("isBadCredentialsError: false for an already-locked/disabled account (alternate Keycloak wording, where present)", () => {
  assert.strictEqual(isBadCredentialsError("Account temporarily disabled"), false);
});

test("isBadCredentialsError: false for a permanently disabled account", () => {
  assert.strictEqual(isBadCredentialsError("Account disabled"), false);
});

test("isBadCredentialsError: false for account setup incomplete", () => {
  assert.strictEqual(isBadCredentialsError("Account is not fully set up"), false);
});

test("isBadCredentialsError: false for an unrecognized/generic description", () => {
  assert.strictEqual(isBadCredentialsError("Some unexpected Keycloak error"), false);
});

test("isBadCredentialsError: false for null/undefined description", () => {
  assert.strictEqual(isBadCredentialsError(null), false);
  assert.strictEqual(isBadCredentialsError(undefined), false);
});
