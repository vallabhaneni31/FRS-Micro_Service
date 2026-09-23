import bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { pool } from '../../db/pool.js';
import { env } from '../../config/env.js';
import logger from '../../utils/logger.js';
import { sendUserInvite, sendAccountDeletionNotification } from '../emailService.js';
import { validatePasswordComplexity } from '../../utils/validatePassword.js';
import {
  createOrUpdateKeycloakUser,
  mapRoleToKeycloakRealmRole,
  getAllKeycloakUsers,
  setKeycloakUserEnabled,
  deleteKeycloakUser,
} from '../keycloakUserService.js';
import { addUserToOrganization } from '../keycloakProvisioner.js';
import * as repo from '../../repositories/userRepository.js';
import { invalidateAuthCacheBySub } from '../authCache.js';

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.statusCode = 409;
  }
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.statusCode = 404;
  }
}

export class UpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpstreamError';
    this.statusCode = 502;
  }
}

function makeInviteToken() {
  const raw = randomBytes(32).toString('hex');
  const hashed = createHash('sha256').update(raw).digest('hex');
  return { raw, hashed };
}

// Map UI role to rbac_role.role_name (the RBAC table used by requireAuth + manifest)
export const ROLE_TO_RBAC = {
  admin: 'tenant_admin',
  hr: 'hr_manager',
  hr_manager: 'hr_manager',
  super_admin: 'super_admin',
  tenant_admin: 'tenant_admin',
  site_admin: 'site_admin',
  viewer: 'viewer',
  device_operator: 'device_operator',
};

// Map UI role to a value accepted by frs_user_membership role CHECK constraint
export const ROLE_TO_MEMBERSHIP = {
  admin: 'admin',
  hr: 'hr',
  hr_manager: 'hr_manager',
  super_admin: 'super_admin',
  tenant_admin: 'admin',
  site_admin: 'site_admin',
  viewer: 'viewer',
  device_operator: 'device_operator',
};

const ADMIN_PERMS = [
  'users.read', 'users.manage', 'devices.read', 'devices.manage',
  'attendance.read', 'attendance.manage', 'analytics.read',
  'audit.read', 'facility.read', 'facility.manage', 'aiinsights.read',
];
const HR_PERMS = [
  'users.read', 'attendance.read', 'attendance.manage',
  'analytics.read', 'devices.read', 'facility.read', 'aiinsights.read',
];

export { validatePasswordComplexity };

// ============================================================================
// LIST
// ============================================================================

export async function listUsers({ tenantId, isSuperAdminFlag, role, siteId }) {
  if (isSuperAdminFlag) {
    return repo.listUsersSuperAdmin();
  }
  // A non-super-admin caller with no resolvable tenantId (e.g. JWT missing its
  // tenant_id claim) must never fall through to the cross-tenant listing below
  // — fail closed instead of leaking every tenant's admin users.
  if (!tenantId) {
    return [];
  }
  if ((role === 'site_admin' || role === 'hr_manager') && siteId) {
    return repo.listUsersSiteScoped(tenantId, siteId);
  }
  return repo.listUsersTenantScoped(tenantId);
}

export async function assertUserInTenant(userId, tenantId) {
  // Callers gate this on "caller isn't a verified super admin" — a missing
  // tenantId here means scope couldn't be resolved, not that the caller is a
  // super admin, so deny rather than allowing a global match.
  if (!tenantId) return false;
  return repo.isUserInTenant(userId, tenantId);
}

// ============================================================================
// CREATE
// ============================================================================

export async function emailAlreadyExists(email) {
  return repo.findUserByEmail(pool, email);
}

export async function createUser(client, { email, username, role, department, reqSiteId, reqSiteIds, callerTenantId }) {
  if (!username || !username.trim()) {
    throw new ValidationError('Display Name is required.');
  }
  const finalUsername = username.trim();
  if (callerTenantId) {
    const dupUsername = await repo.findUserByUsername(client, callerTenantId, finalUsername);
    if (dupUsername) {
      throw new ConflictError('This display name is already in use by another user in this tenant.');
    }
  }

  const useInviteFlow = true;
  const hash = await bcrypt.hash(randomBytes(32).toString('hex'), 10);

  const user = await repo.insertUser(client, { email, username: finalUsername, role, hash, department, useInviteFlow });

  const [customerId, fallbackSiteId] = await Promise.all([
    repo.findCustomerForTenant(client, callerTenantId),
    repo.findSiteForTenant(client, callerTenantId),
  ]);
  const tenantId = callerTenantId || null;

  const siteIds = Array.isArray(reqSiteIds)
    ? reqSiteIds.map((id) => Number(id)).filter((id) => !isNaN(id))
    : (reqSiteId !== undefined && reqSiteId !== null && reqSiteId !== '' ? [Number(reqSiteId)] : []);

  const siteId = siteIds.length > 0 ? siteIds[0] : fallbackSiteId;

  if (tenantId) {
    const membershipRole = ROLE_TO_MEMBERSHIP[role] || 'hr';
    await repo.insertUserMembership(client, {
      userId: user.pk_user_id,
      membershipRole,
      tenantId,
      customerId,
      siteId,
      permissions: ['admin', 'super_admin', 'tenant_admin'].includes(role) ? ADMIN_PERMS : HR_PERMS,
    });
    await repo.mapUserToTenant(client, user.pk_user_id, tenantId);
  }

  const rbacRoleName = ROLE_TO_RBAC[role] || 'hr_manager';
  const rbacRoleRow = await repo.findRbacRoleByName(client, rbacRoleName);
  if (rbacRoleRow) {
    const isSiteScoped = ['site_admin', 'hr_manager', 'viewer', 'device_operator'].includes(rbacRoleName);
    const targetSiteIds = isSiteScoped && siteIds.length > 0 ? siteIds : [null];

    for (const sId of targetSiteIds) {
      await repo.insertUserRoleIfMissing(client, { userId: user.pk_user_id, roleId: rbacRoleRow.pk_role_id, siteId: sId });
    }
    logger.info(`[userRoutes] RBAC role '${rbacRoleName}' assigned to user ${email} for sites: [${targetSiteIds.join(', ')}]`);
  } else {
    logger.warn(`[userRoutes] RBAC role '${rbacRoleName}' not found in rbac_role table`);
  }

  return { user };
}

// ── Post-commit Keycloak sync (non-fatal, mirrors original inline try/catch) ─

export async function syncNewUserToKeycloak({ email, username, role, callerTenantId, reqSiteId, userId }) {
  if (env.authMode !== 'keycloak') return;
  try {
    // Mirrors the original's post-commit site resolution, which only honors a
    // singular reqSiteId (not reqSiteIds) — falling back to "any site for this
    // tenant" otherwise. This can differ from the siteId used for the
    // in-transaction membership/RBAC assignment when the caller passed
    // siteIds instead of siteId; preserved as-is rather than reconciled.
    const fallbackSiteId = await repo.findSiteForTenant(pool, callerTenantId);
    const tenantId = callerTenantId || null;
    const siteId = reqSiteId !== undefined
      ? (reqSiteId === null || reqSiteId === '' ? null : Number(reqSiteId))
      : fallbackSiteId;

    const realmRole = mapRoleToKeycloakRealmRole(role);

    let orgSlug = null;
    let realmSlug = null;
    if (siteId) {
      const siteDetails = await repo.getSiteKeycloakSyncDetails(siteId);
      orgSlug = siteDetails.keycloak_org_id;
      realmSlug = siteDetails.realm_slug;
    }

    // Transport-only fallback: Transport tenants have no frs_site rows at
    // all (Depots/Buses live in their own separate database), so the
    // site-based lookup above always comes up empty for them — this used
    // to silently fall through to Keycloak's default realm instead of the
    // tenant's own registered one. Resolve directly from tenant_realm by
    // tenantId instead, but ONLY when the site path found nothing AND the
    // tenant is actually transport, so every other vertical's existing
    // site-based resolution (which already works) is completely untouched.
    if (!realmSlug && tenantId) {
      const tenantInfo = await repo.getTenantVerticalAndRealm(tenantId);
      if (tenantInfo.vertical === 'transport' && tenantInfo.realm_slug) {
        realmSlug = tenantInfo.realm_slug;
      }
    }

    const kcUserId = await createOrUpdateKeycloakUser({
      email,
      username,
      realmRole,
      tenantId,
      realmSlug: realmSlug || undefined,
    });

    if (kcUserId) {
      await repo.updateUserKeycloakSub(userId, kcUserId);

      if (realmSlug && orgSlug) {
        await addUserToOrganization({ realmSlug, orgSlug, userId: kcUserId });
      }
    }

    logger.info(`[userRoutes] User ${email} synced to Keycloak in realm ${realmSlug || 'default'}`);
  } catch (kcErr) {
    logger.warn('[userRoutes] Keycloak sync failed (user still created in DB):', kcErr.message);
  }
}

// Resolves the tenant name for the invite — the original route `await`s this
// before proceeding to the audit log / response, unlike the invite-insert and
// email-send below which are genuinely fire-and-forget. Keep that boundary.
export async function resolveTenantNameForInvite(userId) {
  return repo.getTenantNameForUser(userId);
}

export function sendNewUserInviteEmail({ userId, email, username, inviterName, role, invitedById, tenantName }) {
  const appUrl = process.env.APP_URL || 'https://frs.motivitylabs.com';
  const { raw: rawToken, hashed: hashedToken } = makeInviteToken();
  const roleLabel = ROLE_TO_RBAC[role] === 'tenant_admin' ? 'Tenant Admin'
    : ROLE_TO_RBAC[role] === 'site_admin' ? 'Site Admin'
    : ROLE_TO_RBAC[role] === 'hr_manager' ? 'HR Manager'
    : role;

  repo.insertInvite({
    userId,
    hashedToken,
    invitedById,
    invitedByName: inviterName,
    roleLabel,
    tenantName,
  }).then(() => {
    const setupLink = `${appUrl}/setup-password/${rawToken}`;
    return sendUserInvite({
      toEmail: email,
      toName: username,
      invitedByName: inviterName,
      roleName: roleLabel,
      tenantName,
      setupLink,
      expiresAt: new Date(Date.now() + Number(process.env.INVITE_TOKEN_TTL_HOURS ?? 72) * 3600000),
    });
  }).catch((err) => logger.warn('[userRoutes] Invite email failed:', err.message));
}

// ============================================================================
// UPDATE
// ============================================================================

export async function updateUser({ id, username, department, siteId, siteIds, tenantId, role }) {
  if (username && tenantId) {
    const dupUsername = await repo.findUserByUsername(pool, tenantId, username, id);
    if (dupUsername) {
      throw new ConflictError('This display name is already in use by another user in this tenant.');
    }
  }

  if (role && !['admin', 'hr', 'hr_manager', 'super_admin', 'tenant_admin', 'site_admin', 'viewer', 'device_operator'].includes(role)) {
    throw new ValidationError(`role must be one of: admin, hr, hr_manager, super_admin, tenant_admin, site_admin, viewer, device_operator`);
  }

  const user = await repo.updateUserFields({ username, department, role, id });
  if (!user) {
    throw new NotFoundError('User not found');
  }

  if (role && tenantId) {
    const membershipRole = ROLE_TO_MEMBERSHIP[role] || 'hr';
    const permissions = ['admin', 'super_admin', 'tenant_admin'].includes(role) ? ADMIN_PERMS : HR_PERMS;
    await repo.updateUserMembershipRole(id, tenantId, membershipRole, permissions);
  }

  const roleChanged = Boolean(role);
  const siteScopeProvided = siteIds !== undefined || siteId !== undefined;

  let parsedSiteIds;
  if (siteScopeProvided) {
    parsedSiteIds = siteIds !== undefined
      ? (Array.isArray(siteIds) ? siteIds.map((sid) => Number(sid)).filter((sid) => !isNaN(sid)) : [])
      : (siteId !== null && siteId !== '' ? [Number(siteId)] : []);

    if (parsedSiteIds.length > 0) {
      const inactiveSites = await repo.findInactiveSites(parsedSiteIds);
      if (inactiveSites.length > 0) {
        const inactiveNames = inactiveSites.map((r) => r.site_name).join(', ');
        throw new ValidationError(`Cannot assign users to inactive site(s): ${inactiveNames}`);
      }
    }

    await repo.updateMembershipSiteId(id, parsedSiteIds.length > 0 ? parsedSiteIds[0] : null);
  }

  // RBAC user_role sync must run on a role change even when the caller didn't
  // also resend site scoping — this is the table getPrimaryRole() (manifest
  // route) actually reads to decide which dashboard a user lands on, and it's
  // separate from the frs_user.role / frs_user_membership.role columns synced
  // above.
  if (roleChanged || siteScopeProvided) {
    const rbacRoleName = ROLE_TO_RBAC[user.role] || 'hr_manager';
    const roleRow = await repo.findRbacRoleWithScope(rbacRoleName);
    if (roleRow) {
      const isSiteScoped = ['site_admin', 'hr_manager', 'viewer', 'device_operator'].includes(rbacRoleName);

      let targetSiteIds;
      if (siteScopeProvided) {
        targetSiteIds = isSiteScoped && parsedSiteIds.length > 0 ? parsedSiteIds : [null];
      } else if (isSiteScoped) {
        // Role-only change: keep the user's existing site scope rather than
        // requiring the caller to resend siteIds just to change the role.
        const currentSiteIds = await repo.getActiveUserRoleSiteIds(id);
        targetSiteIds = currentSiteIds.length > 0 ? currentSiteIds : [null];
      } else {
        targetSiteIds = [null];
      }

      // Must run before the deletes below, which only touch rows for THIS
      // role id — deactivateOtherUserRoles clears every OTHER role id so a
      // stale, higher-privilege grant (e.g. a leftover tenant_admin row) from
      // an earlier assignment can't keep outranking the new role at login.
      if (roleChanged) {
        await repo.deactivateOtherUserRoles(id, roleRow.pk_role_id);
      }

      if (isSiteScoped) {
        await repo.deleteUserRoleNotInSites(id, roleRow.pk_role_id, targetSiteIds);
      } else {
        await repo.deleteUserRoleAllSiteScoped(id, roleRow.pk_role_id);
      }

      for (const sId of targetSiteIds) {
        await repo.insertUserRoleIfMissing(pool, { userId: id, roleId: roleRow.pk_role_id, siteId: sId });
      }
    }
  }

  if ((roleChanged || siteScopeProvided) && user.keycloak_sub) {
    // Manifest/role resolution is cached by keycloak_sub — invalidate so the
    // new role takes effect immediately instead of waiting on cache TTL.
    invalidateAuthCacheBySub(user.keycloak_sub).catch(() => {});
  }

  if (env.authMode === 'keycloak') {
    try {
      const realmRole = mapRoleToKeycloakRealmRole(user.role);
      await createOrUpdateKeycloakUser({
        email: user.email,
        username: user.username,
        realmRole,
        tenantId,
      });
      logger.info(`[userRoutes] User ${user.email} updated in Keycloak`);
    } catch (kcErr) {
      logger.warn('[userRoutes] Keycloak update failed:', kcErr.message);
    }
  }

  return user;
}

// ============================================================================
// PASSWORD RESET
// ============================================================================

// AB#3270: Admin-triggered "Reset Password" no longer sets a password
// directly. Instead it sends the target user a self-service reset link,
// reusing the exact same user_invite + email mechanism as the "Forgot
// password?" flow (see POST /forgot-password in authRoutes.js). The user's
// password/sessions are only touched once they complete the link via the
// existing /api/auth/invite/:token/setup endpoint — nothing here talks to
// Keycloak or the local password_hash column.
export async function resetPassword({ id }) {
  const user = await repo.findUserForPasswordReset(id);
  if (!user) {
    throw new NotFoundError('User not found');
  }

  if (user.is_active === false) {
    throw new ValidationError('Cannot reset password for a deactivated user.');
  }

  const rawToken = randomBytes(32).toString('hex');
  const hashedToken = createHash('sha256').update(rawToken).digest('hex');

  const ttlHours = Number(process.env.INVITE_TOKEN_TTL_HOURS ?? 72);
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);

  await pool.query(
    `INSERT INTO user_invite
       (fk_user_id, invite_token, invited_by_id, invited_by_name, role_label, tenant_name, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, hashedToken, null, 'FRS Security System', 'Password Reset', null, expiresAt]
  );

  const appUrl = process.env.APP_URL || 'https://frs.motivitylabs.com';
  const setupLink = `${appUrl}/setup-password/${rawToken}`;

  await sendUserInvite({
    toEmail: user.email,
    toName: user.username || user.email,
    invitedByName: 'FRS Security System',
    roleName: 'Password Reset',
    setupLink,
    expiresAt,
  });

  return { user };
}

// ============================================================================
// ACTIVATE / DEACTIVATE
// ============================================================================

export async function deactivateUser(id) {
  const user = await repo.deactivateUser(id);
  if (!user) throw new NotFoundError('User not found');
  await repo.revokeSessions(id);
  // FRS-ARCH-002 A1: don't let a deactivated account keep working off a
  // stale auth cache entry for up to the cache TTL.
  if (user.keycloak_sub) invalidateAuthCacheBySub(user.keycloak_sub).catch(() => {});

  if (env.authMode === 'keycloak' && user.keycloak_sub) {
    try {
      const realmSlug = await repo.findRealmSlugForUser(id);
      await setKeycloakUserEnabled({
        keycloakSub: user.keycloak_sub,
        enabled: false,
        realmSlug,
      });
      logger.info(`[userRoutes] User ${user.email} disabled in Keycloak realm ${realmSlug || 'default'}`);
    } catch (kcErr) {
      logger.error(`[userRoutes] Failed to disable user ${user.email} in Keycloak:`, kcErr.message);
      throw new UpstreamError(`Failed to deactivate user in Keycloak: ${kcErr.message}`);
    }
  }

  return user;
}

export async function activateUser(id) {
  const user = await repo.activateUser(id);
  if (!user) throw new NotFoundError('User not found');
  if (user.keycloak_sub) invalidateAuthCacheBySub(user.keycloak_sub).catch(() => {});

  if (env.authMode === 'keycloak' && user.keycloak_sub) {
    try {
      const realmSlug = await repo.findRealmSlugForUser(id);
      await setKeycloakUserEnabled({
        keycloakSub: user.keycloak_sub,
        enabled: true,
        realmSlug,
      });
      logger.info(`[userRoutes] User ${user.email} enabled in Keycloak realm ${realmSlug || 'default'}`);
    } catch (kcErr) {
      logger.error(`[userRoutes] Failed to enable user ${user.email} in Keycloak:`, kcErr.message);
      throw new UpstreamError(`Failed to activate user in Keycloak: ${kcErr.message}`);
    }
  }

  return user;
}

// ============================================================================
// DELETE
// ============================================================================

export async function deleteUser(id, tenantId = null) {
  const existingUser = await repo.findUserById(id);

  if (tenantId) {
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM frs_tenant_user_map WHERE fk_user_id = $1',
      [id]
    );
    const count = rows[0]?.count ?? 0;
    if (count > 1) {
      await pool.query('DELETE FROM frs_tenant_user_map WHERE fk_user_id = $1 AND fk_tenant_id = $2', [id, tenantId]);
      await pool.query('DELETE FROM frs_user_membership WHERE fk_user_id = $1 AND tenant_id = $2', [id, tenantId]);
      logger.info(`[UserService] Unmapped user ${existingUser?.email} (ID ${id}) from tenant ${tenantId} (${count - 1} other tenant mapping(s) remain)`);

      if (existingUser && existingUser.email) {
        try {
          await sendAccountDeletionNotification({
            toEmail: existingUser.email,
            toName: existingUser.username || existingUser.email,
            roleName: (existingUser.role === 'tenant_admin' || existingUser.role === 'admin') ? 'Tenant Admin' : (existingUser.role || 'User'),
            tenantName: existingUser.tenant_name,
          });
        } catch (emailErr) {
          logger.warn(`[UserService] Failed to send account deletion email notification to ${existingUser.email}:`, emailErr.message);
        }
      }
      return;
    }
  }

  const kcSub = await repo.getKeycloakSubForUser(id);
  const realmSlug = await repo.findRealmSlugForUser(id);
  await repo.cascadeDeleteUser(id);

  if (kcSub && env.authMode === 'keycloak') {
    try {
      await deleteKeycloakUser({ keycloakSub: kcSub, realmSlug });
      logger.info(`[userRoutes] User deleted from Keycloak realm ${realmSlug || 'default'}`);
    } catch (e) {
      logger.warn('[userRoutes] Keycloak delete failed:', e.message);
    }
  }

  if (existingUser && existingUser.email) {
    try {
      await sendAccountDeletionNotification({
        toEmail: existingUser.email,
        toName: existingUser.username || existingUser.email,
        roleName: (existingUser.role === 'tenant_admin' || existingUser.role === 'admin') ? 'Tenant Admin' : (existingUser.role || 'User'),
        tenantName: existingUser.tenant_name,
      });
      logger.info(`[UserService] Account deletion email notification sent to ${existingUser.email}`);
    } catch (emailErr) {
      logger.warn(`[UserService] Failed to send account deletion email notification to ${existingUser.email}:`, emailErr.message);
    }
  }
}

// ============================================================================
// KEYCLOAK SYNC / PRUNE
// ============================================================================

export async function syncKeycloakUsers() {
  const dbUsers = await repo.listKeycloakLinkedUsers(env.keycloak.realm || 'attendance');

  const uniqueRealms = [...new Set(dbUsers.map((u) => u.realm_slug))];

  const activeIdsByRealm = new Map();
  for (const realmSlug of uniqueRealms) {
    try {
      const { users: kcUsers } = await getAllKeycloakUsers({ realmSlug });
      if (Array.isArray(kcUsers)) {
        activeIdsByRealm.set(realmSlug, new Set(kcUsers.map((u) => u.id)));
      } else {
        logger.warn(`[userRoutes] Keycloak listed empty or invalid user array for realm: ${realmSlug}`);
      }
    } catch (e) {
      logger.error(`[userRoutes] Sync: Failed to load users for realm ${realmSlug}:`, e.message);
    }
  }

  let prunedCount = 0;

  for (const dbUser of dbUsers) {
    const activeKcIds = activeIdsByRealm.get(dbUser.realm_slug);
    if (!activeKcIds) continue;

    if (!activeKcIds.has(dbUser.keycloak_sub)) {
      await repo.cascadeDeleteUser(dbUser.pk_user_id);
      prunedCount++;
      logger.info(`[userRoutes] Sync pruned orphaned user: ${dbUser.email} (Realm: ${dbUser.realm_slug}, Keycloak sub: ${dbUser.keycloak_sub})`);
    }
  }

  return prunedCount;
}
