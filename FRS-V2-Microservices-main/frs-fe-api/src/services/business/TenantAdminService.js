import bcrypt from 'bcrypt';
import { randomBytes, createHash } from 'crypto';
import { env } from '../../config/env.js';
import logger from '../../utils/logger.js';
import { sendUserInvite } from '../emailService.js';
import { createOrUpdateKeycloakUser, mapRoleToKeycloakRealmRole } from '../keycloakUserService.js';
import { addUserToOrganization } from '../keycloakProvisioner.js';
import * as repo from '../../repositories/tenantAdminRepository.js';

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

function makeInviteToken() {
  const raw = randomBytes(32).toString('hex');
  const hashed = createHash('sha256').update(raw).digest('hex');
  return { raw, hashed };
}

// ============================================================================
// OVERVIEW
// ============================================================================

export async function getOverviewStats(tenantId) {
  const { sites, customers, users, configRow, tenantRow, zero } = await repo.getOverviewCoreStats(tenantId);

  const rawFeatures = configRow.rows[0]?.enabled_features;
  const features = Array.isArray(rawFeatures) ? rawFeatures
    : typeof rawFeatures === 'string' ? JSON.parse(rawFeatures)
    : [];

  const has = (f) => features.includes(f);

  const { totalEmployees, presentToday, lateToday, enrolledFaces, deviceTotal, deviceOnline, deviceOffline } =
    await repo.getOverviewFeatureStats(tenantId, has, zero);

  const emp = parseInt(totalEmployees.rows[0]?.count ?? 0);
  const pres = parseInt(presentToday.rows[0]?.count ?? 0);
  const late = parseInt(lateToday.rows[0]?.count ?? 0);
  const enr = parseInt(enrolledFaces.rows[0]?.count ?? 0);
  const devT = parseInt(deviceTotal.rows[0]?.count ?? 0);
  const devOn = parseInt(deviceOnline.rows[0]?.count ?? 0);
  const devOf = parseInt(deviceOffline.rows[0]?.count ?? 0);

  return {
    sites: parseInt(sites.rows[0].count),
    customers: parseInt(customers.rows[0].count),
    users: parseInt(users.rows[0].count),
    features,
    tenantTypeName: tenantRow.rows[0]?.typeName ?? null,

    attendance: {
      totalEmployees: emp,
      presentToday: pres,
      absentToday: Math.max(0, emp - pres),
      lateToday: late,
      attendanceRate: emp > 0 ? Math.round((pres / emp) * 100) : 0,
    },

    faceRecognition: {
      totalEmployees: emp,
      enrolled: enr,
      enrollmentRate: emp > 0 ? Math.round((enr / emp) * 100) : 0,
    },

    devices: {
      total: devT,
      online: devOn,
      offline: devOf,
      error: Math.max(0, devT - devOn - devOf),
    },
  };
}

// ============================================================================
// SITES / USERS (read)
// ============================================================================

export async function listSites(tenantId) {
  return repo.listTenantSites(tenantId);
}

export async function listUsers(tenantId) {
  return repo.listTenantUsers(tenantId);
}

// ============================================================================
// CREATE TENANT USER
// ============================================================================

const HR_PERMS = ['employee.read', 'employee.write', 'attendance.read', 'analytics.read'];
const SITE_ADMIN_PERMS = ['employee.read', 'employee.write', 'device.read', 'device.write', 'site.read'];

export async function createTenantUser(client, { tenantId, email, username, roleName, siteId, siteIds, department, actorId, inviterName }) {
  const dup = await repo.findUserByEmail(client, email);
  if (dup) {
    throw new ConflictError('Email already in use');
  }

  if (!username || !username.trim()) {
    throw new ValidationError('Display Name is required.');
  }

  const finalUsername = username.trim();
  const dupUsername = await repo.findUserByUsername(client, tenantId, finalUsername);
  if (dupUsername) {
    throw new ConflictError('This display name is already in use by another user in this tenant.');
  }

  const placeholderHash = await bcrypt.hash(randomBytes(32).toString('hex'), 10);

  const newUser = await repo.insertTenantUser(client, {
    email,
    username: finalUsername,
    passwordHash: placeholderHash,
    roleName,
    department: department ?? null,
  });

  await repo.mapUserToTenant(client, newUser.pk_user_id, tenantId);

  const customerId = await repo.findFirstCustomerForTenant(client, tenantId);

  const parsedSiteIds = Array.isArray(siteIds)
    ? siteIds.map((id) => Number(id)).filter((id) => !isNaN(id))
    : (siteId !== undefined && siteId !== null && siteId !== '' ? [Number(siteId)] : []);

  if (parsedSiteIds.length > 0) {
    const inactiveSites = await repo.findInactiveSites(client, parsedSiteIds);
    if (inactiveSites.length > 0) {
      const inactiveNames = inactiveSites.map((r) => r.site_name).join(', ');
      throw new ValidationError(`Cannot assign users to inactive site(s): ${inactiveNames}`);
    }
  }

  const primarySiteId = parsedSiteIds.length > 0 ? parsedSiteIds[0] : null;

  const membershipRole = roleName === 'site_admin' ? 'site_admin' : 'hr';

  await repo.insertUserMembership(client, {
    userId: newUser.pk_user_id,
    membershipRole,
    tenantId,
    customerId,
    siteId: primarySiteId,
    permissions: membershipRole === 'site_admin' ? SITE_ADMIN_PERMS : HR_PERMS,
  });

  const roleRow = await repo.findRbacRoleByName(client, roleName);
  if (!roleRow) throw new Error(`Role ${roleName} not found`);

  const isSiteScoped = ['site_admin', 'hr_manager', 'hr'].includes(roleName);
  const targetSiteIds = isSiteScoped && parsedSiteIds.length > 0 ? parsedSiteIds : [null];

  for (const sId of targetSiteIds) {
    await repo.insertUserRole(client, { userId: newUser.pk_user_id, roleId: roleRow.pk_role_id, siteId: sId, grantedBy: actorId });
  }

  const tenantName = await repo.getTenantName(client, tenantId);

  let siteName = null;
  if (siteId) {
    siteName = await repo.getSiteName(client, siteId);
  }

  const { raw: rawToken, hashed: hashedToken } = makeInviteToken();
  const roleLabel = roleName === 'site_admin' ? 'Site Admin' : 'HR Manager';
  const ttlHours = Number(process.env.INVITE_TOKEN_TTL_HOURS ?? 72);

  const expiresAt = await repo.insertInvite(client, {
    userId: newUser.pk_user_id,
    hashedToken,
    invitedById: actorId,
    invitedByName: inviterName,
    roleLabel,
    tenantName,
    siteName,
    ttlHours,
  });

  return { newUser, roleName, siteId, tenantName, siteName, rawToken, expiresAt, roleLabel };
}

// ── Post-commit Keycloak sync (non-fatal, mirrors original inline try/catch) ─

export async function syncNewUserToKeycloak({ tenantId, email, username, roleName, siteId, userId }) {
  if (env.authMode !== 'keycloak') return;
  try {
    const realmSlug = await repo.getRealmSlugForTenant(tenantId);

    let orgSlug = null;
    if (siteId) {
      orgSlug = await repo.getSiteKeycloakOrg(siteId);
    } else if (realmSlug) {
      orgSlug = realmSlug;
    }

    const kcUserId = await createOrUpdateKeycloakUser({
      email,
      username: username ?? email.split('@')[0],
      realmRole: mapRoleToKeycloakRealmRole(roleName),
      tenantId,
      realmSlug,
    });

    if (kcUserId) {
      await repo.updateUserKeycloakSub(userId, kcUserId);
      if (realmSlug && orgSlug) {
        await addUserToOrganization({ realmSlug, orgSlug, userId: kcUserId }).catch(() => {});
      }
    }
    logger.info(`[tenant-admin] User ${email} synced to Keycloak (realm ${realmSlug || env.keycloak.realm})`);
  } catch (kcErr) {
    logger.warn(`[tenant-admin] Keycloak sync failed (user still created in DB): ${kcErr.message}`);
  }
}

export function sendInviteEmail({ email, username, inviterName, roleLabel, tenantName, siteName, rawToken, expiresAt }) {
  const appUrl = process.env.APP_URL || 'https://frs.motivitylabs.com';
  const setupLink = `${appUrl}/setup-password/${rawToken}`;
  sendUserInvite({
    toEmail: email,
    toName: username ?? email.split('@')[0],
    invitedByName: inviterName,
    roleName: roleLabel,
    tenantName,
    siteName,
    setupLink,
    expiresAt,
  }).catch((err) => logger.error('[tenant-admin] invite email failed:', err.message));
}

// ============================================================================
// USER -> KEYCLOAK BACKFILL SYNC
// ============================================================================

export async function syncTenantUsers(tenantId, dryRun) {
  const realmSlug = await repo.getRealmSlugForTenant(tenantId);
  const users = await repo.listTenantUsersForSync(tenantId);

  const results = [];
  let synced = 0, failed = 0, skipped = 0;

  for (const u of users) {
    if (dryRun) {
      results.push({ email: u.email, status: u.keycloak_sub ? 'already_linked' : 'would_sync' });
      continue;
    }
    try {
      const kcUserId = await createOrUpdateKeycloakUser({
        email: u.email,
        username: u.username ?? u.email.split('@')[0],
        realmRole: mapRoleToKeycloakRealmRole(u.role),
        tenantId,
        realmSlug,
      });
      if (kcUserId) {
        await repo.updateUserKeycloakSub(u.pk_user_id, kcUserId);
        const orgSlug = u.site_org || (realmSlug ? realmSlug : null);
        if (realmSlug && orgSlug) {
          await addUserToOrganization({ realmSlug, orgSlug, userId: kcUserId }).catch(() => {});
        }
        synced++;
        results.push({ email: u.email, status: 'synced', linked: !u.keycloak_sub });
      } else {
        skipped++;
        results.push({ email: u.email, status: 'skipped' });
      }
    } catch (kcErr) {
      failed++;
      logger.warn(`[tenant-admin] user sync failed for ${u.email}: ${kcErr.message}`);
      results.push({ email: u.email, status: 'failed', error: kcErr.message });
    }
  }

  return {
    dryRun,
    realm: realmSlug || env.keycloak.realm,
    summary: { totalUsers: users.length, synced, skipped, failed },
    results,
  };
}

// ============================================================================
// ANALYTICS
// ============================================================================

export async function getAnalytics(tenantId, fromRaw, toRaw) {
  const from = fromRaw ? new Date(fromRaw) : null;
  const to = toRaw ? new Date(toRaw) : null;

  let dateClause = `ar.attendance_date >= CURRENT_DATE - INTERVAL '30 days'`;
  const params = [tenantId];

  if (from && !isNaN(from.getTime()) && to && !isNaN(to.getTime())) {
    params.push(from, to);
    dateClause = `ar.attendance_date BETWEEN $2 AND $3`;
  }

  const [attendanceLast30, siteActivity] = await Promise.all([
    repo.getAttendanceLast30({ tenantId, dateClause, params }),
    repo.getSiteActivity(tenantId),
  ]);

  return { attendanceLast30, siteActivity };
}

// ============================================================================
// UI CONFIG
// ============================================================================

export async function getUiConfig(tenantId) {
  const config = await repo.getUiConfig(tenantId);
  return config ?? {};
}

export async function updateUiConfig(tenantId, { logoUrl, primaryColor, enabledFeatures, dashboardWidgets }) {
  await repo.upsertUiConfig({
    tenantId,
    logoUrl: logoUrl ?? null,
    primaryColor: primaryColor ?? null,
    enabledFeatures: enabledFeatures ? JSON.stringify(enabledFeatures) : null,
    dashboardWidgets: dashboardWidgets ? JSON.stringify(dashboardWidgets) : null,
  });
}

// ============================================================================
// GROUPS
// ============================================================================

export async function listGroups(tenantId) {
  return repo.listGroups(tenantId);
}

export async function createGroup(client, { tenantId, name, description, roleIds = [], isDefault = false, actorId }) {
  const trimmed = name?.trim();
  const dup = await repo.findGroupByName(client, tenantId, trimmed);
  if (dup) {
    throw new ConflictError('A group with this name already exists');
  }
  const group = await repo.insertGroup(client, {
    name: trimmed,
    description: description ?? null,
    isDefault,
    tenantId,
    createdBy: actorId,
  });
  if (roleIds.length > 0) {
    await repo.insertGroupRoleMap(client, { groupId: group.id, roleIds, grantedBy: actorId });
  }
  return group;
}

export async function updateGroup(client, { tenantId, id, name, description, roleIds, isDefault, actorId }) {
  const group = await repo.updateGroup(client, {
    name: name?.trim() ?? null,
    description: description ?? null,
    isDefault: isDefault ?? null,
    id,
    tenantId,
  });
  if (!group) {
    throw new NotFoundError('Group not found');
  }
  if (Array.isArray(roleIds)) {
    await repo.deleteGroupRoleMap(client, id);
    if (roleIds.length > 0) {
      await repo.insertGroupRoleMap(client, { groupId: id, roleIds, grantedBy: actorId });
    }
  }
  return group;
}

export async function deactivateGroup(id, tenantId) {
  const group = await repo.deactivateGroup(id, tenantId);
  if (!group) {
    throw new NotFoundError('Group not found');
  }
}

// ── Group members ────────────────────────────────────────────────────────────

export async function listGroupMembers(groupId, tenantId) {
  return repo.listGroupMembers(groupId, tenantId);
}

export async function addGroupMember({ groupId, tenantId, userId, actorId }) {
  const inTenant = await repo.isUserInTenant(userId, tenantId);
  if (!inTenant) {
    throw new ValidationError('User is not a member of this tenant');
  }
  await repo.addGroupMember({ userId, groupId, addedBy: actorId });
}

export async function removeGroupMember(groupId, userId) {
  await repo.removeGroupMember(groupId, userId);
}
