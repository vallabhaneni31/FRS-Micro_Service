import { pool, frsPool } from '../db/pool.js';
import { verifyKeycloakToken } from '../services/keycloakVerifier.js';

const FRS_ROLE_MAP = {
  admin:        'OWNER',
  tenant_admin: 'OWNER',
  hr_manager:   'MANAGER',
  hr:           'STAFF',
  site_admin:   'MANAGER',
  viewer:       'STAFF',
};

/**
 * Auth lookup order (all against a SIGNATURE-VERIFIED payload — never trust
 * claims from a token whose signature hasn't been checked against its own
 * realm's real Keycloak signing keys):
 *
 *   0. Resolve the tenant from the JWT's `iss` claim (the Keycloak realm that
 *      actually issued/signed this token). For tenants with a dedicated
 *      realm, this is the ONLY trustworthy source of tenant identity — an
 *      email or user id can exist under multiple tenants (e.g. a Motivity
 *      staffer test-registered as a manager on two different demo tenants),
 *      and matching by email/user-id ALONE — without also checking that the
 *      match belongs to the tenant the person actually logged into — was a
 *      real cross-tenant data leak: logging into Tenant A's realm could
 *      resolve identity via an email match against Tenant B's retail_users
 *      row and silently serve Tenant B's stores/dashboards instead.
 *   1. retail_users table, scoped to that resolved tenant (or unscoped by
 *      email as a last resort for the shared corporate realm — see below)
 *   2. FRS main DB — frs_user + membership, scoped to that resolved tenant
 *      (same unscoped fallback for the shared corporate realm)
 *   3. Realm-role derivation — no retail_users/membership row at all, just
 *      Keycloak realm_access roles, for a tenant-specific realm
 */
export async function authenticateUser(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_token' });
  }
  const token = auth.slice(7);

  let decoded;
  try {
    ({ payload: decoded } = await verifyKeycloakToken(token));
  } catch (err) {
    console.error('[auth] token verification failed', err.message);
    return res.status(401).json({ error: 'invalid_token', detail: err.message });
  }

  const email = decoded.email || decoded.preferred_username || '';
  const sub   = decoded.sub || '';

  // ── 0. Resolve the authoritative tenant from the token's issuing realm ───
  const iss = decoded.iss || '';
  const realmMatch = iss.match(/\/realms\/([^/]+)$/);
  if (!realmMatch) {
    return res.status(403).json({ error: 'user_not_found', detail: 'Cannot identify realm from token' });
  }
  const realmSlug = realmMatch[1];
  const isSharedCorporateRealm = realmSlug === 'attendance' || realmSlug === 'master';

  let scopedTenantId = null;
  if (!isSharedCorporateRealm) {
    const tenantRes = await frsPool.query(
      `SELECT t.pk_tenant_id, t.vertical
       FROM tenant_realm r
       JOIN frs_tenant t ON t.pk_tenant_id = r.fk_tenant_id
       WHERE r.realm_slug = $1
       LIMIT 1`,
      [realmSlug]
    );
    if (!tenantRes.rows.length) {
      return res.status(403).json({ error: 'unknown_realm', detail: `Realm '${realmSlug}' is not registered to any tenant` });
    }
    if (tenantRes.rows[0].vertical !== 'retail') {
      return res.status(403).json({ error: 'not_retail_tenant', detail: `Realm '${realmSlug}' is not a retail tenant` });
    }
    scopedTenantId = tenantRes.rows[0].pk_tenant_id;
  }

  // ── 1. retail_users table (standalone accounts) ──────────────────────────
  try {
    const { rows } = scopedTenantId
      ? await pool.query(
          `SELECT id, email, display_name, role, store_id, tenant_id, status
           FROM retail_users WHERE email = $1 AND tenant_id = $2 LIMIT 1`,
          [email, scopedTenantId]
        )
      : await pool.query(
          `SELECT id, email, display_name, role, store_id, tenant_id, status
           FROM retail_users WHERE email = $1 LIMIT 1`,
          [email]
        );
    if (rows.length) {
      const u = rows[0];
      if (u.status === 'inactive') return res.status(403).json({ error: 'account_inactive' });
      req.user = { id: u.id, email: u.email, display_name: u.display_name,
                   role: u.role, store_id: u.store_id, tenant_id: u.tenant_id, sub };
      return next();
    }
  } catch (err) {
    console.error('[auth] retail_users lookup failed', err.message);
  }

  // ── 2. FRS main DB — frs_user + membership ───────────────────────────────
  try {
    const userRes = await frsPool.query(
      `SELECT pk_user_id, email, username FROM frs_user
       WHERE email = $1 OR keycloak_sub = $2 LIMIT 1`,
      [email, sub]
    );
    if (userRes.rows.length) {
      const frsUser = userRes.rows[0];
      const { rows: memberRows } = scopedTenantId
        ? await frsPool.query(
            `SELECT m.role, m.tenant_id
             FROM frs_user_membership m
             JOIN frs_tenant t ON t.pk_tenant_id = m.tenant_id
             WHERE m.fk_user_id = $1 AND m.tenant_id = $2 AND t.vertical = 'retail'
             LIMIT 1`,
            [frsUser.pk_user_id, scopedTenantId]
          )
        : await frsPool.query(
            `SELECT m.role, m.tenant_id
             FROM frs_user_membership m
             JOIN frs_tenant t ON t.pk_tenant_id = m.tenant_id
             WHERE m.fk_user_id = $1 AND t.vertical = 'retail'
             LIMIT 1`,
            [frsUser.pk_user_id]
          );
      if (memberRows.length) {
        const { role: frsRole, tenant_id } = memberRows[0];
        const storeRes = await pool.query(`SELECT id FROM stores WHERE tenant_id = $1 LIMIT 1`, [tenant_id]);
        req.user = {
          id: frsUser.pk_user_id, email: frsUser.email, display_name: frsUser.username,
          role: FRS_ROLE_MAP[frsRole] || 'STAFF',
          store_id: storeRes.rows[0]?.id || null,
          tenant_id, sub,
        };
        return next();
      }
    }
  } catch (err) {
    console.error('[auth] FRS DB fallback failed', err.message);
  }

  // ── 3. Realm-role derivation (tenant-specific realm, no DB row at all) ───
  if (scopedTenantId) {
    const realmRoles = decoded.realm_access?.roles || [];
    let retailRole = 'STAFF';
    if (realmRoles.includes('tenant_admin') || realmRoles.includes('admin')) retailRole = 'OWNER';
    else if (realmRoles.includes('hr_manager') || realmRoles.includes('site_admin')) retailRole = 'MANAGER';

    const storeRes = await pool.query(`SELECT id FROM stores WHERE tenant_id = $1 LIMIT 1`, [scopedTenantId]);

    req.user = {
      id: sub, email, display_name: decoded.name || email,
      role: retailRole,
      store_id: storeRes.rows[0]?.id || null,
      tenant_id: scopedTenantId, sub,
    };
    return next();
  }

  return res.status(403).json({ error: 'user_not_found', detail: 'User not registered in retail system' });
}

export function requireOwner(req, res, next) {
  if (req.user?.role !== 'OWNER') {
    return res.status(403).json({ error: 'owner_required' });
  }
  return next();
}

// OWNER sees every store in the tenant; MANAGER (and STAFF) are confined to
// their own assigned store_id — every store-scoped read route must check
// this, not just tenant_id, or a manager can pull another branch's full data
// by guessing/enumerating store ids within the same tenant.
export function canAccessStore(req, storeId) {
  if (req.user.role === 'OWNER') return true;
  return req.user.store_id === storeId;
}
