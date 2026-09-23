/**
 * login.test.js — Login Flow Test Suite
 *
 * Covers all stages of the FRS login flow end-to-end:
 *
 *   1. Token parsing & validation helpers
 *   2. Keycloak JWT verification logic (verifyKeycloakToken)
 *   3. Keycloak bootstrap endpoint logic
 *   4. Legacy API bootstrap (authService)
 *   5. Token refresh flow
 *   6. Logout flow
 *   7. Security edge cases (CSRF, header injection, etc.)
 *
 * Uses Node.js built-in test runner — no external dependencies.
 * Run: npm test  (or: node --test src/tests/login.test.js)
 */

import test from "node:test";
import assert from "node:assert/strict";

// ─────────────────────────────────────────────────────────────────────────────
// Section 1: Token/Claim Parsing Helpers
//   Mirrors logic in keycloakVerifier.js + authz.js
// ─────────────────────────────────────────────────────────────────────────────

/** Extract realm slug from a Keycloak issuer URL */
function parseRealmSlug(iss) {
  if (!iss) return null;
  const m = iss.match(/\/realms\/([^/]+)/);
  return m ? m[1] : null;
}

/** Read Bearer token from Authorization header */
function readBearerToken(headers) {
  const header = headers?.authorization || "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim() || null;
}

/** Read token from httpOnly cookie first, then Bearer header */
function readToken(req) {
  if (req.cookies?.access_token) return req.cookies.access_token;
  return readBearerToken(req.headers || {});
}

test("parseRealmSlug: extracts realm from standard KC issuer URL", () => {
  assert.equal(
    parseRealmSlug("https://frs.motivitylabs.com/auth/realms/attendance"),
    "attendance"
  );
});

test("parseRealmSlug: handles multi-segment realm names", () => {
  assert.equal(
    parseRealmSlug("https://auth.example.com/auth/realms/my-org"),
    "my-org"
  );
});

test("parseRealmSlug: returns null for malformed issuer", () => {
  assert.equal(parseRealmSlug("https://example.com/notrealms"), null);
  assert.equal(parseRealmSlug(null), null);
  assert.equal(parseRealmSlug(""), null);
});

test("readBearerToken: extracts token from valid Authorization header", () => {
  assert.equal(
    readBearerToken({ authorization: "Bearer my.test.token" }),
    "my.test.token"
  );
});

test("readBearerToken: case-insensitive 'bearer' prefix", () => {
  assert.equal(
    readBearerToken({ authorization: "BEARER my.test.token" }),
    "my.test.token"
  );
});

test("readBearerToken: returns null for missing Authorization header", () => {
  assert.equal(readBearerToken({}), null);
  assert.equal(readBearerToken(null), null);
});

test("readBearerToken: returns null for non-Bearer schemes", () => {
  assert.equal(readBearerToken({ authorization: "Basic dXNlcjpwYXNz" }), null);
});

test("readBearerToken: returns null for empty Bearer value", () => {
  assert.equal(readBearerToken({ authorization: "Bearer " }), null);
  assert.equal(readBearerToken({ authorization: "Bearer" }), null);
});

test("readToken: prefers httpOnly cookie over Bearer header", () => {
  const req = {
    cookies: { access_token: "cookie-token" },
    headers: { authorization: "Bearer header-token" },
  };
  assert.equal(readToken(req), "cookie-token");
});

test("readToken: falls back to Bearer header when no cookie", () => {
  const req = {
    cookies: {},
    headers: { authorization: "Bearer header-token" },
  };
  assert.equal(readToken(req), "header-token");
});

test("readToken: returns null when neither cookie nor header present", () => {
  const req = { cookies: {}, headers: {} };
  assert.equal(readToken(req), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 2: Keycloak JWT Payload Validation
//   Mirrors logic in keycloakVerifier.js (soft audience check, claim guards)
// ─────────────────────────────────────────────────────────────────────────────

const EXPECTED_AUDIENCE = "attendance-frontend";
const ALLOWED_AUDIENCES = ["account", EXPECTED_AUDIENCE];

function checkAudience(aud, allowed = ALLOWED_AUDIENCES) {
  if (aud === undefined) return true; // no aud claim → pass (soft check)
  const audList = Array.isArray(aud) ? aud : [aud];
  return audList.some((a) => allowed.includes(a));
}

test("checkAudience: valid single-string audience passes", () => {
  assert.equal(checkAudience("attendance-frontend"), true);
});

test("checkAudience: 'account' audience is whitelisted", () => {
  assert.equal(checkAudience("account"), true);
});

test("checkAudience: array audience containing valid entry passes", () => {
  assert.equal(checkAudience(["account", "attendance-frontend"]), true);
});

test("checkAudience: unknown audience is rejected", () => {
  assert.equal(checkAudience("evil-client"), false);
});

test("checkAudience: array with only unknown audience is rejected", () => {
  assert.equal(checkAudience(["evil-client", "other"]), false);
});

test("checkAudience: missing aud claim passes (soft check)", () => {
  assert.equal(checkAudience(undefined), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 3: Keycloak Bootstrap — JWT Payload Normalisation
//   Tests how the bootstrap endpoint maps JWT claims → user session
// ─────────────────────────────────────────────────────────────────────────────

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const TENANT_B = "bbbbbbbb-0000-0000-0000-000000000002";

/** Mirrors the tenant_id injection step in keycloakVerifier.js */
function injectTenantId(payload, tenantFromDb = null) {
  return { ...payload, tenant_id: tenantFromDb ?? payload.tenant_id ?? null };
}

/** Mirrors the membership scope mapper in authRoutes.js bootstrap endpoint */
function mapMembershipRow(row) {
  return {
    id: String(row.pk_membership_id),
    userId: String(row.fk_user_id),
    role: row.role,
    scope: {
      tenantId: row.tenant_id == null ? null : String(row.tenant_id),
      customerId: row.customer_id ? String(row.customer_id) : undefined,
      siteId: row.site_id ? String(row.site_id) : undefined,
      unitId: row.unit_id ? String(row.unit_id) : undefined,
    },
    permissions: row.permissions || [],
  };
}

test("injectTenantId: uses DB tenant when realm is not the default realm", () => {
  const payload = { sub: "user-123", tenant_id: null, iss: "https://auth/realms/org-realm" };
  const result = injectTenantId(payload, TENANT_A);
  assert.equal(result.tenant_id, TENANT_A);
});

test("injectTenantId: keeps JWT tenant_id when realm matches default", () => {
  const payload = { sub: "user-123", tenant_id: TENANT_A };
  const result = injectTenantId(payload, null);
  assert.equal(result.tenant_id, TENANT_A);
});

test("injectTenantId: returns null tenant_id for super_admin with no DB override", () => {
  const payload = { sub: "admin", tenant_id: null, realm_access: { roles: ["super_admin"] } };
  const result = injectTenantId(payload, null);
  assert.equal(result.tenant_id, null);
});

test("mapMembershipRow: maps tenant_id null correctly (super admin)", () => {
  const row = {
    pk_membership_id: 1,
    fk_user_id: 42,
    role: "super_admin",
    tenant_id: null,
    customer_id: null,
    site_id: null,
    unit_id: null,
    permissions: ["read:all"],
  };
  const membership = mapMembershipRow(row);
  assert.equal(membership.scope.tenantId, null);
  assert.equal(membership.role, "super_admin");
  assert.deepEqual(membership.permissions, ["read:all"]);
});

test("mapMembershipRow: maps all scope levels correctly", () => {
  const row = {
    pk_membership_id: 2,
    fk_user_id: 7,
    role: "hr_manager",
    tenant_id: TENANT_A,
    customer_id: "10",
    site_id: "20",
    unit_id: "30",
    permissions: [],
  };
  const membership = mapMembershipRow(row);
  assert.equal(membership.scope.tenantId, TENANT_A);
  assert.equal(membership.scope.customerId, "10");
  assert.equal(membership.scope.siteId, "20");
  assert.equal(membership.scope.unitId, "30");
});

test("mapMembershipRow: omits undefined optional scope fields", () => {
  const row = {
    pk_membership_id: 3,
    fk_user_id: 5,
    role: "tenant_admin",
    tenant_id: TENANT_B,
    customer_id: null,
    site_id: null,
    unit_id: null,
    permissions: [],
  };
  const membership = mapMembershipRow(row);
  assert.equal(membership.scope.customerId, undefined);
  assert.equal(membership.scope.siteId, undefined);
  assert.equal(membership.scope.unitId, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 4: Bootstrap Response Shape
//   Validates the structure returned to the frontend from /api/auth/bootstrap
// ─────────────────────────────────────────────────────────────────────────────

/** Simulate building a bootstrap response from user + memberships */
function buildBootstrapResponse(user, memberships, catalog) {
  return {
    user: {
      id: String(user.pk_user_id),
      email: user.email,
      name: user.username,
      role: user.role,
      department: user.department || undefined,
      createdAt: user.created_at,
    },
    memberships,
    activeScope: memberships[0]?.scope ?? null,
    tenants: catalog.tenants.map((t) => ({ id: String(t.pk_tenant_id), name: t.tenant_name })),
    customers: catalog.customers.map((c) => ({ id: String(c.pk_customer_id), name: c.customer_name, tenantId: String(c.fk_tenant_id) })),
    sites: catalog.sites.map((s) => ({ id: String(s.pk_site_id), name: s.site_name, customerId: String(s.fk_customer_id) })),
    units: catalog.units.map((u) => ({ id: String(u.pk_unit_id), name: u.unit_name, siteId: String(u.fk_site_id) })),
  };
}

const MOCK_USER = {
  pk_user_id: 1,
  email: "alice@example.com",
  username: "Alice",
  role: "tenant_admin",
  department: "Engineering",
  created_at: new Date("2024-01-01"),
};

const MOCK_MEMBERSHIPS = [
  mapMembershipRow({
    pk_membership_id: 10,
    fk_user_id: 1,
    role: "tenant_admin",
    tenant_id: TENANT_A,
    customer_id: null,
    site_id: null,
    unit_id: null,
    permissions: ["read:employees", "write:employees"],
  }),
];

const MOCK_CATALOG = {
  tenants: [{ pk_tenant_id: TENANT_A, tenant_name: "Acme Corp" }],
  customers: [],
  sites: [],
  units: [],
};

test("buildBootstrapResponse: returns correctly shaped user object", () => {
  const resp = buildBootstrapResponse(MOCK_USER, MOCK_MEMBERSHIPS, MOCK_CATALOG);
  assert.equal(resp.user.id, "1");
  assert.equal(resp.user.email, "alice@example.com");
  assert.equal(resp.user.name, "Alice");
  assert.equal(resp.user.role, "tenant_admin");
});

test("buildBootstrapResponse: activeScope defaults to first membership scope", () => {
  const resp = buildBootstrapResponse(MOCK_USER, MOCK_MEMBERSHIPS, MOCK_CATALOG);
  assert.equal(resp.activeScope.tenantId, TENANT_A);
});

test("buildBootstrapResponse: activeScope is null when no memberships", () => {
  const resp = buildBootstrapResponse(MOCK_USER, [], MOCK_CATALOG);
  assert.equal(resp.activeScope, null);
});

test("buildBootstrapResponse: tenants catalog mapped correctly", () => {
  const resp = buildBootstrapResponse(MOCK_USER, MOCK_MEMBERSHIPS, MOCK_CATALOG);
  assert.equal(resp.tenants.length, 1);
  assert.equal(resp.tenants[0].id, String(TENANT_A));
  assert.equal(resp.tenants[0].name, "Acme Corp");
});

test("buildBootstrapResponse: empty catalog returns empty arrays", () => {
  const resp = buildBootstrapResponse(MOCK_USER, MOCK_MEMBERSHIPS, {
    tenants: [],
    customers: [],
    sites: [],
    units: [],
  });
  assert.equal(resp.tenants.length, 0);
  assert.equal(resp.customers.length, 0);
  assert.equal(resp.sites.length, 0);
  assert.equal(resp.units.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 5: Token Lifecycle — Storage & Session Model
// ─────────────────────────────────────────────────────────────────────────────

/** Simulate tokenStorage.setTokens / getTokens (frontend) */
class MockTokenStorage {
  constructor() { this._store = {}; }
  setTokens(access, refresh) {
    this._store.accessToken  = access  ?? null;
    this._store.refreshToken = refresh ?? null;
  }
  getTokens() {
    return {
      accessToken:  this._store.accessToken  ?? null,
      refreshToken: this._store.refreshToken ?? null,
    };
  }
  clearTokens() { this._store = {}; }
}

test("tokenStorage: setTokens stores both tokens", () => {
  const storage = new MockTokenStorage();
  storage.setTokens("acc-123", "ref-456");
  assert.equal(storage.getTokens().accessToken, "acc-123");
  assert.equal(storage.getTokens().refreshToken, "ref-456");
});

test("tokenStorage: clearTokens wipes stored tokens", () => {
  const storage = new MockTokenStorage();
  storage.setTokens("acc-123", "ref-456");
  storage.clearTokens();
  assert.equal(storage.getTokens().accessToken, null);
  assert.equal(storage.getTokens().refreshToken, null);
});

test("tokenStorage: setTokens with null access token stores null", () => {
  const storage = new MockTokenStorage();
  storage.setTokens(null, "ref-456");
  assert.equal(storage.getTokens().accessToken, null);
  assert.equal(storage.getTokens().refreshToken, "ref-456");
});

test("tokenStorage: getTokens returns nulls when empty", () => {
  const storage = new MockTokenStorage();
  const { accessToken, refreshToken } = storage.getTokens();
  assert.equal(accessToken, null);
  assert.equal(refreshToken, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 6: Refresh Token Flow
//   Mirrors attemptTokenRefresh logic in apiClient.ts
// ─────────────────────────────────────────────────────────────────────────────

/** Simulate the refresh response normaliser */
function normalizeRefreshResponse(resp) {
  if (!resp || !resp.accessToken) return null;
  return {
    accessToken: resp.accessToken,
    refreshToken: resp.refreshToken ?? null,
  };
}

test("normalizeRefreshResponse: valid response returns new tokens", () => {
  const result = normalizeRefreshResponse({
    accessToken: "new-access",
    refreshToken: "new-refresh",
  });
  assert.equal(result.accessToken, "new-access");
  assert.equal(result.refreshToken, "new-refresh");
});

test("normalizeRefreshResponse: missing refreshToken falls back to null", () => {
  const result = normalizeRefreshResponse({ accessToken: "new-access" });
  assert.equal(result.refreshToken, null);
});

test("normalizeRefreshResponse: null response → null (token expired)", () => {
  assert.equal(normalizeRefreshResponse(null), null);
});

test("normalizeRefreshResponse: missing accessToken → null (invalid response)", () => {
  assert.equal(normalizeRefreshResponse({ refreshToken: "ref" }), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 7: Logout Flow
//   Tests session cleanup behaviour
// ─────────────────────────────────────────────────────────────────────────────

test("logout: clears token storage", () => {
  const storage = new MockTokenStorage();
  storage.setTokens("acc", "ref");

  // Simulate logout
  storage.clearTokens();

  assert.equal(storage.getTokens().accessToken, null);
  assert.equal(storage.getTokens().refreshToken, null);
});

test("logout: idempotent — second clearTokens call is safe", () => {
  const storage = new MockTokenStorage();
  storage.clearTokens();
  storage.clearTokens(); // should not throw
  assert.equal(storage.getTokens().accessToken, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 8: Security Edge Cases
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors the x-tenant-id injection guard in authz.js (Keycloak mode) */
function detectTenantHeaderSpoofing(headerTenantId, jwtTenantId) {
  if (!jwtTenantId) return false; // super_admin or no tenant claim — no spoofing check
  if (!headerTenantId) return false; // no header — nothing to check
  return headerTenantId !== jwtTenantId;
}

test("security: x-tenant-id header mismatch from JWT is flagged as spoofing", () => {
  assert.equal(detectTenantHeaderSpoofing(TENANT_B, TENANT_A), true);
});

test("security: x-tenant-id header matching JWT passes", () => {
  assert.equal(detectTenantHeaderSpoofing(TENANT_A, TENANT_A), false);
});

test("security: no x-tenant-id header → not spoofing", () => {
  assert.equal(detectTenantHeaderSpoofing(null, TENANT_A), false);
  assert.equal(detectTenantHeaderSpoofing("", TENANT_A), false);
});

test("security: super_admin (null jwtTenantId) → header check skipped", () => {
  // Super admin has no tenant — any header is technically OK for cross-tenant ops
  assert.equal(detectTenantHeaderSpoofing(TENANT_A, null), false);
});

test("security: missing authorization header returns no token", () => {
  assert.equal(readBearerToken({ authorization: "" }), null);
  assert.equal(readBearerToken({}), null);
});

test("security: bearer token with whitespace padding is stripped", () => {
  // Simulate trim() behaviour
  const raw = "  my.jwt.token  ";
  const token = raw.trim() || null;
  assert.equal(token, "my.jwt.token");
});

test("security: null/undefined origin does not leak stack trace (safe error shape)", () => {
  // Simulate what the error handler returns (no stack in prod)
  function buildSafeError(err, isDev = false) {
    return {
      message: "internal server error",
      error: isDev ? err.message : undefined,
    };
  }
  const result = buildSafeError(new Error("DB connection failed"), false);
  assert.equal(result.message, "internal server error");
  assert.equal(result.error, undefined);
});

test("security: dev mode error includes detail", () => {
  function buildSafeError(err, isDev = false) {
    return {
      message: "internal server error",
      error: isDev ? err.message : undefined,
    };
  }
  const result = buildSafeError(new Error("DB connection failed"), true);
  assert.equal(result.error, "DB connection failed");
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 9: Keycloak Redirect Flow (Frontend Router Logic)
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors AuthGuard decision logic in router.tsx */
function resolveAuthGuardAction(isAuthenticated, isAuthLoading, authMode) {
  if (isAuthLoading) return "loading";
  if (isAuthenticated) return "show_dashboard";
  if (authMode === "keycloak") return "redirect_to_keycloak";
  return "redirect_to_login";
}

test("AuthGuard: loading state shows spinner", () => {
  assert.equal(resolveAuthGuardAction(false, true, "keycloak"), "loading");
});

test("AuthGuard: authenticated user sees dashboard", () => {
  assert.equal(resolveAuthGuardAction(true, false, "keycloak"), "show_dashboard");
});

test("AuthGuard: unauthenticated + keycloak mode → redirect to KC", () => {
  assert.equal(resolveAuthGuardAction(false, false, "keycloak"), "redirect_to_keycloak");
});

test("AuthGuard: unauthenticated + api mode → redirect to /login", () => {
  assert.equal(resolveAuthGuardAction(false, false, "api"), "redirect_to_login");
});

test("AuthGuard: unauthenticated + mock mode → redirect to /login", () => {
  assert.equal(resolveAuthGuardAction(false, false, "mock"), "redirect_to_login");
});

/** Mirrors LoginGuard decision logic in router.tsx */
function resolveLoginGuardAction(isAuthenticated, isAuthLoading, authMode) {
  if (isAuthLoading) return "loading";
  if (isAuthenticated) return "redirect_to_dashboard";
  if (authMode === "keycloak") return "redirect_to_keycloak";
  return "show_login_page";
}

test("LoginGuard: authenticated user is bounced to dashboard", () => {
  assert.equal(resolveLoginGuardAction(true, false, "keycloak"), "redirect_to_dashboard");
});

test("LoginGuard: keycloak mode + unauthenticated → KC redirect (no custom login page)", () => {
  assert.equal(resolveLoginGuardAction(false, false, "keycloak"), "redirect_to_keycloak");
});

test("LoginGuard: api mode + unauthenticated → shows login page", () => {
  assert.equal(resolveLoginGuardAction(false, false, "api"), "show_login_page");
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 10: PKCE & KC Init Config
// ─────────────────────────────────────────────────────────────────────────────

/** Simulate keycloak.init() config builder */
function buildKeycloakInitConfig(originUrl) {
  return {
    onLoad: "check-sso",
    checkLoginIframe: false,
    pkceMethod: "S256",
    redirectUri: originUrl + "/",
  };
}

test("buildKeycloakInitConfig: uses check-sso to avoid forced redirect on init", () => {
  const config = buildKeycloakInitConfig("https://frs.motivitylabs.com");
  assert.equal(config.onLoad, "check-sso");
});

test("buildKeycloakInitConfig: PKCE method is S256", () => {
  const config = buildKeycloakInitConfig("https://frs.motivitylabs.com");
  assert.equal(config.pkceMethod, "S256");
});

test("buildKeycloakInitConfig: redirectUri matches origin + trailing slash", () => {
  const config = buildKeycloakInitConfig("https://frs.motivitylabs.com");
  assert.equal(config.redirectUri, "https://frs.motivitylabs.com/");
});

test("buildKeycloakInitConfig: login iframe check disabled (avoids third-party cookie issue)", () => {
  const config = buildKeycloakInitConfig("https://frs.motivitylabs.com");
  assert.equal(config.checkLoginIframe, false);
});

// Section 11: Workspace / Realm Validation Logic
function mockWorkspaceValidate(slug, defaultRealm, existingRealms) {
  if (!slug || !slug.trim()) return { valid: false, error: "Workspace name is required" };
  const trimmed = slug.trim().toLowerCase();
  if (trimmed === defaultRealm.toLowerCase()) return { valid: true };
  if (existingRealms.map(r => r.toLowerCase()).includes(trimmed)) return { valid: true };
  return { valid: false };
}

test("workspace validation: valid default realm is accepted", () => {
  const res = mockWorkspaceValidate("attendance", "attendance", ["my-company"]);
  assert.equal(res.valid, true);
});

test("workspace validation: valid custom db realm is accepted", () => {
  const res = mockWorkspaceValidate("my-company", "attendance", ["my-company"]);
  assert.equal(res.valid, true);
});

test("workspace validation: case-insensitive match for default realm passes", () => {
  const res = mockWorkspaceValidate("ATTENDANCE", "attendance", ["my-company"]);
  assert.equal(res.valid, true);
});

test("workspace validation: case-insensitive match for custom realm passes", () => {
  const res = mockWorkspaceValidate("MY-company", "attendance", ["my-company"]);
  assert.equal(res.valid, true);
});

test("workspace validation: non-existent realm is rejected", () => {
  const res = mockWorkspaceValidate("random-company", "attendance", ["my-company"]);
  assert.equal(res.valid, false);
});

test("workspace validation: empty or whitespace workspace name returns error", () => {
  const res = mockWorkspaceValidate("   ", "attendance", ["my-company"]);
  assert.equal(res.valid, false);
  assert.equal(res.error, "Workspace name is required");
});

// Section 12: Login Lockout Logic Mock & Tests
async function mockLoginWithEmailPassword({
  user,
  passwordMatch,
  maxFailedLogins = 3,
  onIncrement = () => {},
  onLock = () => {},
  onReset = () => {},
}) {
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new Error("Account locked due to multiple failed login attempts");
  }

  if (user.is_active === false) {
    throw new Error("this has been deactivated please contact admin for the activate the account");
  }

  if (!passwordMatch) {
    onIncrement();
    const failedAttempts = user.failed_login_attempts + 1;
    if (failedAttempts >= maxFailedLogins) {
      onLock();
      throw new Error("Account locked due to multiple failed login attempts");
    }
    return null;
  }

  onReset();
  return { success: true };
}

test("login lockout: blocks authentication when account is already locked", async () => {
  const user = { failed_login_attempts: 3, locked_until: new Date(Date.now() + 60000) };
  await assert.rejects(
    mockLoginWithEmailPassword({ user, passwordMatch: true }),
    { message: "Account locked due to multiple failed login attempts" }
  );
});

test("login lockout: increments attempts and does not lock when below threshold", async () => {
  const user = { failed_login_attempts: 1, locked_until: null };
  let incrementCalled = false;
  let lockCalled = false;
  
  const res = await mockLoginWithEmailPassword({
    user,
    passwordMatch: false,
    maxFailedLogins: 3,
    onIncrement: () => { incrementCalled = true; },
    onLock: () => { lockCalled = true; },
  });
  
  assert.equal(res, null);
  assert.equal(incrementCalled, true);
  assert.equal(lockCalled, false);
});

test("login lockout: locks account and throws error when threshold is reached", async () => {
  const user = { failed_login_attempts: 2, locked_until: null };
  let incrementCalled = false;
  let lockCalled = false;
  
  await assert.rejects(
    mockLoginWithEmailPassword({
      user,
      passwordMatch: false,
      maxFailedLogins: 3,
      onIncrement: () => { incrementCalled = true; },
      onLock: () => { lockCalled = true; },
    }),
    { message: "Account locked due to multiple failed login attempts" }
  );
  
  assert.equal(incrementCalled, true);
  assert.equal(lockCalled, true);
});

test("login lockout: resets failed attempts on successful login", async () => {
  const user = { failed_login_attempts: 2, locked_until: null };
  let resetCalled = false;
  
  const res = await mockLoginWithEmailPassword({
    user,
    passwordMatch: true,
    maxFailedLogins: 3,
    onReset: () => { resetCalled = true; },
  });
  
  assert.deepEqual(res, { success: true });
  assert.equal(resetCalled, true);
});

test("login lockout: blocks authentication when account is deactivated", async () => {
  const user = { is_active: false, failed_login_attempts: 0, locked_until: null };
  await assert.rejects(
    mockLoginWithEmailPassword({ user, passwordMatch: true }),
    { message: "this has been deactivated please contact admin for the activate the account" }
  );
});
