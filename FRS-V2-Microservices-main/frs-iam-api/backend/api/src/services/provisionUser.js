import { pool } from "../db/pool.js";
import { findUserByEmail } from "../repositories/authRepository.js";
import logger from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Role derivation — maps Keycloak realm roles → app role names
// ---------------------------------------------------------------------------
function deriveAppRoles(realmRoles = []) {
    const normalizedRoles = Array.isArray(realmRoles) ? realmRoles : [];
    const realmRole = normalizedRoles.includes("super_admin") || normalizedRoles.includes("superadmin")
        ? "super_admin"
        : normalizedRoles.includes("tenant_admin") || normalizedRoles.includes("admin") || normalizedRoles.includes("tenantadmin")
            ? "tenant_admin"
            : normalizedRoles.includes("site_admin") || normalizedRoles.includes("siteadmin")
                ? "site_admin"
                : normalizedRoles.includes("hr_manager") || normalizedRoles.includes("hrmanager") || normalizedRoles.includes("hr")
                    ? "hr_manager"
                    : "hr_manager";  // safe default

    // rbacRole is the role_name stored in rbac_role table
    const rbacRole = realmRole === "super_admin"  ? "super_admin"
                   : realmRole === "tenant_admin" ? "tenant_admin"
                   : realmRole === "site_admin"   ? "site_admin"
                   : "hr_manager";

    // frsUserRole is the value stored in frs_user.role, which is constrained by
    // frs_user_role_check to: admin | hr | super_admin | site_admin | hr_manager
    // | viewer | device_operator. The Keycloak realm role "tenant_admin" maps to
    // the app's "admin" (the admin↔tenant_admin bridge used elsewhere).
    const frsUserRole = realmRole === "tenant_admin" ? "admin" : realmRole;

    return { realmRole, rbacRole, frsUserRole };
}

// ---------------------------------------------------------------------------
// Admin permissions arrays (used for legacy frs_user_membership rows)
// ---------------------------------------------------------------------------
const ADMIN_PERMS = [
    "users.read", "users.manage", "devices.read", "devices.manage",
    "attendance.read", "attendance.manage", "analytics.read",
    "audit.read", "facility.read", "facility.manage", "aiinsights.read",
];
const HR_PERMS = [
    "users.read", "devices.read",
    "attendance.read", "attendance.manage",
    "analytics.read", "facility.read", "aiinsights.read",
];

// ---------------------------------------------------------------------------
// provisionKeycloakUser
// ---------------------------------------------------------------------------
/**
 * Auto-provision a Keycloak user on first login.
 *
 * This is the SINGLE authoritative provisioning path for Keycloak mode.
 * It atomically writes:
 *   1. frs_user          — identity record (one row per real person)
 *   2. frs_tenant_user_map — which tenants the user belongs to
 *   3. user_role           — RBAC role assignment
 *   4. frs_user_membership — legacy membership row (kept during RBAC migration)
 *
 * Idempotent: re-running with the same sub/email is always safe.
 *
 * @param {object} jwtPayload  - Decoded Keycloak JWT (must have .sub and .email)
 * @returns {object}           - The frs_user row
 */
export async function provisionKeycloakUser(jwtPayload) {
    const email      = jwtPayload.email?.toLowerCase().trim();
    const name       = jwtPayload.name || jwtPayload.preferred_username || email;
    const sub        = jwtPayload.sub;
    const realmRoles = jwtPayload.realm_access?.roles || [];
    const jwtTenantId = jwtPayload.tenant_id ?? null;

    if (!email || !sub) {
        logger.warn("[provisionUser] JWT missing email or sub — cannot provision");
        return null;
    }

    const { realmRole, rbacRole, frsUserRole } = deriveAppRoles(realmRoles);

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // ── 1. Upsert frs_user ───────────────────────────────────────────────
        // First try by keycloak_sub (fastest), then by email (pre-provisioned user)
        let user = null;

        const bySubResult = await client.query(
            `SELECT pk_user_id, email, username, role, department, created_at
             FROM frs_user WHERE keycloak_sub = $1 LIMIT 1`,
            [sub]
        );
        if (bySubResult.rows.length > 0) {
            user = bySubResult.rows[0];
            // Keep role in sync with Keycloak realm roles (DB-constrained value)
            if (user.role !== frsUserRole) {
                await client.query(
                    `UPDATE frs_user SET role = $1 WHERE pk_user_id = $2`,
                    [frsUserRole, user.pk_user_id]
                );
                user.role = frsUserRole;
            }
        } else {
            // Check by email (user was pre-created without a KC sub)
            const byEmailResult = await client.query(
                `SELECT pk_user_id, email, username, role, department, created_at
                 FROM frs_user WHERE LOWER(email) = $1 LIMIT 1`,
                [email]
            );
            if (byEmailResult.rows.length > 0) {
                user = byEmailResult.rows[0];
                // Backfill keycloak_sub and sync role (DB-constrained value)
                await client.query(
                    `UPDATE frs_user
                     SET keycloak_sub = $1, role = $2
                     WHERE pk_user_id = $3`,
                    [sub, frsUserRole, user.pk_user_id]
                );
                user.role = frsUserRole;
            } else {
                // Brand-new user — create the row
                const insertResult = await client.query(
                    `INSERT INTO frs_user
                         (email, username, role, keycloak_sub, fk_user_type_id, password_hash, must_set_password)
                     VALUES ($1, $2, $3, $4, NULL, '', false)
                     RETURNING pk_user_id, email, username, role, department, created_at`,
                    [email, name, frsUserRole, sub]
                );
                user = insertResult.rows[0];
                logger.info({ email, sub }, "[provisionUser] New user provisioned into frs_user");
            }
        }

        const userId = user.pk_user_id;

        // ── 2. Tenant mapping (frs_tenant_user_map) ──────────────────────────
        // Use tenant_id from JWT if present; otherwise skip (super_admin has none).
        // Guard against a JWT that references a tenant not present in this DB
        // (e.g. a realm imported from another environment) — inserting it would
        // violate the FK and 500 the whole login.
        let tenantExists = false;
        if (jwtTenantId) {
            const tRes = await client.query(
                `SELECT 1 FROM frs_tenant WHERE pk_tenant_id = $1::uuid LIMIT 1`,
                [jwtTenantId]
            );
            tenantExists = tRes.rows.length > 0;
            if (tenantExists) {
                await client.query(
                    `INSERT INTO frs_tenant_user_map (fk_user_id, fk_tenant_id)
                     VALUES ($1, $2::uuid)
                     ON CONFLICT (fk_user_id, fk_tenant_id) DO NOTHING`,
                    [userId, jwtTenantId]
                );
            } else {
                logger.warn(`[provisionUser] JWT tenant_id ${jwtTenantId} not found in frs_tenant — skipping tenant map for ${email}`);
            }
        }

        // ── 3. RBAC user_role assignment ─────────────────────────────────────
        // Only assign if the user has NO active role (don't override manually-set roles)
        const hasRole = await client.query(
            `SELECT 1 FROM user_role WHERE fk_user_id = $1 AND is_active = TRUE LIMIT 1`,
            [userId]
        );
        if (hasRole.rows.length === 0) {
            await client.query(
                `INSERT INTO user_role (fk_user_id, fk_role_id, fk_role_id_uuid, fk_site_id, granted_by, is_active)
                 SELECT $1, pk_role_id, pk_role_id_uuid, NULL, NULL, TRUE
                 FROM rbac_role
                 WHERE role_name = $2
                 ON CONFLICT (fk_user_id, fk_role_id) WHERE fk_site_id IS NULL AND is_active = true DO NOTHING`,
                [userId, rbacRole]
            );
        }

        // ── 4. Legacy frs_user_membership (keep during RBAC migration) ────────
        // Only create one if none exists for this user yet.
        const hasMembership = await client.query(
            `SELECT pk_membership_id FROM frs_user_membership WHERE fk_user_id = $1 LIMIT 1`,
            [userId]
        );
        if (hasMembership.rows.length === 0) {
            // Resolve site/customer/tenant scope for the membership row.
            // Prefer JWT tenant_id; fall back to first available site globally
            // (and warn so operators know to add the Protocol Mapper).
            let siteQuery;
            if (jwtTenantId) {
                siteQuery = await client.query(
                    `SELECT s.pk_site_id, s.fk_customer_id, c.fk_tenant_id
                     FROM frs_site s
                     JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
                     WHERE c.fk_tenant_id = $1::uuid
                     ORDER BY s.pk_site_id
                     LIMIT 1`,
                    [jwtTenantId]
                );
            } else {
                logger.warn(
                    "[provisionUser] JWT missing tenant_id — using global first site for legacy membership. " +
                    "Add a Keycloak Protocol Mapper for tenant_id to fix this."
                );
                siteQuery = await client.query(
                    `SELECT s.pk_site_id, s.fk_customer_id, c.fk_tenant_id
                     FROM frs_site s
                     JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
                     ORDER BY s.pk_site_id
                     LIMIT 1`
                );
            }

            if (siteQuery.rows.length > 0) {
                const { pk_site_id, fk_customer_id, fk_tenant_id } = siteQuery.rows[0];
                const permissions = ["super_admin", "tenant_admin", "site_admin"].includes(realmRole)
                    ? ADMIN_PERMS
                    : HR_PERMS;

                const membershipRole = realmRole === "tenant_admin" ? "admin"
                                     : realmRole === "super_admin"  ? "super_admin"
                                     : realmRole;

                await client.query(
                    `INSERT INTO frs_user_membership
                         (fk_user_id, role, tenant_id, customer_id, site_id, permissions)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [userId, membershipRole, fk_tenant_id, fk_customer_id, pk_site_id, permissions]
                );
            }
        }

        await client.query("COMMIT");
        return user;

    } catch (err) {
        await client.query("ROLLBACK");
        logger.error({ err: err.message, email, sub }, "[provisionUser] Provisioning failed — rolled back");
        throw err;
    } finally {
        client.release();
    }
}
