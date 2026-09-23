/**
 * multitenant.js — query helpers for the new tenants/scopes/roles/groups model.
 *
 * After migration 060 the `users` shadow table has been consolidated into
 * `frs_user`. All identity lookups now query `frs_user` directly using
 * `keycloak_sub` (for SSO) or `email` (for pre-provisioned users).
 *
 * The legacy tables still in use:
 *   frs_user, frs_tenant_user_map, user_role, frs_user_membership,
 *   tenants, subscription_plans, tenant_subscriptions, tenant_settings,
 *   scopes, rbac_role, role_scope_mapping, groups,
 *   group_role_assignment, user_group_assignment
 *
 * `roles` was unified into `rbac_role` (rbac_role now carries fk_tenant_id,
 * pk_role_id_uuid, is_super_role, is_active, is_default) — nothing in this
 * file reads `roles` anymore.
 */
import { query } from "../db/pool.js";
import { pool } from "../db/pool.js";
import { provisionKeycloakUser } from "./provisionUser.js";
import logger from "../utils/logger.js";

const PLATFORM_ROOT_ID = "00000000-0000-0000-0000-000000000001";

/* ------------------------------------------------------------------ */
/*  Tenants                                                            */
/* ------------------------------------------------------------------ */

/**
 * Fetch a tenant row by UUID. Returns null if not found.
 */
export async function getTenantById(tenantId) {
    if (!tenantId) return null;
    const { rows } = await query(
        `SELECT pk_tenant_id, parent_id, root_id, hierarchy_path, level,
                tenant_kind, vertical, name, slug, status, settings
           FROM tenants
          WHERE pk_tenant_id = $1`,
        [tenantId],
        "get_tenant_by_id"
    );
    return rows[0] || null;
}

/**
 * Walk up the hierarchy_path to find the customer-level (level=1) ancestor.
 * Sites and units inherit their vertical from the root customer.
 */
export async function getRootCustomerFor(tenantId) {
    if (!tenantId) return null;
    const { rows } = await query(
        `SELECT t1.*
           FROM tenants t1
          WHERE t1.level = 1
            AND $1::uuid::text = ANY (string_to_array(trim(BOTH '/' FROM
                (SELECT hierarchy_path FROM tenants WHERE pk_tenant_id = $1)), '/'))
            AND t1.pk_tenant_id::text = ANY (string_to_array(trim(BOTH '/' FROM
                (SELECT hierarchy_path FROM tenants WHERE pk_tenant_id = $1)), '/'))
          LIMIT 1`,
        [tenantId]
    );
    return rows[0] || null;
}

/**
 * Get every tenant_id beneath (or equal to) the given root. Used by query
 * filters so a Customer-level user can see all of their Sites and Units.
 */
export async function getDescendantTenantIds(rootTenantId) {
    if (!rootTenantId) return [];
    const { rows } = await query(
        `WITH root AS (
             SELECT hierarchy_path FROM tenants WHERE pk_tenant_id = $1
         )
         SELECT pk_tenant_id
           FROM tenants
          WHERE hierarchy_path LIKE (SELECT hierarchy_path FROM root) || '%'
            AND status = 'active'`,
        [rootTenantId]
    );
    return rows.map(r => r.pk_tenant_id);
}

/* ------------------------------------------------------------------ */
/*  Users                                                              */
/* ------------------------------------------------------------------ */

/**
 * Look up a user by their SSO provider + external ID (Keycloak sub).
 * After migration 060 this queries frs_user.keycloak_sub directly.
 */
export async function getUserBySSOSub(provider, sub) {
    if (provider !== 'keycloak') return null;  // only keycloak supported
    const { rows } = await query(
        `SELECT pk_user_id, email, username,
                'keycloak'      AS sso_provider,
                keycloak_sub    AS sso_external_id,
                NULL::uuid      AS home_tenant_id,
                is_active,
                NULL::timestamptz AS last_login_at,
                '{}'::jsonb     AS preferences
           FROM frs_user
          WHERE keycloak_sub = $1
            AND is_active = true`,
        [sub],
        "get_user_by_sso_sub"
    );
    return rows[0] || null;
}

/**
 * Look up a user by email.
 * After migration 060 this queries frs_user directly.
 */
export async function getUserByEmail(email) {
    const { rows } = await query(
        `SELECT pk_user_id, email, username,
                'keycloak'      AS sso_provider,
                keycloak_sub    AS sso_external_id,
                NULL::uuid      AS home_tenant_id,
                is_active,
                NULL::timestamptz AS last_login_at,
                '{}'::jsonb     AS preferences
           FROM frs_user
          WHERE LOWER(email) = LOWER($1)
            AND is_active = true`,
        [email]
    );
    return rows[0] || null;
}

/**
 * provisionMtUser — now delegates entirely to provisionKeycloakUser.
 *
 * The old `users` shadow table has been consolidated into `frs_user` (migration 060).
 * This function is kept for backward-compatibility with any callers that have not
 * yet been updated. All callers should migrate to provisionKeycloakUser directly.
 *
 * @deprecated Use provisionKeycloakUser from ./provisionUser.js instead.
 */
export async function provisionMtUser(jwtPayload) {
    logger.warn(
        "[multitenant] provisionMtUser is deprecated — delegating to provisionKeycloakUser"
    );
    return provisionKeycloakUser(jwtPayload);
}

/* ------------------------------------------------------------------ */
/*  Membership + scopes                                                */
/* ------------------------------------------------------------------ */

/**
 * Return every (tenant_id, scope_tenant_id, role_name) the user has via
 * their group memberships. `scope_tenant_id` is the effective tenant the
 * role applies to (group's tenant by default, unless narrowed in
 * group_role_assignment.fk_scope_tenant_id).
 */
export async function getUserMemberships(userId) {
    if (!UUID_RE.test(String(userId))) return [];
    const { rows } = await query(
        `SELECT g.fk_tenant_id      AS group_tenant_id,
                COALESCE(gra.fk_scope_tenant_id, g.fk_tenant_id) AS scope_tenant_id,
                r.pk_role_id_uuid   AS role_id,
                r.role_name         AS role_name,
                r.is_super_role     AS is_super_role,
                t.hierarchy_path    AS scope_hierarchy_path,
                t.vertical          AS scope_vertical,
                t.tenant_kind       AS scope_tenant_kind,
                t.name              AS scope_tenant_name
           FROM user_group_assignment uga
           JOIN groups g                  ON g.pk_group_id = uga.fk_group_id AND g.is_active
           JOIN group_role_assignment gra ON gra.fk_group_id = g.pk_group_id
           JOIN rbac_role r                ON r.pk_role_id_uuid = gra.fk_role_id AND r.is_active
           JOIN tenants t                 ON t.pk_tenant_id = COALESCE(gra.fk_scope_tenant_id, g.fk_tenant_id)
          WHERE uga.fk_user_id = $1`,
        [userId]
    );
    return rows;
}

/**
 * Return the FLAT list of scope codes the user has at a given tenant.
 * Scopes whose `vertical` is set are filtered against the tenant's vertical
 * (corporate users never see students.*, education users never see employees.*).
 *
 * If `tenantId` is null, returns scopes for ALL the user's memberships
 * (used during bootstrap to show what menus are reachable).
 */
export async function getUserScopes(userId, tenantId = null) {
    const params = [userId];
    let tenantFilter = "";
    if (tenantId) {
        params.push(tenantId);
        // Match the requested tenant OR any ancestor whose hierarchy_path is a
        // prefix of the requested tenant's path. Lets a Customer-level role
        // grant scopes when the user navigates to a Site or Unit under it.
        tenantFilter = `
            AND EXISTS (
              SELECT 1 FROM tenants req
               WHERE req.pk_tenant_id = $2
                 AND req.hierarchy_path LIKE t.hierarchy_path || '%'
            )`;
    }

    // user_group_assignment.fk_user_id is UUID; skip the MT group path for legacy bigint users.
    let rows = [];
    if (UUID_RE.test(String(userId))) {
        const result = await query(
            `SELECT DISTINCT s.scope_code, s.menu_name, s.sub_menu, s.action, s.vertical
               FROM user_group_assignment uga
               JOIN groups g                  ON g.pk_group_id = uga.fk_group_id AND g.is_active
               JOIN group_role_assignment gra ON gra.fk_group_id = g.pk_group_id
               JOIN rbac_role r                ON r.pk_role_id_uuid = gra.fk_role_id AND r.is_active
               JOIN tenants t                 ON t.pk_tenant_id = COALESCE(gra.fk_scope_tenant_id, g.fk_tenant_id)
               JOIN role_scope_mapping rsm    ON rsm.fk_role_id_rbac = r.pk_role_id_uuid
               JOIN scopes s                  ON s.pk_scope_id = rsm.fk_scope_id AND s.is_active
              WHERE uga.fk_user_id = $1
                AND (
                  s.vertical IS NULL
                  ${tenantId ? `OR EXISTS (
                    SELECT 1 FROM tenants req
                     WHERE req.pk_tenant_id = $2 AND req.vertical = s.vertical
                  )` : ""}
                )
                ${tenantFilter}`,
            params
        );
        rows = result.rows;
    }
    if (rows.length > 0) return rows;

    // ── Fallback: resolve scopes from the legacy RBAC graph ──────────────────
    // Tenants and users created at runtime are still provisioned only into the
    // legacy tables (frs_user / user_role / user_group_map / frs_group /
    // rbac_role / group_role_map); they have no rows in the MT scope graph, so
    // the query above returns nothing and every requireScope() check fails.
    //
    // Bridge the two id-spaces by email (users.email = frs_user.email — there is
    // no FK), collect the user's legacy role names scoped to this tenant, then
    // reuse the EXISTING MT role_scope_mapping. The system role names line up
    // (tenant_admin / site_admin / hr_manager / viewer), so this yields the same
    // scope set the MT graph would once provisioning is bridged. Vertical
    // filtering is applied identically to the primary query.
    const legacyTenantPredicateGroup = tenantId ? `
              AND EXISTS (
                SELECT 1 FROM tenants gt
                  JOIN tenants req ON req.pk_tenant_id = $2
                 WHERE gt.pk_tenant_id = g.fk_tenant_id
                   AND req.hierarchy_path LIKE gt.hierarchy_path || '%'
              )` : "";
    const legacyTenantPredicateDirect = tenantId ? `
              AND EXISTS (
                SELECT 1 FROM frs_tenant_user_map m
                  JOIN tenants gt  ON gt.pk_tenant_id = m.fk_tenant_id
                  JOIN tenants req ON req.pk_tenant_id = $2
                 WHERE m.fk_user_id = fu.pk_user_id
                   AND req.hierarchy_path LIKE gt.hierarchy_path || '%'
              )` : "";

    // ── Fallback: resolve scopes from the legacy RBAC graph ──────────────────
    // After migration 060, frs_user IS the authoritative user table and its
    // pk_user_id is the same integer used everywhere. We no longer need to
    // bridge via email through the deprecated `users` shadow table.
    const { rows: legacyRows } = await query(
        `WITH legacy_roles AS (
            SELECT DISTINCT rr.role_name
              FROM frs_user fu
              JOIN user_role ur ON ur.fk_user_id = fu.pk_user_id AND ur.is_active
              JOIN rbac_role rr ON rr.pk_role_id = ur.fk_role_id
             WHERE fu.pk_user_id = $1
               ${legacyTenantPredicateDirect}
            UNION
            SELECT DISTINCT rr.role_name
              FROM frs_user fu
              JOIN user_group_map ugm ON ugm.fk_user_id = fu.pk_user_id
              JOIN frs_group g        ON g.pk_group_id = ugm.fk_group_id AND g.is_active
              JOIN group_role_map grm ON grm.fk_group_id = g.pk_group_id
              JOIN rbac_role rr       ON rr.pk_role_id = grm.fk_role_id
             WHERE fu.pk_user_id = $1
               ${legacyTenantPredicateGroup}
         )
         SELECT DISTINCT s.scope_code, s.menu_name, s.sub_menu, s.action, s.vertical
           FROM legacy_roles lr
           JOIN rbac_role r             ON r.role_name = lr.role_name AND r.is_active
           JOIN role_scope_mapping rsm ON rsm.fk_role_id_rbac = r.pk_role_id_uuid
           JOIN scopes s               ON s.pk_scope_id = rsm.fk_scope_id AND s.is_active
          WHERE (
                s.vertical IS NULL
                ${tenantId ? `OR EXISTS (
                  SELECT 1 FROM tenants req
                   WHERE req.pk_tenant_id = $2 AND req.vertical = s.vertical
                )` : ""}
              )`,
        params
    );
    return legacyRows;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True if the user holds any role marked is_super_role (cross-tenant admin).
 * user_group_assignment.fk_user_id is UUID; legacy frs_user.pk_user_id is bigint.
 * Skip the UUID-keyed table for legacy users to avoid a cast error.
 */
export async function isUserSuperAdmin(userId) {
    if (!UUID_RE.test(String(userId))) return false;
    const { rows } = await query(
        `SELECT 1
           FROM user_group_assignment uga
           JOIN group_role_assignment gra ON gra.fk_group_id = uga.fk_group_id
           JOIN rbac_role r                ON r.pk_role_id_uuid = gra.fk_role_id
          WHERE uga.fk_user_id = $1 AND r.is_super_role = true AND r.is_active = true
          LIMIT 1`,
        [userId],
        "is_user_super_admin"
    );
    return rows.length > 0;
}

/* ------------------------------------------------------------------ */
/*  Subscriptions + Features                                           */
/* ------------------------------------------------------------------ */

/**
 * Resolve the effective feature set for a tenant by combining:
 *   plan.features  ∪  tenant_subscriptions.custom_features
 *                  −  tenant_subscriptions.disabled_features
 *                  −  tenant_settings.disabled_features
 *                  ∪  tenant_settings.custom_features
 *
 * Walks to the root customer if the given tenant is a site/unit (those
 * inherit features from their parent customer's subscription).
 */
export async function featuresForTenant(tenantId) {
    if (!tenantId) return [];

    const { rows } = await query(
        `WITH target AS (
             SELECT pk_tenant_id, hierarchy_path FROM tenants WHERE pk_tenant_id = $1
         ),
         customer_anc AS (
             SELECT t.pk_tenant_id
               FROM tenants t, target
              WHERE t.level = 1
                AND target.hierarchy_path LIKE t.hierarchy_path || '%'
              LIMIT 1
         )
         SELECT p.features            AS plan_features,
                s.custom_features     AS sub_custom,
                s.disabled_features   AS sub_disabled,
                ts.custom_features    AS settings_custom,
                ts.disabled_features  AS settings_disabled,
                uic.enabled_features  AS ui_config_features
           FROM customer_anc ca
           LEFT JOIN tenant_subscriptions s ON s.fk_tenant_id = ca.pk_tenant_id AND s.status = 'active'
           LEFT JOIN subscription_plans p   ON p.pk_plan_id = s.fk_plan_id
           LEFT JOIN tenant_settings ts     ON ts.fk_tenant_id = ca.pk_tenant_id
           -- tenant_ui_config.enabled_features is the one feature list with an
           -- actual working save button today (TenantUiSettings.tsx's PATCH
           -- /tenant-admin/ui-config) — tenant_settings.custom_features above
           -- has no UI/API writer anywhere in the app, so without this join a
           -- tenant admin toggling a feature in Settings would never actually
           -- change what hasFeature() returns.
           LEFT JOIN tenant_ui_config uic   ON uic.fk_tenant_id = ca.pk_tenant_id`,
        [tenantId],
        "features_for_tenant"
    );

    if (!rows.length) return [];
    const r = rows[0];

    const set = new Set([
        ...(r.plan_features       || []),
        ...(r.sub_custom          || []),
        ...(r.settings_custom     || []),
        ...(r.ui_config_features  || []),
    ]);
    for (const f of (r.sub_disabled      || [])) set.delete(f);
    for (const f of (r.settings_disabled || [])) set.delete(f);
    return [...set];
}

/**
 * Returns plan + quota info for a tenant. Used by the bootstrap response and
 * by quota-enforcing routes once Phase 4 is in place.
 */
export async function getSubscriptionForTenant(tenantId) {
    if (!tenantId) return null;
    const { rows } = await query(
        `SELECT s.pk_subscription_id, s.status, s.starts_at, s.ends_at, s.auto_renew,
                s.current_users, s.current_sites, s.current_devices, s.current_employees,
                p.name AS plan_name, p.plan_type, p.vertical, p.features AS plan_features,
                p.max_users, p.max_sites, p.max_units, p.max_devices, p.max_employees,
                p.data_retention_days, p.api_rate_limit_per_hour
           FROM tenants t
           JOIN tenant_subscriptions s ON s.fk_tenant_id = (
                SELECT pk_tenant_id FROM tenants
                 WHERE level = 1 AND t.hierarchy_path LIKE hierarchy_path || '%'
                 LIMIT 1
           )
           JOIN subscription_plans p ON p.pk_plan_id = s.fk_plan_id
          WHERE t.pk_tenant_id = $1 AND s.status = 'active'`,
        [tenantId]
    );
    return rows[0] || null;
}

export { PLATFORM_ROOT_ID };
