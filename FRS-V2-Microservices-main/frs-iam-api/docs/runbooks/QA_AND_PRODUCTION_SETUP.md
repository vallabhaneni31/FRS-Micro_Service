# QA & Production Environment Setup

**Status as of 2026-07-10.** This is a factual snapshot of what's true on the current host and repo, plus the steps to stand up (or promote) a QA or production environment. It complements `docs/PRODUCTION_READINESS_CHECKLIST.md` (security/feature sign-off) — this document is about *infrastructure and configuration*, not feature correctness.

---

## 0. Read this first

**⚠️ Verify frontend builds actually deploy before trusting one.** `frontend/vite.config.ts` previously had `outDir: '../dist'`, which builds to a stray `dist/` at the repo root instead of `frontend/dist` — the directory nginx (on this host, and per the repo's own `infra/nginx/nginx.conf.template`) actually serves. Every `npm run build` reported success while deploying nowhere; this was only caught by reproducing a live bug with Playwright and finding the deployed bundle didn't match the source. Fixed 2026-07-10 (`outDir` now defaults to `frontend/dist`), but **after any frontend build meant to go live, confirm it**: `curl` the live site's `index.html` for its asset hash, then check that exact file exists with a recent mtime in `frontend/dist/assets/` and contains your change (grep for a distinctive string). Don't just trust the build log.

**This host is already running as a dev/QA environment**, not a clean box. Live nginx serves `dev-frs.motivitylabs.com` (real Let's Encrypt cert), not the `frs.motivitylabs.com` production domain that appears in the repo's checked-in nginx template. Before following the "fresh box" steps below, decide whether you're:

- **(A) Promoting this box** to be the QA environment of record — mostly a matter of confirming config and locking it down, since the services are already running.
- **(B) Standing up a separate, new box** for QA and/or production — follow the full walkthrough in §3.

**Two blockers exist right now, independent of which path you choose:**

1. **~1,600 files are uncommitted on `dev`.** Everything from the repo restructure (`backend/` → `backend/api` + `backend/api-retail`) through this session's SQL-extraction and validator work has never been committed. A QA box provisioned by `git clone`/`git pull` today would get **none** of it. You need to review and commit (in sensible chunks — 1,600 files in one commit is not reviewable) before any git-based deployment path works.
2. **The live PM2 process was pointed at a deleted file path** (`backend/src/server.js`, pre-restructure) until this session fixed it. It's now correctly running `backend/api/src/server.js` and `pm2 save` has been re-run, so it will survive a reboot. If you provision a *new* box, make sure whatever startup script you use references `backend/api/src/server.js`, not the old path — the repo's `infra/native-deploy/pm2_setup.sh` already has this right.

---

## 1. Architecture at a glance

Native processes (no Docker in QA/production — Docker Compose files in the repo are dev-only, see header comments in `docker-compose.yml`):

| Service | How it runs | Port | Entry point |
|---|---|---|---|
| Backend API | PM2 (`frs-backend`) | 8080 | `backend/api/src/server.js` |
| Retail API | PM2 (not currently running on this box) | 4001 | `backend/api-retail/src/index.js` |
| Frontend | Static build served by nginx | — | `frontend/dist/` (output of `npm run build`) |
| Keycloak | systemd (`keycloak.service`) | 9090 | `infra/keycloak-native/` |
| PostgreSQL | systemd (`postgresql`) | 5432 | two DBs: `attendance_intelligence` (app), `keycloak` (IdP) |
| Kafka (KRaft mode) | systemd (`kafka.service`) | 9092 (internal) | `/opt/kafka` |
| nginx | systemd | 80 → 443 redirect | reverse proxy + static SPA host |

Request flow: browser → nginx (TLS) → `/api/*` proxied to backend :8080, `/auth/*` proxied to Keycloak :9090, `/api/v1/retail/*` (when wired up) to retail API :4001, everything else falls through to the SPA (`try_files ... /index.html`).

---

## 2. What actually changes between environments

This is the core answer to "what do I need to change for QA vs. production." Nothing in the *code* should change — only configuration.

### 2.1 Backend `.env` (`backend/api/.env`)

The checked-in `backend/api/.env.example` is **incomplete** relative to what the running app actually reads from `process.env` — treat the table below as the authoritative list, not the example file (worth fixing the example file separately).

| Variable | Dev | QA | Production | Notes |
|---|---|---|---|---|
| `NODE_ENV` | `development` | `staging` or `production` | `production` | Gates some behavior (dev-bypass in `requireTenantAdmin`, etc. — see §4 below, **this is a real security gate, do not leave as `development` in QA if QA is internet-reachable**) |
| `PORT` | 8080 | 8080 | 8080 | Keep consistent so nginx proxy config doesn't need per-env edits |
| `CLIENT_ORIGIN` | `http://localhost:5173` | `https://<qa-domain>` | `https://<prod-domain>` | CORS allow-list |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | local | QA Postgres | prod Postgres | **`.env.example` says `DB_NAME=FRS` — the real databases are named `attendance_intelligence`. Don't copy the example literally.** |
| `DB_SSL` | `false` | environment-dependent | `true` if DB is remote/managed | |
| `EDGE_AI_URL` / `JETSON_SIDECAR_URL` | local sidecar | QA Jetson/sidecar host | real Jetson device IP | Per-environment, never hardcode (existing comment in `.env.example` already says this) |
| `AUTH_MODE` | `keycloak` | `keycloak` | `keycloak` | `api` mode is legacy/deprecated |
| `KEYCLOAK_URL` | `http://localhost:9090` | QA Keycloak URL | prod Keycloak URL | |
| `KEYCLOAK_REALM` | `attendance` | own realm per env (don't share a realm between QA and prod) | `attendance` (or per-tenant realms — see `tenant_realm` table) | |
| `KEYCLOAK_ISSUER` / `KEYCLOAK_AUDIENCE` / `KEYCLOAK_JWKS_URI` / `KEYCLOAK_CLOCK_TOLERANCE_SEC` | — | — | — | **Present in the real `.env`, missing from `.env.example` — add them.** Used by `keycloakVerifier.js`. |
| `KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD` | — | — | — | Also missing from `.env.example`. Needed for realm/user provisioning and the delete-user Keycloak cleanup path in `UserController`. |
| `DEVICE_JWT_SECRET` / `ENROLLMENT_TOKEN_SECRET` / `HRMS_WEBHOOK_API_KEY` | generate fresh | **generate fresh, different from prod** | generate fresh | Server refuses to boot without these (`config/env.js`). Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. **Never reuse the production secret in QA.** |
| `BETA_TESTER_EMAILS` | as needed | as needed | as needed | Comma-separated allowlist |
| `KAFKA_BROKERS` / `KAFKA_CLIENT_ID` / `KAFKA_GROUP_ID` / `KAFKA_TOPIC_PREFIX` / `KAFKA_NUM_PARTITIONS` / `KAFKA_REPLICATION_FACTOR` | local Kafka | QA Kafka | prod Kafka | **Missing from `.env.example` — add them.** `KAFKA_TOPIC_PREFIX` should differ per environment if QA and prod ever share a Kafka cluster (they shouldn't, but if forced to, this is the isolation knob). |
| `SMTP_SERVICE` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM_NAME` | a test inbox or Mailhog | a QA-only mailbox (never real customer-facing "from" address) | real SMTP creds | **Missing from `.env.example`.** Wire QA to a sandboxed mail provider/catch-all so QA testing doesn't send real notification emails to real employees. |
| `APP_URL` / `PUBLIC_BASE_URL` / `ENROLLMENT_PORTAL_URL` | `http://localhost:...` | `https://<qa-domain>/...` | `https://<prod-domain>/...` | **Missing from `.env.example`.** Used to build invite/enrollment links sent in email — get these wrong and QA users get production-looking links (or vice versa). |
| `METRICS_AUTH_TOKEN` / `METRICS_IP_ALLOWLIST` | loose | tighter | tightest | **Missing from `.env.example`.** |
| `FACE_DB_PATH` / `FRAME_QUEUE_SIZE` / `MOTION_SKIP_FRAMES` / `SNAPSHOT_*` / `ENABLE_ALPR` / `ENABLE_FACE_RECOGNITION` / `ENABLE_REID` | tuned for a dev laptop/small box | match target hardware | match target hardware | Performance/feature tuning knobs, not secrets |
| `GOOGLE_CALENDAR_API_KEY` / `COMPANY_CALENDAR_ID` | optional | optional | optional | Falls back to a built-in holiday list if unset |

### 2.2 Retail API `.env.retail` (`backend/api-retail/.env.retail`)

Not currently running on this box at all (no PM2 process for it). If QA needs the retail vertical:

| Variable | Notes |
|---|---|
| `PORT` | 4001, keep consistent with nginx's `/api/v1/retail/` proxy block |
| `RETAIL_DB_URL` | separate `retail_intelligence` database — **create it**, it doesn't exist yet on this host (only `attendance_intelligence` and `keycloak` were provisioned by `pg_setup.sh`) |
| `FRS_DB_URL` | must point at the **same** `attendance_intelligence` DB as the main backend's `DB_*` vars (cross-DB user/tenant lookups) |
| `RETAIL_DEVICE_JWT_SECRET` | generate fresh per environment, same rule as the main backend's device secret |
| `KEYCLOAK_REALM_URL` | must match the realm the main backend uses |

### 2.3 Frontend build-time config (`frontend/.env`)

These are **baked into the build** at `npm run build` time (Vite), not read at runtime — you cannot change these by editing a file on the server after building; you must rebuild.

| Variable | Dev | QA | Production |
|---|---|---|---|
| `VITE_AUTH_MODE` | `mock` (optional) or `keycloak` | `keycloak` | `keycloak` — **never ship `mock` mode past dev** |
| `VITE_API_BASE_URL` | `/api` | `/api` | `/api` (relative path — nginx proxies it, no change needed) |
| `VITE_API_URL` | `http://localhost:8080` | `https://<qa-domain>` | `https://<prod-domain>` |
| `VITE_WS_URL` | `http://localhost:8080` | `https://<qa-domain>` | `https://<prod-domain>` |
| `VITE_KEYCLOAK_URL` | `http://localhost:9090` | QA Keycloak URL | prod Keycloak URL |
| `VITE_KEYCLOAK_REALM` / `VITE_KEYCLOAK_CLIENT_ID` | `attendance` / `attendance-frontend` | match whatever realm QA's backend uses | match prod realm |
| `VITE_APP_BASE_DOMAIN` | `localhost` | `<qa-domain>` | `<prod-domain>` |

### 2.4 nginx (`infra/nginx/nginx.conf.template` → rendered `nginx.conf`)

The repo template is rendered via `infra/nginx/render.sh`, which reads `infra/nginx/.env`:

```
FRS_DOMAIN=<qa-or-prod-domain>
FRS_REPO_ROOT=/absolute/path/to/this/checkout
```

**Important**: the *live* config on this box (`/etc/nginx/conf.d/frs.conf` + `/etc/nginx/frs-locations.conf`) was hand-built for `dev-frs.motivitylabs.com` and has **already diverged** from the repo template (it's missing the `/api/v1/retail/` block the template has, and has extra blocks for an unrelated project sharing this host — `/video/`, `/V1api/`). Don't assume `nginx -t` reflects the repo template; check the actual files under `/etc/nginx/` on whatever box you're working on.

For a new environment: run `infra/nginx/render.sh`, review the output, copy it into place (or `include` it from your real nginx config), point `ssl_certificate`/`ssl_certificate_key` at that environment's cert (Let's Encrypt via `certbot --nginx -d <domain>`, or self-signed for an IP-only environment — see `docs/security/cert-rotation-runbook.md` if one exists, otherwise `openssl req -x509 ...`).

### 2.5 Keycloak realm

**Do not share a Keycloak realm between QA and production.** Each environment needs its own realm (or its own whole Keycloak instance) so:
- QA test users/passwords can't accidentally work in prod and vice versa.
- Realm-level settings (session timeouts, brute-force detection, SMTP for password reset) can be tuned looser for QA without weakening prod.
- `infra/keycloak/realm-export.json` is the base realm config to import (`kc.sh import` per the native-deployment notes) — import it into QA's Keycloak, then change `frontend/.env`'s `VITE_KEYCLOAK_REALM` and the backend's `KEYCLOAK_REALM`/`KEYCLOAK_ISSUER` to match.
- This app also supports **per-tenant realms** (see the `tenant_realm` table and `services/keycloakProvisioner.js`) — if QA needs to test multi-tenant realm provisioning specifically, that's a separate, deeper setup than just importing the base realm.

### 2.6 Database

- Schema is applied via `backend/api/scripts/migrate.js`, which loads `backend/api/src/db/migrations/schema.sql` and is **idempotent** (checks for the `tenant_realm` table first; skips if already applied). Run it once against a fresh QA database: `cd backend/api && node scripts/migrate.js`.
- `pgvector` extension must be installed and enabled (`CREATE EXTENSION IF NOT EXISTS vector;`) — `infra/native-deploy/pg_setup.sh` compiles it from source (v0.5.1) and enables it on both the app DB and the Keycloak DB.
- Seed data / test users are your call for QA — production should **never** be seeded with synthetic data.

---

## 3. Standing up a new QA (or production) box from scratch

Assumes Ubuntu, matching this host. Follow `infra/native-deploy/*.sh` in this order — they're already written for the post-restructure `backend/api` path:

1. **PostgreSQL + pgvector**: `infra/native-deploy/pg_setup.sh`. Change the hardcoded passwords in the script before running anywhere but a fully isolated box — they're dev-grade placeholders (`postgres123`, `keycloak123`).
2. **Kafka**: `infra/native-deploy/kafka_setup.sh` (KRaft mode, no Zookeeper).
3. **Keycloak**: use `infra/keycloak-native/` (systemd unit template), import `infra/keycloak/realm-export.json`, set a real admin password (see §2.5 above — don't reuse prod's realm).
4. **Backend**: `cd backend/api && npm install`, copy `.env.example` → `.env` and fill in per §2.1 (cross-check against the *real* variable list, not just the example file), then `node scripts/migrate.js`, then start via `infra/native-deploy/pm2_setup.sh` (or manually: `pm2 start src/server.js --name frs-backend` from inside `backend/api`).
   - **Note**: `pm2_setup.sh` currently starts the process with `--watch`. The existing production process on this host deliberately does **not** use `--watch` (auto-restart-on-file-change is not what you want for a stable long-running service, and `--watch` also risks restart loops if deploy tooling touches files while the process is live). Recommend dropping `--watch` from the script, or at minimum removing it manually after `pm2_setup.sh` runs.
5. **Retail backend** (optional, not currently live anywhere): `cd backend/api-retail && npm install`, create the `retail_intelligence` database, copy `.env.retail.example` → `.env.retail`, fill in per §2.2, `pm2 start src/index.js --name frs-retail-backend`.
6. **Frontend**: `cd frontend && npm install`, copy `.env.example` → `.env`, fill in per §2.3, `npm run build` → produces `frontend/dist/`.
7. **nginx**: fill in `infra/nginx/.env` per §2.4, run `infra/nginx/render.sh`, install the rendered config, get a cert (`certbot --nginx -d <domain>` or self-signed for IP-only), `nginx -t && systemctl reload nginx`.
8. **`pm2 save`** once everything is confirmed healthy, so the whole stack survives a reboot (systemd `pm2-<user>` service resurrects from this saved list — see the incident this session just fixed for what happens when this step is skipped after a path change).

---

## 4. Environment-gated behavior to be aware of

A few things in the code branch on `NODE_ENV`/config in ways that matter operationally:

- `routes/tenantAdminRoutes.js`'s `requireTenantAdmin` middleware has a **DEV BYPASS**: `if (env.nodeEnv === 'development') { ...skip the tenant-admin check... }`. If QA is reachable outside a trusted network, **do not run it with `NODE_ENV=development`** — this disables a real authorization check. Use `staging` or `production`.
- `authConfig.ts` on the frontend defaults to `mock` auth mode if `VITE_AUTH_MODE` is unset — make sure QA and prod builds always set it explicitly to `keycloak`.
- Rate limiting falls back to an in-memory, per-process store if `REDIS_URL` isn't set (seen in this session's PM2 restart logs: `[RateLimit] REDIS_URL not configured`). Fine for a single QA instance; if QA or prod ever runs more than one backend instance behind a load balancer, this needs a real Redis so limits are shared.
- Kafka SASL is unauthenticated unless configured (`[KafkaConfig] SASL not configured — Kafka connections are unauthenticated (dev mode only)`, also seen live). Fine if Kafka is not network-reachable outside the host; tighten before exposing it.

---

## 5. Verification checklist (any environment)

Run after any deploy or config change:

```bash
# Backend health
curl -s http://localhost:8080/api/health

# Backend requires auth on protected routes (expect 401, not 200 or 500)
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/api/users

# Full backend test suite
cd backend/api && npm test    # expect: 94 passed, 0 failed (at time of writing)

# PM2 process is pointed at the right file and will survive a reboot
pm2 describe frs-backend | grep -E "script path|status"
cat ~/.pm2/dump.pm2 | grep -o '"pm_exec_path":"[^"]*"' # sanity-check the saved path

# nginx config is valid and reloaded
sudo nginx -t && sudo systemctl reload nginx

# Frontend build is current (compare mtimes / rebuild if in doubt)
ls -la frontend/dist/index.html
```

---

## 6. Before this goes to QA — outstanding items

1. ~~Commit the ~1,600 uncommitted files on `dev`~~ — **done 2026-07-10**, pushed to `origin/dev`.
2. ~~Fix the Vite build output path~~ — **done 2026-07-10**, see §0. Redeploy the frontend (`cd frontend && npm run build`) on any box that was built before this fix, since its `dist/` may be stale.
3. Fix `backend/api/.env.example` and `backend/api-retail/.env.retail.example` to include the full real variable list (§2.1/§2.2) — right now they're missing Kafka, SMTP, several Keycloak, and metrics/app-URL variables that the app genuinely reads.
4. Decide whether this host (`dev-frs.motivitylabs.com`) *is* QA going forward, or whether QA is a new box — the live nginx config, PM2 setup, and Keycloak realm all need to be consistent with that decision.
5. If retail is in scope for QA, provision the `retail_intelligence` database and the `/api/v1/retail/` nginx block — neither exists on this host yet.
6. Revisit the `otplib`/`jose` downgrades noted in the native-deployment history (done for a Node 18.19 host) — this host is now running Node 22.22.3, so it's worth confirming whether those downgrades are still necessary or can be reverted.
