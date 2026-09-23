# Requirements: Extract Database Schemas, Seeds, DDLs, and Scripts into Separate Repository

| | |
|---|---|
| **Ticket** | DB-REPO-001 |
| **Project / service** | frs-core-api (extracting to `frs-database`) |
| **Stack** | Node.js ESM, PostgreSQL (`pg`), Bash / SQL, Docker |
| **Status** | Draft |
| **Author** | Antigravity (Edith) |
| **Date** | 2026-09-17 |

> One spec = one folder `specs/NNNN-<slug>/` holding `requirements.md` (this file — the WHAT and
> WHY), `design.md` (the HOW), and `tasks.md` (the ordered execution plan). This file is the
> contract the human approves; the other two derive from it.

## Revisions

| # | What changed | Why | Requirements affected |
|---|--------------|-----|-----------------------|
| 1 | Initial specification draft | Initial feature request | All |

## 1. Problem / Goal

Currently, database DDLs, migration files, seed scripts, maintenance utilities, and database schemas are bundled directly inside application repositories (primarily `frs-core-api/backend/api/src/db/migrations` and `backend/api/scripts/`, with separate migrations inside `backend/api-retail` and `backend/api-transport`). This creates tight coupling between backend application deployment and database lifecycle management, risks schema drift across microservices and branches, complicates multi-tenant database provisioning, and hinders independent schema versioning and CI/CD validation. 

The goal is to extract all database DDL schemas, incremental migrations, seed scripts, SQL patches, and database operational utilities into a dedicated, standalone repository (`frs-database`) equipped with its own automated migration runner, test harness, containerized execution environment, and clean integration interface for downstream microservices.

## 2. Scope

**In scope**
- Creation of a new standalone repository (`frs-database`) with structured directories for Core FRS, Retail, and Transport vertical database assets.
- Migration and consolidation of all SQL schema files (`schema.sql`, `001_init_schema.sql` through `027_lockout_duration_minutes.sql`, `001_camera_attribution_columns.sql`, and Flyway migrations `V1`–`V4`).
- Migration and adaptation of all database seed scripts (`seed.js`, `seed_platform.js`, `seed_device_commands.js`, `reseed_device_commands.js`).
- Migration and adaptation of database maintenance, backup, and diagnostic scripts (`backup.sh`, `schema-drift-patch.sql`, `inspect_db_data.js`, `alter_plans_vertical.js`, `backfill_encrypt_embeddings.js`, `backfill-realm-security-policy.js`, `audit_rbac_membership.js`).
- Implementation of a unified, idempotent Node.js / SQL migration and seeding CLI runner in the new repository supporting target filtering (`--target=core|retail|transport`) and dry-run/inspection modes.
- Creation of automated migration validation and idempotency tests in the new repository running against fresh PostgreSQL test containers/instances.
- Containerization of the migration runner via a dedicated `Dockerfile` for execution in CI/CD pipelines and Kubernetes/ECS init tasks.
- Updates to `frs-core-api` deployment entrypoints (`deploy.sh`, `backend/api/Dockerfile`) and documentation (`QA_AND_PRODUCTION_SETUP.md`, `DR_DRILL_PROCEDURE.md`) to invoke the externalized database migration workflow and eliminate schema file redundancy.

**Non-goals** (explicitly NOT doing)
- Rewriting application data access layers (repositories and services in `frs-core-api` will continue using raw parameterized `pg` queries against the established database schema).
- Extracting non-database scripts from `backend/api/scripts/` (e.g., Computer Vision models `face_quality_service.py` and `mediapipe_engine.py`, Kafka scripts `create-topics.js`, Keycloak administrative scripts `create-keycloak-users.sh` remain in `frs-core-api`).
- Altering existing table definitions, column types, or breaking relational constraints during the extraction.

## 3. Requirements

### Requirement 1 — Centralized Schema and Migration Asset Structure
**User story:** As a platform engineer, I want all database schemas, DDLs, and incremental migrations across FRS verticals housed in a dedicated repository, so that database evolution is tracked independently from application service code.

**Acceptance criteria**
- [ ] **1.1** THE SYSTEM SHALL organize database assets in `frs-database` under vertical-specific directories (`core/migrations/`, `retail/migrations/`, `transport/migrations/`).
- [ ] **1.2** WHEN the migration suite is initialized for Core FRS, THE SYSTEM SHALL contain identical, byte-verified copies of the baseline dump `schema.sql` and migrations `001_init_schema.sql` through `027_lockout_duration_minutes.sql`.
- [ ] **1.3** WHEN the migration suite is initialized for the Retail vertical, THE SYSTEM SHALL contain `retail/migrations/001_camera_attribution_columns.sql`.
- [ ] **1.4** WHEN the migration suite is initialized for the Transport vertical, THE SYSTEM SHALL preserve Flyway-compatible versions `transport/migrations/V1__init_transport_schema.sql` through `V4__add_passenger_face_embeddings.sql`.
- [ ] **1.5** IF a migration file contains `psql` meta-commands (lines starting with `\`), THEN THE SYSTEM SHALL strip or sanitize them prior to execution via node-postgres.

### Requirement 2 — Seed Data and Platform Initialization Extraction
**User story:** As a developer or deployment operator, I want seed scripts and initial data catalogs in the dedicated database repository, so that fresh environments and tenants can be populated consistently.

**Acceptance criteria**
- [ ] **2.1** THE SYSTEM SHALL provide standalone seed runners under `core/seeds/` for default platform setup (`seed_platform.js`), tenant baseline data (`seed.js`), and device command catalogs (`seed_device_commands.js`, `reseed_device_commands.js`).
- [ ] **2.2** WHEN seed execution is triggered against a database where tenant records already exist, THE SYSTEM SHALL log the count of existing records and safely exit without creating duplicate records or throwing foreign key violations.
- [ ] **2.3** IF mandatory database environment variables (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`) are missing during seed execution, THEN THE SYSTEM SHALL exit with status code 1 and emit a descriptive configuration error message.

### Requirement 3 — Database Operational Utilities and Patch Scripts
**User story:** As a database administrator, I want maintenance, backup, and backfill scripts centralized in the database repository, so that operational tasks and schema drift repairs are executed from a single source of truth.

**Acceptance criteria**
- [ ] **3.1** THE SYSTEM SHALL house database operational and backfill scripts under `core/scripts/` (`schema-drift-patch.sql`, `alter_plans_vertical.js`, `audit_rbac_membership.js`, `backfill-realm-security-policy.js`, `backfill_encrypt_embeddings.js`, `inspect_db_data.js`).
- [ ] **3.2** THE SYSTEM SHALL house the PostgreSQL backup utility under `core/backup/backup.sh` supporting automated `pg_dump`, gzip compression, S3 upload, and local 7-day retention rotation.
- [ ] **3.3** WHEN `schema-drift-patch.sql` is executed against an existing database, THE SYSTEM SHALL apply missing schema patches idempotently without dropping active columns or destroying existing table data.

### Requirement 4 — Unified Standalone Migration & Seeding CLI Runner
**User story:** As a DevOps engineer, I want a unified command-line interface in `frs-database`, so that migrations and seeds can be executed consistently in local development and automated deployment pipelines.

**Acceptance criteria**
- [ ] **4.1** WHEN `npm run migrate` is invoked without flags, THE SYSTEM SHALL apply Core FRS baseline `schema.sql` (if uninitialized) followed by all incremental migrations in numerical order.
- [ ] **4.2** WHEN `npm run migrate -- --target=retail` is invoked, THE SYSTEM SHALL execute retail-specific migrations against the configured retail database connection.
- [ ] **4.3** WHEN `npm run migrate -- --target=transport` is invoked, THE SYSTEM SHALL execute transport-specific migrations against the configured transport database connection.
- [ ] **4.4** WHEN `npm run seed` is invoked with `--target=core`, THE SYSTEM SHALL execute `seed_platform.js` and `seed.js` sequentially against the Core database.
- [ ] **4.5** IF any individual migration file fails execution during a run, THEN THE SYSTEM SHALL halt execution immediately, roll back the active transaction (for transactional DDLs), report the failing file name and PostgreSQL error code, and exit with status code 1.
- [ ] **4.6** THE SYSTEM SHALL provide a containerized entrypoint via `Dockerfile` supporting execution as a Kubernetes InitContainer or AWS ECS RunTask with commands `migrate` and `seed`.

### Requirement 5 — Test Automation and Idempotency Verification
**User story:** As a release engineer, I want automated CI test suites in the new repository, so that broken SQL migrations and non-idempotent scripts are caught prior to production rollout.

**Acceptance criteria**
- [ ] **5.1** WHEN `npm test` is executed in `frs-database`, THE SYSTEM SHALL execute migrations from scratch on a clean PostgreSQL database instance and assert that all tables, indexes, and constraints exist.
- [ ] **5.2** WHEN `npm test` runs migrations a second consecutive time against the already-migrated database, THE SYSTEM SHALL complete with 0 errors, asserting full idempotency.
- [ ] **5.3** WHEN `npm run test:seed` is executed following migrations, THE SYSTEM SHALL assert that platform roles, permissions, and default device command catalogs are populated.

### Requirement 6 — Decoupling and Consumer Integration in `frs-core-api`
**User story:** As a backend maintainer, I want `frs-core-api` cleanly decoupled from embedded database scripts while maintaining continuous deployment stability, so that applications use the externalized database lifecycle seamlessly.

**Acceptance criteria**
- [ ] **6.1** WHEN `deploy.sh` is executed in `frs-core-api`, THE SYSTEM SHALL invoke the migration runner using the decoupled migration entrypoint without relying on stale local copies.
- [ ] **6.2** WHEN `backend/api/Dockerfile` builds and starts in containerized environments, THE SYSTEM SHALL execute migrations and seeding via the standardized external runner interface before launching `src/server.js`.
- [ ] **6.3** THE SYSTEM SHALL update operational documentation (`QA_AND_PRODUCTION_SETUP.md`, `DR_DRILL_PROCEDURE.md`) to guide engineers on running migrations and seeds from `frs-database`.
- [ ] **6.4** WHILE transitioning downstream consumers, THE SYSTEM SHALL ensure `frs-core-api` runtime database connection configuration (`backend/api/src/db/pool.js`) remains 100% backward-compatible.

## 4. Open questions / follow-ups

- CI/CD repository hosting: Will `frs-database` be hosted under the same Azure DevOps / GitHub organization with separate deployment pipeline triggers, or integrated as a Git submodule in `frs-core-api`? (Non-blocking: the standalone CLI and Docker runner support both decoupled CI triggers and submodule mounting).
- Flyway vs Node runner for Transport: When Transport API is split into its own repository, will it continue using Java Flyway plugin directly against `transport/migrations` or use the unified Node CLI? (Non-blocking: files are named `V1`–`V4` to preserve Flyway compatibility while also being runnable by the unified CLI).
