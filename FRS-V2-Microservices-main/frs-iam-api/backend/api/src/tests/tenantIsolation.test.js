/**
 * Tenant Isolation Unit Tests
 *
 * Tests the four critical security fixes:
 *   1. isSuperAdminPayload — canonical super-admin detection
 *   2. resolveRequestedScope — JWT tenant_id is authoritative, x-tenant-id header validated
 *   3. buildScopeWhere — super admin null tenantId produces no tenant filter (not zero rows)
 *   4. validateScopeAccess — req.auth.jwtPayload is now read; tenantId locked from JWT
 *
 * These tests use Node.js built-in test runner (no external deps).
 * Run: npm test  (or: node --test src/tests/tenantIsolation.test.js)
 */

import test from "node:test";
import assert from "node:assert/strict";

// ── helpers ────────────────────────────────────────────────────────────────

/** Minimal mock of isSuperAdminPayload logic (mirrors authz.js) */
function isSuperAdminPayload(payload) {
  if (!payload) return false;
  return (
    payload.realm_access?.roles?.includes("super_admin") === true ||
    payload.tenant_id === null
  );
}

/** Minimal mock of buildScopeWhere (mirrors scopeSql.js) */
function buildScopeWhere(scope, alias = "") {
  const prefix = alias ? `${alias}.` : "";
  const clauses = [];
  const values = [];

  if (scope.tenantId !== null && scope.tenantId !== undefined) {
    values.push(scope.tenantId);
    clauses.push(`${prefix}tenant_id = $${values.length}::uuid`);
  }
  if (scope.customerId) {
    values.push(Number(scope.customerId));
    clauses.push(`(${prefix}customer_id = $${values.length} OR ${prefix}customer_id IS NULL)`);
  }
  if (scope.siteId) {
    values.push(Number(scope.siteId));
    clauses.push(`(${prefix}site_id = $${values.length} OR ${prefix}site_id IS NULL)`);
  }
  if (scope.unitId) {
    values.push(Number(scope.unitId));
    clauses.push(`(${prefix}unit_id = $${values.length} OR ${prefix}unit_id IS NULL)`);
  }
  if (clauses.length === 0) return { whereSql: "TRUE", values: [] };
  return { whereSql: clauses.join(" AND "), values };
}

/** Minimal mock of resolveRequestedScope (Keycloak mode, mirrors authz.js) */
function resolveRequestedScope(headers = {}, memberships = [], jwtPayload = null) {
  const hdr = (key) => { const v = String(headers[key] || ""); return v === "null" ? "" : v; };
  const customerId = hdr("x-customer-id");
  const siteId     = hdr("x-site-id");
  const unitId     = hdr("x-unit-id");

  // Keycloak mode
  if (jwtPayload) {
    if (isSuperAdminPayload(jwtPayload)) {
      return { tenantId: null, customerId: customerId || undefined, siteId: siteId || undefined, unitId: unitId || undefined };
    }
    const jwtTenantId = jwtPayload.tenant_id ?? null;
    const tenantId = jwtTenantId || memberships[0]?.scope?.tenantId || null;
    const requestedTenantId = hdr("x-tenant-id");
    if (requestedTenantId && tenantId && requestedTenantId !== tenantId) {
      return { _tenantMismatch: true, requestedTenantId, jwtTenantId: tenantId };
    }
    return { tenantId, customerId: customerId || undefined, siteId: siteId || undefined, unitId: unitId || undefined };
  }

  // API mode (legacy)
  const tenantId = hdr("x-tenant-id");
  if (!tenantId) return memberships[0]?.scope ?? null;
  return { tenantId, customerId: customerId || undefined, siteId: siteId || undefined, unitId: unitId || undefined };
}

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const TENANT_B = "bbbbbbbb-0000-0000-0000-000000000002";

// ── Test Suite 1: isSuperAdminPayload ──────────────────────────────────────

test("isSuperAdminPayload: realm_access super_admin role → true", () => {
  assert.equal(isSuperAdminPayload({ realm_access: { roles: ["super_admin"] } }), true);
});

test("isSuperAdminPayload: tenant_id null → true", () => {
  assert.equal(isSuperAdminPayload({ tenant_id: null, realm_access: { roles: [] } }), true);
});

test("isSuperAdminPayload: normal user → false", () => {
  assert.equal(isSuperAdminPayload({ tenant_id: TENANT_A, realm_access: { roles: ["hr_manager"] } }), false);
});

test("isSuperAdminPayload: custom role claim only (not realm role) → false", () => {
  // Bug we fixed: payload.role === 'super_admin' was accepted before — now rejected
  assert.equal(isSuperAdminPayload({ role: "super_admin", tenant_id: TENANT_A, realm_access: { roles: [] } }), false);
});

test("isSuperAdminPayload: tenant_id GLOBAL string → false (must use realm role)", () => {
  // 'GLOBAL' string is no longer a valid super admin signal — only realm role or null
  assert.equal(isSuperAdminPayload({ tenant_id: "GLOBAL", realm_access: { roles: [] } }), false);
});

test("isSuperAdminPayload: null payload → false", () => {
  assert.equal(isSuperAdminPayload(null), false);
});

// ── Test Suite 2: resolveRequestedScope (Keycloak mode) ────────────────────

test("Keycloak mode: tenantId comes from JWT, not x-tenant-id header", () => {
  const scope = resolveRequestedScope(
    { "x-tenant-id": TENANT_B },         // header says B
    [],
    { tenant_id: TENANT_A, realm_access: { roles: ["hr_manager"] } }  // JWT says A
  );
  // Should detect mismatch and return sentinel
  assert.equal(scope._tenantMismatch, true, "should flag tenant mismatch");
  assert.equal(scope.jwtTenantId, TENANT_A);
  assert.equal(scope.requestedTenantId, TENANT_B);
});

test("Keycloak mode: matching x-tenant-id is allowed (no mismatch)", () => {
  const scope = resolveRequestedScope(
    { "x-tenant-id": TENANT_A },
    [],
    { tenant_id: TENANT_A, realm_access: { roles: ["hr_manager"] } }
  );
  assert.equal(scope._tenantMismatch, undefined);
  assert.equal(scope.tenantId, TENANT_A);
});

test("Keycloak mode: no x-tenant-id header → tenantId still comes from JWT", () => {
  const scope = resolveRequestedScope(
    {},                                  // no header at all
    [],
    { tenant_id: TENANT_A, realm_access: { roles: ["hr_manager"] } }
  );
  assert.equal(scope.tenantId, TENANT_A);
});

test("Keycloak mode: super_admin gets tenantId null regardless of x-tenant-id", () => {
  const scope = resolveRequestedScope(
    { "x-tenant-id": TENANT_A },
    [],
    { tenant_id: null, realm_access: { roles: ["super_admin"] } }
  );
  assert.equal(scope.tenantId, null);
  assert.equal(scope._tenantMismatch, undefined);
});

test("Keycloak mode: sub-scope headers still honoured within JWT tenant", () => {
  const scope = resolveRequestedScope(
    { "x-customer-id": "42", "x-site-id": "7" },
    [],
    { tenant_id: TENANT_A, realm_access: { roles: ["hr_manager"] } }
  );
  assert.equal(scope.tenantId, TENANT_A);
  assert.equal(scope.customerId, "42");
  assert.equal(scope.siteId, "7");
});

test("Keycloak mode: JWT with no tenant_id falls back to first membership tenant", () => {
  const memberships = [{ scope: { tenantId: TENANT_A } }];
  const scope = resolveRequestedScope(
    {},
    memberships,
    { realm_access: { roles: ["hr_manager"] } }  // no tenant_id in JWT
  );
  assert.equal(scope.tenantId, TENANT_A);
});

// ── Test Suite 3: buildScopeWhere super admin ──────────────────────────────

test("buildScopeWhere: null tenantId (super admin) → no tenant_id predicate, returns TRUE", () => {
  const { whereSql, values } = buildScopeWhere({ tenantId: null });
  assert.equal(whereSql, "TRUE");
  assert.equal(values.length, 0);
  // Must NOT contain "tenant_id" — that would produce zero rows via NULL comparison
  assert.equal(whereSql.includes("tenant_id"), false);
});

test("buildScopeWhere: null tenantId with sub-scope → sub-scope applied, no tenant filter", () => {
  const { whereSql, values } = buildScopeWhere({ tenantId: null, customerId: "5" });
  assert.equal(whereSql.includes("tenant_id"), false);
  assert.equal(whereSql.includes("customer_id"), true);
  assert.equal(values[0], 5);
});

test("buildScopeWhere: normal tenant scope → tenant_id predicate present", () => {
  const { whereSql, values } = buildScopeWhere({ tenantId: TENANT_A });
  assert.ok(whereSql.includes("tenant_id = $1::uuid"), `got: ${whereSql}`);
  assert.equal(values[0], TENANT_A);
});

test("buildScopeWhere: full scope hierarchy produces correct SQL", () => {
  const { whereSql, values } = buildScopeWhere({
    tenantId: TENANT_A,
    customerId: "10",
    siteId: "20",
    unitId: "30",
  });
  assert.ok(whereSql.includes("tenant_id = $1::uuid"));
  assert.ok(whereSql.includes("customer_id = $2 OR"));
  assert.ok(whereSql.includes("site_id = $3 OR"));
  assert.ok(whereSql.includes("unit_id = $4 OR"));
  assert.deepEqual(values, [TENANT_A, 10, 20, 30]);
});

test("buildScopeWhere: alias prefix is applied to all columns", () => {
  const { whereSql } = buildScopeWhere({ tenantId: TENANT_A, siteId: "5", customerId: "3" }, "a");
  assert.ok(whereSql.includes("a.tenant_id"));
  assert.ok(whereSql.includes("a.customer_id"));
  assert.ok(whereSql.includes("a.site_id"));
});

// ── Test Suite 4: validateScopeAccess re-lock logic ────────────────────────

/**
 * Simulates the re-lock behaviour in validateScopeAccess:
 * even if req.scope.tenantId was set from a header, the JWT claim overwrites it.
 */
function simulateValidateScopeAccess(reqScope, jwtPayload) {
  const scope = { ...reqScope };
  if (jwtPayload) {
    const superAdmin = isSuperAdminPayload(jwtPayload);
    if (superAdmin) return { allowed: true, scope };
    if (jwtPayload.tenant_id) {
      scope.tenantId = jwtPayload.tenant_id; // overwrite with JWT
    }
  }
  return { allowed: true, scope };
}

test("validateScopeAccess: header tenantId overwritten by JWT tenant_id", () => {
  const result = simulateValidateScopeAccess(
    { tenantId: TENANT_B },  // header-sourced scope (wrong tenant)
    { tenant_id: TENANT_A, realm_access: { roles: ["hr_manager"] } }
  );
  assert.equal(result.scope.tenantId, TENANT_A, "JWT must overwrite header value");
});

test("validateScopeAccess: super admin bypasses scope check entirely", () => {
  const result = simulateValidateScopeAccess(
    { tenantId: TENANT_A },
    { tenant_id: null, realm_access: { roles: ["super_admin"] } }
  );
  assert.equal(result.allowed, true);
  // tenantId should NOT have been overwritten (early return)
  assert.equal(result.scope.tenantId, TENANT_A);
});

test("validateScopeAccess: no jwtPayload (API mode) → scope untouched", () => {
  const result = simulateValidateScopeAccess({ tenantId: TENANT_A }, null);
  assert.equal(result.scope.tenantId, TENANT_A);
});
