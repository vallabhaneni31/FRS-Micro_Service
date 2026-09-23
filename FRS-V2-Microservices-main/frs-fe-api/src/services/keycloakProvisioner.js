import { env } from "../config/env.js";
import logger from "../utils/logger.js";

// Custom login theme applied to every tenant realm. Matches the theme the
// primary `attendance` realm uses; override via env if the theme is renamed.
const KEYCLOAK_LOGIN_THEME = process.env.KEYCLOAK_LOGIN_THEME || "motivity-frs";

// Realm roles seeded into every dedicated realm. Must stay in sync with the
// rbac_role table so a DB role can always be granted in Keycloak.
export const DEFAULT_REALM_ROLES = [
  "super_admin",
  "tenant_admin",
  "site_admin",
  "hr_manager",
  "viewer",
  "device_operator",
];

/**
 * Build a Keycloak realm `smtpServer` config from the app's SMTP_* env vars so
 * password-reset / verify-email messages can be delivered. Keycloak needs an
 * explicit host/port — it does not understand a nodemailer "service" alias —
 * so we resolve Gmail to smtp.gmail.com:587 (STARTTLS) by default.
 * Returns null when no credentials are configured (email left unconfigured).
 */
function buildSmtpServer() {
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;
  if (!user || !password) return null;

  const service = (process.env.SMTP_SERVICE || "gmail").toLowerCase();
  const host = process.env.SMTP_HOST || (service === "gmail" ? "smtp.gmail.com" : undefined);
  if (!host) return null;
  const port = String(process.env.SMTP_PORT || 587);

  return {
    host,
    port,
    from: process.env.SMTP_FROM || user,
    fromDisplayName: process.env.SMTP_FROM_NAME || "FRS",
    replyTo: process.env.SMTP_REPLY_TO || user,
    ssl: port === "465" ? "true" : "false",
    starttls: port === "465" ? "false" : "true",
    auth: "true",
    user,
    password,
  };
}

/**
 * The single source of truth for branding + email applied to EVERY realm.
 * Used by both realm creation and applyRealmBranding() so the theme and SMTP
 * service are identical across all tenants by default.
 */
export function commonRealmSettings() {
  const smtpServer = buildSmtpServer();
  return {
    loginTheme: KEYCLOAK_LOGIN_THEME,
    resetPasswordAllowed: true,
    loginWithEmailAllowed: true,
    ...(smtpServer ? { smtpServer } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom error: thrown when the requested Keycloak realm slug is already taken.
// The route layer catches this and returns 409 with a field-specific message
// instead of letting it surface as a generic 500.
// ─────────────────────────────────────────────────────────────────────────────
export class RealmConflictError extends Error {
  constructor(realmSlug) {
    super(`Realm slug "${realmSlug}" is already taken in Keycloak. Please choose a different slug.`);
    this.name = "RealmConflictError";
    this.field = "realmSlug";
    this.statusCode = 409;
  }
}

// Exported so callers outside this module (e.g. AB#3267's remaining-login-
// attempts lookup in authRoutes.js) can reuse realm-master admin auth instead
// of duplicating this ROPC-against-admin-cli logic.
export async function getKeycloakAdminToken() {
  const adminUser = process.env.KEYCLOAK_ADMIN_USER || "admin";
  const adminPass = process.env.KEYCLOAK_ADMIN_PASSWORD || "admin";

  const response = await fetch(
    `${env.keycloak.url}/realms/master/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username: adminUser,
        password: adminPass,
      }),
    }
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Failed Keycloak Master authentication (${response.status}): ${detail}`);
  }

  const data = await response.json();
  return data.access_token;
}

/**
 * Returns true if a realm with the given slug already exists in Keycloak.
 * Requires a valid admin token.
 */
async function realmExistsInKeycloak(token, realmSlug) {
  const response = await fetch(`${env.keycloak.url}/admin/realms/${encodeURIComponent(realmSlug)}`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${token}` },
  });
  return response.status === 200;
}

export async function provisionDedicatedRealm({ realmSlug, realmName, preflightOnly = false, sessionTimeoutMinutes, maxFailedLogins, passwordMinLength, lockoutDurationMinutes }) {
  logger.info(`[KeycloakProvisioner] ${preflightOnly ? 'Pre-flight checking' : 'Starting provisioning for'} realm slug: ${realmSlug}`);
  const token = await getKeycloakAdminToken();

  // ── Existence check ──────────────────────────────────────────────────────────
  // Always performed. In preflightOnly mode we stop here after checking.
  const alreadyExists = await realmExistsInKeycloak(token, realmSlug);
  if (alreadyExists) {
    logger.warn(`[KeycloakProvisioner] Realm ${realmSlug} already exists in Keycloak — raising RealmConflictError`);
    throw new RealmConflictError(realmSlug);
  }

  // Pre-flight mode: just checking — do not create anything
  if (preflightOnly) {
    logger.info(`[KeycloakProvisioner] Pre-flight passed for realm ${realmSlug} — slug is available`);
    return true;
  }

  // 1. Create Realm — including the COMMON branding (login theme) and email
  //    config so tenants never fall back to the default Keycloak theme and
  //    password-reset mail works out of the box.
  const common = commonRealmSettings();
  const realmBody = {
    id: realmSlug,
    realm: realmSlug,
    displayName: realmName,
    enabled: true,
    organizationsEnabled: true,
    ...common,
  };

  // Apply per-tenant security policy when the caller supplies it, so the realm
  // actually enforces session/lockout/password rules instead of leaving the DB
  // values cosmetic. Omitted values fall back to Keycloak defaults.
  if (Number.isFinite(sessionTimeoutMinutes)) {
    const secs = Math.round(sessionTimeoutMinutes * 60);
    realmBody.ssoSessionIdleTimeout = secs;
    realmBody.ssoSessionMaxLifespan = secs;
  }
  if (Number.isFinite(maxFailedLogins)) {
    const lockoutSecs = Number.isFinite(lockoutDurationMinutes) ? Math.round(lockoutDurationMinutes * 60) : 900;
    realmBody.bruteForceProtected = true;
    realmBody.failureFactor = maxFailedLogins;
    realmBody.waitIncrementSeconds = lockoutSecs;
    realmBody.maxFailureWaitSeconds = lockoutSecs;
  }
  if (Number.isFinite(passwordMinLength)) {
    realmBody.passwordPolicy = `length(${passwordMinLength})`;
  }
  if (!common.smtpServer) {
    logger.warn(`[KeycloakProvisioner] SMTP_USER/PASSWORD not set — realm ${realmSlug} created without email; password reset will not send.`);
  }
  const realmResponse = await fetch(`${env.keycloak.url}/admin/realms`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(realmBody),
  });

  if (![201, 204].includes(realmResponse.status)) {
    const detail = await realmResponse.text().catch(() => "");
    // Race condition: another process created it between our check and create — still a conflict
    if (realmResponse.status === 409) {
      logger.warn(`[KeycloakProvisioner] Realm ${realmSlug} created concurrently — raising RealmConflictError`);
      throw new RealmConflictError(realmSlug);
    }
    throw new Error(`Failed to create realm ${realmSlug} (${realmResponse.status}): ${detail}`);
  }

  // 2. Register frontend client
  const clientResponse = await fetch(`${env.keycloak.url}/admin/realms/${realmSlug}/clients`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      clientId: "attendance-frontend",
      name: "FRS Attendance Frontend",
      enabled: true,
      publicClient: true,
      directAccessGrantsEnabled: true,
      standardFlowEnabled: true,
      redirectUris: ["*"],
      webOrigins: ["*"],
    }),
  });

  if (![201, 204].includes(clientResponse.status) && clientResponse.status !== 409) {
    const detail = await clientResponse.text().catch(() => "");
    throw new Error(`Failed to register frontend client inside realm ${realmSlug} (${clientResponse.status}): ${detail}`);
  }

  // 3. Seed default roles
  await ensureRealmRoles({ realmSlug, token });

  // 4. Guarantee branding + SMTP stuck (idempotent). Some Keycloak versions
  //    ignore a subset of fields on realm-create; a follow-up partial update
  //    ensures every realm ends up with the identical common configuration.
  try {
    await applyRealmBranding({ realmSlug });
  } catch (brandErr) {
    logger.error(`[KeycloakProvisioner] Realm ${realmSlug} created but branding/SMTP apply failed: ${brandErr.message}`);
  }

  logger.info(`[KeycloakProvisioner] Realm ${realmSlug} provisioned successfully with common branding + SMTP.`);
  return true;
}

/**
 * Apply login theme + SMTP + password-reset settings to an EXISTING realm.
 * Keycloak's PUT /admin/realms/{realm} is a partial update, so unrelated realm
 * settings are preserved. Used to backfill realms created before branding/email
 * were wired into provisioning.
 */
export async function applyRealmBranding({ realmSlug }) {
  const token = await getKeycloakAdminToken();
  const update = { realm: realmSlug, ...commonRealmSettings() };

  const response = await fetch(`${env.keycloak.url}/admin/realms/${encodeURIComponent(realmSlug)}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(update),
  });

  if (![200, 204].includes(response.status)) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Failed to apply branding to realm ${realmSlug} (${response.status}): ${detail}`);
  }

  logger.info(`[KeycloakProvisioner] Applied theme '${KEYCLOAK_LOGIN_THEME}' + SMTP to realm ${realmSlug}`);
  return true;
}

/**
 * Push a tenant's security policy (brute-force lockout, session timeout and
 * password policy) to an EXISTING realm. Keycloak's own brute-force
 * protection is the only lockout mechanism that actually runs for
 * Keycloak-backed logins, so this is what enforces the tenant's configured
 * "max failed logins" — see AB#2730. This is the general re-sync entry point
 * for AppAdminService.updateTenant(), so it also re-pushes sessionTimeoutMinutes
 * (ssoSessionIdleTimeout/ssoSessionMaxLifespan) and passwordMinLength
 * (passwordPolicy), mirroring the fields provisionDedicatedRealm() applies at
 * realm-creation time. Keycloak's PUT /admin/realms/{realm} is a partial
 * update, so unrelated realm settings are preserved. Follows the same
 * auth/PUT pattern as applyRealmBranding() above.
 */
export async function applyRealmSecurityPolicy({ realmSlug, sessionTimeoutMinutes, maxFailedLogins, passwordMinLength, lockoutDurationMinutes }) {
  const token = await getKeycloakAdminToken();
  const lockoutSecs = Number.isFinite(lockoutDurationMinutes) ? Math.round(lockoutDurationMinutes * 60) : 900;
  const update = {
    realm: realmSlug,
    bruteForceProtected: true,
    failureFactor: maxFailedLogins,
    waitIncrementSeconds: 900,
    maxFailureWaitSeconds: 900,
  };

  if (Number.isFinite(sessionTimeoutMinutes)) {
    const secs = Math.round(sessionTimeoutMinutes * 60);
    update.ssoSessionIdleTimeout = secs;
    update.ssoSessionMaxLifespan = secs;
  }
  if (Number.isFinite(passwordMinLength)) {
    update.passwordPolicy = `length(${passwordMinLength})`;
  }

  const response = await fetch(`${env.keycloak.url}/admin/realms/${encodeURIComponent(realmSlug)}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(update),
  });

  if (![200, 204].includes(response.status)) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Failed to apply security policy to realm ${realmSlug} (${response.status}): ${detail}`);
  }

  logger.info(`[KeycloakProvisioner] Applied security policy (failureFactor=${maxFailedLogins}, sessionTimeoutMinutes=${sessionTimeoutMinutes}, passwordMinLength=${passwordMinLength}) to realm ${realmSlug}`);
  return true;
}

/**
 * Idempotently ensure DEFAULT_REALM_ROLES all exist in an EXISTING realm.
 * Creation returns 409 when the role already exists, which is treated as
 * success. Used both during fresh provisioning and to backfill realms created
 * before a role was added to the default set (e.g. device_operator).
 * Pass `token` to reuse a caller's admin token; otherwise one is fetched.
 */
export async function ensureRealmRoles({ realmSlug, token }) {
  const adminToken = token || (await getKeycloakAdminToken());
  for (const role of DEFAULT_REALM_ROLES) {
    const roleResponse = await fetch(`${env.keycloak.url}/admin/realms/${realmSlug}/roles`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: role,
        description: `Dedicated ${role} role for ${realmSlug}`,
      }),
    });

    if (![201, 204].includes(roleResponse.status) && roleResponse.status !== 409) {
      const detail = await roleResponse.text().catch(() => "");
      logger.error(`[KeycloakProvisioner] Failed to seed role ${role} in realm ${realmSlug} (${roleResponse.status}): ${detail}`);
    }
  }
}

export async function setDedicatedRealmEnabled({ realmSlug, enabled }) {
  const token = await getKeycloakAdminToken();
  const response = await fetch(`${env.keycloak.url}/admin/realms/${encodeURIComponent(realmSlug)}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ realm: realmSlug, enabled }),
  });

  if (![200, 204].includes(response.status)) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Failed to ${enabled ? 'enable' : 'disable'} realm ${realmSlug} (${response.status}): ${detail}`);
  }

  logger.info(`[KeycloakProvisioner] Realm ${realmSlug} ${enabled ? 'enabled' : 'disabled'} successfully.`);
  return true;
}

export async function deprovisionDedicatedRealm({ realmSlug }) {
  logger.info(`[KeycloakProvisioner] Starting realm deactivation for slug: ${realmSlug}`);
  await setDedicatedRealmEnabled({ realmSlug, enabled: false });
  return true;
}

/**
 * HARD-delete a dedicated realm (removes the realm with its users and orgs).
 * Used as a compensation step when tenant creation fails AFTER the realm was
 * provisioned, so a failed creation never leaves an orphaned realm behind.
 * A 404 is treated as success (already gone).
 */
export async function deleteDedicatedRealm({ realmSlug }) {
  const token = await getKeycloakAdminToken();
  const response = await fetch(`${env.keycloak.url}/admin/realms/${encodeURIComponent(realmSlug)}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${token}` },
  });

  if (![200, 204, 404].includes(response.status)) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Failed to delete realm ${realmSlug} (${response.status}): ${detail}`);
  }

  logger.info(`[KeycloakProvisioner] Realm ${realmSlug} deleted (compensation/cleanup).`);
  return true;
}

/**
 * Provisions a new Keycloak organization under the specified realm.
 * Keycloak 26 requires every organization to declare at least one domain, so we
 * pass the caller's domain or derive a stable placeholder from the org slug.
 */
export async function createKeycloakOrganization({ realmSlug, orgSlug, orgName, domain }) {
  logger.info(`[KeycloakProvisioner] Creating organization "${orgName}" (${orgSlug}) inside realm "${realmSlug}"`);
  const token = await getKeycloakAdminToken();

  const orgDomain = (domain && String(domain).trim()) || `${orgSlug}.local`;
  const response = await fetch(`${env.keycloak.url}/admin/realms/${realmSlug}/organizations`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      alias: orgSlug,
      name: orgName,
      enabled: true,
      domains: [{ name: orgDomain, verified: false }],
    }),
  });

  if (![201, 204].includes(response.status) && response.status !== 409) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Failed to create Keycloak organization ${orgSlug} in realm ${realmSlug} (${response.status}): ${detail}`);
  }

  logger.info(`[KeycloakProvisioner] Keycloak organization ${orgSlug} created or already exists.`);
  return true;
}

/**
 * Resolve a Keycloak organization's internal id (UUID) from its alias/slug.
 * Keycloak 26's members endpoint is keyed on the org id, not the alias.
 * Returns null when no organization matches.
 */
async function resolveOrganizationId({ realmSlug, orgSlug, token }) {
  const authToken = token || await getKeycloakAdminToken();
  const response = await fetch(
    `${env.keycloak.url}/admin/realms/${realmSlug}/organizations?search=${encodeURIComponent(orgSlug)}`,
    { headers: { "Authorization": `Bearer ${authToken}` } }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Failed to look up organization ${orgSlug} in realm ${realmSlug} (${response.status}): ${detail}`);
  }
  const orgs = await response.json();
  const match = (orgs || []).find((o) => o.alias === orgSlug) || (orgs || [])[0] || null;
  return match?.id ?? null;
}

/**
 * Associates a user with a specific organization in the specified realm.
 * Keycloak 26 requires the org id (UUID) in the path and the user id as a raw
 * string body, so we resolve the id from the alias first.
 */
export async function addUserToOrganization({ realmSlug, orgSlug, userId }) {
  logger.info(`[KeycloakProvisioner] Adding user ${userId} to organization ${orgSlug} in realm ${realmSlug}`);
  const token = await getKeycloakAdminToken();

  let orgId = await resolveOrganizationId({ realmSlug, orgSlug, token });
  if (!orgId) {
    logger.warn(`[KeycloakProvisioner] Organization ${orgSlug} not found in realm ${realmSlug}. Attempting to auto-create it.`);
    try {
      await createKeycloakOrganization({ realmSlug, orgSlug, orgName: orgSlug });
      orgId = await resolveOrganizationId({ realmSlug, orgSlug, token });
    } catch (createErr) {
      logger.error(`[KeycloakProvisioner] Failed to auto-create organization ${orgSlug}:`, createErr);
    }
  }

  if (!orgId) {
    throw new Error(`Organization ${orgSlug} not found in realm ${realmSlug}`);
  }

  const response = await fetch(`${env.keycloak.url}/admin/realms/${realmSlug}/organizations/${orgId}/members`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    // Keycloak 26 expects the bare user id as the request body, not an object.
    body: userId,
  });

  if (![201, 204].includes(response.status) && response.status !== 409) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Failed to add user ${userId} to organization ${orgSlug} in realm ${realmSlug} (${response.status}): ${detail}`);
  }

  logger.info(`[KeycloakProvisioner] User ${userId} successfully added to organization ${orgSlug}.`);
  return true;
}

