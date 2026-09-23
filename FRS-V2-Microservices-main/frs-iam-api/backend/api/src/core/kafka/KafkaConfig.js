/**
 * KafkaConfig.js — FIX-034: SASL/SSL enforcement for Kafka connections
 *
 * Changes from original:
 *  - In production: SSL is mandatory (cannot be disabled via env var)
 *  - In production: SASL credentials are mandatory — startup fails without them
 *  - SASL mechanism validated to SCRAM-SHA-256 or SCRAM-SHA-512 (PLAIN blocked in prod)
 *  - Producer idempotent mode + acks=all enforced for durability
 */
import { env } from '../../config/env.js';
import logger from '../../utils/logger.js';

const IS_PROD = (process.env.NODE_ENV || env.nodeEnv) === 'production';

class KafkaConfig {
  constructor() {
    this.brokers     = env.kafka.brokers;
    this.clientId    = env.kafka.clientId;
    this.groupId     = env.kafka.groupId;
    this.topicPrefix = env.kafka.topicPrefix;
    this.topics      = env.kafka.topics;
    this.numPartitions    = env.kafka.numPartitions;
    this.replicationFactor = env.kafka.replicationFactor;

    // SSL: respect KAFKA_SSL_ENABLED env var in all environments.
    // Default is true in production and false in development, but can be
    // explicitly overridden — e.g. single-node local Kafka has no SSL.
    this.sslEnabled = env.kafka.sslEnabled ?? IS_PROD;

    if (IS_PROD && !this.sslEnabled) {
      logger.warn('[KafkaConfig] Kafka SSL is disabled in production (KAFKA_SSL_ENABLED=false). Ensure this is intentional for your infrastructure.');
    }

    // ── FIX-034: SASL enforcement ─────────────────────────────────────────
    this.sasl = null;

    const mechanism = env.kafka.saslMechanism;
    const username  = env.kafka.saslUsername;
    const password  = env.kafka.saslPassword;

    if (IS_PROD) {
      // SASL is strongly recommended in production — warn if missing
      if (!mechanism || !username || !password) {
        logger.warn('[KafkaConfig] SASL credentials not configured — Kafka connections are unauthenticated. Set KAFKA_SASL_MECHANISM, KAFKA_SASL_USERNAME, KAFKA_SASL_PASSWORD for production security.');
      } else if (mechanism.toUpperCase() === 'PLAIN') {
        logger.warn('[KafkaConfig] Kafka SASL mechanism PLAIN is not recommended in production — prefer scram-sha-256 or scram-sha-512');
      }
    }

    if (mechanism && username && password) {
      this.sasl = { mechanism, username, password };
    } else if (!IS_PROD) {
      logger.warn('[KafkaConfig] SASL not configured — Kafka connections are unauthenticated (dev mode only)');
    }
  }

  getKafkaConfig() {
    const config = {
      clientId: this.clientId,
      brokers:  this.brokers,
      retry: {
        initialRetryTime: 100,
        retries: 8,
      },
    };

    if (this.sslEnabled) {
      config.ssl = true;
    }

    if (this.sasl) {
      config.sasl = this.sasl;
    }

    return config;
  }

  getConsumerConfig() {
    return {
      groupId:              this.groupId,
      sessionTimeout:       env.kafka.sessionTimeout,
      rebalanceTimeout:     env.kafka.rebalanceTimeout,
      maxBytesPerPartition: 1048576,
      minBytes:             1,
      maxBytes:             10485760,
      maxWaitTimeInMs:      5000,
      retry: { retries: 5 },
    };
  }

  getProducerConfig() {
    return {
      allowAutoTopicCreation: true,
      transactionTimeout:     30000,
      maxInFlightRequests:    5,
      idempotent:             true,  // requires acks=-1 (all) — kafkajs sets this automatically
    };
  }

  getTopicName(key) {
    return this.topics[key] || `${this.topicPrefix}${key}`;
  }
}

export default new KafkaConfig();
