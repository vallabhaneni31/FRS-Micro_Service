/**
 * ============================================================================
 * KEYCLOAK (AUTHENTICATION) vs DATABASE RBAC (AUTHORIZATION) TRUST BOUNDARY
 * ============================================================================
 *
 * 1. Keycloak (Identity & Authentication)
 *    - Keycloak is the authoritative Identity Provider (IdP) for the FRS system.
 *    - Responsibility: AUTHENTICATION. It cryptographically signs JWTs confirming
 *      "who" the user is (via token signatures, subject keycloak_sub/sub claims) and
 *      their primary login credentials.
 *    - Access Tokens: Are signed and verified at the middleware layer using Keycloak's
 *      JWKS keys. This guarantees that token payloads have not been tampered with.
 *
 * 2. PostgreSQL Database RBAC (Access Control & Authorization)
 *    - The local PostgreSQL database is the authoritative source for AUTHORIZATION.
 *    - Responsibility: ACCESS CONTROL (permissions, capabilities, sites, tenants).
 *    - Separation of Concerns:
 *      * Keycloak roles (e.g. realm roles) represent high-level authentication tags.
 *      * PostgreSQL tables (`rbac_role`, `rbac_permission`, `rbac_role_permission`,
 *        `user_role`, `frs_tenant_user_map`) store deep granular mapping of what
 *        capabilities (e.g., `sites.read`, `devices.write`) a user has inside their
 *        scoped tenant and sites.
 *    - Security Boundary:
 *      * A user successfully authenticated via Keycloak cannot perform any tenant
 *        actions unless their Keycloak subject sub is mapped to a valid database
 *        user record (`frs_user.keycloak_sub`) and they possess explicit active
 *        memberships in `user_role` and `frs_tenant_user_map`.
 *      * The database layer isolates data per-tenant via tenant scope filters or RLS policies.
 * ============================================================================
 */

import { bootstrapWithAccessToken } from "../services/authService.js";
import { env } from "../config/env.js";
import { verifyKeycloakToken } from "./keycloakVerifier.js";
import { findUserByKeycloakSub, getMembershipsByUserId, getRbacPermissionsForUser } from "../repositories/authRepository.js";
import { provisionKeycloakUser } from "../services/provisionUser.js";
import {
    getUserBySSOSub,
    provisionMtUser,
    getUserScopes,
    isUserSuperAdmin,
    getTenantById,
    featuresForTenant,
} from "../services/multitenant.js";
import { writeAudit } from "./auditLog.js";
import logger from '../utils/logger.js';
import { pool } from '../db/pool.js';
import { getCachedAuth, setCachedAuth } from '../services/authCache.js';

function readBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim();
}

/**
 * S-01: Read access token from httpOnly cookie first (API-mode human sessions),
 * falling back to Authorization: Bearer header (Keycloak JWTs, device JWTs).
 */
function readToken(req) {
  // Keycloak mode authenticates via the Bearer JWT. A stale legacy `access_token`
  // cookie (left over from API-mode sessions) must NOT shadow it, or token
  // verification fails ("Invalid JWT") and the request falls through to fallbacks.
  if (env.authMode === "keycloak") return readBearerToken(req) || req.cookies?.access_token || null;
  if (req.cookies?.access_token) return req.cookies.access_token;
  return readBearerToken(req);
}

/**
 * Single canonical super-admin check. Only realm_access.roles is authoritative —
 * Keycloak realm roles are cryptographically signed. The tenant_id===null check
 * is kept as a secondary signal for JWT payloads already normalised in this process.
 */
export function isSuperAdminPayload(payload) {
  if (!payload) return false;
  return (
    payload.realm_access?.roles?.includes('super_admin') === true ||
    payload.tenant_id === null
  );
}

/**
 * Resolve the active request scope from the JWT (Keycloak mode) or headers (API mode).
 *
 * Security contract (Keycloak mode):
 *   - tenantId is ALWAYS taken from the signed JWT claim `tenant_id`.
 *   - x-tenant-id header is IGNORED for scope derivation; it may only be used by
 *     the frontend as a hint for which sub-scope (customer/site/unit) to render.
 *   - If the JWT carries no tenant_id claim (Keycloak Protocol Mapper not yet
 *     configured) we fall back to the first membership's tenantId so the system
 *     degrades gracefully, but emit a warning so operators know to add the mapper.
 *   - super_admin payloads get tenantId = null (global access).
 *
 * Sub-tenant headers (x-customer-id, x-site-id, x-unit-id) are still read from
 * request headers because they narrow scope *within* a tenant that is already
 * established by the JWT — they cannot escalate to a different tenant.
 */
function resolveRequestedScope(req, memberships, jwtPayload) {
  const hdr = (key) => { const v = String(req.headers[key] || req.query[key] || ""); return v === "null" ? "" : v; };
  const customerId = hdr("x-customer-id");
  const siteId     = hdr("x-site-id");
  const unitId     = hdr("x-unit-id");

  if (env.authMode === "keycloak" && jwtPayload) {
    if (isSuperAdminPayload(jwtPayload)) {
      // Super admin: can assume any tenant scope, or global (null) if none provided
      const requestedTenantId = hdr("x-tenant-id");
      const resolved = {
        tenantId: requestedTenantId || null,
        customerId: customerId || undefined,
        siteId: siteId || undefined,
        unitId: unitId || undefined,
      };
      logger.debug('[auth] super_admin scope resolved:', JSON.stringify(resolved));
      return resolved;
    }

    // Keycloak mode: JWT tenant_id is authoritative
    const jwtTenantId = jwtPayload.tenant_id ?? null;
    if (!jwtTenantId) {
      logger.warn('[auth] JWT missing tenant_id claim — Keycloak Protocol Mapper may not be configured. Falling back to membership tenant.');
    }
    const tenantId = jwtTenantId || memberships[0]?.scope?.tenantId || null;

    // Validate x-tenant-id header if provided — must match JWT. A mismatch
    // here means the client is actively trying to claim a different tenant
    // than the one its token was issued for, so this is flagged for
    // requireAuth to reject outright rather than silently overridden.
    const requestedTenantId = hdr("x-tenant-id");
    const tenantMismatch = !!(requestedTenantId && tenantId && requestedTenantId !== tenantId);
    if (tenantMismatch) {
      logger.warn(`[auth] Mismatched x-tenant-id header (${requestedTenantId}) — rejecting (authenticated JWT tenant_id is ${tenantId})`);
    }

    const resolved = {
      tenantId,
      customerId: customerId || undefined,
      siteId: siteId || undefined,
      unitId: unitId || undefined,
      _tenantMismatch: tenantMismatch,
    };
    logger.debug('[auth] JWT-locked scope resolved:', JSON.stringify(resolved));
    return resolved;
  }

  // ── Legacy API mode: header-driven scope (unchanged behaviour) ──
  const tenantId = hdr("x-tenant-id");
  if (!tenantId) {
    return memberships[0]?.scope ?? null;
  }
  const resolved = {
    tenantId,
    customerId: customerId || undefined,
    siteId: siteId || undefined,
    unitId: unitId || undefined,
  };
  logger.debug('[auth] resolved requested scope:', JSON.stringify(resolved));
  return resolved;
}

function canAccessScope(membership, scope) {
  if (!scope) return false;

  // null tenantId = global role (super_admin) — can access any scope
  if (membership.scope.tenantId === null) return true;

  // Tenant must match
  if (membership.scope.tenantId !== scope.tenantId) {
    logger.debug(`[auth] tenant mismatch: mem=${membership.scope.tenantId} vs req=${scope.tenantId}`);
    return false;
  }
  
  // Site scoping check
  if (scope.siteId && membership.scope.siteId !== null && membership.scope.siteId !== scope.siteId) {
    logger.debug(`[auth] site mismatch: mem=${membership.scope.siteId} vs req=${scope.siteId}`);
    return false;
  }

  // Unit scoping check
  if (scope.unitId && membership.scope.unitId !== null && membership.scope.unitId !== scope.unitId) {
    logger.debug(`[auth] unit mismatch: mem=${membership.scope.unitId} vs req=${scope.unitId}`);
    return false;
  }
  
  return true;
}

/* ------------------------------------------------------------------ */
/*  Keycloak mode: JWT verification via jose/JWKS                      */
/* ------------------------------------------------------------------ */

// AB#2812: provisionKeycloakUser() (provisionUser.js) returns null when the
// JWT lacks email/sub instead of throwing — this guard turns that into a
// clear, specific error at the point of failure, rather than letting a
// downstream `String(legacyUser.pk_user_id)` throw an opaque TypeError.
export function assertUserProvisioned(legacyUser, jwtPayload) {
  if (!legacyUser) {
    throw new Error(
      `Unable to resolve or provision user identity for Keycloak sub "${jwtPayload?.sub ?? 'unknown'}" — ` +
      'JWT is likely missing required claims (email/sub).'
    );
  }
}

async function authenticateWithKeycloak(accessToken) {
  // 1. Verify JWT signature, issuer, audience, expiration. Always run fresh,
  // never cached — this is the actual security check (catches expiry/
  // revocation), and it's a cheap in-memory JWKS verify, not a DB call.
  const jwtPayload = await verifyKeycloakToken(accessToken);

  // FRS-ARCH-002 A1: everything below this point is DB-derived and safe to
  // cache — it depends only on jwtPayload.sub/tenant_id, not on per-request
  // state. Cache hit collapses the ~7 lookups below into this one Redis GET.
  const cacheTenantKey = jwtPayload.tenant_id || 'global';
  const cached = await getCachedAuth(jwtPayload.sub, cacheTenantKey);
  if (cached) {
    return { jwtPayload, ...cached };
  }

  // 2 & 3. Legacy frs_user lookup and the new-model user lookup both key off
  // jwtPayload.sub alone — neither depends on the other's result, so resolve
  // them concurrently instead of one-after-another (FRS-ARCH-002 C1).
  const [legacyUserRow, mtUserRow] = await Promise.all([
    findUserByKeycloakSub(jwtPayload.sub),
    getUserBySSOSub("keycloak", jwtPayload.sub),
  ]);

  // Legacy frs_user lookup — kept while child tables still reference it.
  // Phase 7 cleanup will drop this dual lookup.
  let legacyUser = legacyUserRow;
  if (!legacyUser) {
    legacyUser = await provisionKeycloakUser(jwtPayload);
  } else if (legacyUser.is_active === false) {
    throw new Error("User account is deactivated");
  }
  // AB#2812: provisionKeycloakUser() returns null when the JWT is missing
  // email/sub (provisionUser.js) — without this guard, the next line
  // (String(legacyUser.pk_user_id)) throws an opaque TypeError on null,
  // which downstream callers (e.g. site creation) surface as a generic,
  // undiagnosable 500. Fail with a clear, specific error instead.
  assertUserProvisioned(legacyUser, jwtPayload);

  // New-model user lookup + provisioning into the `users` table.
  // The two tables drift apart only on the first login of a brand-new user;
  // provisionMtUser is idempotent for everyone else.
  let mtUser = mtUserRow;
  if (!mtUser) {
    mtUser = await provisionMtUser(jwtPayload);
  }

  const isSuperAdmin = isSuperAdminPayload(jwtPayload);

  // 4 & 5. Legacy memberships (keyed on legacyUser) and new-model scope
  // resolution (keyed on mtUser) read disjoint tables and don't depend on
  // each other's results, so they also run concurrently (FRS-ARCH-002 C1).
  const [rawMemberships, mtScope] = await Promise.all([
    // Legacy memberships (still used by every existing route guard until
    // Phase 4 rewrites the child-table FKs to point at the new tenants tree).
    (async () => {
      let memberships = await getRbacPermissionsForUser(legacyUser.pk_user_id);
      if (!memberships || memberships.length === 0) {
        memberships = await getMembershipsByUserId(legacyUser.pk_user_id);
      }
      return memberships;
    })(),
    // New-model: resolve scope codes + vertical + features for the JWT tenant.
    // These flow into req.auth.mt for routes that have moved to the new model.
    (async () => {
      const defaults = { mtScopeCodes: [], mtVertical: null, mtFeatures: [], mtSuperAdmin: false };
      if (!mtUser?.pk_user_id) return defaults;
      try {
        const mtSuperAdmin = await isUserSuperAdmin(mtUser.pk_user_id);
        const tenantForLookup = isSuperAdmin || mtSuperAdmin ? null : jwtPayload.tenant_id;

        const [scopeRows, tenant, mtFeatures] = await Promise.all([
          getUserScopes(mtUser.pk_user_id, tenantForLookup || null),
          jwtPayload.tenant_id ? getTenantById(jwtPayload.tenant_id) : Promise.resolve(null),
          jwtPayload.tenant_id ? featuresForTenant(jwtPayload.tenant_id) : Promise.resolve([]),
        ]);

        return {
          mtScopeCodes: scopeRows.map(r => r.scope_code),
          mtVertical: tenant?.vertical || null,
          mtFeatures,
          mtSuperAdmin,
        };
      } catch (err) {
        logger.warn({ err: err.message }, "[auth] multitenant scope resolution failed; falling back to legacy memberships");
        return defaults;
      }
    })(),
  ]);

  const { mtScopeCodes, mtVertical, mtFeatures, mtSuperAdmin } = mtScope;

  const memberships = rawMemberships.map((row) => ({
    id: String(row.pk_membership_id),
    userId: String(row.fk_user_id),
    role: row.role,
    scope: {
      tenantId: isSuperAdmin ? null : (jwtPayload.tenant_id || (row.tenant_id != null ? String(row.tenant_id) : null)),
      customerId: row.customer_id != null ? String(row.customer_id) : null,
      siteId: row.site_id != null ? String(row.site_id) : null,
      unitId: row.unit_id != null ? String(row.unit_id) : null,
    },
    permissions: row.permissions || [],
  }));

  const resolved = {
    user: {
      id: String(legacyUser.pk_user_id),
      email: legacyUser.email,
      name: legacyUser.username,
      role: legacyUser.role,
      department: legacyUser.department || undefined,
      password: "",
      createdAt: legacyUser.created_at,
    },
    memberships,
    mt: {
      userId: mtUser?.pk_user_id || null,
      homeTenantId: mtUser?.home_tenant_id || null,
      vertical: mtVertical,
      scopeCodes: mtScopeCodes,
      features: mtFeatures,
      isSuperAdmin: mtSuperAdmin,
    },
  };

  // Fire-and-forget: don't make the response wait on the cache write.
  setCachedAuth(jwtPayload.sub, cacheTenantKey, resolved).catch(() => {});

  return { jwtPayload, ...resolved };
}

/* ------------------------------------------------------------------ */
/*  requireAuth middleware — dual mode                                 */
/* ------------------------------------------------------------------ */

export async function requireAuth(req, res, next) {
  logger.debug(`[auth] verifying token for path: ${req.path} (mode: ${env.authMode})`);
  // S-01: Read from httpOnly cookie first (API mode), then Bearer header (Keycloak/device)
  const accessToken = readToken(req);
  if (!accessToken) {
    logger.debug('[auth] no token found in cookie or Authorization header');
    return res.status(401).json({ message: "authorization token is required" });
  }

  try {
    let authPayload;

    if (env.authMode === "keycloak") {
      try {
        authPayload = await authenticateWithKeycloak(accessToken);
      } catch (err) {
        logger.error({ err: err.message, stack: err.stack, path: req.path }, '[auth] authenticateWithKeycloak FAILED (this triggers the dev bypass)');
        if (env.nodeEnv === 'development') authPayload = null;
        else throw err;
      }
    } else {
      let ip = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || "unknown";
      if (ip.startsWith("::ffff:")) ip = ip.slice(7);
      const context = {
        ipAddress: ip,
        userAgent: req.headers["user-agent"] || "unknown",
      };
      try {
        authPayload = await bootstrapWithAccessToken(accessToken, context);
      } catch (err) {
        if (env.nodeEnv === 'development') authPayload = null;
        else throw err;
      }
    }

    if (!authPayload) {
      if (env.nodeEnv === 'development') {
        logger.warn('[auth] [DEV BYPASS] Invalid token — injecting synthetic payload (NODE_ENV=development)');
        let devUserId = 1;
        try {
          const { rows } = await pool.query(
            "SELECT pk_user_id FROM frs_user WHERE email = 'superadmin@company.com' OR email = 'admin@company.com' ORDER BY pk_user_id LIMIT 1"
          );
          if (rows.length > 0) {
            devUserId = Number(rows[0].pk_user_id);
          } else {
            const firstUser = await pool.query("SELECT pk_user_id FROM frs_user ORDER BY pk_user_id LIMIT 1");
            if (firstUser.rows.length > 0) {
              devUserId = Number(firstUser.rows[0].pk_user_id);
            }
          }
        } catch (dbErr) {
          logger.error('[auth] Failed to resolve dev user ID:', dbErr);
        }

        authPayload = {
          user: { id: devUserId, name: 'Dev User' },
          memberships: [],
          jwtPayload: { realm_access: { roles: ['super_admin'] } }
        };
      } else {
        logger.debug('[auth] authentication failed');
        return res.status(401).json({ message: "invalid or expired token" });
      }
    }
    logger.debug('[auth] authentication success');

    const scope = resolveRequestedScope(req, authPayload.memberships, authPayload.jwtPayload);

    // Validate customerId belongs to tenantId if both are present to prevent stale customer headers
    if (scope?.customerId && scope?.tenantId) {
      try {
        const { rows } = await pool.query(
          'SELECT 1 FROM frs_customer WHERE pk_customer_id = $1 AND fk_tenant_id = $2::uuid',
          [scope.customerId, scope.tenantId]
        );
        if (rows.length === 0) {
          logger.warn(`[auth] Mismatched x-customer-id (${scope.customerId}) for tenant ${scope.tenantId} — overriding/ignoring customer scope`);
          scope.customerId = undefined;
        }
      } catch (dbErr) {
        logger.error('[auth] Customer scope validation failed:', dbErr);
      }
    }

    // Strict Client Isolation: x-tenant-id conflicted with JWT tenant_id
    if (scope?._tenantMismatch) {
      return res.status(403).json({ message: "scope access denied: tenant mismatch with token" });
    }

    let matchingMemberships = authPayload.memberships.filter((m) => canAccessScope(m, scope));
    if (!matchingMemberships.length) {
      if (env.nodeEnv === 'development') {
        logger.warn('[auth] [DEV BYPASS] No memberships found — injecting synthetic membership (NODE_ENV=development)');
        matchingMemberships = [{
          scope: { tenantId: scope?.tenantId ?? null, customerId: null, siteId: null, unitId: null },
          permissions: ['*'],
        }];
      } else {
        logger.debug('[auth] scope access denied');
        await writeAudit({
          req: { ...req, auth: { user: authPayload.user, scope } },
          action: 'auth.scope_denied',
          details: `Access denied to requested scope: ${JSON.stringify(scope)}`,
          entityType: 'user',
          entityId: authPayload.user.id,
          entityName: authPayload.user.name,
          source: 'api'
        }).catch(() => {});
        return res.status(403).json({ message: "scope access denied" });
      }
    }

    const hasTenantLevelAccess = matchingMemberships.some((m) => m.scope.siteId === null);
    if (!scope.siteId && !hasTenantLevelAccess) {
      scope.allowedSiteIds = [...new Set(matchingMemberships.map((m) => Number(m.scope.siteId)))];
    }

    req.auth = {
      user: authPayload.user,
      memberships: matchingMemberships,
      scope,
      // Expose the verified JWT payload so downstream middleware (scopeExtractor,
      // validateScopeAccess) can read JWT claims without re-parsing the token.
      jwtPayload: authPayload.jwtPayload ?? null,
      // New multitenant model surface: scope codes, vertical, plan features.
      // Routes that have migrated to the new model read req.auth.mt; legacy
      // routes keep using req.auth.memberships unchanged.
      mt: authPayload.mt ?? null,
    };
    return next();
  } catch (err) {
    // JWKS fetch failed at startup / Keycloak unreachable — return 503 not 500
    if (err?._jwksFetchFailed) {
      logger.warn(`[auth] 503 on ${req.path} — Keycloak JWKS unreachable: ${err.message}`);
      return res.status(503).json({ message: "authentication service temporarily unavailable, retry shortly" });
    }
    const msg = (err?.message || '').toLowerCase();
    const code = err?.code || '';
    // All jose/JWT errors are auth failures — never let them become 500
    const is401 = code.startsWith('ERR_JWT') || code.startsWith('ERR_JWS')
      || code.startsWith('ERR_JWKS') || code.startsWith('ERR_JOSE_')
      || msg.includes('jwt') || msg.includes('jws') || msg.includes('token')
      || msg.includes('invalid') || msg.includes('expired') || msg.includes('signature')
      || msg.includes('malformed') || msg.includes('unsupported') || msg.includes('audience')
      || msg.includes('not allowed') || msg.includes('missing');
    if (is401) {
      logger.warn(`[auth] 401 on ${req.path} — code=${code} msg="${msg.slice(0, 120)}"`);
      return res.status(401).json({ message: "invalid or expired token" });
    }
    logger.error('[auth] CRASH in requireAuth:', err);
    return res.status(500).json({ message: "internal server error during authentication" });
  }
}

const ROLE_PERMISSIONS = {
  // Synced from rbac_role_permission table — super_admin is also bypassed via role check below
  super_admin: [
    'alerts.acknowledge', 'alerts.configure', 'alerts.read',
    'attendance.correct', 'attendance.manage', 'attendance.read', 'attendance.write',
    'devices.configure', 'devices.decommission', 'devices.provision', 'devices.read', 'devices.reboot', 'devices.write',
    'employees.bulk_assign', 'employees.bulk_import', 'employees.deactivate', 'employees.delete', 'employees.read', 'employees.write',
    'people.read',
    'reports.export', 'reports.generate',
    'sites.delete', 'sites.read', 'sites.write',
    'system.audit.read', 'system.settings.read', 'system.settings.write',
    'users.read', 'users.roles.manage', 'users.write',
    'visitors.convert', 'visitors.write'
  ],
  tenant_admin: [
    'alerts.acknowledge', 'alerts.configure', 'alerts.read',
    'attendance.correct', 'attendance.correct_request', 'attendance.manage', 'attendance.read', 'attendance.write',
    'breaks.configure',
    'devices.configure', 'devices.decommission', 'devices.provision', 'devices.read', 'devices.reboot', 'devices.write',
    'employees.bulk_assign', 'employees.bulk_import', 'employees.deactivate', 'employees.delete', 'employees.read', 'employees.write',
    'overtime.configure',
    'people.read',
    'reports.export', 'reports.generate',
    'shifts.assign', 'shifts.read', 'shifts.write',
    'sites.delete', 'sites.read', 'sites.write',
    'system.audit.read', 'system.settings.read',
    'users.read', 'users.roles.manage', 'users.write',
    'visitors.convert', 'visitors.write'
  ],
  site_admin: [
    'alerts.acknowledge', 'alerts.read',
    'attendance.correct_request', 'attendance.read', 'attendance.write',
    'devices.configure', 'devices.read', 'devices.reboot', 'devices.write',
    'employees.bulk_assign', 'employees.bulk_import', 'employees.deactivate', 'employees.read', 'employees.write',
    'people.read',
    'reports.export', 'reports.generate',
    'shifts.assign', 'shifts.read', 'shifts.write',
    'sites.read',
    'users.read', 'users.roles.manage', 'users.write',
    'visitors.convert', 'visitors.write'
  ],
  hr_manager: [
    'attendance.correct_request', 'attendance.read', 'attendance.write',
    'breaks.configure',
    'employees.bulk_assign', 'employees.bulk_import', 'employees.deactivate', 'employees.read', 'employees.write',
    'overtime.configure',
    'people.read',
    'reports.export', 'reports.generate',
    'shifts.assign', 'shifts.read', 'shifts.write',
    'users.read', 'users.roles.manage',
    'visitors.convert', 'visitors.write',
    // Zone Analytics (specs/0003-zone-analytics) — HR-only module, deliberately
    // NOT added to any other role here (see 029_seed_zones_read_permission.sql).
    'zones.read'
  ],
  device_operator: [
    'devices.read'
  ],
  viewer: [
    'attendance.read',
    'devices.read',
    'employees.read',
    'reports.export', 'reports.generate',
    'sites.read',
    'users.read'
  ]
};

export function requirePermission(permission) {
  return (req, res, next) => {
    // ── DEV BYPASS ─────────────────────────────────────────────────────────────
    // In development mode, skip all permission checks to allow sandbox testing
    // without requiring Keycloak role protocol mappers to be fully configured.
    // Remove this block (or set NODE_ENV=production) before deploying to prod.
    if (env.nodeEnv === 'development') {
      logger.warn(`[auth] [DEV BYPASS] Skipping permission check: ${permission} (NODE_ENV=development)`);
      return next();
    }
    // ───────────────────────────────────────────────────────────────────────────

    // Keycloak Mode: check JWT payload claims for roles
    if (env.authMode === "keycloak" && req.auth?.jwtPayload) {
      const roles = req.auth.jwtPayload.realm_access?.roles || [];
      const hasPermission = roles.some(role => ROLE_PERMISSIONS[role]?.includes(permission));
      if (hasPermission || roles.includes('super_admin')) {
        return next();
      }
      return res.status(403).json({ message: `permission denied: ${permission}` });
    }

    const memberships = req.auth?.memberships || [];
    const allowed = memberships.some((membership) => membership.permissions.includes(permission));
    if (!allowed) {
      return res.status(403).json({ message: `permission denied: ${permission}` });
    }
    return next();
  };
}

/**
 * Guard a route with one of the new menu-anchored scope codes.
 * Example: router.get('/students', requireAuth, requireScope('students.list.read'), handler)
 *
 * Reads from req.auth.mt.scopeCodes — populated for every Keycloak request.
 * Super admins (any role with is_super_role=true) bypass the check.
 */
export function requireScope(scopeCode) {
  return (req, res, next) => {
    const mt = req.auth?.mt;
    if (!mt) {
      return res.status(401).json({ message: 'authentication required' });
    }
    if (mt.isSuperAdmin) return next();
    if (Array.isArray(mt.scopeCodes) && mt.scopeCodes.includes(scopeCode)) {
      return next();
    }
    logger.debug(`[auth] scope denied: required=${scopeCode} user=${req.auth?.user?.id}`);
    return res.status(403).json({ message: `scope denied: ${scopeCode}` });
  };
}

/**
 * Guard a route by feature key (resolved via subscription_plans.features
 * ∪ tenant_settings.custom_features − disabled). Use for plan-gated routes.
 */
export function requireFeature(featureKey) {
  return (req, res, next) => {
    const mt = req.auth?.mt;
    if (!mt) {
      return res.status(401).json({ message: 'authentication required' });
    }
    if (mt.isSuperAdmin) return next();
    if (Array.isArray(mt.features) && mt.features.includes(featureKey)) {
      return next();
    }
    return res.status(402).json({
      message: `feature not enabled for this tenant: ${featureKey}`,
      error: 'FEATURE_NOT_AVAILABLE',
    });
  };
}

