# Tasks: Prune Duplicate and Unwanted Codebase Across Microservices

> The ordered execution plan for `requirements.md` + `design.md` (same folder). `/spec-build`
> executes these **one task at a time**, in order, checking each off — with its tests passing —
> before starting the next.

## Status

| | |
|---|---|
| **Tasks completed** | 0 / 7 fully — Task 2, 3, 5, 6 partially built 2026-09-17 (AC 2.1, 3.5, 3.6, 5.2, 5.3 MET; 3.4, 5.1 partial); Tasks 1, 4, 7 unchanged |
| **Last executed** | Partial build, 2026-09-17: one `developer` agent per repo (`frs-core-api`, `frs-fe-api`, `frs-web-ui`), scope limited to human-approved, non-blocked, non-destructive ACs only. Full log: `WALKTHROUGH.md`. Earlier, two untracked commits (`8d4fcf6b`, `47468c93`) had landed part of Task 3 outside this spec's own tracking, before the spec reached `Approved`. |

> All 4 repos (`frs-core-api`, `frs-fe-api`, `frs-edge-api`, `frs-web-ui`) are present in this
> workspace as siblings under `Micro-Service/`, alongside a workspace-level `CLAUDE.md`/`docs/`.
> Every AC across all 7 tasks has now been checked against real code (except live-request/live-
> startup checks — those need an actual run, not a static one). Full evidence in requirements.md.

## Task list

- [ ] **1. Port Missing Edge Box Endpoints into `frs-edge-api`** — Req: 1.1, 1.2, 1.3, 1.4, 1.5
  **AC 1.1 done** (built 2026-09-17) — new `employeeRoutes.js`, ported and adapted from
  `frs-fe-api`'s removed handler, mounted at `/api/employees`. **AC 1.2 investigated, NOT built —
  blocked on a product decision, not a technical one**: the pipeline behind `/api/frames/*` is
  already dead in `frs-core-api` (queues frames into an in-memory structure nothing drains, since
  the rule-execution engine it fed was already deleted in commit `47468c93`). `frs-edge-api`'s
  `/api/events/*` (`deviceEventsRoutes.js` → Kafka) looks like the live replacement for the same
  need. **Decided 2026-09-17: retire, not port.** The two routes were deleted from `frs-core-api`
  (see AC 3.1); this AC is retired, not blocked — nothing to add to `frs-edge-api`. See
  requirements.md §1.2 for the full trace, including corroborating pre-existing team documentation
  (`docs/architecture/BACKEND_ARCHITECTURE_OVERVIEW.md:195-206`). **AC 1.3 resolved, MET** — the
  spec's wording was wrong, not the code (`claim-token` is `GET /api/bootstrap/:deviceCode`; the
  commands-executed callback is under `/api/device-management/...`) — corrected in requirements.md
  rather than adding unused route aliases to match imprecise prose. AC 1.4, 1.5 **MET** — retail
  edge routes and the 401 auth-rejection contract are both already correct.
  Ensure `frs-edge-api` contains 100% of edge-box endpoints:
  - Add `POST /api/employees/:employeeId/enroll-face-direct` in `frs-edge-api/src/routes/employeeRoutes.js` (gated with `authenticateDevice`, validating 512-d ArcFace float array and L2 norm). Mount in `frs-edge-api/src/server.js`.
  - ~~Add `POST /api/frames/rtsp/:cameraId` and `POST /api/frames/smart/:cameraId` in `frs-edge-api/src/server.js`~~ — retired, not built. Removed from `frs-core-api` instead (AC 3.1); not ported anywhere.
  - Verify that all existing edge routes (`/api/bootstrap/*`, `/api/events/*`, `/api/face/sync/*`, `/api/face/recognize`, `/api/cameras/*`, `/api/devices/*`, `/api/device-management/*`, `/api/attendance/*`, `/api/jetson/*`) and retail edge routes (`/api/v1/retail/devices/*`, `/api/v1/retail/health`) load cleanly.
  *Tests*: `node --check src/server.js` in `frs-edge-api` and automated unit test asserting HTTP status 200/202 for direct face enrollment and frame injection with device JWT.

- [x] **2. Clean `frs-fe-api` of Device-Facing Ingest and Retain Business & Retail Surfaces** — Req: 2.1, 2.2, 2.3, 2.4
  **Done** (built 2026-09-17) — AC 2.1's route removed from `employeeRoutes.js`; 2.2, 2.3, 2.4
  were already MET. **Caveat, real**: since Task 1 (adding the route to `frs-edge-api`) was
  explicitly NOT built this pass, `enroll-face-direct` now exists in *neither* service — a
  functional gap, not just a paper one, until Task 1 lands.
  Ensure `frs-fe-api` contains only non-edge business endpoints:
  - Remove the device-facing `POST /:employeeId/enroll-face-direct` route from `frs-fe-api/src/routes/employeeRoutes.js` and remove the unused `authenticateDevice` import.
  - Verify all 31 business routes (`attendance`, `employee`, `camera`, `device`, `dashboard`, `reports`, `alerts`, `incidents`, `watchlist`, `face`, etc.) and all 10 retail routes (`stores`, `cameras`, `devices/register`, `devices` [list], `snapshot` [read/stream], `dashboard`, `reports`, `settings`, `invite`, `health`) remain registered and healthy.
  - Confirm `startDataRetentionCron`, `startEnrollmentReminderCron`, and `startDriftMonitorCron` run without duplicate instances.
  *Tests*: `node --check src/server.js` in `frs-fe-api` and `npm test` in `frs-fe-api`.

- [ ] **3. Prune `frs-core-api` to Pure IAM Surface** — Req: 3.1, 3.2, 3.3, 3.4, 3.5
  **Partially done** (built 2026-09-17, see requirements.md §Requirement 3 for full evidence):
  - ✅ Route files deleted (only 7 IAM routes remain) — landed in `8d4fcf6b`.
  - ✅ Controller files deleted (only `UserController.js` remains) — landed in `8d4fcf6b`.
  - ✅ **Built this pass**: `services/alerting/`, `services/ai-evaluation/` deleted; `startDataRetentionCron`, `startDeviceOfflineCron`, `startEnrollmentReminderCron`, `startDriftMonitorCron` no longer start at boot.
  - ❌ **Permanently deferred, decided 2026-09-17**: `services/business/` will NOT be removed under
    this spec — full removal means also stripping live device-polling/attendance-worker runtime
    from `server.js`, which is a separate architecture decision needing its own spec, not a cleanup
    task. AC 3.4 stays partial under `0002` indefinitely.
  - ✅ **Built this pass**: `/api/frames/rtsp/:cameraId` and `/api/frames/smart/:cameraId` removed
    from `server.js` entirely (dead pipeline, retired — see AC 1.2), plus the now-unused
    `authenticateDevice` import.
  - ❌ **Still open, out of scope for this decision**: `/uploads` (`server.js:455`) — a live, working
    photo-serving endpoint, not dead code like the frame routes were. Removing it needs its own call.
  Convert `frs-core-api` strictly into `frs-iam-api`:
  - In `frs-core-api/backend/api/src/server.js`, import and mount only IAM routes (`authRoutes`, `mfaRoutes`, `meRoutes`, `userRoutes`, `rbacRoutes`, `internalRoutes`, `swaggerRoutes`).
  - Disable cron job startup calls (`startDataRetentionCron`, `startDeviceOfflineCron`, `startEnrollmentReminderCron`).
  - Delete all 27 non-IAM route files from `backend/api/src/routes/`.
  - Delete 16 non-IAM controller files from `backend/api/src/controllers/`.
  - Delete non-IAM services (`src/services/business/`, `src/services/alerting/`, `src/services/ai-evaluation/`) from `backend/api/src/services/`.
  *Tests*: `node --check backend/api/src/server.js` and automated test asserting only IAM endpoints are mounted and non-IAM endpoints return 404.

- [ ] **4. Verify and Protect PM2 Sidecar Services, Workers, and Logging** — Req: 4.1, 4.2, 4.3, 4.4
  **`frs-core-api`'s half verified clean** (2026-09-17): `face_quality_service.py`, `mediapipe_engine.py`, `requirements.txt`, `deviceEventConsumer.js`, `deadLetterMonitor.js`, `create-topics.js`, `logger.js`, `correlationId.js`, `securityEventLogger.js` all present and wired — nothing broken here. `frs-core-api/backend/api/src/server.js:662-672` also confirms a live health-probe call to the face-quality service. AC 4.2's live `:5050/quality` call from `frs-fe-api`/`frs-edge-api` wasn't confirmed statically (no direct `127.0.0.1:5050` match in either repo's `src/` — may be env-configured instead) — a runtime check, not attempted.
  Ensure auxiliary operational services and logging are fully intact:
  - Verify `backend/api/scripts/face_quality_service.py`, `mediapipe_engine.py`, and `requirements.txt` are preserved and can be launched on port 5050.
  - Verify Kafka consumer workers (`deviceEventConsumer.js`, `deadLetterMonitor.js`) and topic scripts are preserved.
  - Verify Pino structured logger (`utils/logger.js`), `correlationId.js` (W-06 `X-Request-ID`), and `securityEventLogger.js` (FIX-015 audit log) are operational across all services.
  *Tests*: Syntax check on Python scripts, file existence tests, and response header verification for `x-request-id`.

- [x] **5. Remove Obsolete `backend/api-retail` while Preserving `backend/api-transport`** — Req: 3.6
  **Done** (built 2026-09-17) — `backend/api-retail/` deleted (27 files); `backend/api-transport/` independently confirmed untouched.
  Clean up legacy vertical directories in `frs-core-api`:
  - Delete `frs-core-api/backend/api-retail/` (already fully running in `frs-fe-api/src/retail` and `frs-edge-api/src/retail`).
  - Verify `frs-core-api/backend/api-transport/` remains completely untouched.
  *Tests*: Script asserting `!fs.existsSync('backend/api-retail')` AND `fs.existsSync('backend/api-transport')`.

- [ ] **6. Clean Stray Root Files and Test Scripts Across Repositories** — Req: 5.1, 5.2, 5.3
  **Mostly done, rest permanently deferred (decided 2026-09-17)** — all `frs-core-api` root files
  deleted except `reconciliation_summary.md` and `document.md`, which will **not** be deleted —
  real incident/migration history, kept at repo root deliberately rather than relying on git
  history for retrieval. All 3 `frs-web-ui` files deleted. AC 5.1 stays permanently partial.
  Remove loose artifacts and scratch files:
  - In `frs-core-api` root: delete `diagram1_corporate_relational_er.png`, `diagram2_corporate_storage_relationship.png`, `diagram3_corporate_enrollment_flow.png`, `test_mermaid.png`, `all_diagrams_overview.md`, `reconciliation_summary.md`, `storage_relationship_diagram_corporate.md`, `enrollment_data_flow_diagram_corporate.md`, `er_diagram_corporate_relational.md`, `owner-dashboard.html`, `query_check.js`, `document.md`, and `dist/`.
  - In `frs-web-ui` root: delete `test-canNext.js`, `test-csc.js`, `test-csc.mjs`.
  *Tests*: Script asserting that all specified loose root files have been removed.

- [ ] **7. Multi-Service Startup and End-to-End Proxy Verification** — Req: 6.1, 6.2, 6.3, 6.4
  **Config verified, live run not attempted** (2026-09-17): all 4 ports match the spec exactly via
  each repo's `.env`/`vite.config.ts` (8082/8080/8081/5173), and the Vite proxy split (AC 6.2, 6.3)
  is wired correctly and confirmed **MET** statically. AC 6.1 ("launches without errors") and 6.4
  ("live 200/202 responses") both need an actual `up.sh` run — not done this pass.
  Verify complete system integrity:
  - Launch services via `up.sh` (or verify individual ports).
  - Verify `frs-core-api` on port 8082 responds to IAM requests (`/api/auth/*`, `/api/me/bootstrap`).
  - Verify `frs-fe-api` on port 8080 responds to business & retail requests (`/api/*`, `/api/v1/retail/*`).
  - Verify `frs-edge-api` on port 8081 responds to edge & retail device requests (`/api/attendance/*`, `/api/events/*`, `/api/v1/retail/devices/*`, `/api/employees/:id/enroll-face-direct`).
  - Verify `frs-web-ui` on port 5173 proxies `/api/auth`, `/api/me/bootstrap`, `/api/users`, `/api/admin/rbac` to port 8082 and `/api` to port 8080.
  - Run regression test suites across `frs-core-api`, `frs-fe-api`, `frs-edge-api`, and `frs-web-ui`.
  *Tests*: All automated tests passing across all active repositories with zero regressions.
