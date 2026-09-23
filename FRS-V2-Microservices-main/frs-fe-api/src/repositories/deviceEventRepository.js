import { pool } from '../db/pool.js';
import { resolveDeviceCodeAlias } from '../config/deviceCodeAliases.js';

// ============================================================================
// EVENT INGESTION (processEvent)
// ============================================================================

export async function findLegacyDeviceByCode(deviceCode) {
  const result = await pool.query(
    'SELECT pk_device_id FROM public.devices WHERE device_code = $1 LIMIT 1',
    [resolveDeviceCodeAlias(deviceCode)]
  );
  return result.rows[0]?.pk_device_id ?? null;
}

export async function insertLegacyDevice(deviceCode) {
  deviceCode = resolveDeviceCodeAlias(deviceCode);
  const result = await pool.query(
    `INSERT INTO public.devices (device_code, device_name, status)
     VALUES ($1, $1, 'online')
     RETURNING pk_device_id`,
    [deviceCode]
  );
  return result.rows[0].pk_device_id;
}

export async function insertDeviceEvent({ fkDeviceId, deviceCode, tenantId, dbEventType, payload }) {
  const result = await pool.query(
    `INSERT INTO device_events (fk_device_id, device_code, tenant_id, event_type, payload_json, occurred_at, processed, payload, processing_status)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5::jsonb, NOW(), false, $5::jsonb, 'processing')
     RETURNING pk_event_id`,
    [fkDeviceId, deviceCode, tenantId, dbEventType, JSON.stringify(payload)]
  );
  return result.rows[0]?.pk_event_id;
}

export async function touchDeviceLastSeen(deviceCode, tenantId) {
  await pool.query(
    `UPDATE facility_device SET last_active = NOW(), last_heartbeat = NOW()
     WHERE external_device_id = $1 AND tenant_id = $2::uuid`,
    [deviceCode, tenantId]
  );
}

export async function markEventProcessed(eventId) {
  await pool.query(
    `UPDATE device_events
     SET processed = true,
         processing_status = 'completed',
         processed_at = NOW()
     WHERE pk_event_id = $1`,
    [eventId]
  );
}

export async function markEventFailed(eventId, errorMessage) {
  await pool.query(
    `UPDATE device_events
     SET processed = false,
         processing_status = 'failed',
         processing_error = $2,
         processed_at = NOW()
     WHERE pk_event_id = $1`,
    [eventId, errorMessage]
  );
}

// ============================================================================
// HEARTBEAT
// ============================================================================

export async function updateFacilityDeviceHeartbeat({ deviceCode, tenantId, status, firmwareVersion, telemetry }) {
  await pool.query(
    `UPDATE facility_device
        SET status = $3,
            model = COALESCE($4, model),
            device_config = COALESCE(device_config, '{}'::jsonb) || $5::jsonb
      WHERE external_device_id = $1 AND tenant_id = $2::uuid`,
    [deviceCode, tenantId, status, firmwareVersion || null, JSON.stringify(telemetry)]
  );
}

export async function cascadeChildCamerasOnline(deviceCode, tenantId) {
  await pool.query(
    `UPDATE facility_device
     SET status = 'online',
         last_active = NOW(),
         last_heartbeat = NOW()
     WHERE parent_device_id = (
       SELECT pk_device_id FROM facility_device
       WHERE external_device_id = $1 AND tenant_id = $2::uuid LIMIT 1
     ) AND decommissioned_at IS NULL`,
    [deviceCode, tenantId]
  ).catch(() => {});
}

export async function insertHeartbeatHistory({ deviceCode, status, telemetry, tenantId }) {
  await pool.query(
    `INSERT INTO device_heartbeat (device_id, status, metrics, timestamp)
     SELECT pk_device_id, $2, $3::jsonb, NOW()
     FROM facility_device
     WHERE external_device_id = $1 AND tenant_id::text = $4
     ON CONFLICT DO NOTHING`,
    [deviceCode, status, JSON.stringify(telemetry), tenantId]
  ).catch(() => {}); // Ignore if table doesn't exist
}

export async function findDeviceForOfflineNotification(deviceCode, tenantId) {
  const result = await pool.query(
    `SELECT pk_device_id, name, site_id FROM facility_device WHERE external_device_id = $1 AND tenant_id = $2::uuid`,
    [deviceCode, tenantId]
  );
  return result.rows[0] ?? null;
}

// ============================================================================
// BREAK DURATION CALCULATION
// ============================================================================

export async function listAttendancePingsForDay({ tenantId, employeeId, siteTz, dateStr }) {
  const result = await pool.query(
    `SELECT direction, occurred_at FROM attendance_ping
     WHERE tenant_id = $1::uuid AND fk_employee_id = $2
       AND (occurred_at AT TIME ZONE $3)::date = $4::date
     ORDER BY occurred_at ASC`,
    [tenantId, employeeId, siteTz, dateStr]
  );
  return result.rows;
}

export async function updateAttendanceBreakDuration({ breakMinutes, tenantId, employeeId, dateStr }) {
  await pool.query(
    `UPDATE attendance_record
     SET break_duration_minutes = CASE
           WHEN $1::integer > 0 THEN $1::integer
           WHEN check_in IS NOT NULL AND check_out IS NOT NULL
             AND check_out > check_in
             AND EXTRACT(EPOCH FROM (check_out - check_in)) / 60 >= 60
           THEN 30
           ELSE $1::integer
         END,
         duration_minutes = CASE
           WHEN check_in IS NOT NULL AND check_out IS NOT NULL AND check_out > check_in
           THEN ROUND(EXTRACT(EPOCH FROM (check_out - check_in)) / 60)
           ELSE NULL
         END,
         working_hours = CASE
           WHEN check_in IS NOT NULL AND check_out IS NOT NULL AND check_out > check_in
           THEN GREATEST(0, ROUND(
             EXTRACT(EPOCH FROM (check_out - check_in)) / 3600.0
             - (CASE
                  WHEN $1::integer > 0 THEN $1::numeric
                  WHEN EXTRACT(EPOCH FROM (check_out - check_in)) / 60 >= 60 THEN 30::numeric
                  ELSE 0::numeric
                END) / 60.0,
             2
           ))
           ELSE 0.00
         END
     WHERE tenant_id = $2::uuid AND fk_employee_id = $3 AND attendance_date = $4::date`,
    [breakMinutes, tenantId, employeeId, dateStr]
  );
}

// ============================================================================
// FACE RECOGNIZED
// ============================================================================

export async function getSiteTimezoneForDevice(deviceCode, tenantId) {
  const result = await pool.query(
    `SELECT s.timezone FROM frs_site s
     JOIN facility_device fd ON fd.site_id = s.pk_site_id
     WHERE fd.external_device_id = $1 AND fd.tenant_id = $2::uuid`,
    [deviceCode, tenantId]
  );
  return result.rows[0]?.timezone ?? null;
}

export async function getTenantVertical(tenantId) {
  const result = await pool.query(
    `SELECT vertical FROM tenants WHERE pk_tenant_id = $1::uuid`,
    [tenantId]
  );
  return result.rows[0]?.vertical ?? null;
}

export async function findStudentByIdentifier({ tenantId, identifierCode, identifierId }) {
  const result = await pool.query(
    `SELECT pk_student_id, roll_number, name FROM edu_student
     WHERE fk_tenant_id = $1::uuid AND (roll_number = $2 OR pk_student_id::text = $3)
     LIMIT 1`,
    [tenantId, identifierCode || '', identifierId?.toString() || '0']
  );
  return result.rows[0] ?? null;
}

export async function insertStudentPresencePing({ tenantId, studentId, deviceCode, direction, confidence, ts }) {
  await pool.query(
    `INSERT INTO attendance_ping (tenant_id, fk_student_id, device_code, direction, confidence, occurred_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
    [tenantId, studentId, deviceCode, direction || null, confidence || null, ts]
  );
}

export async function upsertStudentAttendanceCheckin({ studentId, tenantId, dateStr, ts, deviceCode, confidence }) {
  await pool.query(
    `INSERT INTO student_attendance
       (fk_student_id, fk_tenant_id, attendance_date, status, check_in_at, marked_by_device, confidence, source)
     VALUES ($1, $2::uuid, $3, 'present', $4, $5, $6, 'face_recognition')
     ON CONFLICT (fk_student_id, attendance_date) DO UPDATE
       SET check_in_at = LEAST(student_attendance.check_in_at, EXCLUDED.check_in_at),
           marked_by_device = COALESCE(student_attendance.marked_by_device, EXCLUDED.marked_by_device),
           confidence = GREATEST(student_attendance.confidence, EXCLUDED.confidence)`,
    [studentId, tenantId, dateStr, ts, deviceCode, confidence || null]
  );
}

export async function upsertStudentAttendanceCheckout({ studentId, tenantId, dateStr, ts, deviceCode, confidence }) {
  await pool.query(
    `INSERT INTO student_attendance
       (fk_student_id, fk_tenant_id, attendance_date, status, check_out_at, marked_by_device, confidence, source)
     VALUES ($1, $2::uuid, $3, 'present', $4, $5, $6, 'face_recognition')
     ON CONFLICT (fk_student_id, attendance_date) DO UPDATE
       SET check_out_at = GREATEST(student_attendance.check_out_at, EXCLUDED.check_out_at),
           marked_by_device = COALESCE(student_attendance.marked_by_device, EXCLUDED.marked_by_device),
           confidence = GREATEST(student_attendance.confidence, EXCLUDED.confidence)`,
    [studentId, tenantId, dateStr, ts, deviceCode, confidence || null]
  );
}

export async function findEmployeeByIdentifier({ tenantId, identifierCode, identifierId }) {
  const code = (identifierCode || '').toString();
  const idStr = (identifierId || '').toString();
  const result = await pool.query(
    `SELECT pk_employee_id, employee_code, full_name FROM hr_employee
     WHERE tenant_id = $1::uuid AND (
       employee_code = $2 
       OR pk_employee_id::text = $3 
       OR ($2 != '' AND person_id::text = $2)
       OR ($3 != '' AND person_id::text = $3)
     )
     LIMIT 1`,
    [tenantId, code, idStr || '0']
  );
  return result.rows[0] ?? null;
}

export async function findPersonByUuid(tenantId, personId) {
  const result = await pool.query(
    `SELECT person_id, person_type, full_name FROM person
     WHERE tenant_id = $1::uuid AND person_id = $2::uuid LIMIT 1`,
    [tenantId, personId]
  );
  return result.rows[0] ?? null;
}

export async function touchPersonLastSeen({ personId, ts }) {
  await pool.query(
    `UPDATE person
     SET visit_count = visit_count + 1,
         last_seen = GREATEST(last_seen, $2::timestamptz),
         updated_at = NOW()
     WHERE person_id = $1::uuid`,
    [personId, ts]
  );
}

export async function linkEventToPerson(eventId, personId) {
  await pool.query(
    `UPDATE device_events
     SET fk_person_id = $1::uuid
     WHERE pk_event_id = $2::uuid`,
    [personId, eventId]
  );
}

export async function insertEmployeePresencePing({ tenantId, employeeId, deviceCode, direction, confidence, ts }) {
  await pool.query(
    `INSERT INTO attendance_ping (tenant_id, fk_employee_id, device_code, direction, confidence, occurred_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
    [tenantId, employeeId, deviceCode, direction || null, confidence || null, ts]
  );
}

export async function upsertAttendanceCheckin({ employeeId, ts, dateStr, photoUrl, tenantId }) {
  await pool.query(
    `INSERT INTO attendance_record
       (fk_employee_id, check_in, attendance_date, checkin_photo_url, tenant_id, status, site_id)
     VALUES ($1, $2, $3, $4, $5::uuid, 'present', (SELECT site_id FROM hr_employee WHERE pk_employee_id = $1 LIMIT 1))
     ON CONFLICT (tenant_id, fk_employee_id, attendance_date) DO UPDATE
       SET check_in = LEAST(COALESCE(attendance_record.check_in, EXCLUDED.check_in), EXCLUDED.check_in),
           checkin_photo_url = COALESCE(attendance_record.checkin_photo_url, EXCLUDED.checkin_photo_url),
           site_id = COALESCE(attendance_record.site_id, EXCLUDED.site_id),
           status = EXCLUDED.status,
           -- Clear check_out that arrived before this check_in (midnight-carryover exit from previous session) or when employee returns from break (check-in after check-out)
           -- Clear check_out that arrived before this check_in (midnight-carryover exit from previous session) or when employee returns from break (check-in after check-out)
           check_out = CASE
             WHEN attendance_record.check_out IS NOT NULL
               AND (
                 attendance_record.check_out <= LEAST(COALESCE(attendance_record.check_in, EXCLUDED.check_in), EXCLUDED.check_in)
                 OR (EXCLUDED.check_in > attendance_record.check_out AND EXCLUDED.check_in - attendance_record.check_out >= interval '2 minutes')
               )
             THEN NULL
             ELSE attendance_record.check_out
           END,
           checkout_photo_url = CASE
             WHEN attendance_record.check_out IS NOT NULL
               AND (
                 attendance_record.check_out <= LEAST(COALESCE(attendance_record.check_in, EXCLUDED.check_in), EXCLUDED.check_in)
                 OR (EXCLUDED.check_in > attendance_record.check_out AND EXCLUDED.check_in - attendance_record.check_out >= interval '2 minutes')
               )
             THEN NULL
             ELSE attendance_record.checkout_photo_url
           END,
           duration_minutes = CASE
             WHEN attendance_record.check_out IS NOT NULL
               AND (
                 attendance_record.check_out <= LEAST(COALESCE(attendance_record.check_in, EXCLUDED.check_in), EXCLUDED.check_in)
                 OR (EXCLUDED.check_in > attendance_record.check_out AND EXCLUDED.check_in - attendance_record.check_out >= interval '2 minutes')
               )
             THEN NULL
             ELSE attendance_record.duration_minutes
           END,
           working_hours = CASE
             WHEN attendance_record.check_out IS NOT NULL
               AND (
                 attendance_record.check_out <= LEAST(COALESCE(attendance_record.check_in, EXCLUDED.check_in), EXCLUDED.check_in)
                 OR (EXCLUDED.check_in > attendance_record.check_out AND EXCLUDED.check_in - attendance_record.check_out >= interval '2 minutes')
               )
             THEN 0.00
             ELSE attendance_record.working_hours
           END`,
    [employeeId, ts, dateStr, photoUrl || null, tenantId]
  );
}

export async function upsertAttendanceCheckout({ employeeId, ts, dateStr, photoUrl, tenantId }) {
  await pool.query(
    `INSERT INTO attendance_record
       (fk_employee_id, check_out, attendance_date, checkout_photo_url, tenant_id, status)
     VALUES ($1, $2, $3, $4, $5::uuid, $6)
     ON CONFLICT (tenant_id, fk_employee_id, attendance_date) DO UPDATE
       SET check_out = CASE
             -- Ignore check_out that arrives before an already-set check_in (stale midnight-carryover exit)
             WHEN attendance_record.check_in IS NOT NULL AND EXCLUDED.check_out <= attendance_record.check_in
             THEN attendance_record.check_out
             ELSE GREATEST(COALESCE(attendance_record.check_out, EXCLUDED.check_out), EXCLUDED.check_out)
           END,
           checkout_photo_url = COALESCE(EXCLUDED.checkout_photo_url, attendance_record.checkout_photo_url),
           status = EXCLUDED.status,
           duration_minutes = CASE
             WHEN attendance_record.check_in IS NOT NULL
               AND GREATEST(COALESCE(attendance_record.check_out, EXCLUDED.check_out), EXCLUDED.check_out) > attendance_record.check_in
             THEN EXTRACT(EPOCH FROM (GREATEST(COALESCE(attendance_record.check_out, EXCLUDED.check_out), EXCLUDED.check_out) - attendance_record.check_in))::int / 60
             ELSE NULL
           END,
           working_hours = CASE
             WHEN attendance_record.check_in IS NOT NULL
               AND GREATEST(COALESCE(attendance_record.check_out, EXCLUDED.check_out), EXCLUDED.check_out) > attendance_record.check_in
             THEN ROUND((EXTRACT(EPOCH FROM (GREATEST(COALESCE(attendance_record.check_out, EXCLUDED.check_out), EXCLUDED.check_out) - attendance_record.check_in)) / 3600.0)::numeric, 2)
             ELSE 0.00
           END`,
    [employeeId, ts, dateStr, photoUrl || null, tenantId, 'present']
  );
}

export async function getEmployeeSiteId(employeeId) {
  const result = await pool.query(
    `SELECT site_id FROM hr_employee WHERE pk_employee_id = $1`,
    [employeeId]
  );
  return result.rows[0]?.site_id ?? null;
}

// The device is supposed to debounce its own recognitions using this value
// (site_config.recognition_settings.cooldown_seconds), but firmware has been
// observed running with a local cooldown of 0 regardless of what's
// configured here — producing 2-3 FACE_DETECTED/EMPLOYEE_ENTRY events for a
// single person within ~1-2 seconds. Read the same config value so the
// backend's own dedup window stays in sync with whatever the site is set to.
export async function getRecognitionCooldownSeconds(siteId) {
  if (!siteId) return 10;
  const { rows } = await pool.query(
    `SELECT (site_config->'recognition_settings'->>'cooldown_seconds')::numeric AS cooldown
     FROM frs_site WHERE pk_site_id = $1`,
    [siteId]
  );
  const cooldown = rows[0]?.cooldown;
  return (cooldown !== null && cooldown !== undefined && !isNaN(cooldown)) ? Number(cooldown) : 10;
}

// True if this employee already has an ATTENDANCE_UPDATE alert within the
// cooldown window — the actual fix for "3 notifications for one event": the
// device fires duplicate recognitions faster than any human walks past a
// camera twice, so a repeat within this window is always noise, never a
// second real visit.
export async function hasRecentAttendanceNotification(employeeId, cooldownSeconds) {
  const { rows } = await pool.query(
    `SELECT 1 FROM system_alert
     WHERE fk_employee_id = $1 AND alert_type = 'ATTENDANCE_UPDATE'
       AND created_at > NOW() - ($2 || ' seconds')::interval
     LIMIT 1`,
    [employeeId, String(cooldownSeconds)]
  );
  return rows.length > 0;
}

// ============================================================================
// FACE UNKNOWN
// ============================================================================

export async function findFacilityDeviceForUnknownFace(deviceCode, tenantId) {
  const result = await pool.query(
    `SELECT pk_device_id, site_id FROM facility_device
     WHERE external_device_id = $1 AND tenant_id = $2::uuid`,
    [deviceCode, tenantId]
  );
  return result.rows[0] ?? null;
}

export async function insertUnauthorizedAccessLog({ deviceId, ts, confidence, photoUrl }) {
  await pool.query(
    `INSERT INTO unauthorized_access_log
       (device_id, event_timestamp, confidence_score, image_url)
     VALUES ($1, $2, $3, $4)`,
    [deviceId, ts, confidence || 0, photoUrl || null]
  ).catch(() => {});
}

export async function findExistingPersonByUuid(personUuid) {
  const result = await pool.query(
    `SELECT person_id, person_type FROM person WHERE person_id = $1::uuid LIMIT 1`,
    [personUuid]
  );
  return result.rows[0] ?? null;
}

// Non-fatal: caller catches and logs a warning, matching the original's
// fire-and-forget `.catch(err => logger.warn(...))` — never rethrows.
export function updateReturningVisitor({ personUuid, ts, photoUrl }) {
  return pool.query(
    `UPDATE person
     SET visit_count = visit_count + 1,
         last_seen   = GREATEST(last_seen, $2::timestamptz),
         photo_url   = COALESCE(photo_url, $3),
         updated_at  = NOW()
     WHERE person_id = $1::uuid`,
    [personUuid, ts, photoUrl || null]
  );
}

export async function linkEventToPersonSilent(personUuid, eventId) {
  await pool.query(
    `UPDATE device_events SET fk_person_id = $1::uuid WHERE pk_event_id = $2::uuid`,
    [personUuid, eventId]
  ).catch(() => {});
}

export async function insertVisitorBuffer({ tenantId, siteId, deviceCode, trackingId, personUuid, photoUrl, confidence, payload, ts }) {
  await pool.query(
    `INSERT INTO visitor_buffer
       (tenant_id, site_id, device_code, tracking_id, person_uuid,
        photo_url, confidence, event_payload, buffered_at)
     VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, $7, $8, $9)`,
    [tenantId, siteId || null, deviceCode, trackingId || null, personUuid || null, photoUrl || null, confidence || null, JSON.stringify(payload), ts]
  );
}

export async function insertFallbackPerson({ personUuid, tenantId, label, photoUrl, ts }) {
  await pool.query(
    `INSERT INTO person (person_id, tenant_id, person_type, status, full_name, photo_url,
       first_seen, last_seen, visit_count, risk_score, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'unknown', 'active', $3, $4, $5, $5, 1, 0.0, NOW(), NOW())
     ON CONFLICT (person_id) DO NOTHING`,
    [personUuid, tenantId, label, photoUrl || null, ts]
  ).catch(() => {});
}

// ============================================================================
// ENROLLMENT COMPLETED / FAILED
// ============================================================================

export async function findStudentByIdentifierForEnrollment({ tenantId, identifierCode, identifierId }) {
  const result = await pool.query(
    `SELECT pk_student_id FROM edu_student
     WHERE fk_tenant_id = $1::uuid AND (roll_number = $2 OR pk_student_id::text = $3)
     LIMIT 1`,
    [tenantId, identifierCode || '', identifierId?.toString() || '0']
  );
  return result.rows[0]?.pk_student_id ?? null;
}

export async function findDuplicateStudentEmbedding({ vectorStr, studentId, modelVersion }) {
  const result = await pool.query(
    `SELECT ef.fk_student_id, 1 - (ef.embedding <=> $1::vector) as similarity, s.name
     FROM edu_student_face_embedding ef
     JOIN edu_student s ON s.pk_student_id = ef.fk_student_id
     WHERE 1 - (ef.embedding <=> $1::vector) >= 0.50
       AND ef.fk_student_id != $2
       AND ef.model_version = $3
     ORDER BY ef.embedding <=> $1::vector ASC
     LIMIT 1`,
    [vectorStr, studentId, modelVersion]
  );
  return result.rows;
}

export async function listStudentEmbeddings(studentId) {
  const result = await pool.query(
    `SELECT id FROM edu_student_face_embedding WHERE fk_student_id = $1 ORDER BY enrolled_at ASC`,
    [studentId]
  );
  return result.rows;
}

export async function deleteStudentEmbedding(id) {
  await pool.query(`DELETE FROM edu_student_face_embedding WHERE id = $1`, [id]);
}

export async function insertStudentEmbedding({ studentId, vectorStr, confidence, isPrimary, photoPath, modelVersion }) {
  await pool.query(
    `INSERT INTO edu_student_face_embedding
       (fk_student_id, embedding, quality_score, is_primary, model_version, photo_path)
     VALUES ($1, $2::vector, $3, $4, $6, $5)`,
    [studentId, vectorStr, confidence || null, isPrimary, photoPath || null, modelVersion]
  ).catch(() => {});
}

export async function updateStudentPhotoPath(studentId, photoPath) {
  await pool.query(
    `UPDATE edu_student SET photo_path = $2 WHERE pk_student_id = $1`,
    [studentId, photoPath]
  );
}

export async function findActiveEnrollFromPhotoCommand({ deviceCode, employeeId, employeeCode }) {
  // FIX: enroll_from_photo commands are inserted into device_command_queue
  // (see insertEnrollFromPhotoCommand in enrollmentRepository.js), not the
  // legacy device_commands table this used to query — that mismatch meant
  // this lookup always returned zero rows, so markDeviceCommandDone/Failed
  // below silently never fired: queue rows stayed at status='delivered'
  // forever even after the embedding was successfully created via the
  // independent employee_face_embeddings insert path.
  const result = await pool.query(
    `SELECT dcq.pk_command_id AS id, dcq.command_payload AS payload
     FROM device_command_queue dcq
     JOIN facility_device fd ON fd.pk_device_id = dcq.device_id
     WHERE fd.external_device_id = $1
       AND dcq.command_type = 'enroll_from_photo'
       AND dcq.status = 'delivered'
       AND (dcq.command_payload->>'employee_id' = $2::text OR dcq.command_payload->>'employee_code' = $3::text)
     ORDER BY dcq.created_at DESC
     LIMIT 1`,
    [deviceCode, String(employeeId || ''), String(employeeCode || '')]
  ).catch(() => ({ rows: [] }));
  return result.rows;
}

export async function findInvitationByPhotoFilename(filename) {
  const result = await pool.query(
    `SELECT fk_employee_id
     FROM enrollment_invitations
     WHERE status = 'completed'
       AND photo_paths::text LIKE '%' || $1 || '%'
     LIMIT 1`,
    [filename]
  ).catch(() => ({ rows: [] }));
  return result.rows;
}

// The Jetson callback payload may or may not include photo_path (device
// firmware is outside this repo's control) — this is the reliable fallback:
// the backend already knows the exact S3 key for every angle, since it's the
// same value used to build the pre-signed URL the Jetson downloaded from.
export async function getLatestInvitationPhotoPath(employeeId, angle) {
  const result = await pool.query(
    `SELECT photo_paths->>$2 AS photo_path
     FROM enrollment_invitations
     WHERE fk_employee_id = $1 AND photo_paths ? $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [employeeId, angle]
  ).catch(() => ({ rows: [] }));
  return result.rows[0]?.photo_path ?? null;
}

export async function findEmployeeCode(employeeId) {
  const result = await pool.query(
    `SELECT employee_code FROM hr_employee WHERE pk_employee_id = $1 LIMIT 1`,
    [employeeId]
  ).catch(() => ({ rows: [] }));
  return result.rows;
}

export async function findEmployeeByIdentifierForEnrollment({ tenantId, identifierCode, identifierId }) {
  const result = await pool.query(
    `SELECT pk_employee_id, employee_code FROM hr_employee
     WHERE tenant_id = $1::uuid AND (employee_code = $2 OR pk_employee_id::text = $3)
     LIMIT 1`,
    [tenantId, identifierCode || '', identifierId?.toString() || '0']
  );
  return result.rows;
}

export async function markDeviceCommandDone(commandId) {
  await pool.query(
    `UPDATE device_command_queue SET status = 'done', executed_at = NOW() WHERE pk_command_id = $1`,
    [commandId]
  );
}

export async function markDeviceCommandFailed(commandId) {
  await pool.query(
    `UPDATE device_command_queue SET status = 'failed', executed_at = NOW() WHERE pk_command_id = $1`,
    [commandId]
  ).catch(() => {});
}

export async function findDuplicateEmployeeEmbeddingForEvent({ vectorStr, employeeId, modelVersion }) {
  const result = await pool.query(
    `SELECT ef.employee_id, 1 - (ef.embedding <=> $1::vector) as similarity, e.full_name
     FROM employee_face_embeddings ef
     JOIN hr_employee e ON e.pk_employee_id = ef.employee_id
     WHERE 1 - (ef.embedding <=> $1::vector) >= 0.50
       AND ef.employee_id != $2
       AND ef.model_version = $3
     ORDER BY ef.embedding <=> $1::vector ASC
     LIMIT 1`,
    [vectorStr, employeeId, modelVersion]
  );
  return result.rows;
}

export async function markInvitationEmbeddingFailedForEmployee(employeeId, reason) {
  await pool.query(
    `UPDATE enrollment_invitations
     SET embedding_status = 'failed', approval_status = 'rejected', rejection_reason = $2, updated_at = NOW()
     WHERE fk_employee_id = $1 AND status = 'completed'`,
    [employeeId, reason]
  ).catch(() => {});
}

export async function listEmployeeEmbeddings(employeeId) {
  const result = await pool.query(
    `SELECT id FROM employee_face_embeddings WHERE employee_id = $1 ORDER BY enrolled_at ASC`,
    [employeeId]
  );
  return result.rows;
}

export async function deleteEmployeeEmbedding(id) {
  await pool.query(`DELETE FROM employee_face_embeddings WHERE id = $1`, [id]);
}

// Non-fatal: caller catches and logs an error, matching the original's
// `.catch(err => logger.error(...))` — never rethrows.
export function insertEmployeeEmbeddingForEvent({ employeeId, vectorStr, confidence, isPrimary, photoPath, modelVersion, angle }) {
  return pool.query(
    `INSERT INTO employee_face_embeddings
       (employee_id, embedding, quality_score, is_primary, model_version, photo_path, angle)
     VALUES ($1, $2::vector, $3, $4, $6, $5, $7)`,
    [employeeId, vectorStr, confidence || null, isPrimary, photoPath || null, modelVersion, angle || null]
  );
}

export async function markEmployeeKioskEnrolled(employeeId) {
  await pool.query(
    `UPDATE hr_employee SET kiosk_enrollment_status = 'enrolled', face_enrolled = true
     WHERE pk_employee_id = $1`,
    [employeeId]
  );
}

export async function markInvitationEnrollmentSuccess(employeeId) {
  await pool.query(
    `UPDATE enrollment_invitations
     SET embedding_status = 'success', approval_status = 'auto_approved', completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
     WHERE fk_employee_id = $1 AND status = 'completed'`,
    [employeeId]
  ).catch(() => {});
}

export async function clearEmployeeKioskEnrollmentStatus(employeeId) {
  await pool.query(
    `UPDATE hr_employee SET kiosk_enrollment_status = NULL WHERE pk_employee_id = $1`,
    [employeeId]
  ).catch(() => {});
}

// ============================================================================
// COMMANDS POLLING (GET /commands)
// ============================================================================

export async function drainLegacyCommands(deviceCode) {
  const result = await pool.query(
    `UPDATE device_commands
     SET status = 'delivered'
     WHERE id IN (
       SELECT id FROM device_commands
       WHERE device_code = $1 AND status = 'pending'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
     )
     RETURNING command_type, payload`,
    [deviceCode]
  ).catch((err) => ({ rows: [], __err: err }));
  return result;
}

export async function drainQueuedCommands(deviceId) {
  const result = await pool.query(
    `UPDATE device_command_queue
     SET status = 'delivered'
     WHERE pk_command_id IN (
       SELECT pk_command_id FROM device_command_queue
       WHERE device_id = $1
         AND status = 'pending'
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY priority DESC, created_at ASC
       FOR UPDATE SKIP LOCKED
     )
     RETURNING command_type, command_payload AS payload`,
    [deviceId]
  ).catch((err) => ({ rows: [], __err: err }));
  return result;
}

export async function recordDeviceScan(deviceCode, tenantId, isRecognized) {
  const accuracyScore = isRecognized ? 100 : 0;
  
  await pool.query(`
    UPDATE facility_device 
    SET 
      recognition_accuracy = CASE 
        WHEN total_scans + 1 = 0 THEN 0 
        ELSE ((recognition_accuracy * total_scans) + $3) / (total_scans + 1) 
      END,
      total_scans = total_scans + 1
    WHERE external_device_id = $1 AND tenant_id = $2::uuid
  `, [deviceCode, tenantId, accuracyScore]);

  await pool.query(`
    UPDATE frs_camera 
    SET 
      recognition_accuracy = CASE 
        WHEN total_scans + 1 = 0 THEN 0 
        ELSE ((recognition_accuracy * total_scans) + $2) / (total_scans + 1) 
      END,
      total_scans = total_scans + 1
    WHERE cam_id = $1
  `, [deviceCode, accuracyScore]);
}
