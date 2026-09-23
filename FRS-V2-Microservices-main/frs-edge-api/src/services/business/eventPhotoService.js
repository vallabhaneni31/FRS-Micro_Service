/**
 * eventPhotoService.js — shared identity/direction resolution + S3 upload for
 * event-driven photos (attendance check-in/out, unrecognized-face detections).
 * Extracted from DeviceEventService.js so FaceController's legacy recognition
 * pipeline and PersonService's visitor registration can share the exact same
 * key-building logic instead of each re-deriving it slightly differently.
 */
import { randomUUID } from 'crypto';
import * as repo from '../../repositories/deviceEventRepository.js';
import * as storage from '../storageService.js';
import { sanitizeForKey, eventDateTimeParts, buildEventPhotoKey, buildEventPhotoFilename } from '../../utils/s3KeyBuilder.js';

export async function resolveEventIdentity(tenantId, payload) {
  const employeeOrStudent =
    payload.employee_code || payload.employeeCode ||
    payload.employee_id || payload.employeeId ||
    payload.student_code || payload.studentCode ||
    payload.student_id || payload.studentId;

  if (employeeOrStudent) {
    const emp = await repo.findEmployeeByIdentifier({
      tenantId,
      identifierCode: String(employeeOrStudent),
      identifierId: String(employeeOrStudent),
    }).catch(() => null);
    const id = emp?.employee_code || String(employeeOrStudent);
    const name = emp?.full_name || id;
    return { kind: 'employee', id, name };
  }

  // visitor_id/fk_person_id, or (truly unknown, no identifier yet) a fresh
  // UUID — matches the buffered-visitor UUID scheme visitorValidationService
  // / handleFaceUnknown uses once it promotes the event to visitor_buffer.
  const id = payload.visitor_id || payload.fk_person_id || randomUUID();
  return { kind: 'visitor', id, name: id };
}

export function resolveDirection(eventType, payload) {
  const raw = String(payload.direction || '').toLowerCase();
  if (raw === 'out' || raw === 'exit' || eventType === 'attendance.checkout') return 'out';
  return 'in';
}

/**
 * @param {{ tenantId: string, eventType?: string, payload: object, buffer: Buffer, direction?: 'in'|'out' }} args
 * @returns {Promise<string>} the S3 key
 */
export async function uploadEventPhoto({ tenantId, eventType, payload, buffer, direction }) {
  const { kind, id, name } = await resolveEventIdentity(tenantId, payload);
  const dir = direction || resolveDirection(eventType, payload);
  const { dateStr, timeStr } = eventDateTimeParts(payload.event_time);
  const safeId = sanitizeForKey(id);
  const filename = buildEventPhotoFilename({ kind, name, id, dateStr, timeStr });
  const key = buildEventPhotoKey({ tenantId, kind, safeId, dateStr, direction: dir, filename });
  await storage.uploadFile(storage.LOGS_BUCKET, key, buffer, 'image/jpeg');
  return key;
}
