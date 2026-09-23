-- Migration 019: Seed subscription_plans rows for the Transport vertical.
--
-- Root cause of "No plans configured for this vertical yet" in the tenant
-- creation wizard: CreateTenantWizard.tsx fetches GET /app-admin/tenant-types
-- (backed 1:1 by subscription_plans, see tenantTypeRepository.js) and filters
-- by vertical client-side — zero rows existed for vertical='transport', so
-- the tier list was correctly empty. Not a code bug; the same class of gap
-- as nav_item before migration 018.
--
-- plan_type is deliberately 'enterprise' for both rows, matching what the
-- CURRENT createTenantType() API path already sets for every new plan
-- regardless of vertical (tenantTypeRepository.js:42) — NOT retail's older
-- 'retail' plan_type, which predates that code and would have required also
-- widening subscription_plans_plan_type_check (confirmed via
-- pg_get_constraintdef: it allows 'retail' already but not 'transport').
-- Using 'enterprise' avoids a 6th/7th constraint change that isn't actually
-- necessary — plan_type is read-only/display elsewhere (multitenant.js,
-- authRoutes.js), never branched on.
--
-- Feature keys match getFeaturesForVertical('transport') in
-- CreateTenantWizard.tsx exactly (fleet_management, devices, live_occupancy,
-- boarding_events, reports) so the wizard's per-feature checkmarks render
-- correctly instead of silently matching nothing.
--
-- Not applied by scripts/migrate.js (see 017's header comment) — applied by hand.

INSERT INTO subscription_plans (name, description, plan_type, vertical, features, is_active) VALUES
  ('Transport Starter', 'Single-fleet live occupancy tracking with boarding/deboarding event history',
   'enterprise', 'transport', '["live_occupancy", "boarding_events", "reports"]'::jsonb, true),
  ('Transport Pro', 'Multi-fleet management with device provisioning, live occupancy, and full event history',
   'enterprise', 'transport', '["fleet_management", "devices", "live_occupancy", "boarding_events", "reports"]'::jsonb, true);
