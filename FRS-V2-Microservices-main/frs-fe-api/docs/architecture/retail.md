# retail vertical (`src/retail/`)

> Shard of `docs/ARCHITECTURE.md` — read the router first. This covers ONLY `src/retail/**`, a
> self-contained sub-app for the retail people-counting/occupancy product, mounted at
> `/api/v1/retail/*` (`src/server.js:456-471`). Copied read-only from
> `frs-core-api/backend/api-retail` (`README.md:48-56`) — treated as its own bounded context,
> deliberately not sharing this repo's main DB pool, auth, or middleware.

## Depends on / Used by
- **Depends on:** the main FRS Postgres DB, but only via a **separate, read-only** cross-DB
  connection (`FRS_DB_URL`) for user/tenant lookups from
  `src/retail/middleware/authenticateUser.js` — not the main app's `pool`/`warmPool`
  (`src/db/pool.js`). Also depends on a Keycloak realm (per-tenant, dynamic JWKS) via
  `KEYCLOAK_REALM_URL`, and on `INTERNAL_API_URL` (Keycloak-provisioning / invite-email internal
  endpoints, likely frs-iam-api, `INTERNAL_SERVICE_SECRET`-authenticated).
- **Used by:** the retail frontend at `RETAIL_APP_URL` (invite setup links,
  `src/retail/routes/settingsRoutes.js: POST /settings/invitations`).
- **Not used by / does not use:** the rest of this repo's routes, controllers, services, or main
  auth (`src/middleware/authz.js`). No known coupling in either direction beyond the read-only
  cross-DB lookup above — this is the cleanest module boundary in the repo.

## What it is
Own Postgres database (`RETAIL_DB_URL`), own auth (Keycloak-token verification, not this repo's
`authz.js`), own routes/middleware/services — `README.md:57-71`.

## Structure
| Area | Path | One-liner |
|------|------|-----------|
| DB pool | `src/retail/db/pool.js` | Connects to `RETAIL_DB_URL`, a separate Postgres DB from the main app |
| Migrations | `src/retail/db/migrations/` | Own migration set, not shared with `src/db/migrations/` (only spot-checked: `001_camera_attribution_columns.sql` confirmed) |
| Auth middleware | `src/retail/middleware/authenticateUser.js` | Verifies Keycloak tokens directly via `src/retail/services/keycloakVerifier.js` — distinct from `src/middleware/authz.js` |
| Routes | `src/retail/routes/{health,store,camera,device,snapshot,dashboard,report,settings,invite}Routes.js` | User/admin-facing only — device-facing routes (heartbeat, snapshot push, count/occupancy ingest) were dropped and live in sibling `frs-edge-api` instead (`README.md:66-70`) |
| Services | `src/retail/services/{cameraResolver,jwtService,keycloakVerifier,snapshotStore}.js` | Retail-specific business logic |

## Data & persistence
- **Engine:** PostgreSQL, but a **separate database** from the main app (`RETAIL_DB_URL`) —
  `src/retail/db/pool.js`.
- **Cross-DB read-only link:** `FRS_DB_URL` points back at the main FRS database for
  user/tenant lookups — used by `authenticateUser.js`. Also referenced by this repo's own
  `authRoutes.js` forgot-password flow, in the other direction, to look up accounts that only
  exist in the retail DB (`.env.example`, `src/db/retailPool.js`) — the one place where the two
  verticals' data does cross.
- **Migrations:** own numbered `.sql` set under `src/retail/db/migrations/`, not shared with or
  run alongside the main app's `src/db/migrations/`.

## Auth
- `src/retail/middleware/authenticateUser.js` + `src/retail/services/keycloakVerifier.js` verify
  Keycloak tokens with **dynamic per-realm JWKS fetch** (retail tenants can live in per-tenant
  realms) via `KEYCLOAK_REALM_URL` — independent of the main app's `keycloakVerifier.js`/`authz.js`.
- Device-facing auth (heartbeat, snapshot push) was intentionally dropped from this repo's retail
  copy — see trimming notes at the top of `src/retail/routes/deviceRoutes.js` and
  `src/retail/routes/snapshotRoutes.js` (per README) — that traffic goes to `frs-edge-api`.

## Cross-cutting notes specific to this shard
- Env vars: `RETAIL_DB_URL`, `FRS_DB_URL`, `KEYCLOAK_REALM_URL`, `RETAIL_APP_URL`,
  `INTERNAL_API_URL`, `INTERNAL_SERVICE_SECRET` — see `.env.example`'s "Retail vertical" section.
- Mounted under a "clearly delimited block" in `src/server.js` separate from the main routes
  (`src/server.js:456-471`) — when touching server.js route-mounting, keep that separation intact.

## Keeping this fresh
Regenerate this shard only when `src/retail/**` changes (routes, services, migrations, or its auth
verifier). Main-app changes never require touching this file.
