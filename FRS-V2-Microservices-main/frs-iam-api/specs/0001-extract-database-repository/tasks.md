# Tasks: Extract Database Schemas, Seeds, DDLs, and Scripts into Separate Repository

> The ordered execution plan for `requirements.md` + `design.md` (same folder). `/spec-build`
> executes these **one task at a time**, in order, checking each off — with its tests passing —
> before starting the next.

## Status

| | |
|---|---|
| **Tasks completed** | 0 / 7 |
| **Last executed** | — |

## Task list

- [ ] **1. Initialize Repository Structure and Extract Schema/DDL Assets** — Req: 1.1, 1.2, 1.3, 1.4
  Initialize the `frs-database` standalone repository structure (`package.json`, `.env.example`, `.gitignore`, `README.md`). Create directory hierarchies for `core/migrations/`, `retail/migrations/`, and `transport/migrations/`. Copy and verify byte-for-byte fidelity of `schema.sql`, `001_init_schema.sql` through `027_lockout_duration_minutes.sql` from `frs-core-api/backend/api/src/db/migrations/`, `001_camera_attribution_columns.sql` from `backend/api-retail/src/db/migrations/`, and `V1`–`V4` from `backend/api-transport/src/main/resources/db/migration/`.
  *Tests*: `test/assetIntegrity.test.js` checking file existence, non-emptiness, and checksum match with source files.

- [ ] **2. Extract and Adapt Seed Data and Platform Initialization Scripts** — Req: 2.1, 2.2, 2.3
  Migrate seed scripts into `frs-database/core/seeds/`: extract `seed.js`, `seed_platform.js`, `seed_device_commands.js`, and `reseed_device_commands.js` from `frs-core-api/backend/api/scripts/`. Refactor them to import a localized `db/pool.js` configuration in the new repository. Add environment variable validation guarding against missing `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, and ensure duplicate-tenant guard logs existing count and exits cleanly.
  *Tests*: `test/seed.test.js` verifying clean seed on fresh database, exit with status code 1 on missing env vars, and idempotent exit on duplicate run.

- [ ] **3. Extract Operational Utilities, Backup Scripts, and SQL Patches** — Req: 3.1, 3.2, 3.3
  Move database operational utilities into `frs-database/core/scripts/` (`schema-drift-patch.sql`, `alter_plans_vertical.js`, `audit_rbac_membership.js`, `backfill-realm-security-policy.js`, `backfill_encrypt_embeddings.js`, `inspect_db_data.js`). Move and configure `backup.sh` into `core/backup/backup.sh`. Ensure `schema-drift-patch.sql` is executable and non-destructive.
  *Tests*: `test/scripts.test.js` validating script syntax, execution against test database, and backup script parameter validation.

- [ ] **4. Build Unified Migration & Seeding CLI Runner** — Req: 1.5, 4.1, 4.2, 4.3, 4.4, 4.5
  Implement `bin/cli.js`, `bin/migrationRunner.js`, and `bin/seedRunner.js` in `frs-database`. Features:
  - Meta-command sanitizer stripping lines matching `^\s*\\` (Req: 1.5).
  - Tracking table `schema_migrations` recording applied version, timestamp, and runtime (Req: 4.1).
  - Target routing for `core`, `retail`, and `transport` (Req: 4.1, 4.2, 4.3).
  - Transaction-wrapped execution per migration file with automatic `ROLLBACK` on error, descriptive SQL error reporting, and exit code 1 (Req: 4.5).
  - Seed orchestration command `npm run seed -- --target=core` (Req: 4.4).
  *Tests*: `test/sanitizer.test.js`, `test/migration.test.js`, and `test/errorHandling.test.js` validating transaction rollback on SQL syntax failure.

- [ ] **5. Implement Containerized Migration Runner (Dockerfile) and CI Automation** — Req: 4.6, 5.1, 5.2, 5.3
  Create `frs-database/Dockerfile` with Node 20 Alpine base and entrypoint `["node", "bin/cli.js"]`. Add `.github/workflows/ci.yml` (or Azure pipeline template) configuring automated test execution against a PostgreSQL container. Implement comprehensive integration and idempotency test suites (`test/migration.test.js`, `test/idempotency.test.js`, `test/seed.test.js`).
  *Tests*: `docker build -t frs-database:test .` and `npm test` verifying end-to-end migrations, idempotency on second run, and seed verification.

- [ ] **6. Decouple `frs-core-api` Deployment, Dockerfile, and Runbooks** — Req: 6.1, 6.2, 6.3, 6.4
  Update `frs-core-api`:
  - Update `deploy.sh` to trigger migrations using the decoupled runner (or external invocation).
  - Update `backend/api/Dockerfile` to remove embedded seed execution and rely on the standalone migration runner in deployment orchestration.
  - Update runbooks (`docs/runbooks/QA_AND_PRODUCTION_SETUP.md` and `docs/runbooks/DR_DRILL_PROCEDURE.md`) with instructions for running migrations and seeds from `frs-database`.
  - Verify that `backend/api/src/db/pool.js` remains completely untouched and functional for existing microservice queries.
  *Tests*: Execute syntax check on `deploy.sh`, run `node --check backend/api/src/server.js`, and run `npm --prefix backend/api run test`.

- [ ] **7. Final Acceptance and Verification Gate** — Req: all
  Run full test suites across both repositories:
  - Run `npm test` in `frs-database` (all unit, migration, idempotency, and seed tests passing green).
  - Run `npm run test:api` in `frs-core-api` ensuring runtime backward compatibility.
  - On green, update spec status to `Approved` / `Implemented` and mark all criteria complete.
