import { pool } from '../db/pool.js';

// ============================================================================
// OVERVIEW / ANALYTICS (cross-tenant aggregate stats)
// ============================================================================

export async function getOverviewStats() {
  const [deviceMetrics, tenantActivity] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(CASE WHEN dt.category = 'edge_node' THEN 1 END)::int as edge_nodes_total,
        COUNT(CASE WHEN dt.category = 'camera' THEN 1 END)::int as cameras_total
      FROM facility_device fd
      LEFT JOIN device_type dt ON dt.pk_device_type_id = fd.device_type_id
      WHERE fd.status != 'decommissioned'
    `),
    pool.query(`
      SELECT
        t.pk_tenant_id as tenant_id,
        t.tenant_name as tenant,
        sp.name as plan,
        COUNT(DISTINCT s.pk_site_id)::int as site_count,
        COUNT(DISTINCT CASE WHEN u.role != 'super_admin' THEN tum.fk_user_id END)::int as users_count,
        COUNT(DISTINCT CASE WHEN dt.category = 'edge_node' THEN d.pk_device_id END)::int as edge_node_count,
        COUNT(DISTINCT CASE WHEN dt.category = 'camera' THEN d.pk_device_id END)::int as camera_count
      FROM frs_tenant t
      LEFT JOIN tenant_subscriptions ts ON ts.fk_tenant_id = t.pk_tenant_id AND ts.status = 'active'
      LEFT JOIN subscription_plans sp ON sp.pk_plan_id = ts.fk_plan_id
      LEFT JOIN frs_tenant_user_map tum ON tum.fk_tenant_id = t.pk_tenant_id
      LEFT JOIN frs_user u ON u.pk_user_id = tum.fk_user_id
      LEFT JOIN frs_customer c ON c.fk_tenant_id = t.pk_tenant_id
      LEFT JOIN frs_site s ON s.fk_customer_id = c.pk_customer_id AND s.status = 'active'
      LEFT JOIN facility_device d ON d.tenant_id = t.pk_tenant_id AND d.status != 'decommissioned'
      LEFT JOIN device_type dt ON dt.pk_device_type_id = d.device_type_id
      GROUP BY t.pk_tenant_id, t.tenant_name, sp.name
      ORDER BY edge_node_count DESC, camera_count DESC
    `)
  ]);

  const activityRows = tenantActivity.rows;

  return {
    tenants:   activityRows.length,
    customers: activityRows.length,
    sites:     activityRows.reduce((sum, row) => sum + row.site_count, 0),
    users:     activityRows.reduce((sum, row) => sum + row.users_count, 0),
    edgeNodes: activityRows.reduce((sum, row) => sum + row.edge_node_count, 0),
    cameras:   activityRows.reduce((sum, row) => sum + row.camera_count, 0),
    tenantActivity: activityRows,
  };
}

export async function getAnalyticsStats() {
  const [deviceMetrics, deviceStatus, systemHealthStats, recentAlerts, tenantActivity, mapLocations] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(CASE WHEN dt.category = 'edge_node' THEN 1 END)::int as edge_nodes_total,
        COUNT(CASE WHEN dt.category = 'edge_node' AND fd.status = 'online' AND fd.last_heartbeat >= NOW() - INTERVAL '5 minutes' THEN 1 END)::int as edge_nodes_online,
        COUNT(CASE WHEN dt.category = 'camera' THEN 1 END)::int as cameras_total,
        COUNT(CASE WHEN dt.category = 'camera' AND fd.status = 'online' AND fd.last_heartbeat >= NOW() - INTERVAL '5 minutes' THEN 1 END)::int as cameras_online
      FROM facility_device fd
      LEFT JOIN device_type dt ON dt.pk_device_type_id = fd.device_type_id
      WHERE fd.status != 'decommissioned'
    `),
    pool.query(`
      SELECT
        dt.category,
        CASE
          WHEN fd.last_heartbeat < NOW() - INTERVAL '5 minutes' OR fd.last_heartbeat IS NULL THEN 'offline'
          ELSE fd.status
        END as status,
        COUNT(*)::int as count
      FROM facility_device fd
      LEFT JOIN device_type dt ON dt.pk_device_type_id = fd.device_type_id
      WHERE fd.status != 'decommissioned'
      GROUP BY dt.category,
               CASE
                 WHEN fd.last_heartbeat < NOW() - INTERVAL '5 minutes' OR fd.last_heartbeat IS NULL THEN 'offline'
                 ELSE fd.status
               END
    `),
    pool.query(`
      SELECT
        COALESCE(SUM(total_scans), 0)::int as total_scans,
        COALESCE(AVG(recognition_accuracy::numeric), 0)::float as avg_accuracy,
        (SELECT COUNT(*)::int FROM unauthorized_access_log WHERE resolved_at IS NULL) as active_alerts,
        (SELECT COUNT(*)::int FROM unauthorized_access_log WHERE resolved_at IS NULL AND confidence_score < 0.3) as critical_alerts
      FROM facility_device
      WHERE decommissioned_at IS NULL
    `),
    pool.query(`
      SELECT
        ua.pk_log_id AS id,
        ua.event_timestamp AS created_at,
        ua.confidence_score,
        fd.name AS device_name,
        s.site_name,
        COALESCE(e.full_name, 'Unknown') AS employee_name
      FROM unauthorized_access_log ua
      LEFT JOIN facility_device fd ON fd.pk_device_id::text = ua.device_id
      LEFT JOIN frs_site s ON s.pk_site_id = fd.site_id
      LEFT JOIN hr_employee e ON e.employee_code = ua.employee_code AND e.mt_tenant_id = fd.tenant_id
      WHERE ua.resolved_at IS NULL
      ORDER BY ua.event_timestamp DESC
      LIMIT 5
    `),
    pool.query(`
      SELECT
        t.pk_tenant_id as tenant_id,
        t.tenant_name as tenant,
        sp.name as plan,
        COUNT(DISTINCT s.pk_site_id)::int as site_count,
        COUNT(DISTINCT CASE WHEN u.role != 'super_admin' THEN tum.fk_user_id END)::int as users_count,
        COUNT(DISTINCT CASE WHEN dt.category = 'edge_node' THEN d.pk_device_id END)::int as edge_node_count,
        COUNT(DISTINCT CASE WHEN dt.category = 'camera' THEN d.pk_device_id END)::int as camera_count
      FROM frs_tenant t
      LEFT JOIN tenant_subscriptions ts ON ts.fk_tenant_id = t.pk_tenant_id AND ts.status = 'active'
      LEFT JOIN subscription_plans sp ON sp.pk_plan_id = ts.fk_plan_id
      LEFT JOIN frs_tenant_user_map tum ON tum.fk_tenant_id = t.pk_tenant_id
      LEFT JOIN frs_user u ON u.pk_user_id = tum.fk_user_id
      LEFT JOIN frs_customer c ON c.fk_tenant_id = t.pk_tenant_id
      LEFT JOIN frs_site s ON s.fk_customer_id = c.pk_customer_id AND s.status = 'active'
      LEFT JOIN facility_device d ON d.tenant_id = t.pk_tenant_id AND d.status != 'decommissioned'
      LEFT JOIN device_type dt ON dt.pk_device_type_id = d.device_type_id
      GROUP BY t.pk_tenant_id, t.tenant_name, sp.name
      ORDER BY edge_node_count DESC, camera_count DESC
    `),
    pool.query(`
      SELECT
        s.pk_site_id AS id,
        s.site_name AS name,
        s.latitude,
        s.longitude,
        s.city,
        s.country,
        s.location_address,
        t.pk_tenant_id AS tenant_id,
        t.tenant_name AS tenant,
        COUNT(DISTINCT CASE WHEN dt.category = 'edge_node' THEN fd.pk_device_id END)::int as edge_node_count,
        COUNT(DISTINCT CASE WHEN dt.category = 'camera' THEN fd.pk_device_id END)::int as camera_count
      FROM frs_site s
      JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
      JOIN frs_tenant t ON t.pk_tenant_id = c.fk_tenant_id
      LEFT JOIN facility_device fd ON fd.site_id = s.pk_site_id AND fd.status != 'decommissioned'
      LEFT JOIN device_type dt ON dt.pk_device_type_id = fd.device_type_id
      WHERE s.status = 'active'
      GROUP BY s.pk_site_id, s.site_name, s.latitude, s.longitude, s.city, s.country, s.location_address, t.pk_tenant_id, t.tenant_name
      ORDER BY t.tenant_name, s.site_name
    `)
  ]);

  const activityRows = tenantActivity.rows;

  return {
    summary: {
      tenants:   activityRows.length,
      customers: activityRows.length,
      sites:     activityRows.reduce((sum, row) => sum + row.site_count, 0),
      users:     activityRows.reduce((sum, row) => sum + row.users_count, 0),
      edgeNodes: activityRows.reduce((sum, row) => sum + row.edge_node_count, 0),
      edgeNodesOnline: deviceMetrics.rows[0].edge_nodes_online,
      cameras:   activityRows.reduce((sum, row) => sum + row.camera_count, 0),
      camerasOnline: deviceMetrics.rows[0].cameras_online,
    },
    deviceStatus: deviceStatus.rows,
    systemHealth: systemHealthStats.rows[0],
    recentAlerts: recentAlerts.rows,
    tenantActivity: activityRows,
    mapLocations: mapLocations.rows,
  };
}

// ============================================================================
// TENANTS CRUD
// ============================================================================

export async function listTenants() {
  const result = await pool.query(`
    SELECT
      t.pk_tenant_id                                  AS id,
      t.tenant_name                                   AS name,
      ts.fk_plan_id                                   AS "tenantTypeId",
      sp.name                                         AS "tenantTypeName",
      (
        SELECT COALESCE(
          EXISTS (
            SELECT 1
            FROM public.user_invite ui
            WHERE ui.fk_user_id = u.pk_user_id
              AND ui.tenant_name = t.tenant_name
              AND ui.used_at IS NULL
              AND ui.expires_at > NOW()
          ) OR u.must_set_password,
          false
        )
        FROM public.frs_user u
        JOIN public.frs_tenant_user_map m ON m.fk_user_id = u.pk_user_id
        WHERE m.fk_tenant_id = t.pk_tenant_id AND u.role = 'tenant_admin'
        LIMIT 1
      ) AS "mustSetPassword",
      (
        SELECT u.email
        FROM public.frs_user u
        JOIN public.frs_tenant_user_map m ON m.fk_user_id = u.pk_user_id
        WHERE m.fk_tenant_id = t.pk_tenant_id AND u.role = 'tenant_admin'
        LIMIT 1
      ) AS "adminEmail",
      COUNT(DISTINCT c.pk_customer_id)::int           AS customer_count,
      COUNT(DISTINCT s.pk_site_id)::int               AS site_count,
      COUNT(DISTINCT CASE WHEN u.role != 'super_admin' THEN tum.fk_user_id END)::int             AS user_count
    FROM frs_tenant t
    LEFT JOIN tenant_subscriptions ts ON ts.fk_tenant_id = t.pk_tenant_id AND ts.status = 'active'
    LEFT JOIN subscription_plans sp   ON sp.pk_plan_id = ts.fk_plan_id
    LEFT JOIN frs_customer c          ON c.fk_tenant_id       = t.pk_tenant_id
    LEFT JOIN frs_site s              ON s.fk_customer_id     = c.pk_customer_id AND s.status = 'active'
    LEFT JOIN frs_tenant_user_map tum ON tum.fk_tenant_id     = t.pk_tenant_id
    LEFT JOIN frs_user u              ON u.pk_user_id         = tum.fk_user_id
    GROUP BY t.pk_tenant_id, t.tenant_name, ts.fk_plan_id, sp.name
    ORDER BY t.tenant_name ASC
  `);
  return result.rows;
}

export async function findTenantByName(name) {
  const result = await pool.query(
    'SELECT pk_tenant_id FROM frs_tenant WHERE tenant_name = $1', [name]
  );
  return result.rows[0] ?? null;
}

export async function isRealmSlugTaken(realmSlug) {
  const result = await pool.query(
    `SELECT realm_slug FROM tenant_realm WHERE realm_slug = $1
     UNION
     SELECT t.slug FROM tenants t
     WHERE t.slug = $1 AND t.status = 'active'`, [realmSlug]
  );
  return result.rows.length > 0;
}

export async function findUserByEmailForTenantCreate(email) {
  const result = await pool.query(
    'SELECT pk_user_id, email, username FROM frs_user WHERE email = $1', [email]
  );
  return result.rows[0] ?? null;
}

export async function getPlanForTenantCreate(client, tenantTypeId) {
  const result = await client.query(
    `SELECT name, features, vertical FROM subscription_plans WHERE pk_plan_id = $1`,
    [tenantTypeId]
  );
  return result.rows[0] ?? null;
}

export async function findLegacyTenantTypeId(client, lookupName) {
  const result = await client.query(
    `SELECT pk_tenant_type_id FROM tenant_type WHERE LOWER(type_name) = $1 LIMIT 1`,
    [lookupName]
  );
  return result.rows[0]?.pk_tenant_type_id ?? null;
}

export async function insertTenant(client, { tenantId, name, legacyTenantTypeId, vertical }) {
  const result = await client.query(
    `INSERT INTO frs_tenant (pk_tenant_id, tenant_name, fk_tenant_type_id, vertical)
     VALUES ($1, $2, $3, $4)
     RETURNING pk_tenant_id AS id, tenant_name AS name, fk_tenant_type_id AS "tenantTypeId"`,
    [tenantId, name, legacyTenantTypeId, vertical]
  );
  return result.rows[0];
}

export async function upsertTenantUiConfig(client, tenantId, features) {
  await client.query(
    `INSERT INTO tenant_ui_config (fk_tenant_id, enabled_features)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (fk_tenant_id) DO UPDATE SET enabled_features = $2::jsonb`,
    [tenantId, JSON.stringify(features)]
  );
}

export async function retireOrphanedTenantSlug(client, realmSlug) {
  await client.query(
    `UPDATE tenants SET status = 'inactive',
        slug = slug || '-deleted-' || substring(pk_tenant_id::text from 1 for 8)
     WHERE slug = $1
       AND parent_id = '00000000-0000-0000-0000-000000000001'::uuid
       AND NOT EXISTS (SELECT 1 FROM frs_tenant WHERE pk_tenant_id = tenants.pk_tenant_id)`,
    [realmSlug]
  );
}

export async function upsertTenantTreeNode(client, { tenantId, hierarchyPath, vertical, name, slug }) {
  await client.query(
    `INSERT INTO tenants (
        pk_tenant_id, parent_id, root_id, hierarchy_path,
        level, tenant_kind, vertical, name, slug, status, settings
     ) VALUES ($1, '00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000001'::uuid, $2, 1, 'customer', $3, $4, $5, 'active', '{}'::jsonb)
     ON CONFLICT (pk_tenant_id) DO UPDATE SET
        slug = EXCLUDED.slug,
        hierarchy_path = EXCLUDED.hierarchy_path`,
    [tenantId, hierarchyPath, vertical, name, slug]
  );
}

export async function insertTenantSubscription(client, { tenantId, tenantTypeId }) {
  await client.query(
    `INSERT INTO tenant_subscriptions (fk_tenant_id, fk_plan_id, status, starts_at, auto_renew)
     VALUES ($1, $2, 'active', NOW(), true)`,
    [tenantId, tenantTypeId]
  );
}

export async function insertTenantSettings(client, tenantId, features) {
  await client.query(
    `INSERT INTO tenant_settings (fk_tenant_id, primary_color, custom_features, email_notifications)
     VALUES ($1, '#6366f1', $2::jsonb, true)`,
    [tenantId, JSON.stringify(features)]
  );
}

export async function insertTenantRealm(client, { tenantId, realmSlug, realmName, domain, sessionTimeout, maxFailedLogins, passwordMinLength, lockoutDurationMinutes }) {
  const result = await client.query(
    `INSERT INTO tenant_realm
       (fk_tenant_id, realm_slug, realm_name, domain,
        session_timeout_minutes, max_failed_logins, password_min_length, lockout_duration_minutes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING pk_realm_id AS id, realm_slug AS slug, realm_name AS "realmName",
               domain, session_timeout_minutes AS "sessionTimeout",
               max_failed_logins AS "maxFailedLogins",
               password_min_length AS "passwordMinLength",
               lockout_duration_minutes AS "lockoutDurationMinutes", created_at AS "createdAt"`,
    [tenantId, realmSlug, realmName, domain, sessionTimeout ?? 480, maxFailedLogins ?? 5, passwordMinLength ?? 8, lockoutDurationMinutes ?? 15]
  );
  return result.rows[0];
}

export async function insertGroup(client, { tenantId, name, description }) {
  const { rows: [grp] } = await client.query(
    `INSERT INTO frs_group (fk_tenant_id, group_name, description)
     VALUES ($1,$2,$3) RETURNING pk_group_id`,
    [tenantId, name, description]
  );
  return grp;
}

export async function findRoleByName(client, roleName) {
  const { rows: [role] } = await client.query(
    `SELECT pk_role_id FROM rbac_role WHERE role_name = $1`, [roleName]
  );
  return role ?? null;
}

export async function insertGroupRoleMap(client, groupId, roleId) {
  await client.query(
    `INSERT INTO group_role_map (fk_group_id, fk_role_id)
     VALUES ($1, $2)`,
    [groupId, roleId]
  );
}

export async function insertTenantAdminUser(client, { email, username, passwordHash, keycloakSub }) {
  const result = await client.query(
    `INSERT INTO frs_user (email, username, password_hash, role, must_set_password, keycloak_sub)
     VALUES ($1, $2, $3, 'admin', true, $4)
     RETURNING pk_user_id, email, username`,
    [email, username, passwordHash, keycloakSub]
  );
  return result.rows[0];
}

export async function insertTenantUserMap(client, userId, tenantId) {
  await client.query(
    'INSERT INTO frs_tenant_user_map (fk_user_id, fk_tenant_id) VALUES ($1, $2)',
    [userId, tenantId]
  );
}

export async function assignUserRole(client, { userId, roleId, grantedBy }) {
  await client.query(
    `INSERT INTO user_role (fk_user_id, fk_role_id, fk_site_id, granted_by, is_active)
     VALUES ($1, $2, NULL, $3, true)
     ON CONFLICT DO NOTHING`,
    [userId, roleId, grantedBy]
  );
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

export async function updateTenantCore(client, { id, name, legacyTenantTypeId }) {
  const updateQuery = legacyTenantTypeId
    ? `UPDATE frs_tenant SET tenant_name = $1, fk_tenant_type_id = $2 WHERE pk_tenant_id = $3 RETURNING pk_tenant_id AS id, tenant_name AS name, fk_tenant_type_id AS "tenantTypeId"`
    : `UPDATE frs_tenant SET tenant_name = $1 WHERE pk_tenant_id = $2 RETURNING pk_tenant_id AS id, tenant_name AS name, fk_tenant_type_id AS "tenantTypeId"`;

  const queryParams = legacyTenantTypeId
    ? [name, legacyTenantTypeId, id]
    : [name, id];

  const result = await client.query(updateQuery, queryParams);
  return result.rows[0] ?? null;
}

export async function updateTenantTreeName(client, id, name) {
  await client.query(`UPDATE tenants SET name = $1 WHERE pk_tenant_id = $2`, [name, id]);
}

export async function tenantSubscriptionExists(client, tenantId) {
  const result = await client.query('SELECT 1 FROM tenant_subscriptions WHERE fk_tenant_id = $1', [tenantId]);
  return result.rows.length > 0;
}

export async function updateTenantSubscriptionPlan(client, tenantId, tenantTypeId) {
  await client.query(`UPDATE tenant_subscriptions SET fk_plan_id = $1 WHERE fk_tenant_id = $2`, [tenantTypeId, tenantId]);
}

export async function insertTenantSubscriptionOnUpdate(client, tenantId, tenantTypeId) {
  await client.query(`INSERT INTO tenant_subscriptions (fk_tenant_id, fk_plan_id, status, starts_at, auto_renew) VALUES ($1, $2, 'active', NOW(), true)`, [tenantId, tenantTypeId]);
}

export async function upsertTenantUiConfigOnUpdate(client, tenantId, features) {
  await client.query(
    `INSERT INTO tenant_ui_config (fk_tenant_id, enabled_features) VALUES ($1, $2::jsonb)
     ON CONFLICT (fk_tenant_id) DO UPDATE SET enabled_features = $2::jsonb`,
    [tenantId, JSON.stringify(features)]
  );
}

export async function upsertTenantSettingsOnUpdate(client, tenantId, features) {
  await client.query(
    `INSERT INTO tenant_settings (fk_tenant_id, primary_color, custom_features, email_notifications) VALUES ($1, '#6366f1', $2::jsonb, true)
     ON CONFLICT (fk_tenant_id) DO UPDATE SET custom_features = $2::jsonb`,
    [tenantId, JSON.stringify(features)]
  );
}

export async function countCustomersForTenant(tenantId) {
  const result = await pool.query(
    'SELECT COUNT(*) FROM public.frs_customer WHERE fk_tenant_id = $1',
    [tenantId]
  );
  return parseInt(result.rows[0].count, 10);
}

export async function getRealmSlugForTenant(tenantId) {
  const result = await pool.query(
    'SELECT realm_slug FROM public.tenant_realm WHERE fk_tenant_id = $1',
    [tenantId]
  );
  return result.rows[0]?.realm_slug ?? null;
}

/**
 * Full cascading delete of a tenant and every dependent row, in the exact
 * order the original inline route performed it (FK-dependency order matters —
 * reordering these risks FK-violation errors or orphaned rows). Runs inside
 * the caller's transaction (client must already be in a BEGIN).
 */
export async function deleteTenantCascade(client, id) {
  await client.query("SET LOCAL app.bypass_rls = 'true'");

  const tenantUsersRes = await client.query(
    `SELECT DISTINCT fk_user_id AS user_id
       FROM public.frs_tenant_user_map
      WHERE fk_tenant_id = $1`,
    [id]
  );
  const tenantUserIds = tenantUsersRes.rows.map(r => r.user_id);

  // 1. PURGE AUDIT LOG FIRST — it has FK refs to frs_customer, frs_site, frs_unit, frs_user
  //    This MUST happen before any parent table rows are deleted.
  await client.query('SELECT purge_audit_log_for_tenant($1)', [id]);
  await client.query(`UPDATE public.audit_log SET customer_id = NULL, site_id = NULL, unit_id = NULL, fk_user_id = NULL WHERE tenant_id = $1`, [id]).catch(() => {});

  // PRE-FLIGHT: NULL OUT created_by / granted_by / added_by NULLABLE FK COLS
  await client.query(`
    UPDATE public.frs_site SET created_by_user_id = NULL
    WHERE fk_customer_id IN (SELECT pk_customer_id FROM public.frs_customer WHERE fk_tenant_id = $1)
  `, [id]).catch(() => {});
  await client.query(`UPDATE public.frs_group SET created_by = NULL WHERE fk_tenant_id = $1`, [id]).catch(() => {});
  await client.query(`UPDATE public.group_role_map SET granted_by = NULL WHERE fk_group_id IN (SELECT pk_group_id FROM public.frs_group WHERE fk_tenant_id = $1)`, [id]).catch(() => {});
  if (tenantUserIds.length > 0) {
    await client.query(`UPDATE public.user_role SET granted_by = NULL, fk_site_id = NULL WHERE fk_user_id = ANY($1::bigint[])`, [tenantUserIds]).catch(() => {});
    await client.query(`UPDATE public.user_group_map SET added_by = NULL WHERE fk_user_id = ANY($1::bigint[])`, [tenantUserIds]).catch(() => {});
  }
  await client.query(`UPDATE public.hr_roster SET created_by = NULL WHERE tenant_id = $1`, [id]).catch(() => {});
  await client.query(`UPDATE public.device_activation_code SET created_by = NULL WHERE fk_tenant_id = $1`, [id]).catch(() => {});
  await client.query(`UPDATE public.enrollment_invitations SET approved_by = NULL WHERE mt_tenant_id = $1::uuid`, [id]).catch(() => {});
  await client.query(`UPDATE public.frs_confidence_review SET reviewer_id = NULL WHERE tenant_id = $1`, [id]).catch(() => {});
  await client.query(`UPDATE public.frs_confidence_threshold SET updated_by = NULL WHERE tenant_id = $1`, [id]).catch(() => {});
  await client.query(`UPDATE public.gdpr_erasure_requests SET requested_by = NULL WHERE tenant_id = $1`, [id]).catch(() => {});
  await client.query(`UPDATE public.frs_watchlist SET created_by = NULL WHERE tenant_id = $1`, [id]).catch(() => {});
  await client.query(`UPDATE public.system_alert SET unit_id = NULL WHERE tenant_id = $1`, [id]).catch(() => {});

  // 2. PURGE DEPENDENT EVENT LOGS, ALERTS, & INCIDENTAL SCHEMAS
  await client.query('DELETE FROM public.frs_user_membership WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM public.enrollment_invitations WHERE mt_tenant_id = $1', [id]);
  await client.query('DELETE FROM public.device_events WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM public.device_heartbeat WHERE device_id IN (SELECT pk_device_id FROM public.facility_device WHERE tenant_id = $1)', [id]);
  await client.query('DELETE FROM public.device_activation_code WHERE fk_tenant_id = $1', [id]);
  await client.query('DELETE FROM public.system_alert WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM public.frs_alert WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM public.frs_incident WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM public.frs_confidence_review WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM public.frs_confidence_threshold WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM public.frs_watchlist WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM public.gdpr_erasure_requests WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM public.ai_drift_snapshots WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM public.report_schedules WHERE tenant_id = $1', [id]);

  // 3. PURGE STUDENT DATA (EDUCATION VERTICAL SCHEMAS)
  await client.query('DELETE FROM public.student_attendance WHERE fk_tenant_id = $1', [id]);
  await client.query('DELETE FROM public.edu_student WHERE fk_tenant_id = $1', [id]);

  // 4. PURGE EMPLOYEE BIOMETRIC EMBEDDINGS & ATTENDANCE DATA (CORPORATE VERTICAL SCHEMAS)
  await client.query(`
    DELETE FROM public.employee_face_embeddings WHERE employee_id IN (
      SELECT pk_employee_id FROM public.hr_employee WHERE tenant_id = $1
    )
  `, [id]);
  await client.query('DELETE FROM public.attendance_record WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM public.hr_roster WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM public.hr_employee WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM public.hr_shift WHERE tenant_id = $1', [id]);
  await client.query('DELETE FROM public.hr_department WHERE tenant_id = $1', [id]);

  // 5. PURGE UNITS, DEVICES, SYSTEM ALERTS (correct FK order)
  await client.query(`UPDATE public.system_alert SET unit_id = NULL WHERE tenant_id = $1`, [id]).catch(() => {});
  await client.query(`
    DELETE FROM public.frs_unit WHERE fk_site_id IN (
      SELECT pk_site_id FROM public.frs_site WHERE fk_customer_id IN (
        SELECT pk_customer_id FROM public.frs_customer WHERE fk_tenant_id = $1
      )
    )
  `, [id]);
  await client.query('DELETE FROM public.system_alert WHERE tenant_id = $1', [id]);
  await client.query(`
    DELETE FROM public.site_device_assignment WHERE site_id IN (
      SELECT pk_site_id FROM public.frs_site WHERE fk_customer_id IN (
        SELECT pk_customer_id FROM public.frs_customer WHERE fk_tenant_id = $1
      )
    )
  `, [id]);
  await client.query('DELETE FROM public.facility_device WHERE tenant_id = $1', [id]);

  // 6. PURGE SITES & CUSTOMERS
  await client.query(`
    UPDATE public.user_role SET fk_site_id = NULL
    WHERE fk_site_id IN (
      SELECT pk_site_id FROM public.frs_site WHERE fk_customer_id IN (
        SELECT pk_customer_id FROM public.frs_customer WHERE fk_tenant_id = $1
      )
    )
  `, [id]).catch(() => {});
  await client.query(`
    DELETE FROM public.group_role_map WHERE fk_site_id IN (
      SELECT pk_site_id FROM public.frs_site WHERE fk_customer_id IN (
        SELECT pk_customer_id FROM public.frs_customer WHERE fk_tenant_id = $1
      )
    )
  `, [id]).catch(() => {});
  await client.query(`
    DELETE FROM public.frs_site WHERE fk_customer_id IN (
      SELECT pk_customer_id FROM public.frs_customer WHERE fk_tenant_id = $1
    )
  `, [id]);
  await client.query(`
    DELETE FROM public.frs_customer_user_map WHERE fk_customer_id IN (
      SELECT pk_customer_id FROM public.frs_customer WHERE fk_tenant_id = $1
    )
  `, [id]);
  await client.query('DELETE FROM public.frs_customer WHERE fk_tenant_id = $1', [id]);

  // 7. PURGE REALM, SETTINGS, GROUPS
  await client.query('DELETE FROM public.tenant_realm          WHERE fk_tenant_id = $1', [id]);
  await client.query('DELETE FROM public.tenant_ui_config      WHERE fk_tenant_id = $1', [id]);
  await client.query('DELETE FROM public.tenant_holidays       WHERE fk_tenant_id = $1', [id]);
  await client.query('DELETE FROM public.tenant_subscriptions  WHERE fk_tenant_id = $1', [id]);
  await client.query('DELETE FROM public.tenant_settings       WHERE fk_tenant_id = $1', [id]);
  await client.query('DELETE FROM public.group_role_map  WHERE fk_group_id IN (SELECT pk_group_id FROM public.frs_group WHERE fk_tenant_id = $1)', [id]);
  await client.query('DELETE FROM public.user_group_map  WHERE fk_group_id IN (SELECT pk_group_id FROM public.frs_group WHERE fk_tenant_id = $1)', [id]);
  await client.query('DELETE FROM public.frs_group              WHERE fk_tenant_id = $1', [id]);

  // Nullify home_tenant_id on the new users relation. In some environments
  // `users` is a VIEW (consolidated onto frs_user) where this UPDATE errors —
  // and a plain .catch() can't undo that: the error aborts the whole Postgres
  // transaction, poisoning every later statement (the symptom: "current
  // transaction is aborted" on the final DELETE). A SAVEPOINT isolates it so a
  // failure here rolls back only this statement and the delete proceeds.
  await client.query('SAVEPOINT sp_users_home');
  try {
    await client.query('UPDATE public.users SET home_tenant_id = NULL WHERE home_tenant_id = $1', [id]);
    await client.query('RELEASE SAVEPOINT sp_users_home');
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT sp_users_home');
  }

  // 8. PURGE USER SESSIONS, INVITES, ROLES, AND TENANT MAPPINGS
  if (tenantUserIds.length > 0) {
    await client.query('DELETE FROM public.auth_session_token WHERE fk_user_id = ANY($1::bigint[])', [tenantUserIds]);
    await client.query('DELETE FROM public.user_invite WHERE fk_user_id = ANY($1::bigint[]) OR invited_by_id = ANY($1::bigint[])', [tenantUserIds]);
    await client.query('DELETE FROM public.user_role WHERE fk_user_id = ANY($1::bigint[])', [tenantUserIds]);
    await client.query('DELETE FROM public.frs_tenant_user_map WHERE fk_user_id = ANY($1::bigint[])', [tenantUserIds]);
    await client.query(
      `DELETE FROM public.frs_user
       WHERE pk_user_id = ANY($1::bigint[])
         AND pk_user_id NOT IN (
           SELECT DISTINCT fk_user_id FROM public.frs_tenant_user_map
         )`,
      [tenantUserIds]
    );
  }

  // 9. DELETE THE TENANT ITSELF
  await client.query('DELETE FROM public.frs_tenant_user_map WHERE fk_tenant_id = $1', [id]);
  const result = await client.query(
    'DELETE FROM public.frs_tenant WHERE pk_tenant_id = $1 RETURNING pk_tenant_id',
    [id]
  );

  if (result.rows.length === 0) {
    return null;
  }

  await client.query('UPDATE public.tenants SET parent_id = NULL, root_id = NULL WHERE pk_tenant_id = $1', [id]);
  await client.query('DELETE FROM public.tenants WHERE pk_tenant_id = $1', [id]);

  return result.rows[0];
}

// ============================================================================
// REALM
// ============================================================================

export async function getRealmByTenantId(tenantId) {
  const { rows } = await pool.query(
    `SELECT pk_realm_id AS id, realm_slug AS slug, realm_name AS "realmName",
            domain, session_timeout_minutes AS "sessionTimeout",
            max_failed_logins AS "maxFailedLogins",
            password_min_length AS "passwordMinLength",
            lockout_duration_minutes AS "lockoutDurationMinutes", created_at AS "createdAt"
     FROM tenant_realm WHERE fk_tenant_id = $1`,
    [tenantId]
  );
  return rows[0] ?? null;
}

// AB#3267: resolve a realm's configured failureFactor (max_failed_logins) by
// its slug — the identifier the login route already has on hand (req.body.realm),
// vs. getRealmByTenantId() above which needs a tenant id we don't have at
// login-failure time. Defaults to 5, mirroring authRepository.getUserMaxFailedLogins().
export async function getMaxFailedLoginsByRealmSlug(realmSlug) {
  const { rows } = await pool.query(
    `SELECT COALESCE(max_failed_logins, 5) AS "maxFailedLogins"
     FROM tenant_realm WHERE realm_slug = $1`,
    [realmSlug]
  );
  return rows[0]?.maxFailedLogins ?? 5;
}

export async function getLockoutDurationByRealmSlug(realmSlug) {
  const { rows } = await pool.query(
    `SELECT COALESCE(lockout_duration_minutes, 15) AS "lockoutDurationMinutes"
     FROM tenant_realm WHERE realm_slug = $1`,
    [realmSlug]
  );
  return rows[0]?.lockoutDurationMinutes ?? 15;
}

export async function getTenantWithRealm(tenantId) {
  const { rows } = await pool.query(
    `SELECT t.tenant_name, tr.realm_slug, tr.realm_name,
            tr.session_timeout_minutes, tr.max_failed_logins, tr.password_min_length,
            tr.lockout_duration_minutes AS "lockoutDurationMinutes"
     FROM frs_tenant t
     LEFT JOIN tenant_realm tr ON tr.fk_tenant_id = t.pk_tenant_id
     WHERE t.pk_tenant_id = $1`,
    [tenantId]
  );
  return rows[0] ?? null;
}

export async function checkRealmSlugClash(base, tenantId) {
  const clash = await pool.query(
    `SELECT 1 FROM tenant_realm WHERE realm_slug = $1 AND fk_tenant_id <> $2
     UNION SELECT 1 FROM tenants WHERE slug = $1 AND pk_tenant_id <> $2 LIMIT 1`,
    [base, tenantId]
  );
  return clash.rows.length > 0;
}

export async function insertTenantRealmRowIfMissing({ tenantId, realmSlug, realmName }) {
  await pool.query(
    `INSERT INTO tenant_realm
       (fk_tenant_id, realm_slug, realm_name, session_timeout_minutes, max_failed_logins, password_min_length)
     VALUES ($1, $2, $3, 480, 5, 8)
     ON CONFLICT (realm_slug) DO NOTHING`,
    [tenantId, realmSlug, realmName]
  );
}

export async function listTenantMappedUsers(tenantId) {
  const { rows } = await pool.query(
    `SELECT u.pk_user_id, u.email, u.username, u.role
     FROM frs_tenant_user_map tum
     JOIN frs_user u ON u.pk_user_id = tum.fk_user_id
     WHERE tum.fk_tenant_id = $1`,
    [tenantId]
  );
  return rows;
}

export async function updateUserKeycloakSub(userId, keycloakUserId) {
  await pool.query('UPDATE frs_user SET keycloak_sub = $1 WHERE pk_user_id = $2', [keycloakUserId, userId]);
}

// ============================================================================
// TENANT ADMIN ASSIGNMENT
// ============================================================================

export async function listTenantAdmins(tenantId) {
  const result = await pool.query(
    `SELECT u.pk_user_id AS id, u.email, u.username, u.role, u.department
     FROM frs_user u
     JOIN user_role ur ON ur.fk_user_id = u.pk_user_id
     JOIN frs_tenant_user_map tum ON tum.fk_user_id = u.pk_user_id
     WHERE tum.fk_tenant_id = $1 AND ur.fk_role_id = 7 AND ur.is_active = true`,
    [tenantId]
  );
  return result.rows;
}

export async function findUserByEmailForAdminAssign(client, email) {
  const result = await client.query('SELECT pk_user_id FROM frs_user WHERE email = $1', [email]);
  return result.rows[0] ?? null;
}

export async function insertPlaceholderTenantAdmin(client, { email, username, passwordHash }) {
  const result = await client.query(
    `INSERT INTO frs_user (email, username, password_hash, role, must_set_password)
     VALUES ($1, $2, $3, 'tenant_admin', true)
     RETURNING pk_user_id`,
    [email, username, passwordHash]
  );
  return result.rows[0].pk_user_id;
}

export async function updateUserRoleToTenantAdmin(client, userId) {
  await client.query('UPDATE frs_user SET role = \'tenant_admin\' WHERE pk_user_id = $1', [userId]);
}

export async function reassignTenantAdminRole(client, userId, grantedBy) {
  await client.query('DELETE FROM user_role WHERE fk_user_id = $1 AND fk_role_id = 7', [userId]);
  await client.query(
    `INSERT INTO user_role (fk_user_id, fk_role_id, fk_site_id, granted_by, is_active)
     VALUES ($1, 7, NULL, $2, true)`,
    [userId, grantedBy]
  );
}

export async function mapUserToTenant(client, userId, tenantId) {
  await client.query(
    `INSERT INTO frs_tenant_user_map (fk_user_id, fk_tenant_id)
     VALUES ($1, $2)
     ON CONFLICT (fk_user_id, fk_tenant_id) DO NOTHING`,
    [userId, tenantId]
  );
}

export async function getRealmSlugForTenantTx(client, tenantId) {
  const realmRes = await client.query('SELECT realm_slug FROM public.tenant_realm WHERE fk_tenant_id = $1 LIMIT 1', [tenantId]);
  return realmRes.rows[0]?.realm_slug ?? null;
}

export async function updateUserKeycloakSubTx(client, userId, keycloakUserId) {
  await client.query('UPDATE frs_user SET keycloak_sub = $1 WHERE pk_user_id = $2', [keycloakUserId, userId]);
}

// ============================================================================
// ORGANIZATIONS BACKFILL
// ============================================================================

export async function listTenantsForBackfill(tenantId) {
  const { rows } = await pool.query(
    `SELECT t.pk_tenant_id, t.tenant_name, tr.realm_slug, tr.realm_name,
            tr.session_timeout_minutes, tr.max_failed_logins, tr.password_min_length,
            tr.lockout_duration_minutes
     FROM frs_tenant t
     LEFT JOIN tenant_realm tr ON tr.fk_tenant_id = t.pk_tenant_id
     WHERE ($1::uuid IS NULL OR t.pk_tenant_id = $1::uuid)
     ORDER BY t.tenant_name`,
    [tenantId]
  );
  return rows;
}

export async function checkRealmSlugClashForBackfill(base, tenantId) {
  const clash = await pool.query(
    `SELECT 1 FROM tenant_realm WHERE realm_slug = $1 AND fk_tenant_id <> $2
     UNION SELECT 1 FROM tenants WHERE slug = $1 AND pk_tenant_id <> $2 LIMIT 1`,
    [base, tenantId]
  );
  return clash.rows.length > 0;
}

export async function insertTenantRealmRowForBackfill({ tenantId, realmSlug, realmName }) {
  await pool.query(
    `INSERT INTO tenant_realm
       (fk_tenant_id, realm_slug, realm_name, session_timeout_minutes, max_failed_logins, password_min_length, lockout_duration_minutes)
     VALUES ($1, $2, $3, 480, 5, 8, 15)
     ON CONFLICT (realm_slug) DO NOTHING`,
    [tenantId, realmSlug, realmName]
  );
}

export async function listSitesForTenantBackfill(tenantId) {
  const { rows } = await pool.query(
    `SELECT s.pk_site_id, s.site_name, s.keycloak_org_id
     FROM frs_site s
     JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
     WHERE c.fk_tenant_id = $1`,
    [tenantId]
  );
  return rows;
}

export async function updateSiteKeycloakOrg(siteId, orgSlug) {
  await pool.query(
    `UPDATE frs_site SET keycloak_org_id = $1, keycloak_org_alias = $1 WHERE pk_site_id = $2`,
    [orgSlug, siteId]
  );
}

export async function listTenantMembersWithKeycloakSub(tenantId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.keycloak_sub
     FROM frs_tenant_user_map tum
     JOIN frs_user u ON u.pk_user_id = tum.fk_user_id
     WHERE tum.fk_tenant_id = $1 AND u.keycloak_sub IS NOT NULL`,
    [tenantId]
  );
  return rows;
}
