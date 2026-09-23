-- =============================================================================
-- Schema Drift Patch — bring an EXISTING database up to what the code expects
-- =============================================================================
--
-- WHY THIS EXISTS:
--   scripts/migrate.js short-circuits ("Migrations already applied. Skipping
--   execution.") as soon as the `tenant_realm` table exists. On any already-
--   provisioned environment (UAT, prod, an existing dev box) that means edits to
--   migration files — and even brand-new migrations — never run. The columns
--   below were added to the code but their migrations never executed on existing
--   DBs, causing runtime `column "<x>" does not exist` errors.
--
-- WHAT IT DOES:
--   Adds every column the code references that is missing on a drifted DB.
--   Every statement is idempotent (ADD COLUMN IF NOT EXISTS), so this file is
--   safe to run any number of times and on a DB that already has some/all of
--   the columns — it is a no-op for those.
--
-- HOW TO RUN (on UAT / any existing DB):
--   PGPASSWORD=<pw> psql -h <host> -U <user> -d attendance_intelligence \
--       -v ON_ERROR_STOP=1 -f backend/scripts/schema-drift-patch.sql
--
-- Fresh installs do NOT need this — the same columns are defined in the
-- migrations (031, 060) which run on a clean DB.
-- =============================================================================

BEGIN;

-- ── Login / manifest flow ────────────────────────────────────────────────────
-- frs_user predates the users-table consolidation (migration 060).
ALTER TABLE frs_user   ADD COLUMN IF NOT EXISTS is_active   boolean NOT NULL DEFAULT true;
ALTER TABLE frs_user   ADD COLUMN IF NOT EXISTS preferences jsonb   NOT NULL DEFAULT '{}'::jsonb;

-- nav_item predates the multitenant "vertical" concept (migration 031).
-- NULL = item shown for all verticals; otherwise 'corporate' | 'education'.
ALTER TABLE nav_item   ADD COLUMN IF NOT EXISTS vertical    varchar(16)
    CHECK (vertical IN ('corporate','education'));

-- ── Device health probe (server.js 30s interval) + GDPR erasure ──────────────
-- Queried as COALESCE(fd.use_tls, ...) on facility_device; the column lives on
-- frs_nug_box but not facility_device.
ALTER TABLE facility_device ADD COLUMN IF NOT EXISTS use_tls boolean DEFAULT false;

-- ── Enrollment invitation photo-capture route ───────────────────────────────
-- enrollmentRoutes.js selects these from hr_employee.
ALTER TABLE hr_employee ADD COLUMN IF NOT EXISTS consent_given_at     timestamptz;
ALTER TABLE hr_employee ADD COLUMN IF NOT EXISTS consent_withdrawn_at timestamptz;
ALTER TABLE hr_employee ADD COLUMN IF NOT EXISTS consent_method       varchar(32);

-- ── Employee manager-hierarchy (dev branch 009_employee_manager /
-- 010_employee_is_manager) — EmployeeService.js now joins/selects
-- e.fk_manager_id and mgr.full_name unconditionally, so this must land
-- before that code runs on this DB or every employee list/detail call 500s.
ALTER TABLE hr_employee ADD COLUMN IF NOT EXISTS fk_manager_id BIGINT REFERENCES hr_employee(pk_employee_id) ON DELETE SET NULL;
ALTER TABLE hr_employee ADD COLUMN IF NOT EXISTS is_manager BOOLEAN NOT NULL DEFAULT false;

COMMIT;

-- fk_manager_id's index uses a plain (non-concurrent) CREATE INDEX in the
-- source migration; safe to run inside the transaction above, but kept here
-- with the other post-COMMIT indexes for consistency of this file's layout.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hr_employee_manager
  ON public.hr_employee (fk_manager_id);

-- ── GET /api/hr/departments — perf index ────────────────────────────────────
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so this
-- lives outside the BEGIN/COMMIT above. Idempotent (IF NOT EXISTS) like
-- everything else in this file.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hr_employee_tenant_dept_status
  ON public.hr_employee (tenant_id, fk_department_id, status);

-- =============================================================================
-- NOT included (intentionally) — dead code, would need a rewrite not a column:
--   * biasEvaluationService.js  → runBiasEvaluation has no caller; references
--       hr_employee.gender/date_of_birth and attendance_record.match_confidence/
--       attendance_type (the live cron uses recognition_accuracy instead).
--   * repositories/deviceRepository.js → only imported by the unmounted
--       middleware/deviceAuth.js; targets a different `devices`→frs_floor→
--       frs_building design (fk_floor_id, client_id, building_name). The live
--       device path uses facility_device. Delete or rewrite rather than patch.
-- =============================================================================
