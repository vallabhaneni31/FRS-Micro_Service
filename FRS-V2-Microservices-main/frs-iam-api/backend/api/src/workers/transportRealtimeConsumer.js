/**
 * transportRealtimeConsumer.js — standalone worker process (run separately
 * from frs-backend, mirrors workers/deviceEventConsumer.js) that relays the
 * Transport service's `frs.transport-realtime` Kafka topic into the
 * existing wsManager, so the frontend's tenant socket room gets a live
 * occupancy update without the Java service knowing anything about
 * WebSockets, Socket.IO, or Redis.
 *
 * This is the one piece of Phase 2g/7 that lives outside
 * backend/api-transport's isolation boundary — the Java service is
 * unaware this consumer exists; it only publishes to a topic. Nothing
 * else in backend/api is touched.
 *
 * No dedup/retry here (unlike deviceEventConsumer.js): a redelivered or
 * dropped realtime message just means a live dashboard's occupancy number
 * is briefly stale/re-rendered — never a data-correctness issue, since
 * occupancy_snapshots (Postgres, via the Java service) is the actual
 * source of truth. broadcastToTenant() already swallows its own errors
 * (see websocket/index.js), so a Redis hiccup here degrades to "no live
 * update this tick," not a crash.
 */
import KafkaConsumer from '../core/kafka/KafkaConsumer.js';
import kafkaConfig from '../core/kafka/KafkaConfig.js';
import wsManager from '../websocket/index.js';
import logger from '../utils/logger.js';

const TOPIC = 'frs.transport-realtime';
const GROUP_ID = `${kafkaConfig.groupId}-transport-realtime`;

async function handleMessage({ message }) {
  let parsed;
  try {
    parsed = JSON.parse(message.value?.toString() || '{}');
  } catch (err) {
    logger.error({ err }, '[transportRealtimeConsumer] Unparseable message — skipping');
    return;
  }

  const { tenantId, busId, occupancyCount, direction, occurredAt } = parsed;
  if (!tenantId) {
    logger.warn({ parsed }, '[transportRealtimeConsumer] Message missing tenantId — skipping');
    return;
  }

  wsManager.broadcastToTenant(tenantId, 'transport.occupancy_update', {
    tenantId,
    busId,
    occupancyCount,
    direction,
    occurredAt,
  });
}

async function main() {
  const consumer = new KafkaConsumer(GROUP_ID);

  consumer.on('handlerError', ({ topic, partition, error }) => {
    logger.error({ err: error, topic, partition }, '[transportRealtimeConsumer] Unhandled error in message handler');
  });
  consumer.on('crash', (event) => {
    logger.error({ event }, '[transportRealtimeConsumer] Consumer crashed');
  });

  await consumer.subscribe([TOPIC]);
  await consumer.run(handleMessage);

  logger.info({ topic: TOPIC, groupId: GROUP_ID }, '[transportRealtimeConsumer] Started, relaying transport occupancy updates');
}

main().catch((err) => {
  logger.error({ err }, '[transportRealtimeConsumer] Fatal startup error');
  process.exit(1);
});
