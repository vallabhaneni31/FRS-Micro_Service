-- Migration 028: Seed nav_item rows for the Zone Analytics module
-- (specs/0003-zone-analytics, Task 10).
--
-- Zone Analytics is HR-only (requirements.md Revision 3) — seeded for
-- `hr_manager` only, matching the `zones.read` RBAC grant in frs-core-api's
-- 029_seed_zones_read_permission.sql (both repos share the same Postgres
-- database, DB_NAME=attendance_intelligence per each repo's .env — the RBAC
-- seed does not need to be duplicated here).
--
-- item_key values are prefixed `zone_analytics.` and match the
-- PAGE_REGISTRY keys added to frontend/src/app/components/DashboardRenderer.tsx
-- in the same change. nav_item (role_name, item_key, label, icon, sort_order,
-- is_active, vertical) has NO column for a group label/badge (confirmed by
-- reading CREATE TABLE public.nav_item in full, 001_init_schema.sql:2401-2412)
-- so per design.md §3's fallback, group metadata (label "Zone Analytics",
-- "4 VIEWS" badge, MapPin icon) is resolved entirely client-side by
-- frontend/src/app/components/shared/navGrouping.ts, keyed off this
-- `zone_analytics.` key prefix — no schema change.
--
-- vertical = 'corporate' (matches the 002_visitor_unknown_schema.sql
-- precedent for hr_manager-only features; this module has no education-vertical
-- variant per requirements.md's scope).
--
-- Not applied by scripts/migrate.js (see 017's header comment) — applied by
-- hand, consistent with every other seed-data migration in this directory.

INSERT INTO public.nav_item (role_name, item_key, label, icon, sort_order, is_active, vertical)
VALUES
  ('hr_manager', 'zone_analytics.overview',  'Overview Dashboard',   'LayoutDashboard', 90, true, 'corporate'),
  ('hr_manager', 'zone_analytics.deep_dive', 'Zone Deep-Dive',       'BarChart3',       91, true, 'corporate'),
  ('hr_manager', 'zone_analytics.compare',   'Compare Zones',        'Activity',        92, true, 'corporate'),
  ('hr_manager', 'zone_analytics.movement',  'Employee Movement',    'Route',           93, true, 'corporate')
ON CONFLICT (role_name, item_key) DO NOTHING;
