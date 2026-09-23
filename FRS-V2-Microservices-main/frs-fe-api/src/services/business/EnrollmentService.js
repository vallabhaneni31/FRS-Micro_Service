/**
 * EnrollmentService.js — business logic extracted from enrollmentRoutes.js.
 * Backed by repositories/enrollmentRepository.js. Covers both the
 * authenticated HR-facing enrollment management endpoints and the PUBLIC
 * (no Keycloak auth) remote-enrollment portal endpoints used directly by
 * employees'/visitors' own browsers and by Jetson edge devices.
 */
import jwt from 'jsonwebtoken';
import { isIP } from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendEnrollmentInvitation, sendEnrollmentRejection, sendEnrollmentReminder } from '../emailService.js';
import { writeAudit } from '../../middleware/auditLog.js';
import logger from '../../utils/logger.js';
import { createSystemNotification } from './SystemNotificationService.js';
import * as repo from '../../repositories/enrollmentRepository.js';
import * as storage from '../storageService.js';
import { buildUserDataKey, sanitizeForKey } from '../../utils/s3KeyBuilder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── FIX-001: ENROLLMENT_TOKEN_SECRET hard-fail guard ─────────────────────────
// Server must NOT start without a strong secret — tokens signed with undefined
// are trivially forgeable.
const ENROLLMENT_TOKEN_SECRET = process.env.ENROLLMENT_TOKEN_SECRET;
if (!ENROLLMENT_TOKEN_SECRET) {
  throw new Error(
    '[FATAL] ENROLLMENT_TOKEN_SECRET is required. Generate: openssl rand -hex 32'
  );
}
if (ENROLLMENT_TOKEN_SECRET.length < 32) {
  throw new Error(
    '[FATAL] ENROLLMENT_TOKEN_SECRET must be at least 32 characters. ' +
    'Generate: openssl rand -hex 32'
  );
}

export function isValidUUID(val) {
  if (typeof val !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
}

// The legacy customer_id / site_id columns on enrollment_invitations are
// integers. In the multi-tenant model scope ids may arrive as UUIDs; coerce to
// an integer only when the value really is one, otherwise store NULL.
export function toIntOrNull(val) {
  if (val === null || val === undefined) return null;
  const n = Number(val);
  return Number.isInteger(n) ? n : null;
}

export async function resolveTenantId(req) {
  let tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'];
  if (!tenantId || !isValidUUID(tenantId)) {
    return null;
  }
  return tenantId;
}

// ── FIX-003: SSRF Prevention ──────────────────────────────────────────────────
// Validates that a Jetson device IP is safe to connect to.
// Blocks cloud metadata endpoints, loopback, and non-allowlisted IPs in prod.
export function validateJetsonIP(ip) {
  if (!ip || typeof ip !== 'string') return false;
  if (!isIP(ip)) return false;

  const blockedIPs = ['169.254.169.254', '100.100.100.200', '192.0.2.1'];
  if (blockedIPs.includes(ip)) return false;

  if (ip === '127.0.0.1' || ip === '::1') return false;

  const allowlist = (process.env.JETSON_IP_ALLOWLIST || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.NODE_ENV === 'production' && allowlist.length > 0) {
    return allowlist.includes(ip);
  }

  const privateRanges = [/^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./];
  if (!privateRanges.some(r => r.test(ip))) {
    logger.warn(`[Security] Non-private Jetson IP detected: ${ip}`);
  }
  return true;
}

// ── FIX-002: Jetson HTTP → HTTPS enforcement ─────────────────────────────────
async function getJetsonUrl(tenantId) {
  const dev = await repo.findActiveJetsonDevice(tenantId);
  if (!dev) return null;

  const ip = dev.ip_address;

  if (!validateJetsonIP(ip)) {
    logger.error(`[Security] Blocked SSRF — invalid Jetson IP: ${ip} for tenant: ${tenantId}`);
    throw new Error('Invalid device IP address');
  }

  const forceHttp = process.env.JETSON_FORCE_HTTP === 'true';
  if (forceHttp && process.env.NODE_ENV === 'production') {
    throw new Error('[Security] JETSON_FORCE_HTTP cannot be used in production');
  }
  const protocol = (!forceHttp && process.env.NODE_ENV === 'production') ? 'https' : 'http';
  const configPort = dev.device_config?.port;
  const port = configPort || (protocol === 'https' ? 5443 : 5000);
  return `${protocol}://${ip}:${port}`;
}

export function getRemoteEnrollmentPhotoDir() {
  return process.env.REMOTE_ENROLLMENT_PHOTO_DIR
    || path.resolve(__dirname, '../../../uploads/remote-enrollment');
}

// ============================================================================
// AUTHENTICATED HR-FACING ENDPOINTS
// ============================================================================

export async function listInvitations(tenantId) {
  return repo.listInvitationsForTenant(tenantId);
}

export async function sendInvitations({ employeeIds, tenantId, customerId, siteId }, req) {
  const results = { sent: [], failed: [], skipped: [] };

  const empRows = await repo.findEmployeesForInvite(employeeIds.map(Number), tenantId);

  const foundIds = new Set(empRows.map(e => e.pk_employee_id));
  for (const id of employeeIds) {
    if (!foundIds.has(Number(id))) {
      results.skipped.push({ employeeId: Number(id), reason: 'Employee not found' });
    }
  }

  const completedIds = new Set(
    empRows.length > 0 ? await repo.findActiveOrCompletedEmployeeIds(empRows.map(e => e.pk_employee_id)) : []
  );

  const validEmployees = [];
  for (const employee of empRows) {
    if (!employee.email) {
      results.skipped.push({
        employeeId: employee.pk_employee_id,
        employeeCode: employee.employee_code,
        employeeName: employee.full_name,
        reason: 'No email address',
      });
      continue;
    }
    if (completedIds.has(employee.pk_employee_id)) {
      results.skipped.push({
        employeeId: employee.pk_employee_id,
        employeeCode: employee.employee_code,
        employeeName: employee.full_name,
        reason: 'Already enrolled or awaiting approval',
      });
      continue;
    }
    validEmployees.push(employee);
  }

  if (validEmployees.length > 0) {
    await repo.expirePendingInvitations(validEmployees.map(e => e.pk_employee_id));
  }

  for (const employee of validEmployees) {
    const employeeId = employee.pk_employee_id;
    try {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      const token = jwt.sign(
        {
          employeeId: employee.pk_employee_id,
          employeeCode: employee.employee_code,
          tenantId,
          customerId,
          siteId,
        },
        ENROLLMENT_TOKEN_SECRET,
        { expiresIn: '7d' }
      );

      const invitationId = await repo.insertInvitation({
        employeeId, tenantId, customerId: toIntOrNull(customerId), siteId: toIntOrNull(siteId), token, expiresAt,
      });

      const enrollmentLink = `${process.env.ENROLLMENT_PORTAL_URL}/${token}`;

      try {
        await sendEnrollmentInvitation({
          employeeName: employee.full_name,
          employeeEmail: employee.email,
          enrollmentLink,
          expiresAt,
        });
      } catch (emailErr) {
        logger.error(`Email dispatch failed for employee ${employeeId}, rolling back database record:`, emailErr);
        await repo.deleteInvitation(invitationId);
        throw new Error(`Email dispatch failed: ${emailErr.message}`);
      }

      await writeAudit({
        req,
        action: 'enrollment.invitation.sent',
        details: `Sent enrollment invitation to ${employee.full_name} (${employee.employee_code})`,
        entityType: 'employee',
        entityId: String(employeeId),
        entityName: employee.full_name,
        after: { invitationId, expiresAt: expiresAt.toISOString() },
        source: 'ui',
      });

      results.sent.push({
        employeeId,
        employeeCode: employee.employee_code,
        employeeName: employee.full_name,
        email: employee.email,
        invitationId,
        expiresAt,
      });
    } catch (error) {
      logger.error(`Failed to send invitation to employee ${employeeId}:`, error);
      results.failed.push({ employeeId, reason: error.message });
    }
  }

  return {
    summary: {
      total: employeeIds.length,
      sent: results.sent.length,
      failed: results.failed.length,
      skipped: results.skipped.length,
    },
    results,
  };
}

export async function getReminderSettings(tenantId) {
  return repo.getReminderSettings(tenantId);
}

export async function setReminderSettings(tenantId, enabled, hour) {
  return repo.setReminderSettings(tenantId, enabled, hour);
}

// HR explicitly picking employees from the Invitations tab and asking to
// remind them right now — separate from the automatic per-tenant daily cron.
export async function sendManualReminders({ invitationIds, tenantId }, req) {
  const results = { sent: [], failed: [], skipped: [] };
  const invitations = await repo.getInvitationsForManualReminder(invitationIds.map(Number), tenantId);

  const foundIds = new Set(invitations.map(i => i.pk_invitation_id));
  for (const id of invitationIds) {
    if (!foundIds.has(Number(id))) {
      results.skipped.push({ invitationId: Number(id), reason: 'Invitation not found' });
    }
  }

  for (const inv of invitations) {
    if (!['pending', 'opened', 'in_progress'].includes(inv.status)) {
      results.skipped.push({ invitationId: inv.pk_invitation_id, employeeName: inv.full_name, reason: 'Already completed' });
      continue;
    }
    if (new Date(inv.expires_at) <= new Date()) {
      results.skipped.push({ invitationId: inv.pk_invitation_id, employeeName: inv.full_name, reason: 'Invitation expired' });
      continue;
    }
    if (!inv.email) {
      results.skipped.push({ invitationId: inv.pk_invitation_id, employeeName: inv.full_name, reason: 'No email address' });
      continue;
    }

    try {
      const enrollmentLink = `${process.env.ENROLLMENT_PORTAL_URL}/${inv.invitation_token}`;
      await sendEnrollmentReminder({
        employeeName: inv.full_name,
        employeeEmail: inv.email,
        enrollmentLink,
        expiresAt: inv.expires_at,
      });
      await repo.markReminderSent(inv.pk_invitation_id);
      await writeAudit({
        req,
        action: 'enrollment.reminder.sent',
        details: `Manually sent enrollment reminder to ${inv.full_name}`,
        entityType: 'employee',
        entityId: String(inv.pk_invitation_id),
        entityName: inv.full_name,
        source: 'ui',
      });
      results.sent.push({ invitationId: inv.pk_invitation_id, employeeName: inv.full_name, email: inv.email });
    } catch (error) {
      logger.error(`Failed to send manual reminder for invitation ${inv.pk_invitation_id}:`, error);
      results.failed.push({ invitationId: inv.pk_invitation_id, employeeName: inv.full_name, reason: error.message });
    }
  }

  return {
    summary: { total: invitationIds.length, sent: results.sent.length, failed: results.failed.length, skipped: results.skipped.length },
    results,
  };
}

export async function listInvitationsFiltered({ tenantId, status, limit }) {
  const rows = await repo.listInvitationsWithFilter(tenantId, limit);
  const filtered = (status && status !== 'all')
    ? rows.filter(r => r.display_status === status)
    : rows;
  return { invitations: filtered, total: filtered.length };
}

export async function listEnrollmentEmployees(scope) {
  return repo.listEmployeesWithEnrollmentStatus(scope);
}

function formatDate(dateVal) {
  if (!dateVal) return null;
  const d = new Date(dateVal);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatTimeRange(fromVal, toVal) {
  if (!fromVal || !toVal) return null;
  const fromD = new Date(fromVal);
  const toD = new Date(toVal);
  const formatTime = (d) => d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  return `${formatTime(fromD)} - ${formatTime(toD)}`;
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.statusCode = 404;
  }
}

export async function resendInvitation(id, req) {
  const invitation = await repo.getInvitationForResend(id);
  if (!invitation) throw new NotFoundError('Invitation not found');

  const newExpiresAt = new Date();
  newExpiresAt.setDate(newExpiresAt.getDate() + 7);
  const newToken = jwt.sign(
    {
      employeeId: invitation.fk_employee_id || undefined,
      personId: invitation.fk_person_id || undefined,
      employeeCode: invitation.employee_code,
      tenantId: invitation.mt_tenant_id,
      customerId: invitation.customer_id,
      siteId: invitation.site_id,
    },
    ENROLLMENT_TOKEN_SECRET,
    { expiresIn: '7d' }
  );
  await repo.updateInvitationForResend(id, { token: newToken, expiresAt: newExpiresAt });

  const enrollmentLink = `${process.env.ENROLLMENT_PORTAL_URL}/${newToken}`;

  let visitDetails = null;
  if (invitation.fk_person_id) {
    let hostName = null;
    if (invitation.host_employee_id) {
      hostName = await repo.getHostEmployeeName(invitation.host_employee_id);
    }
    visitDetails = {
      hostName,
      visitDate: formatDate(invitation.valid_from),
      visitTimeRange: formatTimeRange(invitation.valid_from, invitation.valid_to),
      visitPurpose: invitation.visit_purpose,
    };
  }

  await sendEnrollmentInvitation({
    employeeName: invitation.full_name,
    employeeEmail: invitation.email,
    enrollmentLink,
    expiresAt: newExpiresAt,
    visitDetails,
  });

  await writeAudit({
    req,
    action: 'enrollment.invitation.resent',
    details: invitation.fk_employee_id
      ? `Resent enrollment invitation to ${invitation.full_name} (${invitation.employee_code})`
      : `Resent visitor enrollment invitation to ${invitation.full_name} (${invitation.email})`,
    entityType: invitation.fk_employee_id ? 'employee' : 'person',
    entityId: String(invitation.fk_employee_id || invitation.fk_person_id),
    source: 'ui',
  });
}

export async function getPendingApprovals(tenantId) {
  return repo.getPendingApprovals(tenantId);
}

export async function approveEnrollment({ id, tenantId, approvedBy }, req) {
  const invitation = await repo.getInvitationForApproval(id, tenantId);
  if (!invitation) throw new NotFoundError('Invitation not found');

  if (invitation.status !== 'completed') {
    const err = new Error('Enrollment not completed yet');
    err.statusCode = 400;
    throw err;
  }
  if (invitation.approval_status === 'auto_approved' || invitation.approval_status === 'manually_approved') {
    const err = new Error('Already approved');
    err.statusCode = 400;
    throw err;
  }

  await repo.markInvitationPendingEmbedding(id, approvedBy);

  await writeAudit({
    req,
    action: 'enrollment.approved',
    details: `Approved enrollment for ${invitation.full_name} (${invitation.employee_code})`,
    entityType: 'employee',
    entityId: String(invitation.fk_employee_id),
    entityName: invitation.full_name,
    source: 'ui',
  });

  // Fire-and-forget: create embeddings in background; Jetson may take time.
  createEmbeddingsFromPhotos(invitation)
    .then(count => {
      if (count > 0) {
        repo.markInvitationManuallyApproved(invitation.pk_invitation_id).catch(() => {});
      }
    })
    .catch(err => logger.error('Background embedding creation failed:', err.message));

  logger.info(`✅ HR approved enrollment for ${invitation.employee_code}`);

  await createSystemNotification({
    tenant_id: tenantId,
    site_id: invitation.site_id,
    customer_id: invitation.customer_id,
    alert_type: 'EMPLOYEE_ENROLLMENT_APPROVED',
    severity: 'info',
    title: 'Enrollment Approved',
    message: `Enrollment for ${invitation.full_name} (${invitation.employee_code}) was approved.`,
    fk_employee_id: invitation.fk_employee_id,
  });
}

// ── Live progress panel — GET /enroll/invitations/:id/progress ─────────────
// Called by the HR approvals UI after clicking Approve, polled every few
// seconds (plus nudged by the enrollment.completed/failed WebSocket events)
// to show per-angle pipeline stage without the admin having to guess what's
// happening server-side. Derives "embedded" from employee_face_embeddings
// directly (reliable, independent of the device_command_queue status bug
// fixed above) and "queued"/"delivered" from device_command_queue.
export async function getEnrollmentProgress({ id, tenantId }) {
  const invitation = await repo.getInvitationForProgress(id, tenantId);
  if (!invitation) throw new NotFoundError('Invitation not found');

  const angleNames = Object.keys(invitation.photo_paths || {});
  // invitation.since (approved_at, falling back to completed_at/created_at —
  // see getInvitationForProgress) naturally excludes stale command/embedding
  // rows from a previous enrollment attempt for the same employee.
  const since = invitation.since;

  const angles = {};
  for (const angle of angleNames) {
    angles[angle] = { stage: 'pending', command_id: null, queued_at: null, delivered_at: null, embedded_at: null, quality_score: null };
  }

  if (invitation.fk_employee_id) {
    const [commands, embeddings] = await Promise.all([
      invitation.employee_code
        ? repo.getEnrollFromPhotoCommandsSince(invitation.employee_code, since)
        : [],
      repo.getEmployeeEmbeddingsSince(invitation.fk_employee_id, since),
    ]);

    for (const cmd of commands) {
      if (!angles[cmd.angle]) continue; // defensive: ignore angles outside this invitation's set
      angles[cmd.angle].command_id = cmd.pk_command_id;
      angles[cmd.angle].queued_at = cmd.created_at;
      angles[cmd.angle].stage = 'queued';
      if (cmd.status === 'delivered' || cmd.status === 'done') {
        angles[cmd.angle].delivered_at = cmd.executed_at || cmd.created_at;
        angles[cmd.angle].stage = 'delivered';
      }
      if (cmd.status === 'failed') {
        angles[cmd.angle].stage = 'failed';
      }
    }

    // Embeddings are the ground truth — override queued/delivered/failed
    // once the angle actually lands, whether it arrived via the fast direct-
    // push path (no command row at all) or via the queued/Jetson-poll path.
    for (const emb of embeddings) {
      if (!angles[emb.angle]) continue;
      angles[emb.angle].stage = 'embedded';
      angles[emb.angle].embedded_at = emb.enrolled_at;
      angles[emb.angle].quality_score = emb.quality_score;
    }
  } else if (invitation.fk_person_id) {
    // Visitor enrollment: person_face_embeddings has no per-angle column, so
    // the best available signal is "any embedding landed at all" — applied
    // uniformly since we can't distinguish which angle it corresponds to.
    const embeddings = await repo.getPersonEmbeddingsSince(invitation.fk_person_id, since);
    if (embeddings.length > 0) {
      for (const angle of angleNames) {
        angles[angle].stage = 'embedded';
        angles[angle].embedded_at = embeddings[0].created_at;
        angles[angle].quality_score = embeddings[0].quality_score;
      }
    }
  }

  return {
    invitation_id: invitation.pk_invitation_id,
    employee_code: invitation.employee_code || null,
    full_name: invitation.full_name || null,
    approval_status: invitation.approval_status,
    embedding_status: invitation.embedding_status,
    angles,
  };
}

// Rejected/revoked invitations never reach approveEnrollment, so their
// already-uploaded angle photos (captured before HR ever saw them — see
// upload-angle) have no other cleanup path and would otherwise sit in
// USER_DATA_BUCKET forever. Best-effort: a delete failure shouldn't block
// the reject/revoke action itself.
async function deleteInvitationPhotos(photoPaths) {
  for (const photoPath of Object.values(photoPaths || {})) {
    try {
      await storage.deleteFile(storage.USER_DATA_BUCKET, photoPath);
    } catch (err) {
      logger.warn(`[enrollment] Failed to delete photo ${photoPath}:`, err.message);
    }
  }
}

export async function rejectEnrollment({ id, reason, tenantId, customerId, siteId, rejectedBy }, req) {
  const invitation = await repo.getInvitationForReject(id, tenantId);
  if (!invitation) throw new NotFoundError('Invitation not found');

  await repo.markInvitationRejected(id, { reason: reason || 'Poor photo quality', rejectedBy });
  await deleteInvitationPhotos(invitation.photo_paths);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  const token = jwt.sign(
    { employeeId: invitation.fk_employee_id, employeeCode: invitation.employee_code, tenantId, customerId, siteId },
    ENROLLMENT_TOKEN_SECRET,
    { expiresIn: '7d' }
  );

  await repo.insertInvitation({
    employeeId: invitation.fk_employee_id, tenantId, customerId: toIntOrNull(customerId), siteId: toIntOrNull(siteId), token, expiresAt,
  });

  const enrollmentLink = `${process.env.ENROLLMENT_PORTAL_URL}/${token}`;

  try {
    await sendEnrollmentRejection({
      employeeName: invitation.full_name,
      employeeEmail: invitation.email,
      reason: reason || 'Poor photo quality',
      enrollmentLink,
    });
    logger.info(`📧 Rejection email sent to ${invitation.email}`);
  } catch (emailErr) {
    logger.error('Failed to send rejection email:', emailErr);
  }

  await writeAudit({
    req,
    action: 'enrollment.rejected',
    details: `Rejected enrollment for ${invitation.full_name} (${invitation.employee_code}): ${reason || 'Poor photo quality'}. New invitation sent.`,
    entityType: 'employee',
    entityId: String(invitation.fk_employee_id),
    entityName: invitation.full_name,
    source: 'ui',
  });
}

export async function revokeInvitationById(id, req) {
  const invitation = await repo.getInvitationForRevoke(id);
  if (!invitation) throw new NotFoundError('Invitation not found');

  await repo.revokeInvitation(id, invitation.invitation_token);
  await deleteInvitationPhotos(invitation.photo_paths);

  await writeAudit({
    req,
    action: 'enrollment.invitation.revoked',
    details: `Revoked enrollment invitation ID ${id}`,
    entityType: 'employee',
    entityId: String(invitation.fk_employee_id),
    source: 'ui',
  });
}

// ============================================================================
// PUBLIC ENROLLMENT PORTAL
// ============================================================================

export async function isTokenBlacklisted(token) {
  return repo.isTokenBlacklisted(token);
}

export async function getProgress(token) {
  jwt.verify(token, ENROLLMENT_TOKEN_SECRET);
  const row = await repo.getInvitationProgress(token);
  if (!row) throw new NotFoundError('Not found');
  return { quality_scores: row.quality_scores || {}, average_quality: row.average_quality, approval_status: row.approval_status };
}

export async function getPublicInvitation(token) {
  jwt.verify(token, ENROLLMENT_TOKEN_SECRET);

  const invitation = await repo.getInvitationByToken(token);
  if (!invitation) throw new NotFoundError('Invitation not found');

  // Checked before the expiry test: a superseded link's own expires_at is
  // left untouched by expirePendingInvitations, so it may still read as
  // "not yet expired" — but it's dead either way, and the employee should
  // be told why (a newer invite exists) rather than that it timed out.
  if (invitation.status === 'superseded') {
    return {
      employeeName: invitation.full_name,
      employeeCode: invitation.employee_code,
      status: 'superseded',
    };
  }

  if (new Date(invitation.expires_at) < new Date()) {
    return {
      employeeName: invitation.full_name,
      employeeCode: invitation.employee_code,
      status: 'expired',
    };
  }

  if (invitation.status === 'pending') {
    await repo.markInvitationOpened(invitation.pk_invitation_id);
  }

  return {
    employeeName: invitation.full_name,
    employeeCode: invitation.employee_code,
    status: invitation.status,
    invitationId: invitation.pk_invitation_id,
  };
}

export async function recordConsent(token, method) {
  jwt.verify(token, ENROLLMENT_TOKEN_SECRET);

  const invitation = await repo.getInvitationForConsent(token);
  if (!invitation) throw new NotFoundError('Invitation not found');

  const fakeReq = { user: { id: null }, headers: {}, ip: '' };

  if (invitation.fk_employee_id) {
    await repo.updateEmployeeConsent(invitation.fk_employee_id, method);
    await repo.insertEmployeeBiometricConsent(invitation.fk_employee_id, invitation.mt_tenant_id, method);

    await writeAudit({
      req: fakeReq,
      action: 'employee.consent_given',
      details: `GDPR consent given by employee ID ${invitation.fk_employee_id} via ${method}`,
      entityType: 'employee',
      entityId: String(invitation.fk_employee_id),
      source: 'remote_enrollment',
    }).catch(() => {});
  } else if (invitation.fk_person_id) {
    await repo.updatePersonConsent(invitation.fk_person_id, method);
    await repo.insertPersonBiometricConsent(invitation.fk_person_id, invitation.mt_tenant_id, method);

    await writeAudit({
      req: fakeReq,
      action: 'person.consent_given',
      details: `GDPR consent given by visitor ID ${invitation.fk_person_id} via ${method}`,
      entityType: 'person',
      entityId: String(invitation.fk_person_id),
      source: 'remote_enrollment',
    }).catch(() => {});
  }
}

// Calls the local AdaFace quality service (face_quality_service.py, port
// FACE_QUALITY_PORT/5050) and returns its scoring — shared by uploadAngle
// (which persists the result) and checkPose (which doesn't persist anything,
// used for live pose guidance while the camera is still open).
async function scoreFrameQuality(fileBuffer, angle) {
  let quality = null;
  let qualityMeta = {};
  try {
    const QUALITY_SVC = `http://127.0.0.1:${process.env.FACE_QUALITY_PORT || 5050}`;
    const formPayload = new FormData();
    formPayload.append('image', new Blob([fileBuffer], { type: 'image/jpeg' }), `${angle}.jpg`);
    formPayload.append('angle', angle);
    // Named explicitly rather than relying on the sidecar's QUALITY_ENGINE env
    // var: the enrollment UI's pose gates are calibrated to MediaPipe's real
    // head-pose degrees, and InsightFace's scale is both different and
    // sign-inverted on yaw. A host that hadn't set the env var would serve the
    // wrong scale here and silently make most capture angles unreachable.
    formPayload.append('engine', 'mediapipe');
    const qResp = await fetch(`${QUALITY_SVC}/quality`, {
      method: 'POST',
      body: formPayload,
      signal: AbortSignal.timeout(8000),
    });
    if (qResp.ok) {
      const qData = await qResp.json();
      quality = typeof qData.confidence === 'number' ? qData.confidence : null;
      qualityMeta = {
        face_detected:    qData.face_detected,
        multiple_faces_detected: qData.multiple_faces_detected,
        fully_visible:    qData.fully_visible,
        partial_face:     qData.partial_face,
        glasses_detected: qData.glasses_detected,
        mask_detected:    qData.mask_detected,
        occlusion_detected: qData.occlusion_detected,
        det_score:        qData.det_score,
        sharpness:        qData.sharpness,
        brightness:       qData.brightness,
        face_size_pct:    qData.face_size_pct,
        pose:             qData.pose,
        face_center_offset: qData.face_center_offset,
        elapsed_ms:       qData.elapsed_ms,
      };
      logger.info(`✅ AdaFace quality for ${angle}: ${quality} (${qData.elapsed_ms}ms)`);
    } else {
      logger.warn(`⚠️ face-quality-svc returned ${qResp.status} for ${angle}`);
    }
  } catch (qErr) {
    logger.warn(`⚠️ face-quality-svc unreachable for ${angle}: ${qErr.message}`);
  }
  return { quality, qualityMeta };
}

// Live pose check — called repeatedly while the camera is open, BEFORE the
// user actually captures a photo. Unlike uploadAngle, this never writes to
// S3 or the invitation record; it only exists to tell the frontend "turn
// left more" / "look up" in real time. Token is still verified so this
// public endpoint can't be hit without a live invitation link.
export async function checkPose({ token, angle, fileBuffer }) {
  jwt.verify(token, ENROLLMENT_TOKEN_SECRET);
  const { quality, qualityMeta } = await scoreFrameQuality(fileBuffer, angle);
  return {
    face_detected:    qualityMeta.face_detected ?? null,
    multiple_faces_detected: qualityMeta.multiple_faces_detected ?? null,
    fully_visible:    qualityMeta.fully_visible ?? null,
    partial_face:     qualityMeta.partial_face ?? null,
    glasses_detected: qualityMeta.glasses_detected ?? null,
    mask_detected:    qualityMeta.mask_detected ?? null,
    occlusion_detected: qualityMeta.occlusion_detected ?? null,
    pose: qualityMeta.pose ?? null,
    face_size_pct: qualityMeta.face_size_pct ?? null,
    face_center_offset: qualityMeta.face_center_offset ?? null,
    quality,
  };
}

export async function uploadAngle({ token, angle, fileBuffer }) {
  jwt.verify(token, ENROLLMENT_TOKEN_SECRET);

  const invitation = await repo.getInvitationForUpload(token);
  if (!invitation) throw new NotFoundError('Invitation not found');

  const consentGivenAt = invitation.fk_employee_id ? invitation.emp_consent_given_at : invitation.vis_consent_given_at;
  const consentWithdrawnAt = invitation.fk_employee_id ? invitation.emp_consent_withdrawn_at : invitation.vis_consent_withdrawn_at;

  if (!consentGivenAt || consentWithdrawnAt) {
    const err = new Error('GDPR consent is required before uploading enrollment photos.');
    err.statusCode = 400;
    throw err;
  }

  // ── FIX-008: Replace MD5 with SHA-256 HMAC for liveness/duplicate check ──
  const { generatePhotoIntegrityToken } = await import('../../utils/photoIntegrity.js');
  const { createHash, timingSafeEqual } = await import('crypto');

  // Anti-spoofing: block identical photos across angles (static image reuse)
  const uploadedSha256 = createHash('sha256').update(fileBuffer).digest('hex');
  const existingPhotoPaths = invitation.photo_paths || {};
  for (const [existingAngle, existingKey] of Object.entries(existingPhotoPaths)) {
    if (existingAngle !== angle) {
      try {
        const existingBuf = await storage.getFileBuffer(storage.USER_DATA_BUCKET, existingKey);
        const existingSha256 = createHash('sha256').update(existingBuf).digest('hex');
        const eBuf = Buffer.from(existingSha256, 'hex');
        const uBuf = Buffer.from(uploadedSha256, 'hex');
        if (eBuf.length === uBuf.length && timingSafeEqual(eBuf, uBuf)) {
          logger.warn(
            `[enrollment-liveness] Spoofing attempt blocked — identical photo ` +
            `for ${angle} and ${existingAngle} (employee: ${invitation.employee_code})`
          );
          const err = new Error('Liveness check failed: duplicate static photo detected.');
          err.statusCode = 400;
          throw err;
        }
      } catch (err) {
        if (err.statusCode === 400) throw err;
        // else: existing object unreadable — ignore and continue
      }
    }
  }

  // Permanent user-data bucket. Keyed by employee_code when this invitation
  // is for an employee; falls back to the invitation's person/employee id
  // for person-based (visitor-enrollment) invitations, which employee_code
  // doesn't cover. Filename is stable per angle (not timestamped) so a
  // re-upload of the same angle replaces it in place rather than
  // accumulating stale objects — matches "keep the bucket clean" intent.
  const employeeIdentifier = invitation.employee_code
    || invitation.fk_person_id
    || invitation.fk_employee_id
    || invitation.pk_invitation_id;
  // Includes employeeIdentifier, not just the angle: /api/jetson/photos/:filename
  // (used to serve these once attached to an embedding) only ever receives a
  // bare basename — the frontend's resolvePhotoPath strips any directory
  // portion before requesting it — so two employees both having an
  // "image_front.jpg" would collide and the wrong employee's photo could be
  // served. The S3 key's directory prefix (below) already disambiguates by
  // employee for storage purposes, but that's invisible to the basename-only
  // lookup, so the filename itself has to be unique too.
  const filename = `image_${sanitizeForKey(String(employeeIdentifier))}_${sanitizeForKey(angle)}.jpg`;
  const photoKey = buildUserDataKey({
    tenantId: invitation.mt_tenant_id,
    employeeCode: employeeIdentifier,
    section: 'enrollment',
    filename,
  });
  await storage.uploadFile(storage.USER_DATA_BUCKET, photoKey, fileBuffer, 'image/jpeg');

  // The "front" angle also doubles as the employee's profile photo (employee
  // invitations only — visitor/person invitations have no profile concept).
  if (angle === 'front' && invitation.employee_code) {
    const profileKey = buildUserDataKey({
      tenantId: invitation.mt_tenant_id,
      employeeCode: employeeIdentifier,
      section: 'profile',
      filename: 'profile.jpg',
    });
    await storage.uploadFile(storage.USER_DATA_BUCKET, profileKey, fileBuffer, 'image/jpeg');
  }

  const integrityToken = generatePhotoIntegrityToken(
    fileBuffer,
    String(invitation.pk_invitation_id),
    angle
  );

  // ── AdaFace quality scoring (immediate, live) ────────────────────────────────────────────────
  const { quality, qualityMeta } = await scoreFrameQuality(fileBuffer, angle);

  const currentPhotoPaths = invitation.photo_paths || {};
  const currentQualities = invitation.quality_scores || {};
  const currentIntegrityTokens = invitation.photo_integrity_tokens || {};

  currentPhotoPaths[angle] = photoKey;
  currentQualities[angle] = quality;
  currentIntegrityTokens[angle] = integrityToken;

  await repo.updateInvitationPhotoData(invitation.pk_invitation_id, {
    photoPaths: currentPhotoPaths, qualityScores: currentQualities, integrityTokens: currentIntegrityTokens,
  });

  logger.info(`📷 Photo saved for ${angle} (invitation ${invitation.pk_invitation_id}) quality=${quality ?? 'pending'}`);

  return {
    success: true,
    quality,
    quality_pending: quality === null,
    face_detected: qualityMeta.face_detected ?? null,
    multiple_faces_detected: qualityMeta.multiple_faces_detected ?? null,
    quality_meta: qualityMeta,
    message: quality !== null
      ? 'Photo captured and scored'
      : 'Photo saved — quality scoring temporarily unavailable',
  };
}

export async function completeEnrollment(token) {
  jwt.verify(token, ENROLLMENT_TOKEN_SECRET);

  const invitation = await repo.getInvitationForComplete(token);
  if (!invitation) throw new NotFoundError('Invitation not found');

  const qualityScores = invitation.quality_scores || {};

  const allAngles = Object.keys(invitation.photo_paths || {});
  const scoredValues = allAngles
    .map(a => qualityScores[a])
    .filter(v => typeof v === 'number');

  const avgQuality = scoredValues.length > 0
    ? scoredValues.reduce((sum, q) => sum + q, 0) / scoredValues.length
    : 0;

  // Mandatory HR manual approval: all submitted enrollments must be reviewed and approved by HR
  const approvalStatus = 'pending';

  await repo.markInvitationCompleted(invitation.pk_invitation_id, { avgQuality, approvalStatus });

  await writeAudit({
    req: { user: { id: null }, headers: {}, ip: '' },
    action: 'enrollment.completed',
    details: `${invitation.full_name} (${invitation.employee_code}) completed remote enrollment (avg quality: ${(avgQuality * 100).toFixed(0)}%)`,
    entityType: invitation.fk_employee_id ? 'employee' : 'person',
    entityId: String(invitation.fk_employee_id || invitation.fk_person_id),
    entityName: invitation.full_name,
    after: { avgQuality, approvalStatus },
    source: 'remote_enrollment',
  });

  try {
    await createSystemNotification({
      tenant_id: invitation.mt_tenant_id,
      site_id: invitation.site_id,
      customer_id: invitation.customer_id,
      alert_type: 'EMPLOYEE_ENROLLMENT_SUBMITTED',
      severity: 'info',
      title: 'Enrollment Pending Review',
      message: `${invitation.full_name} (${invitation.employee_code}) has submitted their remote enrollment.`,
      fk_employee_id: invitation.fk_employee_id,
    });
  } catch (err) {
    logger.error('Failed to create notification on enrollment submit', err);
  }

  return {
    success: true,
    averageQuality: avgQuality,
    approvalStatus,
    qualityScores,
    message: 'Enrollment submitted — pending HR review.',
  };
}

/**
 * Helper: create face embeddings from stored photos.
 * Returns the number of embeddings created.
 * Never throws — if Jetson is unreachable the invitation is marked
 * 'pending_embedding' so the Jetson can process it on next contact.
 */
async function createEmbeddingsFromPhotos(invitation) {
  const photoPaths = invitation.photo_paths || {};
  const qualityScores = invitation.quality_scores || {};

  const dev = await repo.findActiveJetsonDevice(invitation.mt_tenant_id);
  const deviceId = dev?.pk_device_id;
  const jetsonBase = await getJetsonUrl(invitation.mt_tenant_id).catch(() => null);

  if (!deviceId) {
    logger.warn(`⚠️ No active Jetson for tenant ${invitation.mt_tenant_id} — embeddings deferred`);
    await repo.markInvitationPendingEmbeddingOnly(invitation.pk_invitation_id);
    return 0;
  }

  // ── VERIFY PHOTO INTEGRITY ──
  const integrityTokens = invitation.photo_integrity_tokens || {};
  let integrityFailed = false;
  let tamperedAngle = null;

  const { verifyPhotoIntegrityToken } = await import('../../utils/photoIntegrity.js');

  for (const [angle, photoPath] of Object.entries(photoPaths)) {
    try {
      const imgBuf = await storage.getFileBuffer(storage.USER_DATA_BUCKET, photoPath);
      const storedToken = integrityTokens[angle];
      if (!verifyPhotoIntegrityToken(imgBuf, String(invitation.pk_invitation_id), angle, storedToken)) {
        integrityFailed = true;
        tamperedAngle = angle;
        break;
      }
    } catch (err) {
      logger.error(`[Security] Error reading file for integrity check: ${photoPath}`, err);
      integrityFailed = true;
      tamperedAngle = angle;
      break;
    }
  }

  if (integrityFailed) {
    logger.error(`[Security] Photo integrity check failed for invitation ${invitation.pk_invitation_id}, angle ${tamperedAngle}`);
    await repo.markInvitationEmbeddingFailed(
      invitation.pk_invitation_id,
      `Photo integrity check failed for angle '${tamperedAngle}'. The enrollment photos may have been modified.`
    );
    return 0;
  }

  // Delete existing embeddings before re-creating
  if (invitation.fk_employee_id) {
    await repo.deleteEmployeeFaceEmbeddings(invitation.fk_employee_id);

    try {
      const { default: faceDB } = await import('../../core/db/FaceDB.js');
      await faceDB.deleteEmployeeFaces(invitation.fk_employee_id);
      logger.info(`[enrollment] Cleaned SQLite face cache for employee ID: ${invitation.fk_employee_id}`);
    } catch (dbErr) {
      logger.warn('[enrollment] Failed to clean SQLite face cache:', dbErr.message);
    }
  } else if (invitation.fk_person_id) {
    await repo.deletePersonFaceEmbeddings(invitation.fk_person_id);
  }

  let created = 0;
  let directCallFailed = false;
  let isDuplicate = false;
  const successfulAngles = new Set();

  if (jetsonBase) {
    for (const [angle, photoPath] of Object.entries(photoPaths)) {
      const quality = qualityScores[angle] || 0;
      try {
        const imgBuf = await storage.getFileBuffer(storage.USER_DATA_BUCKET, photoPath);
        const formPayload = new FormData();
        formPayload.append('image', new Blob([imgBuf], { type: 'image/jpeg' }), `${angle}.jpg`);

        const resp = await fetch(`${jetsonBase}/enroll-image`, {
          method: 'POST',
          body: formPayload,
          signal: AbortSignal.timeout(5000),
        });

        if (!resp.ok) {
          logger.warn(`⚠️ Jetson returned ${resp.status} for ${angle}`);
          directCallFailed = true;
          continue;
        }

        const jetsonData = await resp.json().catch(() => ({}));
        if (!jetsonData?.embedding || jetsonData.embedding.length !== 512) {
          logger.warn(`⚠️ No valid 512-d embedding from Jetson for ${angle}: ${jetsonData?.error || 'unknown'}`);
          directCallFailed = true;
          continue;
        }

        const modelVersion = jetsonData.model_version
          || process.env.JETSON_MODEL_VERSION
          || 'arcface-r50-fp16';

        const embeddingStr = `[${jetsonData.embedding.join(',')}]`;

        // ── CHECK FOR DUPLICATE ENROLLMENT ──
        let duplicateCheck = [];
        if (invitation.fk_employee_id) {
          duplicateCheck = await repo.findDuplicateEmployeeEmbedding(embeddingStr, invitation.fk_employee_id, modelVersion);
        } else if (invitation.fk_person_id) {
          duplicateCheck = await repo.findDuplicatePersonEmbedding(embeddingStr, invitation.fk_person_id, modelVersion);
        }

        if (duplicateCheck.length > 0) {
          logger.warn(`Duplicate face detected for angle ${angle}: already registered to ${duplicateCheck[0].full_name}`);
          isDuplicate = true;
          await repo.markInvitationEmbeddingFailed(
            invitation.pk_invitation_id,
            `This face is already registered in the system under a different name (${duplicateCheck[0].full_name}).`
          );
          break;
        }

        if (invitation.fk_employee_id) {
          await repo.insertEmployeeFaceEmbedding({ employeeId: invitation.fk_employee_id, embeddingStr, angle, quality, modelVersion, photoPath });
        } else if (invitation.fk_person_id) {
          await repo.insertPersonFaceEmbedding({ personId: invitation.fk_person_id, embeddingStr, modelVersion, quality, photoPath });
        }
        logger.info(`✅ Embedding created for ${angle} (quality=${quality}, model=${modelVersion})`);
        created++;
        successfulAngles.add(angle);
      } catch (err) {
        logger.warn(`⚠️ Direct embedding failed for ${angle}: ${err.message}`);
        directCallFailed = true;
      }
    }
  } else {
    directCallFailed = true;
  }

  // If direct connection failed for ANY angle, queue commands for Jetson to pull those specific angles
  if (directCallFailed && !isDuplicate) {
    logger.info(`📋 Direct connection to Jetson unavailable or partially failed for tenant ${invitation.mt_tenant_id}. Queueing 'enroll_from_photo' commands for failed angles.`);

    for (const [angle, photoPath] of Object.entries(photoPaths)) {
      if (!successfulAngles.has(angle)) {
        // photoPath is an S3 key (USER_DATA_BUCKET), not a local file — since
        // the S3 storage migration, enrollment photos are never written to
        // local disk at all. This used to hardcode a /uploads/remote-enrollment/
        // URL, which (a) 401'd for devices anyway because that route only
        // accepts user Bearer tokens, not device JWTs, and (b) pointed at a
        // file that no longer exists locally regardless of auth. A pre-signed
        // S3 URL needs no bearer token of any kind and matches the actual
        // storage location. 24h TTL — commands can sit in the device's queue
        // for a while if it was offline when this was generated.
        const photoUrl = await storage.getDownloadUrl(storage.USER_DATA_BUCKET, photoPath, 24 * 60 * 60);

        await repo.insertEnrollFromPhotoCommand({
          deviceId,
          payload: {
            employee_id: invitation.fk_employee_id || null,
            person_id: invitation.fk_person_id || null,
            employee_code: invitation.employee_code,
            full_name: invitation.full_name,
            photo_url: photoUrl,
            photo_key: photoPath,
            angle: angle,
            requested_by: "system_remote_enroll",
          },
        });
      }
    }

    await repo.markInvitationPendingEmbeddingAndStatus(invitation.pk_invitation_id);

    if (created === 0) return 0;
  }

  logger.info(`Created ${created}/${Object.keys(photoPaths).length} embeddings for ${invitation.fk_employee_id ? 'employee ' + invitation.fk_employee_id : 'person ' + invitation.fk_person_id}`);

  let embeddingStatus = 'success';
  if (isDuplicate) {
    embeddingStatus = 'failed';
  } else if (created === 0) {
    embeddingStatus = 'failed';
  } else if (created < Object.keys(photoPaths).length) {
    embeddingStatus = 'partial_success';
  }

  await repo.updateInvitationEmbeddingStatus(invitation.pk_invitation_id, embeddingStatus);

  return created;
}
