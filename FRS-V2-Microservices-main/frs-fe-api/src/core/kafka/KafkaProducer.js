/**
 * KafkaProducer.js — singleton producer with retry + DLQ support
 * FIX-034: Uses getKafkaConfig() so SSL/SASL settings are enforced
 * FIX-016: Replaced console.error with structured logger
 */
import EventEmitter from 'events';
import { Kafka, CompressionTypes } from 'kafkajs';
import { v4 as uuidv4 } from 'uuid';
import kafkaConfig  from './KafkaConfig.js';
import shutdownManager from '../managers/ShutdownManager.js';
import logger       from '../../utils/logger.js';

class KafkaProducer extends EventEmitter {
  constructor() {
    super();

    // FIX-034: Use getKafkaConfig() so SSL + SASL enforcement is applied
    this.kafka = new Kafka(kafkaConfig.getKafkaConfig());
    this.producer  = this.kafka.producer(kafkaConfig.getProducerConfig());
    this.connected = false;

    this.topicPrefix = kafkaConfig.topicPrefix;
    this.topics = {
      rawFrames:          `${this.topicPrefix}raw-frames`,
      detections:         `${this.topicPrefix}detections`,
      events:             `${this.topicPrefix}events`,
      alerts:             `${this.topicPrefix}alerts`,
      smartSearch:        `${this.topicPrefix}smart-search`,
      smartSearchResults: `${this.topicPrefix}smart-search-results`,
      deadLetter:         `${this.topicPrefix}dead-letter`,
      systemMetrics:      `${this.topicPrefix}system-metrics`,
      // PERF-0001: dedicated write-behind attendance ingest topic (NOT `events`,
      // which is a shared detection/snapshot firehose).
      attendanceIngest:   `${this.topicPrefix}attendance-ingest`,
    };

    shutdownManager.registerShutdownHandler('kafkaProducer', async () => {
      await this.close();
    });
  }

  /** Connect producer (idempotent). */
  async connect() {
    if (this.connected) return;
    await this.producer.connect();
    this.connected = true;
    this.emit('connected');
  }

  /**
   * Send a single event to a topic.
   * @param {string} topic
   * @param {any}    event
   * @param {string} [key]
   */
  async sendEvent(topic, event, key = uuidv4()) {
    await this.connect();
    const payload = {
      key,
      value:   JSON.stringify(event),
      headers: { 'x-event-type': String(event.type || '') },
    };

    try {
      // FRS-ARCH-002 Phase 6 (K1): GZIP compression, no extra codec package
      // needed (unlike Snappy/LZ4/ZSTD) — reduces network I/O for produced
      // messages, real cost for the JSON detection/device-event payloads.
      await this.producer.send({ topic, messages: [payload], compression: CompressionTypes.GZIP });
      this.emit('sent', { topic, key });
    } catch (err) {
      logger.error({ err, topic, key }, '[KafkaProducer] sendEvent failed — routing to DLQ');
      await this.routeToDeadLetter(topic, payload, err);
    }
  }

  /**
   * Send a batch of events.
   * @param {Array<{topic:string, event:any, key?:string}>} events
   */
  async sendBatch(events) {
    if (!events || events.length === 0) return;
    await this.connect();

    const batchesByTopic = new Map();
    for (const e of events) {
      if (!batchesByTopic.has(e.topic)) batchesByTopic.set(e.topic, []);
      batchesByTopic.get(e.topic).push({
        key:     e.key || uuidv4(),
        value:   JSON.stringify(e.event),
        headers: { 'x-event-type': String(e.event.type || '') },
      });
    }

    for (const [topic, messages] of batchesByTopic.entries()) {
      try {
        await this.producer.send({ topic, messages, compression: CompressionTypes.GZIP });
      } catch (err) {
        logger.error({ err, topic, count: messages.length }, '[KafkaProducer] sendBatch failed — routing to DLQ');
        for (const msg of messages) {
          await this.routeToDeadLetter(topic, msg, err);
        }
      }
    }
  }

  async routeToDeadLetter(sourceTopic, message, error) {
    try {
      // sendEvent/sendBatch both connect() before sending; this one didn't,
      // which is harmless when it's called via one of them (already
      // connected by that point) but a hard failure the moment a caller
      // routes to the DLQ without ever otherwise sending — exactly
      // deviceEventConsumer.js's situation, since it only ever calls
      // routeToDeadLetter, never sendEvent/sendBatch, so the underlying
      // producer had never connected. Confirmed live: every dead-letter
      // routing attempt from that process failed with a generic retriable
      // KafkaJSError until this was added.
      await this.connect();
      await this.producer.send({
        topic:    this.topics.deadLetter,
        messages: [{
          key:   message.key,
          value: JSON.stringify({
            sourceTopic,
            original: message.value?.toString(),
            error:    error?.message,
          }),
        }],
        compression: CompressionTypes.GZIP,
      });
    } catch (err) {
      logger.error({ err, sourceTopic }, '[KafkaProducer] Failed to route to DLQ');
    }
  }

  async close() {
    if (!this.connected) return;
    try {
      await this.producer.disconnect();
    } catch (err) {
      logger.error({ err }, '[KafkaProducer] Disconnect error');
    } finally {
      this.connected = false;
    }
  }
}

const kafkaProducer = new KafkaProducer();
export default kafkaProducer;
