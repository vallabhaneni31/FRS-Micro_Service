/**
 * recoverDeadLetterCheckins.js — one-off recovery for check-in events lost
 * to frs.dead-letter between 2026-07-28 03:52 and 06:34 UTC, caused by a
 * parameter-count bug in upsertAttendanceCheckin (fixed in
 * deviceEventRepository.js — the SQL only used $1-$5 but the code passed 6
 * values, tripping a Postgres bind-message protocol error on every
 * check-in). The device already got its 202 and discarded its own copy of
 * these events, so this Kafka topic is the only remaining source for them.
 *
 * Reads frs.dead-letter from the beginning under a disposable consumer
 * group (does not touch any other consumer group's offsets), recovers each
 * attendance.checkin event's employee/timestamp/photo, and writes it
 * through the now-fixed upsertAttendanceCheckin. Does not fire system
 * notifications or websocket broadcasts for these backdated events, to
 * avoid confusing live dashboard viewers with "just checked in" alerts for
 * things that happened hours ago.
 *
 * Usage: node src/scripts/recoverDeadLetterCheckins.js
 */
import { Kafka } from 'kafkajs';
import kafkaConfig from '../core/kafka/KafkaConfig.js';
import logger from '../utils/logger.js';
import * as repo from '../repositories/deviceEventRepository.js';
import { uploadEventPhoto } from '../services/business/DeviceEventService.js';

const DLQ_TOPIC = 'frs.dead-letter';

async function main() {
  const kafka = new Kafka(kafkaConfig.getKafkaConfig());
  const consumer = kafka.consumer({ groupId: `frs-dlq-recovery-${Date.now()}` });
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
        messages.push(message.value?.toString() || '');
        resetIdle();
      },
    }).catch(reject);
  });
  await consumer.disconnect();

  logger.info({ count: messages.length }, '[dlq-recovery] Read dead-letter messages');

  let recovered = 0, skipped = 0, failed = 0;

  for (const raw of messages) {
    let envelope, original;
    try {
      envelope = JSON.parse(raw);
      original = JSON.parse(envelope.original);
    } catch (err) {
      logger.warn({ err }, '[dlq-recovery] Unparseable envelope, skipping');
      skipped++;
      continue;
    }

    const { device_code: deviceCode, tenant_id: tenantId, event_type: eventType, payload } = original;

    if (eventType !== 'attendance.checkin') {
      // Only checkins were affected by the bind-mismatch bug; checkout's
      // SQL was correct all along and never landed here for that reason.
      skipped++;
      continue;
    }

    try {
      const identifierCode = payload.employeeCode;
      const identifierId = payload.employeeId;
      const emp = await repo.findEmployeeByIdentifier({ tenantId, identifierCode, identifierId });
      if (!emp) {
        logger.warn({ identifierCode, identifierId, tenantId }, '[dlq-recovery] Employee not found, skipping');
        skipped++;
        continue;
      }

      const ts = payload.timestamp ? new Date(payload.timestamp) : new Date();

      let siteTz = 'Asia/Kolkata';
      try {
        const tz = await repo.getSiteTimezoneForDevice(deviceCode, tenantId);
        if (tz) siteTz = tz;
      } catch (_) {}

      const dateStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: siteTz, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(ts);

      let photoUrl = null;
      if (payload.photo_base64) {
        try {
          const buffer = Buffer.from(payload.photo_base64, 'base64');
          photoUrl = await uploadEventPhoto({ tenantId, eventType, payload: { ...payload, event_time: payload.timestamp }, buffer });
        } catch (err) {
          logger.warn({ err }, '[dlq-recovery] Photo recovery failed, continuing without photo');
        }
      }

      await repo.upsertAttendanceCheckin({ employeeId: emp.pk_employee_id, ts, dateStr, photoUrl, tenantId });

      logger.info(
        { employee: emp.full_name, employeeCode: emp.employee_code, ts: ts.toISOString(), dateStr },
        '[dlq-recovery] Recovered check-in'
      );
      recovered++;
    } catch (err) {
      logger.error({ err }, '[dlq-recovery] Failed to recover event');
      failed++;
    }
  }

  logger.info({ recovered, skipped, failed, total: messages.length }, '[dlq-recovery] Done');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, '[dlq-recovery] Fatal error');
  process.exit(1);
});
