/**
 * attendanceIngestPublisher.js (PERF-0001)
 *
 * Producer side of write-behind attendance ingest. Device-originated marks and
 * frame-URL attaches are published to the dedicated `attendance-ingest` Kafka
 * topic (keyed by employeeId) and applied later by attendanceIngestWorker, so
 * the request path returns 202 without touching the DB.
 *
 * The dual-write flag lives in env (ATTENDANCE_WRITE_MODE / ATTENDANCE_ASYNC_TENANTS);
 * when a tenant is in `sync` mode the caller takes the existing synchronous path.
 *
 * IMPORTANT: never put biometric data (face embeddings / photo bytes) in these
 * events — only the fields markAttendance already needs (DPIA).
 */
import kafkaEventService from "../../core/kafka/KafkaEventService.js";
import { env } from "../../config/env.js";

/**
 * Should this tenant's device-originated marks be written asynchronously?
 * True when the global mode is 'async', or the tenant is in the per-tenant allowlist.
 * @param {string} tenantId
 * @returns {boolean}
 */
export function shouldWriteAsync(tenantId) {
  if (env.attendance.writeMode === "async") return true;
  return !!tenantId && env.attendance.asyncTenants.includes(String(tenantId));
}

/**
 * Trace/partition id only — NOT the idempotency key. Idempotency comes from the
 * DB UPSERT on (tenant_id, fk_employee_id, attendance_date).
 */
export function buildEventId(tenantId, employeeId) {
  return `att_${tenantId}_${employeeId}_${Date.now()}`;
}

/**
 * Publish a single device-originated attendance mark. `mark` is exactly the
 * payload markAttendance expects ({ employeeId, deviceId, timestamp, confidence,
 * direction, trackId, scope }). Keyed by employeeId for per-person ordering.
 * @param {object} mark
 */
export async function publishAttendanceMark(mark) {
  const employeeId = String(mark.employeeId);
  const tenantId = mark.scope?.tenantId;
  const event = {
    id: buildEventId(tenantId, employeeId),
    kind: "attendance",
    tenantId,
    employeeId,
    mark,
  };
  await kafkaEventService.publishAttendanceIngest(event, employeeId);
  return event.id;
}

/**
 * Publish a frame-URL attach. Applied by the worker AFTER the employee's mark
 * (same partition, keyed by employeeId), so the URL is never lost to the
 * write-behind race (N2). Carries only frame metadata — no image bytes.
 * @param {{tenantId:string, employeeId:(string|number), date:string, type:string, frameUrl:string}} frame
 */
export async function publishFrameAttach(frame) {
  const employeeId = String(frame.employeeId);
  const event = {
    id: buildEventId(frame.tenantId, employeeId),
    kind: "frame",
    tenantId: frame.tenantId,
    employeeId,
    frame: { date: frame.date, type: frame.type, frameUrl: frame.frameUrl },
  };
  await kafkaEventService.publishAttendanceIngest(event, employeeId);
  return event.id;
}
