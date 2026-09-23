import express from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { inviteLimiter } from "../middleware/rateLimit.js";
import logger from "../utils/logger.js";
import { createOrUpdateKeycloakUser } from "../services/keycloakUserService.js";
import { sendUserInvite } from "../services/emailService.js";

const router = express.Router();

// Service-to-service calls only (e.g. backend/api-retail), never exposed to browsers.
// Guarded by a shared secret rather than a user session, matching the existing
// HRMS webhook pattern (routes/hrmsIntegrationRoutes.js).
function requireInternalSecret(req, res, next) {
  const expected = process.env.INTERNAL_SERVICE_SECRET;
  if (!expected) {
    logger.error("[internal] INTERNAL_SERVICE_SECRET is not configured — refusing request");
    return res.status(503).json({ error: "internal_service_unconfigured" });
  }
  const provided = req.headers["x-internal-secret"];
  if (provided !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }
  return next();
}

router.use(requireInternalSecret);

/**
 * POST /api/internal/keycloak/provision-user
 * Body: { email, username, password, realmRole, tenantId, realmSlug }
 * Creates or updates a Keycloak user in the given tenant realm and assigns
 * a realm role. Used by other backend services (e.g. retail) that share
 * this Keycloak instance but don't hold Keycloak admin credentials themselves.
 */
router.post("/keycloak/provision-user", inviteLimiter, asyncHandler(async (req, res) => {
  const { email, username, password, realmRole, tenantId, realmSlug } = req.body || {};
  if (!email || !password || !realmRole || !realmSlug) {
    return res.status(400).json({ error: "email, password, realmRole and realmSlug are required" });
  }

  const keycloakUserId = await createOrUpdateKeycloakUser({
    email, username: username || email, password, realmRole, tenantId, realmSlug,
  });

  return res.json({ keycloakUserId });
}));

/**
 * POST /api/internal/email/send-user-invite
 * Body: { toEmail, toName, invitedByName, roleName, tenantName, siteName, setupLink, expiresAt }
 */
router.post("/email/send-user-invite", inviteLimiter, asyncHandler(async (req, res) => {
  const { toEmail, setupLink, expiresAt } = req.body || {};
  if (!toEmail || !setupLink || !expiresAt) {
    return res.status(400).json({ error: "toEmail, setupLink and expiresAt are required" });
  }

  await sendUserInvite(req.body);
  return res.json({ sent: true });
}));

export { router as internalRoutes };
