import { pool } from '../db/pool.js';

// ============================================================================
// LIST
// ============================================================================

export async function listUsersSuperAdmin() {
  const result = await pool.query(
    `SELECT u.pk_user_id, u.email, u.username, u.role, u.department,
            u.created_at, u.is_active, u.keycloak_sub,
            MAX(s.created_at) AS last_login,
            MAX(t.tenant_name) AS tenant_name,
            NULL::integer AS site_id,
            NULL::varchar AS site_name
     FROM frs_user u
     LEFT JOIN auth_session_token s ON s.fk_user_id = u.pk_user_id
     LEFT JOIN frs_tenant_user_map m ON m.fk_user_id = u.pk_user_id
     LEFT JOIN frs_tenant t ON t.pk_tenant_id = m.fk_tenant_id
     WHERE u.role IN ('admin', 'tenant_admin', 'super_admin')
     GROUP BY u.pk_user_id
     ORDER BY u.created_at DESC`
  );
  return result.rows;
}

export async function listUsersSiteScoped(tenantId, siteId) {
  const result = await pool.query(
    `SELECT u.pk_user_id, u.email, u.username, u.role, u.department,
            u.created_at, u.is_active, u.keycloak_sub,
            MAX(s.created_at) AS last_login,
            MAX(ur.fk_site_id) AS site_id,
            array_agg(DISTINCT ur.fk_site_id) FILTER (WHERE ur.fk_site_id IS NOT NULL) AS site_ids,
            string_agg(DISTINCT fs.site_name, ', ') FILTER (WHERE fs.site_name IS NOT NULL) AS site_name
     FROM frs_user u
     JOIN frs_tenant_user_map m  ON m.fk_user_id  = u.pk_user_id
     JOIN user_role             ur ON ur.fk_user_id = u.pk_user_id
                                   AND ur.fk_site_id = $2
                                   AND ur.is_active  = true
     LEFT JOIN frs_site         fs ON fs.pk_site_id = ur.fk_site_id
     LEFT JOIN auth_session_token s ON s.fk_user_id = u.pk_user_id
     WHERE m.fk_tenant_id = $1::uuid
     GROUP BY u.pk_user_id
     ORDER BY u.created_at DESC`,
    [tenantId, siteId]
  );
  return result.rows;
}

export async function listUsersTenantScoped(tenantId) {
  const result = await pool.query(
    `SELECT u.pk_user_id, u.email, u.username, u.role, u.department,
            u.created_at, u.is_active, u.keycloak_sub,
            MAX(s.created_at) AS last_login,
            MAX(ur.fk_site_id) AS site_id,
            array_agg(DISTINCT ur.fk_site_id) FILTER (WHERE ur.fk_site_id IS NOT NULL) AS site_ids,
            string_agg(DISTINCT fs.site_name, ', ') FILTER (WHERE fs.site_name IS NOT NULL) AS site_name
     FROM frs_user u
     JOIN frs_tenant_user_map m ON m.fk_user_id = u.pk_user_id
     LEFT JOIN user_role ur ON ur.fk_user_id = u.pk_user_id AND ur.is_active = true
     LEFT JOIN frs_site fs ON fs.pk_site_id = ur.fk_site_id
     LEFT JOIN auth_session_token s ON s.fk_user_id = u.pk_user_id
     WHERE m.fk_tenant_id = $1::uuid
     GROUP BY u.pk_user_id
     ORDER BY u.created_at DESC`,
    [tenantId]
  );
  return result.rows;
}

// ============================================================================
// TENANT ISOLATION
// ============================================================================

export async function isUserInTenant(userId, tenantId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM frs_tenant_user_map WHERE fk_user_id=$1 AND fk_tenant_id=$2::uuid',
    [userId, tenantId]
  );
  return rows.length > 0;
}

// ============================================================================
// CREATE
// ============================================================================

export async function findUserByEmail(client, email) {
  const result = await client.query('SELECT 1 FROM frs_user WHERE email = $1', [email]);
  return result.rows.length > 0;
}

export async function findUserByUsername(client, tenantId, username, excludeUserId = null) {
  let query = `SELECT u.pk_user_id FROM frs_tenant_user_map tum
               JOIN frs_user u ON u.pk_user_id = tum.fk_user_id
               WHERE tum.fk_tenant_id = $1 AND LOWER(TRIM(u.username)) = LOWER($2)`;
  const params = [tenantId, username.trim()];
  if (excludeUserId) {
    query += ` AND u.pk_user_id != $3`;
    params.push(excludeUserId);
  }
  const result = await client.query(query, params);
  return result.rows.length > 0;
}

export async function insertUser(client, { email, username, role, hash, department, useInviteFlow }) {
  const result = await client.query(
    `INSERT INTO frs_user (email, username, fk_user_type_id, role, password_hash, department, must_set_password)
     VALUES ($1, $2, 1, $3, $4, $5, $6)
     RETURNING pk_user_id, email, username, role, department, created_at`,
    [email, username, role, hash, department || null, useInviteFlow]
  );
  return result.rows[0];
}

export async function findCustomerForTenant(client, tenantId) {
  const result = tenantId
    ? await client.query('SELECT pk_customer_id FROM frs_customer WHERE fk_tenant_id=$1::uuid LIMIT 1', [tenantId])
    : await client.query('SELECT pk_customer_id FROM frs_customer LIMIT 1');
  return result.rows[0]?.pk_customer_id || null;
}

export async function findSiteForTenant(client, tenantId) {
  const result = tenantId
    ? await client.query(`SELECT s.pk_site_id FROM frs_site s JOIN frs_customer c ON c.pk_customer_id=s.fk_customer_id WHERE c.fk_tenant_id=$1::uuid LIMIT 1`, [tenantId])
    : await client.query('SELECT pk_site_id FROM frs_site LIMIT 1');
  return result.rows[0]?.pk_site_id || null;
}

export async function insertUserMembership(client, { userId, membershipRole, tenantId, customerId, siteId, permissions }) {
  await client.query(
    `INSERT INTO frs_user_membership
       (fk_user_id, role, tenant_id, customer_id, site_id, permissions)
     VALUES ($1, $2, $3, $4, $5, $6::text[])
     ON CONFLICT DO NOTHING`,
    [userId, membershipRole, tenantId, customerId, siteId, permissions]
  );
}

export async function mapUserToTenant(client, userId, tenantId) {
  await client.query(
    `INSERT INTO frs_tenant_user_map (fk_user_id, fk_tenant_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, tenantId]
  );
}

export async function findRbacRoleByName(client, roleName) {
  const result = await client.query('SELECT pk_role_id FROM rbac_role WHERE role_name = $1', [roleName]);
  return result.rows[0] ?? null;
}

export async function insertUserRoleIfMissing(clientOrPool, { userId, roleId, siteId }) {
  await clientOrPool.query(
    `INSERT INTO user_role (fk_user_id, fk_role_id, fk_role_id_uuid, fk_site_id, is_active)
     SELECT $1, $2, pk_role_id_uuid, $3, true FROM rbac_role WHERE pk_role_id = $2
     ON CONFLICT DO NOTHING`,
    [userId, roleId, siteId]
  );
}

export async function getSiteKeycloakSyncDetails(siteId) {
  const result = await pool.query(
    `SELECT s.keycloak_org_id, tr.realm_slug
     FROM frs_site s
     JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
     JOIN tenant_realm tr ON tr.fk_tenant_id = c.fk_tenant_id
     WHERE s.pk_site_id = $1`,
    [siteId]
  );
  return result.rows[0] ?? {};
}

// Transport-only fallback for Keycloak realm resolution (see
// syncNewUserToKeycloak) — Transport tenants have no frs_site rows at all,
// so the site-based lookup above can never find a realm for them. Reads
// the tenant's own vertical + registered realm directly instead.
export async function getTenantVerticalAndRealm(tenantId) {
  const result = await pool.query(
    `SELECT t.vertical, tr.realm_slug
     FROM frs_tenant t
     LEFT JOIN tenant_realm tr ON tr.fk_tenant_id = t.pk_tenant_id
     WHERE t.pk_tenant_id = $1`,
    [tenantId]
  );
  return result.rows[0] ?? {};
}

export async function updateUserKeycloakSub(userId, kcUserId) {
  await pool.query('UPDATE frs_user SET keycloak_sub = $1 WHERE pk_user_id = $2', [kcUserId, userId]);
}

export async function getTenantNameForUser(userId) {
  const result = await pool.query(
    'SELECT t.tenant_name FROM frs_tenant t JOIN frs_tenant_user_map m ON m.fk_tenant_id = t.pk_tenant_id WHERE m.fk_user_id = $1 LIMIT 1',
    [userId]
  );
  return result.rows[0]?.tenant_name ?? null;
}

export async function findUserById(id) {
  const result = await pool.query(
    `SELECT u.pk_user_id, u.email, u.username, u.role, u.department, t.tenant_name
     FROM frs_user u
     LEFT JOIN frs_tenant_user_map m ON m.fk_user_id = u.pk_user_id
     LEFT JOIN frs_tenant t ON t.pk_tenant_id = m.fk_tenant_id
     WHERE u.pk_user_id = $1 LIMIT 1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function insertInvite({ userId, hashedToken, invitedById, invitedByName, roleLabel, tenantName }) {
  const ttlHours = Number(process.env.INVITE_TOKEN_TTL_HOURS ?? 72);
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
  await pool.query(
    `INSERT INTO user_invite
       (fk_user_id, invite_token, invited_by_id, invited_by_name, role_label, tenant_name, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, hashedToken, invitedById, invitedByName, roleLabel, tenantName, expiresAt]
  );
  return expiresAt;
}

// ============================================================================
// UPDATE
// ============================================================================

export async function updateUserFields({ username, department, role, id }) {
  const result = await pool.query(
    `UPDATE frs_user
     SET username   = COALESCE($1, username),
         department = COALESCE($2, department),
         role       = COALESCE($3, role)
     WHERE pk_user_id = $4
     RETURNING pk_user_id, email, username, role, department, keycloak_sub`,
    [username || null, department || null, role || null, id]
  );
  return result.rows[0] ?? null;
}

export async function findInactiveSites(siteIds) {
  const result = await pool.query(
    `SELECT pk_site_id, site_name FROM frs_site WHERE pk_site_id = ANY($1::bigint[]) AND status = 'inactive'`,
    [siteIds]
  );
  return result.rows;
}

export async function updateMembershipSiteId(id, siteId) {
  await pool.query(`UPDATE frs_user_membership SET site_id = $1 WHERE fk_user_id = $2`, [siteId, id]);
}

export async function updateUserMembershipRole(id, tenantId, membershipRole, permissions) {
  await pool.query(
    `UPDATE frs_user_membership 
     SET role = $1, permissions = $2 
     WHERE fk_user_id = $3 AND tenant_id = $4`,
    [membershipRole, permissions, id, tenantId]
  );
}

export async function findRbacRoleWithScope(roleName) {
  const result = await pool.query(
    'SELECT pk_role_id, scope_type FROM rbac_role WHERE role_name = $1', [roleName]
  );
  return result.rows[0] ?? null;
}

export async function deleteUserRoleNotInSites(id, roleId, targetSiteIds) {
  await pool.query(
    `DELETE FROM user_role
     WHERE fk_user_id = $1
       AND fk_role_id = $2
       AND (fk_site_id IS NOT NULL AND NOT (fk_site_id = ANY($3::bigint[])))`,
    [id, roleId, targetSiteIds]
  );
}

export async function deleteUserRoleAllSiteScoped(id, roleId) {
  await pool.query(
    `DELETE FROM user_role
     WHERE fk_user_id = $1
       AND fk_role_id = $2
       AND fk_site_id IS NOT NULL`,
    [id, roleId]
  );
}

// Site ids the user currently holds an active grant on. Used to preserve site
// scoping when a role is changed without the caller resending siteIds.
export async function getActiveUserRoleSiteIds(id) {
  const result = await pool.query(
    `SELECT DISTINCT fk_site_id AS site_id
     FROM user_role
     WHERE fk_user_id = $1 AND is_active = true AND fk_site_id IS NOT NULL`,
    [id]
  );
  return result.rows.map((r) => r.site_id);
}

// Reassigning a user's role must be authoritative: without this, a role once
// granted (e.g. tenant_admin) stays active forever and getPrimaryRole()'s
// highest-privilege-wins resolver keeps returning it regardless of whatever
// role the user is later switched to.
export async function deactivateOtherUserRoles(id, keepRoleId) {
  await pool.query(
    `DELETE FROM user_role
     WHERE fk_user_id = $1
       AND fk_role_id != $2`,
    [id, keepRoleId]
  );
}

// ============================================================================
// PASSWORD RESET
// ============================================================================

export async function findUserForPasswordReset(id) {
  const result = await pool.query(
    'SELECT email, username, role, keycloak_sub, password_hash, is_active FROM frs_user WHERE pk_user_id = $1',
    [id]
  );
  return result.rows[0] ?? null;
}

export async function findRealmSlugForUser(id) {
  const result = await pool.query(
    `SELECT tr.realm_slug
     FROM frs_tenant_user_map tum
     JOIN tenant_realm tr ON tr.fk_tenant_id = tum.fk_tenant_id
     WHERE tum.fk_user_id = $1
     LIMIT 1`,
    [id]
  );
  return result.rows[0]?.realm_slug ?? null;
}

export async function updatePasswordHash(id, hash) {
  await pool.query(
    `UPDATE frs_user SET password_hash = $1, must_set_password = false WHERE pk_user_id = $2`,
    [hash, id]
  );
}

export async function revokeSessions(id) {
  await pool.query('UPDATE auth_session_token SET revoked = true WHERE fk_user_id = $1', [id]).catch(() => {});
}

// ============================================================================
// ACTIVATE / DEACTIVATE
// ============================================================================

export async function deactivateUser(id) {
  const result = await pool.query(
    `UPDATE frs_user SET is_active = false WHERE pk_user_id = $1
     RETURNING pk_user_id, email, username, is_active, keycloak_sub`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function activateUser(id) {
  const result = await pool.query(
    `UPDATE frs_user SET is_active = true WHERE pk_user_id = $1
     RETURNING pk_user_id, email, username, is_active, keycloak_sub`,
    [id]
  );
  return result.rows[0] ?? null;
}

// ============================================================================
// DELETE (cascade — used by DELETE /:id and the Keycloak-prune sync)
// ============================================================================

export async function getKeycloakSubForUser(id) {
  const result = await pool.query('SELECT keycloak_sub FROM frs_user WHERE pk_user_id = $1', [id]);
  return result.rows[0]?.keycloak_sub ?? null;
}

export async function cascadeDeleteUser(id) {
  await pool.query('UPDATE audit_log SET fk_user_id = NULL WHERE fk_user_id = $1', [id]).catch(() => {});
  await pool.query('UPDATE system_alert SET acknowledged_by = NULL WHERE acknowledged_by = $1', [id]).catch(() => {});
  await pool.query('UPDATE system_alert SET resolved_by = NULL WHERE resolved_by = $1', [id]).catch(() => {});
  await pool.query('UPDATE system_alert SET assigned_to = NULL WHERE assigned_to = $1', [id]).catch(() => {});
  await pool.query('UPDATE frs_site SET created_by_user_id = NULL WHERE created_by_user_id = $1', [id]).catch(() => {});
  await pool.query('UPDATE employee_face_embeddings SET enrolled_by = NULL WHERE enrolled_by = $1', [id]).catch(() => {});

  await pool.query('DELETE FROM user_role WHERE fk_user_id = $1', [id]).catch(() => {});
  await pool.query('DELETE FROM user_invite WHERE fk_user_id = $1', [id]).catch(() => {});
  await pool.query('DELETE FROM user_invite WHERE invited_by_id = $1', [id]).catch(() => {});
  await pool.query('DELETE FROM frs_user_membership WHERE fk_user_id = $1', [id]).catch(() => {});
  await pool.query('DELETE FROM frs_tenant_user_map WHERE fk_user_id = $1', [id]).catch(() => {});
  await pool.query('DELETE FROM frs_customer_user_map WHERE fk_user_id = $1', [id]).catch(() => {});
  await pool.query('DELETE FROM auth_session_token WHERE fk_user_id = $1', [id]).catch(() => {});

  await pool.query('DELETE FROM frs_user WHERE pk_user_id = $1', [id]);
}

// ============================================================================
// KEYCLOAK SYNC / PRUNE
// ============================================================================

export async function listKeycloakLinkedUsers(defaultRealm) {
  const result = await pool.query(
    `SELECT u.pk_user_id, u.email, u.keycloak_sub,
            COALESCE(tr.realm_slug, $1) AS realm_slug
     FROM frs_user u
     LEFT JOIN frs_tenant_user_map tum ON tum.fk_user_id = u.pk_user_id
     LEFT JOIN tenant_realm tr ON tr.fk_tenant_id = tum.fk_tenant_id
     WHERE u.keycloak_sub IS NOT NULL`,
    [defaultRealm]
  );
  return result.rows;
}
