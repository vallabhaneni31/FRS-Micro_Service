import { pool } from '../db/pool.js';
import { buildScopeWhere } from './scopeSql.js';

// ============================================================================
// LIST / INVITATIONS
// ============================================================================

export async function listInvitationsForTenant(tenantId) {
  const { rows } = await pool.query(`
    SELECT inv.pk_invitation_id as id, inv.status, inv.approval_status,
           inv.sent_at, inv.expires_at, inv.completed_at,
           e.full_name, e.employee_code
    FROM enrollment_invitations inv
    JOIN hr_employee e ON e.pk_employee_id = inv.fk_employee_id
    WHERE e.tenant_id = $1::uuid
    ORDER BY inv.sent_at DESC
    LIMIT 100
  `, [tenantId]);
  return rows;
}

export async function findEmployeesForInvite(employeeIds, tenantId) {
  const { rows } = await pool.query(
    `SELECT pk_employee_id, employee_code, full_name, email, phone_number
     FROM hr_employee
     WHERE pk_employee_id = ANY($1::int[]) AND tenant_id = $2`,
    [employeeIds, tenantId]
  );
  return rows;
}

export async function findActiveOrCompletedEmployeeIds(employeeIds) {
  if (employeeIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT fk_employee_id FROM enrollment_invitations
     WHERE fk_employee_id = ANY($1::int[]) AND status = 'completed'
       AND approval_status IN ('auto_approved','manually_approved','pending','pending_embedding')`,
    [employeeIds]
  );
  return rows.map(r => r.fk_employee_id);
}

// Distinct from a genuine timeout: this fires when a *new* invitation is
// about to be sent to someone who already has one in flight, so the old
// link needs to stop working. Marked 'superseded' rather than 'expired' (and
// its real expires_at left untouched) so getPublicInvitation can tell the
// employee their old link was replaced by a newer one, instead of claiming
// it timed out.
export async function expirePendingInvitations(employeeIds) {
  if (employeeIds.length === 0) return;
  await pool.query(
    `UPDATE enrollment_invitations
     SET status = 'superseded', updated_at = NOW()
     WHERE fk_employee_id = ANY($1::int[])
       AND status IN ('pending', 'opened', 'in_progress')
       AND expires_at > NOW()`,
    [employeeIds]
  );
}

export async function insertInvitation({ employeeId, tenantId, customerId, siteId, token, expiresAt }) {
  const { rows } = await pool.query(
    `INSERT INTO enrollment_invitations (
      fk_employee_id,
      mt_tenant_id,
      customer_id,
      site_id,
      invitation_token,
      expires_at
    ) VALUES ($1, $2::uuid, $3, $4, $5, $6)
    RETURNING pk_invitation_id`,
    [employeeId, tenantId, customerId, siteId, token, expiresAt]
  );
  return rows[0].pk_invitation_id;
}

export async function deleteInvitation(invitationId) {
  await pool.query(`DELETE FROM enrollment_invitations WHERE pk_invitation_id = $1`, [invitationId]);
}

export async function listInvitationsWithFilter(tenantId, limit) {
  const { rows } = await pool.query(
    `SELECT * FROM (
      SELECT DISTINCT ON (ei.fk_employee_id)
        ei.pk_invitation_id,
        ei.fk_employee_id,
        e.employee_code,
        e.full_name,
        e.email,
        ei.status,
        ei.approval_status,
        ei.average_quality,
        ei.sent_at,
        ei.expires_at,
        ei.opened_at,
        ei.completed_at,
        ei.quality_scores,
        CASE
          WHEN ei.status = 'superseded' THEN 'expired'
          WHEN ei.expires_at < NOW() AND ei.status NOT IN ('completed') THEN 'expired'
          WHEN ei.status = 'completed' AND ei.approval_status IN ('auto_approved','manually_approved') THEN 'approved'
          WHEN ei.status = 'completed' AND ei.approval_status = 'pending_embedding' THEN 'pending_embedding'
          WHEN ei.status = 'completed' AND ei.approval_status = 'rejected' THEN 'rejected'
          WHEN ei.status = 'completed' AND ei.approval_status = 'pending' THEN 'completed'
          ELSE ei.status
        END AS display_status,
        CASE
          WHEN ei.status = 'completed' AND ei.approval_status IN ('auto_approved','manually_approved') THEN 1
          WHEN ei.status = 'completed' AND ei.approval_status = 'pending_embedding' THEN 2
          WHEN ei.status = 'completed' AND ei.approval_status = 'pending' THEN 3
          WHEN ei.status IN ('in_progress', 'opened', 'pending') AND ei.expires_at > NOW() THEN 4
          WHEN ei.status = 'completed' AND ei.approval_status = 'rejected' THEN 5
          ELSE 6
        END AS status_priority
      FROM enrollment_invitations ei
      JOIN hr_employee e ON e.pk_employee_id = ei.fk_employee_id
      WHERE ei.mt_tenant_id = $1::uuid
      ORDER BY ei.fk_employee_id,
        CASE
          WHEN ei.status = 'completed' AND ei.approval_status IN ('auto_approved','manually_approved') THEN 1
          WHEN ei.status = 'completed' AND ei.approval_status = 'pending_embedding' THEN 2
          WHEN ei.status = 'completed' AND ei.approval_status = 'pending' THEN 3
          WHEN ei.status IN ('in_progress', 'opened', 'pending') AND ei.expires_at > NOW() THEN 4
          WHEN ei.status = 'completed' AND ei.approval_status = 'rejected' THEN 5
          ELSE 6
        END ASC,
        ei.created_at DESC
    ) latest
    ORDER BY latest.sent_at DESC
    LIMIT $2`,
    [tenantId, limit]
  );
  return rows;
}

export async function listEmployeesWithEnrollmentStatus(scope) {
  // useArrayForSite=true: hr_employee can belong to multiple sites (site_ids
  // array) with site_id kept in sync as the primary one — same scoping
  // pattern as EmployeeService.js / ReportService.js / liveRepository.js.
  const { whereSql, values } = buildScopeWhere(scope, 'e', true);
  const { rows } = await pool.query(
    `SELECT
       e.pk_employee_id,
       e.employee_code,
       e.full_name,
       e.email,
       e.phone_number,
       e.status,
       COUNT(f.id)::int AS "embeddingCount",
       COUNT(f.id) > 0 AS enrolled
     FROM hr_employee e
     LEFT JOIN employee_face_embeddings f ON f.employee_id = e.pk_employee_id
     WHERE ${whereSql} AND e.status = 'active'
     GROUP BY e.pk_employee_id
     ORDER BY e.full_name`,
    values
  );
  return rows;
}

// ============================================================================
// RESEND
// ============================================================================

export async function getInvitationForResend(id) {
  const { rows } = await pool.query(
    `SELECT ei.*,
            COALESCE(e.full_name, p.full_name) as full_name,
            COALESCE(e.email, p.email) as email,
            COALESCE(e.employee_code, 'VISITOR') as employee_code,
            p.host_employee_id,
            p.visit_purpose,
            p.valid_from,
            p.valid_to
     FROM enrollment_invitations ei
     LEFT JOIN hr_employee e ON e.pk_employee_id = ei.fk_employee_id
     LEFT JOIN person p ON p.person_id = ei.fk_person_id
     WHERE ei.pk_invitation_id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function updateInvitationForResend(id, { token, expiresAt }) {
  await pool.query(
    `UPDATE enrollment_invitations
     SET invitation_token=$1, expires_at=$2, status='pending', opened_at=NULL, updated_at=NOW()
     WHERE pk_invitation_id=$3`,
    [token, expiresAt, id]
  );
}

export async function getHostEmployeeName(hostEmployeeId) {
  const { rows } = await pool.query(
    `SELECT full_name FROM hr_employee WHERE pk_employee_id = $1`,
    [hostEmployeeId]
  );
  return rows[0]?.full_name ?? null;
}

// ============================================================================
// APPROVE / REJECT
// ============================================================================

export async function getInvitationForApproval(id, tenantId) {
  const { rows } = await pool.query(
    `SELECT ei.*, e.employee_code, e.full_name
     FROM enrollment_invitations ei
     JOIN hr_employee e ON e.pk_employee_id = ei.fk_employee_id
     WHERE ei.pk_invitation_id = $1 AND ei.mt_tenant_id = $2::uuid`,
    [id, tenantId]
  );
  return rows[0] ?? null;
}

export async function markInvitationPendingEmbedding(id, approvedBy) {
  await pool.query(
    `UPDATE enrollment_invitations
     SET approval_status = 'pending_embedding',
         approved_at = NOW(),
         approved_by = $1,
         updated_at = NOW()
     WHERE pk_invitation_id = $2`,
    [approvedBy, id]
  );
}

export async function markInvitationManuallyApproved(invitationId) {
  await pool.query(
    `UPDATE enrollment_invitations SET approval_status='manually_approved', updated_at=NOW() WHERE pk_invitation_id=$1`,
    [invitationId]
  );
}

export async function getPendingApprovals(tenantId) {
  const { rows } = await pool.query(
    `SELECT * FROM (
      SELECT DISTINCT ON (ei.fk_employee_id)
        ei.pk_invitation_id,
        ei.fk_employee_id,
        e.employee_code,
        e.full_name,
        e.email,
        ei.average_quality,
        ei.quality_scores,
        ei.photo_paths,
        ei.completed_at,
        ei.approval_status,
        ei.device_info,
        CASE
          WHEN ei.status = 'completed' AND ei.approval_status IN ('auto_approved','manually_approved') THEN 1
          WHEN ei.status = 'completed' AND ei.approval_status = 'pending_embedding' THEN 2
          WHEN ei.status = 'completed' AND ei.approval_status = 'pending' THEN 3
          WHEN ei.status IN ('in_progress', 'opened', 'pending') AND ei.expires_at > NOW() THEN 4
          WHEN ei.status = 'completed' AND ei.approval_status = 'rejected' THEN 5
          ELSE 6
        END AS status_priority
      FROM enrollment_invitations ei
      JOIN hr_employee e ON e.pk_employee_id = ei.fk_employee_id
      WHERE ei.mt_tenant_id = $1::uuid
      ORDER BY ei.fk_employee_id,
        CASE
          WHEN ei.status = 'completed' AND ei.approval_status IN ('auto_approved','manually_approved') THEN 1
          WHEN ei.status = 'completed' AND ei.approval_status = 'pending_embedding' THEN 2
          WHEN ei.status = 'completed' AND ei.approval_status = 'pending' THEN 3
          WHEN ei.status IN ('in_progress', 'opened', 'pending') AND ei.expires_at > NOW() THEN 4
          WHEN ei.status = 'completed' AND ei.approval_status = 'rejected' THEN 5
          ELSE 6
        END ASC,
        ei.created_at DESC
    ) latest
    WHERE latest.approval_status = 'pending' AND latest.status_priority = 3
    ORDER BY latest.completed_at DESC`,
    [tenantId]
  );
  return rows;
}

export async function getInvitationForReject(id, tenantId) {
  const { rows } = await pool.query(
    `SELECT ei.*, e.employee_code, e.full_name, e.email
     FROM enrollment_invitations ei
     JOIN hr_employee e ON e.pk_employee_id = ei.fk_employee_id
     WHERE ei.pk_invitation_id = $1 AND ei.mt_tenant_id = $2::uuid`,
    [id, tenantId]
  );
  return rows[0] ?? null;
}

export async function markInvitationRejected(id, { reason, rejectedBy }) {
  await pool.query(
    `UPDATE enrollment_invitations
     SET approval_status = 'rejected',
         rejection_reason = $1,
         rejected_at = NOW(),
         rejected_by = $2,
         updated_at = NOW()
     WHERE pk_invitation_id = $3`,
    [reason, rejectedBy, id]
  );
}

// ============================================================================
// REVOKE
// ============================================================================

export async function getInvitationForRevoke(id) {
  const { rows } = await pool.query(
    `SELECT invitation_token, fk_employee_id, photo_paths
     FROM enrollment_invitations
     WHERE pk_invitation_id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function revokeInvitation(id, invitationToken) {
  await pool.query('BEGIN');
  if (invitationToken) {
    await pool.query(
      `INSERT INTO blacklisted_enrollment_tokens (token)
       VALUES ($1)
       ON CONFLICT DO NOTHING`,
      [invitationToken]
    );
  }
  await pool.query(
    `UPDATE enrollment_invitations
     SET status = 'expired', expires_at = NOW(), updated_at = NOW()
     WHERE pk_invitation_id = $1`,
    [id]
  );
  await pool.query('COMMIT');
}

// ============================================================================
// PUBLIC PORTAL (blacklist / progress / token lookup / consent / upload / complete)
// ============================================================================

export async function isTokenBlacklisted(token) {
  const { rows } = await pool.query(
    'SELECT 1 FROM blacklisted_enrollment_tokens WHERE token = $1 LIMIT 1',
    [token]
  );
  return rows.length > 0;
}

export async function getInvitationProgress(token) {
  const { rows } = await pool.query(
    `SELECT quality_scores, average_quality, approval_status
     FROM enrollment_invitations WHERE invitation_token=$1`,
    [token]
  );
  return rows[0] ?? null;
}

export async function getInvitationByToken(token) {
  const { rows } = await pool.query(
    `SELECT ei.*,
            COALESCE(e.full_name, p.full_name) as full_name,
            COALESCE(e.employee_code, 'VISITOR') as employee_code,
            COALESCE(e.email, p.email) as email
     FROM enrollment_invitations ei
     LEFT JOIN hr_employee e ON e.pk_employee_id = ei.fk_employee_id
     LEFT JOIN person p ON p.person_id = ei.fk_person_id
     WHERE ei.invitation_token = $1`,
    [token]
  );
  return rows[0] ?? null;
}

export async function markInvitationOpened(invitationId) {
  await pool.query(
    `UPDATE enrollment_invitations
     SET status = 'opened', opened_at = NOW()
     WHERE pk_invitation_id = $1`,
    [invitationId]
  );
}

export async function getInvitationForConsent(token) {
  const { rows } = await pool.query(
    `SELECT pk_invitation_id, fk_employee_id, fk_person_id, mt_tenant_id FROM enrollment_invitations
     WHERE invitation_token = $1`,
    [token]
  );
  return rows[0] ?? null;
}

export async function insertEmployeeBiometricConsent(employeeId, tenantId, method) {
  await pool.query(
    `INSERT INTO biometric_consent (fk_employee_id, tenant_id, consent_given, consent_method, consented_at)
     VALUES ($1, $2, true, $3, NOW())
     ON CONFLICT DO NOTHING`,
    [employeeId, tenantId, method]
  );
}

export async function updateEmployeeConsent(employeeId, method) {
  await pool.query(
    `UPDATE hr_employee
     SET consent_given_at = NOW(),
         consent_method = $1,
         consent_withdrawn_at = NULL
     WHERE pk_employee_id = $2`,
    [method, employeeId]
  );
}

export async function updatePersonConsent(personId, method) {
  await pool.query(
    `UPDATE person
     SET consent_given_at = NOW(),
         consent_method = $1,
         consent_withdrawn_at = NULL
     WHERE person_id = $2`,
    [method, personId]
  );
}

export async function insertPersonBiometricConsent(personId, tenantId, method) {
  await pool.query(
    `INSERT INTO biometric_consent (fk_person_id, tenant_id, consent_given, consent_method, consented_at)
     VALUES ($1, $2, true, $3, NOW())`,
    [personId, tenantId, method]
  );
}

export async function getInvitationForUpload(token) {
  const { rows } = await pool.query(
    `SELECT ei.*,
            e.employee_code, e.consent_given_at as emp_consent_given_at, e.consent_withdrawn_at as emp_consent_withdrawn_at,
            p.consent_given_at as vis_consent_given_at, p.consent_withdrawn_at as vis_consent_withdrawn_at
     FROM enrollment_invitations ei
     LEFT JOIN hr_employee e ON e.pk_employee_id = ei.fk_employee_id
     LEFT JOIN person p ON p.person_id = ei.fk_person_id
     WHERE ei.invitation_token = $1`,
    [token]
  );
  return rows[0] ?? null;
}

export async function updateInvitationPhotoData(id, { photoPaths, qualityScores, integrityTokens }) {
  await pool.query(
    `UPDATE enrollment_invitations
     SET photo_paths = $1,
         quality_scores = $2,
         photo_integrity_tokens = $4,
         status = CASE
           WHEN status = 'opened' OR status = 'pending' THEN 'in_progress'
           ELSE status
         END,
         started_at = COALESCE(started_at, NOW()),
         updated_at = NOW()
     WHERE pk_invitation_id = $3`,
    [JSON.stringify(photoPaths), JSON.stringify(qualityScores), id, JSON.stringify(integrityTokens)]
  );
}

export async function getInvitationForComplete(token) {
  const { rows } = await pool.query(
    `SELECT ei.*,
            COALESCE(e.full_name, p.full_name) as full_name,
            COALESCE(e.email, p.email) as email,
            COALESCE(e.employee_code, 'VISITOR') as employee_code
     FROM enrollment_invitations ei
     LEFT JOIN hr_employee e ON e.pk_employee_id = ei.fk_employee_id
     LEFT JOIN person p ON p.person_id = ei.fk_person_id
     WHERE ei.invitation_token = $1`,
    [token]
  );
  return rows[0] ?? null;
}

export async function getTenantQualityThreshold(tenantId) {
  const { rows } = await pool.query(
    `SELECT enabled_features FROM tenant_ui_config WHERE fk_tenant_id = $1::uuid`,
    [tenantId]
  );
  if (!rows.length) return null;
  const features = rows[0].enabled_features || {};
  return typeof features.face_quality_threshold === 'number' ? features.face_quality_threshold : null;
}

export async function markInvitationCompleted(id, { avgQuality, approvalStatus }) {
  await pool.query(
    `UPDATE enrollment_invitations
     SET status = 'completed',
         completed_at = NOW(),
         average_quality = $1,
         approval_status = $2,
         updated_at = NOW()
     WHERE pk_invitation_id = $3`,
    [avgQuality, approvalStatus, id]
  );
}

export async function markInvitationAutoApproved(invitationId) {
  await pool.query(
    `UPDATE enrollment_invitations SET approval_status='auto_approved', approved_at=NOW() WHERE pk_invitation_id=$1`,
    [invitationId]
  );
}

// ============================================================================
// EMBEDDING CREATION (createEmbeddingsFromPhotos helper)
// ============================================================================

export async function findActiveJetsonDevice(tenantId) {
  const { rows } = await pool.query(
    `SELECT fd.pk_device_id, fd.ip_address, fd.device_config
     FROM facility_device fd
     LEFT JOIN device_type dt ON dt.pk_device_type_id = fd.device_type_id
     WHERE fd.tenant_id = $1::uuid
       AND dt.category = 'edge_node'
       AND fd.status != 'decommissioned'
     ORDER BY fd.last_heartbeat DESC NULLS LAST LIMIT 1`,
    [tenantId]
  );
  return rows[0] ?? null;
}

export async function markInvitationPendingEmbeddingOnly(invitationId) {
  await pool.query(
    `UPDATE enrollment_invitations SET approval_status='pending_embedding' WHERE pk_invitation_id=$1`,
    [invitationId]
  );
}

export async function markInvitationEmbeddingFailed(invitationId, reason) {
  await pool.query(
    `UPDATE enrollment_invitations
     SET embedding_status = 'failed', approval_status = 'rejected', rejection_reason = $1, updated_at = NOW()
     WHERE pk_invitation_id = $2`,
    [reason, invitationId]
  ).catch(() => {});
}

export async function deleteEmployeeFaceEmbeddings(employeeId) {
  await pool.query('DELETE FROM employee_face_embeddings WHERE employee_id=$1', [employeeId]);
}

export async function deletePersonFaceEmbeddings(personId) {
  await pool.query('DELETE FROM person_face_embeddings WHERE person_id=$1', [personId]);
}

export async function findDuplicateEmployeeEmbedding(embeddingStr, employeeId, modelVersion) {
  const { rows } = await pool.query(
    `SELECT ef.employee_id, e.full_name
     FROM employee_face_embeddings ef
     JOIN hr_employee e ON e.pk_employee_id = ef.employee_id
     WHERE 1 - (ef.embedding <=> $1::vector) >= 0.50
       AND ef.employee_id != $2
       AND ef.model_version = $3
     LIMIT 1`,
    [embeddingStr, employeeId, modelVersion]
  );
  return rows;
}

export async function findDuplicatePersonEmbedding(embeddingStr, personId, modelVersion) {
  const { rows } = await pool.query(
    `SELECT pfe.person_id, p.full_name
     FROM person_face_embeddings pfe
     JOIN person p ON p.person_id = pfe.person_id
     WHERE 1 - (pfe.embedding <=> $1::vector) >= 0.50
       AND pfe.person_id != $2
       AND pfe.model_version = $3
     LIMIT 1`,
    [embeddingStr, personId, modelVersion]
  );
  return rows;
}

export async function insertEmployeeFaceEmbedding({ employeeId, embeddingStr, angle, quality, modelVersion, photoPath }) {
  await pool.query(
    `INSERT INTO employee_face_embeddings
     (employee_id, embedding, angle, quality_score, is_primary, model_version, photo_path, enrolled_at)
     VALUES ($1, $2::vector, $3, $4, $5, $6, $7, NOW())`,
    [employeeId, embeddingStr, angle, quality, angle === 'front', modelVersion, photoPath || null]
  );
}

export async function insertPersonFaceEmbedding({ personId, embeddingStr, modelVersion, quality, photoPath }) {
  await pool.query(
    `INSERT INTO person_face_embeddings
     (person_id, embedding, model_version, quality_score, photo_path, created_at)
     VALUES ($1, $2::vector, $3, $4, $5, NOW())`,
    [personId, embeddingStr, modelVersion, quality, photoPath]
  );
}

export async function insertEnrollFromPhotoCommand({ deviceId, payload }) {
  await pool.query(
    `INSERT INTO device_command_queue
       (device_id, command_type, command_payload, priority, expires_at)
     VALUES ($1, 'enroll_from_photo', $2::jsonb, 8, NOW() + INTERVAL '30 minutes')`,
    [deviceId, JSON.stringify(payload)]
  );
}

export async function markInvitationPendingEmbeddingAndStatus(invitationId) {
  await pool.query(
    `UPDATE enrollment_invitations
     SET approval_status='pending_embedding', embedding_status='pending'
     WHERE pk_invitation_id=$1`,
    [invitationId]
  );
}

export async function updateInvitationEmbeddingStatus(invitationId, status) {
  await pool.query(
    `UPDATE enrollment_invitations
     SET embedding_status = $1,
         updated_at = NOW()
     WHERE pk_invitation_id = $2`,
    [status, invitationId]
  ).catch(() => {});
}

// ============================================================================
// LIVE PROGRESS PANEL — GET /enroll/invitations/:id/progress
// ============================================================================

// LEFT JOIN (not INNER, unlike getInvitationForApproval) so person-based
// (visitor) invitations with no fk_employee_id still resolve.
export async function getInvitationForProgress(id, tenantId) {
  const { rows } = await pool.query(
    `SELECT ei.pk_invitation_id, ei.fk_employee_id, ei.fk_person_id,
            ei.photo_paths, ei.approval_status, ei.embedding_status,
            -- approved_at (set once, when Approve is clicked) is the correct
            -- "since" boundary — updated_at is unsuitable, it gets bumped
            -- again later when the invitation reaches auto_approved, i.e.
            -- AFTER the very embeddings we're trying to detect. Falls back to
            -- completed_at/created_at for invitations auto-approved at
            -- completion time (never went through the manual approve path).
            COALESCE(ei.approved_at, ei.completed_at, ei.created_at) AS since,
            e.employee_code, e.full_name
     FROM enrollment_invitations ei
     LEFT JOIN hr_employee e ON e.pk_employee_id = ei.fk_employee_id
     WHERE ei.pk_invitation_id = $1 AND ei.mt_tenant_id = $2::uuid`,
    [id, tenantId]
  );
  return rows[0] ?? null;
}

// Per-angle "embedded" ground truth — independent of the device_command_queue
// status field (which the findActiveEnrollFromPhotoCommand fix above makes
// trustworthy again, but embeddings are the real source of truth regardless).
export async function getEmployeeEmbeddingsSince(employeeId, since) {
  const { rows } = await pool.query(
    `SELECT angle, enrolled_at, quality_score
     FROM employee_face_embeddings
     WHERE employee_id = $1 AND enrolled_at >= $2`,
    [employeeId, since]
  );
  return rows;
}

// person_face_embeddings has no angle column (visitor enrollment isn't
// decomposed per-angle the way employee kiosk/remote enrollment is) — this
// only tells the caller "something landed", not which angle.
export async function getPersonEmbeddingsSince(personId, since) {
  const { rows } = await pool.query(
    `SELECT created_at, quality_score
     FROM person_face_embeddings
     WHERE person_id = $1 AND created_at >= $2`,
    [personId, since]
  );
  return rows;
}

// Per-angle queued/delivered state. `since` (invitation.updated_at at the
// moment approval was triggered) excludes stale command rows left over from
// a previous enrollment attempt for the same employee_code.
export async function getEnrollFromPhotoCommandsSince(employeeCode, since) {
  const { rows } = await pool.query(
    `SELECT pk_command_id, command_payload->>'angle' AS angle, status, created_at, executed_at
     FROM device_command_queue
     WHERE command_type = 'enroll_from_photo'
       AND command_payload->>'employee_code' = $1
       AND created_at >= $2
     ORDER BY created_at ASC`,
    [employeeCode, since]
  );
  return rows;
}

// ============================================================================
// ENROLLMENT REMINDERS
// ============================================================================

export async function getReminderSettings(tenantId) {
  const { rows } = await pool.query(
    `SELECT COALESCE((custom_settings->>'enrollment_reminders_enabled')::boolean, false) AS enabled,
            COALESCE((custom_settings->>'enrollment_reminder_hour')::int, 9) AS hour
     FROM tenant_settings WHERE fk_tenant_id = $1::uuid`,
    [tenantId]
  );
  return { enabled: rows[0]?.enabled ?? false, hour: rows[0]?.hour ?? 9 };
}

export async function setReminderSettings(tenantId, enabled, hour) {
  await pool.query(
    `UPDATE tenant_settings
     SET custom_settings = COALESCE(custom_settings, '{}'::jsonb)
                            || jsonb_build_object('enrollment_reminders_enabled', $2::boolean, 'enrollment_reminder_hour', $3::int)
     WHERE fk_tenant_id = $1::uuid`,
    [tenantId, enabled, hour]
  );
  return { enabled, hour };
}

// Tenants that currently have enrollment reminders switched on, with each
// tenant's configured local send hour (defaults to 9 AM if never set).
export async function listReminderEnabledTenants() {
  const { rows } = await pool.query(
    `SELECT fk_tenant_id AS tenant_id,
            COALESCE((custom_settings->>'enrollment_reminder_hour')::int, 9) AS hour
     FROM tenant_settings
     WHERE (custom_settings->>'enrollment_reminders_enabled')::boolean IS TRUE`
  );
  return rows.map(r => ({ tenantId: r.tenant_id, hour: r.hour }));
}

// Invitations still awaiting completion (sent, not expired, not finished),
// joined to the employee's site for timezone-aware local-9AM scheduling.
export async function getPendingReminderCandidates(tenantId) {
  const { rows } = await pool.query(
    `SELECT ei.pk_invitation_id, ei.invitation_token, ei.expires_at, ei.last_reminder_sent_at,
            e.full_name, e.email, s.timezone
     FROM enrollment_invitations ei
     JOIN hr_employee e ON e.pk_employee_id = ei.fk_employee_id
     LEFT JOIN frs_site s ON s.pk_site_id = e.site_ids[1]
     WHERE e.tenant_id = $1::uuid
       AND ei.status IN ('pending', 'opened', 'in_progress')
       AND ei.expires_at > NOW()
       AND e.email IS NOT NULL`,
    [tenantId]
  );
  return rows;
}

export async function markReminderSent(invitationId) {
  await pool.query(
    `UPDATE enrollment_invitations SET last_reminder_sent_at = NOW() WHERE pk_invitation_id = $1`,
    [invitationId]
  );
}

// Invitations HR explicitly picked from the Invitations tab to remind right
// now, regardless of local time/day dedup (that gate is for the automatic
// cron only — a manual send is an explicit one-off action).
export async function getInvitationsForManualReminder(invitationIds, tenantId) {
  const { rows } = await pool.query(
    `SELECT ei.pk_invitation_id, ei.invitation_token, ei.expires_at, ei.status,
            e.full_name, e.email
     FROM enrollment_invitations ei
     JOIN hr_employee e ON e.pk_employee_id = ei.fk_employee_id
     WHERE ei.pk_invitation_id = ANY($1::int[])
       AND e.tenant_id = $2::uuid`,
    [invitationIds, tenantId]
  );
  return rows;
}
