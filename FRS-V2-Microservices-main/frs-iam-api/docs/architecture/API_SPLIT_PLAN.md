# Proposal: split `backend/api` into a frontend-facing API and an edge-box (Jetson) sync API

**Status:** Draft proposal — not approved, not started. No code has been moved.

## Why

`backend/api` currently serves two very different consumers from one process:
human users via `frs-web-ui` (JWT/Keycloak auth, `requireAuth`) and Jetson edge boxes syncing
data (device-JWT auth, `authenticateDevice`). This mirrors the split already done for
`backend/api-retail` and `backend/api-transport`, which are being pulled into their own repos
per `azure-pipelines.yml:8-11` — this is the same move applied one level deeper, inside `api`
itself.

## Target shape

Two new repos:

- **`frs-frontend-api`** — everything `requireAuth`/Keycloak-JWT: dashboards, HR/employee,
  reports, admin consoles, enrollment self-service, HRMS integration.
- **`frs-edge-api`** — everything `authenticateDevice`/device-JWT: device sync, face sync,
  attendance ingest, device provisioning/heartbeat/commands.

Plus a shared internal package (see "Shared package" below) both depend on.

## Route inventory (34 files in `backend/api/src/routes/`)

### Move to `frs-frontend-api` as-is (24 files)
`authRoutes.js`, `mfaRoutes.js`, `meRoutes.js`, `manifestRoutes.js`, `userRoutes.js`,
`rbacRoutes.js`, `appAdminRoutes.js`, `tenantAdminRoutes.js`, `employeeRoutes.js`,
`peopleRoutes.js`, `hrRoutes.js`, `studentsRoutes.js`, `dashboardRoutes.js`, `liveRoutes.js`,
`reportRoutes.js`, `searchRoutes.js`, `confidenceReviewRoutes.js`, `incidentRoutes.js`,
`alertRoutes.js`, `watchlistRoutes.js`, `biometricConsentRoutes.js`, `siteRoutes.js`,
`siteManagementRoutes.js`, `monitoringRoutes.js`, `deviceTokenRoutes.js`

Also move as-is, on closer read (no `authenticateDevice` handlers found despite earlier
"mixed" flag — both are entirely `requireAuth`/public-token, no device auth):
- `configRoutes.js` — admin pushes/reads device config; devices *poll* it via
  `deviceManagementRoutes.js`'s separate `/device/config/:code`, not this file.
- `enrollmentRoutes.js` — admin invite management + `/:token/*` public self-enrollment
  (browser/mobile of the person enrolling, not the edge box).
- `hrmsIntegrationRoutes.js` — `/webhook/employee` is an external HRMS system callback, not
  Jetson; rest is `requireAuth` admin.

**Frontend-API total: 27 files moved whole.**

### Move to `frs-edge-api` as-is (2 files)
- `bootstrapRoutes.js` — public device-code token claim (device has no token yet)
- `deviceEventsRoutes.js` — all routes `authenticateDevice`; photo/event/batch upload, command polling

### Split by handler (6 files — real mix of `requireAuth` and `authenticateDevice` in one file)

| File | Frontend-API keeps | Edge-API gets |
|---|---|---|
| `cameraRoutes.js` | `GET /` (list, requirePermission), `POST /` (register), `POST /:id/test`, `POST /system-config`, `PATCH /:code/status`, `GET /:id/stream`, `POST /:id/capture-frame` | `POST /:camId/heartbeat`, `POST /device-sync`, and the `authenticateDeviceOptional` variant of `GET /` |
| `deviceRoutes.js` | All building/floor/zone/nug-box/camera CRUD, hierarchy, telemetry-history, heatmaps (`requirePermission`) | `POST /:camId/heartbeat`, `POST /nug-boxes/:code/heartbeat`, `GET /nug-boxes/:code/pending-enrollments`, `POST /nug-boxes/:code/enrollment-quality`, `GET /enrollment-photos/:filename` |
| `deviceManagementRoutes.js` | Everything `requireAuth` — summary, register/provision/list/update/delete device, site assignment, activation-code generation/status, effective-config lookup | `POST /devices/:code/heartbeat`, `GET /device/config/:code`, `GET /devices/:code/config`, `GET /devices/:code/commands`, `POST /devices/:code/commands/:commandId/executed`, `POST /devices/activate` (public, activation-limited — device-initiated) |
| `faceRoutes.js` | Everything except `/recognize` — CRUD, verify, search, groups, stats, visitors | `POST /recognize` (device submits a frame for recognition) |
| `faceSyncRoutes.js` | `POST /trigger-enrollment` (`requireAuth`) | `GET /embeddings`, `GET /employees`, `GET /config`, `GET /cameras`, `GET /enrollment-pending` — this file is otherwise almost entirely edge-facing; only one route stays |
| `attendanceRoutes.js` | `GET /photos/:filename`, `mark`, `batch`, `today`, `employee/:id`, `date-range`, `current`, `stats`, `reports/*`, `:id/correct`, `:id` delete, `dwell`, `dwell-summary`, `export/*`, `correction` | `POST /frame`, `POST /bulk-sync`, `POST /direction` (all `authenticateDevice`, `deviceIngestLimiter`) |

### Special case: `jetsonRoutes.js`
- `GET /photos/:filename` → **frontend-API** (`requireAuth`, serves photos to the UI, despite the file's name)
- `ALL /:camId/heartbeat` → **edge-API** (`authenticateDevice`, legacy firmware compat)

### Infra — decide per-repo, likely duplicated thin versions
- `internalRoutes.js` (Keycloak provisioning/invite email) → frontend-API only, it's admin-driven
- `swaggerRoutes.js` → both repos, each documenting its own surface

## Shared package (`@frs/api-core` or similar, private npm package)

Both new services need:
- `db/pool.js`, `db/retailPool.js` (only if a route in edge-API still needs retail pool — verify;
  likely frontend-only, confirm before dropping it from edge-API)
- `middleware/`: `asyncHandler.js`, `correlationId.js`, `requestLogger.js`, `rateLimit.js`,
  `auditLog.js`, `securityEventLogger.js` shared; `authz.js`+`keycloakVerifier.js` frontend-only,
  `authenticateDevice.js`+`requireDeviceScope.js`+`validateEventSignature.js` edge-only
- `repositories/`: `deviceRepository.js`, `deviceEventRepository.js`, `deviceManagementRepository.js`,
  `facilityDeviceRepository.js`, `enrollmentRepository.js` are read/written from **both** sides
  (e.g. admin registers a device, edge box heartbeats it) — these need to be shared, not duplicated
- `services/`: `configService.js`, `photoResolverService.js`, `storageService.js`,
  `tokenService.js`, `multitenant.js`, `authCache.js` — used by both
- `utils/`: `logger.js`, `embeddingEncryption.js`, `photoIntegrity.js`, `s3KeyBuilder.js` — used by both
- DB migrations — single source of truth, both services connect to the same schema. Migrations
  themselves should probably stay in **one** repo (whichever owns the DB migration runner) with the
  other consuming the already-migrated schema, to avoid two repos racing to apply migrations.

Frontend-API-only from the current tree: `controllers/` (AppAdmin, Dashboard, Employee,
Enrollment(partial), Report, Search, TenantAdmin, User), most of `services/business/`,
`services/alerting/`, `keycloakProvisioner.js`, `keycloakUserService.js`, `emailService.js`,
`gdprErasureService.js`, `identityMappingService.js`, `visitorValidationService.js`.

Edge-API-only: `controllers/DeviceEventController.js`, `controllers/DeviceHierarchyController.js`
(the heartbeat/ingest methods only — split like the route file), `controllers/FaceController.recognizeAndMark`,
`services/duplicateDetectionService.js`, `services/recognitionThresholdService.js`,
`services/ai-evaluation/`, `repositories/eventRepository.js`.

## Migration order (once approved)

1. Extract the shared package first, published to wherever this org hosts private npm packages
   (Azure Artifacts, given `azure-pipelines.yml` is already in use) — with `backend/api` as the
   only consumer initially, to prove it out without yet creating new repos.
2. Split the 6 mixed route files into their frontend/edge halves inside the existing repo,
   behind the existing single server, so the boundary is exercised in place before repos diverge.
3. Stand up `frs-edge-api` as a new repo, move the edge-only + split-edge files and their
   dedicated controllers/services, wire it to the shared package, stand up its own
   `azure-pipelines.yml` (model off the existing one, narrowed like `api-retail`/`api-transport`
   already were).
4. Cut `frs-frontend-api` the same way, or just rename/trim the existing `frs-core-api` repo down
   to frontend-only once edge-API is confirmed working — avoids a second full extraction.
5. Update `frs-web-ui`'s API base URL if it changes, and update Jetson firmware / edge deployment
   config to point at the new edge-API host.
6. Update `docs/ESTATE.md` (the `frs-web-ui` contract doc) and `docs/architecture/BACKEND_ARCHITECTURE_OVERVIEW.md`
   once the split is live — both are explicitly the docs of record for this.

## Open questions before starting

- Where do DB migrations live post-split, and which service runs them?
- Does the edge-API need `retailPool` at all, or was that import in `authRoutes.js` frontend-only
  (looks that way — confirm before excluding it)?
- Private package hosting: Azure Artifacts feed, or something else already in use for this org?
- Deployment: same EC2 VM (per `SINGLE_NODE_THROUGHPUT_OPTIMIZATION.md`) split into two processes,
  or genuinely separate infra? Affects whether this is "two repos, one box" or "two repos, two boxes."
