# FRS Backend — Technical Change Documentation

**Date:** 2026-07-21  
**Service:** `@motivity/api` (backend/api)  
**Scope:** All architectural and implementation changes to the Node.js/Express API

---

## 1. Architectural Overview — Before vs After

### Before
- `POST /api/events` accepted a device event, **synchronously** decoded photos, uploaded to S3, wrote to the database, and broadcast via WebSocket — all before sending an HTTP response.
- A single slow S3 upload or DB write could block the request for several seconds, causing Jetson firmware to time out and retry, which could duplicate records.
- Rate limiting used an **in-memory store** per process; multiple processes had independent counters, so the real effective limit was `max × N` workers.
- Background cron jobs (device polling, metrics, visitor validation) ran in **every** PM2 worker simultaneously, causing N-fold duplicate DB writes.
- Photo uploads used a single local-disk `uploads/` directory with **no authentication** on the static file server.

### After
- `POST /api/events` authenticates, validates, assigns a `event_uid` UUID, **publishes to Kafka**, and immediately returns `HTTP 202 { status: "queued" }`.
- All heavy processing (base64 decode, S3 upload, DB write, WebSocket broadcast) runs in a **separate standalone worker process** (`workers/deviceEventConsumer.js`) off the HTTP request path.
- Rate limiting upgraded to a **Redis-backed distributed store** shared across all processes.
- Background jobs are gated on `IS_PRIMARY_INSTANCE` (`NODE_APP_INSTANCE === '0'`), so only one PM2 worker runs them.
- Photo serving is fully authenticated (JWT + scope + permission + tenant-ownership check).
- S3 is the primary photo store; local disk is a read-only legacy fallback.

---

## 2. API Behavior Changes

### 2.1 `POST /api/events` — Single Event

| Property | Before | After |
|---|---|---|
| HTTP Status | `200 OK` | `202 Accepted` |
| Body `status` field | `"ok"` | `"queued"` |
| Body `event_id` field | absent | UUID assigned at ingest |
| Processing | Synchronous (blocks until DB write done) | Async (Kafka consumer does the work) |
| Max latency | 2–10 s (S3 + DB) | < 50 ms (Kafka publish only) |

**Before response:**
```json
{ "success": true, "message": "Event processed" }
```

**After response:**
```json
{ "success": true, "received": "attendance.checkin", "event_id": "uuid-v4", "status": "queued" }
```

### 2.2 `POST /api/events/batch` — Batch Events

| Property | Before | After |
|---|---|---|
| HTTP Status | `200 OK` | `202 Accepted` |
| Per-item `status` | `"processed"` | `"queued"` |
| `event_id` per item | absent | UUID per event |
| Batch size limit | none | `MAX_BATCH_EVENTS` (default: 100) |

**After response shape:**
```json
{
  "success": true,
  "processed": 3,
  "results": [
    { "id": "client-ref-1", "status": "queued", "event_id": "uuid-1" },
    { "id": "client-ref-2", "status": "queued", "event_id": "uuid-2" },
    { "id": "client-ref-3", "status": "error",  "message": "event_type is required" }
  ]
}
```

### 2.3 New Endpoint — `POST /api/events/photo-upload-url`

Allows a Jetson device to receive a **pre-signed S3 PUT URL** and upload a photo directly to S3, completely bypassing the API tier for photo bytes.

**Request:**
```json
{ "event_type": "attendance.checkin", "payload": { "employee_code": "E001" } }
```

**Response:**
```json
{ "success": true, "url": "https://s3.amazonaws.com/...", "key": "tenant-xxx/employee/E001/2026-07-21/in/...", "expiresIn": 300 }
```

The device then PUTs the JPEG directly to `url`, and sends the attendance event with `photo_key` instead of `photo_base64`.

---

## 3. New Asynchronous Processing Flow

```
Jetson Firmware
     │
     │  POST /api/events  (Bearer device-JWT)
     ▼
authenticateDevice middleware
     │  validates JWT, checks revocation table
     ▼
deviceEventRateLimiter (1200 req/min/device, Redis-backed)
     │
     ▼
DeviceEventController.postEvent()
     │  1. validateEventPayload (Joi schema)
     │  2. randomUUID() → event_uid
     │  3. kafkaProducer.sendEvent('frs.jetson-device-events', {...})
     │  4. return 202 { status: 'queued', event_id }
     ▼
Kafka topic: frs.jetson-device-events
     │
     ▼  (separate OS process)
workers/deviceEventConsumer.js
     │  KafkaConsumer.runBatch()
     │  1. claimBatch() → INSERT INTO event_dedup ON CONFLICT DO NOTHING
     │  2. skip duplicates
     │  3. processOne() → up to 3 retries with exponential backoff
     │     ├── DeviceEventService.processEvent()
     │     │   ├── decode photo_base64 → upload to S3
     │     │   ├── INSERT device_events (audit log)
     │     │   ├── handleFaceRecognized / handleHeartbeat / etc.
     │     │   ├── DB writes (attendance_record, etc.)
     │     │   └── WebSocket broadcast via Redis emitter
     │     └── on failure: kafkaProducer.routeToDeadLetter()
     ▼
workers/deadLetterMonitor.js  (separate OS process)
     │  Reads frs.dead-letter topic
     │  Logs ERROR with event_uid, device_code, event_type
     └── logs ERROR with event_uid, device_code, event_type
```

### Idempotency (at-least-once delivery protection)

Kafka guarantees **at-least-once** delivery. To prevent duplicate attendance records on consumer restart or rebalance:

1. `DeviceEventController` assigns a `event_uid = randomUUID()` to every event before publishing.
2. `deviceEventConsumer.claimBatch()` does a batch `INSERT INTO event_dedup (event_uid) SELECT DISTINCT unnest($1::uuid[]) ON CONFLICT DO NOTHING RETURNING event_uid`.
3. Only events whose `event_uid` was **newly inserted** (returned by `RETURNING`) are processed. Others are logged and skipped.
4. The dedup check is done in **one round trip** for the entire batch (O(1) vs O(N)).

### In-order Processing

Events within the same Kafka partition are processed **sequentially** (not in parallel) inside `handleBatch()`. This preserves the Kafka ordering guarantee: a checkout always follows its checkin for the same employee, even within the same batch.

---

## 4. Kafka Integration

### 4.1 KafkaConfig (`core/kafka/KafkaConfig.js`)

Production-hardened Kafka configuration:

| Feature | Behavior |
|---|---|
| SSL | Respects `KAFKA_SSL_ENABLED`; defaults `true` in production, `false` in dev |
| SASL | Reads `KAFKA_SASL_MECHANISM / USERNAME / PASSWORD`; warns if absent in production |
| SASL PLAIN | Warns (not blocked) — recommend `scram-sha-256` or `scram-sha-512` |
| Producer idempotent | `idempotent: true` enforced — prevents duplicate messages on retries |
| Producer acks | `acks=-1` (all) — automatic when idempotent mode is on |
| Retry | 8 retries, 100 ms initial backoff |

### 4.2 Topics

| Topic | Purpose |
|---|---|
| `frs.jetson-device-events` | Primary ingest: Jetson → consumer worker |
| `frs.events` | Enterprise events (subscribed in server.js) |
| `frs.detections` | AI detection results |
| `frs.ai-detections` | AI detection broadcast stream |
| `frs.device-events` | Device-level events |
| `frs.alerts` | Alert pipeline |
| `frs.smart-search` | Smart search queries |
| `frs.smart-search-results` | Smart search results |
| `frs.system-metrics` | System metrics publishing |
| `frs.dead-letter` | Poison/failed messages |

Partitions: 3 (default, via `KAFKA_NUM_PARTITIONS`).  
Replication factor: 1 (dev/staging), set `KAFKA_REPLICATION_FACTOR=3` in production.

### 4.3 Consumer Worker (`workers/deviceEventConsumer.js`)

- Runs as a **standalone PM2 app** (`node src/workers/deviceEventConsumer.js`), separate from `frs-backend`.
- Uses `KafkaConsumer.runBatch()` (kafkajs `eachBatch`) — not one-at-a-time.
- Offsets committed only **after** the handler returns successfully; a crash mid-batch triggers redelivery (protected by `event_dedup`).
- Heartbeat is sent per batch to avoid consumer-group rebalance during slow processing.
- Retry: up to **3 attempts** with exponential backoff (500 ms, 1000 ms, 2000 ms) per event.
- After exhausting retries: routes to `frs.dead-letter` via `kafkaProducer.routeToDeadLetter()`.

### 4.4 Dead Letter Monitor (`workers/deadLetterMonitor.js`)

- Separate standalone process watching `frs.dead-letter`.
- Logs every arrival at **ERROR level** with full event context (`event_uid`, `device_code`, `event_type`, original error).
- Important rationale: Jetson firmware treats any 2xx as final and discards its local copy. After Kafka decoupling, a `202` no longer means "processed" — it means "accepted". A DLQ arrival means data is permanently at risk unless a human reviews it.
## 5. Rate Limiter Changes

### 5.1 Upgrade to Redis-Backed Distributed Limiting

**File:** `src/middleware/rateLimit.js`

Previously, all rate limiters used the default in-memory store. When PM2 runs N worker processes, each process maintained its own counter — so the effective rate limit was `max × N`, making the limits meaningless in a multi-process deployment.

**Changes:**
- Added `ioredis` + `rate-limit-redis` (`RedisStore`) as the backing store when `REDIS_URL` is configured.
- Falls back to in-memory gracefully with a warning log when Redis is unavailable.
- Each limiter gets its **own `RedisStore` instance** with a unique key prefix (`frs:rl:<name>:`). This is required because:
  - `express-rate-limit` v7+ throws `ERR_ERL_STORE_REUSE` if the same store object is shared between limiters.
  - Sharing a store would cause different limiters to commingle counters under the same Redis keys.

**Critical bug fixed:** The old `keyGenerator` passed `req` (the full request object) to `ipKeyGenerator`, which expects an IP string. In express-rate-limit v7+, this silently stringified to `"[object Object]"`, causing every client to share one counter. Every limiter was effectively a global counter with no per-IP separation. Fixed to `ipKeyGenerator(req.ip)`.

### 5.2 Rate Limiter Inventory

| Limiter | Window | Max | Keyed By | Redis Prefix |
|---|---|---|---|---|
| `globalRateLimiter` | 10 min | 300 req | IP | `frs:rl:global:` |
| `deviceEventRateLimiter` | 1 min | 1200 req (env tunable) | `device:<id>` | `frs:rl:device-events:` |
| `authRateLimiter` | 5 min | 10 req | IP | `frs:rl:auth:` |
| `accountLoginLimiter` | 15 min | 8 req | email (fallback: IP) | `frs:rl:account-login:` |
| `inviteLimiter` | 15 min | 5 req | IP | `frs:rl:invite:` |
| `photoUploadLimiter` | 5 min | 20 req | IP | `frs:rl:photo-upload:` |
| `activationLimiter` | 10 min | 10 req | IP | `frs:rl:activation:` |
| `uploadsDownloadLimiter` | 1 min | 300 req | IP | (in-memory, inline) |
| `photoDownloadLimiter` | 1 min | 300 req | IP | (in-memory, inline) |

**`globalRateLimiter` exemption fix:** The skip condition for `/api/events` was using `req.path.startsWith('/api/events')`, but Express rebases `req.path` at each `app.use()` mount. Inside the `/api` mount, `req.path` for `/api/events/batch` is already `/events/batch` — so the exemption never fired. Fixed to use `req.originalUrl.startsWith('/api/events')` which is never rebased.

### 5.3 `deviceEventRateLimiter`

New limiter specifically for authenticated device traffic:
- **Keyed by `req.device.id`** (stable numeric DB PK), not IP. Device IPs may be dynamic (DHCP); device codes are renameable; only the DB PK is a truly stable identifier.
- Must be mounted **after** `authenticateDevice` so `req.device` is populated.
- Default: 1200 req/min (20/sec/device). Override: `DEVICE_RATE_LIMIT_MAX` env var.

### 5.4 `accountLoginLimiter`

New per-account brute-force protection:
- Keyed by normalized email (not IP), so a distributed attack rotating source IPs against one account is still throttled.
- `skipSuccessfulRequests: true` — only failed logins (4xx/5xx) count toward the limit.

---

## 6. PM2 / Cluster Changes

### 6.1 `IS_PRIMARY_INSTANCE` Guard

**File:** `src/server.js` line 663

```js
const IS_PRIMARY_INSTANCE = !process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === '0';
```

PM2 sets `NODE_APP_INSTANCE` (0-indexed) on each worker in cluster mode. It is **unset** in fork mode or plain `node server.js`, so the guard is backwards-compatible — nothing changes for single-process deployments.

All **background jobs are gated behind `IS_PRIMARY_INSTANCE`**:
- Periodic metrics update (every 30 s)
- Active device health probing (every 30 s)
- Device status WebSocket broadcast (every 10 s)
- Device offline cron (`startDeviceOfflineCron`, 60 s)
- GDPR data retention cron (daily)
- AI drift monitor cron (weekly)
- Visitor validation service polling (30 s)

All workers **still serve HTTP and WebSocket** traffic equally — the guard only prevents N workers from each running cron jobs.

### 6.2 Worker Processes (PM2 Apps)

Three separate PM2 app entries are now needed:

| App Name | Entry Point | Instances | Purpose |
|---|---|---|---|
| `frs-backend` | `src/server.js` | N (cluster) | HTTP API + WebSocket |
| `frs-device-event-consumer` | `src/workers/deviceEventConsumer.js` | 1 (fork) | Kafka consumer for Jetson events |
| `frs-dead-letter-monitor` | `src/workers/deadLetterMonitor.js` | 1 (fork) | DLQ visibility / alerting |

**Recommended `ecosystem.config.cjs`:**
```js
module.exports = {
  apps: [
    {
      name: 'frs-backend',
      script: 'src/server.js',
      instances: 'max',
      exec_mode: 'cluster',
      env: { NODE_ENV: 'production' }
    },
    {
      name: 'frs-device-event-consumer',
      script: 'src/workers/deviceEventConsumer.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production', CONSUMER_METRICS_PORT: '9465' }
    },
    {
      name: 'frs-dead-letter-monitor',
      script: 'src/workers/deadLetterMonitor.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production', DLQ_MONITOR_METRICS_PORT: '9466' }
    }
  ]
};
```

> **Note:** `deviceEventConsumer.js` can be horizontally scaled (multiple instances in a consumer group) — Kafka will partition the load across them automatically, and `event_dedup` handles cross-instance deduplication.

---

## 7. S3 Upload Changes

### 7.1 Two-Bucket Architecture

**File:** `src/services/storageService.js`

| Bucket | Env Var | Contents |
|---|---|---|
| Logs bucket | `AWS_S3_LOGS_BUCKET` | Attendance check-in/out photos, unknown face snapshots (temporal) |
| User-data bucket | `AWS_S3_USER_DATA_BUCKET` | Enrollment photos, profile photos (permanent) |

Callers pass the bucket explicitly via the exported `LOGS_BUCKET` / `USER_DATA_BUCKET` constants. No bucket is ever guessed internally.

### 7.2 S3 Key Structure

All keys follow the pattern:
```
tenant-{tenantId}/{kind}/{safeId}/{YYYY-MM-DD}/{in|out}/{Name}_{YYYY-MM-DD}_{HH-MM-SS}.jpg
```

- **`tenantId`** is the stable UUID (never the tenant name, which is renameable).
- **`kind`** is `employee` or `visitor`.
- **Date/time** reflect `event_time` from the device (capture moment), not upload time.
- A random nonce is appended to guarantee uniqueness within the same second.

### 7.3 Photo Upload Flow (Option A — Base64, Default)

This is the current Jetson firmware path, unchanged from the device side:

1. Device includes `photo_base64` in the event payload.
2. `DeviceEventController` publishes the event as-is to Kafka.
3. `deviceEventConsumer` calls `DeviceEventService.processEvent()`.
4. `processEvent` decodes `photo_base64` → `Buffer`, runs `sharp` metadata check, calls `storageService.uploadFile(LOGS_BUCKET, key, buffer)`.
5. `payload.photo_url` is set to the S3 key; `photo_base64` is deleted from the payload before DB writes.

### 7.4 Photo Upload Flow (Option B — Direct S3, New)

For updated Jetson firmware — removes photo bandwidth from the API tier entirely:

1. Device calls `POST /api/events/photo-upload-url` with `event_type` + identity fields.
2. Server derives the exact S3 key (same function as Option A: `resolveEventPhotoKey`).
3. Server returns a **presigned S3 PUT URL** (5-minute expiry).
4. Device PUTs the JPEG directly to S3 — no API tier involved.
5. Device sends the actual event with `photo_key: "<the-key>"` instead of `photo_base64`.
6. `processEvent` calls `storage.objectExists(LOGS_BUCKET, photo_key)` to verify the upload landed before trusting it.

> **Security:** The device never chooses its own key — `resolveEventPhotoKey` is always called server-side, so a compromised device cannot write outside its own tenant/identity scope.

### 7.5 `storageService.js` API

| Function | Description |
|---|---|
| `uploadFile(bucket, key, buffer, contentType)` | Upload buffer to S3; logs initiated/succeeded/failed |
| `deleteFile(bucket, key)` | Delete object; returns `false` (not throws) if already gone |
| `getFileStream(bucket, key)` | Returns readable stream for proxy-serving to browser |
| `getFileBuffer(bucket, key)` | Returns fully-buffered file (for Jetson forwarding) |
| `getDownloadUrl(bucket, key, expiresSeconds)` | Presigned GET URL (for future direct-from-S3 serving) |
| `getUploadUrl(bucket, key, {contentType, expiresSeconds})` | Presigned PUT URL for Option B device uploads |
| `objectExists(bucket, key)` | HEAD check — verify Option B upload landed |

### 7.6 Photo Resolver (`photoResolverService.js`)

Resolves a bare filename back to its storage location. Checked in order:

1. `attendance_record.checkin_photo_url / checkout_photo_url` → Logs bucket
2. `device_events.payload_json->>'photo_url'` → Logs bucket
3. `employee_face_embeddings.photo_path` → User-data bucket
4. `person_face_embeddings.photo_path` → User-data bucket
5. `person.photo_url` → User-data bucket
6. `device_command_queue.command_payload->>'photo_key'` → User-data bucket
7. `enrollment_invitations.photo_paths` (JSONB) → User-data bucket

**Legacy detection:** If the resolved value starts with `/`, it's a pre-migration local disk path. The `/uploads` static server and `jetsonRoutes` both check for this and fall back to `express.static` / `fs.existsSync`.

### 7.7 `/uploads` Static Server (Authenticated)

Previously: `app.use('/uploads', express.static(...))` — zero authentication.

Now:
```
/uploads → requireAuth → validateScopeAccess → requirePermission('attendance.read')
         → uploadsDownloadLimiter → verifyPhotoAccess → express.static (local fallback)
         → S3 stream proxy (for post-migration photos)
```

`verifyPhotoAccess` confirms the filename belongs to the requesting tenant before any file access.

---

## 8. Metrics & Observability

### 8.1 Metrics Endpoints

| Endpoint | Auth | Port | Format |
|---|---|---|---|
| `GET /api/metrics` | Bearer token / IP allowlist | 8080 | JSON (system info) |

### 8.3 Health Endpoints

| Endpoint | Auth | Description |
|---|---|---|
| `GET /api/health` | Bearer / IP | Full health check: DB status + latency |
| `GET /api/health/live` | Bearer / IP | Liveness: is process responsive? |
| `GET /api/health/ready` | Bearer / IP | Readiness: DB + Redis reachable? |
## 9. Security Changes

### 9.1 Device Authentication (`authenticateDevice.js`) — FIX-005 / FIX-012

Previously, frame endpoints (`/api/frames/*`) and event endpoints were unauthenticated. Any caller could inject arbitrary face frames.

**Now:**
- All `/api/events/*` routes require a **device JWT** signed with `DEVICE_JWT_SECRET`.
- All `/api/frames/*` routes require the same device JWT.
- JWT validation: `jsonwebtoken.verify(token, DEVICE_JWT_SECRET)`.
- **Decommissioned device check:** Rejects tokens from devices with `decommissioned_at IS NOT NULL`.
- **JTI revocation check (FIX-012):** Checks `device_token_revocations` table — if the token's `jti` is revoked, returns 401. Gracefully skips the check if the table doesn't exist yet (pre-migration, returns warning log).
- **Tenant resolution:** Always re-reads `tenant_id` from `facility_device` table rather than trusting the baked-in token claim — protects against stale tokens after a device is moved between tenants.
- Sets `req.device = { id, code, tenant_id, type, jti }` for downstream use.

### 9.2 CORS Hardening (FIX-006)

- Wildcard `*` is blocked in production (`NODE_ENV=production`).
- Null origin requests that arrived via nginx reverse proxy (have `X-Forwarded-Proto`) are allowed.
- Multi-tenant dev: any `*.localhost` origin is allowed in non-production.
- `APP_URL` env var: subdomains of the configured app domain are allowed in non-production.

### 9.3 Photo Access Control (FIX-004)

- `GET /api/jetson/photos/:filename` — now requires: valid Keycloak/API JWT + `attendance.read` permission + tenant scope + `tenantOwnsPhoto()` cross-tenant check.
- `/uploads` static server — same protection chain as above, plus `verifyPhotoAccess` middleware.

### 9.4 Security Event Logger (FIX-015)

`securityEventLogger` middleware registered **after** all routes logs every 401 / 403 / 429 response to the `audit_log` table, including the authenticated user identity if available.

### 9.5 Body Parser Security

Different limits per route prefix to prevent memory exhaustion:

| Route prefix | Limit |
|---|---|
| `/api/auth`, `/api/live`, `/api/me`, `/api/users`, `/api/students` | 1 MB |
| `/api/enroll`, `/api/hrms`, `/api/events` | 10 MB |
| All others (catch-all) | 10 MB |
| Raw image (`image/*`) | 10 MB |

**Jetson JSON sanitization:** `/api/jetson` routes receive `express.text()` first, then a custom middleware replaces `:nan` → `:null` before parsing as JSON. Jetson C++ firmware emits IEEE NaN literals which are invalid JSON.

---

## 10. Configuration & Environment Variables

### 10.1 New Required Variables (Server Refuses to Boot Without These)

| Variable | Purpose |
|---|---|
| `DEVICE_JWT_SECRET` | Signs/verifies device JWTs (min 32 chars) |
| `ENROLLMENT_TOKEN_SECRET` | Signs enrollment invite tokens (min 32 chars) |
| `HRMS_WEBHOOK_API_KEY` | API key for HRMS integration webhooks |

### 10.2 New Optional Variables

| Variable | Default | Purpose |
|---|---|---|
| `REDIS_URL` | _(none)_ | Enables distributed rate limiting + WebSocket cross-process broadcast |
| `KAFKA_BROKERS` | `localhost:9092` | Comma-separated Kafka broker list |
| `KAFKA_CLIENT_ID` | `frs2-backend` | Kafka client identifier |
| `KAFKA_GROUP_ID` | `frs2-consumer-group` | Consumer group base ID |
| `KAFKA_TOPIC_PREFIX` | `frs.` | Prefix for all auto-generated topic names |
| `KAFKA_NUM_PARTITIONS` | `3` | Default partitions for auto-created topics |
| `KAFKA_REPLICATION_FACTOR` | `1` | Set to `3` in production |
| `KAFKA_SSL_ENABLED` | `false` (dev) / `true` (prod) | Enable Kafka TLS |
| `KAFKA_SASL_MECHANISM` | _(none)_ | `scram-sha-256` or `scram-sha-512` |
| `KAFKA_SASL_USERNAME` | _(none)_ | Kafka SASL username |
| `KAFKA_SASL_PASSWORD` | _(none)_ | Kafka SASL password |
| `KAFKA_CONSUMER_SESSION_TIMEOUT` | `30000` ms | Consumer session timeout |
| `KAFKA_CONSUMER_REBALANCE_TIMEOUT` | `60000` ms | Consumer rebalance timeout |
| `AWS_ACCESS_KEY_ID` | _(none)_ | AWS credentials for S3 |
| `AWS_SECRET_ACCESS_KEY` | _(none)_ | AWS credentials for S3 |
| `AWS_REGION` | `us-east-1` | AWS region |
| `AWS_S3_LOGS_BUCKET` | _(none)_ | S3 bucket for attendance photos (temporal) |
| `AWS_S3_USER_DATA_BUCKET` | _(none)_ | S3 bucket for enrollment photos (permanent) |
| `AWS_S3_ENDPOINT` | _(none)_ | MinIO/local S3-compatible endpoint |
| `HEALTH_AUTH_TOKEN` | _(none)_ | Bearer token for `/api/health*` |
| `HEALTH_IP_ALLOWLIST` | _(none)_ | Comma-separated IPs for `/api/health*` |
| `JETSON_WEBHOOK_SECRET` | _(none)_ | HMAC secret for enrollment webhooks |
| `JETSON_SIDECAR_URL` | `http://localhost:5000` | URL of Jetson embedding sidecar |
| `FACE_QUALITY_PORT` | `5050` | Port of local face quality service |
| `JETSON_MODEL_VERSION` | `arcface-r50-fp16` | Model version tag for new embeddings |
| `DB_PORT` | `5432` | Set to `6432` when using PgBouncer |
| `DB_POOL_MAX` | `20` | Max PG pool connections per process |
| `DB_KEEPALIVE` | `true` | TCP keepalive for long-idle connections |
| `BETA_TESTER_EMAILS` | _(empty)_ | Comma-separated emails for private beta features |

### 10.3 Variables in Current `.env` (Dev/Staging)

```env
PORT=8080
DB_HOST=localhost
DB_PORT=6432          # PgBouncer
DB_NAME=attendance_intelligence_07-07-26
DB_POOL_MAX=100
AUTH_MODE=keycloak
KAFKA_BROKERS=localhost:9092
KAFKA_GROUP_ID=frs2-consumer-group
REDIS_URL=redis://127.0.0.1:6379
AWS_S3_LOGS_BUCKET=motivity-frs-logs-dev
AWS_S3_USER_DATA_BUCKET=motivity-frs-user-dev
AWS_REGION=us-east-1
```

---

## 11. Database Changes

### 11.1 `event_dedup` Table (New)

Required for Kafka at-least-once idempotency:

```sql
CREATE TABLE event_dedup (
  event_uid UUID PRIMARY KEY,
  claimed_at TIMESTAMPTZ DEFAULT NOW()
);
```

> Add a TTL cleanup job (e.g., `DELETE FROM event_dedup WHERE claimed_at < NOW() - INTERVAL '7 days'`) to prevent unbounded growth.

### 11.2 `device_token_revocations` Table (FIX-012)

```sql
CREATE TABLE device_token_revocations (
  jti TEXT PRIMARY KEY,
  revoked_at TIMESTAMPTZ DEFAULT NOW(),
  device_id INTEGER REFERENCES facility_device(pk_device_id)
);
```

`authenticateDevice` checks this table. The revocation API is under `/api/device-tokens`.

### 11.3 PgBouncer (DB Connection Routing)

The `.env` now points to port `6432` (PgBouncer) instead of `5432` (Postgres directly). PgBouncer runs in transaction pooling mode, multiplexing up to 1000 app-side connections onto ~20 real Postgres connections, preventing connection exhaustion as worker count grows.

---

## 12. Deployment Steps

### 12.1 Prerequisites

1. **Kafka** broker running and reachable at `KAFKA_BROKERS`.
2. **Redis** running at `REDIS_URL` (required for distributed rate limiting).
3. **PostgreSQL** with `event_dedup` and `device_token_revocations` tables created.
4. **AWS S3** buckets created (`AWS_S3_LOGS_BUCKET`, `AWS_S3_USER_DATA_BUCKET`).
5. **PgBouncer** configured (if using `DB_PORT=6432`).

### 12.2 Environment Setup

```bash
# Copy template and populate all required values
cp .env.example .env

# Generate required secrets
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Use output for: DEVICE_JWT_SECRET, ENROLLMENT_TOKEN_SECRET, HRMS_WEBHOOK_API_KEY
```

### 12.3 Database Migration

```bash
# Run migrations in order
psql -d $DB_NAME -f src/db/migrations/001_init_schema.sql
psql -d $DB_NAME -f src/db/migrations/007_visitor_buffer.sql
# ... plus any new migrations

# Manually create event_dedup table
psql -d $DB_NAME -c "
  CREATE TABLE IF NOT EXISTS event_dedup (
    event_uid UUID PRIMARY KEY,
    claimed_at TIMESTAMPTZ DEFAULT NOW()
  );
"

# Manually create device_token_revocations if not already present
psql -d $DB_NAME -c "
  CREATE TABLE IF NOT EXISTS device_token_revocations (
    jti TEXT PRIMARY KEY,
    revoked_at TIMESTAMPTZ DEFAULT NOW(),
    device_id INTEGER
  );
"
```

### 12.4 Kafka Topic Setup

```bash
cd backend/api
node scripts/create-topics.js
```

Or manually via Kafka CLI:
```bash
kafka-topics.sh --bootstrap-server localhost:9092 --create \
  --topic frs.jetson-device-events --partitions 3 --replication-factor 1

kafka-topics.sh --bootstrap-server localhost:9092 --create \
  --topic frs.dead-letter --partitions 1 --replication-factor 1
```

### 12.5 PM2 Start Commands (Without ecosystem.config)

```bash
# API server
pm2 start src/server.js --name frs-backend

# Kafka consumer worker (exactly 1 instance)
pm2 start src/workers/deviceEventConsumer.js --name frs-device-event-consumer

# DLQ monitor (exactly 1 instance)
pm2 start src/workers/deadLetterMonitor.js --name frs-dead-letter-monitor

pm2 save
```

### 12.6 Verifying the Pipeline

```bash
# Watch consumer logs
pm2 logs frs-device-event-consumer

# Check consumer lag
curl -s http://127.0.0.1:9465/metrics | grep frs_kafka_consumer_lag

# Check DLQ arrivals
curl -s http://127.0.0.1:9466/metrics | grep frs_dead_letter

# Health check
curl -H "Authorization: Bearer $HEALTH_AUTH_TOKEN" \
     https://dev-frs.motivitylabs.com/api/health
```

---

## 13. Jetson Firmware Compatibility Notes

### 13.1 No Breaking Changes for Existing Firmware

The change from `200 → 202` and `"ok" → "queued"` is **fully backward-compatible** with existing Jetson firmware because:

> **The Jetson firmware team confirmed directly:** Jetson treats any `2xx` response as success and marks the event as sent. It does not check the numeric status code (200 vs 202) or parse the response body.

Existing firmware can continue operating without any changes.

### 13.2 New Firmware Capabilities (Optional Upgrades)

Existing firmware is unaffected. Optionally, new firmware can take advantage of:

| Feature | How | Benefit |
|---|---|---|
| Direct S3 photo upload | Call `POST /api/events/photo-upload-url` first, PUT photo to returned URL, send event with `photo_key` | Eliminates photo base64 encoding + API bandwidth |
| Native heartbeat events | Send `event_type: "device.heartbeat"` to `POST /api/events` | Unified pipeline; legacy `/api/jetson/:camId/heartbeat` still works |
| Batch drain | `POST /api/events/batch` with `events[]` array | Efficient offline queue upload |
| `event_id` tracking | Parse `event_id` from 202 response | Cross-reference with consumer logs for tracing |

### 13.3 Legacy Heartbeat Endpoint

`POST /api/jetson/:camId/heartbeat` is **preserved unchanged** for current firmware. It handles both nested (`{ metrics: { cpu_percent } }`) and flat (`{ cpu_percent }`) telemetry formats, and sanitizes Jetson's invalid `:nan` JSON literals.

### 13.4 Endpoint Continuity

All existing Jetson endpoints remain operational:

| Endpoint | Status | Notes |
|---|---|---|
| `POST /api/events` | ✅ Active | Now async via Kafka (202 response) |
| `POST /api/events/batch` | ✅ Active | Now async via Kafka (202 response) |
| `GET /api/events/commands` | ✅ Active | Unchanged |
| `POST /api/jetson/:camId/heartbeat` | ✅ Active | Unchanged, legacy compat |
| `GET /api/jetson/photos/:filename` | ✅ Active | Now authenticated |
| `GET /api/face/sync/*` | ✅ Active | Face sync pull (unchanged) |
| `POST /api/events/photo` | ✅ Active | Multipart photo upload (unchanged) |
| `POST /api/events/photo-upload-url` | 🆕 New | Direct-to-S3 presigned URL |

---

## 14. Key Files Changed / Created

| File | Change Type | Summary |
|---|---|---|
| `src/controllers/DeviceEventController.js` | Modified | Now publishes to Kafka instead of calling processEvent inline; returns 202 |
| `src/workers/deviceEventConsumer.js` | New | Standalone Kafka consumer worker with batch processing and idempotency |
| `src/workers/deadLetterMonitor.js` | New | Watches frs.dead-letter and logs ERROR |
| `src/config/env.js` | Modified | Added `aws`, Kafka SASL/SSL, Redis, `IS_PRIMARY_INSTANCE`-related env vars |
| `src/server.js` | Modified | `IS_PRIMARY_INSTANCE` guard, Kafka subscriptions, authenticated `/uploads` |
| `src/middleware/authenticateDevice.js` | Modified | JTI revocation check, decommission check, tenant resolution from DB |
| `src/routes/deviceEventsRoutes.js` | Modified | Added `photo-upload-url` endpoint, `deviceEventRateLimiter` |
| `src/services/business/DeviceEventService.js` | Modified | Added `resolveEventPhotoKey`, Option B `photo_key` verification |
