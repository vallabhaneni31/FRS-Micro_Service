# Architecture Shard: frs-edge-api (Edge Box & Device Ingest Service)

> Applies to: `frs-edge-api/**`
> Port: `8081` | Entry: `frs-edge-api/src/server.js` | Stack: Node.js (ESM), Express, PostgreSQL, Redis

## Depends on / Used by
- **Used by:** Jetson Orin/Nano edge boxes, ONVIF/RTSP IP cameras, Edge runner C++ daemons
- **Emits to:** Redis Pub/Sub (`frs:events`) to broadcast match events to `frs-fe-api`
- **Depends on:** PostgreSQL (device registries, face feature vectors, attendance logs), Redis (heartbeats, caching)

## Responsibilities & Boundaries
`frs-edge-api` is exclusively responsible for IoT, edge devices, and camera streams:
1. **Device Management & Auth:** Edge box onboarding, token verification (`authenticateDevice`), device heartbeat tracking (`/api/devices/*`)
2. **Camera Ingestion:**
   - Raw frame ingest: `POST /api/frames/rtsp/:cameraId` and `POST /api/frames/smart/:cameraId`
   - Camera health status: `POST /api/cameras/:id/heartbeat`
3. **Jetson Direct Vector Enrollment:**
   - `POST /api/employees/:employeeId/enroll-face-direct`: Receives 512-dimension ArcFace vectors extracted directly by the Jetson C++ engine and stores them in PostgreSQL
4. **Attendance Event Ingestion:**
   - Batched and real-time face recognition log ingestion from edge devices (`POST /api/edge/events`)

> [!IMPORTANT]
> `frs-edge-api` endpoints require device authentication (`authenticateDevice` middleware) rather than user session JWTs.

## Key Files & Entry Points
- Server entry: `frs-edge-api/src/server.js:1`
- Express app config: `frs-edge-api/src/app.js:1`
- Device auth middleware: `frs-edge-api/src/middlewares/authDevice.js:1`
- Frame ingest routes: `frs-edge-api/src/routes/frameRoutes.js:1`
- Direct enrollment route: `frs-edge-api/src/routes/edgeEmployeeRoutes.js:1`
- Device event controller: `frs-edge-api/src/controllers/deviceEventController.js:1`
- Redis event publisher: `frs-edge-api/src/services/eventPublisher.js:1`

## Tests & Quality Gates
- Test command: `cd frs-edge-api && npm test` (`node --test src/tests/*.test.js`)
