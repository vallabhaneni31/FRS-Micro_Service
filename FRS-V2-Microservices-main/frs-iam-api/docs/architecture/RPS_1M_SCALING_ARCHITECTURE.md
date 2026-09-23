# Scaling FRS to 1,000,000 Requests/Second — Architecture & Roadmap
**FRS-ARCH-001 | v1.0 | 2026-08-03**

## Purpose and how to read this document

This document is the planning artifact for the 1M RPS initiative. It describes, from a direct
reading of the current codebase and the live host, exactly how a request is handled today, why
today's architecture cannot reach 1M RPS regardless of code polish, what has to change, and in
what order. **No code or infrastructure has been changed as part of writing this document** — it
is analysis and planning only. Implementation begins after this plan is reviewed, starting with
the Kafka systemd migration (Phase 0) that the team has already agreed is the prerequisite step.

A note on the target itself: **1M RPS is a fleet-aggregate number, not a per-node number.** No
single Postgres primary, no single Kafka broker, and no single Node.js process will individually
ever handle 1,000,000 requests per second. Every recommendation below is either (a) something that
makes each node/instance handle more of its fair share, or (b) something that lets you add more
nodes/instances linearly. Section 5 works the actual arithmetic once the per-node ceiling is
measured.

---

## 1. Current Architecture and Request Flow

### 1.1 Physical/deployment topology (verified against the live host)

Everything currently runs on **one EC2 host** (8 vCPUs, 15 GB RAM), with every tier co-located and
process-managed by **PM2** (a Node.js process manager):

| PM2 process | What it actually is | Mode |
|---|---|---|
| `frs-backend` | Main API, `backend/api/src/server.js` | cluster, **2 instances** |
| `frs-device-event-consumer` | Kafka consumer worker, `backend/api/src/workers/deviceEventConsumer.js` | fork, 1 instance |
| `kafka` | **Apache Kafka 4.3.1 broker (Java/JVM)**, KRaft combined mode | fork, 1 instance — PM2 is supervising a JVM, not a Node process |
| `frs-retail-backend` | Separate retail-vertical API (port 4001) | fork |
| `face-quality-svc` | Python face-quality sidecar | fork |
| `mediamtx` | RTSP media server | fork |
| `frontend-dev` | Vite dev server | fork |
| `api-service`, `gateway-service` | Unrelated legacy "ESurveillance" services (different codebase, `/home/ubuntu/ESurveillance/`) | fork |

In front of all of this is a single **nginx** instance (`worker_processes auto`, `worker_connections
1024` — the stock Ubuntu default, never tuned) terminating TLS and reverse-proxying:
`/api/` → `127.0.0.1:8080` (the backend), `/socket.io/` → same, `/auth/` → Keycloak on `127.0.0.1:9090`,
everything else → static files from `frontend/dist`.

There is one Postgres instance (`attendance_intelligence_07-07-26` — confirmed via `.env`; a separate,
stale `attendance_intelligence` DB also exists on this host and is not the live one), one Redis instance (used for rate-limit
counters, the Socket.IO cross-process adapter, and nothing else load-bearing), one Keycloak
instance, and the one Kafka broker above — **no replicas, no clustering, no load balancer tier
anywhere in the stack.** `docs/runbooks/SCALING_RUNBOOK.md` describes scaling via
`kubectl scale deployment frs-backend --replicas=5` — there is no Kubernetes anywhere in this
deployment; that runbook describes an environment that does not exist here and should not be
trusted as a scaling reference until the fleet described in this document actually exists.

### 1.2 Request flow — human/browser traffic

```
Browser → nginx (TLS terminate, static asset serve) → 127.0.0.1:8080 (frs-backend, PM2 cluster, 2 workers)
```

Inside `backend/api/src/server.js`, every request passes through, in order:
`correlationIdMiddleware` → `requestLogger` → `compression()` → `cookieParser` → `helmet` →
CORS (a function-based origin check, not a static allow-list) → route-scoped `express.json()` body
parsers → `globalRateLimiter` (Express middleware, Redis-backed when `REDIS_URL` is set) → the
matched route.

Any route behind `requireAuth` (`backend/api/src/middleware/authz.js`) additionally does, **per
request, sequentially, with no caching layer**:

1. Verify the Keycloak JWT (JWKS-based signature/issuer/audience check).
2. `findUserByKeycloakSub` — Postgres query against `frs_user`.
3. `getUserBySSOSub` — Postgres query against the newer multi-tenant `users` table.
4. `getRbacPermissionsForUser` (falls back to `getMembershipsByUserId`) — Postgres query for RBAC
   role/permission rows.
5. `isUserSuperAdmin` — Postgres query.
6. `getUserScopes` — Postgres query.
7. `getTenantById` — Postgres query.
8. `featuresForTenant` — Postgres query.

That is **up to 7 sequential Postgres round trips plus one JWT verification, on every single
authenticated HTTP request**, before the route handler itself runs (`authz.js:191-252`). There is
also a synchronous `console.log('[DEBUG req.auth.scope]...')` on every successful auth
(`authz.js:410`) that still ships in this code path.

### 1.3 Request flow — device/Jetson traffic (the other major source of volume)

Device events (`POST /api/events`) follow the already-optimized path described in
`backend/api/docs/backend_architecture_changes.md`: authenticate → validate → assign `event_uid` →
publish to Kafka topic `frs.jetson-device-events` → return `202` in <50ms. The heavy work (S3
upload, DB write, WebSocket broadcast) happens later, off the request path, in
`frs-device-event-consumer`.

Raw camera frames (`POST /api/frames/rtsp/:cameraId`, `POST /api/frames/smart/:cameraId`) do
**not** go through Kafka — they're handed to `validationService.validateAndQueueFrame`, which
queues them in **in-process, in-memory queues** owned by `shutdownManager` (`cameraQueues`, visible
at `/api/metrics`). This path is bounded by a single process's memory and event loop; it cannot be
horizontally scaled without moving frame ingestion onto Kafka the same way device events already
were.

### 1.4 Kafka today (the piece being migrated first)

- **Single broker**, KRaft combined broker+controller mode, `node.id=1`, `replication.factor=1` for
  every internal topic, `num.partitions=1` default. Verified via
  `/home/ubuntu/kafka-install/kafka_2.13-4.3.1/config/server.properties`.
- Producer (`KafkaProducer.js`): one shared idempotent producer, `acks=all`. `sendEvent()` sends one
  message per call — no client-side batching/linger, so every published event is its own network
  round trip to the broker.
- Consumer (`deviceEventConsumer.js`): uses `eachBatch`, batches the dedup `INSERT` for a whole
  fetched batch (good), but **processes events within a batch strictly sequentially by design**
  (to preserve per-tenant ordering) — one consumer process, and if the topic has one partition,
  one partition, means this pipeline's ceiling is one sequential worker doing blocking DB writes.
- **Managed by PM2**, not systemd: `pm2 describe kafka` shows `script path:
  bin/kafka-server-start.sh`, `exec mode: fork_mode`. PM2 is a Node.js process supervisor being
  asked to babysit a JVM with no OS-level start-on-boot guarantee independent of PM2's own resurrect
  mechanism, no cgroup-based memory/CPU isolation, and `pm2 restart` semantics (SIGINT then
  SIGKILL) that were designed for Node event loops, not JVM shutdown hooks. This is exactly the gap
  Phase 0 (below) closes.

### 1.5 What already scales correctly (worth preserving, not rebuilding)

- Rate limiting already supports a **Redis-backed distributed store** (`rateLimit.js`) with graceful
  per-process fallback — the mechanism is right, only the call pattern needs rethinking at 1M RPS
  scale (Section 2.7).
- WebSocket already has a **Redis adapter/emitter** (`@socket.io/redis-adapter`) so
  `frs-device-event-consumer` and `frs-backend` can both emit to connected clients regardless of
  which process holds the socket — this is the correct primitive for a multi-node fleet, it's just
  only exercised across 2 backend instances today.
- Device-event ingestion is already decoupled via Kafka (Section 1.3) — this is the pattern that
  still needs to be extended to raw frame ingestion.
- `IS_PRIMARY_INSTANCE` gating (`server.js:675`) already prevents cron/polling duplication across
  PM2 cluster workers — this must be preserved and re-verified as instance count grows.

---

## 2. Bottlenecks Preventing 1M RPS (ranked by impact)

1. **Single host, zero horizontal scale-out, anywhere.** One nginx, one Postgres, one Redis, one
   Kafka broker, 2 backend processes. This alone caps the system's ceiling at whatever one 8-vCPU
   box can do — independent of every fix below. There is no load balancer tier; nginx here is
   simultaneously the edge and (via PM2 cluster) the only app-tier fan-out mechanism.

2. **7 sequential blocking DB round trips per authenticated request, with zero caching.**
   (Section 1.2.) This is the single largest per-request latency/throughput cost in the codebase.
   At any meaningful RPS this alone will exhaust the Postgres connection pool long before CPU or
   network becomes the limit.

3. **PM2 cluster is running 2 instances on an 8-vCPU host** — 75% of the API tier's own host
   capacity is idle before any other constraint is even reached.

4. **A synchronous `console.log` on every authenticated request** (`authz.js:410`). Under load,
   synchronous stdout writes block the event loop, and worse once stdout is a pipe (PM2/journald)
   that can apply backpressure. Trivial to fix, real impact at volume.

5. **Postgres has no connection multiplexing (no PgBouncer) and a small pool.** `DB_POOL_MAX`
   defaults to 20 per process; 2 backend instances ⇒ 40 total application connections to a single
   primary, with no read replica to offload reporting/dashboard queries. `withTenantContext` also
   issues two extra `SET LOCAL` statements per pooled-connection use for RLS — real, but secondary
   to bottleneck #2.

6. **Kafka is a single-broker, unreplicated, single-partition-by-default SPOF**, PM2-managed
   (Section 1.4). Both a reliability gap (Phase 0's concern) and a throughput ceiling (one
   partition ⇒ one consumer thread of parallelism per topic).

7. **Rate limiting does a synchronous Redis round trip per limiter, per request, in the hot path.**
   `globalRateLimiter` alone is one Redis call on essentially every `/api/*` request; routes behind
   multiple limiters (e.g. device events: global-exempted but still `deviceEventRateLimiter`) add
   more. At 1M RPS this makes a single Redis instance a new bottleneck, and the existing
   "fall back to in-memory silently" behavior means correctness (not just performance) degrades
   exactly when Redis is most loaded.

8. **nginx is untuned and single-instance.** Default `worker_connections 1024` was never revisited;
   there's no caching of cacheable API responses, no HTTP keepalive tuning called out, and nginx
   here plays both edge and (implicitly) load-balancer role for a 2-process backend — it has no
   peers to fail over to or spread load across.

9. **No caching layer for hot read endpoints.** Dashboard, employee directory, device status, and
   tenant/feature lookups all hit Postgres directly on every call, compounding bottleneck #2/#5.

10. **Raw camera frame ingestion bypasses Kafka entirely** (Section 1.3) — it's the one high-volume
    ingestion path still bound to a single process's memory, unlike device events which were
    already fixed this way.

11. **No fleet-wide observability.** `/api/metrics` is a single hand-rolled JSON endpoint on one
    process. You cannot safely operate — let alone validate — a 1M RPS fleet without real RED
    (rate/error/duration) metrics aggregated across every tier and every node.

---

## 3. Architectural and Code Changes Required

Mapped to the bottlenecks above, roughly grouped by what layer owns the fix:

### 3.1 Infrastructure (must happen — no code change substitutes for this)
- Stand up a real horizontally-scalable app tier (autoscaling group or Kubernetes/ECS) behind an
  actual load balancer (ALB/NLB or a dedicated nginx/HAProxy LB tier) — not the same nginx that
  also serves static assets on one box.
- Separate every tier onto independently scalable resources: LB tier, app tier, cache tier
  (Redis Cluster), DB tier (Postgres primary + read replicas, PgBouncer), broker tier (multi-broker
  Kafka cluster).
- Move static frontend assets to a CDN, off the app host entirely.

### 3.2 Kafka
- **Phase 0 (this task, immediate):** migrate the broker from PM2 to a native `systemd` service —
  see Section 4, Phase 0 for the concrete unit file and cutover plan. This is a reliability/ops
  fix, not a throughput fix, and is explicitly the prerequisite the team wants done before any
  throughput work starts.
- Grow to a proper multi-broker cluster (3+ brokers, `replication.factor=3`) once off systemd and
  validated.
- Size topic partitions to match desired consumer parallelism (today: 1 partition ⇒ 1 consumer
  thread max per group, regardless of how many consumer processes you run).
- Adopt client-side batching in the producer (`sendBatch` is already implemented in
  `KafkaProducer.js` — use it consistently instead of `sendEvent` on hot paths) to cut per-message
  network round trips.
- Extend the Kafka-decoupling pattern already used for device events to raw frame ingestion
  (bottleneck #10), so that path is no longer bound to one process's memory.

### 3.3 Auth/authz (highest-leverage code change in the whole system)
- Introduce a short-TTL Redis cache keyed on the verified JWT (or its `sub`+`tenant_id`) holding
  the resolved `{user, memberships, permissions, scope, mt}` bundle, so repeat requests from the
  same session skip all 7 DB round trips. This is the single biggest win available without any
  infrastructure change.
- Where correctness allows, parallelize the independent lookups (`Promise.all` for
  `getUserScopes`/`getTenantById`/`featuresForTenant`, which don't depend on each other) rather than
  awaiting them one at a time.
- Remove the stray `console.log` on the auth hot path (`authz.js:410`).
- Consider a local in-process LRU as an L1 in front of the Redis cache for sub-millisecond hits on
  the busiest sessions.

### 3.4 Database
- Introduce PgBouncer (transaction-mode pooling) in front of Postgres; centralized pooling is what
  lets you safely raise per-instance `DB_POOL_MAX` without each new app replica linearly eating
  into Postgres's own `max_connections`.
- Add read replica(s) for read-heavy dashboard/report/search endpoints.
- Batch the two `SET LOCAL` RLS statements in `withTenantContext` into a single round trip.
- Revisit tenant-based sharding only once a single (replicated) primary is empirically the ceiling
  — premature before that.

### 3.5 App tier
- Raise PM2 cluster instances to match host vCPU count today (quick, zero-risk win), then move to
  container/orchestrator-based autoscaling (HPA-equivalent) as the fleet grows past one host.
- Add Redis-backed caching for hot, infrequently-changing reads (device status list, employee
  directory, tenant config/feature flags).
- Keep the `IS_PRIMARY_INSTANCE` single-instance-gating pattern intact and re-verified at every
  scale-out step — it is currently the only thing preventing N-fold duplicate cron/polling work.

### 3.6 Rate limiting
- Push coarse, identity-agnostic IP throttling to the edge (nginx `limit_req` or the load
  balancer) so Node/Redis only spends cycles on the fine-grained, identity-aware limits (per
  account, per device) that actually require application context.
- At fleet scale, evaluate a real API gateway (Kong/Envoy/similar) with built-in distributed rate
  limiting instead of continuing to hand-roll it in Express middleware — the current design is
  correct at today's scale but a per-request synchronous Redis call does not comfortably reach
  1M RPS in aggregate without a lot more Redis capacity than the plan currently assumes.

### 3.7 Observability
- Replace the single hand-rolled `/api/metrics` JSON endpoint with real fleet-wide RED metrics
  (Prometheus/Grafana or equivalent) — non-optional prerequisite for safely operating and for
  validating each phase's benchmark below.

---

## 4. Prioritized Implementation Roadmap

### Phase 0 — Kafka: PM2 → systemd migration (prerequisite, do first)
**Goal:** operational reliability, not throughput. Get the broker off a Node.js process manager and
onto the OS's own service supervisor before any throughput work begins, per the team's existing
decision.
- Write a `systemd` unit for the broker matching the live config exactly (Kafka 4.3.1 at
  `/home/ubuntu/kafka-install/kafka_2.13-4.3.1`, `config/server.properties`, KRaft combined mode,
  `log.dirs=/home/ubuntu/kafka-install/kraft-logs`).
- Cut over: stop the PM2-managed process, remove it from PM2's process list/dump so it isn't
  resurrected by `pm2 resurrect` on next boot, enable+start the systemd unit.
- Verify: broker healthy, existing topics/cluster ID intact (no reformat — the storage directory
  and `meta.properties` are reused as-is), `frs-backend` and `frs-device-event-consumer` reconnect
  without error, `frs.jetson-device-events` consumer lag returns to baseline.
- Update `infra/native-deploy/kafka_setup.sh`, which currently describes installing a *different*
  Kafka version (3.7.0, `/opt/kafka`) than what's actually running (4.3.1,
  `/home/ubuntu/kafka-install/`) — bring it in line with the real, running configuration so it's
  usable for the next environment stood up.
- **This phase is a separate, explicitly-scoped piece of work — see the next message for the
  concrete unit file and step-by-step cutover plan, held for review before touching the live
  broker.**

### Phase 1 — Single-host quick wins (days, no new infrastructure)
**This phase now has its own dedicated deep-dive document:
[`docs/architecture/SINGLE_NODE_THROUGHPUT_OPTIMIZATION.md`](./SINGLE_NODE_THROUGHPUT_OPTIMIZATION.md)
(FRS-ARCH-002)** — it covers this host's full process inventory, config-level findings
(`NODE_ENV=development` in the live `.env`, Keycloak running in `start-dev`, no nginx↔backend
upstream keepalive, stock-default Postgres tuning, etc.), a layer-by-layer optimization list, and
its own benchmark/validation plan. Summary of what it covers:
- Remove the hot-path `console.log` (`authz.js:410`).
- Add the Redis-backed auth/permission cache (Section 3.3) — expect this to be the largest single
  latency win available.
- Parallelize the independent auth DB lookups.
- Rightsize PM2 `frs-backend` cluster instances (not simply "match vCPUs" — this host also runs
  Kafka's and Keycloak's JVMs, Postgres, Redis, and other co-resident processes; see FRS-ARCH-002 §4.3, item I3).
- Introduce PgBouncer in front of the existing single Postgres instance.
- **Target:** FRS-ARCH-002's Step 6 produces the actual measured sustained-RPS-at-budget-latency
  ceiling for this single host — that number is the required input to Section 5.4 below, not a
  number to guess here.

### Phase 2 — Horizontal app tier + shared state (weeks)
- Stand up a real load-balancer tier and 3+ app-tier replicas (separate hosts/instances, not more
  PM2 workers on one box).
- Move Redis to a clustered/HA configuration (rate limiting + Socket.IO adapter + new auth cache
  all depend on it — it becomes load-bearing at this point, not optional).
- Add a Postgres read replica for read-heavy endpoints.
- Push coarse rate limiting to the edge/LB layer.
- **Target:** demonstrate linear-ish scaling across replicas under load test (Section 5) — e.g. if
  one tuned node sustains X RPS at budget latency, N nodes behind the LB should sustain ~N×X minus
  a measured, small coordination overhead.

### Phase 3 — Data/broker tier scale-out (weeks–months)
- Grow Kafka to a real multi-broker cluster with partition counts matched to consumer parallelism;
  move raw frame ingestion onto Kafka the same way device events already are.
- Evaluate Postgres read/write splitting or tenant-based sharding if the replicated primary is the
  measured ceiling.
- Full autoscaling (fleet grows/shrinks with load, not fixed replica counts).
- CDN for all static assets; API gateway evaluation for rate limiting at the edge.

### Phase 4 — Fleet validation against the 1M RPS target
- Run the full benchmark suite (Section 5) against the assembled fleet, compute the actual
  per-node budget achieved in Phase 1–2, and derive the concrete fleet size (app replicas, Kafka
  partitions/brokers, DB replicas, Redis shards) needed to sustain 1M RPS aggregate at the agreed
  latency/error budget. Treat this as the phase that produces the final, real numbers — Section 5
  gives the *method*, not a pre-committed node count, because that number is meaningless before
  Phase 1's per-node measurement exists.

---

## 5. Performance Benchmarks and Validation Strategy

**Principle:** every phase above ends with a load test against a realistic traffic mix, not a
synthetic single-endpoint benchmark. Do not treat any number in this section as a target to hit
blindly — treat it as the *shape* of the measurement to take; fill in real thresholds once Phase 1
produces a real per-node baseline.

### 5.1 Tooling
- `k6` or `autocannon`/`wrk` for HTTP load generation, scripted to reproduce the actual mix this
  system serves: authenticated dashboard reads, device-event ingestion (`POST /api/events`),
  camera frame posts, and login/auth traffic — not just one hot endpoint.
- Kafka: `kafka-producer-perf-test.sh` / `kafka-consumer-perf-test.sh` (shipped with the broker) for
  isolating broker/partition throughput independent of the app tier.
- `pgbench` for isolating Postgres throughput independent of the app tier, especially before/after
  PgBouncer and before/after the read replica.

### 5.2 What to measure at every phase
| Signal | Why it matters here specifically |
|---|---|
| p50/p95/p99 latency | Catches the auth-path serial-DB-calls tax (bottleneck #2) directly — watch p95/p99 collapse after Phase 1's cache lands |
| Error rate (4xx/5xx/timeouts) | Distinguishes "slow" from "falling over" — critical once the Postgres pool or Redis is saturated |
| Postgres: active connections vs. `max_connections`, slow query log | Confirms whether PgBouncer/read-replica actually relieved bottleneck #5 |
| Kafka consumer lag on `frs.jetson-device-events` | Confirms Phase 0's cutover didn't regress ingestion, and later confirms partition/consumer scale-out is working |
| Redis ops/sec and hit rate on the new auth cache | Confirms Phase 1's cache is actually being hit, not bypassed |
| CPU/mem per PM2 instance and per host | Confirms Phase 1's instance-count bump is actually using the idle 75% of the host identified in bottleneck #3 |

### 5.3 Validation gates between phases
- **Phase 0 → Phase 1:** Kafka producer/consumer reconnect cleanly post-cutover, consumer lag at
  baseline, zero message loss across the systemd switch (verify via a burst of test events
  produced immediately before and after the cutover window).
- **Phase 1 → Phase 2:** the auth cache must show a measured p95 latency drop and a measured drop
  in Postgres connections-in-use under the same load-test script run before and after — if either
  doesn't move, do not proceed to spending on horizontal infrastructure until it's understood why.
- **Phase 2 → Phase 3:** confirm near-linear scaling across app replicas (Section 4, Phase 2
  target) before committing to broker/DB-tier scale-out spend.
- **Phase 3 → Phase 4:** confirm Kafka partition scale-out actually increases consumer throughput
  (lag stays flat under higher produce rate) and that the read replica measurably offloads the
  primary, before running the final fleet-wide 1M RPS validation.

### 5.4 On the "1M RPS" number itself
Once Phase 1 produces a real, measured per-node sustained-RPS-at-budget-latency number, the fleet
size for Phase 4 is arithmetic: `fleet_app_nodes ≈ 1,000,000 / per_node_rps`, with Kafka partition
count, consumer replica count, and DB read-replica count each sized off the same measured,
per-component ceiling rather than assumed in advance. This document deliberately does not
pre-commit to a node count — doing so before Phase 1's measurement would be a guess dressed up as
a plan.
