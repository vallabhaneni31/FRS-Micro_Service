# Maximizing Single-VM Throughput — FRS Platform
**FRS-ARCH-002 | v2.1 | 2026-08-03**

## 0. Scope and constraints

This is the definitive assessment for the current phase of work: **this single EC2 VM is the only
compute available — no additional VMs/EC2 instances, no horizontal scaling.** Every recommendation
below is a code change, a config file, a kernel parameter, or a process's own startup flags — things
that run on the box FRS is on right now. The output of executing this plan (a measured, sustained
RPS-at-acceptable-latency ceiling for this host) becomes the baseline input for the separate,
future horizontal-scaling phase toward the long-term 1M RPS goal (`docs/architecture/
RPS_1M_SCALING_ARCHITECTURE.md`, FRS-ARCH-001) — that phase is out of scope here and not discussed
further in this document.

**Kafka's process management is out of scope for this document.** Per direction, the Kafka
PM2→systemd migration is not to be re-proposed here. One factual note is still necessary for the
"current architecture" section to be honest, and is stated once, plainly, without re-litigating the
migration decision: **a `kafka.service` systemd unit already exists on this host, but it points at a
different, never-initialized install (`/opt/kafka`) and has been crash-looping — 42,757+ restart
attempts at the time of writing, roughly every 10 seconds, each burning ~2.2s of CPU before failing
with `No readable meta.properties files found`.** The broker actually carrying live traffic today is
still the PM2-managed process at `/home/ubuntu/kafka-install/kafka_2.13-4.3.1`. This matters here
only because it's real, currently-occurring CPU consumption on the exact box this document is trying
to get maximum throughput from — Section 2 counts it as a bottleneck on that basis alone.

As with every prior document in this series: analysis sections below were verified against the live
host and the codebase at time of writing; Section 5 (Roadmap) is now the live implementation tracker.

---

## 1. Current Architecture and Request Flow

### 1.1 Everything on this one box

8 vCPUs (Neoverse-N1/Graviton, confirmed instance type `c6g.2xlarge`), 15 GB RAM, no swap configured,
single 150 GB NVMe root volume (`ext4`, shared by both Postgres's data directory and Kafka's log
directory — no separate volumes, so both compete for the same disk I/O budget). Load average ~0.5 at
today's real traffic. All of the following run as separate OS processes with **no cgroup/priority
separation between them**:

| Process | Nature | Footprint (measured) |
|---|---|---|
| `frs-backend` ×2 (PM2 cluster) | Node/Express, the main API | ~192 MB each |
| `frs-device-event-consumer` | Node, Kafka consumer worker | ~149 MB |
| `kafka` (PM2-managed, the real broker) | JVM, Kafka 4.3.1 broker (KRaft) | ~1.3 GB, `-Xmx1G -Xms1G` |
| `kafka.service` (systemd, broken) | JVM, crash-loops every ~10s, never starts | ~2.2s CPU burned per failed attempt, indefinitely |
| `frs-retail-backend` | Node, separate vertical's API | ~82 MB |
| `face-quality-svc` | Python | ~135 MB |
| `mediamtx` | Go, RTSP media server | ~38 MB |
| `frontend-dev` | Vite **dev server** (nginx serves the static build directly, not this) | ~73 MB |
| `api-service`, `gateway-service` | Node — unrelated "ESurveillance" codebase | ~105 MB + ~81 MB |
| nginx | reverse proxy + static file server | — |
| Postgres 16 | DB, `attendance_intelligence_07-07-26` (confirmed via `.env` — a separate, stale `attendance_intelligence` DB also exists on this host, not the live one), `max_connections=100` | — |
| Redis | rate-limit store + Socket.IO adapter | — |
| Keycloak 26.6.0 | JVM, IdP — running via `kc.sh start-dev` | `-Xms64m -Xmx512m` |

### 1.2 Request path

```
Client → nginx (TLS terminate + static assets) → 127.0.0.1:8080 (frs-backend, PM2 cluster ×2)
       → correlationId → requestLogger → compression → cookieParser → helmet → CORS
       → body parser → globalRateLimiter (Redis round trip) → route
       → [if authenticated] requireAuth: JWT verify (Keycloak JWKS) + up to 7 sequential
         Postgres queries, no caching (authz.js) → handler
```

Device events: `authenticate → validate → publish to Kafka → 202`, processed asynchronously by
`frs-device-event-consumer`. Raw camera frames (`/api/frames/rtsp|smart/:cameraId`) bypass Kafka
entirely and queue in-process, in-memory (`shutdownManager.cameraQueues`) — bound to one process's
memory, the one high-volume path not yet decoupled the way device events are.

---

## 2. Current Performance Bottlenecks (ranked by impact, verified against the live host)

1. **`NODE_ENV=development` in the live `.env`** (`backend/api/.env:7`). Gates a real behavior in
   `authz.js:320-344`: when Keycloak auth fails, `requireAuth` **silently injects a synthetic
   super-admin session** instead of returning 401. Also disables the production security warnings
   already written into `env.js`, and routes every request log line through the dev-only
   `pino-pretty` formatter (§2a #17). **Status: intentionally held — see §5, this environment stays
   in development mode for now, per direction.**

2. **7 sequential, uncached Postgres round trips per authenticated request**
   (`authz.js` → `authenticateWithKeycloak`, `authService.js:191-252`): `findUserByKeycloakSub` →
   `getUserBySSOSub` → `getRbacPermissionsForUser`/`getMembershipsByUserId` → `isUserSuperAdmin` →
   `getUserScopes` → `getTenantById` → `featuresForTenant`. The relevant tables (`frs_user`,
   `user_role`, `rbac_role_permission`) **are properly indexed** (verified via `pg_indexes` —
   `idx_frs_user_keycloak_sub`, `idx_user_role_user_active`, `idx_rrp_role`/`idx_rrp_perm` all
   exist), so this is not a missing-index problem — it's a **round-trip-count problem**: 7 awaited,
   sequential network round trips (even at ~1-3ms each on loopback with pool-checkout overhead) add
   up to a real, avoidable tax on every authenticated request, and it's the single largest cost in
   the request path.

3. **Keycloak running in `start-dev` mode** (`kc.sh start-dev --import-realm`, confirmed via `ps
   aux`), `-Xmx512m`. Dev mode is explicitly not built for production concurrency; every login/token
   refresh pays for it.

4. **nginx has no upstream keep-alive to the Node backend.** Confirmed: no `upstream` block, no
   `keepalive N`, no `proxy_set_header Connection ""` in either `frs.conf` or `frs-locations.conf`.
   `keepalive_timeout 65` only governs client↔nginx. Every proxied request opens and tears down a
   fresh TCP connection to `127.0.0.1:8080`.

5. **Postgres on stock factory defaults**: `shared_buffers=128MB`, `work_mem=4MB`,
   `maintenance_work_mem=64MB`, `effective_cache_size=4GB`, `max_connections=100` (all confirmed via
   `SHOW`) — none reflect this host's real 15 GB or its actual query mix. Real, cheap, unrealized
   headroom.

6. **The crash-looping `kafka.service` systemd unit** (Section 0) — currently burning ~2.2s of CPU
   roughly every 10 seconds, indefinitely, for zero benefit, on this same box.

7. **PM2 cluster runs `frs-backend` at 2 instances** on an 8-vCPU host that also carries two JVMs
   (Kafka, Keycloak), Postgres, Redis, and several other resident processes — under-parallelized,
   but the correct target is not simply 8 (see §4.3).

8. **No connection pooling in front of Postgres.** `DB_POOL_MAX` defaults to 20/process. A local
   PgBouncer process (still just software on this same box) is the standard fix and becomes
   necessary the moment PM2 instance count rises.

9. **No general response/read cache.** Dashboard, employee directory, device-status, and
   tenant/feature-flag reads all hit Postgres directly on every call — compounding #2/#5 for
   read-heavy, infrequently-changing data.

10. **`bcryptjs` (pure JS, not the native `bcrypt` addon) blocks the main event loop** during
    password verification — real wall-clock time inside whichever PM2 worker's loop handles a login,
    unlike native `bcrypt` which offloads to libuv's thread pool.

11. **`UV_THREADPOOL_SIZE` unset (default 4) on an 8-core box** — under-provisions the thread pool
    backing `zlib` (used by the global `compression()` middleware), async `crypto`, `fs`, `dns`.

12. **A synchronous `console.log` on every authenticated request** (`authz.js:410`) — pure, free CPU
    waste with no upside.

13. **Redis `io-threads=1`** (confirmed via `CONFIG GET`) — single-threaded network I/O on an 8-core
    box under rate-limiter + (future) cache traffic.

14. **Raw camera frame ingestion bypasses Kafka**, unlike device events — bound to one process's
    memory, no backpressure/durability the way the Kafka-backed path has.

15. **Postgres and Kafka share one physical volume.** Both do meaningful sequential write I/O (WAL,
    log segments) on the same NVMe device with no separation — a real, if usually secondary,
    contention source under simultaneous heavy write load from both.

### 2a. Additional findings — full-codebase and full-host re-review

Two further end-to-end passes (code re-read plus live re-verification of nginx, Postgres, Kafka, and
the OS) turned up further items, none of which change the order-of-magnitude conclusions above, but
all of which are real and worth fixing:

16. **The CORS allowed-origin check compiles a fresh `RegExp` on every request.** `server.js`'s
    `cors({ origin: ... })` callback constructs `new RegExp(...)` from `APP_URL` inline, per request,
    even though `APP_URL` is constant for the process's lifetime. Should be hoisted to module load
    time.

17. **Every request log line is currently rendered through `pino-pretty`.** `utils/logger.js` gates a
    `transport: { target: 'pino-pretty' }` branch on `NODE_ENV !== 'production'` — and
    `NODE_ENV=development` is live (bottleneck #1). `pino-pretty` is explicitly documented upstream as
    unsuitable for production: a synchronous, colorizing formatter, not raw Pino's optimized async
    JSON path. This is a second, concrete mechanism behind bottleneck #1, not a new independent one —
    fixing `NODE_ENV` fixes this too.

18. **`emitAttendanceUpdate`/`emitPresenceUpdate` (`websocket/index.js`) run an uncached DB query per
    broadcast** to resolve employee name/department — the same "no caching" pattern as bottleneck #2,
    just in the WebSocket fan-out path instead of the HTTP auth path.

19. **Kafka's producer has no message compression configured** (`KafkaConfig.js`'s
    `getProducerConfig()` — `idempotent`/`acks`/`maxInFlightRequests` are set, `compression` is not).
    Given bottleneck #15 (shared disk with Postgres), this is a direct, currently-unclaimed way to
    reduce I/O on that shared volume.

20. **nginx: several small, confirmed-missing tunables**, re-verified line by line against the live
    config: `tcp_nopush` is still commented out (pairs with the already-enabled `sendfile`); there is
    no `open_file_cache` (static requests re-`stat()`/`open()` every time); `access_log` has no
    `buffer=`/`flush=` (unbuffered writes to the same disk Postgres/Kafka use); and Certbot's
    `options-ssl-nginx.conf` only sets protocols/ciphers — confirmed **no** `ssl_session_cache`/
    `ssl_session_tickets`, so TLS session reuse is genuinely absent, not just unverified.

21. **Postgres `max_wal_size` (1GB) and `wal_buffers` (4MB) are stock and unreviewed** — worth
    reviewing for the actual write volume (device/attendance/visitor events, audit log).

22. **`sharp`'s image-processing concurrency defaults to all detected cores**, uncapped — an
    enrollment-photo burst can spike CPU contention against Postgres/Node/Kafka on this shared box.
    `sharp.concurrency(N)` is a one-line cap.

23. **`facility_device.parent_device_id` has no index** (confirmed via `pg_indexes`) — used in the
    30s device-health-check cron's `UPDATE ... WHERE parent_device_id=$1` (`server.js`). Negligible
    today (14 rows in the table), but zero-cost to add now rather than after it's grown.

24. **PM2's `frs-backend` has no `max_memory_restart` set** (confirmed via `pm2 jlist`) — on a host
    with no swap and 15GB shared across two JVMs, Postgres, and Redis, a worker that leaks memory over
    time has no auto-recycle safety net. A stability item, not a throughput one.

**Checked and confirmed already correct — no action needed, listed so nothing looks unexamined:**
- Transparent Huge Pages: `[madvise]`, not `always` — `always` is the mode that causes Postgres/JVM
  latency spikes; `madvise` is the safe default already in effect.
- NVMe I/O scheduler: `[none]` — the recommended scheduler for NVMe; a software scheduler like
  `mq-deadline` only benefits rotational disks.
- Postgres `checkpoint_completion_target=0.9` — this is PostgreSQL 14+'s modern default, already
  correct, not something requiring manual tuning.
- Postgres `synchronous_commit=on` / `full_page_writes=on` — both correct as-is. **Deliberately not
  recommending `synchronous_commit=off`**: this system carries attendance/biometric audit data, and
  trading durability for RPS on compliance-relevant records is the wrong call here, despite the real
  throughput temptation.
- `attendance_record`/`attendance_ping` (well-indexed on employee+date) and `event_dedup.event_uid`
  (has its primary key, correctly backing the Kafka consumer's `ON CONFLICT` dedup claim) — checked,
  no gaps.
- **Socket.IO under PM2 cluster mode** — the classic sticky-session gotcha (a multi-request polling
  handshake landing across different cluster workers) doesn't apply today: the frontend's client sets
  `transports: ['websocket', 'polling']` with `websocket` tried first and no `tryAllTransports`, so
  the initial connection is a single WS upgrade, and reconnection attempts retry `websocket` first
  too. Re-verify once Phase 6 raises PM2 instance count from 2 to 4–5.

**Confirmed instance type (via instance metadata): `c6g.2xlarge`** (Graviton2, 8 vCPU — matches the
CPU model observed earlier), AWS-documented network performance **"up to 10 Gbps," burstable, not a
guaranteed sustained rate.** This replaces the earlier generic network-bandwidth estimate in
FRS-ARCH-001/FRS-ARCH-003 with a sourced, specific figure.

---

## 3. Current Maximum Sustainable RPS — Reasoned Estimate

No load test has been run yet (Section 6 defines how to get the real number; Section 5's Phase 0 is
where that number gets produced — treat everything below as the model to validate, not a substitute
for measuring it). The estimate, worked from what's actually configured:

- The authenticated-request path is gated by two things in series: the Postgres connection pool
  (`DB_POOL_MAX=20` × 2 `frs-backend` instances = **40 total pooled connections**), and the ~7
  sequential round trips each authenticated request holds a connection through. Even with the
  confirmed-present indexes keeping each individual query fast, 7 awaited round trips at realistic
  loopback + pool-checkout overhead (~1-3ms each) plus JWT verification put **total auth overhead
  per request in the ~10–25ms range**.
- By Little's Law (`throughput ≈ concurrency ÷ latency`), 40 pooled connections at ~15-20ms average
  hold time caps the auth-bound path at roughly **2,000 requests/sec from the DB-pool constraint
  alone** — before adding the real CPU cost of the rest of the middleware chain (compression, CORS,
  the Redis rate-limit round trip, JSON, business logic, WebSocket broadcast queries), which is
  where the actual ceiling likely lands lower, because only **2 cores** (2 PM2 instances) are
  available to do that CPU work at all.
- **Estimated current sustainable ceiling for the authenticated API surface: roughly 800–1,500 RPS**
  at an acceptable p95 latency, blended across typical dashboard/reporting traffic.
- Device-event ingestion (already decoupled via Kafka) has a materially higher ceiling on the
  ingest side — likely several thousand events/sec accepted — but end-to-end processing throughput
  is separately capped by the single-partition, single-sequential-consumer design in
  `deviceEventConsumer.js`, independent of ingest capacity.

**This range is what Phase 0 (Section 5) exists to confirm or correct** — it's built from real,
verified configuration values (pool size, index presence, instance count), not a guess, but it has
not been measured end-to-end under load until Phase 0 runs.

---

## 4. Optimizations Available on This Single VM

Every item below explains **why it's needed, what changes, the expected gain, and the trade-offs**.
Grouped exactly as requested: architectural, code-level, infrastructure, database, OS, runtime.

### 4.1 Architectural

**A1. Redis-backed auth/permission cache**
- *Why:* bottleneck #2 — 7 sequential DB round trips on every authenticated request, with zero reuse
  across requests from the same session.
- *What:* cache the resolved `{user, memberships, permissions, scope, mt}` bundle in Redis, keyed on
  JWT `sub`+`tenant_id`, short TTL (tens of seconds), invalidated on role/permission change if that
  matters for correctness in this app's admin flows.
- *Expected gain:* this is the single largest lever in the whole plan — collapses ~7 round trips to
  ~1 Redis `GET` (~0.2-0.5ms) for the large majority of requests (cache hits). Directly relieves the
  DB-pool constraint identified in Section 3.
- *Trade-offs/risks:* a stale cache window means a permission revoked mid-TTL stays effective for up
  to the TTL — needs an explicit invalidation path for admin actions that change roles/permissions
  if that staleness isn't acceptable. Adds Redis as a hard dependency for auth (already true for rate
  limiting; not a new failure mode, just a bigger one) — must fail closed (deny), not open, if Redis
  is unreachable.

**A2. General response/read cache for hot GET endpoints**
- *Why:* bottleneck #9 — dashboard, employee directory, device status, tenant/feature reads hit
  Postgres on every call even though this data changes infrequently relative to read volume.
- *What:* Redis-backed cache (or in-process LRU for the hottest, smallest data) for the identified
  hot read endpoints, with TTL or explicit invalidation on write. Also absorbs bottleneck #18 (the
  WS-broadcast employee/department lookup).
- *Expected gain:* meaningful reduction in Postgres query volume for read-heavy traffic, freeing DB
  capacity for the auth path and writes.
- *Trade-offs/risks:* cache invalidation correctness (the classic hard problem) — get the invalidation
  triggers wrong and staff see stale device status/employee data; start with short TTLs and
  explicit-invalidation-on-write rather than long TTLs, to bound the blast radius of a missed
  invalidation.

**A3. Move raw camera-frame ingestion onto Kafka**
- *Why:* bottleneck #14 — the one high-volume ingestion path not yet decoupled the way device events
  already are; bound to one process's memory today.
- *What:* apply the same pattern already proven in this codebase for device events
  (`backend/api/docs/backend_architecture_changes.md`) — authenticate/validate, publish, return
  fast, process asynchronously.
- *Expected gain:* removes a single-process memory ceiling on frame ingestion; makes this path
  resilient to a slow consumer the same way device events already are.
- *Trade-offs/risks:* real implementation effort (not a config change); needs the same
  idempotency/ordering care already built into `deviceEventConsumer.js`.

**A4. More Kafka partitions + more consumer processes, same box**
- *Why:* one partition caps `deviceEventConsumer` to one sequential worker regardless of core count.
- *What:* raise partition count for `frs.jetson-device-events` and run more than one consumer
  process in the group (still on this box).
- *Expected gain:* proportionally more consumer parallelism, up to the number of partitions/consumer
  processes added, bounded by remaining CPU headroom on this box.
- *Trade-offs/risks:* more partitions changes ordering guarantees (only order-within-partition is
  preserved) — must partition on a key (e.g. `tenant_id`) that keeps required ordering intact; more
  consumer processes means more concurrent DB writers, re-checking the dedup/claim logic still holds
  under higher concurrency.

### 4.2 Code-level

**C1. Parallelize independent auth DB lookups**
- *Why:* several of the 7 lookups in §2.2 don't depend on each other.
- *What:* `Promise.all` the independent calls instead of awaiting sequentially.
- *Expected gain:* reduces wall-clock latency on cache-miss requests by roughly the fraction of the
  7 calls that can run concurrently — a smaller win than A1 but free and complementary to it.
- *Trade-offs/risks:* verify none of the "independent" calls actually have a hidden ordering
  dependency before parallelizing.

**C2. Remove the hot-path `console.log`** (`authz.js:410`)
- *Why:* synchronous stdout write on every authenticated request; blocks the event loop, worse once
  stdout is a pipe under load.
- *What:* delete it (it's already labeled `[DEBUG]`).
- *Expected gain:* small per-request, but pure waste with zero offsetting benefit — free to remove.
- *Trade-offs/risks:* none.

**C3. Replace `bcryptjs` with native `bcrypt`, or move hashing to `worker_threads`**
- *Why:* bottleneck #10.
- *What:* swap the dependency (native `bcrypt` requires a build toolchain — verify this host/CI can
  compile native addons) or wrap the existing calls in a worker-thread pool.
- *Expected gain:* frees the event loop during password verification.
- *Trade-offs/risks:* native `bcrypt` adds a compiled-dependency maintenance burden; `worker_threads`
  avoids that but adds IPC overhead and complexity.

**C4. Batch the two RLS `SET LOCAL` statements in `withTenantContext`** (`db/pool.js:102-123`)
- *Why:* every tenant-scoped pooled-connection use issues two separate `SET LOCAL` round trips.
- *What:* combine into a single multi-statement call.
- *Expected gain:* removes one round trip per tenant-scoped DB operation.
- *Trade-offs/risks:* none functionally; verify `pg`'s handling of multi-statement `SET LOCAL`.

**C5. Use `KafkaProducer.sendBatch` instead of `sendEvent` on hot paths**
- *Why:* `sendEvent` sends one network round trip per message.
- *What:* audit call sites publishing in a loop or from a batch context and switch to `sendBatch`.
- *Expected gain:* fewer broker round trips for bursty publish patterns.
- *Trade-offs/risks:* none — switching to an existing, already-tested code path.

**C6. Hoist the CORS allowed-origin `RegExp` to module load time**
- *Why:* bottleneck #16.
- *Expected gain:* small, free — removes a per-request regex compilation.
- *Trade-offs/risks:* none.

**C7. Cache the WS-broadcast employee/department lookup**
- *Why:* bottleneck #18 — same pattern as A1, in `websocket/index.js`.
- *Expected gain:* removes a DB round trip from every attendance/presence broadcast, using the same
  Redis cache A1 introduces.
- *Trade-offs/risks:* same staleness-window consideration as A1/A2.

### 4.3 Infrastructure (nginx, PM2, process management)

**I1. nginx upstream keep-alive to the backend**
- *Why:* bottleneck #4.
- *What:* add an `upstream` block for `127.0.0.1:8080` with `keepalive N;`, set
  `proxy_set_header Connection "";`, keep `proxy_http_version 1.1`.
- *Expected gain:* removes a TCP connect/teardown cycle per proxied request.
- *Trade-offs/risks:* none — just needs a reload, not a restart.

**I2. nginx `worker_connections` / `worker_rlimit_nofile` tuning**
- *Why:* stock default (`1024`) never revisited.
- *What:* raise both to match this host's actual fd/connection budget.
- *Expected gain:* removes an artificial connection ceiling.
- *Trade-offs/risks:* none, provided the raised value stays under confirmed ulimit headroom.

**I3. Rightsize PM2 `frs-backend` instance count**
- *Why:* bottleneck #7 — 2 of 8 cores, but this box also runs both JVMs, Postgres, Redis, and other
  resident processes.
- *What:* raise instance count conservatively (e.g. to 4) and measure.
- *Expected gain:* roughly proportional increase in app-tier CPU parallelism.
- *Trade-offs/risks:* sequence after D1/D2/D4 (Postgres tuning + PgBouncer), or size `DB_POOL_MAX`
  down proportionally, so total stays within Postgres's `max_connections`.

**I4. Stop `frontend-dev` if confirmed unused**
- *Why:* nginx serves the static `frontend/dist` build directly.
- *What:* confirm nothing depends on it, then stop the PM2 process.
- *Expected gain:* frees ~73 MB RAM and whatever CPU it was consuming.
- *Trade-offs/risks:* confirm first.

**I5. Process-priority separation between critical and non-critical colocated work**
- *Why:* no cgroup/priority separation today.
- *What:* OS-level `nice`/`ionice` (or cgroup weighting) to bias scheduling toward FRS's own
  processes under contention.
- *Expected gain:* protects FRS's tail latency under a CPU spike in a lower-priority process.
- *Trade-offs/risks:* deprioritized processes get worse latency under contention.

**I6. nginx: `tcp_nopush`, `open_file_cache`, buffered `access_log`, TLS session cache**
- *Why:* bottleneck #20 — four small, independently-confirmed-missing nginx tunables.
- *Expected gain:* fewer syscalls per static request; less unbuffered disk I/O competing with
  Postgres/Kafka on the shared volume; faster TLS handshakes for repeat visitors.
- *Trade-offs/risks:* none of consequence — all standard, well-documented nginx settings.

**I7. Set PM2 `max_memory_restart` on `frs-backend`**
- *Why:* bottleneck #24 — no swap on this host, no auto-recycle safety net today.
- *Expected gain:* stability, not throughput — a leaking worker gets recycled before it threatens
  host-wide memory pressure.
- *Trade-offs/risks:* set generously enough that normal load doesn't trigger spurious restarts —
  verify against measured per-worker memory under load.

### 4.4 Database

**D1. Tune `shared_buffers` / `effective_cache_size` / `work_mem` / `maintenance_work_mem`**
- *Why:* bottleneck #5 — all confirmed stock defaults on a 15 GB host.
- *What:* raise incrementally, sized against what's actually left over after the JVMs/Node
  processes/Redis take their share of 15 GB.
- *Expected gain:* likely a real reduction in query latency for the exact lookups that dominate the
  auth path.
- *Trade-offs/risks:* over-allocating `shared_buffers` on a box this crowded risks starving the JVMs
  or triggering OOM (no swap) — raise incrementally and watch host-wide memory.

**D2. Add PgBouncer (transaction-mode pooling)**
- *Why:* bottleneck #8.
- *What:* run PgBouncer as a local process, transaction-pooling mode.
- *Expected gain:* decouples app-side pool size from Postgres's real connection ceiling.
- *Trade-offs/risks:* transaction-mode pooling doesn't support session-level features (e.g.
  `SET LOCAL`, prepared statements tied to a session) transparently — verify `withTenantContext`'s
  RLS pattern (C4) still works correctly through PgBouncer.
- ***Finding (Phase 4 investigation, 2026-08-04):*** this specific risk turned out to be moot on
  this host, for a more fundamental reason — see the finding box below. Resolved: transaction-mode
  pooling is safe here with respect to RLS/`SET LOCAL` specifically, since RLS isn't enforced at
  all today regardless of pooling mode. Prepared-statement/connection-affinity (D4) is a separate,
  still-real consideration handled by sequencing D4 before D2 below.

> **Finding — RLS policies are enabled but not enforced (pre-existing, not caused by this phase).**
> Investigating D2's own risk note above required checking whether `withTenantContext()`
> (`pool.js:102`, the one place the app sets the `app.current_tenant_id`/`app.bypass_rls` session
> GUCs the schema's `tenant_isolation_policy` RLS policies key on) actually works. Two independent
> findings, confirmed empirically:
> 1. `withTenantContext()` has **zero call sites** anywhere else in the codebase — dead code, never
>    invoked by any route or service today.
> 2. Even if it were called: it fires `SET LOCAL` with no surrounding `BEGIN`. Verified live against
>    this DB — Postgres returns `WARNING: SET LOCAL can only be used in transaction blocks` and the
>    setting does **not** carry to the next statement (confirmed by contrast against the same test
>    wrapped in an explicit `BEGIN`/`COMMIT`, where it does carry). So the helper wouldn't actually
>    propagate tenant context to the query that follows it, even if wired up.
> 3. Underlying both of the above: the app's only configured DB role is `postgres`, which carries
>    `Superuser` + explicit `Bypass RLS`. Postgres never applies RLS policies to a role with that
>    attribute, independent of GUCs or `SET LOCAL` correctness. So `tenant_isolation_policy` on
>    `hr_employee`, `attendance_record`, `frs_alert`, `facility_device`, etc. is enabled in the
>    schema but has never actually filtered a single row the app has read.
>
> Spot-checked the actual enforcement mechanism: `tenantRepository.js` and others do explicit
> `WHERE`/`JOIN` filtering on `tenant_id`/`mt_tenant_id` in raw SQL — that is what's actually
> protecting tenant isolation today, not RLS. Whether every repository query consistently does this
> is a separate, larger question (a full per-query audit), not something checked here.
>
> **Disposition (user-confirmed 2026-08-04):** out of scope for Phase 4 (a performance phase, not a
> security phase). Logged here as a known finding for a dedicated future security-focused pass, not
> actioned in this phase. Does not block D1/D2/D4/D5/D6.

**D3. Autovacuum tuning**
- *Why:* `facility_device` status/heartbeat columns are updated every 10-30s per device.
- *What:* review `pg_stat_user_tables` bloat/dead-tuple counts and tune per-table thresholds if found.
- *Expected gain:* prevents gradual query-latency regression over time.
- *Trade-offs/risks:* more aggressive autovacuum uses more background I/O — balance against
  bottleneck #15's disk contention.

**D4. Prepared statements for the hottest queries**
- *Why:* the `pg` driver doesn't use server-side prepared statements by default.
- *What:* use parameterized/prepared query forms for `findUserByKeycloakSub` and other hot
  auth-path queries.
- *Expected gain:* saves Postgres's query-planning step on repeat executions.
- *Trade-offs/risks:* through PgBouncer's transaction mode (D2), prepared statements need care —
  sequence and test alongside D2.

**D5. Review `max_wal_size` / `wal_buffers`**
- *Why:* bottleneck #21 — stock values, never reviewed against actual write volume.
- *Expected gain:* fewer/smoother checkpoints under write load.
- *Trade-offs/risks:* larger `max_wal_size` trades some crash-recovery replay time for fewer
  checkpoint I/O spikes — reasonable trade, size deliberately.

**D6. Add an index on `facility_device.parent_device_id`**
- *Why:* bottleneck #23 — confirmed missing, used in a 30s cron.
- *Expected gain:* negligible today at 14 rows; protects query latency as the table grows.
- *Trade-offs/risks:* none — standard `CREATE INDEX CONCURRENTLY` to avoid locking the table.

### 4.5 OS-level

**O1. sysctl review** — `net.core.somaxconn=4096` and `fs` limits already reasonable; revisit
`net.ipv4.ip_local_port_range` in combination with I1 once nginx↔backend keep-alive is in place.

**O2. No swap configured (`Swap: 0B`)** — do not add swap purely to mask memory-sizing risk; size
D1/I3 changes incrementally and watch host-wide memory instead.

**O3. Postgres and Kafka share one physical volume** (bottleneck #15) — if disk I/O shows up as a
contention point during benchmarking, attach a **separate EBS volume** for one of the two log/data
directories — storage, not compute, so it stays within the single-VM constraint.

**O4. CPU frequency scaling is not exposed to the guest OS on this instance type** — nothing to tune.

### 4.6 Runtime (Node.js / JVM)

**R1. `NODE_ENV=production`** — see bottleneck #1. **Held out of the active roadmap per direction —
see §5.**

**R2. `UV_THREADPOOL_SIZE` tuning** (e.g. 8-16 per worker)
- *Why:* bottleneck #11.
- *Expected gain:* modest, real improvement for concurrent compressed-response load specifically.
- *Trade-offs/risks:* too high a value adds context-switch overhead — needs measurement.

**R3. Node/V8 GC and heap flags**
- *Why:* not yet identified as a live problem, but worth profiling given host-wide memory pressure.
- *What:* profile with `clinic.js` or `--prof` before setting any flag.
- *Expected gain:* unknown until profiled; could be zero.
- *Trade-offs/risks:* wrong GC flags can make latency worse — measure first.

**R4. Keycloak: `start-dev` → `start --optimized`, enable caching, revisit heap**
- *Why:* bottleneck #3.
- *Expected gain:* meaningful improvement to login/token-refresh latency and concurrent-login
  throughput — isolated to auth-flow endpoints.
- *Trade-offs/risks:* `start` mode's stricter config validation can surface configuration gaps that
  `start-dev` silently tolerated — budget time for a realm/config review.

**R5. Redis `io-threads` increase**
- *Why:* bottleneck #13.
- *Expected gain:* better network-I/O throughput under concurrent rate-limit/cache traffic.
- *Trade-offs/risks:* diminishing/negative returns past a handful of threads — tune incrementally,
  verify with `redis-benchmark`.

**R6. Cap `sharp` concurrency**
- *Why:* bottleneck #22.
- *Expected gain:* prevents an enrollment-photo burst from spiking CPU contention.
- *Trade-offs/risks:* caps peak photo-processing throughput to protect the rest of the system.

---

## 5. Prioritized Implementation Roadmap — Live Tracker

This section is now the live implementation tracker, mirroring the phases on the artifact
(`FRS Single-VM Architecture — Current vs Target`). Status markers: **Pending / In Progress /
Completed**. Each phase's summary (changes made, expected impact, issues encountered) gets appended
here as it's executed.

### Phase 0 — Baseline Load Testing — **Status: Completed 2026-08-03**
Load-test this VM exactly as it stands today — no code or config changes yet — using a fixed,
reusable traffic mix, and record: RPS, Throughput, API Latency (P50/P95/P99), Error Rate, CPU
Utilization, Memory Utilization, Disk I/O, Network I/O, PostgreSQL metrics, Redis metrics, Kafka
metrics, PM2/Node.js metrics. Document bottlenecks actually observed. Every effect claimed in this
document is only meaningful relative to this baseline. **Full benchmarking methodology: Section 6.**

*Execution log:*
- **Scenario:** authenticated dashboard read (`GET /api/me/bootstrap`), the exact code path behind
  bottleneck #2's 7-sequential-query auth chain — a dedicated `loadtest-frs-arch002` Keycloak user
  was provisioned in the existing `motivity-qa` test realm (real token, real DB auto-provisioning,
  not the dev-bypass) specifically so this measures the real auth path, not a shortcut around it.
  Target: public domain (`https://dev-frs.motivitylabs.com`), per direction. Tool: `autocannon`,
  staged ramp (10→25→50→100→200→400 connections, 15-20s/stage).
- **Unplanned but necessary detour:** prep work surfaced a live bug — `rateLimit.js`'s `keyGenerator`
  was passing the whole `req` object to `ipKeyGenerator` instead of `req.ip` (introduced by a
  same-day commit, `ff2565268`, unrelated to this roadmap), bucketing **every client on the app
  under one shared `frs:rl:global:[object Object]` counter** capped at 300 req/10min *total*, not
  per-IP. This was live and affecting real traffic independent of this test. Fixed (3 occurrences,
  `req` → `req.ip`), verified via `redis-cli KEYS` showing a real per-IP key post-fix, deployed via
  `pm2 reload` (zero-downtime). The global limiter's cap was then **temporarily raised for the test
  window only** (a single-source-IP tool would otherwise measure its own 300/10min ceiling, not the
  backend's capacity) and **reverted immediately after**, confirmed via the live
  `RateLimit-Limit: 300` response header.
- **Results** (zero errors/timeouts at every stage — this found a real capacity ceiling, not a
  crash):

  | Connections | Avg RPS | P50 | P95 | P99 | Error rate |
  |---|---|---|---|---|---|
  | 10  | 490.0 | 19ms  | 32ms   | 37ms   | 0% |
  | 25  | 577.5 | 41ms  | 63ms   | 73ms   | 0% |
  | 50  | 593.0 | 81ms  | 119ms  | 138ms  | 0% |
  | 100 | 589.6 | 160ms | 244ms  | 302ms  | 0% |
  | 200 | 590.2 | 323ms | 489ms  | 1540ms | 0% |
  | 400 | 600.0 | 643ms | 3133ms | 3198ms | 0% |

  Throughput plateaus flat at **~590-600 RPS from 50 connections onward** — additional concurrency
  past that point doesn't buy more throughput, it just queues (P50 goes 19ms→643ms, P99 goes
  37ms→3198ms, as connections rise 10→400). That's the textbook signature of a real ceiling.
- **Host metrics during the heaviest stages:** both `frs-backend` PM2 workers pegged at **80-100%
  CPU each**; system-wide `load1` peaked at **12.3** (well above the 8 physical cores, evidence of
  queueing); `mem_avail` never dropped below **6.4 GB** (memory was never close to a constraint);
  Postgres `active_conns` peaked at **12** (nowhere near the 40-connection pool ceiling); Redis
  peaked at **~2,039 ops/sec** (comfortable headroom).
- **Correction to the Section 3 estimate:** the reasoned estimate predicted the DB connection pool
  (40 connections) as the binding constraint, projecting ~800-1,500 RPS. **The real measurement
  shows CPU saturation on the 2 PM2 instances as the actual binding constraint, at a lower ceiling
  (~590-600 RPS) than estimated** — Postgres was never close to its connection limit (12 of 40 used
  at peak). This is exactly why Phase 0 exists: static analysis had the right mechanism-in-general
  (too few PM2 instances, bottleneck #7) but the wrong dominant constraint. It sharpens, not
  weakens, the case for Phase 3 (auth cache, cuts CPU work per request) and Phase 6 (rightsizing
  PM2) — CPU-bound means both matter more than the original DB-pool-bound theory implied.
- **Kafka metrics:** not exercised by this scenario (dashboard read only, no device-event
  publish/consume in this pass) — deferred to a follow-up pass or folded into Phase 8 alongside the
  device-event/camera-frame scenarios.
- Raw results: `results.jsonl`, `metrics.csv`, `run_output.log` (session scratchpad — not committed
  to the repo; regenerate via `run_baseline.mjs` if needed for the Phase 8 comparison).

### Phase 1 — Kafka Process-Management Migration (PM2 → systemd) — **Status: Completed 2026-08-03**
Highest priority. Correct the existing broken `kafka.service` unit to point at the real install,
cut over from PM2 to systemd, verify no data loss, remove from PM2 permanently, enable on boot.

*Execution log:*
- Re-verified live state immediately before touching anything: real broker still PM2-managed
  (fork mode, script `bin/kafka-server-start.sh config/server.properties`), broken `kafka.service`
  unit still crash-looping (44,655 restarts by this point, still pointing at the never-formatted
  `/opt/kafka`) — nothing had changed since the original finding.
- Wrote a corrected unit (`WorkingDirectory`/`ExecStart`/`ExecStop` → the real install at
  `/home/ubuntu/kafka-install/kafka_2.13-4.3.1`, `Environment="KAFKA_HEAP_OPTS=-Xmx1G -Xms1G"`
  matching the process's actual running environment, `LimitNOFILE=1048576` matching its actual
  ulimit, `TimeoutStopSec=90` for clean shutdown, `After=network-online.target`). Validated with
  `systemd-analyze verify` before touching the live broker — no errors.
- Cutover: `systemctl stop kafka.service` (halts the crash loop) → installed the corrected unit →
  `daemon-reload` → `pm2 stop kafka` (confirmed port 9092 released) → `systemctl start kafka.service`.
  Both the client listener (`:9092`) and controller listener (`:9093`) came up within ~10 seconds.
- **No data loss:** `meta.properties` confirmed identical `cluster.id=NooRLaWERI22y7HfqmEb0Q` before
  and after — the existing KRaft log directory was reused, not reformatted. Broker logs showed
  `GroupCoordinator` loading existing consumer-offset records (e.g. 168 records for
  `__consumer_offsets-26`) rather than starting empty.
- **Consumers self-healed automatically**, no manual intervention: `frs-backend`'s and
  `frs-device-event-consumer`'s kafkajs clients logged `Consumer Stopped` → `Consumer Starting` →
  `Consumer has joined the group` within ~10-40 seconds for every consumer group
  (`device-events`, `ai-detections`, `attendance-ingest`, `jetson-device-events`), with partition
  assignments restored exactly as before (e.g. `frs.jetson-device-events: [0,1,2]`).
- Explicit produce/consume smoke test via `kafka-console-producer.sh`/`kafka-console-consumer.sh`
  against `frs.system-metrics` confirmed a clean round trip.
- `kafka` removed from PM2 (`pm2 delete kafka && pm2 save`) so it can't be resurrected by
  `pm2 resurrect` on reboot; `kafka.service` enabled (`systemctl enable`) for boot-time autostart
  independent of PM2 entirely.
- `infra/native-deploy/kafka_setup.sh` rewritten to match the real configuration end-to-end
  (Kafka 4.3.1, `/home/ubuntu/kafka-install`, `config/server.properties` not
  `config/kraft/server.properties`, the same corrected systemd unit, idempotent re-run safety via a
  `meta.properties` existence check) — the next environment stood up gets this right the first time
  instead of reproducing the orphaned-`/opt/kafka` crash loop this phase just fixed.
- **Known leftover, not cleaned up:** the orphaned, never-formatted `/opt/kafka` directory tree from
  the original broken setup attempt is still present on disk. It's inert (nothing references it
  anymore) — left as-is rather than deleting unprompted; flagging it here so it isn't mistaken for
  something intentional later.
- **Expected impact:** operational/reliability only, by design — no throughput change expected or
  observed. The broker now has correct OS-level supervision (auto-start on boot, standard
  restart/stop semantics) independent of PM2, and the crash-looping ghost unit's ~2.2s-per-10s CPU
  waste is eliminated.
- **Issues encountered:** none during the cutover itself — the only issues this phase surfaced were
  the pre-existing broken unit (root cause of this phase) and the unrelated rate-limiter bug found
  during Phase 0 prep (already fixed, documented there).

### Phase 1.5 — Kafka UI (Operational Tooling) — **Status: Completed 2026-08-03**
Inserted after Phase 1 rather than renumbering everything after it — this is an addendum to Phase 1's
Kafka work (monitoring/debugging tooling), not a throughput phase, and has no dependency on Phases
2-8, so it doesn't need to wait for them.

*Objective:* give the team a real console for topics, consumer groups, partitions, and message
inspection on the now-systemd-managed broker — evaluated in the prior session against AKHQ,
Confluent Control Center, Redpanda Console, and Kafdrop; `kafbat/kafka-ui` chosen (see
TARGET_ARCHITECTURE_SINGLE_VM.md §2.5 for the full comparison and reasoning).

*Why required:* no way to inspect `frs.jetson-device-events`/`frs.attendance-ingest`/
`frs.dead-letter` or consumer-group state today short of `kafka-console-consumer.sh` and manual
`journalctl` reading — real operational friction once Phase 6 starts adding partitions/consumers.

*Approach:* native install (executable JAR + its own systemd unit), matching Kafka's and Keycloak's
own pattern on this box — explicitly **not** Docker, even though it's available, to stay consistent
with how every other JVM service here is run. Bound to `127.0.0.1` only, proxied at `/kafka-ui/`
through nginx exactly like the existing `/auth/` block, authenticating via OIDC against the existing
Keycloak realm rather than a separate credential system.

*Expected outcome:* a working, authenticated, loopback-only Kafka UI reachable at
`https://dev-frs.motivitylabs.com/kafka-ui/`, showing this pipeline's real topics/consumer
groups/partitions. No throughput impact expected or claimed — this is observability, not a
performance change.

*Dependencies:* Phase 1 (the broker must already be systemd-managed) — satisfied.

*Execution log:*
- Downloaded `kafbat/kafka-ui` — the latest release (v1.5.0) turned out to require Java 25
  (`UnsupportedClassVersionError` against this host's Java 21, the same runtime Kafka/Keycloak use);
  stepped back to **v1.4.2**, confirmed clean startup on Java 21.0.11 with no other JDK installed.
- Registered a confidential OIDC client (`kafka-ui`) in the existing **`attendance`** Keycloak realm
  — the platform's main realm, since this is platform-level ops tooling, not tenant-specific.
  `directAccessGrantsEnabled: false` (browser authorization-code flow only, no password grant for
  this client). Added a protocol mapper flattening Keycloak's nested `realm_access.roles` into a
  top-level `roles` claim, since kafka-ui's RBAC expects a flat claim — verified this was necessary
  by checking the actual kafka-ui documentation source rather than assuming the config schema.
- RBAC configured to grant full access (topics, consumers, schema registry, connect, ksqlDB, ACLs)
  to holders of the existing `super_admin` realm role only — not open to every authenticated
  employee in the realm.
- `kafka-ui.service`: `java -Xmx384m -Xms256m -jar`, `User=ubuntu`, `Requires=kafka.service`, bound
  to `127.0.0.1:8090` — confirmed via `ss` binding only to loopback, matching Keycloak's pattern.
- nginx `location ^~ /kafka-ui/` added, mirroring the existing `/auth/` block exactly; config tested
  (`nginx -t`) before a graceful `reload` (not restart) — confirmed the existing site was unaffected
  (`200` on the homepage) immediately after.
- **Bug found and fixed during verification:** the app was generating `http://` (not `https://`)
  OAuth2 redirect URIs despite nginx correctly sending `X-Forwarded-Proto: https` — Spring Boot
  doesn't trust forwarded headers for URL construction unless explicitly told to. Fixed with
  `server.forward-headers-strategy: framework`; confirmed the generated `redirect_uri` matched the
  registered one exactly afterward.
- **Verified:** the full redirect chain (`/kafka-ui/` → app's OAuth2 endpoint → Keycloak's real
  authorization endpoint) completes with no errors, landing on Keycloak's actual login page for the
  `attendance` realm (`200`, correct client, correct redirect_uri) — this is the check that would
  have failed had the client registration or redirect URI been wrong.
- **Human verification completed 2026-08-03:** logged in via real browser through the temporary
  `kafkaui-verify-frs-arch002` account — confirmed the RBAC-gated dashboard shows the real `frs`
  cluster (1 broker, 62 partitions, 7 topics), real topic data (`frs.jetson-device-events` at
  92,885 messages / 2GB), and real consumer groups. **This surfaced a genuine operational finding
  in the process**: `frs2-consumer-group-dead-letter-monitor` showed 135 messages of lag with the
  consumer group in `EMPTY` state — worth investigating separately from this migration.
- **Access model decided:** a dedicated permanent named account, not shared SSO reuse or
  network-level restriction (both offered as options). Deleted the temporary
  `kafkaui-verify-frs-arch002` account and created **`kafka-ui-admin`** (`super_admin` role,
  `attendance` realm, permanent, not tied to a one-off verification purpose) via the same OIDC/RBAC
  flow already validated above — no config changes needed, only a different Keycloak user.
- **Credentials changed again per explicit direction, username → `kafkaadmin`, password →
  `Admin@123`.** Flagged clearly at the time: this is a widely-targeted default-credential pattern,
  and this account has `super_admin` access to Kafka topics carrying biometric/attendance PII at a
  public URL — the realm's brute-force lockout (5 failed attempts) is only a partial mitigation
  against a targeted guess. Proceeded per explicit, repeated instruction. Username changes turned
  out to be blocked realm-wide (`error-user-attribute-read-only` — a platform identity policy, not
  something touched for this one account), so the account was recreated rather than renamed: deleted
  `kafka-ui-admin`, created **`kafkaadmin`** with the requested password, same `super_admin` role.
  **Recommend revisiting this credential before this environment is anything other than a
  low-stakes dev box**, and consider layering the network-restriction option (nginx IP allowlist on
  `/kafka-ui/`) discussed earlier as a compensating control if the weak password stays.
- **Renamed again 2026-08-04, `kafkaadmin` → `admin`, password unchanged (`Admin@123`)**, per
  explicit direction after this same account became the shared login for Redis UI too (Phase 3.2).
  Same realm policy blocked a direct rename (`error-user-attribute-read-only`), so recreated again:
  deleted `kafkaadmin`, created **`admin`** with the same password and `super_admin` role. Verified
  the new account works via a direct Keycloak token-grant test (real `access_token` issued) before
  deleting the old one, then confirmed Kafka UI and Redis UI both still reachable afterward — safe
  because both gate access by the `super_admin` *role*, not by username, so the rename needed no
  config changes on either integration. `admin`/`Admin@123` is about as commonly-targeted a
  default-credential pair as exists; flagged again at the time, proceeded per explicit direction.
  Now the one shared login for both internal tools.
- Enabled on boot (`systemctl enable`).
- (populated as this phase executes)

### Phase 2 — Zero-Risk Configuration Fixes — **Status: Completed 2026-08-04**
I1, I2, I4, I6, C6, I7, I5. **R1 (`NODE_ENV=production`) is intentionally excluded — held per
direction, this environment stays in development mode for now.** It remains documented as
bottleneck #1/#17 because the mechanism is real, but it is not an active task until that decision
changes.

*Execution log:*
- **I4 correction (2026-08-04):** the original deferral reasoning was wrong. `frontend-dev`'s PM2
  `cwd` is `/home/ubuntu/ESurveillance/Frontend` — a separate, non-git project unrelated to this
  repo. The `CreateTenantWizard.tsx` in-progress change lives in FRS's own `frontend/`, which is
  served as a static build via nginx's `root` directive, not via any PM2 dev-server process; the two
  are unconnected. The only real tie is nginx's `location ^~ /video/` proxying to this process's
  port (5173). Checked every retained access log (52 days, 2026-06-13 → today): **zero requests to
  `/video/`, ever.** Stopped it (`pm2 stop frontend-dev && pm2 save`, so it won't resurrect on
  reboot). Verified clean: homepage `200`, API `401` (expected, unauthenticated), `/video/` now
  `502` (harmless — nothing was calling it), nginx error log shows only the one 502 from this
  verification check, no other client hit it. Not counted as an FRS Phase 2 deliverable — it was
  never an FRS bottleneck — but recorded here to correct the earlier note and because it freed RAM
  and one PM2 slot on this shared VM.
- **C6** (CORS regex hoist) and **I7** (PM2 `max_memory_restart=1G`) deployed together via
  `pm2 reload frs-backend` (zero-downtime, both cluster workers restarted with new PIDs, confirmed
  via `pm2 jlist`). Observed 16 `express-rate-limit: async error during store initialization`
  log lines immediately after — matches exactly 8 rate limiters × 2 workers, a known pre-existing
  Redis lazy-connect startup race already described in `rateLimit.js`'s own comments, not a
  regression from this change. Confirmed self-resolved: live rate-limit headers immediately after
  showed correct, accurate per-IP counting.
- **I1** (nginx upstream keepalive), **I2** (`worker_connections` 1024→4096,
  `worker_rlimit_nofile 65535`), **I4-equivalent HTTP/2** (added `http2 on;` to both TLS server
  blocks — confirmed live via `curl -w '%{http_version}'` returning `2`), and **I6** (`tcp_nopush`,
  `open_file_cache`, buffered `access_log`, `ssl_session_cache`/`ssl_session_tickets`) all applied
  in `/etc/nginx/nginx.conf` in one pass; backed up the live config first.
- **I5** (`limit_req`/`limit_conn` zones) added with one deliberate refinement beyond the original
  plan: **device/fleet paths (`/api/events`, `/api/jetson/`, `/api/face/sync`,
  `/api/device-management`, `/api/devices`) were carved out from the edge rate-limit zone entirely**,
  mirroring the app-level `globalRateLimiter`'s own existing exemption list exactly. An IP-keyed edge
  limiter would otherwise throttle an entire fleet of Jetson devices sharing one NAT/office IP — the
  same problem the app layer already solved by keying device throttling on device ID instead.
  `/api/auth/` gets a stricter zone (5r/s + burst=15); general `/api/` gets a generous one (50r/s +
  burst=100) meant to catch gross abuse, not fine-tune normal dashboard usage.
- Full config tested (`nginx -t`) before every reload; reloaded via `systemctl reload` (graceful,
  not a restart) each time.
- **Verified post-reload:** homepage `200`, HTTP/2 confirmed active, Keycloak and Kafka UI both
  unaffected, `/api/devices` reaches the backend correctly (`401`, not `404`/`502` — carve-out
  working), a 20-request burst against the general zone returned consistent `401`s with no false
  `503`s, nginx error log showed only clean reload messages.
- **Expected impact:** connection-overhead and static-asset-serving improvements should show up in
  Phase 8's final measurement; not independently re-benchmarked this phase (that's what Phase 8 is
  for) — Phase 2 was about landing the changes correctly and safely, not re-running the full load
  test after each one.

### Phase 3 — Caching Layer: Auth Cache & Response Cache — **Status: Completed 2026-08-04**
A1, C1, C2, C3, A2, C7.

*Execution log:*
- **C2** — removed the hot-path `console.log('[DEBUG req.auth.scope]...')` at the end of
  `requireAuth` (`authz.js:410`). Ran on every single authenticated request.
- **C1** — restructured `authenticateWithKeycloak` to run its independent DB lookups
  concurrently instead of sequentially: (a) `findUserByKeycloakSub` + `getUserBySSOSub` both key
  only on `jwtPayload.sub`, resolved via one `Promise.all`; (b) the legacy-membership lookup
  (keyed on the legacy user) and the new-model scope/tenant/feature resolution (keyed on the mt
  user) read disjoint tables and don't depend on each other, so they also run concurrently.
  Behavior-preserving — every conditional gate (deactivated-user check, provisioning fallback,
  RBAC-empty fallback, mt-user-missing default) kept exactly as before, just reordered for
  concurrency. Verified live post-deploy: homepage 200, auth-gated 401 as expected, zero errors.
- **A1** (the big lever) — added `services/authCache.js`: a Redis-backed cache for the
  DB-derived `{user, memberships, mt}` bundle `authenticateWithKeycloak` resolves, keyed on JWT
  `sub`+`tenant_id`, 30s TTL. JWT signature/expiry verification itself is **never** cached — it
  runs fresh every request (the real security check); only the DB-derived data is cached, so a
  Redis outage or any cache error always falls through to the real DB lookup (fail-closed by
  construction — a cache failure can only ever cost latency, never grant access the DB wouldn't).
  Wired explicit invalidation (`invalidateAuthCacheBySub`, clears every cached tenant-variant for
  a user) into the three clearest permission-changing write paths: role grant/revoke
  (`rbacRoutes.js` `POST /users/:userId/roles` and `DELETE /user-roles/:userRoleId`) and account
  activate/deactivate (`UserService.js`). Other, lower-frequency role/membership-touching paths
  (tenant provisioning, `multitenant.js`, etc.) were **not** individually wired — they rely on the
  30s TTL bound instead of explicit invalidation; noted here rather than silently claimed as
  covered. Verified: isolated round-trip test (miss → set → hit → tenant-scoped independence →
  invalidation clears all tenant variants) all passed against the live Redis instance; confirmed
  the same benign Redis lazy-connect startup race already known from Phase 2 (first call before
  `status === 'ready'` safely no-ops rather than erroring); confirmed real cache entries appear
  under live traffic post-deploy.
- **C3** — swapped `bcryptjs` → native `bcrypt` (`bcrypt@6.0.0`) across all 7 call sites
  (`authService.js`, `UserService.js`, `AppAdminService.js`, `TenantAdminService.js`,
  `DeviceManagementService.js`, `authRoutes.js`, `mfaRoutes.js`). Investigation first: this host
  runs `AUTH_MODE=keycloak`, so bcrypt is **not** on the hot per-request path — Keycloak JWT
  verification is. bcrypt only runs at login (legacy API-mode fallback), password change/reset,
  MFA verify, and device-secret provisioning — real but much lower-frequency than originally
  scoped. Verified compile toolchain present (gcc/g++/make/python3) before swapping; verified
  hash-format cross-compatibility in isolation before touching any app code (bcryptjs-hash ↔
  native-bcrypt-compare and vice versa, plus wrong-password correctly rejected) — critical since
  existing user `password_hash` values in the DB were generated by bcryptjs and must still verify
  post-swap. Confirmed native bcrypt loads correctly in the actual project `node_modules`; other
  PM2 processes (`frs-retail-backend`, separate `node_modules`) unaffected.
- **C7** — `websocket/index.js`'s `emitAttendanceUpdate` re-queried Postgres for
  employee/department display info on *every* attendance check-in/check-out broadcast. Added
  `services/cache.js` (a small shared Redis cache helper, same connection pattern as
  `authCache.js`/`rateLimit.js`) and wrapped the lookup in a 5-minute-TTL cache keyed on
  employeeId — safe because this only feeds a live notification's display name, not an
  authorization decision. Both call sites in `emitAttendanceUpdate` (the `payload.record` path and
  the `payload.employeeId` fallback path) now share the same cache entry per employee. This code
  is also imported by the separate `frs-device-event-consumer` PM2 process (via
  `DeviceEventService.js`) — reloaded that process too so it picks up the change, not just
  `frs-backend`.
- **A2** — investigation found this was **already substantially implemented**: `middleware/
  apiCache.js` (in-process, per-worker in-memory cache, 15s default TTL, scope+user-keyed) was
  already applied to `/live/employees`, `/live/devices`, `/live/alerts`, `/live/metrics`, `/live/
  calendar`, `/live/dept-shift-analytics`, `/live/activity/hourly`, with invalidation already
  wired via `purgeApiCache('/live')` in `AttendanceController.js`/`DeviceEventController.js` on
  writes. Two things were actually done here: (1) removed leftover RCA debug instrumentation on
  `/live/attendance` — three extra middleware layers doing synchronous `console.log` on every
  request (scope, headers, cache-key, hit/miss, query results) plus a duplicate inline
  `buildCacheKey` — same class of problem as C2, just more elaborate; the route now matches the
  same clean `cacheApi(15000)` pattern as its siblings. (2) Extended `cacheApi(15000)` to the two
  next-hottest uncached endpoints identified from real nginx access logs (`/api/site-management/
  sites` — 2 correlated subqueries per row — and `/api/devices/edge-devices`), matching the exact
  existing convention (order: `cacheApi` before `requirePermission`, safe because the cache key
  already includes `user.id` — a cache hit can only ever replay a response that already passed
  that same user's permission check). Confirmed `/api/me/bootstrap` — by far the single hottest
  endpoint in the access logs (67,060 hits vs. ~2,200 for the next-busiest) — needed no separate
  caching: its handler does no DB work of its own, it only reads `req.auth` already resolved by
  `requireAuth`, so it's already fully covered by A1+C1.
- All changes deployed via `pm2 reload` (zero-downtime); `frs-device-event-consumer` reloaded
  separately for the C7 change. Verified after every deploy: homepage 200, auth-gated 401,
  `node --check` clean pre-deploy, no crashes/`MODULE_NOT_FOUND`/500s in logs post-deploy. Real
  live traffic confirmed populating both new Redis cache namespaces (`frs:authcache:*`,
  `frs:cache:*`) post-deploy.

### Phase 3.1 — Redis Admin UI — **Status: Completed 2026-08-04**
Phase 3 turned Redis into a genuinely multi-purpose dependency — not just a single-use cache —
so an admin UI to inspect it earned its own sub-phase rather than being a footnote.

*What Redis is actually used for on this host (confirmed by codebase grep, not assumed):*
| Concern | File | Pattern |
|---|---|---|
| Rate limiting | `middleware/rateLimit.js` | 8 limiters, TTL'd counters, prefix `frs:rl:*` |
| Auth cache (Phase 3 A1) | `services/authCache.js` | Short-TTL key/value, `frs:authcache:*` |
| General response/lookup cache (Phase 3 A2/C7) | `services/cache.js` | Short-TTL key/value, `frs:cache:*` |
| WebSocket cross-process fan-out | `websocket/server.js`, `redisEmitter.js` | Socket.IO redis-adapter — **pub/sub**, not key/value |

Redis itself: 7.0.15, loopback-only (`127.0.0.1:6379`), no auth on the connection string.

*Options considered (user-requested comparison — RedisInsight, Redis Commander, Medis):*
- **Medis — ruled out.** Desktop Electron app; Medis 2 is closed-source/commercial and the
  open-source Medis 1 has been unmaintained since ~2020. This is a headless remote host — a
  desktop tool means either exposing Redis's port directly or an SSH tunnel per session, a worse
  security posture than the web-UI-behind-nginx pattern already proven with Kafka UI (Phase 1.5).
- **Redis Commander — passed over.** Functional but thin: key browse/edit and basic monitoring
  only. No pub/sub inspection, no memory analysis, no slowlog, no CLI. Given a real pub/sub
  concern now exists (Socket.IO adapter across `frs-backend`'s two workers and
  `frs-device-event-consumer`) plus four overlapping key namespaces to keep straight, this would
  leave a real blind spot. Maintenance has also been inconsistent historically.
- **RedisInsight — chosen.** Official Redis Inc. tool, actively maintained, ships as a web app
  (Docker or standalone) rather than desktop-only — matches the exact deployment shape already
  working for Kafka UI on this host. Covers what Commander lacks: pub/sub monitoring, per-key
  TTL/memory inspection, slowlog, and a CLI for ad-hoc debugging.

*Implementation — native install, no Docker (explicit user direction, mirroring Kafka UI):*
- **Node version constraint found and resolved.** RedisInsight's `package.json` requires
  `node >=24.x` (`.nvmrc` pins `24.16.0`); this host's system Node (what PM2/`frs-backend` use) is
  22.22.3. Installed an isolated Node 24.16.0 at `/home/ubuntu/redisinsight-install/runtime/node24`
  — official nodejs.org tarball, not nvm (user chose this over nvm to avoid unnecessary shell-profile
  integration a systemd service doesn't need) — completely separate from the system Node; zero
  effect on `frs-backend` or any other PM2 process.
- **Built from source, verified before permanent install.** RedisInsight has no non-Docker,
  non-Electron distribution — reverse-engineered the real recipe from the project's own
  `Dockerfile` (its build stage is genuinely just `npm ci` → `build:ui` → `build:statics` →
  `build:api` → `npm ci --omit=dev`, then `node dist/src/main.js`; Docker only supplies the base
  image and networking, not any Docker-specific runtime behavior). Ran the full recipe once in a
  scratch directory first to confirm it actually works on Node 24/this host's architecture
  (aarch64) before touching anything permanent — real server, real UI (confirmed title "Redis
  Insight", version 3.8.0), `/api/docs` Swagger reachable, process stable. Only then repeated the
  same recipe in the permanent location. ~2.9GB on disk (mostly `node_modules`), ~2.5 min build
  time, memory stayed workable throughout (host has 15GB, dipped to ~1.5GB free at peak).
- **`RI_PROXY_PATH=redis-ui`** — confirmed RedisInsight natively handles being served under a URL
  prefix (verified: root path 404s, `/redis-ui/` serves correctly) — cleaner than any nginx
  rewrite trick, and avoids the kind of path-prefix issues that needed workarounds for other tools.
- **Install layout**, mirroring Kafka UI's `/home/ubuntu/kafka-ui-install/` convention exactly:
  `/home/ubuntu/redisinsight-install/{app/ (built source), runtime/node24/ (isolated Node),
  data/ (RI_APP_FOLDER_ABSOLUTE_PATH — SQLite config/connection store), redisinsight.env}`.
- **systemd unit** (`/etc/systemd/system/redisinsight.service`) — same shape as `kafka-ui.service`:
  `Type=simple`, `User=ubuntu`, `EnvironmentFile`, `Restart=on-failure`, `ExecStart` pointing
  directly at the isolated Node 24 binary running `main.js`. Enabled on boot.
  `RI_APP_HOST=127.0.0.1` (loopback-only, same as Kafka UI) on port 5540.
- **Edge auth: nginx basic auth** (user's choice over IP allowlist or both) — RedisInsight has no
  built-in auth outside Electron desktop mode. Generated a random 20-char password (not a
  memorable/default one — no realm-level lockout exists here the way Keycloak had for Kafka UI, so
  a guessable credential carries more per-attempt risk), hashed with `openssl passwd -apr1` into
  `/etc/nginx/.redisinsight-htpasswd` (mode 640, `root:ubuntu` — matches nginx's actual worker
  user, confirmed from `nginx.conf`'s `user ubuntu;` directive, not the more common `www-data`
  default that would have silently failed permission checks here).
- **nginx** — added `location ^~ /redis-ui/` to `frs-locations.conf`, mirroring `/kafka-ui/`'s
  proxy directives exactly, plus `auth_basic`/`auth_basic_user_file`. Backed up config before
  editing (established pattern); `nginx -t` passed before reload.
- **Verified end-to-end post-deploy:** homepage 200 and Kafka UI 302 both unaffected; `/redis-ui/`
  without credentials → 401; with credentials → 200, serving the real app through the full chain
  (nginx basic auth → proxy → systemd-managed RedisInsight → its own proxy-path handling).
- **Not automated:** adding the actual Redis connection (`127.0.0.1:6379`, no auth) inside
  RedisInsight itself — a one-time, ~10-second manual step, left for human verification the same
  way Kafka UI's final login/verification was done by hand, not scripted.
- **Human verification done 2026-08-04:** connected, confirmed real live data — an `frs:authcache:*`
  entry (TTL counting down from 30s, matching A1's design) and two `frs:rl:*` rate-limit counters.
  `frs:cache:*` (C7's employee-display cache) and pub/sub activity weren't visible at that moment —
  expected, not a gap: the former only populates on an actual attendance check-in/check-out
  broadcast and has a 5-minute TTL, the latter is transient and only observable live in the
  Pub/Sub tab while an event fires, not browsable after the fact.

### Phase 3.2 — Redis UI: Keycloak SSO (replacing basic auth) — **Status: Completed 2026-08-04**
User's request: Kafka UI uses Keycloak SSO, Redis UI used nginx basic auth — inconsistent, and the
user wanted one login experience across every internal tool, same credentials, no separate
Redis UI account to maintain.

*Why this couldn't just mirror Kafka UI directly — verified, not assumed:* checked RedisInsight's
actual source (already built and installed for Phase 3.1). It has no `passport`/`oidc`/`openid`
dependency anywhere, and the only "SSO"-shaped code in it (`modules/cloud/auth/`, Google/GitHub/
SSO strategies) is for RedisInsight authenticating *outbound* to Redis Cloud's API — completely
unrelated to gating its own login. Kafka UI could do OIDC natively because it's Spring Boot with
Spring Security's OAuth2 client built in; RedisInsight (NestJS) has no equivalent. This was already
flagged as an open risk in Phase 3.1's own execution log before RedisInsight was deployed.

*Solution: OAuth2 Proxy in front of RedisInsight* — a purpose-built reverse-proxy auth layer for
exactly this situation (app has no SSO, needs to sit behind one anyway).
- **Keycloak client registered** (`redis-ui`, `attendance` realm) via the Admin REST API, mirroring
  `kafka-ui`'s client structure: confidential client, `standardFlowEnabled`, redirect URI
  `https://dev-frs.motivitylabs.com/redis-ui/oauth2/callback`, same `realm-roles-flat` protocol
  mapper (`oidc-usermodel-realm-role-mapper` → flattened `roles` claim) added for consistency,
  though oauth2-proxy's `keycloak-oidc` provider type reads Keycloak's native `realm_access.roles`
  directly and doesn't strictly need it.
- **oauth2-proxy v7.15.3** — native binary (Go, statically linked; no build step needed, unlike
  RedisInsight), no Docker, matching the user's explicit direction. Installed at
  `/home/ubuntu/oauth2-proxy-install/`. Config: `provider = "keycloak-oidc"`,
  `allowed_roles = ["super_admin"]` (matches Kafka UI's RBAC gating exactly — same population of
  users can reach both tools), `code_challenge_method = "S256"` (PKCE), loopback-only
  (`127.0.0.1:4180`), `proxy_prefix = "/redis-ui/oauth2"` so its own login/callback paths live
  under the same URL prefix as the app instead of colliding with a bare `/oauth2/` at the domain
  root.
- Tested the full config against the live Keycloak instance in the foreground before touching
  anything permanent (same discipline as the RedisInsight build): confirmed OIDC discovery
  succeeds, confirmed an unauthenticated request produces a real `302` to Keycloak's actual
  `/auth/realms/attendance/protocol/openid-connect/auth` endpoint with the correct `client_id`,
  `redirect_uri`, and PKCE challenge — not a mocked/assumed response.
- One config key (`trusted_proxy_ip`) turned out not to be supported in this binary's legacy TOML
  config format despite matching the CLI flag name — dropped rather than forced; acceptable because
  this port is loopback-only and unreachable except through nginx anyway, so the header-spoofing
  risk that flag guards against is already closed off by network topology.
- **systemd unit** (`oauth2-proxy.service`), same shape as the other native services on this host:
  `Type=simple`, `User=ubuntu`, `Restart=on-failure`, `After=keycloak.service redisinsight.service`.
  Enabled on boot.
- **nginx**: replaced the `/redis-ui/` location's `auth_basic`/`auth_basic_user_file` directives
  with a single `proxy_pass http://127.0.0.1:4180/redis-ui/` — oauth2-proxy handles both its own
  paths and, once authenticated, forwarding through to RedisInsight itself, so nginx only needs the
  one block. Backed up config before editing; `nginx -t` passed before reload.
- **Verified end-to-end post-deploy:** homepage 200, Kafka UI 302, both unaffected by the nginx
  change. `/redis-ui/` unauthenticated → real `302` to Keycloak (not a stub) with the correct
  client/redirect/PKCE parameters. The old basic-auth credentials (`redisadmin`/`Admin@123`, set
  moments earlier per the user's request, now superseded) confirmed to have zero effect anymore —
  the `-u` flag is simply ignored since `auth_basic` no longer exists on this route.
- Removed `/etc/nginx/.redisinsight-htpasswd` — no longer referenced by any location block.
- **Not automated, left for human verification:** logging in through the real browser flow to
  confirm a `super_admin`-role account reaches RedisInsight successfully post-login, and that a
  non-`super_admin` account is correctly denied. Same pattern as every other "final login check"
  in this document — done by hand, not scripted.

### Phase 4 — Database Layer Tuning — **Status: Completed 2026-08-04**
D1, D2, D4, D5, D6.

*Execution log:*
- **D6** — added `idx_facility_device_parent_device_id` via `CREATE INDEX CONCURRENTLY` (no table
  lock) on the live DB; also committed as migration `014_facility_device_parent_index.sql` (plain
  `CREATE INDEX IF NOT EXISTS`, matching the repo's existing migration style) so fresh environments
  get it too. Confirmed the column is read on the device-auth path, the 30s device-offline cron,
  and face-sync/device-management lookups — all previously doing a full 14-row seq scan, harmless
  at today's device count but now correct going forward.
- **D1 + D5** — bundled into one Postgres restart (both `shared_buffers` and `wal_buffers` are
  `PGC_POSTMASTER`-context, restart-only, not reloadable): `shared_buffers` 128MB → 1GB, `work_mem`
  (unset/4MB default) → 8MB, `maintenance_work_mem` (unset/64MB default) → 256MB, `wal_buffers`
  (auto) → 16MB explicit, `max_wal_size` 1GB → 2GB. Sized conservatively against actual headroom,
  not the usual "25% of RAM" rule — this host also runs Kafka (Xmx1G), Keycloak (Xmx512m), and
  Kafka UI (Xmx384m) JVMs with no swap, so oversizing risks starving them. `effective_cache_size`
  left at its already-reasonable 4GB. Confirmed the timing with the user before restarting (a real,
  if brief, DB outage) — restart completed in under a second per the Postgres log's own
  shutdown/ready timestamps; verified all 5 settings live via `SHOW`, homepage/API healthy
  afterward, host memory stable, no new errors traceable to the restart itself (see the map_x/
  tenant_id finding below — real errors were present but pre-existing, confirmed via log history
  back to at least 2026-08-02).
- **D4** — added optional named-prepared-statement support to `query()` in `pool.js` (`name` param;
  when passed, delegates to `pool.query({text, values, name})` so `pg` PREPAREs once per physical
  connection and Bind+Executes on reuse, skipping Postgres's planning step on repeat calls). Applied
  to the 7 fixed-SQL-text queries in the `authenticateWithKeycloak` hot path (the exact lookups A1's
  cache misses fall through to): `findUserByKeycloakSub`, `getMembershipsByUserId`,
  `getRbacPermissionsForUser` (`authRepository.js`), `getTenantById`, `getUserBySSOSub`,
  `isUserSuperAdmin`, `featuresForTenant` (`multitenant.js`). Deliberately **not** applied to
  `getUserScopes` — it builds different SQL text depending on whether `tenantId` is passed, and a
  prepared-statement name reused across different text is a hard Postgres error, not a silent
  fallback; left as parameterized-but-unnamed (already safe/correct). Verified mechanism directly
  with the live `pg` version before and after deploy (see D2 below — this turned out to matter more
  than expected). Deployed via zero-downtime `pm2 reload frs-backend`.
- **D2** — investigating this item's own documented risk ("verify RLS still works through
  PgBouncer") surfaced that **PgBouncer was already installed, configured, running, and enabled on
  boot** — `/etc/pgbouncer/pgbouncer.ini` last modified 2026-07-21, predating this phase and never
  reflected in this roadmap. The app's live `.env` (`DB_PORT=6432`, vs. `.env.example`'s documented
  `5432`) already routes both `frs-backend` and `frs-device-event-consumer` through it in
  `pool_mode = transaction`. Not something done in this phase — discovered, not built.
  - Confirmed this pre-existing setup already solves the connection-ceiling risk D2 was meant to
    address: `DB_POOL_MAX=100` per PM2 worker × 2 workers = a theoretical 200 app-side connections
    against Postgres's `max_connections=100` — a real latent risk if the app connected directly —
    but PgBouncer's `default_pool_size=20` caps real backend connections well under the ceiling
    regardless of app-side pool sizing.
  - **Found and fixed a real gap**: `max_prepared_statements` was unset (0, disabled) in
    `pgbouncer.ini` — meaning the D4 named prepared statements just deployed were running through a
    transaction pooler with no cross-backend prepared-statement handling. No errors had surfaced
    yet, but that was luck (low connection churn at current load), not correctness — Postgres
    prepared statements are physical-connection-scoped, and transaction pooling doesn't guarantee
    the same backend serves repeat uses of a name. PgBouncer 1.21+ ("the one with prepared
    statements") added exactly this feature; this host runs 1.22.0. Set
    `max_prepared_statements = 100` (PgBouncer's own recommended starting value).
  - **Self-inflicted, disclosed in full**: the first edit put the explanatory comment on the same
    line as the value (`max_prepared_statements = 100    # comment`) — unlike `postgresql.conf`,
    PgBouncer's INI parser doesn't support trailing same-line comments, so the whole string was read
    as the value. `systemctl restart pgbouncer` then failed to start (`invalid value ... for
    parameter max_prepared_statements`), leaving PgBouncer down for **~28 seconds**
    (10:35:10–10:35:38 UTC) — a real gap during which live device traffic hit `ECONNREFUSED` on
    `authenticateDevice`, `deviceOfflineCron`, and `visitor-validation` (confirmed in
    `frs-backend`'s own logs, not swept under the rug). Fixed by moving the comment to its own
    `;;`-prefixed line above the setting (matching the file's existing comment style) and
    restarting again, which succeeded immediately. Root cause was pgbouncer.ini's stricter format,
    not the underlying config decision.
  - Verified the fix, not just the recovery: 30 concurrent queries using the same named prepared
    statement, fired through a 5-connection pool against the live port-6432 endpoint (forcing
    backend churn), all 30 succeeded with zero "prepared statement does not exist" errors.
  - Backed up `/etc/pgbouncer/pgbouncer.ini` before editing, per this doc's established practice
    for every live system-file change.
  - Not touched, out of scope: the plaintext DB password in `pgbouncer.ini`'s `[databases]` line —
    matches the same value already live in `.env`, not a new incremental exposure; `.env.example`
    still documents direct-port-5432 as the template default and wasn't updated, since not every
    environment (e.g. local dev) will run PgBouncer.
- **Also found during this phase (not part of D1/D2/D4/D5/D6, logged for visibility):**
  - The RLS-bypass finding — see the finding box under D2 above in §4.4.
  - A pre-existing, frequently-hit bug: a `facility_device` lookup selects `map_x, map_y,
    map_angle` (columns that don't exist — only `model` does) and a `frs_site` timezone lookup
    filters on `tenant_id` (column doesn't exist on that table). Confirmed via Postgres logs this
    has been erroring continuously since at least 2026-08-02 (39,000+ occurrences in the current
    log file alone, growing to 74,874 by the time of the fix below), on a per-device-request hot
    path. Pre-existing, unrelated to this phase's changes.
    - **Fixed 2026-08-04, as part of Phase 4 stabilization before moving to Phase 5** (user's
      explicit call: confirm the current phase is solid before advancing, given a real incident had
      just occurred in this exact area and this bug was still actively firing). Root cause was
      narrower than first described: `facility_device` genuinely has no map-position columns —
      those live on `frs_camera`, correctly joined and used elsewhere
      (`facilityDeviceRepository.js`, `DeviceHierarchyController.js`). The bug was two specific
      queries in `websocket/index.js` (`broadcastDeviceChange`, `broadcastSingleDevice`) that
      mistakenly selected camera-table columns from `facility_device` directly. Because both were
      wrapped in a silent `try/catch`, the real-world impact was worse than "missing map data" —
      the entire query failed, meaning these two WebSocket broadcasts (fired on every device
      create/update via `DeviceHierarchyController`, and on every device event via
      `DeviceEventService`) have been silently no-ops the whole time; live dashboard device-status
      pushes never reached connected clients through this path. Fix: dropped the three
      non-existent columns from both `SELECT`s (confirmed via `information_schema.columns` neither
      query's downstream code — `emitDeviceUpdate`, `broadcastDeviceStatus` — ever referenced
      `map_x`/`mapX` by name, so nothing consumed the field that would need updating).
    - The `frs_site.tenant_id` lookup (`liveRepository.js`'s `getSiteTimezone`, tenantId-only
      branch) was fixed the same way `siteRoutes.js` and `deviceManagementRepository.js` already
      correctly handle this: `frs_site` has no direct tenant column, join through `frs_customer`
      (`s.fk_customer_id = c.pk_customer_id`, filter on `c.fk_tenant_id`). Verified both corrected
      queries directly against the live DB with real data before deploying.
    - Deployed via `pm2 reload frs-backend` + `frs-device-event-consumer` (the latter also imports
      `websocket/index.js` via `DeviceEventService.js`, same as the Phase 3 C7 fix). Verified
      clean: zero new `map_x`/`tenant_id` errors in the Postgres log in the 2+ minutes after both
      workers were fully online (one straggler error at the reload boundary was an in-flight
      request against the outgoing worker during PM2's graceful handoff — expected, not a
      regression). No new errors of any other kind introduced.
    - Also confirmed as part of this stabilization pass: zero prepared-statement errors and zero
      PgBouncer errors/warnings in the ~19 minutes since the D2 incident's fix took effect —
      the D4/PgBouncer prepared-statement mechanism held up under continued real traffic, not just
      the original 30-query synthetic test.

### Phase 5 — Keycloak Production Mode — **Status: Completed 2026-08-04**
R4.

*Execution log:*
- **Baseline confirmed:** `kc.sh start-dev --import-realm`, `-Xms64m -Xmx512m` (bottleneck #3).
  `--import-realm` turned out to be a harmless no-op — it reads from `data/import/`, which doesn't
  exist on this host, so every prior restart already ran on pure Postgres-backed state with nothing
  to (re-)import. This mattered: it meant switching modes carried no risk of a stale JSON file
  clobbering the live realm (new OIDC clients, the renamed `admin` account, etc.) on restart.
- **`kc.sh build`** run first — genuinely non-disruptive, confirmed live: it only reads
  `keycloak.conf` and persists a compiled config to disk, doesn't touch the running dev-mode
  process at all (verified: same PID, same uptime, live traffic unaffected immediately after).
  `db=postgres` picked up correctly as a build-time option; `hostname`/`http-enabled`/
  `proxy-headers`/`http-port` correctly deferred to runtime (already set in `keycloak.conf` from
  earlier work — no gaps to fill in).
- **Verified `start --optimized` in isolation before touching the live service** — same discipline
  as RedisInsight/oauth2-proxy: ran it side-by-side on alternate ports (`--http-port=9091`) against
  the *same* live Postgres-backed realm data, while the real dev-mode instance kept serving traffic
  on 9090. Hit one real snag along the way: Keycloak's management interface (health/metrics, port
  9000) turned out to already be bound by the running dev-mode instance too — dev mode isn't
  exempt from it, contrary to assumption — so the side-by-side test needed
  `--http-management-port=9001` as well. Once resolved: booted cleanly in ~3.7s
  (`Profile prod activated`), and critically, a real token-grant login with the actual
  `admin`/`Admin@123` account (created earlier via the Admin API against the dev-mode instance)
  succeeded through this separate production-mode process — definitive proof both instances share
  the same underlying state correctly, not a guess. Health endpoint confirmed `UP` on all three
  checks. Stopped cleanly; live instance confirmed unaffected throughout.
- **Heap ("revisit heap" per R4):** traced the `512MB` default to `kc.sh`'s own fallback (only
  applies outside containers; `JAVA_OPTS_KC_HEAP` overrides it cleanly). Given this host's real
  memory pressure right now — several other active dev-tooling processes running concurrently,
  ~3GB free at decision time — chose a modest bump, `768MB`, not an aggressive one; reflects
  production mode's added Infinispan/JGroups overhead without gambling on a memory-constrained
  host.
- **Confirmed restart timing with the user before cutover** — same standing practice as the Phase 4
  Postgres restart: this identity provider now gates every login across the main app, Kafka UI,
  and Redis UI, so a restart's brief interruption window needed an explicit go-ahead, not just a
  green light from isolated testing.
- **systemd unit updated**: `ExecStart` → `kc.sh start --optimized` (dropped `--import-realm` —
  confirmed unnecessary above), added `Environment="JAVA_OPTS_KC_HEAP=-Xms256m -Xmx768m"` (quoted —
  systemd's `Environment=` requires quoting when the value contains a space, unlike a shell
  assignment). Backed up the old unit first.
- **Verified end-to-end post-cutover:** homepage 200, Kafka UI 302, Redis UI 302 (all three
  unaffected); real login through the actual public HTTPS domain with the `admin` account
  succeeded; the FRS backend's own JWKS endpoint (what every app request's JWT verification
  depends on) reachable and correct; health checks `UP`. Zero WARN/ERROR lines in the journal for
  the entire startup — confirms the config was already production-ready before this phase (no
  gaps the stricter `start` validation needed to surface, unlike the risk this item's own
  trade-offs note anticipated). One class of error observed in `frs-backend` logs after the
  restart (`"exp" claim timestamp check failed`) is a pre-existing, unrelated expired-JWT retry
  loop from some client — confirmed identical before this change too, not a regression.

### Hotfix — 2026-08-04: real login-blocking 429s, root-caused and fixed live
Not part of any planned phase — found while the user was testing login post-Phase-5 and reported
real `429 Too Many Requests` errors on `/api/auth/workspace/validate`, breaking the login page
entirely for a real user.

*Root cause, traced from the actual browser network trace, not guessed:*
- The 429 carried full Express-set security headers (CSP, `Access-Control-Allow-Credentials`),
  ruling out nginx's edge `limit_req` (Phase 2, I5) as the source — nginx would return a bare
  error page. Traced instead to `globalRateLimiter` (300 requests / 10 minutes per IP), an
  **app-level** limiter in `server.js`, pre-existing and separate from anything touched in Phases
  2-5.
- Chrome DevTools' "Remote Address" field showed `54.208.4.206` — a red herring; that field always
  shows the *server's* address, not the client's. The real client IP, confirmed via nginx access
  logs, was `182.76.136.42` — the same IP used all session for dashboard browsing and pgAdmin.
- Counted actual traffic from that IP in a live 10-minute window: **546 requests**, nearly double
  the 300 ceiling. Breakdown by path revealed the dominant contributor: **182 requests to
  `/api/jetson/photos/:filename`** — over half the entire budget from one endpoint.
- That endpoint is authenticated, human-facing (dashboard photo-thumbnail loading), and already has
  its own well-designed limiter (`photoDownloadLimiter` in `jetsonRoutes.js`, 600/min, keyed by
  authenticated user ID) — with a code comment *already anticipating this exact failure mode*:
  shared-NAT-IP staff usage exhausting a shared per-IP counter. The bug: `globalRateLimiter` runs
  earlier in the middleware chain, before `requireAuth` resolves user identity, so it blindly
  IP-keyed this traffic anyway and undermined the smarter limiter downstream — real device/photo
  traffic sharing this NAT IP was exhausting a human user's login budget.
- Also found, same file: `/api/jetson/:camId/heartbeat` (device-authenticated) wasn't covered by
  the existing `/api/cameras/.../heartbeat` regex exemption either — different path, same gap.

*Fix:* added `/api/jetson/` as a prefix exemption to `isDeviceIngestPath()` in `server.js`,
mirroring nginx's existing edge-layer `/api/jetson/` carve-out from Phase 2 so both layers agree.
Deployed via `pm2 reload frs-backend` (zero-downtime).

*Verified, not assumed:* confirmed via direct Redis counter checks that 5 repeated hits to
`/api/jetson/photos/*` no longer increment `frs:rl:global:*` (counter stayed flat), while a normal
non-exempt request still correctly increments it (sanity check the limiter itself wasn't broken).
`workspace/validate` confirmed returning clean `200`s afterward; no new 429s on that endpoint in
nginx logs since the fix deployed. Homepage and `/api/health` unaffected.

*Not fixed here, worth a look during Phase 7 (Rate-Limiting Refinement):* the underlying pattern —
a raw per-IP limiter running before authentication resolves, on a host serving a genuinely shared
office/NAT egress IP — is a general risk, not just this one endpoint. This fix closes the specific
gap that broke real logins today; a broader look at whether `globalRateLimiter` should key
differently for authenticated vs. anonymous traffic is separate, larger work.

### Phase 6 — App-Tier & Kafka Scale-Out (within this VM) — **Status: Completed 2026-08-04**
I3 (re-verify Socket.IO reconnection once instance count rises), R2, R5, A4, K1 (Kafka producer
compression), A3, R6, I5, D3, O3 (only if disk contention shows up in benchmarking).

*Execution log:*
- **I3 — Rightsized PM2 from 2 to 3 instances**, both `frs-backend` and `frs-device-event-consumer`
  (the latter matching Kafka's existing 3-partition layout so every consumer gets exactly one
  partition — no idle consumer, no partition served by two instances). Deliberately stopped at 3,
  not the roadmap's original 4–5 range: confirmed live via `free -h` this host runs substantial
  non-FRS tooling concurrently (other agent/IDE sessions), and going straight to the top of the
  range risked real memory pressure without first confirming 3 was insufficient. Presented as an
  explicit choice, user confirmed "Go to 3 instances." Deployed via `pm2 scale` (zero-downtime).
  Verified post-scale: Socket.IO redis-adapter attached cleanly on the new instances (cross-checked
  against each new instance's own `pm_uptime` to disambiguate reused log-file paths), PgBouncer
  transaction-mode pooling absorbed the extra app-side connections without growing real backend
  connections (`pg_stat_activity` checked), Kafka rebalanced 3 partitions across 3 consumers evenly
  with no duplicate processing (`event_dedup` claim counts matched message counts exactly).
- **K1 — Enabled Kafka producer GZIP compression.** Added `CompressionTypes.GZIP` to all three
  `producer.send()` call sites in `KafkaProducer.js` (`sendEvent`, `sendBatch`,
  `routeToDeadLetter`) — no extra codec dependency needed, GZIP ships with kafkajs. Reduces network
  I/O for the JSON detection/device-event payloads without adding a new package to audit. Verified
  live: producer connects and sends without error, consumer (`deviceEventConsumer.js`) decodes
  transparently (kafkajs handles decompression automatically, no consumer-side change needed),
  confirmed on real Jetson device-event traffic post-deploy.
- **A4 — Scaled `frs-device-event-consumer` to 3 instances**, matching the topic's existing 3
  partitions (see I3 above — same deploy, one combined verification pass). Confirmed even
  partition-to-consumer assignment and zero duplicate event processing via the batch-level
  `event_dedup` claim counts.
- **A3 — Investigated, found already addressed; no code change made.** The roadmap's original
  framing (raw camera-frame ingestion bound to one process's memory, needing a Kafka migration)
  doesn't match this codebase's actual current shape: `/api/attendance/frame` only ever stored a
  URL string with existing async support; `/api/events`'s legacy `photo_base64` path already flows
  through the same Kafka pipeline just scaled up in A4; modern firmware bypasses the API tier
  entirely via presigned S3 uploads; the one remaining synchronous path
  (`/api/face/recognize`) receives a pre-computed embedding from the device, not raw frame bytes —
  a fundamentally lighter operation than what A3 was written to describe. Presented via
  AskUserQuestion after investigating device-side expectations first (user's chosen order); user
  selected "Mark A3 as already addressed" over forcing a speculative async conversion with no
  matching problem to solve.
- **R6 — Capped `sharp` concurrency to 2** (`sharp.concurrency(2)`) in both `server.js` and
  `deviceEventConsumer.js` — sharp/libvips runs its own internal thread pool independent of
  Node's `UV_THREADPOOL_SIZE`, and left uncapped it defaults to using all available cores. With
  6 total Node processes now colocated on 8 cores (3× frs-backend, 3× frs-device-event-consumer,
  both doing image work), an uncapped per-process pool risked oversubscription under concurrent
  load. Capped modestly rather than to 1, to preserve some intra-process parallelism for
  multi-image batches.
- **R5 — Investigated, deferred; no change made.** Phase 0's baseline showed Redis peaking at
  ~2,039 ops/sec — nowhere near where Redis's single I/O thread becomes a real bottleneck (Redis
  routinely handles 100k+ ops/sec single-threaded). Enabling `io-threads` now would add OS-thread
  overhead on an already resource-constrained host for a problem with no current evidence.
  Documented here rather than implemented speculatively — same bar applied to R2, I5, O3 below.
- **R2 — Investigated, deferred; no change made.** Its original rationale (concurrent
  compressed-response load saturating Node's libuv threadpool) is substantially weakened now that
  this same phase's Phase 7 work removed Express's `compression()` — that code path no longer runs
  through the threadpool at all. `sharp` uses its own separate pool (capped independently via R6
  above), and `bcrypt` (native, since Phase 3's C3) is confirmed off the hot request path. Without
  profiling evidence of actual threadpool saturation from the remaining fs/crypto/DNS work, raising
  `UV_THREADPOOL_SIZE` speculatively wouldn't be evidence-based. Deferred pending real profiling
  data, not changed.
- **I5 — Investigated, deferred; no change made.** Checked live: every FRS process (3×
  frs-backend, 3× frs-device-event-consumer) plus Postgres, Kafka, and Keycloak all currently run
  at default `nice=0` / `ionice none:prio 0` — confirming no priority separation exists today,
  matching the roadmap's own baseline description. Two things argued against implementing it now:
  (1) PM2 has no native mechanism to set process niceness, so doing this properly (surviving
  `pm2 restart`/`reload`, not just a one-off `renice` that silently stops applying at the next
  restart) means wrapping the PM2 ecosystem config's own exec invocation — a change to the live
  process manager's startup behavior; (2) unlike I3/K1/A4, which fixed a measured, present
  bottleneck, I5 is explicitly preventative for *future* resource contention — live `uptime` showed
  load average 0.39/0.60/0.66 on 8 cores at the time of this check, i.e. no active contention to
  fix. Deferred with the same evidence bar as R5/R2, not implemented speculatively.
- **D3 — Checked `pg_stat_user_tables` for real bloat; no change warranted.** Every table's
  dead-tuple percentage sits under the default autovacuum trigger (20% of live rows + 50), and
  autovacuum is actively running and keeping pace on every table checked (confirmed via recent
  `last_autovacuum` timestamps — e.g. `facility_device` had run 1,266 times, most recently minutes
  before this check, holding dead tuples to 28 despite 678K cumulative updates on a 14-row table).
  Also checked HOT-update ratios as a deeper signal: `person`, `device_events` (the largest table
  at 1.3GB), and `visitor_buffer` all show near-0% HOT updates, which looked concerning until
  cross-checked against each table's actual indexes — in every case the frequent updates touch a
  column that's genuinely indexed for a real query path (`person.updated_at` for audit ordering,
  `device_events.fk_person_id`/`occurred_at` for visitor-to-identity linking, `visitor_buffer.status`
  for the partial pending-visitor index), which structurally prevents HOT regardless of fillfactor
  — confirmed by contrast with `facility_device`, whose heartbeat-style updates touch no indexed
  column and hit 99.8% HOT. Lowering fillfactor would provide no benefit here (HOT requires zero
  indexed-column changes, not just free page space), and dropping those indexes to enable HOT
  would trade away real query performance for a write-path gain nothing currently shows is needed.
  No change applied.
- **O3 — Checked live disk I/O; deferred, no change made.** `iostat -x` over three 2-second
  samples showed `nvme0n1` at 0.6–1.1% `%util` with near-zero `%iowait` — no contention evidence
  at all. Consistent with the roadmap's own conditional framing ("only if disk contention shows up
  in benchmarking") and, like R5, deferred pending Phase 8's actual load test rather than tuned
  against a problem with no current signal.

### Phase 7 — Rate-Limiting Refinement — **Status: Completed 2026-08-04**
Confirm Phase 2's `limit_req`/`limit_conn` zones tuned per route class; implement Redis Lua
sliding-window limiter for login/account limiters; remove Express `compression()`, let nginx own it.

*Execution log:*
- **Confirmed Phase 2's nginx zones need no changes.** Checked the error log for every
  `limit_req`/`limit_conn` rejection ever recorded on this host: zero. `frs_general` (50r/s,
  burst=100) and `frs_auth` (5r/s, burst=15) have never falsely rejected real traffic — confirms
  today's earlier hotfix incident was purely app-level (`globalRateLimiter`), not this edge layer.
- **Removed Express `compression()`.** Confirmed nginx already covers this: `gzip_proxied any;`
  plus `application/json` in `gzip_types` (both already present in `frs-locations.conf`, at file
  scope so they apply to every proxied `/api/*` location, not just static assets) means nginx was
  already fully equipped to compress every response leaving this host — Express's own compression
  was pure duplicate CPU work on the exact process Phase 0 already identified as the binding
  constraint on throughput. Removed the import, the `app.use(compression())` call, and the now-dead
  `compression` dependency from `package.json` (ran `npm install` to keep `package-lock.json`
  consistent, not just hand-edit it). Verified no SSE/streaming responses exist that might have
  depended on unbuffered output. Confirmed post-deploy: a real large asset request returns
  `content-encoding: gzip` from nginx exactly as before — same end-user experience, one fewer
  compression pass per request.
- **Implemented the Redis Lua sliding-window limiter**, scoped to just the two brute-force-
  sensitive limiters (`authRateLimiter`, `accountLoginLimiter`) — not every limiter in the file,
  since the others aren't guarding a brute-forceable secret the same way and the simpler
  fixed-window approach remains the right tool for them. Three Lua scripts (`slidingWindowCheck`
  — atomic check-and-increment; `slidingWindowPeek` — check without incrementing;
  `slidingWindowRecord` — increment only), registered via `ioredis`'s `defineCommand` on the
  existing shared Redis connection in this file (no new connection). Two middleware factories:
  `makeSlidingWindowLimiter` (every request counts — used for `authRateLimiter`) and
  `makeSlidingWindowLimiterSkipSuccessful` (peek-then-conditionally-record — used for
  `accountLoginLimiter`, preserving its existing "only failed logins count" behavior exactly).
  Both fail CLOSED on any Redis/script error, matching this file's existing policy for these two
  limiters. Manual `RateLimit-*` response headers added since `express-rate-limit` no longer
  produces them for these two.
  - *Verified thoroughly before deploying, in two stages:* (1) the raw Lua algorithm directly
    against live Redis with synthetic timestamps — confirmed fill-to-limit, over-limit denial,
    full-window reset, and correct partial sliding (old entries age out independently of recent
    ones, not a hard reset at a window boundary); (2) the actual exported middleware functions via
    mock req/res objects against live Redis — confirmed `authRateLimiter` allows exactly 10 and
    denies the 11th, and critically confirmed `accountLoginLimiter`'s skip-successful-requests
    behavior survived the rewrite: 3 simulated successful logins left the budget untouched (still
    8/8), while 4 simulated failed logins correctly consumed 4 of the 8.
  - Also discovered while tracing the live route: `authRateLimiter`'s two original mount points
    (`POST /login`, `POST /refresh` in `authRoutes.js`) are wrapped in
    `if (env.authMode !== "keycloak")` — dead on this Keycloak-mode host. It's still genuinely live
    via `POST /api/auth/mfa/verify` (`mfaRoutes.js`, unconditional), confirmed via a real request
    against that endpoint showing the new sliding-window headers (`RateLimit-Limit: 10`,
    `RateLimit-Remaining: 9`, `RateLimit-Reset: 300`) live in production, not just in the isolated
    test.
- **Revisited `globalRateLimiter`'s per-IP keying**, prompted directly by the same-day hotfix
  (546 requests/10min observed from one real, legitimately-shared office/NAT IP). Real per-user
  keying — mirroring `photoDownloadLimiter`'s pattern — isn't possible without restructuring where
  this limiter runs relative to `requireAuth` in the pipeline (it currently runs first, before any
  identity is known); judged that as a real pipeline change deserving its own dedicated design/test
  pass, not something to bolt on same-day alongside everything else already touched. Instead: raised
  the ceiling 300 → 600 requests/10min, sized to match the precedent already set elsewhere in this
  same file for the identical "many legitimate things share one identity" problem
  (`photoDownloadLimiter`: 600/min per user; `deviceIngestLimiter`: 300/min per device) — not an
  arbitrary number. Still a real ceiling (≈1 req/s sustained, well below what a genuine single-actor
  abuse pattern would need) — just no longer tuned for a single-user-per-IP assumption this host
  doesn't match. The deeper fix (key by authenticated user once identity is known) is explicitly
  documented in the code as deferred, not silently dropped.
- **Verified all four changes together, live:** homepage 200, Kafka UI 302, Redis UI 302 all
  unaffected; `globalRateLimiter`'s new `600;w=600` policy visible in live response headers;
  `workspace/validate` still clean; gzip still active on real asset responses; zero new
  errors in `frs-backend` logs (the one error line found — a WebSocket auth rejection for a
  naturally expired JWT on a real user's session — is unrelated to any change made here).
  Deployed via `pm2 reload frs-backend` throughout (zero-downtime).

### Phase 8 — Final Optimized Load Testing — **Status: Completed 2026-08-05**
Re-run Phase 0's exact scenarios against the fully optimized architecture; collect the identical
metric set; populate the Baseline-vs-Final results table; update §3/§8 with real measured numbers.

*Execution log:*
- **Methodology deviation, found and resolved before the real run:** the original plan was to
  reuse Phase 0's exact test unmodified (same tool, same scenario, same target — the public
  domain). First attempt did that and got a 99.5% error rate at just 10 connections. Root cause:
  Phase 2 (edge nginx rate limiting) added an `frs_general` zone (50r/s + burst 100, `nodelay`) to
  `location ^~ /api/` **after** Phase 0's baseline ran — Phase 0 never saw this zone because it
  didn't exist yet. A single-source load-test tool will always collide with a per-IP edge zone
  sized for real distributed traffic; that's a difference in what changed between the two tests,
  not a regression.
- **Near-miss, caught and fully reverted:** attempted a scoped fix (a `geo`/`map` construct to
  bypass `frs_general` for just the test's own source IP, leaving the zone intact for all other
  traffic). `nginx -t` passed and `systemctl reload` reported success, but nginx's error log showed
  it had silently **rejected** the reload (`limit_req "frs_general" uses the "$frs_general_key" key
  while previously it used the "$binary_remote_addr" key`) and kept running the old workers
  unchanged — changing a `limit_req_zone`'s key variable is not reload-safe; it requires a full
  restart. This left the on-disk config in a state nginx had already proven it would refuse to
  start with — a real risk if anything else had restarted nginx before it was caught (crash, OOM,
  reboot). Caught via worker process start-time inspection (`ps -eo lstart`, stale since the
  previous day despite multiple "successful" reloads) before any further action. **Immediately
  reverted both edited files to their pre-change backups**, confirmed `nginx -t` clean, reloaded,
  confirmed new workers actually respawned this time, confirmed real traffic (homepage, Kafka UI,
  Redis UI) unaffected throughout. Reported to the user before attempting any further nginx change.
- **Resolution: tested via loopback instead**, hitting `http://127.0.0.1:8080` (the same upstream
  nginx itself proxies `/api/` to) rather than the public domain — matching nginx's own
  `proxy_set_header` behavior (`Host`, `X-Forwarded-Proto`, `X-Forwarded-For`) so the app tier sees
  an equivalent request. This isolates exactly the question Phase 0 answered (app-tier capacity)
  with zero nginx config risk. Confirmed with a light, realistically-paced check afterward (20
  requests at ~1/s through the real public path, zero rejections) that the edge zone itself still
  behaves correctly for genuine traffic patterns — not a full stress test of it, since that's not
  what Phase 8 is measuring.
- **App-level `globalRateLimiter` temporarily raised for the test window** (mirroring Phase 0's own
  documented approach), same as before: a single-source tool otherwise measures its own rate-limit
  ceiling, not the backend's. First attempt sized this at 100,000 (Phase 0's assumption, ~600 RPS
  ceiling) and undersold it — stages 1+2 alone consumed 83,197 requests, confirming the ceiling had
  moved substantially before the full ramp even finished. Raised to 50,000,000, Redis counter
  cleared, re-ran the complete ramp clean. **Reverted to 600 immediately after** — verified via live
  response header on the public domain, then re-verified again after a first revert attempt that
  turned out not to have actually executed (an unrelated shell issue, caught immediately by
  re-checking the live header rather than assuming success).
- **Results** (zero errors/timeouts at every stage, 10–400 connections):

  | Connections | Avg RPS | P50 | P95 | P99 | Error rate |
  |---|---|---|---|---|---|
  | 10  | 2,393.9 | 3ms   | 7ms   | 9ms   | 0% |
  | 25  | 3,043.5 | 7ms   | 11ms  | 13ms  | 0% |
  | 50  | 3,305.6 | 14ms  | 20ms  | 23ms  | 0% |
  | 100 | 3,450.5 | 28ms  | 37ms  | 39ms  | 0% |
  | 200 | 3,380.0 | 57ms  | 73ms  | 84ms  | 0% |
  | 400 | 3,410.0 | 113ms | 147ms | 182ms | 0% |

  Throughput plateaus at **~3,300–3,450 RPS from 50 connections onward** — **~5.6–5.8× Phase 0's
  ~590–600 RPS plateau**. P50/P99 still climb with concurrency (queueing, same signature as Phase
  0), but off a much lower floor and to a much lower ceiling: **P99 at 400 connections is 182ms,
  versus Phase 0's 3,198ms — a ~17.6× improvement**, not just a throughput one.
- **Host metrics during the run:** host-wide CPU 48% avg / 71% peak; `load1` peaked at **5.8**
  (versus Phase 0's 12.3 — no longer queueing past the core count); summed CPU across the 3
  `frs-backend` instances peaked at ~375% (of a possible 300% if all three were fully pegged),
  consistent with the app tier's now-3 instances still being the binding constraint, same *nature*
  of bottleneck Phase 0 found, just a higher ceiling (Phase 6's 2→3 rightsizing, plus Phase 3's
  auth cache and Phase 7's other CPU-per-request reductions, compounding); Postgres active
  connections peaked at **4 of PgBouncer's 20-connection real pool** (nowhere near the ceiling);
  Redis peaked at **14,174 ops/sec** (versus Phase 0's ~2,039 — expected, Phase 3's auth cache adds
  Redis round trips that didn't exist in the Phase 0 baseline; still far under Redis's practical
  single-thread ceiling); memory never dropped below 6.95 GB available — not a constraint.
- **Real, if partial, remaining headroom found, not chased further this phase:** host-wide CPU (71%
  peak) and `load1` (5.8 of 8 cores) both still show slack even at the 400-connection stage — the
  plateau is the app tier's current 3-instance allocation, not the host's absolute ceiling.
  Consistent with Phase 6's own deliberate, evidence-based choice to stop at 3 instances (not the
  original 4–5 range) given real non-FRS tooling colocated on this host — this is the concrete
  confirmation of that trade-off, not a new finding requiring action now.
- **Kafka not exercised**, same as Phase 0 — this scenario is the authenticated-dashboard-read path
  only; device-event/camera-frame scenarios remain deferred (see Phase 0's log for the same
  caveat).
- Raw results: `results_phase8.jsonl`, `metrics_phase8.csv`, `run_output_phase8.log` (session
  scratchpad, same location/convention as Phase 0's `results.jsonl` — not committed to the repo).

### Baseline vs. Final — Results

*Phase 0 column captured 2026-08-03, Phase 8 column captured 2026-08-05 — both the
authenticated-dashboard-read scenario only (device-event/camera-frame scenarios deferred in both
passes, see each phase's execution log). Phase 8 was run via loopback (`127.0.0.1:8080`, the same
upstream nginx itself proxies to) rather than the public domain — see Phase 8's execution log for
why a same-target comparison stopped being possible once Phase 2 added edge rate limiting after
Phase 0 ran; this isolates the same app-tier-capacity question Phase 0 answered.*

| Metric | Phase 0 — Baseline | Phase 8 — Final Optimized | Δ Change |
|---|---|---|---|
| Requests per Second | ~590-600 RPS sustained (plateau from 50 conns onward) | ~3,300-3,450 RPS sustained (plateau from 50 conns onward) | **~5.6-5.8×** |
| Throughput | ~1.45 MB/s at plateau | ~7.1-7.8 MB/s at plateau | **~5.1-5.4×** |
| API Latency — P50 | 19ms (low conc.) – 643ms (400 conns) | 3ms (low conc.) – 113ms (400 conns) | **~5.7-6.3× lower** |
| API Latency — P95 | 32ms (low conc.) – 3133ms (400 conns) | 7ms (low conc.) – 147ms (400 conns) | **~4.6-21.3× lower** |
| API Latency — P99 | 37ms (low conc.) – 3198ms (400 conns) | 9ms (low conc.) – 182ms (400 conns) | **~4.1-17.6× lower** |
| Error Rate | 0% at every stage (10-400 connections) | 0% at every stage (10-400 connections) | No change (both clean) |
| CPU Utilization | Both PM2 workers 80-100%; host load1 peaked 12.3 | 3 PM2 workers ~330-375% summed; host load1 peaked 5.8 | Higher ceiling, no longer queueing past core count |
| Memory Utilization | mem_avail never below 6.4 GB — not a constraint | mem_avail never below 6.95 GB — not a constraint | No change (still headroom) |
| Disk I/O | Not saturating (no evidence of contention at this load level) | Not saturating (no evidence of contention at this load level) | No change |
| Network I/O | Not a constraint at this load level (well under instance's documented ceiling) | Not a constraint at this load level | No change |
| PostgreSQL metrics | active_conns peaked at 12 of 40 pooled — nowhere near the ceiling | active_conns peaked at 4 of PgBouncer's 20-connection real pool — nowhere near the ceiling | Still comfortable headroom |
| Redis metrics | ~2,039 ops/sec peak — comfortable headroom | ~14,174 ops/sec peak — comfortable headroom | ~6.9× more Redis load (auth cache added since Phase 0), still well within capacity |
| Kafka metrics | Not exercised this pass (scenario didn't include device events) | Not exercised this pass (same scenario) | No change (same known gap) |
| PM2/Node.js metrics | 2 instances, both CPU-saturated at plateau — confirmed binding constraint | 3 instances, still the binding constraint by nature — real headroom remains beyond this (host CPU/load1 not fully saturated) | Same bottleneck *type*, higher ceiling, more room known to exist |

### Hotfix — 2026-08-05: HR dashboard 5–10s load, root-caused and fixed live

Reported after Phase 8 closed the throughput roadmap: the HR Manager dashboard (`HRManagerDashboard.tsx`) was still taking 5–10 seconds to load despite every prior phase, undermining the whole point of the throughput work if the highest-traffic page itself stayed slow. Investigated as a full request-lifecycle trace, not assumed to be one of the already-covered endpoints.

*Investigation:*
- **Frontend fires 7 endpoints on mount, all in parallel** (`Promise.allSettled` for 5 of them, 2 more from independent `useEffect`s) — confirmed no client-side waterfall via a fresh Explore-agent trace of `useApiData.ts`, `HRManagerDashboard.tsx`, `ZoneHeatmap.tsx`. Ruled out sequential-fetch as the cause; the delay had to be one slow backend endpoint dominating the parallel batch.
- **Live-timed all 7 against the loadtest tenant**: 6 of 7 returned in 40–90ms. But that tenant has near-zero data — not representative of a real dashboard. Found the actual "Motivity-Internal" tenant (24 real employees, matching the reported screenshot) and re-diagnosed against it directly with `EXPLAIN ANALYZE`, not guesswork.
- **Root cause: `listAttendance`'s "today" query** (`liveRepository.js:165-313`, backing `GET /live/attendance?limit=500`) runs **4 correlated subqueries per employee row** (check-in count, check-out count, full check-in list, full check-out list), each scanning `device_events` — 497K rows, 1.3GB, the largest table in the DB — filtered on `COALESCE(payload_json->>'employee_id', payload_json->>'employeeId')`, a JSONB text extraction with **no supporting index**. Measured directly: **14,980ms execution time** for this query alone, against the real 39-scope-row tenant (Buffers: shared hit=122,489 for just one of the four subqueries).
- **Checked whether an existing index could be reused instead**: `device_events.fk_person_id` has its own index (`idx_de_person_occurred`), which looked like a possible shortcut — but confirmed live that `fk_person_id` is **0/7,285 populated** for `EMPLOYEE_ENTRY`/`EMPLOYEE_EXIT` rows. The JSONB payload is the only real linkage today; routing around it wasn't an option without touching the device-event producer (out of scope, much larger change).
- **The other 6 endpoints are clean**: `getDashboardMetrics` (Global Status/Attendance %/Avg Hours) runs 7 lean queries in `Promise.all`, no `device_events` involvement, ~42ms live. `zone-heatmap` is a proper set-based CTE query against `attendance_ping` (a different, purpose-built table), ~86ms live. Neither needed changes.

*Fix:*
- Added `idx_device_events_payload_employee` — `(tenant_id, event_type, COALESCE(payload_json->>'employee_id', payload_json->>'employeeId'), occurred_at DESC)` — via `CREATE INDEX CONCURRENTLY` (non-blocking; verified live device-event writes continued uninterrupted throughout, 27 rows written in the 5 minutes spanning the build). Targets the exact expression the query already filters on, so no query rewrite was needed.
- Migration `015_device_events_payload_employee_index.sql` added to the repo (`CONCURRENTLY`, must run outside a transaction) so this isn't just an ad-hoc live change — the next environment gets it from the migration, not by rediscovering the same incident.
- **Verified before/after on the exact same query, same real tenant**: 14,980ms → 23.2ms (**~645×**). The narrower single-subquery form (matching my first isolation test) went 14,980ms → 6.2ms (~2,400×) — consistent, not a fluke of query shape.
- Confirmed via `pg_stat_user_indexes` the new index is already being used (`idx_scan` non-zero immediately after creation) and `pg_index.indisvalid = true` (not left in a broken partial-build state).

*Not changed, and why:* client-side inefficiencies noted during investigation (three independent 60s polling timers with no shared cache across `useApiData`/calendar/zone-heatmap; `/live/attendance?limit=500` over-fetching 500 raw rows for client-side aggregation that could move server-side; verbose `console.group`/`console.trace` logging in the hot fetch path) were not touched — the query fix alone collapses the dominant cost by ~2–3 orders of magnitude, and bundling unrelated frontend refactors into an urgent same-day fix wasn't warranted. Flagged here for a future pass, not silently dropped.

---

## 6. Benchmarking and Validation Strategy

1. **Fix the traffic mix and the pass/fail latency budget once**, up front (e.g. p95 under an agreed
   ms figure, error rate under an agreed %), covering authenticated dashboard reads, device-event
   ingestion, camera-frame posts, and login traffic — reuse the identical `k6`/`autocannon`/`wrk`
   script for every before/after comparison so improvements are attributable to the change that
   caused them, not to a different test.
2. **After every phase, capture:** sustained RPS at the latency budget, p50/p95/p99 latency, error
   rate, Postgres active connections + `pg_stat_statements`/slow-query log, Redis ops/sec and (from
   Phase 3 onward) auth-cache hit rate, per-PM2-process CPU/memory, host-wide CPU/memory/load average,
   and Kafka consumer lag on `frs.jetson-device-events` under `kafka-producer-perf-test.sh` load.
3. **Validation gate before proceeding to the next phase:** the signal that phase was meant to move
   must actually move. If it doesn't, stop and understand why before spending further effort.
4. **Final number (Phase 8):** record the sustained-RPS-at-budget-latency figure together with the
   exact host state it was measured under.

---

## 7. Comparison Table — Current State vs. After Optimization

All "After" figures are reasoned estimates tied to specific mechanisms above, to be confirmed by the
Phase 0/Phase 8 benchmarks — treat them as the plan's hypothesis, not a guarantee.

| Dimension | Current State | After Optimization (estimated) |
|---|---|---|
| **Architecture** | Everything co-resident on one VM; no caching layer; auth resolved via 7 sequential DB calls per request; raw frames in-memory only; Kafka single-partition/single-consumer for device events | Same VM, but with a Redis auth/permission cache and general read cache in front of Postgres, frame ingestion decoupled via Kafka like device events, and multiple Kafka partitions/consumers using more of this box's cores |
| **Bottlenecks** | Dev-mode `NODE_ENV` (held), 7-round-trip auth path, Keycloak dev mode, no nginx keepalive, stock Postgres config, crash-looping systemd unit burning CPU, 2/8 PM2 cores, no PgBouncer, no read cache, blocking bcryptjs, hot-path `console.log` | All items in Section 2/2a addressed or substantially reduced per the mapped optimizations in Section 4, except NODE_ENV which stays held |
| **Max sustainable RPS** | ~590–600 RPS **measured** (Phase 0, authenticated-dashboard-read scenario) | ~3,300–3,450 RPS **measured** (Phase 8, same scenario) — a ~5.6–5.8× real improvement; see Section 8 for why this landed below the original 5,000–15,000 reasoned estimate |
| **CPU utilization** | 2 of 8 cores actively serving app traffic | More cores actively used (rightsized, not maxed), each request consuming markedly less CPU per unit of work |
| **Memory utilization** | ~7.5 GB used / 15 GB total, no swap | Modestly higher, sized incrementally against the same ceiling |
| **Database performance** | Stock `shared_buffers=128MB`/`work_mem=4MB`, no PgBouncer, 40 total app connections, ~7 round trips/request | Tuned memory config, PgBouncer, most requests skipping the DB entirely via cache |
| **Kafka throughput** | Single partition, one sequential consumer, PM2-managed broker, plus a crash-looping unattached systemd unit wasting CPU | More partitions + more consumer processes, broker under systemd (Phase 1) |
| **API latency (P50/P95/P99)** | 19ms / 32ms / 37ms (low conc.) – 643ms / 3133ms / 3198ms (400 conns) — measured, Phase 0 | 3ms / 7ms / 9ms (low conc.) – 113ms / 147ms / 182ms (400 conns) — measured, Phase 8 |
| **Overall throughput** | Measured bound: Node CPU across 2 PM2 instances (Postgres pool never close to its ceiling even at baseline) | Measured bound: Node CPU across 3 PM2 instances — Postgres pool and Redis both confirmed with comfortable headroom, not the constraint |

---

## 8. Realistic Maximum RPS on This VM After All Optimizations

**Measured (Phase 8, 2026-08-05): ~3,300–3,450 RPS sustained**, authenticated-dashboard-read
scenario, zero errors, at latencies far below what a real p95 budget would reject (P99 182ms at 400
connections). This is a real ~5.6–5.8× improvement over Phase 0's measured baseline — but it landed
below the original ~5,000–15,000 RPS reasoned estimate below. Both facts are true at once; the
estimate wasn't wrong about the mechanism, it was optimistic about two specific inputs:

- **Instance count: 3, not 4–5.** The estimate assumed 4–5 PM2 instances; Phase 6 (I3) deliberately
  stopped at 3, given real non-FRS tooling colocated on this host (confirmed via `free -h`/`ps aux`
  throughout this engagement) — a considered trade-off, not an oversight. Phase 8's own host metrics
  confirm the gap this leaves on the table: CPU peaked at only 71% host-wide and `load1` peaked at
  5.8 of 8 cores during the 400-connection stage — real headroom the 3-instance ceiling isn't using.
  Going to 4–5 instances would likely close a meaningful part of the gap to the original estimate,
  consistent with the estimate's own reasoning — this just hasn't been done, on purpose, this phase.
- **Single scenario, not a blended mix.** Phase 8 (like Phase 0) measured one scenario
  (authenticated dashboard read) for a clean apples-to-apples comparison. The original estimate was
  phrased as "blended across the real traffic mix," which includes lighter-weight endpoints this
  measurement doesn't cover — a true blended figure could land differently in either direction and
  remains unmeasured.
- What the estimate got right: auth cache (A1) did shift the binding constraint away from the
  Postgres pool — Postgres active connections peaked at just 4 of PgBouncer's 20-connection real
  pool during Phase 8's heaviest stage, confirming the pool is no longer close to relevant. The
  binding constraint is Node.js CPU across the PM2 instance count, exactly as reasoned — just at 3
  instances' worth of capacity, not 4–5.
- Device-event ingestion's separate Kafka-partition-count ceiling (A4) remains unexercised by this
  scenario, same caveat as Phase 0.

**This is still 2+ orders of magnitude short of 1,000,000 RPS**, consistent with every prior document
in this series — reaching that figure requires the horizontal-scaling phase this document
deliberately excludes. Using the real measured figure:
`fleet_nodes ≈ 1,000,000 ÷ 3,375 (plateau midpoint) ≈ 297 nodes` of this exact single-VM
configuration — the concrete input for that future planning, no longer a placeholder. (Re-running
Phase 8 at 4–5 instances, if that trade-off is ever revisited, would tighten this number further —
see the instance-count point above.)
