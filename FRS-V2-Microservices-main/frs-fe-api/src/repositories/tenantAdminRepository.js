import { pool } from '../db/pool.js';

// ============================================================================
// GUARD
// ============================================================================

export async function isTenantAdmin(userId) {
  const result = await pool.query(
    `SELECT 1
       FROM frs_user u
       LEFT JOIN user_role ur ON ur.fk_user_id = u.pk_user_id AND ur.is_active = true
       LEFT JOIN rbac_role rr ON rr.pk_role_id = ur.fk_role_id
      WHERE u.pk_user_id = $1
        AND ( rr.role_name IN ('tenant_admin', 'super_admin')
              OR u.role     IN ('admin', 'tenant_admin', 'super_admin') )
      LIMIT 1`,
    [userId]
  );
  return result.rows.length > 0;
}

// ============================================================================
// OVERVIEW
// ============================================================================

export async function getOverviewCoreStats(tenantId) {
  const zero = { rows: [{ count: 0 }] };
  const [sites, customers, users, configRow, tenantRow] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) FROM frs_site s
       JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
       WHERE c.fk_tenant_id = $1 AND s.status = 'active'`, [tenantId]),
    pool.query(
      `SELECT COUNT(*) FROM frs_customer WHERE fk_tenant_id = $1`, [tenantId]),
    pool.query(
      `SELECT COUNT(DISTINCT fk_user_id) FROM frs_tenant_user_map WHERE fk_tenant_id = $1`, [tenantId]),
    pool.query(
      `SELECT enabled_features FROM tenant_ui_config WHERE fk_tenant_id = $1`, [tenantId])
      .catch(() => ({ rows: [] })),
    pool.query(
      `SELECT tt.type_name AS "typeName"
       FROM frs_tenant t
       LEFT JOIN tenant_type tt ON tt.pk_tenant_type_id = t.fk_tenant_type_id
       WHERE t.pk_tenant_id = $1`, [tenantId])
      .catch(() => ({ rows: [] })),
  ]);
  return { sites, customers, users, configRow, tenantRow, zero };
}

export async function getOverviewFeatureStats(tenantId, has, zero) {
  const [
    totalEmployees, presentToday, lateToday,
    enrolledFaces,
    deviceTotal, deviceOnline, deviceOffline,
  ] = await Promise.all([
    // attendance / face_recognition share employee count
    (has('attendance') || has('face_recognition'))
      ? pool.query(
          `SELECT COUNT(*) FROM hr_employee WHERE tenant_id = $1 AND status = 'active'`,
          [tenantId]).catch(() => zero)
      : Promise.resolve(zero),

    has('attendance')
      ? pool.query(
          `SELECT COUNT(*) FROM attendance_record
           WHERE tenant_id = $1 AND attendance_date = CURRENT_DATE
             AND status IN ('present', 'late')`, [tenantId]).catch(() => zero)
      : Promise.resolve(zero),

    has('attendance')
      ? pool.query(
          `SELECT COUNT(*) FROM attendance_record
           WHERE tenant_id = $1 AND attendance_date = CURRENT_DATE AND is_late = true`,
          [tenantId]).catch(() => zero)
      : Promise.resolve(zero),

    has('face_recognition')
      ? pool.query(
          `SELECT COUNT(DISTINCT efe.employee_id)
           FROM employee_face_embeddings efe
           JOIN hr_employee e ON e.pk_employee_id = efe.employee_id
           WHERE e.tenant_id = $1`, [tenantId]).catch(() => zero)
      : Promise.resolve(zero),

    has('devices')
      ? pool.query(
          `SELECT COUNT(*) FROM facility_device
           WHERE tenant_id = $1 AND status != 'decommissioned'`, [tenantId]).catch(() => zero)
      : Promise.resolve(zero),

    has('devices')
      ? pool.query(
          `SELECT COUNT(*) FROM facility_device
           WHERE tenant_id = $1 AND status = 'online'`, [tenantId]).catch(() => zero)
      : Promise.resolve(zero),

    has('devices')
      ? pool.query(
          `SELECT COUNT(*) FROM facility_device
           WHERE tenant_id = $1 AND status = 'offline'`, [tenantId]).catch(() => zero)
      : Promise.resolve(zero),
  ]);
  return { totalEmployees, presentToday, lateToday, enrolledFaces, deviceTotal, deviceOnline, deviceOffline };
}

// ============================================================================
// SITES
// ============================================================================

export async function listTenantSites(tenantId) {
  const result = await pool.query(
    `SELECT
       s.pk_site_id        AS id,
       s.site_name         AS name,
       s.location_address,
       s.city,
       s.country,
       s.timezone_offset,
       s.status,
       s.latitude,
       s.longitude,
       c.customer_name     AS "customerName",
       c.pk_customer_id    AS "customerId",
       (
         SELECT COUNT(*)::int
         FROM hr_employee e
         WHERE e.tenant_id = c.fk_tenant_id
           AND s.pk_site_id = ANY(e.site_ids)
           AND e.status = 'active'
       ) AS member_count,
       (
         SELECT COUNT(*)::int
         FROM site_device_assignment sda
         JOIN facility_device fd ON fd.pk_device_id = sda.device_id
         WHERE sda.site_id = s.pk_site_id
           AND sda.is_active = TRUE
           AND fd.decommissioned_at IS NULL
       ) AS devices_total,
       (
         SELECT COUNT(*)::int
         FROM site_device_assignment sda
         JOIN facility_device fd ON fd.pk_device_id = sda.device_id
         WHERE sda.site_id = s.pk_site_id
           AND sda.is_active = TRUE
           AND fd.decommissioned_at IS NULL
       ) AS device_count,
       (
         SELECT COUNT(*)::int
         FROM site_device_assignment sda
         JOIN facility_device fd ON fd.pk_device_id = sda.device_id
         WHERE sda.site_id = s.pk_site_id
           AND sda.is_active = TRUE
           AND fd.decommissioned_at IS NULL
           AND fd.status = 'online'
       ) AS devices_online,
       (
         SELECT COALESCE(
           ROUND(
             (COUNT(DISTINCT a.fk_employee_id) * 100.0) / NULLIF(
               (
                 SELECT COUNT(*)::int
                 FROM hr_employee e2
                 WHERE e2.tenant_id = c.fk_tenant_id
                   AND s.pk_site_id = ANY(e2.site_ids)
                   AND e2.status = 'active'
               ),
               0
             )
           )::int,
           0
         )
         FROM attendance_record a
         JOIN hr_employee e ON e.pk_employee_id = a.fk_employee_id
         WHERE a.tenant_id = c.fk_tenant_id
           AND a.attendance_date = CURRENT_DATE
           AND a.status IN ('present', 'late')
           AND s.pk_site_id = ANY(e.site_ids)
       ) AS attendance_rate
     FROM frs_site s
     JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
     WHERE c.fk_tenant_id = $1
     ORDER BY s.site_name`,
    [tenantId]
  );
  return result.rows;
}

// ============================================================================
// USERS
// ============================================================================

export async function listTenantUsers(tenantId) {
  const result = await pool.query(
    `SELECT
       u.pk_user_id   AS id,
       u.email,
       u.username     AS name,
       u.role,
       u.department,
       u.created_at,
       COALESCE(
         json_agg(
           json_build_object(
             'roleId',   ur.pk_user_role_id,
             'roleName', rr.role_name,
             'siteId',   ur.fk_site_id,
             'siteName', fs.site_name
           )
         ) FILTER (WHERE ur.pk_user_role_id IS NOT NULL),
         '[]'
       ) AS rbac_roles
     FROM frs_tenant_user_map tum
     JOIN frs_user u ON u.pk_user_id = tum.fk_user_id
     LEFT JOIN user_role ur ON ur.fk_user_id = u.pk_user_id AND ur.is_active = true
     LEFT JOIN rbac_role rr ON rr.pk_role_id = ur.fk_role_id
     LEFT JOIN frs_site fs  ON fs.pk_site_id = ur.fk_site_id
     WHERE tum.fk_tenant_id = $1
       AND u.pk_user_id NOT IN (
         SELECT ur2.fk_user_id FROM user_role ur2
         JOIN rbac_role rr2 ON rr2.pk_role_id = ur2.fk_role_id
         WHERE rr2.role_name = 'super_admin' AND ur2.is_active = true
       )
     GROUP BY u.pk_user_id, u.email, u.username, u.role, u.department, u.created_at
     ORDER BY u.created_at DESC`,
    [tenantId]
  );
  return result.rows;
}

export async function findUserByEmail(client, email) {
  const result = await client.query('SELECT pk_user_id FROM frs_user WHERE email = $1', [email]);
  return result.rows[0] ?? null;
}

export async function findUserByUsername(client, tenantId, username) {
  const result = await client.query(
    `SELECT u.pk_user_id FROM frs_tenant_user_map tum
     JOIN frs_user u ON u.pk_user_id = tum.fk_user_id
     WHERE tum.fk_tenant_id = $1 AND LOWER(TRIM(u.username)) = LOWER($2)`,
    [tenantId, username.trim()]
  );
  return result.rows[0] ?? null;
}

export async function insertTenantUser(client, { email, username, passwordHash, roleName, department }) {
  const result = await client.query(
    `INSERT INTO frs_user (email, username, password_hash, role, department, must_set_password)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING pk_user_id, email, username, role`,
    [email, username, passwordHash, roleName, department]
  );
  return result.rows[0];
}

export async function mapUserToTenant(client, userId, tenantId) {
  await client.query(
    'INSERT INTO frs_tenant_user_map (fk_user_id, fk_tenant_id) VALUES ($1, $2)',
    [userId, tenantId]
  );
}

export async function findFirstCustomerForTenant(client, tenantId) {
  const result = await client.query(
    'SELECT pk_customer_id FROM frs_customer WHERE fk_tenant_id = $1::uuid LIMIT 1',
    [tenantId]
  );
  return result.rows[0]?.pk_customer_id ?? null;
}

export async function findInactiveSites(client, siteIds) {
  const result = await client.query(
    `SELECT pk_site_id, site_name FROM frs_site WHERE pk_site_id = ANY($1::bigint[]) AND status = 'inactive'`,
    [siteIds]
  );
  return result.rows;
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

export async function findRbacRoleByName(client, roleName) {
  const result = await client.query('SELECT pk_role_id FROM rbac_role WHERE role_name = $1', [roleName]);
  return result.rows[0] ?? null;
}

export async function insertUserRole(client, { userId, roleId, siteId, grantedBy }) {
  await client.query(
    `INSERT INTO user_role (fk_user_id, fk_role_id, fk_site_id, granted_by, is_active)
     VALUES ($1, $2, $3, $4, true)`,
    [userId, roleId, siteId, grantedBy]
  );
}

export async function getTenantName(client, tenantId) {
  const result = await client.query('SELECT tenant_name FROM frs_tenant WHERE pk_tenant_id = $1', [tenantId]);
  return result.rows[0]?.tenant_name ?? null;
}

export async function getSiteName(client, siteId) {
  const result = await client.query('SELECT site_name FROM frs_site WHERE pk_site_id = $1', [siteId]);
  return result.rows[0]?.site_name ?? null;
}

export async function insertInvite(client, { userId, hashedToken, invitedById, invitedByName, roleLabel, tenantName, siteName, ttlHours }) {
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
  await client.query(
    `INSERT INTO user_invite
       (fk_user_id, invite_token, invited_by_id, invited_by_name, role_label, tenant_name, site_name, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [userId, hashedToken, invitedById, invitedByName, roleLabel, tenantName, siteName, expiresAt]
  );
  return expiresAt;
}

// ── Keycloak sync (post-commit, non-fatal) ──────────────────────────────────

export async function getRealmSlugForTenant(tenantId) {
  const result = await pool.query(
    'SELECT realm_slug FROM tenant_realm WHERE fk_tenant_id = $1 LIMIT 1',
    [tenantId]
  );
  return result.rows[0]?.realm_slug || undefined;
}

export async function getSiteKeycloakOrg(siteId) {
  const result = await pool.query(
    'SELECT keycloak_org_id FROM frs_site WHERE pk_site_id = $1',
    [siteId]
  );
  return result.rows[0]?.keycloak_org_id || null;
}

export async function updateUserKeycloakSub(userId, keycloakUserId) {
  await pool.query(
    'UPDATE frs_user SET keycloak_sub = $1 WHERE pk_user_id = $2',
    [keycloakUserId, userId]
  );
}

// ============================================================================
// USER SYNC (backfill DB users into Keycloak)
// ============================================================================

export async function listTenantUsersForSync(tenantId) {
  const result = await pool.query(
    `SELECT DISTINCT u.pk_user_id, u.email, u.username, u.role, u.keycloak_sub,
            (SELECT s.keycloak_org_id
               FROM frs_user_membership m
               JOIN frs_site s ON s.pk_site_id = m.site_id
              WHERE m.fk_user_id = u.pk_user_id AND m.tenant_id = $1::uuid
              LIMIT 1) AS site_org
     FROM frs_tenant_user_map tum
     JOIN frs_user u ON u.pk_user_id = tum.fk_user_id
     WHERE tum.fk_tenant_id = $1
     ORDER BY u.email`,
    [tenantId]
  );
  return result.rows;
}

// ============================================================================
// ANALYTICS
// ============================================================================

export async function getAttendanceLast30({ tenantId, dateClause, params }) {
  const result = await pool.query(
    `SELECT
       ar.attendance_date::text AS date,
       COUNT(*) FILTER (WHERE ar.status IN ('present', 'late'))::int AS present,
       COUNT(*) FILTER (WHERE ar.check_out IS NOT NULL)::int AS checked_out
     FROM attendance_record ar
     WHERE ar.tenant_id = $1
       AND ${dateClause}
     GROUP BY ar.attendance_date
     ORDER BY ar.attendance_date`,
    params
  ).catch(() => ({ rows: [] }));
  return result.rows;
}

export async function getSiteActivity(tenantId) {
  const result = await pool.query(
    `SELECT
       s.site_name AS site,
       COUNT(DISTINCT e.pk_employee_id) AS employee_count,
       COUNT(DISTINCT sda.device_id) FILTER (WHERE sda.is_active) AS device_count
     FROM frs_site s
     JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
     LEFT JOIN hr_employee e ON s.pk_site_id = ANY(e.site_ids)
     LEFT JOIN site_device_assignment sda ON sda.site_id = s.pk_site_id
     WHERE c.fk_tenant_id = $1 AND s.status = 'active'
     GROUP BY s.pk_site_id, s.site_name
     ORDER BY employee_count DESC`,
    [tenantId]
  ).catch(() => ({ rows: [] }));
  return result.rows;
}

// ============================================================================
// UI CONFIG
// ============================================================================

export async function getUiConfig(tenantId) {
  const result = await pool.query(
    `SELECT logo_url AS "logoUrl", primary_color AS "primaryColor",
            enabled_features AS "enabledFeatures",
            dashboard_widgets AS "dashboardWidgets"
     FROM tenant_ui_config WHERE fk_tenant_id = $1`,
    [tenantId]
  );
  return result.rows[0] ?? null;
}

export async function upsertUiConfig({ tenantId, logoUrl, primaryColor, enabledFeatures, dashboardWidgets }) {
  await pool.query(
    `INSERT INTO tenant_ui_config
       (fk_tenant_id, logo_url, primary_color, enabled_features, dashboard_widgets, updated_at)
     VALUES ($1, $2, COALESCE($3, '#6366f1'), COALESCE($4, '[]'::jsonb), COALESCE($5, '[]'::jsonb), NOW())
     ON CONFLICT (fk_tenant_id) DO UPDATE SET
       logo_url          = COALESCE($2, tenant_ui_config.logo_url),
       primary_color     = COALESCE($3, tenant_ui_config.primary_color),
       enabled_features  = COALESCE($4, tenant_ui_config.enabled_features),
       dashboard_widgets = COALESCE($5, tenant_ui_config.dashboard_widgets),
       updated_at        = NOW()`,
    [tenantId, logoUrl, primaryColor, enabledFeatures, dashboardWidgets]
  );
}

// ============================================================================
// GROUPS
// ============================================================================

export async function listGroups(tenantId) {
  const result = await pool.query(
    `SELECT
       g.pk_group_id   AS id,
       g.group_name    AS name,
       g.description,
       g.is_default    AS "isDefault",
       g.is_admin_group AS "isAdminGroup",
       g.is_active     AS "isActive",
       g.created_at    AS "createdAt",
       COUNT(DISTINCT ugm.fk_user_id)::int AS member_count,
       COALESCE(
         (
           SELECT json_agg(json_build_object('roleId', rr2.pk_role_id, 'roleName', rr2.role_name, 'siteId', grm2.fk_site_id))
           FROM group_role_map grm2
           JOIN rbac_role rr2 ON rr2.pk_role_id = grm2.fk_role_id
           WHERE grm2.fk_group_id = g.pk_group_id
         ),
         '[]'::json
       ) AS roles,
       COALESCE(
         (
           SELECT json_agg(json_build_object('id', u.pk_user_id, 'email', u.email, 'username', u.username))
           FROM (
             SELECT u2.pk_user_id, u2.email, u2.username
             FROM user_group_map ugm2
             JOIN frs_user u2 ON u2.pk_user_id = ugm2.fk_user_id
             WHERE ugm2.fk_group_id = g.pk_group_id
             LIMIT 5
           ) u
         ),
         '[]'::json
       ) AS "memberPreviews"
     FROM frs_group g
     LEFT JOIN user_group_map ugm ON ugm.fk_group_id = g.pk_group_id
     WHERE g.fk_tenant_id = $1 AND g.is_active = true
     GROUP BY g.pk_group_id
     ORDER BY g.group_name`,
    [tenantId]
  );
  return result.rows;
}

export async function findGroupByName(client, tenantId, name) {
  const result = await client.query(
    'SELECT pk_group_id FROM frs_group WHERE fk_tenant_id = $1 AND group_name = $2 AND is_active = true',
    [tenantId, name]
  );
  return result.rows[0] ?? null;
}

export async function insertGroup(client, { name, description, isDefault, tenantId, createdBy }) {
  const result = await client.query(
    `INSERT INTO frs_group (group_name, description, is_default, fk_tenant_id, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING pk_group_id AS id, group_name AS name, description, is_default AS "isDefault"`,
    [name, description, isDefault, tenantId, createdBy]
  );
  return result.rows[0];
}

export async function insertGroupRoleMap(client, { groupId, roleIds, grantedBy }) {
  await client.query(
    `INSERT INTO group_role_map (fk_group_id, fk_role_id, fk_role_id_uuid, granted_by)
     SELECT $1, rr.pk_role_id, rr.pk_role_id_uuid, $3
     FROM unnest($2::int[]) AS role_id
     JOIN rbac_role rr ON rr.pk_role_id = role_id`,
    [groupId, roleIds, grantedBy]
  );
}

export async function updateGroup(client, { name, description, isDefault, id, tenantId }) {
  const result = await client.query(
    `UPDATE frs_group
     SET group_name  = COALESCE($1, group_name),
         description = COALESCE($2, description),
         is_default  = COALESCE($3, is_default),
         updated_at  = NOW()
     WHERE pk_group_id = $4 AND fk_tenant_id = $5
     RETURNING pk_group_id AS id, group_name AS name, description, is_default AS "isDefault"`,
    [name, description, isDefault, id, tenantId]
  );
  return result.rows[0] ?? null;
}

export async function deleteGroupRoleMap(client, groupId) {
  await client.query('DELETE FROM group_role_map WHERE fk_group_id = $1', [groupId]);
}

export async function deactivateGroup(id, tenantId) {
  const result = await pool.query(
    `UPDATE frs_group 
     SET is_active = false, 
         group_name = group_name || '_deleted_' || extract(epoch from now()), 
         updated_at = NOW()
     WHERE pk_group_id = $1 AND fk_tenant_id = $2
     RETURNING pk_group_id`,
    [id, tenantId]
  );
  return result.rows[0] ?? null;
}

// ── Group members ────────────────────────────────────────────────────────────

export async function listGroupMembers(groupId, tenantId) {
  const result = await pool.query(
    `SELECT u.pk_user_id AS id, u.email, u.username AS name, ugm.added_at AS "addedAt"
     FROM user_group_map ugm
     JOIN frs_user u ON u.pk_user_id = ugm.fk_user_id
     JOIN frs_group g ON g.pk_group_id = ugm.fk_group_id
     WHERE ugm.fk_group_id = $1 AND g.fk_tenant_id = $2
     ORDER BY u.username`,
    [groupId, tenantId]
  );
  return result.rows;
}

export async function isUserInTenant(userId, tenantId) {
  const result = await pool.query(
    `SELECT 1 FROM frs_tenant_user_map
     WHERE fk_user_id = $1 AND fk_tenant_id = $2`,
    [userId, tenantId]
  );
  return result.rows.length > 0;
}

export async function addGroupMember({ userId, groupId, addedBy }) {
  await pool.query(
    `INSERT INTO user_group_map (fk_user_id, fk_group_id, added_by)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [userId, groupId, addedBy]
  );
}

export async function removeGroupMember(groupId, userId) {
  await pool.query(
    'DELETE FROM user_group_map WHERE fk_group_id = $1 AND fk_user_id = $2',
    [groupId, userId]
  );
}
