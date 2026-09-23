# Design: Prune Duplicate and Unwanted Codebase Across Microservices

| | |
|---|---|
| **Spec** | `specs/0002-prune-duplicate-and-unwanted-codebase` |
| **Project / service** | `frs-core-api` (IAM), `frs-fe-api`, `frs-edge-api`, `frs-web-ui`, `face-quality` |
| **Status** | Draft |
| **Author** | Antigravity (Edith) |
| **Date** | 2026-09-17 |

> The HOW document for `requirements.md` (same folder). Describes current behavior,
> target contracts, directory modifications, PM2 topology, test strategy mapping, and final acceptance gate.

## 1. Deep Dive Findings & Current Behavior

A deep-dive audit of all endpoints in `frs-core-api`, `frs-fe-api`, and `frs-edge-api` revealed two critical edge-box gaps that occurred during the initial microservice split, plus the exact boundaries of `api-retail` and IAM:

### Finding 1: Missing Direct ArcFace Enrollment Route in `frs-edge-api`
In [frs-fe-api/src/routes/employeeRoutes.js:656-680](file:///c:/Users/UmaVenkataKarthikVal/Desktop/FRS/FRS_Application_AWS/Micro-Service/frs-fe-api/src/routes/employeeRoutes.js#L656-L680):
`POST /api/employees/:employeeId/enroll-face-direct` accepts pre-computed 512-d ArcFace embeddings directly from Jetson hardware and gates on `authenticateDevice`. This is an edge-device route, but it was mistakenly left in `frs-fe-api` and is completely absent from `frs-edge-api`.
- **Resolution**: Port this endpoint into `frs-edge-api/src/routes/employeeRoutes.js` (or `faceRoutes.js`) with `authenticateDevice`, and remove it from `frs-fe-api`.

### Finding 2: Missing Camera Frame Injection Routes in `frs-edge-api`
In [frs-core-api/backend/api/src/server.js:495,528](file:///c:/Users/UmaVenkataKarthikVal/Desktop/FRS/FRS_Application_AWS/Micro-Service/frs-core-api/backend/api/src/server.js#L495):
- `POST /api/frames/rtsp/:cameraId`
- `POST /api/frames/smart/:cameraId`
Both routes require `authenticateDevice`. [frs-fe-api/src/server.js:93-95](file:///c:/Users/UmaVenkataKarthikVal/Desktop/FRS/FRS_Application_AWS/Micro-Service/frs-fe-api/src/server.js#L93-L95) explicitly notes that these were dropped from `frs-fe-api` because they belong in `frs-edge-api`. However, `frs-edge-api` never mounted them.
- **Resolution**: Mount `POST /api/frames/rtsp/:cameraId` and `POST /api/frames/smart/:cameraId` in `frs-edge-api/src/server.js`.

### Finding 3: Retail Vertical (`api-retail`) Complete Division
The 10 routes in [backend/api-retail/src/index.js](file:///c:/Users/UmaVenkataKarthikVal/Desktop/FRS/FRS_Application_AWS/Micro-Service/frs-core-api/backend/api-retail/src/index.js#L31-L44) are mapped across `frs-edge-api` and `frs-fe-api`:
- **`frs-edge-api/src/retail/`** (Device-facing):
  - `POST /api/v1/retail/devices/:id/heartbeat` (Device telemetry ping)
  - `POST /api/v1/retail/devices/:id/health` (Firmware alias)
  - `POST /api/v1/retail/devices/:id/snapshot` (Device pushes annotated frame)
  - `POST /api/v1/retail/devices/:id/count` (Device pushes count event)
  - `POST /api/v1/retail/devices/:id/occupancy` (Device pushes occupancy state)
  - `GET /api/v1/retail/health`
- **`frs-fe-api/src/retail/`** (User/Admin-facing):
  - `GET /api/v1/retail/health`
  - `POST/GET /api/v1/retail/stores` (Store CRUD)
  - `GET/POST /api/v1/retail/stores/:storeId/cameras` (Store camera mapping)
  - `POST /api/v1/retail/devices/register` (Owner registers device)
  - `GET /api/v1/retail/devices` (Owner lists devices)
  - `GET /api/v1/retail/devices/:id/snapshot` (User views snapshot)
  - `GET /api/v1/retail/devices/:id/snapshot/cameras` (Live camera tiles)
  - `GET /api/v1/retail/devices/:id/snapshot/stream` (SSE live stream)
  - `GET /api/v1/retail/stores/:id/live`, `GET /api/v1/retail/stores/:id/history` (Store dashboards)
  - `GET /api/v1/retail/stores/:id/reports` (Retail reports)
  - `GET/PUT /api/v1/retail/settings` (Tenant settings)
  - `POST/GET /api/v1/retail/invite` (Staff invitations)
Because both halves are fully implemented in `frs-edge-api` and `frs-fe-api`, the duplicate directory `frs-core-api/backend/api-retail` can be safely removed.

### Finding 4: Transport Service (`backend/api-transport`)
Per user instruction, the transport service (`backend/api-transport/`) is ignored and left unchanged in this pass.

---

## 2. Complete Endpoint Architecture & Scope Matrix

```
                     [frs-web-ui (Port 5173)]
                                │
       ┌────────────────────────┴────────────────────────┐
       │             Vite Dev Server Proxy               │
       ▼                                                 ▼
/api/auth, /api/me/bootstrap,                   /api/* (All business routes)
/api/users, /api/admin/rbac                     /socket.io, /uploads
       │                                                 │
       ▼                                                 ▼
[frs-core-api (Port 8082)]                      [frs-fe-api (Port 8080)]
  IAM Surface Only                                Human / Browser Business Surface
  - /api/auth/*                                   - /api/attendance/* (Reports, stats)
  - /api/auth/mfa/*                               - /api/employees/* (CRUD, profile)
  - /api/me/bootstrap                             - /api/cameras/* (Admin CRUD, stream)
  - /api/users/*                                  - /api/devices/* (Admin CRUD)
  - /api/admin/rbac/*                             - /api/dashboard, reports, search
  - /api/internal/*                               - /api/alerts, incidents, watchlists
  - /api/docs                                     - /api/face/* (Search, verify, CRUD)
                                                  - /api/face/sync/trigger-enrollment
                                                  - /api/jetson/photos/:filename (UI)
                                                  - /api/v1/retail/* (Stores, dashboard)
                                                  - Crons: Retention, Reminders, Drift
                                                         ▲
                                                         │ Quality calls (:5050)
                                                         ▼
                                       ┌───────────────────────────────────┐
                                       │ [face-quality Sidecar (Port 5050)]│
                                       │ Python Flask / InsightFace ONNX   │
                                       │ - POST /quality (Photo Scoring)   │
                                       │ - POST /embedding (Fallback)      │
                                       └───────────────────────────────────┘
                                                         ▲
                                                         │ Embed fallback (:5050)
                                                         ▼
                                            [frs-edge-api (Port 8081)]
                                              Edge / Jetson Box Surface Only
                                              - /api/bootstrap/* (Claim token)
                                              - /api/events/* (Event/photo upload, commands)
                                              - /api/face/sync/* (Embeddings, cameras pull)
                                              - /api/face/recognize (Recognition fallback)
                                              - /api/cameras/* (Heartbeat, sync)
                                              - /api/devices/* (Heartbeat, quality scoring)
                                              - /api/device-management/* (Heartbeat, config)
                                              - /api/attendance/* (Frame, bulk-sync, dir)
                                              - /api/jetson/* (Firmware heartbeat)
                                              - POST /api/employees/:id/enroll-face-direct
                                              - POST /api/frames/rtsp/:cameraId
                                              - POST /api/frames/smart/:cameraId
                                              - /api/v1/retail/devices/* (Heartbeat, count)
```

---

## 3. PM2 Process Topology & Observability Governance

### 3.1 PM2 Process Map

| PM2 Process Name | Entrypoint | Port / Target | Responsibility |
|---|---|---|---|
| `frs-fe-api` | `frs-fe-api/src/server.js` | 8080 | Frontend business API, WebSocket hub, and business crons |
| `frs-edge-api` | `frs-edge-api/src/server.js` | 8081 | Edge device ingest, Jetson heartbeats, frame processing |
| `frs-iam-api` (`frs-core-api`) | `frs-core-api/backend/api/src/server.js` | 8082 | IAM authentication, user management, RBAC, session bootstrap |
| `face-quality` | `backend/api/scripts/face_quality_service.py` | 5050 | Python AdaFace/InsightFace quality scoring & embedding fallback |
| `frs-device-event-consumer` | `src/workers/deviceEventConsumer.js` | Kafka worker | Background processor for `frs.jetson-device-events` |
| `frs-dead-letter-monitor` | `src/workers/deadLetterMonitor.js` | Kafka worker | Monitors dead-letter queue for failed ingest messages |

### 3.2 Logging and Tracing Architecture

1. **Pino Structured JSON Logger (`utils/logger.js`)**:
   - Standardized JSON format with timestamps, log levels, correlation IDs, and module context.
   - Preserved across all three Node services.
2. **Distributed Correlation Tracing (`W-06` / `middleware/correlationId.js`)**:
   - Injects and propagates `X-Request-ID` on all incoming and outgoing HTTP and WebSocket calls.
   - Enables end-to-end tracing between UI proxy, IAM (8082), FE-API (8080), and Edge-API (8081).
3. **Security Audit Logging (`FIX-015` / `middleware/securityEventLogger.js`)**:
   - Automatically intercepts all 401, 403, and 429 status responses and writes security event records to the PostgreSQL `audit_log` table with caller IP, tenant ID, and endpoint path.
4. **PM2 Log File Convention**:
   - Out/Error logs output to `~/.pm2/logs/<app-name>-out.log` and `~/.pm2/logs/<app-name>-error.log`.
   - Local development scripts (`up.sh --logs-only`) pipe outputs to `/tmp/frs-core-api.log`, `/tmp/frs-fe-api.log`, `/tmp/frs-edge-api.log`, `/tmp/frs-web-ui.log`.

---

## 4. Detailed File Deletion & Modification Plan

### 4.1 `frs-edge-api` Modifications
- **Add** `POST /api/employees/:employeeId/enroll-face-direct`:
  Create `frs-edge-api/src/routes/employeeRoutes.js`, mount under `/api/employees`, and gate on `authenticateDevice` with 512-d ArcFace validation.
- **Add** `POST /api/frames/rtsp/:cameraId` and `POST /api/frames/smart/:cameraId`:
  Mount under `frs-edge-api/src/server.js` with `authenticateDevice`.

### 4.2 `frs-fe-api` Modifications
- **Modify** `src/routes/employeeRoutes.js`: Remove `POST /:employeeId/enroll-face-direct` handler and unused `authenticateDevice` import.
- **Retain** all 31 route files in `src/routes/` and all 10 retail route files in `src/retail/routes/`.
- **Retain** business crons in `src/jobs/`.

### 4.3 `frs-core-api` Modifications
- **Modify** `backend/api/src/server.js`: Keep imports and mounts only for:
  - `authRoutes`, `mfaRoutes`, `meRoutes`, `userRoutes`, `rbacRoutes`, `internalRoutes`, `swaggerRoutes`.
  - Disable calls to `startDataRetentionCron`, `startDeviceOfflineCron`, `startEnrollmentReminderCron`.
- **Delete** 27 non-IAM route files from `backend/api/src/routes/`:
  `alertRoutes.js`, `incidentRoutes.js`, `watchlistRoutes.js`, `confidenceReviewRoutes.js`, `liveRoutes.js`, `deviceRoutes.js`, `attendanceRoutes.js`, `employeeRoutes.js`, `dashboardRoutes.js`, `searchRoutes.js`, `faceRoutes.js`, `reportRoutes.js`, `hrRoutes.js`, `jetsonRoutes.js`, `enrollmentRoutes.js`, `cameraRoutes.js`, `siteRoutes.js`, `deviceManagementRoutes.js`, `hrmsIntegrationRoutes.js`, `siteManagementRoutes.js`, `appAdminRoutes.js`, `manifestRoutes.js`, `tenantAdminRoutes.js`, `monitoringRoutes.js`, `configRoutes.js`, `deviceEventsRoutes.js`, `bootstrapRoutes.js`, `faceSyncRoutes.js`, `deviceTokenRoutes.js`, `biometricConsentRoutes.js`, `studentsRoutes.js`, `peopleRoutes.js`.
- **Delete** 16 non-IAM controllers from `backend/api/src/controllers/`:
  `AppAdminController.js`, `AttendanceController.js`, `DashboardController.js`, `DeviceController.js`, `DeviceEventController.js`, `DeviceHierarchyController.js`, `DeviceManagementController.js`, `EmployeeController.js`, `EnrollmentController.js`, `FaceController.js`, `IncidentController.js`, `ReportController.js`, `SearchController.js`, `SiteController.js`, `TenantAdminController.js`, `VisitorController.js`.
- **Delete** business services from `backend/api/src/services/`:
  `src/services/business/`, `src/services/alerting/`, `src/services/ai-evaluation/`, `visitorValidationService.js`, `gdprErasureService.js`, `livePresenceService.js`.
- **Preserve Required Scripts & Sidecars**:
  - `backend/api/scripts/face_quality_service.py`
  - `backend/api/scripts/mediapipe_engine.py`
  - `backend/api/scripts/requirements.txt`
  - `backend/api/src/workers/deviceEventConsumer.js`
  - `backend/api/src/workers/deadLetterMonitor.js`
  - `backend/api/scripts/create-topics.js`
- **Delete** `backend/api-retail/`.
- **Retain** `backend/api-transport/` (ignored per user direction).

### 4.4 Root Artifacts to Delete
- In `frs-core-api` root:
  `diagram1_corporate_relational_er.png`, `diagram2_corporate_storage_relationship.png`, `diagram3_corporate_enrollment_flow.png`, `test_mermaid.png`, `all_diagrams_overview.md`, `reconciliation_summary.md`, `storage_relationship_diagram_corporate.md`, `enrollment_data_flow_diagram_corporate.md`, `er_diagram_corporate_relational.md`, `owner-dashboard.html`, `query_check.js`, `document.md`, `dist/`.
- In `frs-web-ui` root:
  `test-canNext.js`, `test-csc.js`, `test-csc.mjs`.

---

## 5. Test Strategy & Traceability Matrix

| Req | Acceptance Criterion | Test Verification Method |
|---|---|---|
| **1.1** | `enroll-face-direct` in `frs-edge-api` | Unit test posting 512-d vector with device token expecting 200/201 |
| **1.2** | Frame ingest in `frs-edge-api` | Test posting frame data to `/api/frames/rtsp/:id` expecting 202 |
| **1.3** | Retain core edge routes in `frs-edge-api` | Automated route introspection confirming all 9 edge route files mounted |
| **1.4** | Retain retail edge routes in `frs-edge-api` | Automated route test asserting `/api/v1/retail/devices/:id/heartbeat` active |
| **1.5** | Device auth rejection | Unauthenticated request to edge endpoints returns 401 |
| **2.1** | Remove `enroll-face-direct` from `frs-fe-api` | Inspection test asserting route does not exist in `fe-api/src/routes/employeeRoutes.js` |
| **2.2** | Retain business routes in `frs-fe-api` | Automated route introspection confirming 31 business routes mounted |
| **2.3** | Retain retail routes in `frs-fe-api` | Automated test checking `/api/v1/retail/stores` and `/snapshot/cameras` mounted |
| **2.4** | Fe crons active | Startup check asserting retention, reminder, drift crons initialize |
| **3.1** | Mount only IAM in `frs-core-api` | Express route list test confirming only IAM paths mounted |
| **3.2** | 27 non-IAM route files deleted | File existence check asserting zero business route files in `frs-core-api` |
| **3.3** | 16 non-IAM controllers deleted | File existence check asserting zero business controllers in `frs-core-api` |
| **3.4** | Business services deleted | Directory check asserting absence of `services/business/` in `frs-core-api` |
| **3.5** | Business crons disabled in core | Startup assertion that zero business crons are scheduled |
| **3.6** | Delete `backend/api-retail`, preserve `transport` | `!fs.existsSync('backend/api-retail')` AND `fs.existsSync('backend/api-transport')` |
| **4.1** | Preserve `face_quality_service.py` | `fs.existsSync('backend/api/scripts/face_quality_service.py')` |
| **4.2** | Face quality port 5050 communication | Integration test making HTTP GET/POST to `http://127.0.0.1:5050/health` |
| **4.3** | Preserve Kafka worker files | Assert `deviceEventConsumer.js` and `deadLetterMonitor.js` exist |
| **4.4** | Pino logging and correlation IDs | Verification test asserting JSON structure and `X-Request-ID` presence in responses |
| **5.1** | Delete loose diagrams in core | File existence check asserting diagram files deleted |
| **5.2** | Delete stray root scripts in core | File existence check asserting scratch scripts deleted |
| **5.3** | Delete stray root scripts in UI | File existence check asserting `test-canNext.js` etc. deleted |
| **6.1** | Clean startup via `up.sh` | Execution of `up.sh` with HTTP status checks on 8082, 8080, 8081, 5173 |
| **6.2** | Vite proxy to `frs-core-api` | HTTP GET via Vite dev server to `/api/auth/health` reaches :8082 |
| **6.3** | Vite proxy to `frs-fe-api` | HTTP GET via Vite dev server to `/api/health` reaches :8080 |
| **6.4** | Edge requests to :8081 | HTTP POST to edge endpoints on :8081 returns valid response |

---

## 6. Final Acceptance Gate

The refactoring is verified and completed when:
1. `frs-edge-api` exposes both `enroll-face-direct` and `/api/frames/*` with passing tests.
2. `face_quality_service.py` and `mediapipe_engine.py` are verified intact and startable.
3. `frs-fe-api` passes all tests with non-edge business and retail routes intact.
4. `frs-core-api` is stripped to IAM-only, builds cleanly with `node --check`, and passes tests.
5. `backend/api-transport` remains untouched.
6. All 4 services start up cleanly under `up.sh` and respond on their configured ports (8082, 8080, 8081, 5173).
