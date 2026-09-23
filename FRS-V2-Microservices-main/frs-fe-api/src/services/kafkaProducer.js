/**
 * kafkaProducer.js — Bridge to core KafkaProducer
 */
import kafkaProducer from '../core/kafka/KafkaProducer.js';
import logger from '../utils/logger.js';

export async function initProducer() {
  await kafkaProducer.connect();
  return kafkaProducer.producer;
}

export async function publishToKafka(topic, message) {
  try {
    const key = message.device_code || message.employee_id || message.external_device_id;
    await kafkaProducer.sendEvent(topic, message, key);
  } catch (error) {
    logger.error({ err: error, topic }, '[Kafka Bridge] Publish error');
    throw error;
  }
}

export async function disconnectProducer() {
  await kafkaProducer.close();
}

export default { initProducer, publishToKafka, disconnectProducer };
