/**
 * deadLetterMonitor.js — standalone process that watches frs.dead-letter and
 * makes poison messages actually visible, instead of them silently sitting
 * in a Kafka topic nobody is looking at.
 *
 * Why this exists: Jetson firmware (confirmed directly with that team)
 * treats any 2xx response as final — it marks the event as sent and never
 * retries, with no check on the response body. Before the Kafka decoupling,
 * that was safe: a 200 only ever came back after the event was fully
 * processed. Now a 202 just means "accepted into the pipeline" — the actual
 * processing happens after the response, in workers/deviceEventConsumer.js.
 * If an event exhausts its retries there and lands in frs.dead-letter, the
 * device that sent it has already discarded its only copy and will never
 * retry. This process is the replacement safety net: it doesn't retry
 * anything automatically (a message here already failed 3x for a reason
 * that likely needs a human to look at, not another automatic attempt at
 * the same thing) — it exists purely so a permanently-failed event is loud
 * and visible instead of invisible.
 * This logs each arrival at ERROR level so `pm2 logs` and log-based alerting pick it up.
 */
import KafkaConsumer from '../core/kafka/KafkaConsumer.js';
import kafkaConfig from '../core/kafka/KafkaConfig.js';
import logger from '../utils/logger.js';

const DLQ_TOPIC = 'frs.dead-letter';
const GROUP_ID = `${kafkaConfig.groupId}-dead-letter-monitor`;

function handleMessage({ message }) {
  let envelope;
  try {
    envelope = JSON.parse(message.value?.toString() || '{}');
  } catch (err) {
    logger.error({ err, raw: message.value?.toString() }, '[deadLetterMonitor] Unparseable dead-letter envelope');
    return;
  }

  const { sourceTopic, original, error } = envelope;

  // The original field is itself the JSON-stringified event that failed —
  // parse it too so the log line shows what actually failed (device_code,
  // event_type, event_uid), not just an opaque error string.
  let originalEvent;
  try {
    originalEvent = original ? JSON.parse(original) : undefined;
  } catch (_) {
    originalEvent = undefined;
  }

  logger.error(
    {
      sourceTopic,
      error,
      event_uid: originalEvent?.event_uid,
      device_code: originalEvent?.device_code,
      tenant_id: originalEvent?.tenant_id,
      event_type: originalEvent?.event_type,
      raw: originalEvent ? undefined : original,
    },
    '[deadLetterMonitor] Permanently failed event — exhausted retries, device already discarded its copy, needs manual review'
  );
}

async function main() {
  const consumer = new KafkaConsumer(GROUP_ID);

  consumer.on('handlerError', ({ topic, partition, error }) => {
    logger.error({ err: error, topic, partition }, '[deadLetterMonitor] Unhandled error in message handler');
  });
  consumer.on('crash', (event) => {
    logger.error({ event }, '[deadLetterMonitor] Consumer crashed');
  });

  await consumer.subscribe([DLQ_TOPIC]);
  await consumer.run(handleMessage);

  logger.info({ topic: DLQ_TOPIC, groupId: GROUP_ID }, '[deadLetterMonitor] Started, watching dead-letter topic');
}

main().catch((err) => {
  logger.error({ err }, '[deadLetterMonitor] Fatal startup error');
  process.exit(1);
});
