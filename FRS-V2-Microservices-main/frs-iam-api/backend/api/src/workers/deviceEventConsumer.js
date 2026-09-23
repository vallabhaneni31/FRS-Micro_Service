/**
 * deviceEventConsumer.js — standalone worker process (run separately from
 * frs-backend under its own PM2 app) that consumes Jetson device events off
 * Kafka and applies them via the existing, unmodified
 * DeviceEventService.processEvent — the same function that used to run
 * inline inside the HTTP request handler.
 *
 * This is the async half of the decoupling: DeviceEventController now only
 * authenticates, validates, and publishes to `frs.jetson-device-events`
 * before returning 202. Everything that used to happen before the HTTP
 * response (base64 decode, S3 upload, DB writes, attendance/visitor logic,
 * WebSocket broadcast) now happens here instead, off the request path.
 *
 * Idempotency: Kafka only guarantees at-least-once delivery, so the same
 * message can arrive more than once (consumer restart mid-batch, rebalance,
 * broker retry). Before calling processEvent, this claims the producer's
 * event_uid in the event_dedup table via INSERT ... ON CONFLICT DO NOTHING.
 * If no row comes back, someone already claimed it — skip entirely, so a
 * redelivered message never re-uploads a photo or re-runs attendance logic.
 *
 * Batching: messages are consumed via runBatch (kafkajs eachBatch) instead
 * of one-at-a-time. The event_dedup claim is done as a SINGLE multi-row
 * INSERT for the whole batch (one round trip instead of N), including
 * duplicates that arrive within the same batch, not just across batches.
 * processEvent itself is still called per-event, in order — deliberately
 * NOT parallelized, since events in the same batch can belong to the same
 * partition (partitioned by tenant_id) and Kafka's ordering guarantee
 * within a partition would otherwise buy nothing: concurrent processEvent
 * calls could complete out of order (e.g. a checkout landing before its
 * checkin for the same employee). Sequential-within-batch keeps that
 * ordering guarantee intact while still cutting the dedup step from O(N)
 * round trips to O(1).
 *
 * Failures: a bounded number of in-process retries with backoff per event,
 * then that message is routed to the frs.dead-letter topic (via the
 * existing KafkaProducer.routeToDeadLetter) rather than silently dropped,
 * endlessly retried against a poison message, or allowed to block the rest
 * of the batch indefinitely.
 */
import sharp from 'sharp';
import KafkaConsumer from '../core/kafka/KafkaConsumer.js';
import kafkaConfig from '../core/kafka/KafkaConfig.js';
import kafkaProducer from '../core/kafka/KafkaProducer.js';
import { pool } from '../db/pool.js';
import logger from '../utils/logger.js';
import { processEvent } from '../services/business/DeviceEventService.js';

// FRS-ARCH-002 Phase 6 (R6): same cap as server.js — see that file's comment.
// This process also calls into DeviceEventService, which uses sharp.
sharp.concurrency(2);

const TOPIC = 'frs.jetson-device-events';
const GROUP_ID = `${kafkaConfig.groupId}-jetson-device-events`;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Claims a whole batch's event_uids in one round trip. Returns the Set of
 * event_uids that THIS call newly claimed — anything not in the set was
 * already claimed (by a prior batch, another consumer, or a duplicate
 * earlier in this same batch) and should be skipped.
 */
async function claimBatch(eventUids) {
  if (eventUids.length === 0) return new Set();
  const { rows } = await pool.query(
    `INSERT INTO event_dedup (event_uid)
     SELECT DISTINCT unnest($1::uuid[])
     ON CONFLICT (event_uid) DO NOTHING
     RETURNING event_uid`,
    [eventUids]
  );
  return new Set(rows.map((r) => r.event_uid));
}

async function processOne(parsed, rawMessage) {
  const { event_uid, device_code, tenant_id, event_type, payload } = parsed;

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await processEvent(device_code, tenant_id, event_type, payload);
      return;
    } catch (err) {
      lastErr = err;
      logger.warn(
        { err, event_uid, attempt, maxAttempts: MAX_ATTEMPTS },
        '[deviceEventConsumer] processEvent failed, will retry'
      );
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }
  }

  logger.error({ err: lastErr, event_uid }, '[deviceEventConsumer] Exhausted retries — routing to DLQ');
  await kafkaProducer.routeToDeadLetter(TOPIC, rawMessage, lastErr);
}

async function handleBatch({ messages }) {
  const parsedEntries = [];
  for (const message of messages) {
    try {
      const parsed = JSON.parse(message.value?.toString() || '{}');
      parsedEntries.push({ parsed, message });
    } catch (err) {
      logger.error({ err }, '[deviceEventConsumer] Unparseable message — routing to DLQ');
      await kafkaProducer.routeToDeadLetter(TOPIC, message, err);
    }
  }
  if (parsedEntries.length === 0) return;

  // Batch the dedup claim — events with no event_uid (shouldn't happen from
  // the current producer, but don't assume) are processed unconditionally
  // rather than dropped, matching the previous per-message behavior.
  const eventUids = parsedEntries
    .map((e) => e.parsed.event_uid)
    .filter(Boolean);
  const claimed = await claimBatch(eventUids);

  for (const { parsed, message } of parsedEntries) {
    const { event_uid } = parsed;
    if (event_uid && !claimed.has(event_uid)) {
      logger.info({ event_uid }, '[deviceEventConsumer] Duplicate delivery — already claimed, skipping');
      continue;
    }
    await processOne(parsed, message);
  }
}

async function main() {
  const consumer = new KafkaConsumer(GROUP_ID);

  consumer.on('handlerError', ({ topic, partition, error }) => {
    logger.error({ err: error, topic, partition }, '[deviceEventConsumer] Unhandled error in batch handler');
  });
  consumer.on('crash', (event) => {
    logger.error({ event }, '[deviceEventConsumer] Consumer crashed');
  });

  await consumer.subscribe([TOPIC]);
  await consumer.runBatch(handleBatch);

  logger.info({ topic: TOPIC, groupId: GROUP_ID }, '[deviceEventConsumer] Started, consuming device events (batched)');
}

main().catch((err) => {
  logger.error({ err }, '[deviceEventConsumer] Fatal startup error');
  process.exit(1);
});
