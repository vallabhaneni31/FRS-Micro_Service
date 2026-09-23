-- Migration 017: Allow 'transport' vertical across all 5 vertical-scoped tables.
--
-- Migration 008 (allow_retail_vertical) only widened `tenants` — frs_tenant,
-- subscription_plans, nav_item, and scopes were widened separately/manually
-- and never got a matching numbered migration, so this file intentionally
-- covers all 5 in one place rather than repeating that gap.
--
-- Each new constraint preserves exactly what live production currently
-- allows for that table (confirmed via pg_get_constraintdef before writing
-- this) and only appends 'transport' — it does not add 'retail' to `scopes`,
-- which never got it and is left untouched here, out of scope for this change.
--
-- NOTE: as of 2026-08, scripts/migrate.js no-ops on an already-initialized
-- database (it only bootstraps a fresh install via schema.sql, short-circuiting
-- once `tenant_realm` exists) — it does NOT apply numbered migration files
-- incrementally. This file is applied by hand against the live database; it
-- is not picked up automatically by `node scripts/migrate.js` or deploy.sh.

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_vertical_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_vertical_check
  CHECK (vertical IN ('corporate', 'education', 'retail', 'transport'));

ALTER TABLE frs_tenant DROP CONSTRAINT IF EXISTS frs_tenant_vertical_check;
ALTER TABLE frs_tenant ADD CONSTRAINT frs_tenant_vertical_check
  CHECK (vertical IN ('corporate', 'education', 'retail', 'transport'));

ALTER TABLE subscription_plans DROP CONSTRAINT IF EXISTS subscription_plans_vertical_check;
ALTER TABLE subscription_plans ADD CONSTRAINT subscription_plans_vertical_check
  CHECK (vertical IN ('corporate', 'education', 'retail', 'transport'));

ALTER TABLE nav_item DROP CONSTRAINT IF EXISTS nav_item_vertical_check;
ALTER TABLE nav_item ADD CONSTRAINT nav_item_vertical_check
  CHECK (vertical IN ('corporate', 'education', 'retail', 'transport') OR vertical IS NULL);

ALTER TABLE scopes DROP CONSTRAINT IF EXISTS scopes_vertical_check;
ALTER TABLE scopes ADD CONSTRAINT scopes_vertical_check
  CHECK (vertical IN ('corporate', 'education', 'transport'));
