/**
 * KafkaEventService.js — high level event API mirroring Spring's event package
 * FIX-016: Replaced console.error with structured logger
 * FIX-034: KafkaConsumer now uses getKafkaConfig() (via KafkaConfig) for SSL/SASL
 */
import EventEmitter from 'events';
import kafkaProducer from './KafkaProducer.js';
import KafkaConsumer from './KafkaConsumer.js';
import kafkaConfig   from './KafkaConfig.js';
import shutdownManager from '../managers/ShutdownManager.js';
import logger        from '../../utils/logger.js';

class KafkaEventService extends EventEmitter {
  constructor() {
    super();
    this.topicPrefix = kafkaConfig.topicPrefix;
    this.topics = {
      events:             `${this.topicPrefix}events`,
      detections:         `${this.topicPrefix}detections`,
      deviceEvents:       `${this.topicPrefix}device-events`,
      aiDetections:       `${this.topicPrefix}ai-detections`,
      alerts:             `${this.topicPrefix}alerts`,
      smartSearch:        `${this.topicPrefix}smart-search`,
      smartSearchResults: `${this.topicPrefix}smart-search-results`,
      systemMetrics:      `${this.topicPrefix}system-metrics`,
      // PERF-0001: dedicated write-behind attendance ingest topic.
      attendanceIngest:   `${this.topicPrefix}attendance-ingest`,
    };

    this.eventConsumer          = null;
    this.smartSearchConsumer    = null;
    this.deviceEventsConsumer   = null;
    this.aiDetectionsConsumer   = null;
    this.attendanceIngestConsumer = null;

    shutdownManager.registerShutdownHandler('kafkaEventService', async () => {
      await this.shutdown();
    });
  }

  async publishEvent(event) {
    await kafkaProducer.sendEvent(this.topics.events, event, event.id || undefined);
  }

  async publishDetection(detection) {
    await kafkaProducer.sendEvent(this.topics.detections, detection);
  }

  async publishAlert(alert) {
    await kafkaProducer.sendEvent(this.topics.alerts, alert, alert.id || undefined);
  }

  async publishSmartSearchResult(payload) {
    await kafkaProducer.sendEvent(this.topics.smartSearchResults, payload, payload.id || undefined);
  }

  async publishSystemMetrics(metrics) {
    await kafkaProducer.sendEvent(this.topics.systemMetrics, metrics);
  }

  /**
   * PERF-0001: publish a device-originated attendance mark / frame-attach for
   * write-behind processing. Keyed by employeeId so a single person's events
   * stay in one partition (ordered).
   * @param {any}    event  raw payload (no biometric fields)
   * @param {string} [key]  partition key — pass employeeId
   */
  async publishAttendanceIngest(event, key) {
    await kafkaProducer.sendEvent(this.topics.attendanceIngest, event, key || event.employeeId || event.id || undefined);
  }

  async subscribeToEvents(handler) {
    if (this.eventConsumer) return;
    this.eventConsumer = new KafkaConsumer(`${kafkaConfig.groupId}-events`);
    await this.eventConsumer.subscribe([this.topics.events]);
    await this.eventConsumer.run(async ({ message }) => {
      try {
        const event = JSON.parse(message.value?.toString() || '{}');
        await handler(event);
      } catch (err) {
        logger.error({ err }, '[KafkaEventService] subscribeToEvents handler error');
      }
    });
  }

  /**
   * PERF-0001: consume the write-behind attendance ingest topic. The handler is
   * expected to own its own retry/DLQ and NOT throw, so the offset commits after
   * it resolves (see attendanceIngestWorker).
   */
  async subscribeToAttendanceIngest(handler) {
    if (this.attendanceIngestConsumer) return;
    this.attendanceIngestConsumer = new KafkaConsumer(`${kafkaConfig.groupId}-attendance-ingest`);
    await this.attendanceIngestConsumer.subscribe([this.topics.attendanceIngest]);
    await this.attendanceIngestConsumer.run(async ({ message }) => {
      try {
        const event = JSON.parse(message.value?.toString() || '{}');
        await handler(event);
      } catch (err) {
        logger.error({ err }, '[KafkaEventService] subscribeToAttendanceIngest handler error');
      }
    });
  }

  async subscribeToSmartSearch(handler) {
    if (this.smartSearchConsumer) return;
    this.smartSearchConsumer = new KafkaConsumer(`${kafkaConfig.groupId}-smart-search`);
    await this.smartSearchConsumer.subscribe([this.topics.smartSearch]);
    await this.smartSearchConsumer.run(async ({ message }) => {
      try {
        const query = JSON.parse(message.value?.toString() || '{}');
        await handler(query);
      } catch (err) {
        logger.error({ err }, '[KafkaEventService] subscribeToSmartSearch handler error');
      }
    });
  }

  async subscribeToDeviceEvents(handler) {
    if (this.deviceEventsConsumer) return;
    this.deviceEventsConsumer = new KafkaConsumer(`${kafkaConfig.groupId}-device-events`);
    await this.deviceEventsConsumer.subscribe([this.topics.deviceEvents]);
    await this.deviceEventsConsumer.run(async ({ message }) => {
      try {
        const evt = JSON.parse(message.value?.toString() || '{}');
        await handler(evt);
      } catch (err) {
        logger.error({ err }, '[KafkaEventService] deviceEvents handler error');
      }
    });
  }

  async subscribeToAIDetections(handler) {
    if (this.aiDetectionsConsumer) return;
    this.aiDetectionsConsumer = new KafkaConsumer(`${kafkaConfig.groupId}-ai-detections`);
    await this.aiDetectionsConsumer.subscribe([this.topics.aiDetections]);
    await this.aiDetectionsConsumer.run(async ({ message }) => {
      try {
        const evt = JSON.parse(message.value?.toString() || '{}');
        await handler(evt);
      } catch (err) {
        logger.error({ err }, '[KafkaEventService] aiDetections handler error');
      }
    });
  }

  async shutdown() {
    const closers = [];
    if (this.eventConsumer)        closers.push(this.eventConsumer.close());
    if (this.smartSearchConsumer)  closers.push(this.smartSearchConsumer.close());
    if (this.deviceEventsConsumer) closers.push(this.deviceEventsConsumer.close());
    if (this.aiDetectionsConsumer) closers.push(this.aiDetectionsConsumer.close());
    if (this.attendanceIngestConsumer) closers.push(this.attendanceIngestConsumer.close());
    await Promise.allSettled(closers);
  }
}

const kafkaEventService = new KafkaEventService();
export default kafkaEventService;
