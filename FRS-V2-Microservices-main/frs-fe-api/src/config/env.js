import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// Dynamic import (not static) so dotenv.config() above has already populated
// process.env.LOG_LEVEL/NODE_ENV before logger.js reads them at its own
// module-init time — a static import would be hoisted ahead of dotenv.config().
const { default: logger } = await import('../utils/logger.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const toNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true' || value === '1';
  }
  return fallback;
};

class Env {
  constructor() {
    this.port = toNumber(process.env.PORT, 8080);
    this.nodeEnv = process.env.NODE_ENV || 'development';
    this.clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
    
    this.http = {
      timeoutMs: toNumber(process.env.HTTP_TIMEOUT_MS, 15000),
    };
    
    this.edgeAI = {
      baseUrl: process.env.EDGE_AI_URL || 'http://localhost:5000',
    };

    // Jetson sidecar reached directly by the API (e.g. face-embedding enrollment).
    // No environment-specific IP is hardcoded here — set JETSON_SIDECAR_URL per
    // environment (dev/staging/prod each point at a different physical device).
    this.jetsonSidecarUrl = process.env.JETSON_SIDECAR_URL || 'http://localhost:5000';
    
    this.analytics = {
      frameQueueSize: toNumber(process.env.FRAME_QUEUE_SIZE, 100),
      eventQueueSize: toNumber(process.env.EVENT_QUEUE_SIZE, 1000),
      snapshotQueueSize: toNumber(process.env.SNAPSHOT_QUEUE_SIZE, 500),
      inferenceThreads: toNumber(process.env.INFERENCE_THREADS, 4),
      eventPushThreads: toNumber(process.env.EVENT_PUSH_THREADS, 2),
      maxHeapMemoryPercent: toNumber(process.env.MAX_HEAP_MEMORY_PERCENT, 80),
      frameBufferSize: toNumber(process.env.FRAME_BUFFER_SIZE, 10),
      motionSkipFrames: toNumber(process.env.MOTION_SKIP_FRAMES, 3),
      configPath: process.env.CONFIG_PATH || path.join(__dirname, '../../conf'),
      modelPath: process.env.MODEL_PATH || path.join(__dirname, '../../models'),
      monitoringConfigApi: process.env.MONITORING_CONFIG_API,
      ruleConfigApi: process.env.RULE_CONFIG_API,
      modelConfigApi: process.env.MODEL_CONFIG_API,
      monitoringUrl: process.env.MONITORING_URL,
      uploadUrl: process.env.UPLOAD_URL,
      enableFaceRecognition: toBoolean(process.env.ENABLE_FACE_RECOGNITION, false),
      enableAlpr: toBoolean(process.env.ENABLE_ALPR, false),
      enableReId: toBoolean(process.env.ENABLE_REID, false),
    };

    this.kafka = {
      brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
      clientId: process.env.KAFKA_CLIENT_ID || 'frs-api',
      groupId: process.env.KAFKA_GROUP_ID || 'frs-consumer-group',
      topicPrefix: process.env.KAFKA_TOPIC_PREFIX || 'frs.',
      sslEnabled: toBoolean(process.env.KAFKA_SSL_ENABLED, false),
      saslMechanism: process.env.KAFKA_SASL_MECHANISM,
      saslUsername: process.env.KAFKA_SASL_USERNAME,
      saslPassword: process.env.KAFKA_SASL_PASSWORD,
      sessionTimeout: toNumber(process.env.KAFKA_CONSUMER_SESSION_TIMEOUT, 30000),
      rebalanceTimeout: toNumber(process.env.KAFKA_CONSUMER_REBALANCE_TIMEOUT, 60000),
      numPartitions: toNumber(process.env.KAFKA_NUM_PARTITIONS, 3),
      replicationFactor: toNumber(process.env.KAFKA_REPLICATION_FACTOR, 1),

      topics: {
        rawFrames: process.env.KAFKA_TOPIC_RAW_FRAMES || 'frs.raw-frames',
        detections: process.env.KAFKA_TOPIC_DETECTIONS || 'frs.detections',
        events: process.env.KAFKA_TOPIC_EVENTS || 'frs.events',
        alerts: process.env.KAFKA_TOPIC_ALERTS || 'frs.alerts',
        smartSearch: process.env.KAFKA_TOPIC_SMART_SEARCH || 'frs.smart-search',
        smartSearchResults: process.env.KAFKA_TOPIC_SMART_SEARCH_RESULTS || 'frs.smart-search-results',
        systemMetrics: process.env.KAFKA_TOPIC_SYSTEM_METRICS || 'frs.system-metrics',
        snapshots: process.env.KAFKA_TOPIC_SNAPSHOTS || 'frs.snapshots'
      }
    };

    this.face = {
      matchThreshold: toNumber(process.env.FACE_MATCH_THRESHOLD, 0.50),
      dbPath: process.env.FACE_DB_PATH || './data/faces.db'
    };

    this.snapshot = {
      tempDir: process.env.SNAPSHOT_TEMP_DIR || './temp/snapshots',
      concurrency: toNumber(process.env.SNAPSHOT_UPLOAD_CONCURRENCY, 3),
      maxRetries: toNumber(process.env.SNAPSHOT_MAX_RETRIES, 3),
      compressionQuality: toNumber(process.env.SNAPSHOT_COMPRESSION_QUALITY, 80),
      maxTempSizeMB: toNumber(process.env.SNAPSHOT_MAX_TEMP_SIZE_MB, 1024)
    };

    this.db = {
      host: process.env.DB_HOST || 'localhost',
      port: toNumber(process.env.DB_PORT, 5432),
      database: process.env.DB_NAME || 'attendance_intelligence',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      ssl: toBoolean(process.env.DB_SSL, false),
      max: toNumber(process.env.DB_POOL_MAX, 20),
      idleTimeoutMillis: toNumber(process.env.DB_IDLE_TIMEOUT_MS, 30000),
      connectionTimeoutMillis: toNumber(process.env.DB_CONNECTION_TIMEOUT_MS, 5000),
      // TCP keepAlive prevents idle pooled connections to a remote DB from being
      // silently dropped by NAT/firewall, which otherwise surfaces as the pg
      // error "Connection terminated unexpectedly" on the next query.
      keepAlive: toBoolean(process.env.DB_KEEPALIVE, true),
      keepAliveInitialDelayMillis: toNumber(process.env.DB_KEEPALIVE_DELAY_MS, 10000),
    };
    
    this.token = {
      accessTokenTtlMinutes: toNumber(process.env.ACCESS_TOKEN_TTL_MINUTES, 30),
      refreshTokenTtlDays: toNumber(process.env.REFRESH_TOKEN_TTL_DAYS, 7),
    };

    // S-06: Auth tokens for health/metrics endpoints
    this.healthAuthToken  = process.env.HEALTH_AUTH_TOKEN  || null;
    this.metricsAuthToken = process.env.METRICS_AUTH_TOKEN || null;

    this.authMode = process.env.AUTH_MODE || 'api';

    // S-06: Auth tokens for health/metrics endpoints
    this.healthAuthToken     = process.env.HEALTH_AUTH_TOKEN     || '';
    this.metricsAuthToken    = process.env.METRICS_AUTH_TOKEN    || '';

    // S-06: HMAC secret for Jetson enrollment webhook signatures
    this.jetsonWebhookSecret = process.env.JETSON_WEBHOOK_SECRET || '';

    // Programmatic API key handed to HRMS integrations. No fallback default —
    // startServer() in server.js refuses to boot without this set, so an empty
    // string here can only be reached before that check runs.
    this.hrmsWebhookApiKey = process.env.HRMS_WEBHOOK_API_KEY || '';

    // Private-beta feature allowlist. Empty by default (feature hidden for
    // everyone) rather than falling back to any hardcoded email — set
    // BETA_TESTER_EMAILS as a comma-separated list per environment.
    this.betaTesterEmails = (process.env.BETA_TESTER_EMAILS || '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);

    // S3 storage for Jetson event logs (bucket 1) and permanent enrollment/profile
    // photos (bucket 2) — see storageService.js. No hardcoded bucket names/region:
    // must be set per environment.
    this.aws = {
      region: process.env.AWS_REGION || 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      s3LogsBucket: process.env.AWS_S3_LOGS_BUCKET,
      s3UserDataBucket: process.env.AWS_S3_USER_DATA_BUCKET,
      // Optional: only set for local/dev testing against MinIO or similar.
      s3Endpoint: process.env.AWS_S3_ENDPOINT || undefined,
      s3ForcePathStyle: toBoolean(process.env.AWS_S3_FORCE_PATH_STYLE, false),
    };

    this.keycloak = {
      url: process.env.KEYCLOAK_URL || 'http://localhost:9090/auth',
      realm: process.env.KEYCLOAK_REALM || 'attendance',
      issuer: process.env.KEYCLOAK_ISSUER || 'http://localhost:9090/auth/realms/attendance',
      audience: process.env.KEYCLOAK_AUDIENCE || 'attendance-api',
      // When true, the access token's `aud` MUST contain the configured audience.
      // When false (default), Keycloak's built-in "account" audience is also
      // accepted — keep this off until an audience mapper is configured on the
      // realm, otherwise valid logins will be rejected.
      strictAudience: process.env.KEYCLOAK_STRICT_AUDIENCE === 'true',
      jwksUri: process.env.KEYCLOAK_JWKS_URI || 'http://localhost:9090/auth/realms/attendance/protocol/openid-connect/certs',
      clockToleranceSec: Number(process.env.KEYCLOAK_CLOCK_TOLERANCE_SEC || '5'),
    };

    // PERF-0005: how long operator search history is kept before the retention
    // cron sweeps it (query criteria only — no biometric data).
    this.searchHistoryRetentionDays = toNumber(process.env.SEARCH_HISTORY_RETENTION_DAYS, 90);

    // PERF-0003: Redis connection for distributed rate limiting. Null when unset,
    // in which case each limiter uses its own in-memory store (per-process limits).
    this.redis = {
      url: process.env.REDIS_URL || null,
    };

    // PERF-0001: Write-behind attendance ingest (dual-write flag).
    //   writeMode = 'sync' (default) writes on the request path; 'async' publishes
    //   device-originated marks to Kafka and returns 202 (a worker writes them).
    //   asyncTenants lets a subset go async while the global mode stays 'sync'
    //   (gradual rollout). Manual /attendance/mark is never affected.
    this.attendance = {
      writeMode: (process.env.ATTENDANCE_WRITE_MODE || 'sync').toLowerCase(),
      asyncTenants: (process.env.ATTENDANCE_ASYNC_TENANTS || '')
        .split(',')
        .map(t => t.trim())
        .filter(Boolean),
    };
  }

  // --- Validation ---
  validate() {
    // Basic required variables
    const required = ['DB_HOST', 'DB_NAME', 'DB_USER', 'AUTH_MODE'];
    const missing = required.filter(k => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(`[Env Validation] Missing required environment variables: ${missing.join(', ')}`);
    }

    if (this.authMode === 'keycloak' && !process.env.KEYCLOAK_URL) {
      throw new Error(`[Env Validation] KEYCLOAK_URL is required when AUTH_MODE is 'keycloak'`);
    }

    // ── FIX-010: Warn on default / weak DB credentials in production ──────────
    if (this.nodeEnv === 'production') {
      const DEFAULT_CREDS = ['password', 'admin', '1234', 'secret', 'changeme', ''];
      if (DEFAULT_CREDS.includes(this.db.password || '')) {
        logger.warn(
          '[SECURITY] Weak or default DB_PASSWORD detected in production. ' +
          'Set a strong, unique database password.'
        );
      }
      if (['admin', ''].includes(this.db.user || '')) {
        logger.warn(
          '[SECURITY] Default DB_USER detected in production. ' +
          'Consider creating a dedicated application database user.'
        );
      }
      if (!this.db.ssl) {
        logger.warn(
          '[SECURITY] DB_SSL is not enabled in production. Consider setting DB_SSL=true for encrypted connections.'
        );
      }
    }

    // ── S-06: Health/metrics token warnings in production ────────────────────
    if (this.nodeEnv === 'production') {
      if (!this.healthAuthToken) {
        logger.warn('[env] HEALTH_AUTH_TOKEN not set — health endpoint unprotected in production');
      }
      if (!this.metricsAuthToken) {
        logger.warn('[env] METRICS_AUTH_TOKEN not set — metrics endpoint unprotected in production');
      }
      if (!this.jetsonWebhookSecret) {
        logger.warn('[env] JETSON_WEBHOOK_SECRET not set — webhook HMAC validation disabled in production');
      }
    }

    // ── FIX-017: DEVICE_JWT_SECRET startup validation ─────────────────────────
    const deviceSecret = process.env.DEVICE_JWT_SECRET;
    if (!deviceSecret) {
      throw new Error(
        '[FATAL] DEVICE_JWT_SECRET is required. Generate: openssl rand -hex 32'
      );
    }
    if (deviceSecret.length < 32) {
      throw new Error(
        '[FATAL] DEVICE_JWT_SECRET must be at least 32 characters. ' +
        'Generate: openssl rand -hex 32'
      );
    }
    const KNOWN_WEAK_DEVICE = ['secret', 'changeme', 'deviceSecret', 'device_secret'];
    if (this.nodeEnv === 'production' && KNOWN_WEAK_DEVICE.some(w => deviceSecret.toLowerCase().includes(w))) {
      throw new Error('[FATAL] DEVICE_JWT_SECRET appears to be a weak/default value in production');
    }

    // ── S3 storage: warn (don't fail boot) if buckets aren't configured ───────
    if (!this.aws.s3LogsBucket) {
      logger.warn('[env] AWS_S3_LOGS_BUCKET not set — Jetson event photo uploads will fail');
    }
    if (!this.aws.s3UserDataBucket) {
      logger.warn('[env] AWS_S3_USER_DATA_BUCKET not set — enrollment/profile photo uploads will fail');
    }

    // ── FIX-001 (env layer): ENROLLMENT_TOKEN_SECRET validation ───────────────
    const enrollSecret = process.env.ENROLLMENT_TOKEN_SECRET;
    if (!enrollSecret) {
      throw new Error(
        '[FATAL] ENROLLMENT_TOKEN_SECRET is required. Generate: openssl rand -hex 32'
      );
    }
    if (enrollSecret.length < 32) {
      throw new Error(
        '[FATAL] ENROLLMENT_TOKEN_SECRET must be at least 32 characters.'
      );
    }

    logger.info('✅ Environment validated');
  }
}

export const env = new Env();
env.validate(); // Fail-fast at import time
