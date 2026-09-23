# FRS Microservices Estate — Service & Contract Index

> Estate-level retrieval index for the coding agent. When a change crosses service
> boundaries (an HTTP call, WebSocket event, or shared database table), consult this index
> to understand both sides of the contract without guessing.

## Service Registry

| Service | Port | Directory | Owns / Responsibilities | Stack | Summary Doc |
|---------|------|-----------|-------------------------|-------|-------------|
| `frs-core-api` (IAM) | 8082 | `frs-core-api/backend/api` | Authentication, Keycloak realm sync, MFA, user sessions (`/api/me/bootstrap`), users & roles (`/api/users`, `/api/admin/rbac`), internal provisioning (`/api/internal`) | Node.js (ESM), Express, PostgreSQL, Redis | `docs/architecture/frs-core-api.md` |
| `frs-fe-api` | 8080 | `frs-fe-api` | All frontend business APIs: Employees, Visitors, Attendance, Cameras, Sites, Analytics, Notifications, UI Manifest (`/api/me/manifest`), UI Preferences (`/api/me/preferences`), Socket.IO hub | Node.js (ESM), Express, PostgreSQL, Redis, Socket.IO | `docs/architecture/frs-fe-api.md` |
| `frs-edge-api` | 8081 | `frs-edge-api` | Jetson edge box & camera ingestion: Device auth (`authenticateDevice`), camera frame ingest (`/api/frames/*`), Jetson face enrollment (`/api/employees/:id/enroll-face-direct`), heartbeats | Node.js (ESM), Express, PostgreSQL, Redis | `docs/architecture/frs-edge-api.md` |
| `frs-web-ui` | 5173 | `frs-web-ui` | React SPA dashboard: Live feeds, attendance logs, visitor registration, employee management, system administration | React 18, TypeScript, Vite, TailwindCSS | `docs/architecture/frs-web-ui.md` |
| `face-quality` | 5050 | `frs-core-api/backend/api/scripts` | Face image quality assessment, orientation checks, Mediapipe landmark scoring | Python 3, Flask, Mediapipe, ONNX | `docs/architecture/_core.md` |
| `api-transport` | 4002 | `frs-core-api/backend/api-transport` | Vehicle/transport management module (preserved, standalone Spring Boot service) | Java 17, Spring Boot, Maven, PostgreSQL | `frs-core-api/docs/PATTERNS.md` |

---

## Cross-Service Contract Index

### 1. Synchronous HTTP / API Routing (Reverse Proxy & Client Calls)

| Caller | Callee / Endpoint | Protocol / Port | Purpose & Contract |
|--------|-------------------|-----------------|--------------------|
| `frs-web-ui` (Vite Proxy) | `frs-core-api` (`/api/auth/*`, `/api/me/bootstrap`, `/api/users/*`, `/api/admin/rbac/*`, `/api/internal/*`) | HTTP / 8082 | User authentication, token exchange, session bootstrap, RBAC user management |
| `frs-web-ui` (Vite Proxy) | `frs-fe-api` (`/api/*` — business & retail endpoints) | HTTP / 8080 | Dashboard business data, employees, visitors, analytics, attendance, `/api/me/manifest`, `/api/me/preferences` |
| Jetson / Edge Box | `frs-edge-api` (`/api/devices/*`, `/api/frames/*`, `/api/employees/:id/enroll-face-direct`) | HTTP / 8081 | Edge device heartbeats, raw frame ingest, direct 512-d ArcFace vector enrollment |
| `frs-fe-api` | `face-quality` (`http://localhost:5050/score`) | HTTP / 5050 | Pre-enrollment image quality check before storing face vectors in Postgres |
| `frs-edge-api` | `face-quality` (`http://localhost:5050/score`) | HTTP / 5050 | Fallback face quality check when edge device does not provide pre-computed quality score |

### 2. Asynchronous (WebSocket, Redis Pub/Sub & Workers)

| Channel / Topic | Producer | Consumer | Notes |
|-----------------|----------|----------|-------|
| Socket.IO rooms (`site:<id>`, `camera:<id>`) | `frs-fe-api` (and Redis emitter from `frs-edge-api`) | `frs-web-ui` | Real-time recognition alerts, camera status, attendance toast updates |
| Redis Pub/Sub (`frs:events`) | `frs-edge-api` | `frs-fe-api` | Broadcasts verified edge face matches to trigger Socket.IO notifications to web clients |
| `deviceEventConsumer.js` | Kafka topic `device-events` | Postgres DB | Offline or batched device event processing worker |

---

## Common Infrastructure & Shared Contracts

- **Database:** PostgreSQL (shared logical database or shared schemas: `users`, `employees`, `visitors`, `cameras`, `attendance_logs`, `sites`).
- **Cache & Session:** Redis (shared Redis instance for rate limiting, token blocklist, Socket.IO adapter).
- **JWT Authentication:** All microservices (`frs-core-api`, `frs-fe-api`, `frs-edge-api`) independently verify RS256/HS256 tokens using the same Keycloak realm public key / JWKS URL.
- **Edge Box Authentication:** `frs-edge-api` enforces `authenticateDevice` middleware via device tokens and HMAC signatures.

---

## Retrieval Rules for Agents
1. Read `docs/ARCHITECTURE.md` (the router) for global orientation.
2. If touching a specific service, read its shard under `docs/architecture/<service>.md`.
3. If changing an endpoint or shared contract, consult the tables above to ensure callers and callees remain synchronized.
