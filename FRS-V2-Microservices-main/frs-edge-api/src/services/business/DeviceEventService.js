/**
 * DeviceEventService.js — business logic extracted from deviceEventsRoutes.js.
 * The live Jetson → AWS face-recognition/attendance event pipeline: every
 * check-in/check-out, heartbeat, unknown-face buffering, and enrollment
 * completion/failure event from every deployed edge device flows through
 * here. Backed by repositories/deviceEventRepository.js.
 *
 * Every branch, log statement, and catch behavior (log-and-continue vs.
 * rethrow) below is preserved exactly from the original inline route
 * handlers — this is live production business logic, not a place for
 * incidental cleanup.
 */
import sharp from 'sharp';
import { v5 as uuidv5 } from 'uuid';
import { randomUUID } from 'crypto';
import wsManager from '../../websocket/index.js';
import logger from '../../utils/logger.js';
import { createSystemNotification } from './SystemNotificationService.js';
import * as repo from '../../repositories/deviceEventRepository.js';
import * as storage from '../storageService.js';
import { uploadEventPhoto, resolveEventIdentity, resolveDirection } from './eventPhotoService.js';
import { sanitizeForKey, eventDateTimeParts, buildEventPhotoKey, buildEventPhotoFilename } from '../../utils/s3KeyBuilder.js';

// resolveEventPhotoKey/uploadEventPhoto are re-exported here for backward
// compatibility — DeviceEventController.js and scripts/recoverDeadLetterCheckins.js
// import them from this module. The actual identity/direction resolution now
// lives in eventPhotoService.js so FaceController.js and PersonService.js can
// share it instead of re-deriving it slightly differently.
export { uploadEventPhoto };


/**
 * Resolves the S3 key an event photo belongs at — shared by the inline
 * base64-upload path (uploadEventPhoto) and the presigned direct-to-S3
 * path (DeviceEventController.getPhotoUploadUrl), so both ever produce
 * exactly one key shape for the same logical photo.
 */
export async function resolveEventPhotoKey({ tenantId, eventType, payload }) {
  const { kind, id, name } = await resolveEventIdentity(tenantId, payload);
  const direction = resolveDirection(eventType, payload);
  const { dateStr, timeStr } = eventDateTimeParts(payload.event_time);
  const safeId = sanitizeForKey(id);
  const filename = buildEventPhotoFilename({ kind, name, id, dateStr, timeStr });
  return buildEventPhotoKey({ tenantId, kind, safeId, dateStr, direction, filename });
}

// ─── helpers ────────────────────────────────────────────────────────────────

// Devices can legitimately deliver events well after capture (offline-queue
// drain after a connectivity outage), so event_time is normally trusted over
// arrival time for attendance_date and the S3 photo-folder date — that's
// deliberate (see eventDateTimeParts in s3KeyBuilder.js). But an event_time
// this far from "now" almost certainly means a device clock fault or a
// queue-replay bug, not a legitimate delayed delivery: trusting it silently
// files the event under a stale date, so today's real check-in disappears
// from the dashboard/attendance page while raw event counts (queried by
// arrival time) still look correct. Fall back to arrival time in that case.
const MAX_EVENT_TIME_DRIFT_MS = 48 * 60 * 60 * 1000; // 48h

// @returns {{ value: string, wasStale: boolean }} — `wasStale` is the
// authoritative signal for callers (never infer it by comparing strings:
// `value` is always a normalized toISOString(), so a raw timestamp missing
// milliseconds/using a different-but-valid format would look "changed" even
// when it was perfectly fresh, wrongly triggering stale-data handling).
export function resolveEventTimestamp(rawEventTime, { deviceCode, eventType } = {}) {
  if (!rawEventTime) return { value: new Date().toISOString(), wasStale: false };
  const parsed = new Date(rawEventTime);
  if (isNaN(parsed.getTime())) return { value: new Date().toISOString(), wasStale: false };
  const driftMs = Date.now() - parsed.getTime();
  if (Math.abs(driftMs) > MAX_EVENT_TIME_DRIFT_MS) {
    logger.warn(
      { deviceCode, eventType, reportedEventTime: rawEventTime, driftHours: Math.round(driftMs / 3600000) },
      '[device-events] event_time is implausibly stale/future — device clock or offline-queue issue suspected; falling back to arrival time'
    );
    return { value: new Date().toISOString(), wasStale: true };
  }
  return { value: parsed.toISOString(), wasStale: false };
}

export async function processEvent(deviceCode, tenantId, eventType, payload) {
  if (payload) {
    const rawEventTime = payload.event_time || payload.timestamp;
    const { value: resolved, wasStale } = resolveEventTimestamp(rawEventTime, { deviceCode, eventType });
    if (wasStale) {
      // Preserve what the device actually sent, for diagnosing the
      // underlying clock/queue-replay fault — the corrected value is what
      // drives attendance_date and the S3 photo folder from here on.
      payload.event_time_raw = rawEventTime;
    }
    payload.event_time = resolved;
    if (payload.timestamp !== undefined) payload.timestamp = resolved;
  }

  // 0. Base64 photo decode & upload to S3 (photo_base64, snapshot_base64, or face_crop_base64)
  if (payload && (payload.photo_base64 || payload.snapshot_base64 || payload.face_crop_base64)) {
    try {
      let sourceField = payload.snapshot_base64 ? 'snapshot_base64' : (payload.photo_base64 ? 'photo_base64' : 'face_crop_base64');
      let base64Data = payload.snapshot_base64 || payload.photo_base64 || payload.face_crop_base64;
      if (base64Data.includes(',')) {
        base64Data = base64Data.split(',')[1];
      }
      const buffer = Buffer.from(base64Data, 'base64');
      try {
        const meta = await sharp(buffer).metadata();
        logger.info(`[device-events] INCOMING PHOTO from ${sourceField}: type=${eventType}, format=${meta.format}, width=${meta.width}, height=${meta.height}, size=${buffer.length} bytes`);
      } catch (metaErr) {
        logger.warn({ err: metaErr }, '[device-events] Could not read incoming photo metadata via sharp');
      }

      const key = await uploadEventPhoto({ tenantId, eventType, payload, buffer });

      payload.photo_url = key;
      payload.photo_path = key;
      delete payload.photo_base64;
      delete payload.snapshot_base64;
      delete payload.face_crop_base64;
    } catch (err) {
      logger.error({ err }, '[device-events] Failed to decode/upload photo_base64, snapshot_base64, or face_crop_base64 to S3');
    }
  } else if (payload && payload.photo_key) {
    const RETRY_DELAYS_MS = [250, 500, 1000];
    let exists = false;
    try {
      for (let attempt = 0; ; attempt++) {
        exists = await storage.objectExists(storage.LOGS_BUCKET, payload.photo_key);
        if (exists || attempt >= RETRY_DELAYS_MS.length) break;
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
      }
      if (exists) {
        payload.photo_url = payload.photo_key;
        payload.photo_path = payload.photo_key;
      } else {
        logger.warn({ key: payload.photo_key }, '[device-events] photo_key referenced but object not found in S3 after retries — dropping reference');
      }
    } catch (err) {
      logger.error({ err, key: payload.photo_key }, '[device-events] Failed to verify photo_key against S3');
    } finally {
      delete payload.photo_key;
    }
  }

  // 1. Resolve fk_device_id from public.devices
  let fkDeviceId = await repo.findLegacyDeviceByCode(deviceCode);

  if (!fkDeviceId) {
    fkDeviceId = await repo.insertLegacyDevice(deviceCode);
  }

  // 2. Normalize eventType to satisfy check constraint
  let dbEventType = 'FACE_DETECTED';
  const normalized = String(eventType || '').toLowerCase();
  if (normalized.includes('heartbeat')) {
    dbEventType = 'DEVICE_HEARTBEAT';
  } else if (normalized === 'face.recognized' || normalized.includes('access.granted') || normalized === 'attendance.checkin' || normalized === 'attendance.checkout' || normalized === 'employee_entry' || normalized === 'employee_exit') {
    dbEventType = (normalized === 'attendance.checkout' || normalized.includes('checkout') || normalized === 'employee_exit' || String(payload?.direction || '').toLowerCase() === 'out') ? 'EMPLOYEE_EXIT' : 'EMPLOYEE_ENTRY';
  } else if (normalized.includes('access.denied')) {
    dbEventType = 'DEVICE_ERROR';
  } else if (normalized.includes('motion')) {
    dbEventType = 'MOTION_DETECTED';
  } else if (normalized.includes('frame')) {
    dbEventType = 'FRAME_CAPTURED';
  }

  // 3. Persist to device_events audit log with Resolved fk_device_id and dbEventType
  const eventId = await repo.insertDeviceEvent({ fkDeviceId, deviceCode, tenantId, dbEventType, payload });

  // 2. Update device last-seen regardless of event type
  await repo.touchDeviceLastSeen(deviceCode, tenantId);

  // 3. Dispatch to business logic per event type
  try {
    switch (eventType) {
      // Live firmware emits 'device.heartbeat' or 'health.check'; 'heartbeat' is the documented name.
      case 'heartbeat':
      case 'device.heartbeat':
      case 'health.check':
        await handleHeartbeat(deviceCode, tenantId, payload);
        break;
      // Lightweight liveness ping (no telemetry) — already persisted to the
      // audit log above via insertDeviceEvent. Nothing further to act on;
      // this case only exists so it doesn't fall into the "unknown
      // event_type" warning below for a type the device sends routinely.
      case 'health.check':
        break;
      case 'face.recognized':
      case 'EMPLOYEE_ENTRY':
      case 'EMPLOYEE_EXIT':
        await handleFaceRecognized(deviceCode, tenantId, payload, eventId);
        await repo.recordDeviceScan(deviceCode, tenantId, true).catch(e => logger.warn('[Event] failed to record scan: ' + e.message));
        break;
      // Jetson firmware native event types — translate field names to canonical format
      case 'attendance.checkin':
      case 'attendance.checkout': {
        const frameUrl = payload.frameUrl;
        const canonicalPayload = {
          employee_code: payload.employeeCode,
          employee_id:   payload.employeeId,
          confidence:    payload.similarity ?? payload.confidence,
          event_time:    payload.timestamp  ?? payload.event_time,
          // frameUrl comes from POST /api/events/photo (the two-step upload
          // path) — post-S3-migration that's always either a bare S3 key or,
          // for older/third-party firmware, a fully-qualified URL. Never a
          // local /uploads/ path — that folder no longer gets written to.
          photo_url:     payload.photo_url  // set by base64 handler above
            ?? frameUrl
            ?? null,
          direction: eventType === 'attendance.checkin' ? 'in' : 'out',
          // Must carry over — handleFaceRecognized uses this to suppress a
          // stale/replayed photo from being shown as attendance "proof".
          event_time_raw: payload.event_time_raw,
        };
        await handleFaceRecognized(deviceCode, tenantId, canonicalPayload, eventId);
        await repo.recordDeviceScan(deviceCode, tenantId, true).catch(e => logger.warn('[Event] failed to record scan: ' + e.message));
        break;
      }
      // Live firmware emits 'face.unrecognized'; 'face.unknown' is the documented name.
      case 'face.unknown':
      case 'face.unrecognized':
        await handleFaceUnknown(deviceCode, tenantId, payload, eventId);
        await repo.recordDeviceScan(deviceCode, tenantId, false).catch(e => logger.warn('[Event] failed to record scan: ' + e.message));
        break;
      case 'access.granted':
      case 'access.denied':
        await handleAccessEvent(deviceCode, tenantId, eventType, payload);
        break;
      case 'enrollment.completed':
        await handleEnrollmentCompleted(deviceCode, tenantId, payload);
        break;
      case 'enrollment.failed':
        await handleEnrollmentFailed(deviceCode, tenantId, payload);
        break;
      default:
        // Stored in the audit log above, but no handler exists. Log so missing
        // events are debuggable instead of silently disappearing.
        logger.warn(
          { deviceCode, tenantId, eventType },
          '[device-events] received unknown event_type — stored but not processed'
        );
        break;
    }

    if (eventId) {
      await repo.markEventProcessed(eventId);
    }
  } catch (err) {
    logger.error({ err, eventId }, '[device-events] Failed to process event');
    if (eventId) {
      await repo.markEventFailed(eventId, err.message);
    }
    throw err;
  }
}

async function handleHeartbeat(deviceCode, tenantId, payload) {
  const { status = 'online', firmware_version } = payload;

  // Live firmware reports telemetry at the payload top level (cpu_temp,
  // memory_used_mb, load_avg_1m, uptime_seconds, ...), not inside `metrics`.
  // Normalize the fields we know into a telemetry blob persisted on the device
  // so the fleet UI can render it.
  //
  // This device sends multiple heartbeat calls close together, and not all of
  // them carry a full metrics snapshot — some arrive with `metrics: {}`. Since
  // updateFacilityDeviceHeartbeat merges via jsonb `||` (whichever keys are
  // present in this update win), a field OMITTED here leaves the previous
  // value untouched, whereas defaulting it to `null` would blank out good data
  // the moment a lighter-weight heartbeat lands after a richer one. So: only
  // set a key when this call actually reported it.
  const t = payload.metrics && Object.keys(payload.metrics).length ? payload.metrics : payload;
  const telemetry = { updated_at: new Date().toISOString() };
  const setIfPresent = (key, value) => {
    if (value !== undefined && value !== null) telemetry[key] = value;
  };
  setIfPresent('cpu_percent', t.cpu_percent);
  setIfPresent('gpu_percent', t.gpu_percent);
  setIfPresent('memory_used_mb', t.memory_used_mb);
  setIfPresent('memory_total_mb', t.memory_total_mb);
  setIfPresent('temperature_c', t.temperature_c ?? t.cpu_temp);
  setIfPresent('disk_used_gb', t.disk_used_gb);
  setIfPresent('disk_total_gb', t.disk_total_gb);
  setIfPresent('disk_free_gb', t.disk_free_gb);
  setIfPresent('uptime_seconds', t.uptime_seconds);
  setIfPresent('load_avg_1m', t.load_avg_1m);
  setIfPresent('fps', t.fps);

  await repo.updateFacilityDeviceHeartbeat({ deviceCode, tenantId, status, firmwareVersion: firmware_version, telemetry });

  // Cascade: also update child cameras status if parent is online
  if (status === 'online') {
    await repo.cascadeChildCamerasOnline(deviceCode, tenantId);
  }

  // Append to the heartbeat history table when present.
  await repo.insertHeartbeatHistory({ deviceCode, status, telemetry, tenantId });

  // Broadcast to browser via Socket.IO across all supported event names
  try {
    wsManager.broadcastToTenant(tenantId, 'deviceStatusUpdate', {
      device_code: deviceCode,
      status,
      last_heartbeat: new Date().toISOString(),
    });
    wsManager.broadcastToTenant(tenantId, 'device.heartbeat', {
      deviceId: deviceCode,
      cpuUsage: telemetry.cpu_percent,
      memoryUsage: telemetry.memory_used_mb,
      temperature: telemetry.temperature_c,
      tenantId,
    });
    wsManager.broadcastToTenant(tenantId, 'device.status', {
      deviceId: deviceCode,
      status: status === 'online' ? 'online' : 'offline',
      tenantId,
    });
    wsManager.broadcastSingleDevice(tenantId, deviceCode);
  } catch (_) {}

  // Trigger system notification for offline status
  if (status === 'offline') {
    const dev = await repo.findDeviceForOfflineNotification(deviceCode, tenantId);
    if (dev) {
      await createSystemNotification({
        tenant_id: tenantId,
        site_id: dev.site_id,
        alert_type: 'DEVICE_OFFLINE',
        severity: 'critical',
        title: 'Device Offline',
        message: `Device ${dev.name} (${deviceCode}) went offline.`,
        fk_device_id: dev.pk_device_id,
      });
    }
  }
}

async function calculateAndUpdateBreakDuration(tenantId, employeeId, dateStr, siteTz) {
  try {
    const pings = await repo.listAttendancePingsForDay({ tenantId, employeeId, siteTz, dateStr });

    let totalBreakMs = 0;
    let lastInTime = null;
    let lastOutTime = null;
    let workStarted = false;
    // Gap between two consecutive IN pings with no OUT in between — infer a break
    // only when the gap exceeds 30 minutes (avoids counting duplicate detections).
    const INFER_THRESHOLD_MS = 30 * 60 * 1000;

    for (const ping of pings) {
      const dir = (ping.direction || '').toLowerCase();
      const time = new Date(ping.occurred_at);
      if (dir === 'in' || dir === 'entry') {
        if (!workStarted) {
          workStarted = true;
          lastInTime = time;
        } else if (lastOutTime) {
          const breakMs = time - lastOutTime;
          if (breakMs >= 5 * 60 * 1000) {
            totalBreakMs += Math.min(breakMs, 60 * 60 * 1000);
          }
          lastOutTime = null;
          lastInTime = time;
        } else {
          lastInTime = time;
        }
      } else if (dir === 'out' || dir === 'exit') {
        if (workStarted && !lastOutTime) {
          lastOutTime = time;
        }
      }
    }

    const breakMinutes = Math.round(totalBreakMs / 60000);

    // If ping-based calc found no break but the employee has a complete session ≥ 60 min,
    // fall back to a 30-min default (standard minimum break for any shift-length session).
    await repo.updateAttendanceBreakDuration({ breakMinutes, tenantId, employeeId, dateStr });
  } catch (err) {
    logger.warn({ err }, '[device-events] Failed to calculate break duration');
  }
}

async function handleFaceRecognized(deviceCode, tenantId, payload, eventId) {
  const {
    employee_code,
    employee_id,
    student_code,
    student_id,
    confidence,
    event_time,
    event_time_raw,
    photo_url,
  } = payload;

  // Jetson's face.recognized payload uses direction:"entry"/"exit" (see
  // resolveDirection above, used for the photo-key path) — NOT "in"/"out"/
  // "checkin"/"checkout". Every check-in below was falling through to the
  // checkout branch because "entry" matched neither literal. Normalize once
  // here so every downstream comparison only ever sees 'in' or 'out'.
  const rawDirection = String(payload.direction || '').toLowerCase();
  const direction = (rawDirection === 'out' || rawDirection === 'exit' || rawDirection === 'checkout') ? 'out' : 'in';

  // event_time_raw is only set when resolveEventTimestamp() had to correct an
  // implausible device timestamp (see processEvent) — that same unreliable
  // event is very likely carrying stale/replayed photo content too (verified
  // 2026-07-23: a device replaying old recorded footage). Don't surface that
  // photo as "proof" on the attendance record — the DB write below keeps the
  // real photo_url in the raw device_events log for investigation, this just
  // stops attendance_record.checkin/checkout_photo_url from showing it.
  const attendancePhotoUrl = event_time_raw ? null : photo_url;

  const identifierCode = student_code || employee_code;
  const identifierId = student_id || employee_id;

  if (!identifierCode && !identifierId) return;

  const ts = event_time ? new Date(event_time) : new Date();

  // Resolve site timezone for accurate local-date calculations
  let siteTz = 'Asia/Kolkata'; // Default fallback
  try {
    const tz = await repo.getSiteTimezoneForDevice(deviceCode, tenantId);
    if (tz) {
      siteTz = tz;
    }
  } catch (err) {
    logger.warn({ err }, '[handleFaceRecognized] Failed to resolve site timezone');
  }

  const dateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: siteTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ts);

  // Check vertical
  const vertical = await repo.getTenantVertical(tenantId);
  const isEducation = vertical === 'education';

  if (isEducation) {
    const stud = await repo.findStudentByIdentifier({ tenantId, identifierCode, identifierId });

    if (!stud) return;

    // Presence ping for dwell-time / device-activity analytics (non-fatal).
    repo.insertStudentPresencePing({ tenantId, studentId: stud.pk_student_id, deviceCode, direction, confidence, ts })
      .catch(e => logger.warn('[Event] student presence ping failed: ' + e.message));

    if (direction === 'in') {
      await repo.upsertStudentAttendanceCheckin({ studentId: stud.pk_student_id, tenantId, dateStr, ts, deviceCode, confidence })
        .catch(e => logger.error('[student attendance insert]', e.message));
    } else {
      await repo.upsertStudentAttendanceCheckout({ studentId: stud.pk_student_id, tenantId, dateStr, ts, deviceCode, confidence })
        .catch(e => logger.error('[student attendance update]', e.message));
    }

    try {
      wsManager.emitAttendanceUpdate({
        tenantId,
        employeeId: stud.pk_student_id,
        fullName: stud.name,
        rollNumber: stud.roll_number,
        direction,
        timestamp: ts.toISOString(),
        deviceId: deviceCode,
        confidence,
        vertical: 'education',
      });
    } catch (_) {}
    return;
  }

  // Upsert attendance record
  const emp = await repo.findEmployeeByIdentifier({ tenantId, identifierCode, identifierId });

  if (!emp) {
    // Check if the identifier is a visitor in the person table
    const targetId = identifierId?.toString() || identifierCode || '';
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId);

    if (isUuid) {
      const person = await repo.findPersonByUuid(tenantId, targetId);

      if (person) {
        // 1. Update visitor last seen and visit count
        await repo.touchPersonLastSeen({ personId: person.person_id, ts });

        // 2. Link this event record to the person
        if (eventId) {
          await repo.linkEventToPerson(eventId, person.person_id);
        }

        // 3. Broadcast update to browser/sockets
        try {
          wsManager.broadcastToTenant(tenantId, 'visitor.recognized', {
            person_id: person.person_id,
            full_name: person.full_name,
            person_type: person.person_type,
            direction,
            timestamp: ts.toISOString(),
            device_code: deviceCode,
            confidence,
          });
        } catch (_) {}
      }
    }
    return;
  }

  // Presence ping — must be awaited so the break calc below sees this event's ping.
  const effectiveDeviceCode = payload.cam_id || payload.camera_id || payload.external_device_id || deviceCode;
  try {
    await repo.insertEmployeePresencePing({ tenantId, employeeId: emp.pk_employee_id, deviceCode: effectiveDeviceCode, direction, confidence, ts });
  } catch (e) {
    logger.warn('[Event] employee presence ping failed: ' + e.message);
  }

  if (direction === 'in') {
    await repo.upsertAttendanceCheckin({ employeeId: emp.pk_employee_id, ts, dateStr, photoUrl: attendancePhotoUrl, tenantId })
      .catch(e => {
        logger.error({ err: e }, '[attendance insert]');
        throw e;
      });
  } else {
    await repo.upsertAttendanceCheckout({ employeeId: emp.pk_employee_id, ts, dateStr, photoUrl: attendancePhotoUrl, tenantId })
      .catch(e => {
        logger.error({ err: e }, '[attendance update]');
        throw e;
      });
  }

  // Recalculate break duration and net working_hours from all pings for this day
  await calculateAndUpdateBreakDuration(tenantId, emp.pk_employee_id, dateStr, siteTz);

  const empSiteId = await repo.getEmployeeSiteId(emp.pk_employee_id);

  // The device is meant to debounce its own recognitions (cooldown_seconds
  // in site_config) but has been observed firing 2-3 near-duplicate
  // FACE_DETECTED/EMPLOYEE_ENTRY events within ~1-2 seconds for one actual
  // person — faster than anyone walks past a camera twice. The attendance
  // record itself already dedupes fine (LEAST/GREATEST on check_in/
  // check_out), but each of those events was still producing its own
  // notification + live broadcast, i.e. the same "checked in" toast 2-3
  // times. Suppress the repeat here instead.
  const cooldownSeconds = await repo.getRecognitionCooldownSeconds(empSiteId);
  if (await repo.hasRecentAttendanceNotification(emp.pk_employee_id, cooldownSeconds)) {
    logger.debug({ employeeId: emp.pk_employee_id, cooldownSeconds }, '[Event] Suppressed duplicate attendance notification within cooldown window');
    return;
  }

  // Generate system notification for attendance update
  try {
    await createSystemNotification({
      tenant_id: tenantId,
      site_id: empSiteId,
      alert_type: 'ATTENDANCE_UPDATE',
      severity: 'info',
      title: 'Attendance Update',
      message: `${emp.full_name} (${emp.employee_code}) checked ${direction === 'in' ? 'in' : 'out'}.`,
      fk_employee_id: emp.pk_employee_id,
      photo_url: photo_url || null,
    });
  } catch (e) {
    logger.error('Failed to create attendance notification', e);
  }

  // Broadcast attendance update to browser
  try {
    wsManager.emitAttendanceUpdate({
      tenantId,
      employeeId: emp.pk_employee_id,
      fullName: emp.full_name,
      employeeCode: emp.employee_code,
      direction,
      timestamp: ts.toISOString(),
      deviceId: deviceCode,
      confidence,
      vertical: 'corporate',
    });
  } catch (_) {}
}

// The current C++ binary sends a raw face_crop_base64 JPEG instead of a
// computed embedding vector, so visitor re-identification (matching a new
// detection against previously-seen faces in visitorValidationService.js)
// has nothing to compare. face-quality-svc already runs full InsightFace
// inference (detection + recognition) on every call for enrollment scoring —
// this reuses that same call to also get the recognition embedding it was
// already computing and discarding.
async function computeEmbeddingFromCrop(faceCropBase64) {
  try {
    const buffer = Buffer.from(faceCropBase64, 'base64');
    const QUALITY_SVC = `http://127.0.0.1:${process.env.FACE_QUALITY_PORT || 5050}`;
    const form = new FormData();
    form.append('image', new Blob([buffer], { type: 'image/jpeg' }), 'crop.jpg');
    const res = await fetch(`${QUALITY_SVC}/embed`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.embedding)) return null;
    return { embedding: data.embedding, modelVersion: data.model_version || 'insightface-buffalo_sc' };
  } catch (err) {
    logger.warn({ err }, '[device-events] face-quality-svc embedding call failed');
    return null;
  }
}

async function handleFaceUnknown(deviceCode, tenantId, payload, eventId) {
  const { confidence, photo_url, event_time, visitor_id, fk_person_id } = payload;
  const ts = event_time ? new Date(event_time) : new Date();

  if (!Array.isArray(payload.embedding) && payload.face_crop_base64) {
    const computed = await computeEmbeddingFromCrop(payload.face_crop_base64);
    if (computed) {
      payload.embedding = computed.embedding;
      payload.model_version = payload.model_version || computed.modelVersion;
    }
  }

  // Log to unauthorized_access_log (unchanged — always fires)
  const dev = await repo.findFacilityDeviceForUnknownFace(deviceCode, tenantId);
  if (!dev) return;
  const { pk_device_id: deviceId, site_id: siteId } = dev;

  await repo.insertUnauthorizedAccessLog({ deviceId, ts, confidence, photoUrl: photo_url });

  // ── Visitor buffer — validate before writing to person table ─────────────────
  // Instead of creating a person record immediately, buffer the event.
  // visitorValidationService will validate it within 5 minutes:
  //   • If a matching employee is found → drop (audit logged by the service)
  //   • Otherwise → promote to person table
  const trackingId = visitor_id || fk_person_id || null;
  let personUuid   = null;

  if (trackingId) {
    const FRS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trackingId);
    personUuid   = isUuid ? trackingId : uuidv5(trackingId, FRS_NAMESPACE);

    // If this person_uuid is already confirmed in person table (returning visitor),
    // skip the buffer and update directly — no validation needed.
    const existingPerson = await repo.findExistingPersonByUuid(personUuid);

    if (existingPerson && existingPerson.person_type !== 'employee') {
      // Returning visitor — update last_seen and visit_count directly
      await repo.updateReturningVisitor({ personUuid, ts, photoUrl: photo_url })
        .catch(err => logger.warn({ err }, '[device-events] person update failed'));

      if (eventId) {
        await repo.linkEventToPersonSilent(personUuid, eventId);
      }
      return;
    }
  }

  // New face (no existing person record) → write to buffer for validation
  repo.insertVisitorBuffer({
    tenantId, siteId, deviceCode, trackingId, personUuid,
    photoUrl: photo_url, confidence, payload: { ...payload, _event_id: eventId }, ts,
  }).catch(err => {
    // visitor_buffer table may not exist yet — fall back to direct person insert
    if (err.code === '42P01') {
      logger.warn('[device-events] visitor_buffer table missing — run migration 007. Falling back to direct person insert.');
      if (!personUuid) return;
      const label = payload.person_type === 'visitor' ? 'Visitor' : 'Unknown Person';
      repo.insertFallbackPerson({ personUuid, tenantId, label, photoUrl: photo_url, ts });
    } else {
      logger.error({ err }, '[device-events] visitor_buffer insert failed');
    }
  });
}

async function handleAccessEvent(deviceCode, tenantId, eventType, payload) {
  // Access events are already captured via face.recognized / face.unknown
  // This handler exists for explicit access control events from the device
  try {
    wsManager.broadcastToTenant(tenantId, 'accessEvent', {
      device_code: deviceCode,
      event_type: eventType,
      ...payload,
      timestamp: new Date().toISOString(),
    });
  } catch (_) {}
}

async function handleEnrollmentCompleted(deviceCode, tenantId, payload) {
  logger.info({ deviceCode, tenantId, payload: { ...payload, embedding: payload.embedding ? `Array(${payload.embedding.length})` : null } }, '[handleEnrollmentCompleted] entered');
  const {
    employee_id,
    employee_code,
    student_id,
    student_code,
    embedding,
    confidence,
    photo_path,
    angle,
    model_version: payloadModelVersion,
  } = payload;

  // Prefer the model_version reported in the payload (Jetson should include it).
  // Fall back to env override, then the column default. Never silently tag new
  // embeddings as arcface-r50-fp16 when the engine may have changed.
  const resolvedModelVersion = payloadModelVersion
    || process.env.JETSON_MODEL_VERSION
    || 'arcface-r50-fp16';

  const identifierCode = student_code || employee_code;
  const identifierId = student_id || employee_id;

  if (!identifierCode && !identifierId) {
    logger.info('[handleEnrollmentCompleted] return early: no identifierCode and no identifierId');
    return;
  }

  const vertical = await repo.getTenantVertical(tenantId);
  const isEducation = vertical === 'education';

  if (isEducation) {
    // Find student
    const studId = await repo.findStudentByIdentifierForEnrollment({ tenantId, identifierCode, identifierId });
    if (!studId) return;

    // Save embedding if provided
    if (Array.isArray(embedding) && embedding.length >= 128) {
      const vectorStr = `[${embedding.join(',')}]`;

      // ── CHECK FOR DUPLICATE ENROLLMENT ──
      const duplicateCheck = await repo.findDuplicateStudentEmbedding({ vectorStr, studentId: studId, modelVersion: resolvedModelVersion });

      if (duplicateCheck.length > 0) {
        const reason = `This face is already registered in the system under a different name (${duplicateCheck[0].name}).`;
        await handleEnrollmentFailed(deviceCode, tenantId, {
          student_id, student_code, reason,
        });
        return;
      }

      const existing = await repo.listStudentEmbeddings(studId);
      if (existing.length >= 8) {
        await repo.deleteStudentEmbedding(existing[0].id);
      }
      const isPrimary = existing.length === 0;

      await repo.insertStudentEmbedding({ studentId: studId, vectorStr, confidence, isPrimary, photoPath: photo_path, modelVersion: resolvedModelVersion });
    }

    if (photo_path) {
      await repo.updateStudentPhotoPath(studId, photo_path);
    }

    // Broadcast to browser so the enrollment UI updates in real-time
    try {
      wsManager.broadcastToTenant(tenantId, 'enrollment.completed', {
        student_id: studId,
        student_code: identifierCode,
        device_code: deviceCode,
        confidence,
        angle,
        timestamp: new Date().toISOString(),
        vertical: 'education',
      });
    } catch (_) {}
    return;
  }

  // Attempt to resolve mismatching DB employee ID by photo filename in active command
  let empId = null;
  let resolvedEmpCode = null;
  let activeCommandId = null;

  const cmdRows = await repo.findActiveEnrollFromPhotoCommand({ deviceCode, employeeId: employee_id, employeeCode: employee_code });

  if (cmdRows.length > 0) {
    const cmd = cmdRows[0];
    activeCommandId = cmd.id;
    const photoUrl = cmd.payload?.photo_url;
    if (photoUrl) {
      const filename = photoUrl.split('/').pop();
      const invRows = await repo.findInvitationByPhotoFilename(filename);

      if (invRows.length > 0) {
        empId = invRows[0].fk_employee_id;
        const empCodeRows = await repo.findEmployeeCode(empId);
        if (empCodeRows.length > 0) {
          resolvedEmpCode = empCodeRows[0].employee_code;
        }
      }
    }
  }

  logger.info({ empId, resolvedEmpCode, activeCommandId }, '[handleEnrollmentCompleted] command resolution complete');

  // Fallback to direct payload lookup
  if (!empId) {
    logger.info('[handleEnrollmentCompleted] falling back to direct payload lookup');
    const empRows = await repo.findEmployeeByIdentifierForEnrollment({ tenantId, identifierCode, identifierId });
    if (empRows.length > 0) {
      empId = empRows[0].pk_employee_id;
      resolvedEmpCode = empRows[0].employee_code;
      logger.info({ empId, resolvedEmpCode }, '[handleEnrollmentCompleted] fallback lookup succeeded');
    } else {
      logger.info('[handleEnrollmentCompleted] fallback lookup failed');
    }
  }

  if (!empId) {
    logger.warn('[handleEnrollmentCompleted] empId not found, returning early');
    return;
  }

  const finalEmpCode = resolvedEmpCode || identifierCode || employee_code;

  if (activeCommandId) {
    logger.info({ activeCommandId }, '[handleEnrollmentCompleted] setting status of active command to done');
    await repo.markDeviceCommandDone(activeCommandId)
      .catch((err) => { logger.error({ err }, 'Failed to set command status to done'); });
  }

  logger.info({ empId, finalEmpCode, embeddingIsArray: Array.isArray(embedding), embeddingLength: embedding?.length }, '[handleEnrollmentCompleted] preparing to save embedding');

  // Save embedding if provided
  if (Array.isArray(embedding) && embedding.length >= 128) {
    const vectorStr = `[${embedding.join(',')}]`;

    // ── CHECK FOR DUPLICATE ENROLLMENT ──
    const duplicateCheck = await repo.findDuplicateEmployeeEmbeddingForEvent({ vectorStr, employeeId: empId, modelVersion: resolvedModelVersion });

    if (duplicateCheck.length > 0) {
      const reason = `This face is already registered in the system under a different name (${duplicateCheck[0].full_name}).`;

      // Update invitation status if it exists
      await repo.markInvitationEmbeddingFailedForEmployee(empId, reason);

      await handleEnrollmentFailed(deviceCode, tenantId, {
        employee_id, employee_code, reason,
      });
      return;
    }

    const existing = await repo.listEmployeeEmbeddings(empId);
    if (existing.length >= 8) {
      await repo.deleteEmployeeEmbedding(existing[0].id);
    }
    const isPrimary = existing.length === 0;

    // The Jetson's own payload.photo_path is preferred if present, but not
    // guaranteed (device firmware isn't ours to control) — fall back to the
    // S3 key the backend already knows for this employee+angle, the same one
    // used to build the pre-signed URL the Jetson downloaded from.
    const resolvedPhotoPath = photo_path || (angle ? await repo.getLatestInvitationPhotoPath(empId, angle).catch(() => null) : null);

    await repo.insertEmployeeEmbeddingForEvent({ employeeId: empId, vectorStr, confidence, isPrimary, photoPath: resolvedPhotoPath, modelVersion: resolvedModelVersion, angle })
      .catch((err) => {
        logger.error({ err }, 'Failed to insert employee face embedding');
      });
  }

  // Mark kiosk enrollment complete and set face_enrolled flag
  await repo.markEmployeeKioskEnrolled(empId);

  // Update corresponding invitation status if it exists
  await repo.markInvitationEnrollmentSuccess(empId);

  // Broadcast to browser so the enrollment UI updates in real-time
  try {
    wsManager.broadcastToTenant(tenantId, 'enrollment.completed', {
      employee_id: empId,
      employee_code: finalEmpCode,
      device_code: deviceCode,
      confidence,
      angle,
      timestamp: new Date().toISOString(),
      vertical: 'corporate',
    });
  } catch (_) {}
}

async function handleEnrollmentFailed(deviceCode, tenantId, payload) {
  const {
    employee_id,
    employee_code,
    student_id,
    student_code,
    reason,
    angle,
  } = payload;

  const identifierCode = student_code || employee_code;
  const identifierId = student_id || employee_id;

  const vertical = await repo.getTenantVertical(tenantId);
  const isEducation = vertical === 'education';

  if (isEducation) {
    const studId = await repo.findStudentByIdentifierForEnrollment({ tenantId, identifierCode, identifierId });

    try {
      wsManager.broadcastToTenant(tenantId, 'enrollment.failed', {
        student_id: studId ?? identifierId,
        student_code: identifierCode,
        device_code: deviceCode,
        reason,
        angle,
        timestamp: new Date().toISOString(),
        vertical: 'education',
      });
    } catch (_) {}
    return;
  }

  // Attempt to resolve mismatching DB employee ID by photo filename in active command
  let empId = null;
  let resolvedEmpCode = null;
  let activeCommandId = null;

  const cmdRows = await repo.findActiveEnrollFromPhotoCommand({ deviceCode, employeeId: employee_id, employeeCode: employee_code });

  if (cmdRows.length > 0) {
    const cmd = cmdRows[0];
    activeCommandId = cmd.id;
    const photoUrl = cmd.payload?.photo_url;
    if (photoUrl) {
      const filename = photoUrl.split('/').pop();
      const invRows = await repo.findInvitationByPhotoFilename(filename);

      if (invRows.length > 0) {
        empId = invRows[0].fk_employee_id;
        const empCodeRows = await repo.findEmployeeCode(empId);
        if (empCodeRows.length > 0) {
          resolvedEmpCode = empCodeRows[0].employee_code;
        }
      }
    }
  }

  // Fallback to direct payload lookup
  if (!empId) {
    const empRows = await repo.findEmployeeByIdentifierForEnrollment({ tenantId, identifierCode, identifierId });
    if (empRows.length > 0) {
      empId = empRows[0].pk_employee_id;
      resolvedEmpCode = empRows[0].employee_code;
    }
  }

  const finalEmpCode = resolvedEmpCode || identifierCode || employee_code;

  if (activeCommandId) {
    await repo.markDeviceCommandFailed(activeCommandId);
  }

  if (empId) {
    await repo.clearEmployeeKioskEnrollmentStatus(empId);
  }

  try {
    wsManager.broadcastToTenant(tenantId, 'enrollment.failed', {
      employee_id: empId || identifierId,
      employee_code: finalEmpCode,
      device_code: deviceCode,
      reason,
      angle,
      timestamp: new Date().toISOString(),
      vertical: 'corporate',
    });
  } catch (_) {}
}

// ─── Photo upload ───────────────────────────────────────────────────────────
// Two-step upload used by Jetson firmware that can't embed base64 in the
// event payload: upload the photo here first, then reference the returned
// key as frameUrl/photo_url in the actual POST /api/events call. Identity
// (employee/visitor + direction) may not be known yet at upload time, so
// when it's omitted the photo still lands in S3 — just under a tenant-scoped
// staging key rather than the fully organized folder structure.

export async function saveDevicePhoto({ tenantId, fileBuffer, mimetype, employeeCode, visitorId, direction }) {
  const ext = mimetype === 'image/png' ? 'png' : 'jpg';

  if (employeeCode || visitorId) {
    const kind = employeeCode ? 'employee' : 'visitor';
    const id = employeeCode || visitorId;
    const safeId = sanitizeForKey(id);
    const dir = direction === 'out' ? 'out' : 'in';
    const { dateStr, timeStr } = eventDateTimeParts();
    const filename = buildEventPhotoFilename({ kind, name: employeeCode, id, dateStr, timeStr });
    const key = buildEventPhotoKey({ tenantId, kind, safeId, dateStr, direction: dir, filename });
    await storage.uploadFile(storage.LOGS_BUCKET, key, fileBuffer, mimetype || 'image/jpeg');
    return { url: key, filename };
  }

  // No identity yet — tenant-scoped staging key, still S3, never local disk.
  const filename = `${randomUUID()}.${ext}`;
  const key = `tenant-${tenantId}/_incoming/${filename}`;
  await storage.uploadFile(storage.LOGS_BUCKET, key, fileBuffer, mimetype || 'image/jpeg');
  return { url: key, filename };
}

// ─── Command polling ────────────────────────────────────────────────────────

export async function drainCommands({ deviceCode, deviceId }) {
  const legacy = await repo.drainLegacyCommands(deviceCode);
  if (legacy.__err) {
    logger.error({ err: legacy.__err, deviceCode }, 'Failed to fetch pending commands');
  }

  const queued = await repo.drainQueuedCommands(deviceId);
  if (queued.__err) {
    logger.error({ err: queued.__err, deviceCode }, 'Failed to fetch queued commands');
  }

  return [...legacy.rows, ...queued.rows];
}
