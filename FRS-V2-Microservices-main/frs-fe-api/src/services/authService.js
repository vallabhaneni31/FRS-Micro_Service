import bcrypt from "bcrypt";
import {
  findSessionByRefreshToken,
  findUserByAccessToken,
  findUserByEmail,
  getCatalogForTenantIds,
  getMembershipsByUserId,
  getRbacPermissionsForUser,
  revokeSessionByRefreshToken,
  rotateSessionToken,
  saveSessionToken,
  getUserMaxFailedLogins,
  incrementFailedLoginAttempts,
  lockUserAccount,
  resetFailedLoginAttempts,
} from "../repositories/authRepository.js";
import { generateSessionTokens, hashToken } from "./tokenService.js";
import logger from "../utils/logger.js";

function normalizeUser(userRow) {
  return {
    id: String(userRow.pk_user_id),
    email: userRow.email,
    role: userRow.role,
    name: userRow.username,
    department: userRow.department || undefined,
    createdAt: userRow.created_at,
  };
}

function normalizeMembership(membershipRow) {
  return {
    id: String(membershipRow.pk_membership_id),
    userId: String(membershipRow.fk_user_id),
    role: membershipRow.role,
    permissions: membershipRow.permissions || [],
    scope: {
      tenantId: membershipRow.tenant_id != null ? String(membershipRow.tenant_id) : null,
      customerId: membershipRow.customer_id ? String(membershipRow.customer_id) : undefined,
      siteId: membershipRow.site_id ? String(membershipRow.site_id) : undefined,
      unitId: membershipRow.unit_id ? String(membershipRow.unit_id) : undefined,
    },
  };
}

function normalizeCatalog(catalogRows) {
  return {
    tenants: catalogRows.tenants.map((row) => ({
      id: String(row.pk_tenant_id),
      name: row.tenant_name,
    })),
    customers: catalogRows.customers.map((row) => ({
      id: String(row.pk_customer_id),
      tenantId: String(row.fk_tenant_id),
      name: row.customer_name,
    })),
    sites: catalogRows.sites.map((row) => ({
      id: String(row.pk_site_id),
      customerId: String(row.fk_customer_id),
      name: row.site_name,
      status: row.status,
    })),
    units: catalogRows.units.map((row) => ({
      id: String(row.pk_unit_id),
      siteId: String(row.fk_site_id),
      name: row.unit_name,
    })),
  };
}

async function buildBootstrapForUser(userId) {
  // RBAC tables first; fall back to legacy frs_user_membership for pre-migration users.
  let membershipsRaw = await getRbacPermissionsForUser(userId);
  logger.debug({ count: membershipsRaw?.length || 0 }, '[buildBootstrap] RBAC query returned');

  if (!membershipsRaw || membershipsRaw.length === 0) {
    logger.debug('[authService] No RBAC roles found, falling back to legacy frs_user_membership');
    membershipsRaw = await getMembershipsByUserId(userId);
    logger.debug({ count: membershipsRaw?.length || 0 }, '[buildBootstrap] Legacy query returned');
  }
  const memberships = membershipsRaw.map(normalizeMembership);
  const tenantIds = [...new Set(membershipsRaw.map((row) => row.tenant_id))];
  const catalogRaw = await getCatalogForTenantIds(tenantIds);
  const catalog = normalizeCatalog(catalogRaw);
  return {
    memberships,
    activeScope: memberships[0]?.scope ?? null,
    ...catalog,
  };
}

export async function loginWithEmailPassword(email, password, context) {
  const userRow = await findUserByEmail(email);
  if (!userRow) return null;

  // Check if account is locked
  if (userRow.locked_until && new Date(userRow.locked_until) > new Date()) {
    const remainingMs = new Date(userRow.locked_until).getTime() - Date.now();
    const remainingMins = Math.max(1, Math.ceil(remainingMs / (60 * 1000)));
    throw new Error(`Your account has been temporarily locked due to multiple failed login attempts. Please try again in ${remainingMins} minute(s).`);
  }

  // Check if account is active
  if (userRow.is_active === false) {
    throw new Error("this has been deactivated please contact admin for the activate the account");
  }

  const isMatch = await bcrypt.compare(password, userRow.password_hash);
  if (!isMatch) {
    await incrementFailedLoginAttempts(userRow.pk_user_id);
    const failedAttempts = userRow.failed_login_attempts + 1;
    const maxFailedLogins = await getUserMaxFailedLogins(userRow.pk_user_id);
    
    if (failedAttempts >= maxFailedLogins) {
      const lockedUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes lockout
      await lockUserAccount(userRow.pk_user_id, lockedUntil);
      throw new Error("Your account has been temporarily locked due to multiple failed login attempts. Please try again in 15 minute(s).");
    }
    return null;
  }

  // Reset failed attempts on successful login
  await resetFailedLoginAttempts(userRow.pk_user_id);

  const tokens = generateSessionTokens();
  await saveSessionToken({
    userId: userRow.pk_user_id,
    accessToken: hashToken(tokens.accessToken),
    refreshToken: hashToken(tokens.refreshToken),
    accessExpiresAt: tokens.accessExpiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
    userAgent: context.userAgent,
    ipAddress: context.ipAddress,
  });

  const bootstrap = await buildBootstrapForUser(userRow.pk_user_id);
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    user: normalizeUser(userRow),
    memberships: bootstrap.memberships,
    activeScope: bootstrap.activeScope,
  };
}

export async function bootstrapWithAccessToken(accessToken, context) {
  logger.debug('[authService] bootstrap start');
  const hashed = hashToken(accessToken);
  const userRow = await findUserByAccessToken(hashed);
  if (!userRow) {
    logger.debug('[authService] token not found or expired');
    return null;
  }

  if (!context) {
    logger.warn('[authService] context missing!');
    return null;
  }

  // Only check User-Agent for bootstrap. IPs can legitimately change (proxies, mobile networks)
  // so we only bind on UA to avoid false positives that break legitimate sessions.
  const uaMatch = userRow.user_agent === context.userAgent;

  if (!uaMatch) {
    logger.warn({ userId: userRow.pk_user_id }, '[anomaly] bootstrap intercepted: User-Agent mismatch');
    return null;
  }
  logger.debug('[authService] bootstrap context valid');

  const bootstrap = await buildBootstrapForUser(userRow.pk_user_id);
  return {
    user: normalizeUser(userRow),
    memberships: bootstrap.memberships,
    activeScope: bootstrap.activeScope,
    tenants: bootstrap.tenants,
    customers: bootstrap.customers,
    sites: bootstrap.sites,
    units: bootstrap.units,
  };
}

export async function refreshAccess(refreshToken, context) {
  const hashedRefreshToken = hashToken(refreshToken);
  const session = await findSessionByRefreshToken(hashedRefreshToken);

  if (!session || session.revoked || new Date(session.refresh_expires_at) <= new Date()) {
    return null;
  }

  // NOTE: IP/UA mismatch check removed — causes false positives for legitimate users
  // on dynamic IPs (DHCP, VPN, corporate proxy). Refresh-token rotation (below)
  // already provides replay protection: each refresh invalidates the old token.

  const tokens = generateSessionTokens();
  await rotateSessionToken({
    refreshToken: hashedRefreshToken,
    newAccessToken: hashToken(tokens.accessToken),
    newRefreshToken: hashToken(tokens.refreshToken),
    accessExpiresAt: tokens.accessExpiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
    userAgent: context.userAgent,
    ipAddress: context.ipAddress,
  });

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  };
}

export async function logoutByRefreshToken(refreshToken) {
  if (!refreshToken) return;
  await revokeSessionByRefreshToken(hashToken(refreshToken));
}

