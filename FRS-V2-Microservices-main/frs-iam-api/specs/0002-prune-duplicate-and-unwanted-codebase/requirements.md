# Requirements: Prune Duplicate and Unwanted Codebase Across Microservices

| | |
|---|---|
| **Ticket** | REFACTOR-002 |
| **Project / service** | frs-core-api (frs-iam-api), frs-fe-api, frs-edge-api, frs-web-ui |
| **Stack** | Node.js ESM (Express), TypeScript / React (Vite), Python 3 (Flask/InsightFace) |
| **Status** | Approved (partial scope — see Revision 7) |
| **Author** | Antigravity (Edith) |
| **Date** | 2026-09-17 |

> One spec = one folder `specs/NNNN-<slug>/` holding `requirements.md` (this file — the WHAT and
> WHY), `design.md` (the HOW), and `tasks.md` (the ordered execution plan). This file is the
> contract the human approves; the other two derive from it.

## Revisions

| # | What changed | Why | Requirements affected |
|---|--------------|-----|-----------------------|
| 1 | Initial specification draft | Initial feature request | All |
| 2 | Deep-dive endpoint audit & transport scoping | Include missing edge-box endpoints (enroll-face-direct, /api/frames/*), verify 100% coverage of api and api-retail across fe and edge, preserve IAM, ignore transport per user guidance | 1, 2, 3, 4, 6 |
| 3 | Sidecar & background service governance | Explicitly protect PM2 services (face-quality on port 5050, Kafka consumers), preserve structured logging (Pino, correlation IDs, audit logs), and prevent deletion of required operational scripts | 1, 2, 3, 5, 7 |
| 4 | Reconciled AC checkboxes against `frs-core-api`'s actual state (checked via direct file/grep verification, not assumed) | Two untracked commits (`8d4fcf6b`, `47468c93`) had already landed most of Requirement 3 before this spec's own tracking caught up — the paper needs to match reality before this can be approved | 3, 5 |
| 5 | Corrected a false claim from Revision 4 that `frs-fe-api`/`frs-edge-api` are inaccessible | They're present as workspace siblings; Revision 4 was written without re-checking the workspace root | 1, 2, 6 |
| 6 | Verified every remaining AC across `frs-fe-api` and `frs-edge-api` (Requirements 1, 2, 6) with file:line evidence | Completing the correction — Revision 5 fixed the false "inaccessible" claim but hadn't yet checked the ACs themselves | 1, 2, 6 |
| 7 | Approved for a **partial** build only: AC 2.1, 3.4, 3.5, 3.6, and Task 6's root cleanup (minus 5.1's `reconciliation_summary.md`/`document.md`). **Explicitly NOT approved this pass**: AC 1.1/1.2/1.3 (edge endpoint move — unresolved path/method mismatch, needs a human call first), AC 3.1 (removing `/uploads`+`/api/frames/*` from `frs-core-api` — would break device frame ingestion until 1.2 lands in `frs-edge-api`, so it's blocked on that, not independently approvable), AC 4.2/6.1/6.4 (live-run checks, not a build task), 5.1's two flagged docs (human should skim first, not a blind delete) | Human wants incremental, fully-verified, non-destructive-first progress rather than the whole spec at once | 1, 3, 5 |
| 8 | Built the approved scope across all 3 repos (`frs-fe-api`, `frs-core-api`, `frs-web-ui`), one `developer` agent per repo, results independently re-verified before trusting. AC 2.1, 3.5, 3.6, 5.2, 5.3 now **MET**; AC 3.4, 5.1 now **PARTIALLY MET** (deliberately, per plan-mode scope). `services/business/` explicitly excluded from AC 3.4, per a separate plan-mode decision — see `WALKTHROUGH.md` for the full step-by-step log. **Real gap introduced, not just paper**: `enroll-face-direct` now existed in neither `frs-fe-api` nor `frs-edge-api` — Task 1 was not built this pass | Completing the approved partial build | 2, 3, 5 |
| 9 | Closed the gap Revision 8 introduced: built AC 1.1 in `frs-edge-api` (new `employeeRoutes.js`, ported from the exact removed handler, adapted to device-auth) | Human asked what the fix was; AC 1.1 alone had no ambiguity (unlike 1.2/1.3), so it didn't need to wait for those | 1, 2 |
| 10 | Investigated AC 1.2 before building it (human asked to build it as a "no open question" item) — found the `/api/frames/*` pipeline is already dead code (queue nothing drains, rule engine already deleted in `47468c93`) with a live apparent replacement (`/api/events/*` → Kafka) already in `frs-edge-api`. **Did not build** — reclassified as blocked on a product decision (does any fielded device still call the old paths?), not a technical one | Porting dead code under the banner of "completing the port" would have been wrong — this needed investigation, not mechanical execution | 1, 3 |
| 11 | Resolved all 3 remaining blocked decisions with the human: **AC 1.3** — spec wording corrected to match the real, working endpoints (no code change); **AC 3.4's `services/business/`** — permanently deferred, needs its own spec, not built under `0002`; **AC 5.1's 2 flagged docs** — permanently kept, not deleted. All three are now settled decisions, not open questions | Completing bucket B from the human's own framing | 1, 3, 5 |
| 12 | Resolved AC 1.2's Jetson-fleet question: human decided to **remove** the two dead frame routes rather than port them. Built: `POST /api/frames/rtsp/:cameraId` and `POST /api/frames/smart/:cameraId` deleted from `frs-core-api/backend/api/src/server.js`, plus the now-unused `authenticateDevice` import. `validationService`'s other two uses (health/stats) untouched. AC 1.2 retired (not deferred — the endpoints no longer exist anywhere). AC 3.1 now only blocked on the unrelated, still-live `/uploads` endpoint | Human explicitly answered the open question ("remove them") after reviewing what the edge-device contract requires | 1, 3 |

## 1. Problem / Goal

The FRS platform has split from a monolith into distinct microservices:
1. `frs-core-api` (tracked as `frs-iam-api` on remote `origin`): Identity and Access Management (auth, MFA, session bootstrap, user management, RBAC, internal provisioning, API documentation).
2. `frs-fe-api`: Frontend-facing business API (attendance, employees, sites, dashboards, reports, alerts, retail admin, etc.).
3. `frs-edge-api`: Edge-facing Jetson and device API (device sync, face sync, heartbeats, frame ingest, retail device ingest).
4. `frs-web-ui`: Frontend React application (Vite dev server proxying IAM routes to port 8082 and business routes to port 8080).
*(Note: `backend/api-transport` is excluded and ignored in this refactoring per user direction).*

In addition to the primary HTTP services, the operational ecosystem includes:
- **`face-quality` sidecar** (`face_quality_service.py` on port 5050): Python CV service providing AdaFace/InsightFace scoring for enrollment photos (`frs-fe-api`) and embedding extraction fallback for edge boxes (`frs-edge-api`).
- **Kafka workers**: `frs-device-event-consumer` and `deadLetterMonitor`.
- **Structured Logging & Observability**: Pino JSON logger, `X-Request-ID` correlation tracing (W-06), and security event audit logging (FIX-015).

During codebase pruning, there is a risk of accidentally deleting or breaking these auxiliary services, Python scripts, or logging pipelines. The goal is to prune `frs-core-api` strictly down to its IAM role, eliminate true duplicate and dead code, guarantee 100% endpoint coverage for `api` and `api-retail`, and ensure `face-quality`, workers, and logging remain fully protected and operational.

> **Correction (Revision 5):** Revision 4 wrongly claimed `frs-fe-api`/`frs-edge-api` weren't
> present in this workspace — they are, as siblings under `Micro-Service/` alongside a workspace-
> level `CLAUDE.md`/`docs/`/`specs/` this pass had missed. Requirements 1, 2, 6, and 5.3 **are**
> actionable from here. A spot-check (2026-09-17) found AC 1.1 and AC 2.1 both still unmet:
> `frs-edge-api/src/routes/` has no `enroll-face-direct` or `/api/frames/*` routes (grep, no
> match), and `frs-fe-api/src/routes/employeeRoutes.js:652-765` still has both a `POST` and a
> stray `GET /:employeeId/enroll-face-direct` — not removed. **The rest of Requirements 1/2/6/7's
> criteria were not individually re-verified this pass** — don't treat them as met or unmet without
> checking each one; this correction only fixes the "not actionable" claim, not full coverage.
> **Also note**: this spec spans 4 repos but lives only in `frs-core-api/specs/` — the workspace
> root has its own `specs/` with edith's folder templates; whether this spec should move there is
> a question for whoever owns spec placement, not decided here.

## 2. Scope

**In scope**
- **Edge Box Completeness (`frs-edge-api`)**:
  - Add `POST /api/employees/:employeeId/enroll-face-direct` to `frs-edge-api`.
  - Add `POST /api/frames/rtsp/:cameraId` and `POST /api/frames/smart/:cameraId` to `frs-edge-api`.
  - Retain all core and retail edge endpoints (`bootstrap`, `events`, `face/sync`, `recognize`, `cameras` [heartbeat/sync], `devices` [heartbeat/quality], `device-management` [heartbeat/config/commands/activate], `attendance` [frame/bulk-sync/direction], `jetson` [heartbeat], `retail` [devices/health/snapshot/count]).
- **Frontend Business API Completeness (`frs-fe-api`)**:
  - Remove the device-facing `enroll-face-direct` from `frs-fe-api/src/routes/employeeRoutes.js`.
  - Retain all 31 user/browser business routes in core FRS and all 10 retail routes in `src/retail/routes/`.
  - Retain business crons (`startDataRetentionCron`, `startEnrollmentReminderCron`, `startDriftMonitorCron`).
- **IAM Surface Preservation (`frs-core-api`)**:
  - Retain all IAM routes: `/api/auth/*`, `/api/auth/mfa/*`, `/api/me/bootstrap`, `/api/users/*`, `/api/admin/rbac/*`, `/api/internal/*`, `/api/docs`.
  - Prune `server.js` and delete all 27 non-IAM route files, 16 business controllers, business services (`business/`, `alerting/`, `ai-evaluation/`), and duplicate crons.
  - Remove `backend/api-retail/`.
- **Sidecar & Worker Governance**:
  - **Explicitly preserve** `face_quality_service.py`, `mediapipe_engine.py`, and `requirements.txt` under `backend/api/scripts/`.
  - **Explicitly preserve** Kafka worker scripts (`deviceEventConsumer.js`, `deadLetterMonitor.js`, `create-topics.js`).
  - Maintain structured Pino logging, correlation IDs, and security event loggers across all services.
- **Root Artifact Cleanup**:
  - Clean loose diagram images, notes, and scratch files from `frs-core-api` root and `frs-web-ui` root.

**Non-goals** (explicitly NOT doing)
- Touching or modifying `backend/api-transport/` (ignored per user instruction).
- Modifying shared database schemas or altering database migration files.
- Deleting Python CV sidecars or Kafka consumer workers.

## 3. Requirements

### Requirement 1 — Complete Edge Box API Surface in `frs-edge-api`
**User story:** As an edge device or Jetson appliance, I want all device-facing ingest, sync, heartbeat, and enrollment endpoints served by `frs-edge-api` on port 8081, so that edge boxes operate reliably without depending on the frontend API.

**Acceptance criteria**
- [x] **1.1** THE SYSTEM SHALL expose `POST /api/employees/:employeeId/enroll-face-direct` in `frs-edge-api`, verifying device authentication (`authenticateDevice`) and storing L2-normalized 512-d ArcFace embeddings.
  **MET, built 2026-09-17** — new `frs-edge-api/src/routes/employeeRoutes.js`, mounted at `/api/employees` in `server.js`, ported from the exact handler removed from `frs-fe-api` (same validation, duplicate-detection, and primary-photo logic), adapted to this repo's device-auth shape (`req.device.pk_device_id`, not `req.auth.user.id`) and its `writeAudit(...).catch(() => {})` convention. Includes the companion `GET` status-check route, re-gated with `authenticateDevice` (the original's `requirePermission` doesn't exist in a device-only service). Verified: `node --check` on both files, and a real module-load smoke test (imports resolve, no missing dependencies) — not a live HTTP/DB test.
- [ ] **1.2** ~~THE SYSTEM SHALL expose `POST /api/frames/rtsp/:cameraId` and `POST /api/frames/smart/:cameraId` in `frs-edge-api`~~, verifying device authentication (`authenticateDevice`) and queuing frame validation requests.
  **WON'T BUILD — decided 2026-09-17 (Revision 12).** Human decided to remove the two dead routes
  from `frs-core-api` rather than port them (see AC 3.1). This AC is retired, not deferred — the
  endpoints no longer exist anywhere in the estate. If a fielded device is later found to still
  call the old paths, that's a new problem to solve fresh, not a reason to un-retire this AC.
  **NOT MET** (verified 2026-09-17) — no match anywhere under `src/` (not even inline in `server.js`, unlike `frs-core-api` where these two routes currently still live).
  **BLOCKED on a product/architecture decision, investigated 2026-09-17 — do not build without this being resolved by a human:** the pipeline behind these routes (`ValidationService.validateAndQueueFrame()` → `ShutdownManager`'s in-memory per-camera queue) is already dead in `frs-core-api` — the queue has a pop method (`ShutdownManager`'s `frames.shift()`) but **nothing in the entire repo calls it**, and the per-camera rule-execution engine these frames were meant to be validated against (`core/rules/` — `AnimalCountingRule`, `FireSmokeRule`, `ZoneIntrusionRule`, etc.) was already deleted, in the same untracked commit (`47468c93`) that did the IAM trim, before this session started.
  **Independently confirmed by pre-existing team documentation**, not just this investigation — `docs/architecture/BACKEND_ARCHITECTURE_OVERVIEW.md:195-206` (written before this session) states outright: *"Two pipelines exist in this code. One is live."* It names the same framework (`core/managers`, `core/services/InferenceProcessorCore`, `core/workers/InferenceWorker`, `core/rules/*`) as "stubbed out" — `server.js` disables `ModelManager` with the comment `"disabled until Jetson online"` — and confirms the real traffic path is `routes/deviceEventsRoutes.js → DeviceEventService → Kafka → workers/deviceEventConsumer.js → Postgres/pgvector → Socket.IO`. That path already exists, live, in `frs-edge-api` (`deviceEventsRoutes.js` → `DeviceEventController` → `DeviceEventService` → the same Kafka consumer). The doc's framing — "disabled **until** Jetson online," not "disabled after being retired" — suggests this synchronous/rule-engine path may never have been fully activated in production, which lowers (but doesn't eliminate) the risk that live device firmware depends on it.
  Porting `ValidationService` + a `rule_config.json` + the rule engine to `frs-edge-api` would resurrect functionality the rest of the system has moved away from. Whoever owns the Jetson fleet should confirm no firmware still calls the old `/api/frames/*` paths before this AC is actioned either way (port it faithfully, or delete the two orphaned routes from `frs-core-api` and drop this AC from the spec entirely).
- [x] **1.3** THE SYSTEM SHALL retain all existing edge ingest endpoints in `frs-edge-api`:
  **MET — spec wording corrected 2026-09-17** (Revision 11) to match the real, working code rather
  than changing working code to match imprecise spec prose. Two endpoints were mis-described:
  device claim-token is `GET /api/bootstrap/:deviceCode` (`src/routes/bootstrapRoutes.js:33`), not
  `POST /api/bootstrap/claim-token`; the commands-executed callback is
  `POST /api/device-management/devices/:code/commands/:commandId/executed`
  (`src/routes/deviceManagementRoutes.js:35`), not under `/api/events`. Corrected below — every
  group is confirmed present and `authenticateDevice`-gated.
  - `GET /api/bootstrap/:deviceCode` (device claim-token — corrected from spec's original `POST /api/bootstrap/claim-token`)
  - `POST /api/events`, `POST /api/events/photo`, `POST /api/events/batch`, `GET /api/events/commands`; `POST /api/device-management/devices/:code/commands/:commandId/executed` (commands-executed callback — corrected from spec's original `/api/events/commands/:id/executed`)
  - `GET /api/face/sync/embeddings`, `GET /api/face/sync/employees`, `GET /api/face/sync/config`, `GET /api/face/sync/cameras`, `GET /api/face/sync/enrollment-pending`
  - `POST /api/face/recognize`
  - `POST /api/cameras/:camId/heartbeat`, `POST /api/cameras/device-sync`, `GET /api/cameras` (device query)
  - `POST /api/devices/:camId/heartbeat`, `POST /api/devices/nug-boxes/:code/heartbeat`, `GET /api/devices/nug-boxes/:code/pending-enrollments`, `POST /api/devices/nug-boxes/:code/enrollment-quality`, `GET /api/devices/enrollment-photos/:filename`
  - `POST /api/device-management/devices/:code/heartbeat`, `GET /api/device-management/device/config/:code`, `GET /api/device-management/devices/:code/commands`, `POST /api/device-management/devices/activate`
  - `POST /api/attendance/frame`, `POST /api/attendance/bulk-sync`, `POST /api/attendance/direction`
  - `ALL /api/jetson/:camId/heartbeat` (with `:nan` JSON sanitization)
- [x] **1.4** THE SYSTEM SHALL retain all retail edge endpoints under `/api/v1/retail/` in `frs-edge-api` (`devices/:id/heartbeat`, `health`, `snapshot`, `count`, `occupancy`).
  **MET** (verified 2026-09-17) — `RETAIL_BASE = "/api/v1/retail"` (`src/server.js:271-276`); `/:id/heartbeat`, `/:id/health`, `/:id/snapshot`, `/:id/count`, `/:id/occupancy` all present, all `authenticateDevice`-gated (`src/retail/routes/{deviceRoutes,snapshotRoutes,countRoutes}.js`). Note: a *second*, unauthenticated `GET /api/v1/retail/health` also exists (`healthRoutes.js:6`) as a plain service-liveness check, distinct from the per-device health this AC means — both exist, not a conflict.
- [x] **1.5** IF an unauthenticated device request is made to any protected edge route, THEN THE SYSTEM SHALL reject the request with HTTP status 401.
  **MET** (verified 2026-09-17) — `src/middleware/authenticateDevice.js` returns 401 on every rejection path (missing/malformed header, invalid/expired token, missing claims, device not found/decommissioned/revoked — never 403), and is actually applied (not just imported) across every protected route file checked.

### Requirement 2 — Restrict `frs-fe-api` to Pure Non-Edge Business Surface
**User story:** As a web client or API consumer, I want all human/browser business endpoints served by `frs-fe-api` on port 8080, with no orphaned edge-device routes remaining in the service.

**Acceptance criteria**
- [x] **2.1** WHEN `enroll-face-direct` is transferred to `frs-edge-api`, THE SYSTEM SHALL remove `POST /api/employees/:employeeId/enroll-face-direct` from `frs-fe-api/src/routes/employeeRoutes.js`.
  **MET, built 2026-09-17** — both the `POST` and stray `GET /:employeeId/enroll-face-direct` removed from `employeeRoutes.js` (was lines 652-774), along with the now-unused `authenticateDevice` import. The AC's own precondition ("WHEN transferred to `frs-edge-api`") is now also true — AC 1.1 confirms the route was added there in a follow-up pass the same day, closing what was briefly a real functional gap. Full detail: `WALKTHROUGH.md`.
- [x] **2.2** THE SYSTEM SHALL retain all user/browser business routes in `frs-fe-api` (Attendance history/reports/dwell/stats/corrections, Employees, Sites, Cameras admin/stream, Devices admin, Dashboard, Reports, Search, Alerts, Incidents, Watchlist, Face CRUD/groups/search/verify, FaceSync kiosk trigger, Jetson UI photos).
  **MET** (verified 2026-09-17) — all 14 named areas confirmed mounted and active in `src/server.js` (e.g. `/api/attendance:439`, `/api/employees:440`, `/api/face:444`, `/api/jetson:449` — 30 route files total, one under the spec's "~31," immaterial). `enroll-face-direct` (unmet, AC 2.1) is one route inside the otherwise-legitimate `employeeRoutes.js`, not the whole file.
- [x] **2.3** THE SYSTEM SHALL retain all user/browser retail routes under `/api/v1/retail/` in `frs-fe-api` (`stores`, `cameras`, `devices/register`, `devices` list, `devices/:id/snapshot` read & SSE stream, `settings`, `invite`, `health`).
  **MET** (verified 2026-09-17) — every named endpoint confirmed under `src/retail/routes/`, mounted at `src/server.js:462-470`.
- [x] **2.4** WHEN `frs-fe-api` starts up, THE SYSTEM SHALL execute `startDataRetentionCron`, `startEnrollmentReminderCron`, and `startDriftMonitorCron`.
  **MET** (verified 2026-09-17) — all three genuinely invoked (not just imported) in the server-start block: `src/server.js:714,719,723`.

### Requirement 3 — Restrict `frs-core-api` to Pure IAM Surface
**User story:** As a security engineer, I want `frs-core-api` focused strictly on Identity and Access Management on port 8082, with all non-IAM routes, controllers, and services eliminated.

**Acceptance criteria**
- [ ] **3.1** THE SYSTEM SHALL mount only IAM route handlers in `frs-core-api/backend/api/src/server.js`: `/api/auth`, `/api/auth/mfa`, `/api/me`, `/api/users`, `/api/admin/rbac`, `/api/internal`, and `/api/docs`.
  **PARTIALLY MET, built 2026-09-17 (Revision 12)** — `POST /api/frames/rtsp/:cameraId` and `POST /api/frames/smart/:cameraId` removed from `server.js` entirely (were the dead pipeline traced under AC 1.2 — human decided to delete, not port). The now-unused `authenticateDevice` import removed too; `validationService`'s other two uses (health/stats reporting, `server.js:290,340`) left untouched, still imported. **`/uploads` (`server.js:455`) still remains** — a live, working photo-serving endpoint (not dead code like the frame routes), out of scope for this decision; removing it needs its own call, not bundled into this cleanup. Verified: `node --check` passes; grep confirms zero remaining references to the removed routes or `authenticateDevice`.
- [x] **3.2** THE SYSTEM SHALL delete all 27 non-IAM route files from `frs-core-api/backend/api/src/routes/`.
  **MET** (verified 2026-09-17) — `backend/api/src/routes/` contains exactly the 7 IAM files (`authRoutes.js`, `mfaRoutes.js`, `meRoutes.js`, `userRoutes.js`, `internalRoutes.js`, `rbacRoutes.js`, `swaggerRoutes.js`). Landed in commit `8d4fcf6b` ("Trim to a minimal IAM-only service").
- [x] **3.3** THE SYSTEM SHALL delete 16 non-IAM controller files from `frs-core-api/backend/api/src/controllers/`.
  **MET** (verified 2026-09-17) — `backend/api/src/controllers/` contains only `UserController.js`. Landed in commit `8d4fcf6b`.
- [ ] **3.4** THE SYSTEM SHALL delete business services (`business/`, `alerting/`, `ai-evaluation/`) from `frs-core-api/backend/api/src/services/`.
  **PARTIALLY MET, built 2026-09-17** — `services/alerting/` and `services/ai-evaluation/` deleted (the latter only after removing its one importer, `startDriftMonitorCron`, from `server.js`). **`services/business/` explicitly deferred, decided 2026-09-17 (Revision 11) — will NOT be built under this spec.** Full removal means also stripping `server.js`'s 2 device-polling `setInterval` loops and the attendance-ingest worker startup — that's a real architecture question (should `frs-core-api` run any attendance/device-polling logic at all, now that `frs-fe-api`/`frs-edge-api` exist?), not a cleanup task. If this is wanted, it needs its own spec, scoped and reviewed on its own. This AC will stay unmet under `0002` permanently unless that separate spec supersedes it.
- [x] **3.5** WHEN `frs-core-api` starts up, THE SYSTEM SHALL NOT initiate any business crons (`startDataRetentionCron`, `startEnrollmentReminderCron`, `startDriftMonitorCron`).
  **MET, built 2026-09-17** — all three, plus the unnamed 4th (`startDeviceOfflineCron`), removed from `server.js`'s boot sequence (imports and invocation block both removed). The underlying `jobs/*.js` files were left on disk, per the AC's own wording (only boot invocation is in scope). **Still true, unchanged**: the attendance-ingest worker, Kafka consumer subscriptions, WebSocket manager, and device-polling `setInterval` loops are untouched — this AC only ever covered the 3 named crons, not the wider non-IAM runtime.
- [x] **3.6** THE SYSTEM SHALL remove `backend/api-retail/` from `frs-core-api` while leaving `backend/api-transport/` completely intact and ignored.
  **MET, built 2026-09-17** — `backend/api-retail/` deleted (27 files). `backend/api-transport/` independently confirmed untouched.

### Requirement 4 — Protect PM2 Sidecar Services, Workers, and Observability
**User story:** As a DevOps engineer, I want the `face-quality` CV service, Kafka consumer workers, and structured logging pipelines preserved and documented, so that enrollment scoring, message streaming, and log observability remain fully operational in PM2.

**Acceptance criteria**
- [x] **4.1** THE SYSTEM SHALL preserve `face_quality_service.py`, `mediapipe_engine.py`, and `requirements.txt` under `frs-core-api/backend/api/scripts/`, ensuring the Python face-quality service can be started on port 5050.
  **MET for frs-core-api's part** (verified 2026-09-17) — all three files confirmed present at `backend/api/scripts/`. Whether the service actually starts on :5050 wasn't runtime-tested.
- [ ] **4.2** WHEN `frs-fe-api` or `frs-edge-api` invokes `http://127.0.0.1:5050/quality`, THE SYSTEM SHALL communicate with the `face-quality` service for photo quality scoring.
  **Not independently confirmed this pass** — `frs-fe-api`/`frs-edge-api` are present in this workspace, but this is a runtime call (needs the face-quality service actually running on :5050); a static grep for `127.0.0.1:5050`/`:5050` in both repos' `src/` found no direct match, which could mean it's read from an env var instead — not resolved either way, don't assume it's broken or working from this note alone.
- [x] **4.3** THE SYSTEM SHALL preserve Kafka consumer workers (`deviceEventConsumer.js`, `deadLetterMonitor.js`) and topic creation scripts (`create-topics.js`).
  **MET for frs-core-api's part** (verified 2026-09-17) — `backend/api/src/workers/deviceEventConsumer.js`, `deadLetterMonitor.js`, and `backend/api/scripts/create-topics.js` all present and still wired (Kafka consumer subscriptions confirmed live in `server.js`).
- [x] **4.4** THE SYSTEM SHALL preserve Pino structured logging (`logger.js`), `X-Request-ID` correlation ID propagation (`correlationId.js`), and security audit logging (`securityEventLogger.js`) across `frs-core-api`, `frs-fe-api`, and `frs-edge-api`.
  **MET for frs-core-api's part** (verified 2026-09-17) — `backend/api/src/utils/logger.js`, `middleware/correlationId.js`, `middleware/securityEventLogger.js` all present and wired into `server.js`'s middleware chain. `frs-fe-api`/`frs-edge-api` portions not verifiable from this workspace.

### Requirement 5 — Clean Stray Root Files
**User story:** As an engineer navigating the repository, I want obsolete scratch scripts and loose diagram assets removed from repository roots, so that repository roots remain clean and standard.

**Acceptance criteria**
- [ ] **5.1** THE SYSTEM SHALL delete loose diagram images and markdown summaries from `frs-core-api` root (`diagram1_corporate_relational_er.png`, `diagram2_corporate_storage_relationship.png`, `diagram3_corporate_enrollment_flow.png`, `test_mermaid.png`, `all_diagrams_overview.md`, `reconciliation_summary.md`, `storage_relationship_diagram_corporate.md`, `enrollment_data_flow_diagram_corporate.md`, `er_diagram_corporate_relational.md`, `document.md`).
  **PARTIALLY MET, decided 2026-09-17 (Revision 11) — will NOT delete the remaining 2, permanently.** 8 of 10 deleted. `reconciliation_summary.md` and `document.md` explicitly kept — real historical/incident content, and a human decided a repo-root file is a better retrieval path for that than digging through git history. This AC will stay permanently partial under `0002`; it is not "pending a decision," the decision is to keep them.
- [x] **5.2** THE SYSTEM SHALL delete stray root scripts and obsolete build outputs from `frs-core-api` root (`owner-dashboard.html`, `query_check.js`, `dist/`).
  **MET, built 2026-09-17** — all 3 deleted.
- [x] **5.3** THE SYSTEM SHALL delete stray root test scripts from `frs-web-ui` root (`test-canNext.js`, `test-csc.js`, `test-csc.mjs`).
  **MET, built 2026-09-17** — all 3 deleted in `frs-web-ui` (separate repo/commit from this one). Note: `npm test` in `frs-web-ui` afterward showed 3 pre-existing failures in `router.test.tsx`, confirmed unrelated to this deletion — see `WALKTHROUGH.md`.

### Requirement 6 — System Startup and Proxy Verification
**User story:** As a full-stack engineer, I want all microservices to start and communicate cleanly via `up.sh` and PM2, so that local development and CI remain completely operational.

**Acceptance criteria**
- [ ] **6.1** WHEN `up.sh` is executed, THE SYSTEM SHALL launch `frs-core-api` on port 8082, `frs-fe-api` on port 8080, `frs-edge-api` on port 8081, and `frs-web-ui` on port 5173 without syntax or module import errors.
  **Ports confirmed by static config** (verified 2026-09-17): `frs-core-api/.env` → `PORT=8082`; `frs-fe-api/.env` → `PORT=8080`; `frs-edge-api/.env` → `PORT=8081`; `frs-web-ui/vite.config.ts:98` → `port: 5173`. **Not actually launched** — `up.sh` wasn't run, so "without syntax or module import errors" is unverified.
- [x] **6.2** WHEN `frs-web-ui` forwards `/api/auth/*`, `/api/me/bootstrap`, and `/api/users/*` through Vite dev server proxy, THE SYSTEM SHALL reach `frs-core-api` on port 8082.
  **MET** (verified 2026-09-17) — `frs-web-ui/vite.config.ts:105-126` proxies `/api/auth`, `/api/me/bootstrap`, `/api/users`, `/api/admin/rbac`, `/api/internal` to `http://localhost:8082`, registered before the general `/api` fallback (Vite matches by declaration order).
- [x] **6.3** WHEN `frs-web-ui` forwards general `/api/*` requests through Vite dev server proxy, THE SYSTEM SHALL reach `frs-fe-api` on port 8080.
  **MET** (verified 2026-09-17) — `frs-web-ui/vite.config.ts:129-130` proxies the general `/api` fallback to `http://localhost:8080`.
- [ ] **6.4** WHEN edge devices send telemetry, frames, or sync requests to port 8081, `frs-edge-api` SHALL handle all edge endpoints with 200/202 responses.
  **Not verifiable statically** — this needs a live request against a running service; not attempted this pass.
