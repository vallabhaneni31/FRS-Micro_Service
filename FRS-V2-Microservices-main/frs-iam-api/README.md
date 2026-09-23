# Motivity Face Recognition System (FRS)

Attendance and access-control platform built on face recognition, with a
Keycloak-backed multi-tenant web app, a Node/Express API, and a Jetson-based
edge inference pipeline.

## Repository layout

This repo is structured as a set of independently deployable services under
`frontend/` and `backend/`, plus supporting infrastructure and edge code.
**There is no shared root-level `node_modules`/`package-lock.json` and no
npm workspace** — each service below has its own `package.json`,
`package-lock.json`, and `node_modules`, installed and run independently.
This is deliberate: it keeps each service truly self-contained (matches how
they're actually deployed — as separate processes/containers) and avoids
one service's dependency resolution silently affecting another's.

```
frontend/          React/Vite SPA — serves 3 verticals from one app, routed by a
                     server-driven manifest (not by URL namespace):
  src/app/components/
    verticals/
      corporate/    HR/attendance/security/device-management (the default vertical)
      education/    School variant (relabels corporate UI — one dedicated page)
      retail/       People-counting/store-analytics vertical
    platform/       Cross-tenant super-admin tooling (not itself a vertical)
    shared/, ui/    True cross-vertical app shell + design-system primitives

backend/            Backend microservices
  api/              Node/Express API — auth, attendance, device management, reporting
  api-retail/       Standalone Express microservice for the retail vertical
                     (people counting, occupancy, store analytics)

infra/
  docker/           docker-compose files and Dockerfiles for local development
  nginx/            nginx site config (native deployment)
  keycloak/         Keycloak realm export (Docker path)
  keycloak-native/  Native Keycloak server distribution + systemd unit
  certs/            mTLS certificates (device trust — never commit private keys)
  native-deploy/    Scripts that provision the native (non-Docker) production host

edge/
  jetson/           Camera capture + face-embedding inference pipeline for
                     NVIDIA Jetson edge devices

load-tests/
  k6/               k6 load-test scripts with defined SLO thresholds

docs/               Runbooks, compliance docs, and architecture references
testing/            Cross-cutting API integration test scripts
```

**Why this split:** `frontend/` and `backend/` separate the two sides of the
system cleanly; `backend/` is a container for multiple independently
deployable services (each with its own `package.json`, `Dockerfile`, and
database) rather than a single monolith, since the retail vertical runs as
its own microservice. `infra/` holds everything about *how* things get
deployed, not the services themselves.

There used to be a second, standalone retail frontend at `frontend/retail/`
(its own Vite/Tailwind/React-Router toolchain) — it's been retired and merged
into `frontend/src/app/components/verticals/retail/`, which was already the
richer implementation. One frontend, one retail implementation.

## Getting started (local development)

Each service is installed and run independently:

```bash
cd frontend && npm install && npm run dev      # frontend dev server
cd backend/api && npm install && npm run dev   # backend API
cd backend/api-retail && npm install && npm run dev
```

Or use the thin convenience wrappers at the repo root (equivalent to the
`cd`+`npm run` pairs above, via `npm --prefix`):

```bash
npm run install:all               # installs frontend + backend/api + backend/api-retail
npm run dev:frontend              # starts the frontend dev server
npm run dev:api                   # starts the backend API
```

Each service has its own `.env.example` — copy it to `.env` in the
corresponding directory before running:

- `frontend/.env.example` — frontend (Vite `VITE_*` vars only)
- `backend/api/.env.example` — backend API (DB, Keycloak, auth mode, required secrets)
- `backend/api-retail/.env.retail.example` — retail service (copy to `.env.retail`)

To bring up the full local stack (Postgres, Kafka, Keycloak, backend, frontend)
via Docker:

```bash
docker compose -f infra/docker/docker-compose.yml up
```

Production runs natively (PM2 + systemd Keycloak + nginx) rather than via
Docker — see `infra/native-deploy/` and `docs/runbooks/` for that path.

## Configuration

**Nothing environment-specific is hardcoded in application code.** Every
value that differs between dev/staging/prod — device IPs, domains,
credentials, feature-allowlist emails, file paths — is read from an env var
with either no default (the service refuses to boot, e.g. secrets) or a
generic localhost-style default (e.g. Jetson sidecar URLs). This is what
lets the same codebase run in any environment with only config changes.

| Config surface | Template | Real file (gitignored) |
|---|---|---|
| Frontend | `frontend/.env.example` | `frontend/.env` |
| Backend API | `backend/api/.env.example` | `backend/api/.env` |
| Retail API | `backend/api-retail/.env.retail.example` | `backend/api-retail/.env.retail` (+ `.env.retail.local` for personal overrides) |
| Local Docker stack | `infra/docker/.env.example` | `infra/docker/.env` |
| nginx (native) | `infra/nginx/nginx.conf.template` + `infra/nginx/.env.example` | `infra/nginx/.env` → run `infra/nginx/render.sh` to generate `nginx.conf` |
| Keycloak systemd unit (native) | `infra/keycloak-native/keycloak.service.template` + `.env.example` | `infra/keycloak-native/.env` → run `infra/keycloak-native/render.sh` to generate `keycloak.service` |

The two `render.sh` scripts use `envsubst` to fill in the template files —
edit the `.template`, never the generated output directly (it's gitignored
and gets overwritten on the next render).

## Documentation

- `docs/runbooks/` — operational runbooks (backup, DR, incident response,
  Keycloak troubleshooting, tenant onboarding, scaling)
- `docs/compliance/`, `docs/security/` — DPIA and pentest scope
- `docs/PRODUCTION_READINESS_CHECKLIST.md` — current production-readiness status
