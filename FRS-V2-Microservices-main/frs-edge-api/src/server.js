import express from "express";
import cors from "cors";
import helmet from "helmet";
import sharp from "sharp";
import { env } from "./config/env.js";

// Mirrors backend/api/src/server.js — sharp defaults to using every core for
// its internal (libvips) thread pool, per process. Capped globally, once, at
// process start, same rationale as the source service.
sharp.concurrency(2);

import logger from "./utils/logger.js";
import bootstrapRoutes from "./routes/bootstrapRoutes.js";
import deviceEventsRoutes from "./routes/deviceEventsRoutes.js";
import faceSyncRoutes from "./routes/faceSyncRoutes.js";
import { faceRoutes } from "./routes/faceRoutes.js";
import { cameraRoutes } from "./routes/cameraRoutes.js";
import { deviceRoutes } from "./routes/deviceRoutes.js";
import deviceManagementRoutes from "./routes/deviceManagementRoutes.js";
import { attendanceRoutes } from "./routes/attendanceRoutes.js";
import { jetsonRoutes } from "./routes/jetsonRoutes.js";
import { employeeRoutes } from "./routes/employeeRoutes.js";

// === Retail vertical (api-retail) — device-facing routes only ==============
// Split out of frs-core-api/backend/api-retail. Own DB (RETAIL_DB_URL), own
// authenticateDevice, isolated under src/retail/ to avoid colliding with the
// edge-vertical files of the same name above. See src/retail/db/pool.js.
import { deviceRoutes as retailDeviceRoutes } from "./retail/routes/deviceRoutes.js";
import { snapshotRoutes as retailSnapshotRoutes } from "./retail/routes/snapshotRoutes.js";
import { countRoutes as retailCountRoutes } from "./retail/routes/countRoutes.js";
import { healthRoutes as retailHealthRoutes } from "./retail/routes/healthRoutes.js";
// =============================================================================

import { correlationIdMiddleware } from "./middleware/correlationId.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { securityEventLogger } from "./middleware/securityEventLogger.js";
import { globalRateLimiter } from "./middleware/rateLimit.js";
import { pool, warmPool } from "./db/pool.js";

import shutdownManager from "./core/managers/ShutdownManager.js";
import wsManager from "./websocket/index.js";
import { setAuditWsManager } from "./middleware/auditLog.js";
import attendanceService from "./services/business/AttendanceService.js";
import uploadSnapshotPushService from "./core/services/UploadSnapshotPushService.js";
import kafkaEventService from "./core/kafka/KafkaEventService.js";

const app = express();
app.set("trust proxy", 1);
app.use(correlationIdMiddleware); // W-06: X-Request-ID on every request/response
app.use(requestLogger);          // O-02: structured JSON request logging

app.use(
  helmet({
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  })
);

// ── CORS ────────────────────────────────────────────────────────────────────
// Edge devices don't send an Origin header at all, so this mostly guards
// direct browser/tooling access against this service. Kept narrow — no
// tenant-subdomain SPA logic here (that lives in frs-fe-api).
app.use(
  cors({
    origin: (origin, callback) => {
      const allowedOrigins = (env.clientOrigin || "")
        .split(",").map(o => o.trim()).filter(Boolean);

      if (!origin) return callback(null, true);

      if (env.nodeEnv === 'production' && allowedOrigins.includes("*")) {
        return callback(new Error("CORS: wildcard origin not permitted in production"));
      }

      if (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      logger.warn({ origin }, '[CORS] Request from blocked origin');
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-tenant-id",
      "x-customer-id",
      "x-site-id",
      "x-unit-id",
    ],
  })
);

// ── Body parsing ─────────────────────────────────────────────────────────────
// Special handling for Jetson heartbeats which may contain invalid 'nan' JSON
// literal — mirrors backend/api/src/server.js exactly (kept verbatim, this
// quirk is load-bearing for legacy firmware on /api/jetson).
app.use("/api/jetson", express.text({ type: 'application/json', limit: '1mb' }), (req, res, next) => {
  if (typeof req.body === 'string' && req.body.includes(':nan')) {
    try {
      req.body = JSON.parse(req.body.replace(/:nan/g, ':null'));
      return next();
    } catch (e) {
      logger.error('[jetson-sanitizer] Failed to parse sanitized JSON:', e.message);
    }
  }
  if (typeof req.body === 'string') {
    try {
      req.body = JSON.parse(req.body);
    } catch (e) {
      // Ignore, may not be JSON or handled elsewhere
    }
  }
  next();
});

// High-limit routes specifically parsed first (device event ingest carries
// base64 photo payloads on older firmware)
app.use("/api/events", express.json({ limit: "10mb" }));

app.use(express.json({ limit: "10mb" }));
app.use(express.raw({ type: 'image/*', limit: '10mb' }));

// Normalize duplicate /api/api prefix sent by legacy edge boxes
app.use((req, res, next) => {
  if (req.url.startsWith('/api/api/')) {
    req.url = req.url.slice(4);
  }
  next();
});

// ── Rate limiting ────────────────────────────────────────────────────────────
// PERF-0001: device/edge ingest routes are throttled per-DEVICE
// (deviceIngestLimiter, mounted on those routes) and are EXEMPT here — many
// cameras behind one NAT must not throttle each other on the per-IP limit.
const DEVICE_INGEST_EXEMPT = new Set([
  "/api/attendance/frame",
  "/api/attendance/bulk-sync",
  "/api/attendance/direction",
  "/api/face/recognize",
]);
function isDeviceIngestPath(req) {
  const p = (req.originalUrl || req.url || "").split("?")[0];
  if (DEVICE_INGEST_EXEMPT.has(p)) return true;
  if (p === "/api/events" || p.startsWith("/api/events/")) return true; // device event ingest
  if (/^\/api\/cameras\/[^/]+\/heartbeat$/.test(p)) return true;         // device heartbeat
  if (p.startsWith("/api/jetson/")) return true;
  return false;
}
app.use("/api", (req, res, next) =>
  isDeviceIngestPath(req) ? next() : globalRateLimiter(req, res, next)
);

// ── Health protection middleware (SSRF & Auth guard) ────────────────────────
const authenticateHealth = (req, res, next) => {
  const tokenHeader = req.headers.authorization;
  const healthAuthToken = process.env.HEALTH_AUTH_TOKEN || process.env.METRICS_AUTH_TOKEN;
  const healthIpAllowlist = process.env.HEALTH_IP_ALLOWLIST || process.env.METRICS_IP_ALLOWLIST;

  if (healthAuthToken) {
    let token = '';
    if (tokenHeader && tokenHeader.toLowerCase().startsWith('bearer ')) {
      token = tokenHeader.slice(7).trim();
    }
    if (token === healthAuthToken) {
      return next();
    }
  }

  if (healthIpAllowlist) {
    let clientIp = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || '';
    if (clientIp.startsWith('::ffff:')) clientIp = clientIp.slice(7);

    const allowedIps = healthIpAllowlist.split(',').map(ip => ip.trim());
    if (allowedIps.includes(clientIp)) {
      return next();
    }
  }

  if (!healthAuthToken && !healthIpAllowlist) {
    let clientIp = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || '';
    if (clientIp.startsWith('::ffff:')) clientIp = clientIp.slice(7);
    if (clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === 'localhost') {
      return next();
    }
    if (process.env.NODE_ENV === 'production') {
      return res.status(401).json({ message: 'Unauthorized health access (unconfigured in production)' });
    }
    return next();
  }

  return res.status(401).json({ message: 'Unauthorized health access' });
};

app.get("/api/health", authenticateHealth, async (req, res) => {
  const dbStart = Date.now();
  let dbStatus = 'DOWN';
  let dbLatency = 0;

  try {
    const { rows } = await pool.query("SELECT 1 as ok");
    if (rows?.[0]?.ok === 1) {
      dbStatus = 'UP';
      dbLatency = Date.now() - dbStart;
    }
  } catch (_) {
    dbStatus = 'DOWN';
  }

  const status = dbStatus === 'UP' ? 'UP' : 'DEGRADED';
  res.status(status === 'UP' ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services: {
      database: { status: dbStatus, latency: `${dbLatency}ms` },
    }
  });
});

app.get("/api/health/live", authenticateHealth, (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get("/api/health/ready", authenticateHealth, async (req, res) => {
  const checks = {};
  let healthy = true;

  try {
    await pool.query('SELECT 1');
    checks.database = 'ok';
  } catch (err) {
    checks.database = 'error';
    healthy = false;
  }

  if (process.env.REDIS_URL) {
    try {
      const { default: Redis } = await import('ioredis');
      const client = new Redis(process.env.REDIS_URL, { lazyConnect: true, connectTimeout: 2000, maxRetriesPerRequest: 1 });
      await client.connect();
      await client.ping();
      await client.quit();
      checks.redis = 'ok';
    } catch (err) {
      checks.redis = 'error';
      healthy = false;
    }
  }

  res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', checks });
});

// ── Routes — edge/device-facing surface only ─────────────────────────────────
app.use("/api/bootstrap", bootstrapRoutes);      // public device-code token claim (no auth)
app.use("/api/events", deviceEventsRoutes);      // authenticateDevice — photo/event/batch upload, command polling
app.use("/api/face/sync", faceSyncRoutes);       // authenticateDevice — embeddings/employees/config/cameras pull-sync
app.use("/api/face", faceRoutes);                // authenticateDevice — POST /recognize
app.use("/api/cameras", cameraRoutes);           // authenticateDevice(+Optional) — heartbeat, device-sync, camera-sync
app.use("/api/devices", deviceRoutes);           // authenticateDevice — heartbeat, enrollment polling
app.use("/api/device-management", deviceManagementRoutes); // authenticateDevice + public /devices/activate
app.use("/api/attendance", attendanceRoutes);    // authenticateDevice — frame/bulk-sync/direction ingest
app.use("/api/jetson", jetsonRoutes);            // authenticateDevice — legacy firmware heartbeat
app.use("/api/employees", employeeRoutes);       // authenticateDevice — direct face-embedding enrollment

// === Retail vertical (api-retail) — device-facing routes only ==============
// Mount paths mirror backend/api-retail/src/index.js's BASE = '/api/v1/retail'
// exactly. Order (devices -> snapshot -> count) matches the source file too.
const RETAIL_BASE = "/api/v1/retail";
app.use(`${RETAIL_BASE}/health`,  retailHealthRoutes);
app.use(`${RETAIL_BASE}/devices`, retailDeviceRoutes);   // authenticateDevice — heartbeat/health
app.use(`${RETAIL_BASE}/devices`, retailSnapshotRoutes); // authenticateDevice — POST /:id/snapshot
app.use(`${RETAIL_BASE}/devices`, retailCountRoutes);    // authenticateDevice — count/occupancy
// =============================================================================

// FIX-015: Log all 401 / 403 / 429 responses as security events to audit_log.
// Must be registered AFTER all API routes so req.device/req.auth is populated.
app.use(securityEventLogger);

// Error handling middleware
app.use((err, _req, res, _next) => {
  const jwtCodes = ['ERR_JWS_INVALID', 'ERR_JWT_EXPIRED', 'ERR_JWT_CLAIM_VALIDATION_FAILED',
    'ERR_JWKS_NO_MATCHING_KEY', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED'];
  if (err.code && jwtCodes.includes(err.code)) {
    return res.status(401).json({ message: 'invalid or expired token' });
  }
  if (err.message?.toLowerCase().includes('jwt') || err.message?.toLowerCase().includes('audience')) {
    return res.status(401).json({ message: err.message });
  }

  logger.error(err);

  res.status(500).json({
    message: "internal server error",
    error: env.nodeEnv === 'development' ? err.message : undefined
  });
});

// Initialize services and start server
async function startServer() {
  // Validate critical security secrets at startup
  const requiredEnv = [
    'DEVICE_JWT_SECRET',
    'ENROLLMENT_TOKEN_SECRET',
  ];
  for (const key of requiredEnv) {
    if (!process.env[key]) {
      throw new Error(`CRITICAL STARTUP ERROR: Environment variable ${key} is required but missing`);
    }
  }

  try {
    await warmPool();
    logger.info('✅ Database pool warmed');

    const server = app.listen(env.port, () => {
      logger.info(`🚀 Edge API listening on http://localhost:${env.port}`);
    });

    // No local Socket.IO server is started here — this service has no
    // browser clients. wsManager still works: broadcasts fall through to the
    // Redis emitter (see websocket/redisEmitter.js) when REDIS_URL is set, so
    // device-event/attendance broadcasts still reach frs-fe-api's Socket.IO
    // server (which DOES call wsManager.initialize()) across processes. When
    // REDIS_URL is unset, those broadcasts are silent no-ops — never fatal.
    setAuditWsManager(wsManager);
    attendanceService.setBroadcaster((event, payload) => {
      if (event === "attendance.marked" || event === "attendance.batchMarked") {
        wsManager.emitAttendanceUpdate(payload);
      }
    });

    try {
      await uploadSnapshotPushService.initialize();
      logger.info('✅ Snapshot uploader initialized');
    } catch (e) {
      logger.warn('Snapshot uploader init failed:', e.message);
    }

    // Subscribe to enterprise Kafka topics that feed device-event/AI-detection
    // presence broadcasts onward via wsManager (see note above).
    try {
      await kafkaEventService.subscribeToDeviceEvents(async (evt) => {
        wsManager.emitPresenceUpdate({ type: 'device_event', evt });
      });
      await kafkaEventService.subscribeToAIDetections(async (evt) => {
        wsManager.emitAttendanceUpdate({ type: 'ai_detection', evt });
      });
      logger.info('✅ Subscribed to enterprise Kafka topics');
    } catch (e) {
      logger.warn('Kafka enterprise subscriptions failed:', e.message);
    }

    // PERF-0001: write-behind attendance ingest worker (drains attendance-ingest).
    try {
      const { startAttendanceIngestWorker } = await import('./core/workers/attendanceIngestWorker.js');
      await startAttendanceIngestWorker();
    } catch (e) {
      logger.warn('Attendance ingest worker not started:', e.message);
    }

    // Graceful shutdown handler
    const shutdown = async (signal) => {
      logger.info(`\n🛑 Received ${signal}, starting graceful shutdown...`);

      server.close(async () => {
        await shutdownManager.shutdown(signal);
        await pool.end();
        logger.info('👋 Shutdown complete');
        process.exit(0);
      });

      setTimeout(() => {
        logger.error('Force shutdown due to timeout');
        process.exit(1);
      }, 30000);
    };

    process.on("SIGINT", () => shutdown('SIGINT'));
    process.on("SIGTERM", () => shutdown('SIGTERM'));

  } catch (error) {
    logger.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
