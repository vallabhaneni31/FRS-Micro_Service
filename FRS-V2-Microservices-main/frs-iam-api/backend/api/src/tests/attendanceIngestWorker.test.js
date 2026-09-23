/**
 * PERF-0001 — attendanceIngestWorker.
 *   AC5 idempotency: duplicate delivery dispatches to the (idempotent) markAttendance.
 *   AC6 failure:     on exhausted retries the worker publishes to the DLQ and does
 *                    NOT throw (so the offset commits).
 */
import test from "node:test";
import assert from "node:assert";
import { handleIngestEvent } from "../core/workers/attendanceIngestWorker.js";
import attendanceService from "../services/business/AttendanceService.js";
import kafkaProducer from "../core/kafka/KafkaProducer.js";

const attEvent = (empId) => ({
  id: `att_t_${empId}_1`, kind: "attendance", tenantId: "t", employeeId: String(empId),
  mark: { employeeId: String(empId), direction: "entry", scope: { tenantId: "t" } },
});

test("AC5 — duplicate delivery dispatches to markAttendance (idempotent UPSERT op)", async () => {
  const origMark = attendanceService.markAttendance;
  const calls = [];
  attendanceService.markAttendance = async (p) => { calls.push(p); return {}; };
  try {
    const ev = attEvent(42);
    await handleIngestEvent(ev, { retries: 0, delayMs: 0 });
    await handleIngestEvent(ev, { retries: 0, delayMs: 0 }); // redelivery
    assert.strictEqual(calls.length, 2, "both deliveries call markAttendance");
    assert.deepStrictEqual(calls[0], calls[1], "same payload — collapses to one row via the DB UPSERT");
  } finally {
    attendanceService.markAttendance = origMark;
  }
});

test("AC6 — exhausted retries route the message to the DLQ and do not throw", async () => {
  const origMark = attendanceService.markAttendance;
  const origDlq = kafkaProducer.routeToDeadLetter;
  const dlq = [];
  attendanceService.markAttendance = async () => { throw new Error("db down"); };
  kafkaProducer.routeToDeadLetter = async (topic, message, error) => { dlq.push({ topic, message, error }); };
  try {
    await assert.doesNotReject(handleIngestEvent(attEvent(42), { retries: 2, delayMs: 0 }));
    assert.strictEqual(dlq.length, 1, "one DLQ publish after retries exhausted");
    assert.strictEqual(dlq[0].topic, kafkaProducer.topics.attendanceIngest, "DLQ tagged with source topic");
    assert.strictEqual(dlq[0].message.key, "42", "DLQ keyed by employeeId");
    assert.ok(/db down/.test(dlq[0].error.message), "carries the failure cause");
  } finally {
    attendanceService.markAttendance = origMark;
    kafkaProducer.routeToDeadLetter = origDlq;
  }
});
