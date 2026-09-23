import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requirePermission } from "../middleware/authz.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { invalidateAuthCacheBySub } from "../services/authCache.js";

const router = express.Router();

router.use(requireAuth);

router.get(
  "/",
  requirePermission("users.read"),
  asyncHandler(async (_req, res) => {
    const [[{ rows: roles }], [{ rows: perms }]] = await Promise.all([
      [await pool.query("SELECT COUNT(*)::int as count FROM rbac_role")],
      [await pool.query("SELECT COUNT(*)::int as count FROM rbac_permission")],
    ]);
    return res.status(200).json({ roles: roles[0].count, permissions: perms[0].count });
  })
);

router.get(
  "/permissions",
  requirePermission("users.read"),
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT pk_permission_id as id, permission_code as code, display_name, description, category
       FROM rbac_permission ORDER BY category, permission_code`
    );
    return res.status(200).json(rows);
  })
);

function getTenantId(req) {
  return req.auth?.scope?.tenantId ?? req.headers['x-tenant-id'] ?? null;
}

async function getEffectiveSiteId(req) {
  let siteId = req.auth?.scope?.siteId ?? req.headers['x-site-id'] ?? req.headers['X-Site-Id'] ?? null;
  if (siteId && siteId !== 'null' && siteId !== 'undefined') {
    return parsePositiveInt(siteId);
  }

  if (req.auth?.memberships && Array.isArray(req.auth.memberships)) {
    const siteMem = req.auth.memberships.find((m) => m.scope?.siteId);
    if (siteMem?.scope?.siteId) {
      return parsePositiveInt(siteMem.scope.siteId);
    }
  }

  // Fallback: check if the logged-in user has a site-scoped role assignment in user_role
  const userId = parsePositiveInt(req.auth?.user?.id);
  if (userId) {
    const { rows } = await pool.query(
      `SELECT ur.fk_site_id
       FROM user_role ur
       JOIN rbac_role rr ON rr.pk_role_id = ur.fk_role_id
       WHERE ur.fk_user_id = $1
         AND ur.is_active = TRUE
         AND ur.fk_site_id IS NOT NULL
       ORDER BY CASE WHEN rr.role_name = 'site_admin' THEN 1 ELSE 2 END
       LIMIT 1`,
      [userId]
    );
    if (rows.length && rows[0].fk_site_id) {
      return parsePositiveInt(rows[0].fk_site_id);
    }
  }

  return null;
}

function parsePositiveInt(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function groupUsersWithAssignments(rows) {
  const users = new Map();

  for (const row of rows) {
    if (!users.has(row.pk_user_id)) {
      users.set(row.pk_user_id, {
        id: row.pk_user_id,
        email: row.email,
        name: row.username,
        legacyRole: row.legacy_role,
        is_active: row.is_active,
        assignments: [],
      });
    }

    if (row.pk_user_role_id) {
      users.get(row.pk_user_id).assignments.push({
        id: row.pk_user_role_id,
        roleName: row.role_name,
        displayName: row.role_display_name,
        scopeType: row.scope_type,
        siteId: row.fk_site_id,
        siteName: row.site_name,
        grantedAt: row.granted_at,
        expiresAt: row.expires_at,
      });
    }
  }

  return Array.from(users.values());
}

router.get(
  "/users",
  requirePermission("users.read"),
  asyncHandler(async (req, res) => {
    const tenantId = getTenantId(req);
    const siteId = await getEffectiveSiteId(req);

    const { rows } = await pool.query(
      `SELECT
         u.pk_user_id, u.email, u.username, u.role AS legacy_role, u.is_active,
         ur.pk_user_role_id, ur.fk_site_id, ur.granted_at, ur.expires_at,
         r.role_name, r.display_name AS role_display_name, r.scope_type,
         s.site_name
       FROM frs_user u
       LEFT JOIN user_role ur
         ON ur.fk_user_id = u.pk_user_id
        AND ur.is_active = TRUE
        AND ($2::bigint IS NULL OR ur.fk_site_id = $2::bigint)
       LEFT JOIN frs_site s
         ON s.pk_site_id = ur.fk_site_id
       LEFT JOIN frs_customer sc
         ON sc.pk_customer_id = s.fk_customer_id
       LEFT JOIN rbac_role r
         ON r.pk_role_id = ur.fk_role_id
       WHERE (
         CAST($1 AS text) IS NULL OR
         (
           EXISTS (
             SELECT 1
             FROM frs_tenant_user_map tum
             WHERE tum.fk_user_id = u.pk_user_id
               AND CAST(tum.fk_tenant_id AS text) = CAST($1 AS text)
           )
           AND (ur.pk_user_role_id IS NULL OR ur.fk_site_id IS NULL OR CAST(sc.fk_tenant_id AS text) = CAST($1 AS text))
         )
       )
       AND (
         $2::bigint IS NULL OR
         EXISTS (
           SELECT 1 FROM user_role ur2 WHERE ur2.fk_user_id = u.pk_user_id AND ur2.fk_site_id = $2::bigint AND ur2.is_active = TRUE
         ) OR
         EXISTS (
            SELECT 1 FROM hr_employee e WHERE LOWER(e.email) = LOWER(u.email) AND ($2::bigint = ANY(e.site_ids))
         )
       )
       ORDER BY u.email, ur.pk_user_role_id`,
      [tenantId, siteId]
    );

    return res.status(200).json(groupUsersWithAssignments(rows));
  })
);

router.get(
  "/roles",
  requirePermission("users.read"),
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT
         r.pk_role_id AS id, r.role_name, r.display_name, r.description, r.scope_type,
         array_agg(p.permission_code ORDER BY p.category, p.permission_code) AS permissions
       FROM rbac_role r
       JOIN rbac_role_permission rp
         ON rp.fk_role_id = r.pk_role_id
       JOIN rbac_permission p
         ON p.pk_permission_id = rp.fk_permission_id
       GROUP BY r.pk_role_id
       ORDER BY r.role_name`
    );

    return res.status(200).json(rows);
  })
);

router.post(
  "/users/:userId/roles",
  requirePermission("users.roles.manage"),
  asyncHandler(async (req, res) => {
    const userId = parsePositiveInt(req.params.userId);
    const siteIds = Array.isArray(req.body.siteIds)
      ? req.body.siteIds.map(parsePositiveInt).filter(Boolean)
      : (req.body.siteId !== undefined && req.body.siteId !== null
        ? [parsePositiveInt(req.body.siteId)].filter(Boolean)
        : []);
    const roleName = typeof req.body.roleName === "string" ? req.body.roleName.trim() : "";
    const tenantId = getTenantId(req);
    const grantedBy = parsePositiveInt(req.auth?.user?.id);

    if (!userId) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

    if (!roleName) {
      return res.status(400).json({ message: "roleName is required" });
    }

    const [{ rows: userRows }, { rows: roleRows }] = await Promise.all([
      pool.query(
        `SELECT pk_user_id, role, keycloak_sub
         FROM frs_user
         WHERE pk_user_id = $1`,
        [userId]
      ),
      pool.query(
        `SELECT pk_role_id, role_name, scope_type
         FROM rbac_role
         WHERE role_name = $1`,
        [roleName]
      ),
    ]);

    if (!userRows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    const callerRole = req.auth?.user?.role;
    const callerMemberships = req.auth?.memberships || [];
    const isCallerTenantOrSuperAdmin =
      ['admin', 'tenant_admin', 'super_admin'].includes(callerRole) ||
      callerMemberships.some(m => ['admin', 'tenant_admin', 'super_admin'].includes(m.role));

    if (!isCallerTenantOrSuperAdmin && ['admin', 'tenant_admin', 'super_admin'].includes(userRows[0]?.role)) {
      return res.status(403).json({ message: "Site Admins cannot modify Tenant Admin or Super Admin user roles" });
    }

    if (!roleRows.length) {
      return res.status(404).json({ message: "Role not found" });
    }

    const role = roleRows[0];

    if (role.scope_type === "global" && siteIds.length > 0) {
      return res.status(400).json({ message: "siteId/siteIds must be empty for super_admin" });
    }

    if (role.scope_type === "site" && siteIds.length === 0) {
      return res.status(400).json({ message: "siteId is required for site_admin" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const targetSites = siteIds.length > 0 ? siteIds : [null];
      const insertedIds = [];
      const skippedIds = [];

      for (const sId of targetSites) {
        if (sId !== null) {
          const { rows: siteRows } = await client.query(
            `SELECT s.pk_site_id
             FROM frs_site s
             JOIN frs_customer c
               ON c.pk_customer_id = s.fk_customer_id
             WHERE s.pk_site_id = $1
               AND c.fk_tenant_id = $2`,
            [sId, tenantId]
          );

          if (!siteRows.length) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: `Site ${sId} not found under this tenant` });
          }
        }

        const { rows: duplicateRows } = await client.query(
          `SELECT pk_user_role_id
           FROM user_role
           WHERE fk_user_id = $1
             AND fk_role_id = $2
             AND is_active = TRUE
             AND (
               ($3::bigint IS NULL AND fk_site_id IS NULL)
               OR fk_site_id = $3::bigint
             )
           LIMIT 1`,
          [userId, role.pk_role_id, sId]
        );

        if (duplicateRows.length) {
          skippedIds.push(sId);
          continue;
        }

        const insertResult = await client.query(
          `INSERT INTO user_role (fk_user_id, fk_role_id, fk_role_id_uuid, fk_site_id, granted_by, is_active)
           SELECT $1, pk_role_id, pk_role_id_uuid, $2, $3, TRUE
           FROM rbac_role
           WHERE role_name = $4
           ON CONFLICT DO NOTHING
           RETURNING pk_user_role_id`,
          [userId, sId, grantedBy, roleName]
        );

        if (insertResult.rows.length) {
          insertedIds.push(insertResult.rows[0].pk_user_role_id);
        }
      }

      if (insertedIds.length === 0 && skippedIds.length > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "Active role assignment(s) already exist" });
      }

      await client.query("COMMIT");
      // FRS-ARCH-002 A1: the auth cache is keyed on keycloak_sub — clear it so
      // this role grant takes effect on the user's very next request instead
      // of waiting out the cache TTL.
      if (insertedIds.length && userRows[0]?.keycloak_sub) {
        invalidateAuthCacheBySub(userRows[0].keycloak_sub).catch(() => {});
      }
      return res.status(201).json({
        success: true,
        userRoleIds: insertedIds,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);

router.delete(
  "/user-roles/:userRoleId",
  requirePermission("users.roles.manage"),
  asyncHandler(async (req, res) => {
    const userRoleId = parsePositiveInt(req.params.userRoleId);
    const tenantId = getTenantId(req);

    if (!userRoleId) {
      return res.status(400).json({ message: "Invalid userRoleId" });
    }

    const existing = await pool.query(
      `SELECT ur.pk_user_role_id, u.role AS legacy_role, u.keycloak_sub
       FROM user_role ur
       JOIN frs_user u ON u.pk_user_id = ur.fk_user_id
       LEFT JOIN frs_site s
         ON s.pk_site_id = ur.fk_site_id
       LEFT JOIN frs_customer c
         ON c.pk_customer_id = s.fk_customer_id
       WHERE ur.pk_user_role_id = $1
         AND (ur.fk_site_id IS NULL OR c.fk_tenant_id = $2)`,
      [userRoleId, tenantId]
    );

    if (!existing.rows.length) {
      return res.status(404).json({ message: "Role assignment not found" });
    }

    const callerRole = req.auth?.user?.role;
    const callerMemberships = req.auth?.memberships || [];
    const isCallerTenantOrSuperAdmin =
      ['admin', 'tenant_admin', 'super_admin'].includes(callerRole) ||
      callerMemberships.some(m => ['admin', 'tenant_admin', 'super_admin'].includes(m.role));

    if (!isCallerTenantOrSuperAdmin && ['admin', 'tenant_admin', 'super_admin'].includes(existing.rows[0]?.legacy_role)) {
      return res.status(403).json({ message: "Site Admins cannot modify Tenant Admin or Super Admin user roles" });
    }

    const result = await pool.query(
      `UPDATE user_role
       SET is_active = FALSE
       WHERE pk_user_role_id = $1
       RETURNING pk_user_role_id`,
      [userRoleId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "Role assignment not found" });
    }

    if (existing.rows[0]?.keycloak_sub) {
      invalidateAuthCacheBySub(existing.rows[0].keycloak_sub).catch(() => {});
    }

    return res.status(200).json({
      success: true,
      revokedId: result.rows[0].pk_user_role_id,
    });
  })
);

router.get(
  "/sites",
  requirePermission("users.read"),
  asyncHandler(async (req, res) => {
    const tenantId = getTenantId(req);
    const siteId = await getEffectiveSiteId(req);

    const { rows } = await pool.query(
      `SELECT
         s.pk_site_id AS id,
         s.site_name AS name
       FROM frs_site s
       JOIN frs_customer c
         ON c.pk_customer_id = s.fk_customer_id
       WHERE c.fk_tenant_id = $1
         AND ($2::bigint IS NULL OR s.pk_site_id = $2::bigint)
       ORDER BY s.site_name`,
      [tenantId, siteId]
    );

    return res.status(200).json(rows);
  })
);

export default router;
