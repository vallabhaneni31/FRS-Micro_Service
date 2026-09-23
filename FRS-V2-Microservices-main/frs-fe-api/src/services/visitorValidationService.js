/**
 * visitorValidationService.js
 *
 * Background service that validates visitor_buffer records before promoting
 * them to the person table.
 *
 * Pipeline per buffered record:
 *   1. Employee-ID hint check  — payload has employee_id AND confidence ≥ 75% → employee match
 *   2. Employee-code check     — tracking_id matches an active hr_employee.employee_code
 *   3. Person-type cross-check — person_uuid already exists in person table as 'employee' type
 *   4. No match found → promote to person table as 'unknown'
 *
 * Runs every POLL_INTERVAL_MS, processing records that have been pending for
 * at least BUFFER_TTL_MS.
 */

import { pool }   from '../db/pool.js';
import { v5 as uuidv5, v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger.js';

const POLL_INTERVAL_MS = 10_000; // check every 10 seconds
const BUFFER_TTL_MS    = 30_000; // promote after 30 seconds
const EMPLOYEE_CONF_THRESHOLD = 75;       // % — drop if device signalled employee at this confidence
const REPEAT_VISITOR_MATCH_THRESHOLD = 0.55; // cosine similarity — same convention as face-match elsewhere (e.g. FACE_MATCH_THRESHOLD default)

const FRS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

let _timer = null;

// ── Validation logic ──────────────────────────────────────────────────────────

async function validate(record) {
  const { pk_buffer_id, tenant_id, tracking_id, person_uuid, confidence, event_payload } = record;
  const payload = event_payload || {};

  // ── Check 1: device already identified this as an employee at high confidence ──
  const payloadEmployeeId = payload.employee_id ?? payload.identifierId;
  const payloadConf       = Number(payload.confidence ?? confidence ?? 0);
  if (payloadEmployeeId && payloadConf >= EMPLOYEE_CONF_THRESHOLD) {
    // Verify the employee actually exists for this tenant
    const { rows } = await pool.query(
      `SELECT pk_employee_id FROM hr_employee
       WHERE tenant_id = $1::uuid
         AND (pk_employee_id::text = $2 OR employee_code = $2)
         AND status = 'active'
       LIMIT 1`,
      [tenant_id, String(payloadEmployeeId)]
    );
    if (rows.length) {
      return {
        status: 'employee_match',
        matched_employee_id: rows[0].pk_employee_id,
        note: `Device signalled employee_id=${payloadEmployeeId} at ${payloadConf}% confidence (threshold ${EMPLOYEE_CONF_THRESHOLD}%)`,
      };
    }
  }

  // ── Check 2: tracking_id matches an active employee code ─────────────────────
  if (tracking_id) {
    const { rows } = await pool.query(
      `SELECT pk_employee_id FROM hr_employee
       WHERE tenant_id = $1::uuid
         AND employee_code = $2
         AND status = 'active'
       LIMIT 1`,
      [tenant_id, tracking_id]
    );
    if (rows.length) {
      return {
        status: 'employee_match',
        matched_employee_id: rows[0].pk_employee_id,
        note: `tracking_id "${tracking_id}" matches active employee code`,
      };
    }
  }

  // ── Check 3: person_uuid already classified as 'employee' in person table ────
  if (person_uuid) {
    const { rows } = await pool.query(
      `SELECT person_id FROM person
       WHERE person_id = $1::uuid AND person_type = 'employee'
       LIMIT 1`,
      [person_uuid]
    );
    if (rows.length) {
      return {
        status: 'employee_match',
        matched_employee_id: null,
        note: `person_uuid ${person_uuid} is already classified as employee in person table`,
      };
    }
  }

  // ── No employee match → promote to person table ───────────────────────────────
  return { status: 'promote' };
}

async function promote(record, client) {
  const { pk_buffer_id, tenant_id, person_uuid, tracking_id, photo_url, event_payload, buffered_at } = record;
  const payload = event_payload || {};

  // Generate UUID the same way handleFaceUnknown does
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tracking_id ?? '');
  let finalUuid = person_uuid
    || (tracking_id ? (isUuid ? tracking_id : uuidv5(tracking_id, FRS_NAMESPACE)) : null);
  let isNewPerson = !finalUuid;

  // The current C++ binary sends no tracking_id/visitor_id, so a stable
  // identifier is never available above. The only remaining way to recognize
  // "this is the same face as an earlier visit" is to compare this
  // detection's embedding against previously-stored ones — without this,
  // every detection mints a fresh person and visit_count (and therefore
  // "Today's Repeated Visitors") can never rise above 1.
  let vectorStr = null;
  if (Array.isArray(payload.embedding) && payload.embedding.length > 0) {
    vectorStr = `[${payload.embedding.join(',')}]`;
    if (!finalUuid) {
      const { rows: matches } = await client.query(
        `SELECT p.person_id, 1 - (pfe.embedding <=> $1::vector) as similarity
         FROM person_face_embeddings pfe
         JOIN person p ON p.person_id = pfe.person_id
         WHERE p.tenant_id = $2::uuid
           AND p.person_type IN ('visitor', 'unknown')
           AND p.status = 'active'
           ${payload.model_version ? 'AND pfe.model_version = $3' : ''}
         ORDER BY pfe.embedding <=> $1::vector ASC
         LIMIT 1`,
        payload.model_version ? [vectorStr, tenant_id, payload.model_version] : [vectorStr, tenant_id]
      );
      if (matches.length && matches[0].similarity >= REPEAT_VISITOR_MATCH_THRESHOLD) {
        finalUuid = matches[0].person_id;
        isNewPerson = false;
      }
    }
  }

  if (!finalUuid) finalUuid = uuidv4();

  const label = payload.person_type === 'visitor' ? 'Visitor' : 'Unknown Person';
  const ts    = buffered_at;

  const { rows } = await client.query(
    `INSERT INTO person (
       person_id, tenant_id, person_type, status, full_name, photo_url,
       first_seen, last_seen, visit_count, risk_score, created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, 'unknown', 'active', $3, $4,
       $5, $5, 1, 0.0, NOW(), NOW()
     )
     ON CONFLICT (person_id) DO UPDATE
       SET visit_count = person.visit_count + 1,
           last_seen   = GREATEST(person.last_seen, EXCLUDED.last_seen),
           photo_url   = COALESCE(person.photo_url, EXCLUDED.photo_url),
           updated_at  = NOW()
     RETURNING person_id`,
    [finalUuid, tenant_id, label, photo_url || null, ts]
  );

  const personId = rows[0]?.person_id ?? null;

  // Persist the face vector so this visitor becomes recognizable on a repeat
  // visit — without this, promotion only ever wrote a person record with no
  // biometric data, so /face/sync/embeddings had nothing to sync back to
  // devices for these detections (see faceSyncRoutes.js). Only store one for
  // a genuinely new person — a matched repeat visit already has a reference
  // embedding, and the ON CONFLICT branch above already bumped visit_count.
  if (personId && isNewPerson && vectorStr) {
    await client.query(
      `INSERT INTO person_face_embeddings (person_id, embedding, model_version, quality_score, photo_path)
       VALUES ($1::uuid, $2::vector, $3, $4, $5)`,
      [personId, vectorStr, payload.model_version || null, payload.confidence ?? null, photo_url || null]
    );
  }

  // Link the original device_events row (captured as _event_id when this
  // record was buffered in handleFaceUnknown) back to the final person_id.
  // Without this, the movement/sighting timeline on the person profile page
  // (which queries device_events WHERE fk_person_id = ...) shows nothing for
  // every visitor promoted through this path — linkEventToPersonSilent only
  // ever ran on the separate trackingId-based "returning visitor" fast path,
  // which the current device payloads never take (no tracking_id sent).
  if (personId && payload._event_id) {
    await client.query(
      `UPDATE device_events SET fk_person_id = $1::uuid WHERE pk_event_id = $2::uuid`,
      [personId, payload._event_id]
    ).catch(() => {});
  }

  return personId;
}

// ── Main processing loop ──────────────────────────────────────────────────────

async function processBatch() {
  const cutoff = new Date(Date.now() - BUFFER_TTL_MS).toISOString();

  let pending;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM visitor_buffer
       WHERE status = 'pending' AND buffered_at <= $1
       ORDER BY buffered_at ASC
       LIMIT 50`,
      [cutoff]
    );
    pending = rows;
  } catch (err) {
    // Table may not exist yet (migration not applied); fail silently
    if (err.code === '42P01') return;
    logger.warn({ err }, '[visitor-validation] query failed');
    return;
  }

  if (!pending.length) return;

  logger.info(`[visitor-validation] Processing ${pending.length} buffered visitor record(s)`);

  for (const record of pending) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await validate(record);

      if (result.status === 'employee_match') {
        await client.query(
          `UPDATE visitor_buffer
           SET status = 'employee_match',
               validated_at = NOW(),
               validation_note = $2,
               matched_employee_id = $3
           WHERE pk_buffer_id = $1`,
          [record.pk_buffer_id, result.note, result.matched_employee_id || null]
        );

        // Audit log so the dropped event is traceable
        await client.query(
          `INSERT INTO audit_log
             (tenant_id, action, entity_type, entity_id, entity_name, details, source)
           VALUES
             ($1::uuid, 'visitor.buffer.employee_match', 'visitor_buffer', $2, 'Visitor Buffer',
              $3, 'visitor-validation-service')`,
          [
            record.tenant_id,
            record.pk_buffer_id,
            result.note,
          ]
        ).catch(() => {}); // audit is non-fatal

        logger.info(`[visitor-validation] Dropped buffer ${record.pk_buffer_id}: ${result.note}`);

      } else {
        // Promote to person table
        const personId = await promote(record, client);

        await client.query(
          `UPDATE visitor_buffer
           SET status = 'promoted',
               validated_at = NOW(),
               validation_note = 'Promoted after TTL — no employee match found',
               person_id = $2
           WHERE pk_buffer_id = $1`,
          [record.pk_buffer_id, personId]
        );

        logger.info(`[visitor-validation] Promoted buffer ${record.pk_buffer_id} → person ${personId}`);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, bufferId: record.pk_buffer_id }, '[visitor-validation] Failed to process buffer record');
    } finally {
      client.release();
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function start() {
  if (_timer) return;
  // Run once at startup after a short delay (let server finish booting)
  setTimeout(processBatch, 10_000);
  _timer = setInterval(processBatch, POLL_INTERVAL_MS);
  logger.info(`[visitor-validation] Started — TTL ${BUFFER_TTL_MS / 60_000}m, poll ${POLL_INTERVAL_MS / 1_000}s, conf threshold ${EMPLOYEE_CONF_THRESHOLD}%`);
}

export function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
