import logger from "../utils/logger.js";
import { env } from "../config/env.js";

/**
 * REST API Guard for private beta testing phase.
 * Restricts access to the new visitor and unknown person APIs to the
 * allowlist configured via the BETA_TESTER_EMAILS environment variable.
 */
export function requireTestAccess(req, res, next) {
  const userEmail = req.auth?.user?.email;
  const normalizedEmail = userEmail ? userEmail.toLowerCase().trim() : '';

  const isTester = env.betaTesterEmails.includes(normalizedEmail);

  const userRole = req.auth?.user?.role;
  const isHR = userRole === 'hr_manager' || 
               req.auth?.memberships?.some(m => m.role === 'hr_manager');

  if (isTester || isHR) {
    logger.info({ email: userEmail, role: userRole }, "[auth] Access granted to visitor feature");
    return next();
  }

  // Fallback bypass for unit testing/sandbox where req.auth is not populated
  if (process.env.NODE_ENV === "development" && !userEmail) {
    logger.debug("[auth] Development bypass active for test access check due to missing auth email");
    return next();
  }

  logger.warn({ email: userEmail, path: req.path }, "[auth] Access denied: User not in private beta whitelist");
  return res.status(403).json({
    success: false,
    message: "Access restricted: Visitor Management features are currently in private beta testing."
  });
}
