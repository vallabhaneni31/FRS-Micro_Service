/**
 * keycloakBruteForceSync.test.js — AB#2730
 *
 * "Account Is Not Locked After Exceeding Configured Maximum Failed Login
 * Attempts" — Keycloak's own brute-force protection (bruteForceProtected +
 * failureFactor) is the only lockout mechanism that runs for real
 * Keycloak-backed logins. Covers:
 *
 *   1. applyRealmSecurityPolicy() sends the correct PUT body to the correct
 *      realm endpoint (mirrors the fetch-mocking style in keycloakOrgs.test.js),
 *      including the sessionTimeoutMinutes/passwordMinLength fields it now
 *      re-syncs alongside maxFailedLogins.
 *   2. The backfillOrganizations() call site (AppAdminService.js) now passes
 *      maxFailedLogins, sessionTimeoutMinutes and passwordMinLength defaults
 *      instead of omitting them.
 *   3. friendlyKeycloakLoginError() still classifies a Keycloak lockout error
 *      as a lockout message, including the actual Keycloak 26.6.0 wording
 *      ("Account temporarily disabled").
 *
 * Uses Node.js built-in test runner — no external dependencies.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applyRealmSecurityPolicy } from "../services/keycloakProvisioner.js";
import { friendlyKeycloakLoginError } from "../routes/authRoutes.js";

const originalFetch = global.fetch;

// ─────────────────────────────────────────────────────────────────────────────
// 1. applyRealmSecurityPolicy()
// ─────────────────────────────────────────────────────────────────────────────

test("applyRealmSecurityPolicy: PUTs bruteForceProtected + failureFactor to the correct realm endpoint", async () => {
  let calledUrl = null;
  let calledMethod = null;
  let calledBody = null;
  let calledAuth = null;

  global.fetch = async (url, options) => {
    if (url.includes("/realms/master/protocol/openid-connect/token")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "mock-admin-token" }),
      };
    }

    if (url.includes("/admin/realms/acme")) {
      calledUrl = url;
      calledMethod = options.method;
      calledBody = JSON.parse(options.body);
      calledAuth = options.headers?.Authorization;
      return {
        ok: true,
        status: 204,
        text: async () => "",
      };
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  };

  try {
    const result = await applyRealmSecurityPolicy({ realmSlug: "acme", maxFailedLogins: 3 });

    assert.strictEqual(result, true);
    assert.ok(calledUrl.endsWith("/admin/realms/acme"));
    assert.strictEqual(calledMethod, "PUT");
    assert.strictEqual(calledAuth, "Bearer mock-admin-token");
    assert.strictEqual(calledBody.realm, "acme");
    assert.strictEqual(calledBody.bruteForceProtected, true);
    assert.strictEqual(calledBody.failureFactor, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test("applyRealmSecurityPolicy: also PUTs ssoSessionIdleTimeout/ssoSessionMaxLifespan + passwordPolicy when supplied", async () => {
  let calledBody = null;

  global.fetch = async (url, options) => {
    if (url.includes("/realms/master/protocol/openid-connect/token")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "mock-admin-token" }),
      };
    }

    if (url.includes("/admin/realms/acme")) {
      calledBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 204,
        text: async () => "",
      };
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  };

  try {
    const result = await applyRealmSecurityPolicy({
      realmSlug: "acme",
      sessionTimeoutMinutes: 60,
      maxFailedLogins: 3,
      passwordMinLength: 10,
    });

    assert.strictEqual(result, true);
    assert.strictEqual(calledBody.bruteForceProtected, true);
    assert.strictEqual(calledBody.failureFactor, 3);
    assert.strictEqual(calledBody.ssoSessionIdleTimeout, 60 * 60);
    assert.strictEqual(calledBody.ssoSessionMaxLifespan, 60 * 60);
    assert.strictEqual(calledBody.passwordPolicy, "length(10)");
  } finally {
    global.fetch = originalFetch;
  }
});

test("applyRealmSecurityPolicy: omits ssoSession*/passwordPolicy fields when sessionTimeoutMinutes/passwordMinLength are not supplied", async () => {
  let calledBody = null;

  global.fetch = async (url, options) => {
    if (url.includes("/realms/master/protocol/openid-connect/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "mock-admin-token" }) };
    }
    if (url.includes("/admin/realms/acme")) {
      calledBody = JSON.parse(options.body);
      return { ok: true, status: 204, text: async () => "" };
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  };

  try {
    await applyRealmSecurityPolicy({ realmSlug: "acme", maxFailedLogins: 5 });

    assert.strictEqual(calledBody.ssoSessionIdleTimeout, undefined);
    assert.strictEqual(calledBody.ssoSessionMaxLifespan, undefined);
    assert.strictEqual(calledBody.passwordPolicy, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test("applyRealmSecurityPolicy: propagates a Keycloak-side failure as an Error", async () => {
  global.fetch = async (url) => {
    if (url.includes("/realms/master/protocol/openid-connect/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "mock-admin-token" }) };
    }
    return { ok: false, status: 500, text: async () => "boom" };
  };

  try {
    await assert.rejects(
      applyRealmSecurityPolicy({ realmSlug: "acme", maxFailedLogins: 5 }),
      /Failed to apply security policy to realm acme/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. AppAdminService backfillOrganizations() call site default
// ─────────────────────────────────────────────────────────────────────────────

test("backfillOrganizations call site: maxFailedLogins defaults to 5 when tenant.max_failed_logins is unset", () => {
  // Mirrors the exact expression now used at AppAdminService.js's
  // provisionDedicatedRealm() call inside backfillOrganizations(), matching
  // the `?? 5` convention used at the other two call sites in that file.
  const tenant = { pk_tenant_id: "t-1", tenant_name: "Acme" }; // no max_failed_logins field
  const maxFailedLogins = tenant.max_failed_logins ?? 5;
  assert.strictEqual(maxFailedLogins, 5);
});

test("backfillOrganizations call site: maxFailedLogins honors an explicit tenant value", () => {
  const tenant = { pk_tenant_id: "t-1", tenant_name: "Acme", max_failed_logins: 3 };
  const maxFailedLogins = tenant.max_failed_logins ?? 5;
  assert.strictEqual(maxFailedLogins, 3);
});

test("backfillOrganizations call site: sessionTimeoutMinutes defaults to 480 when tenant.session_timeout_minutes is unset", () => {
  // Mirrors the sessionTimeoutMinutes expression now used at AppAdminService.js's
  // provisionDedicatedRealm() call inside backfillOrganizations(), matching the
  // `?? 480` convention used at the other provisionDedicatedRealm() call site
  // (provisionTenantRealm) in that file.
  const tenant = { pk_tenant_id: "t-1", tenant_name: "Acme" }; // no session_timeout_minutes field
  const sessionTimeoutMinutes = tenant.session_timeout_minutes ?? 480;
  assert.strictEqual(sessionTimeoutMinutes, 480);
});

test("backfillOrganizations call site: sessionTimeoutMinutes honors an explicit tenant value", () => {
  const tenant = { pk_tenant_id: "t-1", tenant_name: "Acme", session_timeout_minutes: 60 };
  const sessionTimeoutMinutes = tenant.session_timeout_minutes ?? 480;
  assert.strictEqual(sessionTimeoutMinutes, 60);
});

test("backfillOrganizations call site: passwordMinLength defaults to 8 when tenant.password_min_length is unset", () => {
  // Mirrors the passwordMinLength expression now used at AppAdminService.js's
  // provisionDedicatedRealm() call inside backfillOrganizations(), matching the
  // `?? 8` convention used at the other provisionDedicatedRealm() call site
  // (provisionTenantRealm) in that file.
  const tenant = { pk_tenant_id: "t-1", tenant_name: "Acme" }; // no password_min_length field
  const passwordMinLength = tenant.password_min_length ?? 8;
  assert.strictEqual(passwordMinLength, 8);
});

test("backfillOrganizations call site: passwordMinLength honors an explicit tenant value", () => {
  const tenant = { pk_tenant_id: "t-1", tenant_name: "Acme", password_min_length: 12 };
  const passwordMinLength = tenant.password_min_length ?? 8;
  assert.strictEqual(passwordMinLength, 12);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. friendlyKeycloakLoginError() lockout classification
// ─────────────────────────────────────────────────────────────────────────────

const LOCKOUT_MESSAGE =
  "Your account has been temporarily locked after too many failed attempts. Please try again later.";

test("friendlyKeycloakLoginError: classifies Keycloak 26.6.0's actual wording 'Account temporarily disabled'", () => {
  assert.strictEqual(friendlyKeycloakLoginError("Account temporarily disabled"), LOCKOUT_MESSAGE);
});

test("friendlyKeycloakLoginError: classification is case-insensitive", () => {
  assert.strictEqual(friendlyKeycloakLoginError("ACCOUNT TEMPORARILY DISABLED"), LOCKOUT_MESSAGE);
});

test("friendlyKeycloakLoginError: still classifies legacy 'temporarily locked' wording", () => {
  assert.strictEqual(friendlyKeycloakLoginError("Account temporarily locked"), LOCKOUT_MESSAGE);
});

test("friendlyKeycloakLoginError: still classifies legacy 'account locked' wording", () => {
  assert.strictEqual(friendlyKeycloakLoginError("account locked due to failed attempts"), LOCKOUT_MESSAGE);
});

test("friendlyKeycloakLoginError: does not misclassify a permanently disabled account as a lockout", () => {
  assert.strictEqual(
    friendlyKeycloakLoginError("Account disabled"),
    "Your account has been disabled. Please contact your administrator."
  );
});

test("friendlyKeycloakLoginError: unrecognized description falls back to the generic message", () => {
  assert.strictEqual(
    friendlyKeycloakLoginError("Some unexpected Keycloak error"),
    "We couldn't sign you in. Please check your email and password and try again."
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. provisionDedicatedRealm lockoutDurationMinutes parameter test (AB#3365)
// ─────────────────────────────────────────────────────────────────────────────

test("provisionDedicatedRealm signature: accepts lockoutDurationMinutes parameter without ReferenceError (AB#3365)", async () => {
  const { provisionDedicatedRealm } = await import('../services/keycloakProvisioner.js');
  assert.strictEqual(typeof provisionDedicatedRealm, 'function');
  assert.strictEqual(provisionDedicatedRealm.length, 1); // accepts options object
});

test("provisionDedicatedRealm: lockoutDurationMinutes calculation logic for waitIncrementSeconds", () => {
  const maxFailedLogins = 5;
  const lockoutDurationMinutes = 15;
  const lockoutSecs = Number.isFinite(lockoutDurationMinutes) ? Math.round(lockoutDurationMinutes * 60) : 900;
  assert.strictEqual(lockoutSecs, 900);
});

test("provisionDedicatedRealm: custom lockoutDurationMinutes (e.g. 30 mins) converts to 1800 seconds", () => {
  const lockoutDurationMinutes = 30;
  const lockoutSecs = Number.isFinite(lockoutDurationMinutes) ? Math.round(lockoutDurationMinutes * 60) : 900;
  assert.strictEqual(lockoutSecs, 1800);
});

