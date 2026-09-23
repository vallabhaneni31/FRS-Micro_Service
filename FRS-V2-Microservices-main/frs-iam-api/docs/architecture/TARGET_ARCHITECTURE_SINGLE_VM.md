# Target Architecture — Single VM, Maximum Throughput
**FRS-ARCH-003 | v1.0 | 2026-08-03**

**Visual diagram (current vs. target, side by side):**
https://claude.ai/code/artifact/73864c81-909c-4e6c-b144-35626d699134

This document is the architecture design that FRS-ARCH-002 (`SINGLE_NODE_THROUGHPUT_OPTIMIZATION.md`)
analyzed and justified. Read this one for the *shape* of the target system and the request flow;
read FRS-ARCH-002 for the full per-optimization trade-off/risk discussion behind each piece.

## 0. Constraints and baseline for this design

- **Single VM only.** No additional EC2 instances. Every component below runs on the same 8 vCPU /
  15 GB host that runs FRS today.
- **Kafka's target baseline is a native `systemd` service.** Today it runs as a PM2-managed process
  (a Node.js process manager supervising the JVM broker directly — confirmed via `pm2 describe
  kafka`, script `bin/kafka-server-start.sh`). The migration to `systemd` is treated here as agreed,
  in-scope work for this implementation, not an open question — the "Current Architecture" section
  below shows it PM2-managed because that's what's true today; the "Target Architecture" section
  shows it under `systemd` because that's the agreed destination.
- No code or infrastructure has been changed while writing this document — it is a design, to be
  implemented per the roadmap in FRS-ARCH-002 §5.

---

## 1. Current Architecture and Request Flow

*(Diagram: top half of the artifact linked above.)*

Every process — nginx, the two `frs-backend` cluster workers, the Kafka broker (JVM, PM2-managed),
Keycloak (JVM, `start-dev` mode), Postgres, Redis, and several other resident services — shares one
host's 8 vCPUs and 15 GB RAM, with no priority separation between them.

A browser or Jetson device request flows: **client → nginx (TLS, static assets, reverse proxy with
no upstream keep-alive) → `frs-backend` (PM2 cluster, 2 of 8 cores) → Redis-backed rate limiter →, if
authenticated, 7 sequential uncached Postgres round trips to resolve the session → business logic →
Postgres/S3 → response.** Device events short-circuit the heavy part: authenticate → validate →
publish to Kafka → return `202`, with the actual DB writes/S3 uploads/broadcasts happening later in
a single consumer process. Raw camera frames are the one ingestion path *not* yet on this pattern —
they queue in one process's memory instead.

The full bottleneck list (15 items, ranked, each with the exact file/line or config value verified
against the live host) is in FRS-ARCH-002 §2 — not repeated here in full; the diagram's `flag`
markers correspond one-to-one with that list.

---

## 2. Target Architecture and Request Flow

*(Diagram: bottom half of the artifact linked above.)*

Nothing moves to another machine. What changes is: **fewer round trips per request, more of this
host's cores actually doing app work, a connection pooler in front of Postgres, a cache in front of
the auth path and the hottest reads, Kafka properly supervised and parallelized within this box, and
the one still-synchronous ingestion path (camera frames) brought onto the same async pattern device
events already use.**

### 2.1 Edge (nginx)
Adds an **upstream keep-alive pool** to the backend (removing a TCP handshake per request), raised
`worker_connections`/`worker_rlimit_nofile`, and a coarse **`limit_req`** IP throttle at the edge so
gross abuse is rejected before it ever reaches Node — the fine-grained, identity-aware limiting
(per-account, per-device) stays in the app tier where it already has the context to do that
correctly.

### 2.2 Rate limiting — now explicitly two-tier
1. **Edge (new):** nginx `limit_req`, coarse, IP-based, cheap — a first line of defense that costs
   nothing per request beyond nginx's own overhead.
2. **App tier (unchanged mechanism, tuned dependency):** the existing Redis-backed
   `express-rate-limit` middleware (global, per-account, per-device, per-invitation limiters already
   in `rateLimit.js`) — kept as-is architecturally, since it's the only layer with the request's
   authenticated identity, just running against a Redis instance tuned for higher throughput
   (`io-threads` raised).

### 2.3 Application tier
`frs-backend` stays a PM2 cluster, **rightsized** (not maxed at 8 — see FRS-ARCH-002 §4.3/I3 for why)
to leave real headroom for Postgres, Kafka, Keycloak, and Redis on the same box. Two new layers sit
inside the request path that didn't exist before:

- **Auth/permission cache (Redis, short TTL):** the JWT is still verified every request (cheap,
  local, JWKS-cached), but the 7-query session/permission resolution now checks this cache first.
  A hit replaces all 7 round trips with one Redis `GET`. A miss runs the same 7 lookups but
  **parallelized** (`Promise.all` where they're independent) and then populates the cache for the
  next request in that session.
- **Response cache (Redis):** hot, infrequently-changing GET endpoints (device status, employee
  directory, tenant/feature flags) are served from cache instead of hitting Postgres on every call.

`frs-device-event-consumer` becomes **multiple rightsized instances** instead of one, matched to the
higher partition count in §2.5 below — today it's architecturally capped at one sequential worker no
matter how many cores the box has.

### 2.4 Database
**PgBouncer** (transaction-mode pooling) sits between the app tier and Postgres — a local process on
this same VM, not new infrastructure in the horizontal-scaling sense. It's what makes rightsizing the
app tier (§2.3) safe without blowing through Postgres's `max_connections=100`. Postgres itself gets
its memory settings (`shared_buffers`, `work_mem`, `effective_cache_size`) raised off their stock
defaults, prepared statements for the hottest auth-path queries, and an autovacuum review for the
frequently-updated device-status tables.

### 2.5 Messaging (Kafka) — native systemd service, this implementation's target baseline
Kafka runs as a proper `systemd`-supervised service rather than a PM2-managed process — the same
JVM, the same KRaft broker, just correctly supervised at the OS level (auto-start on boot
independent of any Node process manager, standard restart/stop semantics, no ambiguity about which
process is authoritative). On top of that baseline, within this same box:
- Partition count raised on the hot topics (`frs.jetson-device-events`, and camera frames once §2.6
  lands), so more than one consumer process can do useful work in parallel.
- The producer's already-implemented `sendBatch` path is used on call sites that publish in bursts,
  instead of one network round trip per message via `sendEvent`.

**Operational tooling — Kafka UI (`kafbat/kafka-ui`):** evaluated against AKHQ, Confluent Control
Center, Redpanda Console, and Kafdrop for monitoring/debugging this pipeline (topics, consumer
groups, partition assignment, message inspection). Confluent Control Center was ruled out — it's a
licensed Confluent Platform product built for large multi-cluster estates, not a fit for one stock
Apache Kafka broker on a resource-constrained box. Kafdrop was ruled out — read-only, no auth story
of its own, slowing maintenance. AKHQ is a close, valid alternative (same license/footprint class).
**`kafbat/kafka-ui`** (the actively maintained community continuation, after Provectus stepped back
from the original repo) was chosen for its message-browsing/search UX — a strong match for this
app's actual JSON-payload topics (`frs.jetson-device-events`, `frs.attendance-ingest`,
`frs.dead-letter`) — and its OIDC support, which lets it authenticate against the **existing
Keycloak instance already on this box** instead of a separate credential system.

Installed the same way as every other JVM service here — **natively, not as a container**, matching
Kafka's and Keycloak's own pattern (this host already runs Java 21 for both):
- Executable JAR under `/home/ubuntu/kafka-ui-install/`, run via its own `kafka-ui.service` systemd
  unit (`java -Xmx384m -jar ...`, `User=ubuntu`, `After=kafka.service`/`Wants=kafka.service` so it
  never starts ahead of the broker it depends on).
- Heap sized conservatively (`-Xmx384m`) — this is a third JVM on a box that already carries the
  Kafka broker's and Keycloak's, not a tool being sized for a large cluster.
- Bound to `127.0.0.1` only (`SERVER_ADDRESS=127.0.0.1` in its config) — never exposed on the public
  interface directly, identical to how Keycloak is already loopback-only on this host.
- nginx `location ^~ /kafka-ui/ { proxy_pass http://127.0.0.1:<port>/; ... }`, mirroring the existing
  `/auth/` block exactly — nginx stays the only public-facing entry point on this box.
- `KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS=localhost:9092` — same broker address every other local client
  already uses; `AUTH_TYPE=OAUTH2` pointed at the existing Keycloak realm rather than new credentials.

### 2.6 Identity (Keycloak)
Moves from `start-dev` to `start --optimized` (production mode, ahead-of-time build), with a
config/realm review since production mode validates configuration more strictly than dev mode
tolerates, and its heap re-sized once the rest of this box's memory budget (Postgres, Kafka, the app
tier) is accounted for.

### 2.7 The remaining async gap: camera frames
Raw camera-frame ingestion (`/api/frames/rtsp|smart/:cameraId`) moves onto the **same Kafka-backed
decouple pattern already proven for device events**: authenticate, validate, publish, return fast;
processing happens in a consumer, off the request path. This removes the one high-volume ingestion
path still bound to a single process's in-memory queue.

---

## 3. Request Flow — Step by Step (target architecture)

### Flow A — Authenticated browser/dashboard request
1. nginx terminates TLS and reuses a **pooled keep-alive connection** to `frs-backend` (no new TCP
   handshake per request).
2. **Edge rate limit** — nginx `limit_req` rejects gross abuse before Node sees it.
3. **App rate limit** — the existing Redis-backed limiter, keyed by IP/account/device as appropriate
   for the route.
4. **JWT verification** against Keycloak's JWKS (keys cached locally; no network call per request).
5. **Auth cache lookup** (Redis) keyed on `sub`+`tenant_id`:
   - *Hit* (the common case for an active session): skip directly to the handler with the cached
     `{user, memberships, permissions, scope}` bundle.
   - *Miss*: run the same 7 lookups the system runs today, but in parallel where independent, then
     write the result into the cache before continuing.
6. **Response cache check** (Redis) for the specific hot, cacheable read endpoints — served directly
   if present and fresh.
7. **Business logic** executes; any DB access goes through **PgBouncer** to Postgres.
8. Response returned over the reused keep-alive connection.

### Flow B — Device event / camera frame ingestion (asynchronous)
1. Device JWT authenticated (stable numeric device ID, not the renameable `device_code` string —
   see the codebase's own prior incident notes on why that distinction matters).
2. **Device-scoped rate limit** applied (keyed on device ID).
3. Payload validated, `event_uid` assigned.
4. **Published to Kafka** (`sendBatch` where the call site has a batch) — this is the only synchronous
   work; everything else in this flow happens after the response.
5. **`HTTP 202`** returned immediately.
6. Asynchronously, one of several **rightsized consumer processes** (spread across the now-larger
   partition count) claims the event (batched dedup `INSERT ... ON CONFLICT`), uploads to S3, writes
   to Postgres, runs attendance/visitor business logic, and broadcasts over WebSocket via the
   existing Redis Socket.IO adapter — which is already correctly built to reach a client connected to
   a *different* `frs-backend` process than the one that received the original HTTP request.
7. Failures retry with backoff, then land in the `frs.dead-letter` topic instead of blocking the
   consumer indefinitely on one poison message.

---

## 4. Why Each Component Is Required (summary — full trade-off detail in FRS-ARCH-002 §4)

| Component | Why it's required | Contribution to max sustainable RPS |
|---|---|---|
| nginx upstream keep-alive | Removes a TCP connect/teardown cycle from every single proxied request | Matters increasingly as RPS rises; negligible at idle, material near the ceiling |
| Edge `limit_req` | Cheapest possible place to reject abusive traffic — before it costs the app tier anything | Protects the expensive tiers (auth, DB) from spending cycles on traffic that was always going to be rejected |
| Auth/permission cache | Collapses 7 sequential DB round trips into ~1 Redis round trip for the common case | The single largest lever in this design — the current DB-pool math (FRS-ARCH-002 §3) is the binding constraint today, and this is what relieves it |
| Response cache | Removes repeat Postgres load for hot, slow-changing reads | Frees DB capacity that would otherwise be spent re-answering the same questions |
| Rightsized PM2 instance count | Uses more of this host's 8 cores for app work, without starving Postgres/Kafka/Keycloak of theirs | Roughly proportional increase in app-tier CPU parallelism |
| PgBouncer | Decouples app-side pool size from Postgres's fixed `max_connections` | Makes the PM2 rightsizing above safe to do at all |
| Tuned Postgres memory settings | Stock defaults (128MB `shared_buffers` on a 15GB host) leave real, cheap performance unclaimed | Lower per-query latency on the exact queries that dominate the auth path |
| Kafka under `systemd` | Correct OS-level supervision for the broker (auto-start, restart semantics), independent of any Node process manager | Not a throughput lever by itself — a reliability/operability prerequisite this design takes as its baseline |
| More Kafka partitions + consumer instances | One partition today caps device-event processing at one sequential worker regardless of core count | Consumer-side throughput scales with partitions/consumers added, up to remaining CPU headroom |
| Camera frames onto Kafka | The one ingestion path still bound to a single process's memory | Removes that ceiling the same way it was already removed for device events |
| Keycloak production mode | `start-dev` explicitly isn't built for production concurrency | Faster login/token-refresh specifically, not the general API surface |
| Native `bcrypt` / worker-thread hashing | Pure-JS `bcryptjs` occupies the main event loop for its full duration | Frees event-loop time during login specifically |
| `NODE_ENV=production` | Gates real behavior — including a dev-only auth bypass — not just a label | Closes a correctness/security gap; secondary throughput effect from skipped dev-only branches |

---

## 4a. Rate-Limiting Layering — Detailed Placement

Refining §2.2: rate limiting is not one mechanism but two, deliberately not duplicated across
layers.

- **nginx (edge):** `limit_req` + `burst=N nodelay`, in zones scoped per route class (auth, general
  API, device events) — confirmed absent from the live config today (`grep` of `/etc/nginx/` found
  no `limit_req`/`limit_conn` directives anywhere). This is the token-bucket-family algorithm doing
  its job at the cheapest possible point — rejected before Node or Redis spend anything. Paired with
  `limit_conn` per IP/device to protect the `worker_connections` budget (still the stock `1024`)
  from one client monopolizing it. Route-scoped zones deliver "API-gateway-style" per-route policy
  without adding a dedicated gateway product — a real gateway (Kong/Envoy) is deferred to the future
  multi-node phase, where it has many app nodes to justify itself against; on one VM it would be
  another process competing for the same 8 cores for marginal benefit over this.
- **Redis (app tier):** the existing `rate-limit-redis`-backed limiters stay for the high-volume,
  non-security-critical cases. For the identity-aware, security-sensitive limiters specifically
  (`authRateLimiter`, `accountLoginLimiter`), upgrade from today's fixed-window counter — which has a
  real, if narrow, boundary-burst gap (a client can get up to ~2× the limit by timing requests across
  a window edge) — to a **sliding-window counter implemented as a Redis Lua script**, so the
  check-and-update happens as one atomic round trip. The **distributed-counter** and **atomic-
  operation** properties this needs aren't new infrastructure — they're exactly what the existing
  Redis-backed store already provides, extended to a smarter algorithm for the limiters where the
  boundary case actually matters for security.

**Two additional nginx-layer findings**, verified directly against the live config while reviewing
this:

- **HTTP/2 is compiled into the running nginx build** (`nginx -V` shows `--with-http_v2_module`) **but
  never enabled** — the live `listen 443 ssl;` directives don't add `http2`. Zero-cost to turn on;
  lets the SPA multiplex its parallel dashboard API calls over one connection.
- **Compression currently happens twice, and the second time does nothing.** Express's global
  `compression()` middleware gzips API responses before nginx ever sees them; nginx's own
  `gzip_proxied any` then can't re-compress an already-encoded body, so it's a pass-through no-op for
  every API response. Target: remove `compression()` from Express, let nginx (already doing this for
  static assets) handle it exclusively — frees Node event-loop/threadpool time. Brotli isn't compiled
  in, but `--with-compat` is present, so it's addable via the `libnginx-mod-http-brotli` dynamic
  module rather than a full nginx rebuild.

---

## 5. What this design does *not* claim

Consistent with FRS-ARCH-002 §8: this architecture's realistic ceiling is an estimated
**~5,000–15,000 sustained RPS** on this one VM — a large improvement over today's estimated
~800–1,500, but still 1–2+ orders of magnitude short of the 1,000,000 RPS long-term goal. Closing
that remaining gap requires the horizontal-scaling phase described in FRS-ARCH-001, which is
explicitly out of scope for this design. What this document produces instead is the concrete shape
of the single-node baseline that phase will need to measure against.

A full-codebase and full-host re-review (FRS-ARCH-002 §2a) added several more real, small fixes
(CORS regex hoisting, nginx `tcp_nopush`/`open_file_cache`/buffered logging/TLS session cache,
Postgres WAL settings, Kafka producer compression, capped `sharp` concurrency, and the WS-broadcast
lookup cache above) and confirmed several things were already correct (Transparent Huge Pages at the
safe `madvise` setting, the NVMe I/O scheduler already at `none`, Postgres's checkpoint tuning already
modern). None of it moves the ~5,000–15,000 RPS estimate to a different order of magnitude — it's the
kind of thoroughness pass that closes out a design, not one that reopens it. The host's exact instance
type was also confirmed via metadata: **`c6g.2xlarge`** (Graviton2, 8 vCPU), AWS-documented at **"up
to 10 Gbps," burstable** — the concrete figure behind FRS-ARCH-001/FRS-ARCH-003's networking ceiling
argument.
