/**
 * recoverIncident20260908.js — one-off recovery for events lost to
 * frs.dead-letter, caused by two overlapping schema-drift bugs in
 * DeviceEventService.js / deviceEventRepository.js, both fixed 2026-09-08:
 *   - tenants.vertical missing: broke attendance.checkin/checkout only,
 *     from 2026-09-07 08:47 UTC onward
 *   - public.devices table + facility_device.last_active/last_heartbeat/
 *     model/device_config columns missing: broke every event type,
 *     2026-09-08 06:06:23-06:37:03 UTC
 * Every event type failed at a point in processEvent before any usable DB
 * write, so — unlike the narrower 2026-07-28 checkin-only recovery this is
 * modeled on — this incident isn't scoped to one event type, and replaying
 * by hand-reimplementing each type's handler would just risk introducing
 * new bugs. Since the actual bugs are now fixed in processEvent() itself,
 * this replays through that same, now-corrected production function
 * instead of repository calls.
 *
 * Devices already got their 202 and discarded their own copies, so
 * frs.dead-letter is the only remaining source for these events. Reads it
 * from the beginning under a disposable consumer group (does not touch the
 * live consumer group's offsets or event_dedup — processEvent() has no
 * dedup check of its own, so this is safe to call directly). No start-time
 * filter is needed: Kafka's retention already aged out everything before
 * 2026-09-07 08:48:29 UTC (confirmed via kafka-get-offsets, earliest
 * available offset > 0), which includes the entire already-recovered
 * 2026-07-28 incident — nothing from that recovery is still in this topic
 * to accidentally touch. Only an end-time cutoff (today's fix deployment)
 * is applied, using the dead-letter message's own broker timestamp, so
 * anything dead-lettered after the fix (a different, new problem) is left
 * alone rather than blindly replayed.
 *
 * Some recovered events are now over a day old, others only a few hours —
 * this intentionally does NOT suppress notifications/websocket broadcasts.
 * Building suppression would mean threading a flag through processEvent()
 * and its handlers, which DeviceEventService.js's own header comment flags
 * as live production logic not meant for incidental changes — a real
 * modification under incident time pressure, not a safe one. Data
 * correctness (attendance records existing, matching what actually
 * happened) is what was asked for; a burst of stale notifications is a
 * minor, self-resolving side effect by comparison. A small delay between
 * events avoids hammering the DB/S3/websocket layer with a simultaneous
 * burst.
 *
 * Usage: node src/scripts/recoverIncident20260908.js
 */
import { Kafka } from 'kafkajs';
import kafkaConfig from '../core/kafka/KafkaConfig.js';
import logger from '../utils/logger.js';
import { processEvent } from '../services/business/DeviceEventService.js';

const DLQ_TOPIC = 'frs.dead-letter';
const SOURCE_TOPIC = 'frs.jetson-device-events';
const INCIDENT_END = new Date('2026-09-08T06:40:00Z').getTime();
const DELAY_BETWEEN_MS = 150;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const kafka = new Kafka(kafkaConfig.getKafkaConfig());
  const consumer = kafka.consumer({ groupId: `frs-dlq-recovery-20260908-${Date.now()}` });
  await consumer.connect();
  await consumer.subscribe({ topic: DLQ_TOPIC, fromBeginning: true });

  const messages = [];
  await new Promise((resolve, reject) => {
    let idleTimer;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(resolve, 5000); // no new message in 5s => topic drained
    };
    resetIdle();
    consumer.run({
      eachMessage: async ({ message }) => {
        messages.push(message);
        resetIdle();
      },
    }).catch(reject);
  });
  await consumer.disconnect();

  logger.info({ count: messages.length }, '[dlq-recovery-0908] Read dead-letter messages (all-time)');

  let recovered = 0, skipped = 0, failed = 0;

  for (const message of messages) {
    const ts = Number(message.timestamp);
    if (!(ts <= INCIDENT_END)) {
      skipped++;
      continue;
    }

    let envelope, original;
    try {
      envelope = JSON.parse(message.value?.toString() || '{}');
      if (envelope.sourceTopic !== SOURCE_TOPIC) {
        skipped++;
        continue;
      }
      original = JSON.parse(envelope.original);
    } catch (err) {
      logger.warn({ err }, '[dlq-recovery-0908] Unparseable envelope, skipping');
      skipped++;
      continue;
    }

    const { event_uid, device_code: deviceCode, tenant_id: tenantId, event_type: eventType, payload } = original;

    try {
      await processEvent(deviceCode, tenantId, eventType, payload);
      logger.info({ event_uid, deviceCode, eventType }, '[dlq-recovery-0908] Recovered event');
      recovered++;
    } catch (err) {
      logger.error({ err, event_uid, deviceCode, eventType }, '[dlq-recovery-0908] Failed to recover event');
      failed++;
    }

    await sleep(DELAY_BETWEEN_MS);
  }

  logger.info({ recovered, skipped, failed, total: messages.length }, '[dlq-recovery-0908] Done');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, '[dlq-recovery-0908] Fatal error');
  process.exit(1);
});
