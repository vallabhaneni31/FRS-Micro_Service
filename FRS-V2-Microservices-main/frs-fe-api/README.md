# frs-fe-api

The frontend-facing half of the Face Recognition System (FRS) backend: the
Express/Node (ESM) API that **`frs-web-ui`** (the React frontend, a sibling
repo) talks to. Every route here is human-user-facing and authenticated via
JWT/Keycloak (`requireAuth`) — dashboards, HR/employee management, reports,
admin consoles, attendance, alerts/incidents/watchlists, biometric-consent
and enrollment self-service, HRMS integration, and platform/tenant admin.

## Origin

This repo was split out of `frs-core-api`'s `backend/api` service, which
previously served both human users (via `frs-web-ui`) and Jetson edge boxes
(device-JWT auth, `authenticateDevice`) from one process. See
`frs-core-api/docs/architecture/API_SPLIT_PLAN.md` for the full rationale and
route inventory the split was based on.

`frs-core-api/backend/api` is treated as the historical source of this code —
this repo was created by copying (not moving) the frontend-facing routes and
their transitive dependencies out of it; `frs-core-api` was left untouched.

## Relationship to frs-edge-api

**`frs-edge-api`** is the sibling repo carrying the other half of the
original `backend/api`: everything `authenticateDevice`/device-JWT — device
sync, face-recognition submission, attendance ingest from Jetson boxes,
device provisioning/heartbeat/command polling. Both services:

- connect to the **same Postgres database** (this repo owns
  `src/db/migrations/` as the single source of truth for schema; see that
  directory's migrations before assuming which service should run them in a
  given environment),
- share a large amount of business logic (controllers/services/repositories)
  that is **duplicated between the two repos by deliberate choice**, not
  factored into a shared package — each repo copies whichever full file it
  needs, even if only some of that file's methods are exercised by its own
  routes.

One route file in this repo, `src/routes/employeeRoutes.js`, still contains a
single device-JWT (`authenticateDevice`) endpoint —
`POST /:employeeId/enroll-face-direct`, used by the C++ Jetson runner to push
a pre-computed face embedding directly. It was kept whole/unmodified per the
split plan rather than trimmed, so `DEVICE_JWT_SECRET` is still a required
env var here.

## Retail vertical

`src/retail/` carries the user/admin-facing half of a second, separate
vertical: the retail people-counting/occupancy service, copied (read-only
source, not moved) from `frs-core-api/backend/api-retail`. It is a
self-contained subtree — own `routes/`, `middleware/` (`authenticateUser.js`,
a Keycloak-token-based auth distinct from this repo's `authz.js`),
`services/`, and `db/` (own `pool.js` + `migrations/`) — mounted at
`/api/v1/retail/*` in `server.js` under a clearly delimited block, separate
from the routes above.

Key differences from the rest of this repo:

- **Separate database.** `src/retail/db/pool.js` connects to its own Postgres
  database via `RETAIL_DB_URL` (plus a read-only `FRS_DB_URL` connection back
  to the main DB for cross-DB user/tenant lookups) — not the `pool`/`warmPool`
  from `src/db/pool.js` used everywhere else in this repo.
- **Separate auth.** `src/retail/middleware/authenticateUser.js` verifies
  Keycloak tokens itself (`src/retail/services/keycloakVerifier.js`) rather
  than using `src/middleware/authz.js`.
- **Device-facing routes dropped.** Only `authenticateUser`-guarded routes
  were kept; `authenticateDevice` routes (device heartbeat/health, snapshot
  push, count/occupancy ingest) live in the sibling `frs-edge-api` repo
  instead — see the trimming notes at the top of
  `src/retail/routes/deviceRoutes.js` and `src/retail/routes/snapshotRoutes.js`.

See `.env.example`'s "Retail vertical" section for the env vars this subtree
needs (`FRS_DB_URL`, `KEYCLOAK_REALM_URL`, `RETAIL_APP_URL`,
`INTERNAL_API_URL`, and the already-present `RETAIL_DB_URL` /
`INTERNAL_SERVICE_SECRET`).

## Getting started

```bash
npm install
cp .env.example .env   # fill in DB / Keycloak / secrets
npm run dev             # nodemon src/server.js
```

- `npm start` — production start (`node src/server.js`)
- `npm test` — `node --test src/tests/*.test.js` (test suite was not carried
  over in the initial split — see "Known gaps" below)
- `npm run generate-openapi` — regenerates `src/docs/openapi.generated.json`
  from the route files in this repo (served at `/api/docs`)

Requires a reachable Postgres instance with this repo's migrations applied
(`src/db/migrations/`) and, for `AUTH_MODE=keycloak` (the only supported
mode), a reachable Keycloak realm.

## Known gaps / deferred from the split

- `src/tests/` was not copied — the original suite mixes frontend- and
  edge-facing test cases; splitting it needs a pass to identify which cases
  apply here versus frs-edge-api, deferred to a follow-up.
- `.env.example` here is trimmed to the env vars actually referenced by the
  code copied into this repo (verified via grep across `src/`), not a literal
  copy of the source repo's `.env.example`.
