# frs-edge-api

The edge-box (Jetson device) facing half of the FRS backend API.

## What this is

This service was split out of [`frs-core-api`](../frs-core-api)'s `backend/api`,
which previously served both human users (via `frs-web-ui`) and Jetson edge
boxes from one Express process. See
`frs-core-api/docs/architecture/API_SPLIT_PLAN.md` for the full rationale and
route inventory behind the split.

`frs-edge-api` keeps only the routes authenticated with a device JWT
(`authenticateDevice` / `authenticateDeviceOptional`) or otherwise
device-initiated (bootstrap token claim, ZTP activation) — everything a
Jetson edge box calls directly:

- `POST /api/bootstrap/:deviceCode` — public device-code token claim (no auth yet)
- `POST /api/events`, `POST /api/events/batch`, `GET /api/events/commands`,
  photo upload routes — device event ingestion and command polling
- `GET /api/face/sync/*` — embeddings/employee roster/config/camera pull-sync
- `POST /api/face/recognize` — device submits a frame for recognition
- `POST /api/cameras/:camId/heartbeat`, `POST /api/cameras/device-sync`,
  `GET /api/cameras` (device-authenticated variant)
- `POST /api/devices/:camId/heartbeat`, NUG box heartbeat/enrollment-quality
  polling, enrollment photo serving
- `POST /api/device-management/devices/activate` (ZTP handshake, PIN-gated,
  no prior auth), device heartbeat/config/command polling
- `POST /api/attendance/frame`, `/bulk-sync`, `/direction` — Jetson-originated
  attendance ingest
- `ALL /api/jetson/:camId/heartbeat` — legacy firmware heartbeat compat

## Retail vertical (people counting / occupancy)

This repo also carries the device-facing half of a second, separate vertical:
the retail people-counting/occupancy service, split out of
`frs-core-api/backend/api-retail`. It is a fully self-contained service
(own Postgres DB, own device auth) bolted onto this same Express process —
not merged into the edge-device routes above.

- Code lives entirely under `src/retail/` (`routes/`, `middleware/`, `services/`,
  `db/`), kept isolated from `src/` to avoid filename collisions (both halves
  have their own `deviceRoutes.js`, `authenticateDevice.js`, etc. — do not
  conflate them).
- **Own database** — `src/retail/db/pool.js` connects to `RETAIL_DB_URL`, a
  separate Postgres database from the one `src/db/pool.js` uses. It also
  requires `FRS_DB_URL` (read-only cross-DB lookups) to be set, even though
  the routes kept here don't query it directly. See `.env.retail.example`.
- Routes are mounted under `/api/v1/retail/...`, matching
  `backend/api-retail/src/index.js`'s original mount paths:
  - `GET /api/v1/retail/health`
  - `POST /api/v1/retail/devices/:id/heartbeat`, `POST /api/v1/retail/devices/:id/health`
  - `POST /api/v1/retail/devices/:id/snapshot`
  - `POST /api/v1/retail/devices/:id/count`, `POST /api/v1/retail/devices/:id/occupancy`
- Only the `authenticateDevice`-gated handlers were brought over. The
  user-facing (`authenticateUser`/`requireOwner`) halves of
  `deviceRoutes.js`/`snapshotRoutes.js` — device registration/listing and the
  browser-facing snapshot read/stream endpoints — were intentionally left out;
  those belong in `frs-fe-api`.

## How it relates to the rest of the estate

- **`frs-fe-api`** — the sibling frontend-facing repo, split out of the same
  source at the same time. It keeps everything `requireAuth`/Keycloak-JWT:
  dashboards, HR/employee management, reports, admin consoles, and the
  human-facing halves of the route files that were split between the two
  repos (e.g. camera/device CRUD, attendance reports/exports). The two
  services share a database (same Postgres schema) but do not call each
  other directly.
- **Jetson edge devices** — this is the only backend surface Jetson boxes
  talk to. A device authenticates with a device JWT (minted during
  provisioning/ZTP activation), then pushes events/attendance and pulls
  face-embedding/employee/config sync data on a schedule.
- Both repos intentionally duplicate shared files (middleware, repositories,
  utils) rather than depending on a shared internal package — see the split
  plan doc for why.

## Development

```bash
cp .env.example .env   # fill in DEVICE_JWT_SECRET, ENROLLMENT_TOKEN_SECRET, DB_*, AWS_S3_*
npm install
npm run dev             # nodemon src/server.js
```

Requires a Postgres database migrated with the schema in `src/db/migrations/`
(the same schema `frs-core-api`/`frs-fe-api` use) and, for full functionality,
Kafka (device event ingest, write-behind attendance ingest) and Redis
(distributed rate limiting, cross-process WebSocket broadcast delivery to
`frs-fe-api`'s Socket.IO server). The service degrades gracefully without
Kafka/Redis in local development — see inline comments in `src/server.js`.

## Tests

```bash
npm test   # node --test src/tests/*.test.js
```
