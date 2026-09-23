# FRS Microservices Estate — Architecture Router

> Auto-maintainable architectural map for the Face Recognition System (FRS) estate.
> This file is the top-level router: orient here first, then open the specific service shard.
> Source of truth is the code; if this disagrees with the code, the code wins.
> Cross-service contract index: see `docs/ESTATE.md`.

## What it is
The Face Recognition System (FRS) is a distributed enterprise biometric attendance, visitor management, and video surveillance platform. It is architected into 4 focused services:
- `frs-core-api` (Port 8082): Pure IAM (Auth, Keycloak, MFA, Users, RBAC)
- `frs-fe-api` (Port 8080): Frontend Business API (Employees, Visitors, Attendance, Socket.IO hub)
- `frs-edge-api` (Port 8081): Jetson edge box & camera ingest (Frame ingestion, direct vector enrollment)
- `frs-web-ui` (Port 5173): React / Vite single page application

Auxiliary sidecars include `face-quality` (Python Flask :5050) and `api-transport` (Spring Boot :4002).

## Estate Structure

| Service / Area | Base Path / Directory | Port | Shard Map |
|----------------|----------------------|------|-----------|
| IAM Service | `frs-core-api/backend/api` | 8082 | `docs/architecture/frs-core-api.md` |
| Business API | `frs-fe-api` | 8080 | `docs/architecture/frs-fe-api.md` |
| Edge Ingest API | `frs-edge-api` | 8081 | `docs/architecture/frs-edge-api.md` |
| Web UI | `frs-web-ui` | 5173 | `docs/architecture/frs-web-ui.md` |
| Shared Contracts | Root / Cross-cutting | — | `docs/architecture/_core.md` |
| Transport Module | `frs-core-api/backend/api-transport` | 4002 | `frs-core-api/docs/PATTERNS.md` |

## Data & Persistence
- **Primary Database:** PostgreSQL (relational tables for users, roles, employees, visitors, cameras, sites, attendance logs, face embeddings).
- **Cache & Message Broker:** Redis (session rate limiting, token revocation blocklist, Socket.IO multi-process adapter, event pub/sub).
- **Object Storage:** AWS S3 / MinIO (storing raw employee photos, visitor snapshot images, audit crops).

## Events / Async / Side-Effects
- **WebSockets:** `frs-fe-api` hosts Socket.IO rooms for real-time camera alerts, recognition events, and device disconnect warnings.
- **Redis Pub/Sub:** `frs-edge-api` publishes edge match events to `frs:events`, which `frs-fe-api` ingests and forwards to connected browser clients.
- **Crons:** `frs-fe-api` executes automated shift transitions, daily attendance calculation, and database archiving crons.

## External / Cross-Service Calls
| Client / Proxy | Target | Protocol / Port | Purpose |
|----------------|--------|-----------------|---------|
| `frs-web-ui` (Vite) | `frs-core-api` | HTTP :8082 | Auth, MFA, session bootstrap (`/api/me/bootstrap`), user administration |
| `frs-web-ui` (Vite) | `frs-fe-api` | HTTP :8080 | Business CRUD, attendance records, UI manifest (`/api/me/manifest`), Socket.IO |
| Jetson Runner / Edge | `frs-edge-api` | HTTP :8081 | Heartbeats, RTSP frame ingestion, 512-d ArcFace vector enrollment |
| `frs-fe-api` / `frs-edge-api` | `face-quality` | HTTP :5050 | Image quality check and landmark validation |

## Module Contract Index (The Join Table)

| Contract / Endpoint | Produced By | Consumed By | Defined At |
|---------------------|-------------|-------------|------------|
| `GET /api/me/bootstrap` | `frs-core-api` | `frs-web-ui` (`AuthContext`) | `frs-core-api/backend/api/src/controllers/meController.js:1` |
| `GET /api/me/manifest` | `frs-fe-api` | `frs-web-ui` (`useManifest`) | `frs-fe-api/src/controllers/manifestController.js:1` |
| `POST /api/employees/:id/enroll-face-direct` | `frs-edge-api` | Jetson C++ engine | `frs-edge-api/src/routes/edgeEmployeeRoutes.js:1` |
| `POST /api/frames/rtsp/:cameraId` | `frs-edge-api` | Camera Ingest Daemon | `frs-edge-api/src/routes/frameRoutes.js:1` |
| `POST /score` | `face-quality` | `frs-fe-api`, `frs-edge-api` | `scripts/face_quality_service.py:1` |
| `frs:events` (Redis channel) | `frs-edge-api` | `frs-fe-api` | `frs-edge-api/src/services/eventPublisher.js:1` |

## Keeping This Fresh
Regenerate or run `/edith-refresh` whenever routes, database schemas, or cross-service contracts change. Agents touching code in `auto` doc-maintenance mode update the relevant shard in the same pass as their code edits.
