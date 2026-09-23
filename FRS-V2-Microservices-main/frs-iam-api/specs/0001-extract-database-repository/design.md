# Design: Extract Database Schemas, Seeds, DDLs, and Scripts into Separate Repository

> The HOW for the requirements in `requirements.md` (same folder). Ground every claim about current
> behavior in real code (`path/to/File.ext:42`).

## 1. Current behavior

Today, database schemas, migration files, seed scripts, and operational database tools are embedded inside `frs-core-api`:

- **Core FRS Schema & Migrations**: Located at `backend/api/src/db/migrations/` (`schema.sql` at line 1, and 36 incremental SQL files `001_init_schema.sql` through `027_lockout_duration_minutes.sql`).
- **Core Migration Runner**: Hand-written in `backend/api/scripts/migrate.js:1-67`. It reads `schema.sql` and checks `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenant_realm')`. If not present, it applies `schema.sql`; then it iterates through `\d+.*\.sql` files and executes each via `pool.query(sql)` (`backend/api/scripts/migrate.js:33-55`).
- **Seed Scripts**:
  - `backend/api/scripts/seed.js:1-35`: seeds default tenant, role permissions, and admin user.
  - `backend/api/scripts/seed_platform.js:1-50`: seeds platform super_admin, default platform tenant, and base roles.
  - `backend/api/scripts/seed_device_commands.js:1-80` and `backend/api/scripts/reseed_device_commands.js:1-60`: populates default device command catalog.
- **Database Operational & Backfill Scripts**:
  - `backend/api/scripts/backup.sh:1-56`: runs `pg_dump` and uploads to S3 bucket `frs-database-backups-production`.
  - `backend/api/scripts/schema-drift-patch.sql:1-120`: manual SQL patch for schema drift across staging/prod.
  - `backend/api/scripts/alter_plans_vertical.js:1-25`, `audit_rbac_membership.js:1-180`, `backfill-realm-security-policy.js:1-65`, `backfill_encrypt_embeddings.js:1-75`, `inspect_db_data.js:1-45`.
- **Retail Vertical Migrations**: Located at `backend/api-retail/src/db/migrations/001_camera_attribution_columns.sql:1-15`.
- **Transport Vertical Migrations**: Located at `backend/api-transport/src/main/resources/db/migration/` (`V1__init_transport_schema.sql` through `V4__add_passenger_face_embeddings.sql`), managed via Flyway in `backend/api-transport/pom.xml:42-56`.
- **Deployment & Container Coupling**:
  - `deploy.sh:44-47`: calls `(cd backend/api && node scripts/migrate.js)`.
  - `backend/api/Dockerfile:70-81`: executes `node scripts/migrate.js`, performs an inline node snippet to check `SELECT count(*)::int as c FROM frs_tenant`, imports `./scripts/seed.js` if 0, and then starts `node src/server.js`.
  - Runbooks `docs/runbooks/QA_AND_PRODUCTION_SETUP.md:120,133` and `docs/runbooks/DR_DRILL_PROCEDURE.md:119` document running `node scripts/migrate.js` directly inside `backend/api/`.

## 2. Proposed design

Extract these assets into a dedicated standalone repository: `frs-database` (sibling repository).

### 2.1 Target Repository Layout (`frs-database`)

```
frs-database/
├── .github/
│   └── workflows/
│       └── ci.yml                     # Automated PR linting & migration integration tests
├── .env.example                       # DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, etc.
├── .gitignore
├── Dockerfile                         # Containerized migration & seed runner
├── package.json                       # ESM, dependencies: pg, dotenv
├── README.md                          # Usage, architecture, runbook
├── bin/
│   ├── cli.js                         # Command-line entrypoint (migrate, seed, verify)
│   ├── migrationRunner.js             # Core SQL migration executor with transaction wrapping
│   └── seedRunner.js                  # Seed execution dispatcher
├── core/
│   ├── migrations/
│   │   ├── schema.sql                 # Baseline schema dump
│   │   ├── 001_init_schema.sql
│   │   ├── 002_device_zone_type.sql
│   │   ├── ...
│   │   └── 027_lockout_duration_minutes.sql
│   ├── seeds/
│   │   ├── seed_platform.js
│   │   ├── seed.js
│   │   ├── seed_device_commands.js
│   │   └── reseed_device_commands.js
│   ├── scripts/
│   │   ├── schema-drift-patch.sql
│   │   ├── alter_plans_vertical.js
│   │   ├── audit_rbac_membership.js
│   │   ├── backfill-realm-security-policy.js
│   │   ├── backfill_encrypt_embeddings.js
│   │   └── inspect_db_data.js
│   └── backup/
│       └── backup.sh
├── retail/
│   └── migrations/
│       └── 001_camera_attribution_columns.sql
├── transport/
│   └── migrations/
│       ├── V1__init_transport_schema.sql
│       ├── V2__add_depot_scoping.sql
│       ├── V3__add_passengers.sql
│       └── V4__add_passenger_face_embeddings.sql
└── test/
    ├── migration.test.js              # Fresh DB setup & full migration run
    ├── idempotency.test.js            # Re-running migrations without error
    └── seed.test.js                   # Seed validation
```

### 2.2 CLI Interface Contract

The runner exposes standard CLI commands via `package.json` scripts and `bin/cli.js`:

| Command | Arguments / Flags | Description | Exit Codes |
|---|---|---|---|
| `npm run migrate` | `[--target=core\|retail\|transport]` `[--dry-run]` | Applies baseline schema (if clean DB) and all pending numerical SQL migrations in order. Defaults to `core`. | `0` on success, `1` on failure with SQL error report. |
| `npm run seed` | `[--target=core]` `[--fresh]` | Executes platform and tenant baseline seeds. Guards against duplicate tenant creation unless `--fresh` is passed. | `0` on success, `1` on missing env or DB error. |
| `npm run seed:commands` | `[--target=core]` | Runs `seed_device_commands.js` to refresh device command catalogs. | `0` on success. |
| `npm run verify-drift` | `[--target=core]` | Validates current database schema against migration catalog, logging applied vs pending files. | `0` if in sync, `2` if drift detected. |
| `npm run backup` | `[--s3-bucket=<bucket>]` | Executes `core/backup/backup.sh` with custom dump and S3 upload. | `0` on success, `1` on failure. |

### 2.3 Migration Runner Design (`bin/migrationRunner.js`)

Unlike the legacy `migrate.js` which swallowed errors with `console.warn` (`backend/api/scripts/migrate.js:53`), the new migration runner implements strict transactional guarantees:

1. **Schema History Tracking**:
   - Creates a metadata table `schema_migrations (version varchar(255) primary key, applied_at timestamp default now(), execution_time_ms integer)` if not already present.
2. **Bootstrap Phase**:
   - Checks if core tables (e.g., `tenant_realm`) exist.
   - If fresh database, executes `schema.sql` (sanitized of psql meta-commands `^\s*\\`).
   - Inserts historical markers into `schema_migrations` for pre-existing migrations up to the baseline.
3. **Incremental Phase**:
   - Discovers all `*.sql` files in the target migrations directory.
   - Queries `SELECT version FROM schema_migrations`.
   - Filters unapplied migrations and sorts them in strict numerical/lexicographical order.
   - For each unapplied migration:
     - Begins a database transaction `BEGIN`.
     - Strips any meta-commands and executes the file content.
     - Records version in `schema_migrations`.
     - Commits the transaction `COMMIT`.
     - If an error occurs: issues `ROLLBACK`, logs the failed file, line, and PostgreSQL error code, and terminates with exit code 1.

### 2.4 Containerized Execution Contract (`Dockerfile`)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
ENTRYPOINT ["node", "bin/cli.js"]
CMD ["migrate", "--target=core"]
```

This container can be run:
- In AWS ECS / Fargate as an init task or standalone deployment task: `docker run --env-file .env frs-database:latest migrate --target=core`
- In Kubernetes as an InitContainer prior to starting the `frs-core-api` pod.
- In CI/CD pipelines as an automated integration step before backend deployment.

### 2.5 `frs-core-api` Integration & Decoupling Strategy

To ensure zero downtime and zero deployment breakage during the transition:

1. **Dual-Phase Transition**:
   - **Phase 1 (Repository Extraction & Verification)**: Create `frs-database`, verify full test suite (`npm test`, idempotency, seed verification).
   - **Phase 2 (Consumer Decoupling)**: 
     - Update `frs-core-api/deploy.sh:47` to run migrations via the new decoupled runner (either via cloned `frs-database` runner or invoking the published container/script).
     - Update `frs-core-api/backend/api/Dockerfile:71-81` to rely on the external migration runner during deployment or via container entrypoint invocation.
     - Document the updated workflow in `frs-core-api/docs/runbooks/QA_AND_PRODUCTION_SETUP.md` and `DR_DRILL_PROCEDURE.md`.
     - Remove obsolete/redundant SQL and migration runner copies from `backend/api/src/db/migrations` and `backend/api/scripts/migrate.js` to prevent schema split-brain.

## 3. Cross-module ripple

| Module / Consumer | Current Dependency | Impact of Extraction | Mitigation |
|---|---|---|---|
| `frs-core-api/deploy.sh` | Line 47 calls `(cd backend/api && node scripts/migrate.js)` | Needs to execute migrations from the extracted runner | Configure `deploy.sh` to execute the migration runner from `frs-database` directory or container. |
| `frs-core-api/backend/api/Dockerfile` | Lines 70-81 runs `node scripts/migrate.js` and inline seed snippet | Container size reduced; DB lifecycle decoupled | App container focuses solely on serving traffic (`node src/server.js`); migrations run via init container or deployment step. |
| `backend/api/src/db/pool.js` | Uses runtime env vars (`DB_HOST`, etc.) | **No change** — runtime connection pool remains intact | Preserves complete backward compatibility. |
| `backend/api-retail/deploy_retail.sh` | Comments note migration dependency on core FRS | Retail migrations run via `--target=retail` | Separate target execution. |
| `backend/api-transport` | Uses Flyway with `src/main/resources/db/migration/` | Schema files centralized in `transport/migrations/` | Flyway can read centralized folder or use maven flyway plugin configuration pointing to repo. |
| CI/CD (`azure-pipelines.yml`) | Triggers backend deployment on `backend/api/**` changes | Database changes will now trigger independent testing in `frs-database` | Pipeline triggers isolated; DB changes can be validated before deploying API code. |

## 4. Test strategy

| Criterion | Test type | Test file / method | Description |
|---|---|---|---|
| **1.1, 1.2, 1.3, 1.4** | unit / audit | `test/assetIntegrity.test.js` | Asserts all required files (`schema.sql`, `001`–`027`, `retail/001`, `transport/V1`–`V4`) exist and match source checksums. |
| **1.5** | unit | `test/sanitizer.test.js` | Asserts psql meta-commands (lines starting with `\`) are stripped correctly before execution. |
| **2.1, 2.2, 2.3** | integration | `test/seed.test.js` | Runs `npm run seed`, verifies tenant/roles/commands inserted; re-runs and asserts duplicate-check guards; tests missing env validation. |
| **3.1, 3.2, 3.3** | integration | `test/scripts.test.js` | Executes `schema-drift-patch.sql` and diagnostic scripts against populated schema; verifies non-destructive behavior. |
| **4.1, 4.2, 4.3** | integration / functional | `test/migration.test.js` | Runs `npm run migrate` for core, retail, transport; verifies tables and indexes are created. |
| **4.4** | integration | `test/seed.test.js` | Tests `npm run seed -- --target=core` execution and verify platform tenant and admin creation. |
| **4.5** | integration | `test/errorHandling.test.js` | Introduces an invalid SQL syntax migration file and asserts immediate failure, rollback, and exit code 1. |
| **4.6** | functional / container | `test/dockerRunner.test.js` | Builds the Dockerfile and executes containerized migration against PostgreSQL container. |
| **5.1** | integration | `test/migration.test.js` | Full end-to-end migration from blank DB to current version. |
| **5.2** | integration | `test/idempotency.test.js` | Consecutive execution of migration runner on already-up-to-date database yields 0 errors. |
| **5.3** | integration | `test/seed.test.js` | Asserts RBAC role permissions, platform user, and device command catalogs are present post-seed. |
| **6.1, 6.2** | functional / E2E | `frs-core-api` verification | Validates `deploy.sh` and container startup with externalized migration workflow. |
| **6.3, 6.4** | manual / audit | Documentation review | Confirms runbooks reflect new commands and `pool.js` runtime connects normally. |

### 4.1 Final acceptance (gate before `Verified`)

The spec is **not** `Verified` until:
1. `npm test` in `frs-database` passes 100% green against a fresh PostgreSQL test instance (running all unit, integration, and idempotency tests).
2. Container test `docker build -t frs-database:test . && docker run --rm frs-database:test migrate --dry-run` executes cleanly.
3. `frs-core-api` test suite (`npm --prefix backend/api run test`) passes with existing database pool connectivity intact.

## 5. Rollout & risks

- **Rollout Order**:
  1. Initialize `frs-database` repository, establish directory hierarchy, migrate all SQL and script assets.
  2. Implement CLI runner (`bin/cli.js`, `bin/migrationRunner.js`, `bin/seedRunner.js`) and Dockerfile.
  3. Validate test suite across clean and existing databases.
  4. Update `frs-core-api` deployment scripts and container configurations.
  5. Archive/remove legacy scripts from `frs-core-api` once the new repo is deployed and active in the deployment pipeline.
- **Risks & Mitigations**:
  - *Risk*: Discrepancy between `schema.sql` and incremental migrations 001–027.
    *Mitigation*: Automated checksum audit and integration test that runs both paths (bootstrap from `schema.sql` + delta vs. sequential `001`–`027`) and verifies identical schema catalog via Postgres `information_schema`.
  - *Risk*: `deploy.sh` failure during rollout if database repository is unreachable.
    *Mitigation*: Support dual execution fallback in `deploy.sh` during transitional phase.
