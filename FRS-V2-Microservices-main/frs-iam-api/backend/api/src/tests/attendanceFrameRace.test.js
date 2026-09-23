/**
 * PERF-0001 AC10 — the write-behind frame-URL race (N2).
 * When a frame-attach arrives before the async mark has written the row, the
 * worker retries the UPDATE (giving the mark time to land) so the frame URL is
 * NOT lost. If the row never appears, it dead-letters instead of silently dropping.
 */
import test from "node:test";
import assert from "node:assert";
import { applyFrameUrl, handleIngestEvent } from "../core/workers/attendanceIngestWorker.js";
import kafkaProducer from "../core/kafka/KafkaProducer.js";
import { pool } from "../db/pool.js";

const frameEvent = () => ({
  id: "att_t_42_1", kind: "frame", tenantId: "t", employeeId: "42",
  frame: { date: "2026-05-24", type: "checkin", frameUrl: "https://x/f.jpg" },
});

test("AC10 — frame attach retries when the row isn't there yet, then succeeds", async () => {
  const origQuery = pool.query;
  let attempt = 0;
  // First UPDATE finds no row (mark not written yet), second finds it.
  pool.query = async () => { attempt++; return { rowCount: attempt >= 2 ? 1 : 0 }; };
  try {
    const ok = await applyFrameUrl(
      { employeeId: "42", date: "2026-05-24", type: "checkin", frameUrl: "https://x/f.jpg" },
      "t", { retries: 3, delayMs: 0 }
    );
    assert.strictEqual(ok, true, "frame URL lands once the mark row appears");
    assert.ok(attempt >= 2, "it retried rather than losing the URL on the first miss");
  } finally {
    pool.query = origQuery;
  }
});

test("AC10 — frame attach that never finds a row is dead-lettered, not dropped", async () => {
  const origQuery = pool.query;
  const origDlq = kafkaProducer.routeToDeadLetter;
  const dlq = [];
  pool.query = async () => ({ rowCount: 0 });               // row never appears
  kafkaProducer.routeToDeadLetter = async (topic, message) => { dlq.push({ topic, message }); };
  try {
    await assert.doesNotReject(handleIngestEvent(frameEvent(), { retries: 2, delayMs: 0 }));
    assert.strictEqual(dlq.length, 1, "a permanent miss is dead-lettered");
    assert.strictEqual(dlq[0].message.key, "42");
  } finally {
    pool.query = origQuery;
    kafkaProducer.routeToDeadLetter = origDlq;
  }
});
