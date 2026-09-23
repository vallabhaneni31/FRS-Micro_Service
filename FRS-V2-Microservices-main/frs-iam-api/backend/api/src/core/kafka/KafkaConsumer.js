/**
 * KafkaConsumer.js — Base Kafka consumer with manual control and error handling
 * FIX-034: Uses getKafkaConfig() so SSL/SASL enforcement applies to consumers too
 * FIX-016: Replaced console.error with structured logger
 */
import EventEmitter from 'events';
import { Kafka }    from 'kafkajs';
import kafkaConfig  from './KafkaConfig.js';
import shutdownManager from '../managers/ShutdownManager.js';
import logger       from '../../utils/logger.js';

export default class KafkaConsumer extends EventEmitter {
  /**
   * @param {string} groupId
   */
  constructor(groupId = kafkaConfig.groupId) {
    super();

    // When KAFKA_ENABLED=false, skip all Kafka init to avoid connection noise
    this.disabled = process.env.KAFKA_ENABLED === 'false';
    if (this.disabled) {
      logger.info(`[KafkaConsumer] Kafka disabled (KAFKA_ENABLED=false) — consumer ${groupId} will not connect`);
      this.connected = false;
      return;
    }

    // FIX-034: Use getKafkaConfig() so SSL + SASL are enforced in production
    this.kafka    = new Kafka(kafkaConfig.getKafkaConfig());
    this.consumer = this.kafka.consumer({
      ...kafkaConfig.getConsumerConfig(),
      groupId,
    });
    this.connected = false;

    shutdownManager.registerShutdownHandler(`kafkaConsumer:${groupId}`, async () => {
      await this.close();
    });
  }

  async connect() {
    if (this.disabled || this.connected) return;
    await this.consumer.connect();
    this.connected = true;
    this.emit('connected');
  }

  /**
   * Subscribe to one or more topics.
   * @param {string[]} topics
   */
  async subscribe(topics) {
    if (this.disabled) return;
    await this.connect();
    for (const topic of topics) {
      await this.consumer.subscribe({ topic, fromBeginning: false });
    }
  }

  /**
   * Start consuming with the given handler.
   * @param {Function} handler
   */
  async run(handler) {
    if (this.disabled) return;
    await this.connect();
    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        try {
          await handler({ topic, partition, message });
        } catch (err) {
          this.emit('handlerError', { topic, partition, message, error: err });
        }
      },
    });

    this.consumer.on(this.consumer.events.CRASH, (event) => {
      this.emit('crash', event);
    });
    this.consumer.on(this.consumer.events.REBALANCING, (event) => {
      this.emit('rebalancing', event);
    });
  }

  /**
   * Batched alternative to run() — hands the whole fetched batch to the
   * handler at once (kafkajs still decides batch size/timing based on the
   * consumer's fetch config; this doesn't force artificial batching, it
   * just stops processing one-message-at-a-time when more are already
   * available). Offsets are only committed after the handler returns
   * successfully, and a heartbeat is sent per batch so a slower batch
   * handler doesn't trigger a consumer-group rebalance.
   * @param {Function} handler receives { topic, partition, messages }
   */
  async runBatch(handler) {
    await this.connect();
    await this.consumer.run({
      eachBatch: async ({ batch, resolveOffset, heartbeat }) => {
        try {
          await handler({ topic: batch.topic, partition: batch.partition, messages: batch.messages });
          for (const message of batch.messages) {
            resolveOffset(message.offset);
          }
          await heartbeat();
        } catch (err) {
          this.emit('handlerError', { topic: batch.topic, partition: batch.partition, error: err });
        }
      },
    });

    this.consumer.on(this.consumer.events.CRASH, (event) => {
      this.emit('crash', event);
    });
    this.consumer.on(this.consumer.events.REBALANCING, (event) => {
      this.emit('rebalancing', event);
    });
  }

  async pause(topics) {
    this.consumer.pause(topics.map(topic => ({ topic })));
  }

  async resume(topics) {
    this.consumer.resume(topics.map(topic => ({ topic })));
  }

  async close() {
    if (this.disabled || !this.connected) return;
    try {
      await this.consumer.disconnect();
    } catch (err) {
      logger.error({ err }, '[KafkaConsumer] Disconnect error');
    } finally {
      this.connected = false;
    }
  }
}
