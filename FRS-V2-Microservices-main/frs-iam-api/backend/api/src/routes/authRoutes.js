import express from "express";
import crypto, { createHash } from "crypto";
import { validatePasswordComplexity } from "../utils/validatePassword.js";
import bcrypt from "bcrypt";
import logger from '../utils/logger.js';
import {
  bootstrapWithAccessToken,
  loginWithEmailPassword,
  logoutByRefreshToken,
  refreshAccess,
} from "../services/authService.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { authRateLimiter, accountLoginLimiter, inviteLimiter } from "../middleware/rateLimit.js";
import {
  loginSchema,
  refreshTokenSchema,
  logoutSchema,
  validateBody,
} from "../validators/schemas.js";
import { env } from "../config/env.js";
import { verifyKeycloakToken } from "../middleware/keycloakVerifier.js";
import {
  findUserByKeycloakSub,
  getMembershipsByUserId,
  getCatalogForTenantIds,
  getRbacPermissionsForUser,
  saveSessionToken,
} from "../repositories/authRepository.js";
import { provisionKeycloakUser } from "../services/provisionUser.js";
import { generateSessionTokens, hashToken } from "../services/tokenService.js";
import { createOrUpdateKeycloakUser, mapRoleToKeycloakRealmRole } from "../services/keycloakUserService.js";
import { addUserToOrganization, getKeycloakAdminToken } from "../services/keycloakProvisioner.js";
import { getMaxFailedLoginsByRealmSlug, getLockoutDurationByRealmSlug } from "../repositories/tenantRepository.js";
import { pool } from "../db/pool.js";
import { retailPool } from "../db/retailPool.js";
import { writeAudit } from "../middleware/auditLog.js";

const router = express.Router();

function readBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim();
}

/** S-01: Read token from httpOnly cookie first, then Bearer header (Keycloak/device fallback) */
function readToken(req) {
  // Keycloak mode authenticates via the Bearer JWT. A stale legacy `access_token`
  // cookie (left over from API-mode sessions) must NOT shadow it, or bootstrap
  // verification fails with "Invalid JWT" and returns 401 for a valid session.
  if (env.authMode === "keycloak") return readBearerToken(req) || req.cookies?.access_token || null;
  if (req.cookies?.access_token) return req.cookies.access_token;
  return readBearerToken(req);
}

function getClientContext(req) {
  let ip = req.ip || req.connection?.remoteAddress || "unknown";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return {
    ipAddress: ip,
    userAgent: req.headers["user-agent"] || "unknown",
  };
}

/** S-01: Cookie options for httpOnly session tokens */
const cookieOpts = (maxAgeMs) => ({
  httpOnly: true,
  secure: env.nodeEnv === "production",
  sameSite: "strict",
  path: "/",
  maxAge: maxAgeMs,
});

/** S-01: Set access + refresh tokens as httpOnly cookies */
function setSessionCookies(res, session) {
  res.cookie("access_token",  session.accessToken,  cookieOpts(env.token.accessTokenTtlMinutes * 60 * 1000));
  res.cookie("refresh_token", session.refreshToken, cookieOpts(env.token.refreshTokenTtlDays * 24 * 60 * 60 * 1000));
}

/** S-01: Clear session cookies on logout */
function clearSessionCookies(res) {
  const base = { httpOnly: true, secure: env.nodeEnv === "production", sameSite: "strict", path: "/" };
  res.clearCookie("access_token",  base);
  res.clearCookie("refresh_token", base);
}

/**
 * Forgot-password fallback for retail-vertical accounts that live only in
 * retail_intelligence.retail_users (no frs_user row) — e.g. any account
 * created through the retail invite-accept flow. Reuses the same
 * retail_invitations token mechanism the Owner-initiated invite flow uses;
 * the existing POST /api/v1/retail/invite/:token/accept endpoint already
 * upserts on email, so redeeming this link both resets the Keycloak
 * password and refreshes the retail_users row. Returns true if an email was
 * actually sent (or attempted for a real account), false if there's no
 * matching retail account at all — the caller always responds with the same
 * generic message either way, so this return value never leaks account
 * existence to the client.
 */
async function handleRetailForgotPassword(normalizedEmail) {
  if (!retailPool) return false;
  try {
    const { rows } = await retailPool.query(
      `SELECT id, email, display_name, role, store_id, tenant_id, status
       FROM retail_users WHERE email = $1 LIMIT 1`,
      [normalizedEmail]
    );
    if (!rows.length || rows[0].status === 'inactive') return false;
    const account = rows[0];

    const rawToken = crypto.randomBytes(32).toString('hex');
    const ttlHours = Number(process.env.INVITE_TOKEN_TTL_HOURS ?? 72);
    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);

    await retailPool.query(
      `UPDATE retail_invitations SET status = 'revoked', updated_at = NOW()
       WHERE invitee_email = $1 AND status = 'pending'`,
      [normalizedEmail]
    );
    await retailPool.query(
      `INSERT INTO retail_invitations
         (inviter_id, invitee_email, role, store_id, tenant_id, token, expires_at)
       VALUES (NULL, $1, $2, $3, $4, $5, $6)`,
      [account.email, account.role, account.store_id, account.tenant_id, rawToken, expiresAt]
    );

    const { rows: storeRows } = await retailPool.query(
      `SELECT name FROM stores WHERE id = $1 LIMIT 1`,
      [account.store_id]
    );

    const appUrl = process.env.APP_URL || 'https://frs.motivitylabs.com';
    const setupLink = `${appUrl}/retail-invite/${rawToken}`;

    const { sendUserInvite } = await import("../services/emailService.js");
    await sendUserInvite({
      toEmail: account.email,
      toName: account.display_name || account.email,
      invitedByName: "FRS Security System",
      roleName: "Password Reset",
      storeName: storeRows[0]?.name,
      setupLink,
      expiresAt,
    });
    return true;
  } catch (err) {
    logger.error("[forgot-password] retail fallback failed:", err);
    return false;
  }
}

/* ── Legacy API routes (kept for backward compatibility) ── */
/* NOTE: These routes are disabled when AUTH_MODE=keycloak */

if (env.authMode !== "keycloak") {
  router.post(
    "/login",
    authRateLimiter,
    accountLoginLimiter,
    validateBody(loginSchema),
    asyncHandler(async (req, res) => {
      const { email, password } = req.validatedBody;

      try {
        const session = await loginWithEmailPassword(email, password, getClientContext(req));
        if (!session) {
          await writeAudit({
            req,
            action: 'auth.login_failed',
            details: `Failed login attempt for email: ${email}`,
            entityType: 'user',
            entityName: email,
            source: 'api'
          });
          return res.status(401).json({ message: "Invalid email address or password." });
        }

        // S-02: Check if user has MFA enabled
        const { rows: mfaRows } = await pool.query(
          `SELECT mfa_enabled FROM frs_user WHERE pk_user_id = $1`,
          [session.user.id]
        );
        const mfaEnabled = mfaRows[0]?.mfa_enabled ?? false;

        if (mfaEnabled) {
          // Issue a short-lived MFA challenge token (2 minutes)
          const challengeToken = crypto.randomBytes(32).toString('hex');
          await pool.query(
            `INSERT INTO frs_mfa_challenge (user_id, challenge_token)
             VALUES ($1, $2)`,
            [session.user.id, challengeToken]
          );
          // Do NOT set session cookies yet — MFA must be verified first
          return res.json({ mfaRequired: true, mfaChallengeToken: challengeToken });
        }

        // S-01: Tokens go in httpOnly cookies — never in the response body
        setSessionCookies(res, session);
        const { accessToken, refreshToken, ...publicSession } = session;
        return res.json(publicSession);
      } catch (err) {
        if (err.message === "Account locked due to multiple failed login attempts") {
          return res.status(403).json({ message: "Account locked due to multiple failed login attempts" });
        }
        if (err.message === "this has been deactivated please contact admin for the activate the account") {
          return res.status(403).json({ message: "this has been deactivated please contact admin for the activate the account" });
        }
        throw err;
      }
    })
  );

  router.post(
    "/refresh",
    authRateLimiter,
    asyncHandler(async (req, res) => {
      // S-01: Read refresh token from httpOnly cookie first, body as legacy fallback
      const refreshToken = req.cookies?.refresh_token || req.body?.refreshToken;
      if (!refreshToken) {
        return res.status(401).json({ message: "refresh token required" });
      }
      const refreshed = await refreshAccess(refreshToken, getClientContext(req));
      if (!refreshed) {
        clearSessionCookies(res);
        return res.status(401).json({ message: "invalid refresh token" });
      }
      // S-01: Update access_token cookie; rotate refresh_token if changed
      res.cookie("access_token", refreshed.accessToken, cookieOpts(env.token.accessTokenTtlMinutes * 60 * 1000));
      if (refreshed.refreshToken && refreshed.refreshToken !== refreshToken) {
        res.cookie("refresh_token", refreshed.refreshToken, cookieOpts(env.token.refreshTokenTtlDays * 24 * 60 * 60 * 1000));
      }
      return res.json({ ok: true });
    })
  );

  router.post(
    "/logout",
    asyncHandler(async (req, res) => {
      // S-01: Accept refresh token from cookie or body (backward compat)
      const refreshToken = req.cookies?.refresh_token || req.body?.refreshToken;
      if (refreshToken) {
        await logoutByRefreshToken(refreshToken).catch(() => {});
      }
      clearSessionCookies(res);
      return res.status(204).send();
    })
  );
}

  router.post(
    "/forgot-password",
    authRateLimiter,
    asyncHandler(async (req, res) => {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ message: "Email is required" });
      }

      const normalizedEmail = email.trim().toLowerCase();

      // 1. Find user in the database
      const { rows } = await pool.query(
        "SELECT pk_user_id, email, username, role, is_active FROM frs_user WHERE email = $1",
        [normalizedEmail]
      );

      if (rows.length === 0 || rows[0].is_active === false) {
        // Not a corporate (frs_user) account — check the retail vertical's
        // own user table before giving up. Retail-only accounts (created via
        // the retail invite-accept flow) have no frs_user row at all, so
        // without this fallback every reset attempt silently no-ops behind
        // the generic "success" response below — the account owner sees
        // "reset link sent" but nothing ever arrives, and (as happened in
        // production) retries repeatedly assuming it's broken until they
        // trip authRateLimiter and get locked out entirely.
        const retailHandled = await handleRetailForgotPassword(normalizedEmail);
        if (retailHandled) {
          return res.json({ success: true, message: "Reset link sent." });
        }
        // Return success even if user not found or deactivated to prevent user enumeration
        return res.json({ success: true, message: "If the email exists, a reset link has been sent." });
      }

      const user = rows[0];

      // 2. Generate reset token
      const rawToken = crypto.randomBytes(32).toString('hex');
      const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");

      // 3. Insert invite/reset record
      const ttlHours = Number(process.env.INVITE_TOKEN_TTL_HOURS ?? 72);
      const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
      await pool.query(
        `INSERT INTO user_invite
           (fk_user_id, invite_token, invited_by_id, invited_by_name, role_label, tenant_name, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [user.pk_user_id, hashedToken, null, "FRS Security System", "Password Reset", null, expiresAt]
      );

      // 4. Send reset email
      const appUrl = process.env.APP_URL || 'https://frs.motivitylabs.com';
      const setupLink = `${appUrl}/setup-password/${rawToken}`;

      // Send invite/setup email
      const { sendUserInvite } = await import("../services/emailService.js");
      await sendUserInvite({
        toEmail: user.email,
        toName: user.username || user.email,
        invitedByName: "FRS Security System",
        roleName: "Password Reset",
        setupLink,
        expiresAt,
      });

      return res.json({ success: true, message: "Reset link sent." });
    })
  );


/* ── Bootstrap endpoint — dual mode ── */

router.get("/bootstrap", asyncHandler(async (req, res) => {
  logger.info('[bootstrap] Endpoint called! User:', req.auth?.user?.id || 'unknown');
  // S-01: Read from httpOnly cookie (API mode) or Bearer header (Keycloak mode)
  const accessToken = readToken(req);
  if (!accessToken) {
    return res.status(401).json({ message: "authorization token is required" });
  }

  if (env.authMode === "keycloak") {
    // ── Keycloak mode: verify JWT, find/provision user, load memberships ──
    let jwtPayload;
    try {
      jwtPayload = await verifyKeycloakToken(accessToken);
    } catch (e) {
      logger.error({ err: e.message, code: e.code }, '[bootstrap] Keycloak token verification failed');
      await writeAudit({
        req,
        action: 'auth.login_failed',
        details: `Keycloak token bootstrap failed: ${e.message}`,
        entityType: 'user',
        source: 'api'
      });
      return res.status(401).json({ message: "invalid or expired token", detail: e.message });
    }

    const existingUserResult = await pool.query(
      `SELECT pk_user_id, email, username, role, department, created_at
       FROM frs_user
       WHERE keycloak_sub = $1
       LIMIT 1`,
      [jwtPayload.sub]
    );
    const existingUser = existingUserResult.rows[0] ?? null;

    let user = existingUser;
    if (!user) {
      user = await provisionKeycloakUser(jwtPayload);
    }

    // RBAC tables first; fall back to legacy frs_user_membership for pre-migration users.
    let rawMemberships = await getRbacPermissionsForUser(user.pk_user_id);
    logger.info('[bootstrap/keycloak] RBAC query returned:', rawMemberships?.length || 0, 'rows');
    if (!rawMemberships || rawMemberships.length === 0) {
      logger.info('[bootstrap/keycloak] No RBAC roles found, falling back to legacy');
      rawMemberships = await getMembershipsByUserId(user.pk_user_id);
      logger.info('[bootstrap/keycloak] Legacy query returned:', rawMemberships?.length || 0, 'rows');
    }
    const memberships = rawMemberships.map((row) => ({
      id: String(row.pk_membership_id),
      userId: String(row.fk_user_id),
      role: row.role,
      scope: {
        // null tenant_id = global role (super_admin). Don't stringify it as "null"
        // or downstream UUID casts crash. Keep it as a real null.
        tenantId: row.tenant_id == null ? null : String(row.tenant_id),
        customerId: row.customer_id ? String(row.customer_id) : undefined,
        siteId: row.site_id ? String(row.site_id) : undefined,
        unitId: row.unit_id ? String(row.unit_id) : undefined,
      },
      permissions: row.permissions || [],
    }));

    if (user.role === 'super_admin' && memberships.length === 0) {
      memberships.push({
        id: 'super_admin_temp',
        userId: String(user.pk_user_id),
        role: 'super_admin',
        scope: {
          tenantId: null,
        },
        permissions: ['*'],
      });
    }

    // Catalog query only needs real UUIDs. Filter out null tenantIds before
    // sending to getCatalogForTenantIds, which casts to uuid.
    const tenantIds = [...new Set(
      memberships.map((m) => m.scope.tenantId).filter((id) => id != null)
    )];
    const catalog = tenantIds.length
      ? await getCatalogForTenantIds(tenantIds)
      : { tenants: [], customers: [], sites: [], units: [] };

    // ── Multitenant payload (new model) — feed the SPA the vertical, scope
    //    codes, and resolved plan features so it can render the right UI.
    let mtBundle = null;
    try {
      const { getUserBySSOSub, getUserScopes, isUserSuperAdmin,
              getTenantById, featuresForTenant, getSubscriptionForTenant }
        = await import("../services/multitenant.js");
      const mtUser = await getUserBySSOSub("keycloak", jwtPayload.sub);
      if (mtUser) {
        const isSA = await isUserSuperAdmin(mtUser.pk_user_id);
        const tenantForLookup = isSA ? null : jwtPayload.tenant_id || null;
        const scopeRows = await getUserScopes(mtUser.pk_user_id, tenantForLookup);
        let vertical = null;
        let features = [];
        let plan = null;
        let minPasswordLength = 8;
        if (jwtPayload.tenant_id) {
          const t = await getTenantById(jwtPayload.tenant_id);
          vertical = t?.vertical || null;
          features = await featuresForTenant(jwtPayload.tenant_id);
          plan = await getSubscriptionForTenant(jwtPayload.tenant_id);
          const realmRes = await pool.query('SELECT password_min_length FROM tenant_realm WHERE fk_tenant_id = $1 LIMIT 1', [jwtPayload.tenant_id]);
          if (realmRes.rows[0]?.password_min_length) {
            minPasswordLength = realmRes.rows[0].password_min_length;
          }
        }
        mtBundle = {
          userId: mtUser.pk_user_id,
          homeTenantId: mtUser.home_tenant_id,
          vertical,
          isSuperAdmin: isSA,
          scopeCodes: scopeRows.map(r => r.scope_code),
          scopes: scopeRows,           // full {menu, sub_menu, action} rows for UI
          features,
          minPasswordLength,
          plan: plan ? {
            name: plan.plan_name,
            type: plan.plan_type,
            vertical: plan.vertical,
            limits: {
              maxUsers: plan.max_users,
              maxSites: plan.max_sites,
              maxUnits: plan.max_units,
              maxDevices: plan.max_devices,
              maxEmployees: plan.max_employees,
              dataRetentionDays: plan.data_retention_days,
              apiRateLimitPerHour: plan.api_rate_limit_per_hour,
            },
            usage: {
              users: plan.current_users,
              sites: plan.current_sites,
              devices: plan.current_devices,
              employees: plan.current_employees,
            },
          } : null,
        };
      }
    } catch (err) {
      logger.warn({ err: err.message }, "[bootstrap] multitenant payload failed; legacy response will still ship");
    }

    return res.json({
      user: {
        id: String(user.pk_user_id),
        email: user.email,
        name: user.username,
        role: user.role,
        department: user.department || undefined,
        password: "",
        createdAt: user.created_at,
      },
      memberships,
      activeScope: memberships[0]?.scope ?? null,
      tenants: catalog.tenants.map((t) => ({ id: String(t.pk_tenant_id), name: t.tenant_name })),
      customers: catalog.customers.map((c) => ({ id: String(c.pk_customer_id), name: c.customer_name, tenantId: String(c.fk_tenant_id) })),
      sites: catalog.sites.map((s) => ({ id: String(s.pk_site_id), name: s.site_name, customerId: String(s.fk_customer_id), status: s.status })),
      units: catalog.units.map((u) => ({ id: String(u.pk_unit_id), name: u.unit_name, siteId: String(u.fk_site_id) })),
      mt: mtBundle,
    });
  }

  // ── Legacy API mode: opaque token bootstrap ──
  const payload = await bootstrapWithAccessToken(accessToken, getClientContext(req));
  if (!payload) {
    return res.status(401).json({ message: "invalid or expired token" });
  }
  return res.json(payload);
}));

// ── Invite endpoints (public — no requireAuth) ─────────────────────────────

/**
 * GET /api/auth/invite/:token
 * Validate an invite token and return the user context for the setup page.
 */
router.get("/invite/:token", asyncHandler(async (req, res) => {
  const rawToken = req.params.token?.trim();
  if (!rawToken) {
    return res.status(400).json({ valid: false, reason: "invalid_or_expired" });
  }

  const hashed = createHash("sha256").update(rawToken).digest("hex");

  let rows;
  try {
    const result = await pool.query(
      `SELECT
         ui.pk_invite_id,
         ui.invited_by_name,
         ui.role_label,
         ui.tenant_name,
         ui.site_name,
         ui.expires_at,
         ui.used_at,
         u.email,
         u.username AS name,
         tr.realm_slug,
         tr.password_min_length
       FROM user_invite ui
       JOIN frs_user u ON u.pk_user_id = ui.fk_user_id
       LEFT JOIN frs_tenant_user_map tum ON tum.fk_user_id = u.pk_user_id
       LEFT JOIN tenant_realm tr ON tr.fk_tenant_id = tum.fk_tenant_id
       WHERE ui.invite_token = $1`,
      [hashed]
    );
    rows = result.rows;
  } catch (err) {
    logger.error("[invite-validation] Database query failed:", err);
    throw err;
  }

  if (!rows || !rows.length) {
    logger.warn(`[invite-validation] Token not found or row missing for token starting with ${rawToken.substring(0, 4)}...`);
    return res.status(404).json({ valid: false, reason: "invalid_or_expired" });
  }

  const invite = rows[0];

  if (invite.used_at) {
    return res.status(410).json({ valid: false, reason: "already_used" });
  }
  if (new Date(invite.expires_at) < new Date()) {
    return res.status(410).json({ valid: false, reason: "expired" });
  }

  return res.json({
    valid:          true,
    email:          invite.email,
    name:           invite.name,
    roleName:       invite.role_label,
    tenantName:     invite.tenant_name,
    siteName:       invite.site_name,
    invitedByName:  invite.invited_by_name,
    expiresAt:      invite.expires_at,
    realmSlug:      invite.realm_slug,
    minPasswordLength: invite.password_min_length || 8,
  });
}));

/**
 * POST /api/auth/invite/:token/setup
 * Body: { password }
 * Set the user's password, mark invite used, auto-login and return session.
 */
router.post("/invite/:token/setup", inviteLimiter, asyncHandler(async (req, res) => {
  const { password } = req.body;

  const hashed = createHash("sha256").update(req.params.token).digest("hex");

  // Load invite + user + resolved tenant realm in one query
  const { rows } = await pool.query(
    `SELECT
       ui.pk_invite_id,
       ui.fk_user_id,
       ui.expires_at,
       ui.used_at,
       ui.role_label,
       ui.tenant_name,
       u.email,
       u.username AS name,
       u.role,
       u.password_hash,
       tum.fk_tenant_id AS fk_tenant_id,
       tr.realm_slug,
       tr.password_min_length
     FROM user_invite ui
     JOIN frs_user u ON u.pk_user_id = ui.fk_user_id
     LEFT JOIN frs_tenant_user_map tum ON tum.fk_user_id = u.pk_user_id
     LEFT JOIN tenant_realm tr ON tr.fk_tenant_id = tum.fk_tenant_id
     WHERE ui.invite_token = $1
     LIMIT 1`,
    [hashed]
  );

  if (!rows.length) {
    return res.status(404).json({ message: "Invalid or expired invite link" });
  }

  const invite = rows[0];

  if (invite.used_at) {
    return res.status(410).json({ message: "This invite link has already been used" });
  }
  if (new Date(invite.expires_at) < new Date()) {
    return res.status(410).json({ message: "This invite link has expired. Ask your admin to resend the invite." });
  }

  const complexityErrors = validatePasswordComplexity(password, invite.password_min_length || 8);
  if (complexityErrors.length > 0) {
    return res.status(400).json({ message: "Password does not meet complexity requirements", errors: complexityErrors });
  }

  // Prevent reusing the exact same password if resetting
  if (invite.password_hash && invite.password_hash.startsWith("$2")) {
    const isSameAsOld = await bcrypt.compare(password, invite.password_hash);
    if (isSameAsOld) {
      return res.status(400).json({ message: "New password should be different from your old password" });
    }
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const userId       = invite.fk_user_id;

  // Update user password + clear the must_set_password flag
  if (env.authMode === "keycloak") {
    try {
      const realmSlug = invite.realm_slug || env.keycloak.realm;
      const tenantId  = invite.fk_tenant_id || null;
      const realmRole = mapRoleToKeycloakRealmRole(invite.role_label || invite.role);

      const keycloakUserId = await createOrUpdateKeycloakUser({
        email: invite.email,
        username: invite.name || invite.email,
        password,
        realmRole,
        tenantId,
        realmSlug,
      });

      // Resolve site organization mapping
      const siteRes = await pool.query(
        `SELECT s.keycloak_org_id
         FROM frs_user_membership um
         JOIN frs_site s ON s.pk_site_id = um.site_id
         WHERE um.fk_user_id = $1
         LIMIT 1`,
        [userId]
      );
      const orgSlug = siteRes.rows[0]?.keycloak_org_id;
      if (realmSlug && orgSlug) {
        await addUserToOrganization({
          realmSlug,
          orgSlug,
          userId: keycloakUserId,
        });
      }

      await pool.query(
        `UPDATE frs_user
         SET password_hash = $1, must_set_password = false, keycloak_sub = $2
         WHERE pk_user_id = $3`,
        [passwordHash, keycloakUserId, userId]
      );
    } catch (kcErr) {
      logger.error("Failed to provision/sync user to Keycloak:", kcErr);
      return res.status(500).json({ message: "Failed to set up user credentials in Keycloak: " + kcErr.message });
    }
  } else {
    await pool.query(
      `UPDATE frs_user
       SET password_hash = $1, must_set_password = false
       WHERE pk_user_id = $2`,
      [passwordHash, userId]
    );
  }

  // Mark invite as used
  await pool.query(
    "UPDATE user_invite SET used_at = NOW() WHERE pk_invite_id = $1",
    [invite.pk_invite_id]
  );

  // ── Auto-login: generate session ──────────────────────────────────────────
  let ip = req.ip || req.connection?.remoteAddress || "unknown";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  const context = { ipAddress: ip, userAgent: req.headers["user-agent"] || "unknown" };

  let kcAccessToken = null;
  let kcRefreshToken = null;

  if (env.authMode === "keycloak") {
    const kcBase = env.keycloak.url.replace(/\/$/, "");
    const clientId = process.env.KEYCLOAK_CLIENT_ID || "attendance-frontend";
    const realmSlug = invite.realm_slug || env.keycloak.realm;

    try {
      const tokenRes = await fetch(
        `${kcBase}/realms/${encodeURIComponent(realmSlug)}/protocol/openid-connect/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "password", client_id: clientId, username: invite.email, password }).toString(),
        }
      );
      if (tokenRes.ok) {
        const kcData = await tokenRes.json();
        kcAccessToken = kcData.access_token;
        kcRefreshToken = kcData.refresh_token;
      }
    } catch (err) {
      logger.error("Failed to auto-login Keycloak user after password reset:", err);
    }
  }

  const tokens = generateSessionTokens();
  await saveSessionToken({
    userId,
    accessToken:      hashToken(tokens.accessToken),
    refreshToken:     hashToken(tokens.refreshToken),
    accessExpiresAt:  tokens.accessExpiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
    userAgent:        context.userAgent,
    ipAddress:        context.ipAddress,
  });

  // ── Load memberships + scope (reuse same pattern as bootstrap) ────────────
  let membershipsRaw = await getRbacPermissionsForUser(userId);
  if (!membershipsRaw?.length) {
    membershipsRaw = await getMembershipsByUserId(userId);
  }

  const memberships = membershipsRaw.map((row) => ({
    id:     String(row.pk_membership_id),
    userId: String(row.fk_user_id),
    role:   row.role,
    scope: {
      tenantId:   row.tenant_id   != null ? String(row.tenant_id)   : null,
      customerId: row.customer_id          ? String(row.customer_id) : undefined,
      siteId:     row.site_id              ? String(row.site_id)     : undefined,
    },
    permissions: row.permissions || [],
  }));

  const tenantIds  = [...new Set(membershipsRaw.map((r) => r.tenant_id).filter(Boolean))];
  const catalogRaw = await getCatalogForTenantIds(tenantIds);

  // Write audit entry
  await writeAudit({
    req,
    action:  "user.password_setup",
    details: `Password set via invite for user ID ${userId} (${invite.email})`,
    userId,
    tenantId: membershipsRaw[0]?.tenant_id ?? null,
  });

  // S-01: Set tokens as httpOnly cookies; do not return in body unless we have Keycloak tokens
  setSessionCookies(res, tokens);

  return res.json({
    user: {
      id:    String(userId),
      email: invite.email,
      name:  invite.name,
      role:  invite.role,
    },
    memberships,
    activeScope: memberships[0]?.scope ?? null,
    accessToken: kcAccessToken,
    refreshToken: kcRefreshToken
  });
}));

router.get("/workspace/validate", asyncHandler(async (req, res) => {
  const { slug } = req.query;
  if (!slug || !slug.trim()) {
    return res.status(400).json({ valid: false, message: "Workspace name is required" });
  }

  const trimmed = slug.trim().toLowerCase();

  // 1. Check default keycloak realm
  const defaultRealm = (env.keycloak?.realm || "attendance").toLowerCase();
  if (trimmed === defaultRealm) {
    return res.json({ valid: true });
  }

  // 2. Check tenant_realm table
  const { rows } = await pool.query(
    "SELECT 1 FROM tenant_realm WHERE LOWER(realm_slug) = $1 LIMIT 1",
    [trimmed]
  );

  if (rows.length > 0) {
    return res.json({ valid: true });
  }

  return res.json({ valid: false });
}));

// ── Change password (Keycloak 20+ compatible) ─────────────────────────────
// KC 20+ removed POST /account/credentials/password.
// Flow: verify current password via ROPC, then Admin API reset-password.
router.post("/change-password", asyncHandler(async (req, res) => {
  if (env.authMode !== "keycloak") {
    return res.status(404).json({ error: "Not available in this auth mode" });
  }

  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "currentPassword and newPassword are required" });
  }

  const bearerToken = readBearerToken(req);
  if (!bearerToken) {
    return res.status(401).json({ error: "No access token" });
  }

  // Decode user info and realm from the bearer token
  let realm = env.keycloak.realm;
  let keycloakUserId, username;
  try {
    const payload = JSON.parse(Buffer.from(bearerToken.split('.')[1], 'base64').toString('utf8'));
    const match = (payload.iss || '').match(/\/realms\/([^/]+)$/);
    if (match) realm = decodeURIComponent(match[1]);
    keycloakUserId = payload.sub;
    username = payload.preferred_username;
  } catch {
    return res.status(400).json({ error: "Could not parse access token" });
  }

  const kcBase = env.keycloak.url.replace(/\/$/, "");
  const clientId = process.env.KEYCLOAK_CLIENT_ID || "attendance-frontend";

  // Step 1: Verify current password via ROPC
  const verifyRes = await fetch(
    `${kcBase}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", client_id: clientId, username, password: currentPassword }).toString(),
    }
  );

  if (!verifyRes.ok) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }

  // Step 2: Get admin token
  const adminUser = process.env.KEYCLOAK_ADMIN_USER || "admin";
  const adminPass = process.env.KEYCLOAK_ADMIN_PASSWORD || "";
  const adminTokenRes = await fetch(
    `${kcBase}/realms/master/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: adminUser, password: adminPass }).toString(),
    }
  );
  if (!adminTokenRes.ok) {
    logger.error("[change-password] Failed to get admin token");
    return res.status(500).json({ error: "Password change service unavailable" });
  }
  const { access_token: adminToken } = await adminTokenRes.json();

  // Step 3: Reset password via Admin API
  const resetRes = await fetch(
    `${kcBase}/admin/realms/${encodeURIComponent(realm)}/users/${keycloakUserId}/reset-password`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${adminToken}` },
      body: JSON.stringify({ type: "password", value: newPassword, temporary: false }),
    }
  );

  if (resetRes.ok) {
    return res.json({ success: true });
  }

  const body = await resetRes.json().catch(() => ({}));
  return res.status(resetRes.status).json({ error: body?.errorMessage || body?.error_description || "Failed to change password" });
}));

// Keycloak returns terse OAuth2-speak (e.g. "Invalid user credentials") that
// reads oddly to an end user. Map the descriptions we actually see for the
// password grant to plain-language equivalents; anything unrecognized falls
// back to a generic, still-friendly message rather than leaking raw IdP text.
// Exported for direct unit testing.
const ACCOUNT_LOCKED_MESSAGE = "Your account has been temporarily locked after too many failed attempts. Please try again later.";

function friendlyKeycloakLoginError(description) {
  const text = (description || "").toLowerCase();
  if (text.includes("invalid user credentials")) {
    return "Your email or password is incorrect. Please try again.";
  }
  if (text.includes("account disabled")) {
    return "Your account has been disabled. Please contact your administrator.";
  }
  if (text.includes("not fully set up")) {
    return "Your account setup isn't complete yet. Please check your email for setup instructions or contact your administrator.";
  }
  // AB#2730: Keycloak's own brute-force protection (bruteForceProtected +
  // failureFactor) is what actually locks an account out now. In some
  // environments its direct-grant (ROPC) token endpoint reports this as
  // error_description "Account temporarily disabled" / "temporarily locked" /
  // "account locked" — match that wording where present. It is NOT reliable
  // everywhere (confirmed live: some deployments report plain "Invalid user
  // credentials" for a locked account too), so the /keycloak-login route
  // additionally confirms lockout via the realm-admin attack-detection API
  // (getBruteForceStatus) rather than depending on this text match alone.
  if (
    text.includes("temporarily locked") ||
    text.includes("account locked") ||
    text.includes("temporarily disabled")
  ) {
    return ACCOUNT_LOCKED_MESSAGE;
  }
  return "We couldn't sign you in. Please check your email and password and try again.";
}

// AB#3267: the remaining-attempts Admin API lookup below is only meaningful
// for a fresh bad-credentials attempt — NOT for "account disabled", "not
// fully set up", or an already-locked account, where a count is either
// nonsensical or (for a locked account) the friendly lockout message already
// covers it. Mirrors friendlyKeycloakLoginError()'s first branch.
// Exported for direct unit testing.
function isBadCredentialsError(description) {
  return (description || "").toLowerCase().includes("invalid user credentials");
}

// AB#3267 / AB#2730 follow-up: best-effort lookup of the account's real
// brute-force lockout status. Calls the realm-admin API (not exposed by the
// ROPC token endpoint itself), so it needs a master-realm admin token and the
// user's Keycloak id — both looked up here. Returns null on ANY failure
// (network, 404 user, disabled admin API, etc.) so the caller can silently
// omit the hint rather than fail the whole login-error response over a
// non-critical enhancement.
//
// AB#2730 (reopened): this used to trust Keycloak's error_description text to
// tell a locked account apart from a plain wrong password (see
// friendlyKeycloakLoginError below) and only called this lookup for the
// "remaining attempts" hint, short-circuiting to null once the account was
// already disabled. Confirmed live against a real locked test account
// (tenant "bug-world") that Keycloak's direct-grant token endpoint returns
// the exact same error_description ("Invalid user credentials") whether the
// account is merely wrong-password or already brute-force-disabled — so
// string-matching the description can never detect lockout here, and the
// user was stuck seeing "incorrect password" forever, even once truly locked
// out. The realm-admin attack-detection API is the only reliable source of
// truth for lockout state, so the route now always consults it (via this
async function clearKeycloakBruteForceStatus({ realm, keycloakUserId }) {
  try {
    const kcBase = env.keycloak.url.replace(/\/$/, "");
    const adminToken = await getKeycloakAdminToken();
    await fetch(
      `${kcBase}/admin/realms/${encodeURIComponent(realm)}/attack-detection/brute-force/users/${encodeURIComponent(keycloakUserId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    logger.info(`[keycloak-login] Auto-cleared stale Keycloak brute-force record for user ${keycloakUserId} in realm ${realm}`);
  } catch (err) {
    logger.warn(`[keycloak-login] Failed to auto-clear Keycloak brute-force record: ${err.message}`);
  }
}

// Exported for direct unit testing.
async function getBruteForceStatus({ realm, username }) {
  try {
    const kcBase = env.keycloak.url.replace(/\/$/, "");
    const adminToken = await getKeycloakAdminToken();

    const userRes = await fetch(
      `${kcBase}/admin/realms/${encodeURIComponent(realm)}/users?username=${encodeURIComponent(username)}&exact=true`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    if (!userRes.ok) return null;
    const users = await userRes.json();
    const keycloakUserId = users?.[0]?.id;
    if (!keycloakUserId) return null;

    const [bruteForceRes, maxFailedLogins, lockoutDurationMinutes] = await Promise.all([
      fetch(
        `${kcBase}/admin/realms/${encodeURIComponent(realm)}/attack-detection/brute-force/users/${keycloakUserId}`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      ),
      getMaxFailedLoginsByRealmSlug(realm),
      getLockoutDurationByRealmSlug(realm),
    ]);
    if (!bruteForceRes.ok) return null;
    const bruteForce = await bruteForceRes.json();

    const numFailures = Number(bruteForce?.numFailures) || 0;
    const lastFailure = Number(bruteForce?.lastFailure) || 0;
    const lockWindowSeconds = (lockoutDurationMinutes || 15) * 60;

    let disabled = Boolean(bruteForce?.disabled);
    let remainingSeconds = 0;

    if (lastFailure > 0) {
      const elapsedSeconds = Math.floor((Date.now() - lastFailure) / 1000);
      const remaining = lockWindowSeconds - elapsedSeconds;

      if (remaining > 0 && (disabled || (maxFailedLogins > 0 && numFailures >= maxFailedLogins))) {
        disabled = true;
        remainingSeconds = remaining;
      } else {
        disabled = false;
        remainingSeconds = 0;
        // Keycloak's Direct Grant API retains `numFailures >= failureFactor` in memory
        // even after the lockout timer expires, blocking all logins until cleared.
        // Auto-clear Keycloak's stale brute-force record so Keycloak evaluates logins afresh.
        if (numFailures >= maxFailedLogins && keycloakUserId) {
          clearKeycloakBruteForceStatus({ realm, keycloakUserId }).catch(() => {});
        }
      }
    } else if (disabled) {
      remainingSeconds = lockWindowSeconds;
    }

    return {
      disabled,
      remainingSeconds: disabled ? remainingSeconds : null,
      // Not meaningful once the account is actually locked.
      remainingAttempts: disabled ? null : Math.max(0, maxFailedLogins - numFailures),
    };
  } catch (err) {
    logger.warn(`[keycloak-login] Could not compute brute-force status: ${err.message}`);
    return null;
  }
}

// ── Keycloak ROPC proxy ────────────────────────────────────────────────────
// Exchanges username+password for Keycloak tokens server-side to avoid CORS
// and keep client credentials off the browser. Only active in keycloak mode.
router.post("/keycloak-login", asyncHandler(async (req, res) => {
  if (env.authMode !== "keycloak") {
    return res.status(404).json({ error: "Not available in this auth mode" });
  }

  const { username, password, realm } = req.body;
  if (!username || !password || !realm) {
    return res.status(400).json({ error: "username, password, and realm are required" });
  }

  const kcBase = env.keycloak.url.replace(/\/$/, "");
  const clientId = process.env.KEYCLOAK_CLIENT_ID || "attendance-frontend";

  // Check brute-force status before attempting token grant.
  // If lockout duration has elapsed, getBruteForceStatus automatically clears Keycloak's
  // stale failure count so Keycloak evaluates the password afresh.
  const bruteForceBefore = await getBruteForceStatus({ realm, username });
  if (bruteForceBefore?.disabled) {
    const secs = bruteForceBefore.remainingSeconds || 60;
    const msg = secs <= 60
      ? `Your account has been temporarily locked after too many failed attempts. Please try again in ${secs} second(s).`
      : `Your account has been temporarily locked after too many failed attempts. Please try again in ${Math.ceil(secs / 60)} minute(s).`;
    return res.status(401).json({ error: msg });
  }

  const tokenRes = await fetch(
    `${kcBase}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", client_id: clientId, username, password }).toString(),
    }
  );

  const text = await tokenRes.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch (parseErr) {
    logger.error(`[auth] Keycloak token endpoint returned non-JSON response (${tokenRes.status}):`, text.slice(0, 200));
    return res.status(401).json({ error: "Invalid credentials or workspace details." });
  }

  if (!tokenRes.ok) {
    const description = data.error_description || data.error;
    const responseBody = { error: friendlyKeycloakLoginError(description) };

    // AB#2730 (reopened): Keycloak's direct-grant token endpoint reports the
    // exact same "Invalid user credentials" description for a plain wrong
    // password AND for an account already locked by brute-force protection
    // (confirmed live) — friendlyKeycloakLoginError's text match above can
    // never tell them apart, so it always fell through to the generic
    // wrong-password message even once the account was genuinely locked.
    // The realm-admin attack-detection API is ground truth for lockout
    // state, so always check it for anything that looks like a credentials
    // failure and let it override the message when the account is disabled.
    // Best-effort and never blocks returning the core 401 above.
    if (isBadCredentialsError(description)) {
      const bruteForce = await getBruteForceStatus({ realm, username });
      if (bruteForce?.disabled) {
        const secs = bruteForce.remainingSeconds || 60;
        if (secs <= 60) {
          responseBody.error = `Your account has been temporarily locked after too many failed attempts. Please try again in ${secs} second(s).`;
        } else {
          const mins = Math.ceil(secs / 60);
          responseBody.error = `Your account has been temporarily locked after too many failed attempts. Please try again in ${mins} minute(s).`;
        }
      } else if (bruteForce && bruteForce.remainingAttempts !== null) {
        responseBody.remainingAttempts = bruteForce.remainingAttempts;
      }
    }

    return res.status(401).json(responseBody);
  }

  return res.json({
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_in:    data.expires_in,
  });
}));

// Exchanges refresh_token for new Keycloak tokens server-side to avoid CORS
router.post("/keycloak-refresh", asyncHandler(async (req, res) => {
  if (env.authMode !== "keycloak") {
    return res.status(404).json({ error: "Not available in this auth mode" });
  }

  const { refreshToken, realm } = req.body;
  if (!refreshToken || !realm) {
    return res.status(400).json({ error: "refreshToken and realm are required" });
  }

  const kcBase = env.keycloak.url.replace(/\/$/, "");
  const clientId = process.env.KEYCLOAK_CLIENT_ID || "attendance-frontend";

  const tokenRes = await fetch(
    `${kcBase}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }).toString(),
    }
  );

  const text = await tokenRes.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch (parseErr) {
    logger.error(`[auth] Keycloak refresh endpoint returned non-JSON response (${tokenRes.status}):`, text.slice(0, 200));
    return res.status(401).json({ error: "Token refresh failed" });
  }

  if (!tokenRes.ok) {
    return res.status(401).json({ error: data.error_description || data.error || "Token refresh failed" });
  }

  return res.json({
    access_token:  data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_in:    data.expires_in,
  });
}));

export { router as authRoutes, friendlyKeycloakLoginError, getBruteForceStatus, isBadCredentialsError };
