import { isSuperAdminPayload } from './authz.js';
import { env } from '../config/env.js';
import logger from '../utils/logger.js';

/**
 * Scope Extractor Middleware
 *
 * In Keycloak mode the tenant identity is always JWT-authoritative (set by
 * requireAuth → resolveRequestedScope).  extractScope here only captures the
 * sub-tenant headers (customer/site/unit) that narrow scope *within* an already
 * established tenant — it no longer sets tenantId from headers.
 *
 * In legacy API mode the full behaviour is unchanged.
 *
 * Headers honoured:
 *   x-tenant-id   — API-mode only; ignored (but validated) in Keycloak mode
 *   x-customer-id — always honoured
 *   x-site-id     — always honoured
 *   x-unit-id     — always honoured
 */
export function extractScope(req, res, next) {
  const rawTenantId  = req.headers['x-tenant-id'];
  const customerId   = req.headers['x-customer-id'];
  const siteId       = req.headers['x-site-id'];
  const unitId       = req.headers['x-unit-id'];

  const hasSub = customerId || siteId || unitId;

  if (rawTenantId || hasSub) {
    req.scope = {
      // tenantId is intentionally left undefined here in Keycloak mode;
      // requireAuth (which runs after this) will set it from the JWT claim.
      // In API mode it is set from the header as before.
      tenantId: rawTenantId ? String(rawTenantId) : undefined,
      customerId: customerId ? String(customerId) : undefined,
      siteId: siteId ? String(siteId) : undefined,
      unitId: unitId ? String(unitId) : undefined,
    };

    // Validate scope hierarchy (if child is provided, parent must be provided)
    if (req.scope.unitId && !req.scope.siteId) {
      return res.status(400).json({
        message: 'Cannot specify unit without site',
        error: 'INVALID_SCOPE_HIERARCHY',
      });
    }
    if (req.scope.siteId && !req.scope.customerId) {
      return res.status(400).json({
        message: 'Cannot specify site without customer',
        error: 'INVALID_SCOPE_HIERARCHY',
      });
    }
  } else {
    req.scope = null;
  }

  next();
}

/**
 * Validates that the user has access to the requested scope.
 * Must run AFTER requireAuth so req.auth (including req.auth.jwtPayload) is set.
 *
 * In Keycloak mode:
 *   - req.auth.scope.tenantId is already locked to the JWT claim by requireAuth.
 *   - This function re-locks req.scope.tenantId defensively and validates sub-scopes.
 */
export function validateScopeAccess(req, res, next) {
  // ── DEV BYPASS ─────────────────────────────────────────────────────────────
  // In development mode, skip all scope validation to allow sandbox testing
  // without requiring DB membership rows to be synced from Keycloak.
  if (env.nodeEnv === 'development') {
    logger.warn('[scope] [DEV BYPASS] Skipping scope validation (NODE_ENV=development)');
    return next();
  }
  // ───────────────────────────────────────────────────────────────────────────

  if (!req.auth?.memberships) {
    return res.status(401).json({ message: 'authentication required' });
  }

  // ── Keycloak mode: defensively re-lock tenantId from JWT ─────────────────
  // requireAuth already did this via resolveRequestedScope, but we guard here
  // in case validateScopeAccess is used on a route that bypasses requireAuth's
  // scope resolution (e.g. device routes that call requireAuth without scope).
  const jwtPayload = req.auth.jwtPayload;
  if (jwtPayload) {
    const superAdmin = isSuperAdminPayload(jwtPayload);
    if (superAdmin) {
      // Super admin: skip all scope checks — global access
      return next();
    }
    if (jwtPayload.tenant_id) {
      if (!req.scope) req.scope = {};
      // Overwrite whatever was in req.scope.tenantId — JWT is the source of truth
      req.scope.tenantId = jwtPayload.tenant_id;
    }
  }

  // No scope at all — use the scope already resolved by requireAuth
  if (!req.scope) {
    return next();
  }

  const requestedScope = req.scope;
  const memberships = req.auth.memberships;

  const hasAccess = memberships.some((membership) => {
    // null tenantId = global role (super_admin) — can access any scope
    if (membership.scope.tenantId === null) return true;

    // Must match tenant
    if (membership.scope.tenantId !== requestedScope.tenantId) return false;

    // Tenant-level membership with no customer restriction → full tenant access
    if (!membership.scope.customerId) return true;

    // Customer scoped
    if (requestedScope.customerId) {
      if (membership.scope.customerId !== requestedScope.customerId) return false;
      // Customer matches
      if (!membership.scope.siteId) return true; // full customer access
      if (requestedScope.siteId) {
        if (membership.scope.siteId !== requestedScope.siteId) return false;
        if (requestedScope.unitId) {
          return membership.scope.unitId === requestedScope.unitId;
        }
        return true;
      }
      return true; // customer matches, no site requested
    }

    return true;
  });

  if (!hasAccess) {
    logger.warn(
      '[scope] access denied userId=%s requestedScope=%s',
      req.auth?.user?.id,
      JSON.stringify(requestedScope),
    );
    return res.status(403).json({
      message: 'Access denied',
      error: 'SCOPE_ACCESS_DENIED',
    });
  }

  next();
}

/**
 * Middleware to ensure scope is properly resolved
 * Combines extractScope and validateScopeAccess in the correct order
 * Usage: router.use(ensureScope);
 */
export function ensureScope(req, res, next) {
  // This is a placeholder - actual implementation requires running
  // extractScope before auth and validateScopeAccess after auth
  // See server.js for proper middleware ordering
  next();
}
