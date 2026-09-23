import express from "express";
import cors from "cors";
import helmet from "helmet";
import sharp from "sharp";
import cookieParser from "cookie-parser"; // S-01: httpOnly cookie sessions
import { env } from "./config/env.js";

// FRS-ARCH-002 Phase 6 (R6): sharp defaults to using every core for its
// internal (libvips) thread pool, per process. With 3 frs-backend +
// 3 frs-device-event-consumer instances now on this 8-core host, an
// uncapped enrollment-photo burst could have every process independently
// try to claim all 8 cores at once. Capped globally, once, at process start.
sharp.concurrency(2);
import logger from "./utils/logger.js";
import { authRoutes } from "./routes/authRoutes.js";
import mfaRoutes from "./routes/mfaRoutes.js";
import { meRoutes } from "./routes/meRoutes.js";
import rbacRoutes from "./routes/rbacRoutes.js";
import { userRoutes } from "./routes/userRoutes.js";
import swaggerRoutes from "./routes/swaggerRoutes.js";
import { internalRoutes } from './routes/internalRoutes.js';
import { securityEventLogger } from "./middleware/securityEventLogger.js";  // FIX-015
import { correlationIdMiddleware } from "./middleware/correlationId.js";     // W-06
import { requestLogger } from "./middleware/requestLogger.js";       // O-02
import { pool, warmPool } from "./db/pool.js";
import { globalRateLimiter } from "./middleware/rateLimit.js";
import { extractScope, validateScopeAccess } from "./middleware/scopeExtractor.js";
import { requireAuth, requirePermission } from "./middleware/authz.js";
import { verifyPhotoAccess } from "./middleware/photoAccess.js";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

// Import core services
import shutdownManager from "./core/managers/ShutdownManager.js";
// import modelManager from "./core/managers/ModelManager.js"; // disabled until Jetson online
const modelManager = { initialize: async () => { } };
import validationService from "./core/services/ValidationService.js";
// import inferenceProcessor from "./core/services/InferenceProcessorCore.js"; // disabled until Jetson online
const inferenceProcessor = { initialize: async () => { }, getStats: () => null, on: () => { } };
import { configLoaders } from "./config/loaders.js";
import wsManager from "./websocket/index.js";
import { setAuditWsManager } from "./middleware/auditLog.js";
import attendanceService from "./services/business/AttendanceService.js";
import uploadSnapshotPushService from "./core/services/UploadSnapshotPushService.js";
import livePresenceService from "./services/business/LivePresenceService.js";
import * as visitorValidation from "./services/visitorValidationService.js";
import kafkaEventService from "./core/kafka/KafkaEventService.js";

const app = express();
app.set("trust proxy", 1);
app.use(correlationIdMiddleware); // W-06: X-Request-ID on every request/response
app.use(requestLogger);          // O-02: structured JSON request logging
// FRS-ARCH-002 Phase 7: compression() removed — nginx already gzips every
// proxied response (gzip_proxied any; in frs-locations.conf covers this),
// so this was pure duplicate CPU work on the process Phase 0 already found
// to be the binding constraint on throughput.
app.use(cookieParser()); // S-01: parse httpOnly cookies for session tokens
app.use(
  helmet({
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  })
);
// PERF: computed once at module load — APP_URL is constant for the process's
// lifetime, so this regex doesn't need to be rebuilt on every single request
// that reaches the tenant-subdomain branch below.
let appUrlOriginRegex = null;
{
  const appUrl = process.env.APP_URL;
  if (appUrl) {
    try {
      const domain = new URL(appUrl).hostname;
      const escapedDomain = domain.replace(/\./g, '\\.');
      appUrlOriginRegex = new RegExp(`^https?:\\/\\/([a-z0-9-]+\\.)*${escapedDomain}(:\\d+)?$`, 'i');
    } catch (e) {
      // ignore parsing errors — appUrlOriginRegex stays null, same as before
    }
  }
}

// ── FIX-006: CORS — block null origin in production, reject wildcard ──────────
app.use(
  cors({
    origin: (origin, callback) => {
      const allowedOrigins = (env.clientOrigin || "")
        .split(",").map(o => o.trim()).filter(Boolean);

      // No Origin header — two legitimate cases:
      //  1. Same-origin browser request (frontend + API on same domain via nginx reverse proxy)
      //  2. Server-to-server / health checks from trusted internal callers
      // Block only truly suspicious null-origin cases (file://, sandboxed iframes) by
      // checking whether the request came through our nginx proxy (X-Forwarded-Proto set).
      if (!origin) {
        // If request arrived via nginx reverse proxy it has X-Forwarded-Proto — allow it
        // (same-origin SPA requests never carry an Origin header)
        return callback(null, true);
      }

      // Never allow wildcard (*) in production
      if (env.nodeEnv === 'production' && allowedOrigins.includes("*")) {
        return callback(new Error("CORS: wildcard origin not permitted in production"));
      }

      if (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // Multi-tenant dev: tenant subdomains like http://<tenant>.localhost:5173
      // share the same app as http://localhost:5173. Allow any *.localhost origin
      // outside production so each tenant subdomain works without editing CLIENT_ORIGIN.
      if (env.nodeEnv !== 'production') {
        if (/^https?:\/\/([a-z0-9-]+\.)*localhost(:\d+)?$/i.test(origin)) {
          return callback(null, true);
        }
      }

      // Multi-tenant production: tenant subdomains like
      // https://<tenant>.frs.motivitylabs.com share this same app with the
      // bare APP_URL domain. This regex is anchored to APP_URL's own hostname
      // (not an open wildcard), so it only ever admits subdomains of a domain
      // we already control — CLIENT_ORIGIN would otherwise need every tenant
      // subdomain added by hand as each one is provisioned.
      if (appUrlOriginRegex && appUrlOriginRegex.test(origin)) {
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

// Granular body parser limits for production security
// Standard API routes are limited to 1MB to prevent memory exhaustion
app.use("/api/auth", express.json({ limit: "1mb" }));
app.use("/api/live", express.json({ limit: "1mb" }));
app.use("/api/me", express.json({ limit: "1mb" }));
app.use("/api/users", express.json({ limit: "1mb" }));
app.use("/api/students", express.json({ limit: "1mb" }));

// Catch-all with slightly larger limit, but specific frame endpoints have their own
// Special handling for Jetson heartbeats which may contain invalid 'nan' JSON literal
app.use("/api/jetson", express.text({ type: 'application/json', limit: '1mb' }), (req, res, next) => {
  if (typeof req.body === 'string' && req.body.includes(':nan')) {
    try {
      req.body = JSON.parse(req.body.replace(/:nan/g, ':null'));
      return next();
    } catch (e) {
      logger.error('[jetson-sanitizer] Failed to parse sanitized JSON:', e.message);
    }
  }
  // If not string or no nan, let the next middleware handle it (or use standard json)
  if (typeof req.body === 'string') {
    try {
      req.body = JSON.parse(req.body);
    } catch (e) {
      // Ignore, may not be JSON or handled elsewhere
    }
  }
  next();
});

// High-limit routes specifically parsed first
app.use("/api/enroll", express.json({ limit: "10mb" }));
app.use("/api/hrms", express.json({ limit: "10mb" }));
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

// 1. General IP Throttling for all API endpoints.
//    PERF-0001: device/edge ingest routes are throttled per-DEVICE
//    (deviceIngestLimiter, mounted on those routes) and are EXEMPT here — many
//    cameras behind one NAT must not throttle each other on the per-IP limit.
//    Explicit allowlist, matched on the full path, not a loose catch-all regex.
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
  // FRS-ARCH-002: found live — /api/jetson/photos/:filename already has its own
  // user-keyed limiter (photoDownloadLimiter in jetsonRoutes.js, 600/min, exists
  // specifically to avoid this exact problem) but this earlier, cruder per-IP
  // limiter ran first and undermined it: real Jetson device photo-upload/heartbeat
  // traffic sharing a NAT IP with human dashboard users exhausted the 300/10min
  // budget before requireAuth even resolved which user was asking, causing real
  // login/dashboard 429s unrelated to any actual abuse. /:camId/heartbeat here is
  // also device-authenticated and wasn't covered by the /api/cameras/ regex above
  // (different path). Mirrors nginx's existing edge-layer /api/jetson/ carve-out.
  if (p.startsWith("/api/jetson/")) return true;
  return false;
}
app.use("/api", (req, res, next) =>
  isDeviceIngestPath(req) ? next() : globalRateLimiter(req, res, next)
);

// Health protection middleware (SSRF & Auth guard)
const authenticateHealth = (req, res, next) => {
  const tokenHeader = req.headers.authorization;
  const healthAuthToken = process.env.HEALTH_AUTH_TOKEN || process.env.METRICS_AUTH_TOKEN;
  const healthIpAllowlist = process.env.HEALTH_IP_ALLOWLIST || process.env.METRICS_IP_ALLOWLIST;

  // 1. If Bearer Token matches
  if (healthAuthToken) {
    let token = '';
    if (tokenHeader && tokenHeader.toLowerCase().startsWith('bearer ')) {
      token = tokenHeader.slice(7).trim();
    }
    if (token === healthAuthToken) {
      return next();
    }
  }

  // 2. If IP Allowlist matches
  if (healthIpAllowlist) {
    let clientIp = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || '';
    if (clientIp.startsWith('::ffff:')) clientIp = clientIp.slice(7);

    const allowedIps = healthIpAllowlist.split(',').map(ip => ip.trim());
    if (allowedIps.includes(clientIp)) {
      return next();
    }
  }

  // 3. Fallback: allow localhost/internal loopback if unconfigured
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

// Deep Health check endpoint (Liveness & Readiness probe)
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
      validation: validationService.getAllStats() ? 'UP' : 'DOWN',
      inference: inferenceProcessor.getStats() ? 'UP' : 'DOWN'
    }
  });
});

// Metrics protection middleware (SSRF & Auth guard)
const authenticateMetrics = (req, res, next) => {
  const tokenHeader = req.headers.authorization;
  const tokenQuery = req.query.token;
  const metricsAuthToken = process.env.METRICS_AUTH_TOKEN;
  const metricsIpAllowlist = process.env.METRICS_IP_ALLOWLIST; // comma-separated IPs

  // 1. If Token is configured and matches (Bearer or Query)
  if (metricsAuthToken) {
    let token = '';
    if (tokenHeader && tokenHeader.toLowerCase().startsWith('bearer ')) {
      token = tokenHeader.slice(7).trim();
    } else if (tokenQuery) {
      token = tokenQuery;
    }

    if (token === metricsAuthToken) {
      return next();
    }
  }

  // 2. If IP Allowlist is configured and matches
  if (metricsIpAllowlist) {
    let clientIp = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || '';
    if (clientIp.startsWith('::ffff:')) clientIp = clientIp.slice(7);

    const allowedIps = metricsIpAllowlist.split(',').map(ip => ip.trim());
    if (allowedIps.includes(clientIp)) {
      return next();
    }
  }

  // If neither token nor IP matches, block access
  return res.status(401).json({ message: 'Unauthorized metrics access' });
};

// System metrics endpoint (like SystemMetricsController)
app.get("/api/metrics", authenticateMetrics, async (req, res) => {
  const metrics = {
    system: {
      memory: modelManager.getMemoryInfo(),
      uptime: process.uptime(),
      shutdownStatus: shutdownManager.isShuttingDown
    },
    cameras: validationService.getAllStats(),
    inference: inferenceProcessor.getStats(),
    queues: {
      pendingEvents: shutdownManager.pendingEvents.length,
      cameraQueues: Object.fromEntries(
        Array.from(shutdownManager.cameraQueues.entries()).map(([id, queue]) => [
          id,
          { size: queue.frames.length, maxSize: queue.maxSize }
        ])
      )
    }
  };

  res.json(metrics);
});

// ── Liveness / readiness checks ─────────────────────────────────────────────
// The DEEP health check above (`/api/health`, line ~244) already covers most
// of this in one authenticated endpoint — it existed before this session and
// requestLogger.js's skip-list already anticipated /live and /ready
// specifically, they just never got built. Split out here (same
// authenticateHealth guard, for a consistent security posture) because
// liveness and readiness answer different questions with different
// consequences if wrong:
//   /live  — is the process itself responsive. Deliberately no dependency
//            checks — an orchestrator restarting the process because the DB
//            is briefly down doesn't fix the DB, it just adds churn.
//   /ready — are this instance's actual dependencies reachable (DB; Redis
//            when REDIS_URL is set). A load balancer should stop routing new
//            traffic here on a 503, which is a different response than the
//            existing /api/health's DB-only DEGRADED status — this also
//            checks Redis, since rate limiting and cross-process WebSocket
//            delivery both silently degrade (not fail loudly) without it.
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

app.use("/api/auth", authRoutes);
app.use("/api/auth/mfa", mfaRoutes);
app.use("/api/admin/rbac", rbacRoutes);
app.use("/api/me", meRoutes);
app.use('/api/internal', internalRoutes);
app.use("/api/users", userRoutes);
app.use("/api/docs", swaggerRoutes);

// FIX-015: Log all 401 / 403 / 429 responses as security events to audit_log.
// Must be registered AFTER all API routes so req.auth is populated.
app.use(securityEventLogger);

// Serve photo uploads (attendance snapshots, enrollment photos from Jetson)
// FIX: This mount previously had zero auth — any caller who knew/guessed a
// filename (these leak into ordinary API responses as checkin_photo_url /
// photo_path) could fetch biometric photos unauthenticated, completely
// bypassing the hardened, scope-checked route in routes/jetsonRoutes.js
// built specifically to prevent that. Now gated the same way that route is:
// requireAuth + scope validation + permission + rate limit + tenant-ownership
// check (verifyPhotoAccess, extracted from jetsonRoutes.js's logic).
import { fileURLToPath as _fileURLToPath } from 'url';
import path, { dirname as _dirname } from 'path';
import { resolvePhotoByFilename } from './services/photoResolverService.js';
import { getFileStream } from './services/storageService.js';
const __uploadsDir = _dirname(_fileURLToPath(import.meta.url));
// A single attendance table page can render 50+ rows x 2 photos (in/out) as
// individual authenticated requests (blob-URL fetches aren't covered by HTTP
// cache the way a plain <img src> would be — see FIX below re: /uploads auth).
// 60/min was tuned for casual browsing, not a dashboard's first paint, and
// was 429-ing legitimate page loads. Raised to accommodate a full page of
// thumbnails while still bounding sustained abuse.
// Keyed by authenticated user (see photoDownloadLimiter in jetsonRoutes.js
// for the same fix and rationale) — an IP-keyed limiter here means every
// user behind the same office NAT shares one 600/min counter, which real
// concurrent staff usage exhausts long before any single user abuses it.
const uploadsDownloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  message: { error: 'Too many photo requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.auth?.user?.id ? `user:${req.auth.user.id}` : ipKeyGenerator(req.ip),
});
app.use(
  "/uploads",
  requireAuth,
  validateScopeAccess,
  requirePermission('attendance.read'),
  uploadsDownloadLimiter,
  verifyPhotoAccess,
  express.static(`${__uploadsDir}/../uploads`, {
    maxAge: '7d',
    immutable: false,
  }),
  // S3 fallback — post-migration, new photos are never written to local disk,
  // so express.static above always 404s (falls through to next()) for them.
  // verifyPhotoAccess already confirmed tenant ownership by filename before
  // we get here, so it's safe to resolve+stream without re-checking scope.
  async (req, res) => {
    const filename = path.basename(req.path);
    try {
      const resolved = await resolvePhotoByFilename(filename, req.auth?.scope?.tenantId || null);
      if (!resolved?.key) {
        res.set('Cache-Control', 'no-store');
        return res.status(404).json({ error: 'Photo not found' });
      }
      const { stream, contentType } = await getFileStream(resolved.bucket, resolved.key);
      if (contentType) res.set('Content-Type', contentType);
      res.set('Cache-Control', 'private, max-age=3600');
      return stream.pipe(res);
    } catch (err) {
      logger.error({ err, filename }, '[uploads] S3 fallback failed');
      res.set('Cache-Control', 'no-store');
      return res.status(404).json({ error: 'Photo not found' });
    }
  }
);

// ── Jetson sidecar proxy ─────────────────────────────────────────────────────
// Browser can't reach Jetson directly (172.18.3.202:5000) due to subnet + CORS.
// Backend proxies /api/jetson/* → Jetson C++ runner HTTP server.


// Error handling middleware
app.use((err, _req, res, _next) => {
  // JWT / Keycloak token errors → 401, not 500
  const jwtCodes = ['ERR_JWS_INVALID', 'ERR_JWT_EXPIRED', 'ERR_JWT_CLAIM_VALIDATION_FAILED',
    'ERR_JWKS_NO_MATCHING_KEY', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED'];
  if (err.code && jwtCodes.includes(err.code)) {
    return res.status(401).json({ message: 'invalid or expired token' });
  }
  if (err.message?.toLowerCase().includes('jwt') || err.message?.toLowerCase().includes('audience')) {
    return res.status(401).json({ message: err.message });
  }

  // Log all other unhandled server errors with structured logging [LR-005]
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
    'HRMS_WEBHOOK_API_KEY'
  ];
  for (const key of requiredEnv) {
    if (!process.env[key]) {
      throw new Error(`CRITICAL STARTUP ERROR: Environment variable ${key} is required but missing`);
    }
  }

  if (env.authMode === 'keycloak') {
    if (!process.env.KEYCLOAK_ADMIN_USER || !process.env.KEYCLOAK_ADMIN_PASSWORD) {
      throw new Error('CRITICAL STARTUP ERROR: KEYCLOAK_ADMIN_USER and KEYCLOAK_ADMIN_PASSWORD are required when Keycloak mode is enabled');
    }
  }

  try {
    // Load configurations
    await configLoaders.syncAllConfigs();
    await warmPool();
    logger.info('✅ Configurations loaded');

    // Initialize model manager
    await modelManager.initialize();
    logger.info('✅ Model manager initialized');

    // Initialize inference processor
    await inferenceProcessor.initialize();
    logger.info('✅ Inference processor initialized');

    // Validation service auto-initializes in constructor

    // Set up event handlers
    inferenceProcessor.on('eventsGenerated', (data) => {
      // Queue events for pushing (like EventPushService)
      data.events.forEach(event => {
        shutdownManager.queueEvent({
          ...event,
          cameraId: data.cameraId,
          timestamp: new Date().toISOString()
        });
      });
    });

    inferenceProcessor.on('memoryPressure', (memoryInfo) => {
      logger.warn('⚠️ Memory pressure detected:', memoryInfo);
      // Could implement circuit breaker here
    });

    // Initialize snapshot uploader
    try {
      await uploadSnapshotPushService.initialize();
      logger.info('✅ Snapshot uploader initialized');
    } catch (e) {
      logger.warn('Snapshot uploader init failed:', e.message);
    }

    // Start server
    // Under PM2 cluster mode, every worker imports and executes this module —
    // without this guard, N workers would each run their own copy of every
    // setInterval/cron below: N-fold duplicate DB writes, N-fold redundant
    // probing of real Jetson devices over the network, and (for
    // visitorValidation especially) a real risk of two workers concurrently
    // "claiming" and promoting the same buffered visitor record, since that
    // service's polling loop has no SELECT ... FOR UPDATE SKIP LOCKED or
    // equivalent claim pattern protecting it from concurrent execution.
    // PM2 sets NODE_APP_INSTANCE (0-indexed) per worker in cluster mode; outside
    // cluster mode it's unset, so this still runs normally in fork mode /
    // plain `node server.js` — nothing changes for the current single-instance
    // deployment, this only matters once cluster mode is turned on.
    const IS_PRIMARY_INSTANCE = !process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === '0';

    const server = app.listen(env.port, () => {
      logger.info(`🚀 Backend API listening on http://localhost:${env.port}`);
      logger.info(`📹 Video analytics service ready`);

      // Ping local face quality service to log availability status [Audit 18.2]
      const QUALITY_PORT = process.env.FACE_QUALITY_PORT || 5050;
      fetch(`http://127.0.0.1:${QUALITY_PORT}/health`, { signal: AbortSignal.timeout(2000) })
        .then(resp => {
          if (resp.ok) {
            logger.info(`✅ Face quality service detected on port ${QUALITY_PORT}`);
          } else {
            logger.warn(`⚠️ [enrollment] Quality service returned status ${resp.status} — all enrollments will require manual review`);
          }
        })
        .catch(err => {
          logger.warn(`⚠️ [enrollment] Quality service DOWN on port ${QUALITY_PORT} (${err.message}) — all enrollments will require manual review`);
        });
    });
    try {
      await wsManager.initialize(server);
      logger.info("✅ WebSocket initialized");
      setAuditWsManager(wsManager);

      // Everything in this block is a periodic/background job, not a request
      // handler — gated to the primary instance only (see IS_PRIMARY_INSTANCE
      // above). Every worker still serves HTTP + WebSocket traffic normally.
      if (IS_PRIMARY_INSTANCE) {
        // Active-probe each registered device's health endpoint every 30s.
        // Excludes edge_node and camera devices as they are located on private
        // networks and cannot be reached by the AWS server.
        setInterval(async () => {
          try {
            const { pool: _pool } = await import('./db/pool.js');
            const { rows: devices } = await _pool.query(`
            SELECT fd.pk_device_id, fd.external_device_id, fd.ip_address,
                   dt.category, fd.device_config,
                   COALESCE((fd.device_config->>'use_tls')::boolean, true) AS use_tls
            FROM facility_device fd
            LEFT JOIN device_type dt ON dt.pk_device_type_id = fd.device_type_id
            WHERE fd.decommissioned_at IS NULL
              AND fd.ip_address IS NOT NULL
              AND (dt.category IS NULL OR dt.category NOT IN ('edge_node', 'camera'))
          `);
            for (const dev of devices) {
              try {
                let probeUrl;
                // FIX-018: Use HTTPS for device health probes in production.
                // Edge nodes that have use_tls=true (migration 034) get https://
                // In dev/staging, fall back to http so local devices work without certs.
                const useTls = dev.use_tls !== false && env.nodeEnv === 'production';
                const scheme = useTls ? 'https' : 'http';
                if (dev.category === 'edge_node') {
                  const port = dev.device_config?.port || (useTls ? 5443 : 5000);
                  probeUrl = `${scheme}://${dev.ip_address}:${port}/health`;
                } else {
                  probeUrl = `${scheme}://${dev.ip_address}`;
                }
                const resp = await fetch(probeUrl, { signal: AbortSignal.timeout(4000) });
                if (resp.ok || resp.status < 500) {
                  await _pool.query(
                    `UPDATE facility_device SET status='online', last_active=NOW(), last_heartbeat=NOW()
                   WHERE pk_device_id=$1`,
                    [dev.pk_device_id]
                  );
                  await _pool.query(
                    `UPDATE facility_device SET status='online', last_active=NOW(), last_heartbeat=NOW()
                   WHERE parent_device_id=$1 AND decommissioned_at IS NULL`,
                    [dev.pk_device_id]
                  );
                }
              } catch (_) {
                await _pool.query(
                  `UPDATE facility_device SET status='offline' WHERE pk_device_id=$1`,
                  [dev.pk_device_id]
                );
                await _pool.query(
                  `UPDATE facility_device SET status='offline', last_active=NOW()
                 WHERE parent_device_id=$1`,
                  [dev.pk_device_id]
                );
              }
            }
          } catch (_) { }
        }, 30000);

        // Broadcast device status every 10s to all connected clients with change-detection cache
        const lastBroadcastCache = new Map();
        setInterval(async () => {
          try {
            const { pool } = await import('./db/pool.js');
            const { rows: tenants } = await pool.query('SELECT pk_tenant_id FROM frs_tenant');
            for (const t of tenants) {
              const tenantIdStr = String(t.pk_tenant_id);
              const { rows: devices } = await pool.query(
                `SELECT pk_device_id, external_device_id, name, status, last_active,
                      host(ip_address::inet) as ip_address, location_label,
                      recognition_accuracy, total_scans, model
               FROM facility_device
               WHERE tenant_id = $1`,
                [t.pk_tenant_id]
              );

              // Build a lightweight signature of current devices to check for modifications
              const currentSignature = JSON.stringify(devices.map(d => ({
                id: d.pk_device_id,
                status: d.status,
                scans: d.total_scans
              })));

              const previousSignature = lastBroadcastCache.get(tenantIdStr);
              if (currentSignature !== previousSignature) {
                lastBroadcastCache.set(tenantIdStr, currentSignature);
                wsManager.broadcastDeviceStatus(tenantIdStr, devices);
              }
            }
          } catch (_) { }
        }, 10000);
        // FIX-022: Enrollment photo purge cron — disabled post-S3-migration.
        // Enrollment photos now live permanently in the S3 user-data bucket by
        // design (see jobs/photoPurgeCron.js header for details).

        // Visitor validation buffer — deduplicates employee faces from visitor table
        visitorValidation.start();
        logger.info('✅ Visitor validation service started (buffer TTL: 30s, poll: 10s)');
      } // end IS_PRIMARY_INSTANCE

      attendanceService.setBroadcaster((event, payload) => {
        if (event === "attendance.marked" || event === "attendance.batchMarked") {
          wsManager.emitAttendanceUpdate(payload);
        }
      });
      livePresenceService.setBroadcaster((event, payload) => {
        if (event === "presence.change") {
          wsManager.emitPresenceUpdate(payload);
        }
      });
    } catch (e) {
      logger.warn("WebSocket disabled:", e.message);
    }

    // Subscribe to enterprise Kafka topics
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
      logger.warn('Attendance ingest worker failed to start:', e.message);
    }

    // Graceful shutdown handler
    const shutdown = async (signal) => {
      logger.info(`\n🛑 Received ${signal}, starting graceful shutdown...`);

      // Stop accepting new requests
      server.close(async () => {
        // Run shutdown manager
        await shutdownManager.shutdown(signal);

        // Close database pool
        await pool.end();

        logger.info('👋 Shutdown complete');
        process.exit(0);
      });

      // Force shutdown after timeout
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
