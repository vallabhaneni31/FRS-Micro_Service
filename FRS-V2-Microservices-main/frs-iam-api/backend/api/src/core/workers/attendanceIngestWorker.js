/**
 * attendanceIngestWorker.js (PERF-0001)
 *
 * Consumer side of write-behind attendance ingest. Drains the `attendance-ingest`
 * topic and applies each event:
 *   - kind 'attendance' → the EXISTING attendanceService.markAttendance (no logic
 *     re-implemented; UPSERT is idempotent + commutative, so at-least-once
 *     redelivery is safe).
 *   - kind 'frame'      → attach the proof-frame URL to the row (N2 mitigation).
 *
 * Ordering/concurrency: events are keyed by employeeId, so a person's events land
 * in one partition and are processed in order (mark before its frame). kafkajs
 * gives cross-partition concurrency; we do NOT parallelise within a partition
 * (that would reorder a person's events).
 *
 * Failure handling (AC6): retry within a bounded budget; on exhaustion publish the
 * message to the dead-letter topic explicitly (the producer's routeToDeadLetter
 * only fires on producer-send failure, not consumer failure) and let the offset
 * commit so the consumer never gets stuck.
 */
import kafkaEventService from "../kafka/KafkaEventService.js";
import kafkaProducer from "../kafka/KafkaProducer.js";
import attendanceService from "../../services/business/AttendanceService.js";
import { pool } from "../../db/pool.js";
import logger from "../../utils/logger.js";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Attach a frame URL to an existing attendance row. Because the frame event is
 * keyed by employeeId (same partition, processed after the mark), a plain UPDATE
 * normally finds the row; if it doesn't (reordering / worker lag), we retry a few
 * times to give the mark time to land, then surface a miss to the caller.
 * @returns {boolean} true if a row was updated
 */
export async function applyFrameUrl(frame, tenantId, { retries = MAX_RETRIES, delayMs = RETRY_DELAY_MS } = {}) {
  const col = frame.type === "checkout" ? "checkout_frame_url" : "checkin_frame_url";
  const date = frame.date || new Date().toISOString().slice(0, 10);
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await pool.query(
      `UPDATE attendance_record
         SET ${col} = $1, frame_url = COALESCE(frame_url, $1)
       WHERE fk_employee_id = $2
         AND attendance_date = $3
         AND tenant_id = $4`,
      [frame.frameUrl, Number(frame.employeeId ?? frame.employee_id), date, tenantId]
    );
    if (result.rowCount > 0) return true;
    if (attempt < retries) await sleep(delayMs);
  }
  return false;
}

/**
 * Apply a single ingest event. Owns its own retry + DLQ and never throws, so the
 * offset commits after it resolves.
 */
export async function handleIngestEvent(event, opts = {}) {
  const retries = opts.retries ?? MAX_RETRIES;
  const delayMs = opts.delayMs ?? RETRY_DELAY_MS;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (event.kind === "attendance") {
        await attendanceService.markAttendance(event.mark);
        return;
      }
      if (event.kind === "frame") {
        const ok = await applyFrameUrl({ ...event.frame, employeeId: event.employeeId }, event.tenantId, { retries, delayMs });
        if (ok) return;
        lastErr = new Error("frame attach found no attendance row after retries");
        break; // no point retrying the outer loop — applyFrameUrl already retried
      }
      logger.warn({ kind: event.kind, id: event.id }, "[attendanceIngestWorker] unknown event kind — dropping");
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(delayMs);
    }
  }

  // Retries exhausted → dead-letter explicitly, then return (commit offset).
  logger.error({ err: lastErr, id: event.id, kind: event.kind }, "[attendanceIngestWorker] giving up — routing to DLQ");
  try {
    await kafkaProducer.routeToDeadLetter(
      kafkaProducer.topics.attendanceIngest,
      { key: event.employeeId, value: JSON.stringify(event) },
      lastErr
    );
  } catch (dlqErr) {
    logger.error({ err: dlqErr, id: event.id }, "[attendanceIngestWorker] failed to route to DLQ");
  }
}

/** Wire the consumer. Call once after the server starts listening. */
export async function startAttendanceIngestWorker() {
  await kafkaEventService.subscribeToAttendanceIngest((event) => handleIngestEvent(event));
  logger.info("[attendanceIngestWorker] subscribed to attendance-ingest");
}

export default { startAttendanceIngestWorker, handleIngestEvent, applyFrameUrl };
