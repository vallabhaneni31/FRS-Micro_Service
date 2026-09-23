import express from "express";
import cors from "cors";
import helmet from "helmet";
import sharp from "sharp";
import cookieParser from "cookie-parser"; // S-01: httpOnly cookie sessions
import { env } from "./config/env.js";

// FRS-ARCH-002 Phase 6 (R6): sharp defaults to using every core for its
// internal (libvips) thread pool, per process — capped globally, once, at
// process start. See the source repo's equivalent comment for the full
// rationale (backend/api/src/server.js).
sharp.concurrency(2);
import logger from "./utils/logger.js";
import { alertRoutes } from "./routes/alertRoutes.js";
import { incidentRoutes } from "./routes/incidentRoutes.js";
import { watchlistRoutes } from "./routes/watchlistRoutes.js";
import { confidenceReviewRoutes } from "./routes/confidenceReviewRoutes.js";
import { liveRoutes } from "./routes/liveRoutes.js";
import { deviceRoutes } from "./routes/deviceRoutes.js";
import { attendanceRoutes } from "./routes/attendanceRoutes.js";
import { employeeRoutes } from "./routes/employeeRoutes.js";
import { dashboardRoutes } from "./routes/dashboardRoutes.js";
import { zoneRoutes } from "./routes/zoneRoutes.js";
import { searchRoutes } from "./routes/searchRoutes.js";
import { faceRoutes } from "./routes/faceRoutes.js";
import { reportRoutes } from "./routes/reportRoutes.js";
import { hrRoutes } from "./routes/hrRoutes.js";
import { jetsonRoutes } from "./routes/jetsonRoutes.js";
import enrollmentRoutes from "./routes/enrollmentRoutes.js";
import { cameraRoutes } from "./routes/cameraRoutes.js";
import swaggerRoutes from "./routes/swaggerRoutes.js";
import { siteRoutes } from "./routes/siteRoutes.js";
import deviceManagementRoutes from "./routes/deviceManagementRoutes.js";
import hrmsIntegrationRoutes from './routes/hrmsIntegrationRoutes.js';
import siteManagementRoutes from "./routes/siteManagementRoutes.js";
import appAdminRoutes from "./routes/appAdminRoutes.js";
import manifestRoutes from "./routes/manifestRoutes.js";
import tenantAdminRoutes from "./routes/tenantAdminRoutes.js";
import monitoringRoutes from "./routes/monitoringRoutes.js";
import configRoutes from "./routes/configRoutes.js";
import faceSyncRoutes from "./routes/faceSyncRoutes.js";
import { deviceTokenRoutes } from "./routes/deviceTokenRoutes.js";         // FIX-012
import { securityEventLogger } from "./middleware/securityEventLogger.js";  // FIX-015
import { correlationIdMiddleware } from "./middleware/correlationId.js";     // W-06
import { requestLogger } from "./middleware/requestLogger.js";       // O-02
import { biometricConsentRoutes } from "./routes/biometricConsentRoutes.js"; // FIX-025
import studentsRoutes from "./routes/studentsRoutes.js"; // Edu Tier 1
import peopleRoutes from "./routes/peopleRoutes.js";
import { startDeviceOfflineCron } from "./jobs/deviceOfflineCron.js";

// === Retail vertical (api-retail) ===
// User/admin-facing half of the retail people-counting/occupancy service,
// copied from frs-core-api/backend/api-retail (read-only source). The
// device-facing half (authenticateDevice routes: heartbeat/health, snapshot
// push, count/occupancy ingest) lives in frs-edge-api instead. This vertical
// has its own separate Postgres database (RETAIL_DB_URL) — see
// src/retail/db/pool.js — kept isolated from this repo's main pool.
import { healthRoutes as retailHealthRoutes } from "./retail/routes/healthRoutes.js";
import { storeRoutes as retailStoreRoutes } from "./retail/routes/storeRoutes.js";
import { cameraRoutes as retailCameraRoutes } from "./retail/routes/cameraRoutes.js";
import { deviceRoutes as retailDeviceRoutes } from "./retail/routes/deviceRoutes.js";
import { snapshotRoutes as retailSnapshotRoutes } from "./retail/routes/snapshotRoutes.js";
import { dashboardRoutes as retailDashboardRoutes } from "./retail/routes/dashboardRoutes.js";
import { reportRoutes as retailReportRoutes } from "./retail/routes/reportRoutes.js";
import { settingsRoutes as retailSettingsRoutes } from "./retail/routes/settingsRoutes.js";
import { inviteRoutes as retailInviteRoutes } from "./retail/routes/inviteRoutes.js";
// === End retail vertical imports ===

import { startDataRetentionCron } from "./jobs/dataRetentionCron.js";
import { startEnrollmentReminderCron } from "./jobs/enrollmentReminderCron.js";
import { startDriftMonitorCron } from "./services/ai-evaluation/aiDriftMonitor.js"; // FIX-037
import { pool, warmPool } from "./db/pool.js";
import { globalRateLimiter } from "./middleware/rateLimit.js";
import { extractScope, validateScopeAccess } from "./middleware/scopeExtractor.js";
import { requireAuth, requirePermission } from "./middleware/authz.js";
import { verifyPhotoAccess } from "./middleware/photoAccess.js";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

// Import core services
import shutdownManager from "./core/managers/ShutdownManager.js";
import validationService from "./core/services/ValidationService.js";
import { configLoaders } from "./config/loaders.js";
import wsManager from "./websocket/index.js";
import { setAuditWsManager } from "./middleware/auditLog.js";
import attendanceService from "./services/business/AttendanceService.js";
import uploadSnapshotPushService from "./core/services/UploadSnapshotPushService.js";
import livePresenceService from "./services/business/LivePresenceService.js";
import * as visitorValidation from "./services/visitorValidationService.js";
import kafkaEventService from "./core/kafka/KafkaEventService.js";

// NOTE (frs-fe-api split): this server.js is the frontend-facing half of
// backend/api/src/server.js (see docs/architecture/API_SPLIT_PLAN.md in
// frs-core-api). Dropped relative to the source file:
//   - authenticateDevice / device-JWT setup and its two frame-ingest routes
//     (POST /api/frames/rtsp/:cameraId, POST /api/frames/smart/:cameraId) —
//     device-originated, now live in frs-edge-api.
//   - route mounts for bootstrapRoutes.js and deviceEventsRoutes.js (both
//     entirely device-facing, moved to frs-edge-api).
//   - the Jetson-`:nan`-JSON body sanitizer that was mounted ahead of
//     /api/jetson (that quirk belonged to device heartbeat payloads, which
//     no longer land in this repo's jetsonRoutes.js).
// The ModelManager / InferenceProcessorCore stubs from the source file were
// already disabled no-ops there ("until Jetson online") and are dropped here
// outright rather than carried over as dead code.
const modelManager = { initialize: async () => { }, getMemoryInfo: () => null };
const inferenceProcessor = { initialize: async () => { }, getStats: () => null, on: () => { } };

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
app.use("/api/live", express.json({ limit: "1mb" }));
app.use("/api/me", express.json({ limit: "1mb" })); // manifestRoutes.js (/api/me/manifest, /preferences) — meRoutes.js moved to frs-iam-api
app.use("/api/students", express.json({ limit: "1mb" }));

// High-limit routes specifically parsed first
app.use("/api/enroll", express.json({ limit: "10mb" }));
app.use("/api/hrms", express.json({ limit: "10mb" }));

app.use(express.json({ limit: "10mb" }));
app.use(express.raw({ type: 'image/*', limit: '10mb' }));

// Normalize duplicate /api/api prefix sent by legacy clients
app.use((req, res, next) => {
  if (req.url.startsWith('/api/api/')) {
    req.url = req.url.slice(4);
  }
  next();
});

// 1. General IP Throttling for all API endpoints.
//    PERF-0001: device/edge ingest routes were throttled per-DEVICE
//    (deviceIngestLimiter) and exempted here in the source repo — those
//    routes (attendance/frame, attendance/bulk-sync, attendance/direction,
//    face/recognize, cameras/:id/heartbeat, /api/events/*) all now live in
//    frs-edge-api, so the exemption list is dropped along with them. The
//    /api/jetson/photos/:filename carve-out is kept — real UI/photo traffic,
//    not device ingest.
function isDeviceIngestPath(req) {
  const p = (req.originalUrl || req.url || "").split("?")[0];
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
//   /live  — is the process itself responsive. Deliberately no dependency
//            checks — an orchestrator restarting the process because the DB
//            is briefly down doesn't fix the DB, it just adds churn.
//   /ready — are this instance's actual dependencies reachable (DB; Redis
//            when REDIS_URL is set).
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

// auth, MFA, session bootstrap (/api/me/bootstrap), user accounts (/api/users),
// RBAC (/api/admin/rbac), and internal Keycloak/invite provisioning
// (/api/internal) are IAM's exclusively now — served by frs-iam-api, not
// duplicated here. See docs/architecture/API_SPLIT_PLAN.md.
app.use("/api/alerts", alertRoutes);
app.use("/api/incidents", incidentRoutes);
app.use("/api/watchlists", watchlistRoutes);
app.use("/api/confidence-reviews", confidenceReviewRoutes);
app.use("/api/app-admin", appAdminRoutes);
app.use("/api/activity-log", appAdminRoutes);
app.use("/api/activity-logs", appAdminRoutes);
app.use("/api/activity_log", appAdminRoutes);
app.use("/api/me", manifestRoutes);
app.use("/api/tenant-admin", tenantAdminRoutes);
app.use("/api/devices", deviceRoutes);
app.use("/api/device-management", deviceManagementRoutes);
app.use("/device-management", deviceManagementRoutes);
app.use('/api/hrms', hrmsIntegrationRoutes);
app.use("/api/site-management", siteManagementRoutes);
app.use("/api/monitoring", monitoringRoutes);
app.use("/api/config", configRoutes);
app.use("/api/face/sync", faceSyncRoutes);
app.use("/api/device-tokens", deviceTokenRoutes);        // FIX-012: token rotation/revocation
app.use("/api/consent/biometric", biometricConsentRoutes); // FIX-025: biometric consent
app.use("/api/students", studentsRoutes); // Edu Tier 1
app.use("/api/attendance", attendanceRoutes);
app.use("/api/employees", employeeRoutes);
app.use("/api/people", peopleRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/zones", zoneRoutes); // specs/0003-zone-analytics — requires zones.read (HR-only)
app.use("/api/search", searchRoutes);
app.use("/api/face", faceRoutes);
app.use("/api/site", siteRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/hr", hrRoutes);
app.use("/api/cameras", cameraRoutes);
app.use("/api/jetson", jetsonRoutes);
app.use("/api/enroll", enrollmentRoutes);
app.use("/api/enrollment", enrollmentRoutes); // FIX: Backwards compatibility for cached mobile apps
// Apply extractScope before auth to parse headers, then validate after auth
app.use("/api/live", extractScope, liveRoutes);
app.use("/api/docs", swaggerRoutes);

// === Retail vertical (api-retail) routes ===
// Mount paths mirror backend/api-retail/src/index.js's BASE = '/api/v1/retail'
// exactly (verified by reading that file). Kept in its own block, not
// interleaved with the routes above, since it's a fully separate vertical
// with its own DB/auth.
const RETAIL_BASE = "/api/v1/retail";
app.use(`${RETAIL_BASE}/health`, retailHealthRoutes);
app.use(`${RETAIL_BASE}/stores`, retailStoreRoutes);
app.use(`${RETAIL_BASE}/stores`, retailCameraRoutes);      // /:storeId/cameras
app.use(`${RETAIL_BASE}/devices`, retailDeviceRoutes);
app.use(`${RETAIL_BASE}/devices`, retailSnapshotRoutes);   // /:id/snapshot, /:id/snapshot/stream
app.use(`${RETAIL_BASE}/stores`, retailDashboardRoutes);   // /:id/live, /:id/history
app.use(`${RETAIL_BASE}/stores`, retailReportRoutes);      // /:id/reports
app.use(`${RETAIL_BASE}/settings`, retailSettingsRoutes);
app.use(`${RETAIL_BASE}/invite`, retailInviteRoutes);
// === End retail vertical routes ===

// FIX-015: Log all 401 / 403 / 429 responses as security events to audit_log.
// Must be registered AFTER all API routes so req.auth is populated.
app.use(securityEventLogger);

// Serve photo uploads (attendance snapshots, enrollment photos)
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
  // Validate critical security secrets at startup.
  // DEVICE_JWT_SECRET is still required here — deviceTokenRoutes.js and
  // DeviceManagementService.js sign device JWTs, so token issuance still
  // needs to work even though enroll-face-direct itself was removed
  // (AC 2.1 — that route now belongs to frs-edge-api).
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

    // Initialize model manager (stub — inference lives in frs-edge-api / Jetson)
    await modelManager.initialize();
    logger.info('✅ Model manager initialized');

    // Initialize inference processor (stub — inference lives in frs-edge-api / Jetson)
    await inferenceProcessor.initialize();
    logger.info('✅ Inference processor initialized');

    // Start server
    // Under PM2 cluster mode, every worker imports and executes this module —
    // without this guard, N workers would each run their own copy of every
    // setInterval/cron below. PM2 sets NODE_APP_INSTANCE (0-indexed) per
    // worker in cluster mode; outside cluster mode it's unset, so this still
    // runs normally in fork mode / plain `node server.js`.
    const IS_PRIMARY_INSTANCE = !process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === '0';

    const server = app.listen(env.port, () => {
      logger.info(`🚀 frs-fe-api listening on http://localhost:${env.port}`);
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
        // networks and cannot be reached from this service.
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
        // Start device offline detection cron (60s interval)
        startDeviceOfflineCron(wsManager, 60_000);
        logger.info('✅ Device offline cron started');

        // Start GDPR data retention cleanup cron (run once a day)
        startDataRetentionCron(24 * 3600 * 1000);
        logger.info('✅ GDPR data retention cron started');

        // Enrollment reminder cron — per-tenant opt-in, nudges employees with
        // an unfinished enrollment invitation at their site-local 9 AM.
        startEnrollmentReminderCron();
        logger.info('✅ Enrollment reminder cron started');

        // FIX-037: Start AI model drift monitoring cron (weekly)
        startDriftMonitorCron();
        logger.info('✅ AI drift monitor cron started');

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

    // Subscribe to enterprise Kafka topics (device-event / AI-detection
    // broadcasts consumed to drive live UI updates — publishing happens in
    // frs-edge-api).
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

    // PERF-0001: write-behind attendance ingest worker (drains attendance-ingest,
    // applying marks published by frs-edge-api's device ingest routes).
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
