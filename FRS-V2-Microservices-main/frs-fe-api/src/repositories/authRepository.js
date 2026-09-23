import { query } from "../db/pool.js";

export async function findUserByEmail(email) {
  const result = await query(
    `select
      pk_user_id,
      email,
      username,
      role,
      department,
      created_at,
      password_hash,
      failed_login_attempts,
      locked_until,
      is_active
     from frs_user
     where email = $1
     limit 1`,
    [email]
  );
  return result.rows[0] ?? null;
}

export async function findUserByKeycloakSub(keycloakSub) {
  const result = await query(
    `select
      pk_user_id,
      email,
      username,
      role,
      department,
      is_active,
      created_at
     from frs_user
     where keycloak_sub = $1
     limit 1`,
    [keycloakSub],
    "find_user_by_keycloak_sub"
  );
  return result.rows[0] ?? null;
}

export async function findUserByAccessToken(accessToken) {
  const result = await query(
    `select
      t.user_agent,
      t.ip_address,
      u.pk_user_id,
      u.email,
      u.username,
      u.role,
      u.department,
      u.created_at
     from auth_session_token t
     join frs_user u on u.pk_user_id = t.fk_user_id
     where t.access_token = $1
       and t.revoked = false
       and t.access_expires_at > now()
       and u.is_active = true
     limit 1`,
    [accessToken]
  );
  return result.rows[0] ?? null;
}

export async function findSessionByRefreshToken(refreshToken) {
  const result = await query(
    `select t.token_id, t.fk_user_id, t.refresh_expires_at, t.revoked, t.user_agent, t.ip_address
     from auth_session_token t
     join frs_user u on u.pk_user_id = t.fk_user_id
     where refresh_token = $1
       and u.is_active = true
     limit 1`,
    [refreshToken]
  );
  return result.rows[0] ?? null;
}

export async function revokeSessionByRefreshToken(refreshToken) {
  await query(
    `update auth_session_token
     set revoked = true
     where refresh_token = $1`,
    [refreshToken]
  );
}

export async function saveSessionToken({
  userId,
  accessToken,
  refreshToken,
  accessExpiresAt,
  refreshExpiresAt,
  userAgent,
  ipAddress,
}) {
  const result = await query(
    `insert into auth_session_token(
      fk_user_id,
      access_token,
      refresh_token,
      access_expires_at,
      refresh_expires_at,
      user_agent,
      ip_address,
      revoked
    ) values ($1, $2, $3, $4, $5, $6, $7, false)
    returning token_id`,
    [userId, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt, userAgent, ipAddress]
  );
  return result.rows[0];
}

export async function rotateSessionToken({
  refreshToken,
  newAccessToken,
  newRefreshToken,
  accessExpiresAt,
  refreshExpiresAt,
  userAgent,
  ipAddress,
}) {
  const result = await query(
    `update auth_session_token
     set access_token = $2,
         refresh_token = $3,
         access_expires_at = $4,
         refresh_expires_at = $5,
         user_agent = $6,
         ip_address = $7,
         revoked = false
     where refresh_token = $1
     returning token_id`,
    [refreshToken, newAccessToken, newRefreshToken, accessExpiresAt, refreshExpiresAt, userAgent, ipAddress]
  );
  return result.rows[0] ?? null;
}

export async function getMembershipsByUserId(userId) {
  const result = await query(
    `select
      pk_membership_id,
      fk_user_id,
      role,
      tenant_id,
      customer_id,
      site_id,
      unit_id,
      permissions
     from frs_user_membership
     where fk_user_id = $1
     order by pk_membership_id`,
    [userId],
    "get_memberships_by_user_id"
  );
  return result.rows;
}

/**
 * getRbacPermissionsForUser — RBAC system (Phase 2)
 *
 * Resolves a user's effective permissions from the normalised RBAC tables:
 *   user_role → rbac_role → rbac_role_permission → rbac_permission
 *
 * Returns one row per active role assignment.  A user can have multiple rows
 * (e.g. a global HR Manager AND a Site-Admin assignment for one specific site).
 *
 * Return shape is intentionally identical to getMembershipsByUserId() so that
 * normalizeMembership() in authService.js and the inline normalization in
 * authz.js both work without modification.
 *
 * Extra field  scope_type  ('global' | 'site' | 'flexible') is passed through
 * for use by the updated authz.js middleware in Step 2 of the RBAC integration.
 *
 * Tenant resolution:
 *   - Site-scoped role  →  tenant derived via frs_site → frs_customer
 *   - Global role       →  first tenant in frs_tenant (single-tenant system)
 *
 * Returns [] when the user has no active RBAC role assignments (caller falls
 * back to getMembershipsByUserId for backward-compat during migration).
 */
export async function getRbacPermissionsForUser(userId) {
  const result = await query(
    `SELECT
       ur.pk_user_role_id                                          AS pk_membership_id,
       ur.fk_user_id,
       r.role_name                                                 AS role,
       r.scope_type,
       array_agg(p.permission_code ORDER BY p.permission_code)     AS permissions,
       ur.fk_site_id                                               AS site_id,
       NULL                                                        AS unit_id,
       -- super_admin is cross-tenant: null scope. Other global roles fall back to user's assigned tenant.
       CASE WHEN r.role_name = 'super_admin' THEN NULL
            ELSE COALESCE(
              c.fk_tenant_id,
              (SELECT fk_tenant_id FROM frs_tenant_user_map WHERE fk_user_id = ur.fk_user_id LIMIT 1)
            )
       END                                                         AS tenant_id,
       CASE WHEN r.role_name = 'super_admin' THEN NULL
            ELSE COALESCE(
              s.fk_customer_id,
              (SELECT pk_customer_id FROM frs_customer
               WHERE fk_tenant_id = COALESCE(
                 c.fk_tenant_id,
                 (SELECT fk_tenant_id FROM frs_tenant_user_map WHERE fk_user_id = ur.fk_user_id LIMIT 1)
               )
               ORDER BY pk_customer_id LIMIT 1)
            )
       END                                                         AS customer_id
     FROM   user_role           ur
     JOIN   rbac_role            r  ON  r.pk_role_id        = ur.fk_role_id
     JOIN   rbac_role_permission rp ON  rp.fk_role_id       = r.pk_role_id
     JOIN   rbac_permission      p  ON  p.pk_permission_id  = rp.fk_permission_id
     LEFT JOIN frs_site     s  ON  s.pk_site_id      = ur.fk_site_id
     LEFT JOIN frs_customer c  ON  c.pk_customer_id  = s.fk_customer_id
     WHERE  ur.fk_user_id = $1
       AND  ur.is_active   = TRUE
       AND  (ur.expires_at IS NULL OR ur.expires_at > NOW())
     GROUP  BY
       ur.pk_user_role_id,
       ur.fk_user_id,
       r.role_name,
       r.scope_type,
       ur.fk_site_id,
       s.fk_customer_id,
       c.fk_tenant_id
     ORDER  BY ur.pk_user_role_id`,
    [userId],
    "get_rbac_permissions_for_user"
  );

  return result.rows;
}

export async function getCatalogForTenantIds(tenantIds) {
  const ids = tenantIds.filter(Boolean);
  if (!ids.length) {
    return { tenants: [], customers: [], sites: [], units: [] };
  }
  tenantIds = ids;

  const tenants = await query(
    `select pk_tenant_id, tenant_name
     from frs_tenant
     where pk_tenant_id = any($1::uuid[])`,
    [tenantIds]
  );

  const customers = await query(
    `select pk_customer_id, customer_name, fk_tenant_id
     from frs_customer
     where fk_tenant_id = any($1::uuid[])`,
    [tenantIds]
  );

  const customerIds = customers.rows.map((row) => row.pk_customer_id);
  const sites = customerIds.length
    ? await query(
      `select pk_site_id, site_name, fk_customer_id, status
         from frs_site
         where fk_customer_id = any($1::bigint[])`,
      [customerIds]
    )
    : { rows: [] };

  const siteIds = sites.rows.map((row) => row.pk_site_id);
  const units = siteIds.length
    ? await query(
      `select pk_unit_id, unit_name, fk_site_id
         from frs_unit
         where fk_site_id = any($1::bigint[])`,
      [siteIds]
    )
    : { rows: [] };

  return {
    tenants: tenants.rows,
    customers: customers.rows,
    sites: sites.rows,
    units: units.rows,
  };
}

export async function getUserMaxFailedLogins(userId) {
  const result = await query(
    `SELECT COALESCE(tr.max_failed_logins, 5) AS max_failed_logins
     FROM frs_tenant_user_map tum
     JOIN tenant_realm tr ON tr.fk_tenant_id = tum.fk_tenant_id
     WHERE tum.fk_user_id = $1
     LIMIT 1`,
    [userId]
  );
  return result.rows[0]?.max_failed_logins ?? 5;
}

export async function incrementFailedLoginAttempts(userId) {
  await query(
    `UPDATE frs_user
     SET failed_login_attempts = failed_login_attempts + 1
     WHERE pk_user_id = $1`,
    [userId]
  );
}

export async function lockUserAccount(userId, lockedUntil) {
  await query(
    `UPDATE frs_user
     SET locked_until = $2
     WHERE pk_user_id = $1`,
    [userId, lockedUntil]
  );
}

export async function resetFailedLoginAttempts(userId) {
  await query(
    `UPDATE frs_user
     SET failed_login_attempts = 0,
         locked_until = NULL
     WHERE pk_user_id = $1`,
    [userId]
  );
}

