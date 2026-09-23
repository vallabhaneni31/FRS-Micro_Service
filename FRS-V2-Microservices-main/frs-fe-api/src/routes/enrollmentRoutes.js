/**
 * enrollmentRoutes.js — Employee/visitor enrollment invitations + PUBLIC
 * remote-enrollment portal (used directly by employees'/visitors' own
 * browsers, and by Jetson edge devices — no Keycloak auth on those routes).
 *
 * Business logic lives in services/business/EnrollmentService.js, backed by
 * repositories/enrollmentRepository.js. This file only wires
 * routes -> middleware -> controller.
 */
import express from 'express';
import crypto from 'crypto';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth, requirePermission } from '../middleware/authz.js';
import upload from '../middleware/upload.js';
import { poseCheckLimiter } from '../middleware/rateLimit.js';
import { env } from '../config/env.js';
import EnrollmentController from '../controllers/EnrollmentController.js';
import { isValidUUID } from '../services/business/EnrollmentService.js';

const router = express.Router();
const ac = (fn) => asyncHandler(fn);

// S-06: HMAC signature validation for Jetson enrollment webhooks
function verifyWebhookSignature(req, res, next) {
  const secret = env.jetsonWebhookSecret;
  if (!secret) return next(); // no secret configured — skip in dev

  const signature = req.headers['x-webhook-signature'] || req.headers['x-hub-signature-256'];
  if (!signature) {
    return res.status(401).json({ message: 'Missing webhook signature' });
  }

  const payload = JSON.stringify(req.body);
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');

  let sigBuf, expBuf;
  try {
    sigBuf = Buffer.from(signature);
    expBuf = Buffer.from(expected);
  } catch (_) {
    return res.status(401).json({ message: 'Invalid webhook signature' });
  }

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return res.status(401).json({ message: 'Invalid webhook signature' });
  }

  return next();
}

// Middleware to enforce x-tenant-id header/scope for authenticated requests
router.use((req, res, next) => {
  if (req.auth) {
    const tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'];
    if (!tenantId || !isValidUUID(tenantId)) {
      return res.status(400).json({ error: 'x-tenant-id header is required' });
    }
  }
  next();
});

// GET / — list enrollment invitations for this tenant
router.get('/', requireAuth, requirePermission('employees.read'), ac(EnrollmentController.listInvitations));

/**
 * POST /api/enrollment/send-invitations
 * Send enrollment invitations to multiple employees
 */
router.post('/send-invitations', requireAuth, requirePermission('employees.write'), ac(EnrollmentController.sendInvitations));

/**
 * GET /api/enrollment/invitations
 * Get all enrollment invitations (for HR dashboard)
 */
router.get('/invitations', requireAuth, requirePermission('employees.read'), ac(EnrollmentController.listInvitationsFiltered));

/**
 * GET /api/enrollment/employees
 * List employees with their enrollment status (for Remote Enrollment UI)
 */
router.get('/employees', requireAuth, requirePermission('employees.read'), ac(EnrollmentController.listEnrollmentEmployees));

/**
 * GET /api/enroll/reminder-settings
 * PUT /api/enroll/reminder-settings
 * Get/set whether unfinished-enrollment reminder emails are enabled for this tenant.
 */
router.get('/reminder-settings', requireAuth, requirePermission('employees.read'), ac(EnrollmentController.getReminderSettings));
router.put('/reminder-settings', requireAuth, requirePermission('employees.write'), ac(EnrollmentController.updateReminderSettings));

/**
 * POST /api/enroll/reminders/send
 * Manually send a reminder email right now to HR-selected invitations
 * (independent of the automatic daily 9AM-local cron).
 */
router.post('/reminders/send', requireAuth, requirePermission('employees.write'), ac(EnrollmentController.sendManualReminders));

/**
 * POST /api/enrollment/invitations/:id/resend
 * Resend invitation email
 */
router.post('/invitations/:id/resend', requireAuth, requirePermission('employees.write'), ac(EnrollmentController.resendInvitation));

/**
 * GET /api/enroll/pending-approvals
 * Get enrollments pending HR approval
 */
router.get('/pending-approvals', requireAuth, requirePermission('employees.write'), ac(EnrollmentController.getPendingApprovals));

/**
 * POST /api/enroll/invitations/:id/approve
 * Approve enrollment and create embeddings
 */
router.post('/invitations/:id/approve', requireAuth, requirePermission('employees.write'), ac(EnrollmentController.approveEnrollment));

/**
 * GET /api/enroll/invitations/:id/progress
 * Live per-angle pipeline status for the HR approvals UI, polled after clicking Approve.
 */
router.get('/invitations/:id/progress', requireAuth, requirePermission('employees.read'), ac(EnrollmentController.getEnrollmentProgress));

/**
 * POST /api/enroll/invitations/:id/reject
 * Reject enrollment and send re-enrollment invitation
 */
router.post('/invitations/:id/reject', requireAuth, requirePermission('employees.write'), ac(EnrollmentController.rejectEnrollment));

/**
 * POST /api/enrollment/invitations/:id/revoke
 * Revoke enrollment invitation by adding its token to the blacklist
 */
router.post('/invitations/:id/revoke', requireAuth, requirePermission('employees.write'), ac(EnrollmentController.revokeInvitation));

/**
 * GET /api/enroll/photos/:filename
 * Serve enrollment photo (requires auth)
 */
router.get('/photos/:filename', requireAuth, requirePermission('employees.read'), ac(EnrollmentController.servePhoto));

// ── PUBLIC enrollment portal routes (no Keycloak auth — use their own JWT) ──
// These MUST be after all named routes to avoid the /:token wildcard
// swallowing paths like /invitations, /employees, /send-invitations.

/**
 * GET /api/enroll/:token/progress
 * Returns current quality scores for each angle so the browser can poll
 * while waiting for Jetson to score photos asynchronously.
 */
router.get('/:token/progress', ac(EnrollmentController.checkBlacklist), ac(EnrollmentController.getProgress));

/**
 * GET /api/enrollment/:token
 * Validate token and return employee info (PUBLIC)
 */
router.get('/:token', ac(EnrollmentController.checkBlacklist), ac(EnrollmentController.getPublicInvitation));

/**
 * POST /api/enroll/:token/consent
 * Record employee consent before starting remote enrollment (PUBLIC)
 */
router.post('/:token/consent', ac(EnrollmentController.checkBlacklist), ac(EnrollmentController.recordConsent));

/**
 * POST /api/enroll/:token/upload-angle
 * Upload and process a single angle photo (PUBLIC - no auth)
 */
router.post(
  '/:token/upload-angle',
  upload.single('photo'),
  ac(EnrollmentController.checkBlacklist),
  ac(EnrollmentController.uploadAngle)
);

/**
 * POST /api/enroll/:token/check-pose
 * Live pose/face-direction check while the camera is open, BEFORE capture —
 * never persisted (see EnrollmentService.checkPose). Lets the self-enrollment
 * portal tell the user in real time whether they're facing the right way for
 * the current angle (PUBLIC - no auth).
 */
router.post(
  '/:token/check-pose',
  upload.single('photo'),
  poseCheckLimiter,
  ac(EnrollmentController.checkBlacklist),
  ac(EnrollmentController.checkPose)
);

/**
 * POST /api/enroll/:token/complete
 * Complete enrollment and create embeddings (PUBLIC - no auth)
 */
router.post(
  '/:token/complete',
  ac(EnrollmentController.checkBlacklist),
  verifyWebhookSignature, // S-06: HMAC validation (no-op when secret not configured)
  ac(EnrollmentController.completeEnrollment)
);

export default router;
