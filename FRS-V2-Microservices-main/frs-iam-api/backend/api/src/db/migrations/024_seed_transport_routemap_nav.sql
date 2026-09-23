-- Migration 024: Add the Route Map nav item for Transport's Route Manager
-- (site_admin) — a real Leaflet map of their depot's routes, drawn from
-- real per-stop lat/lng coordinates (added to the Routes page's stop editor
-- specifically to make this possible without fabricating geography).
-- Deliberately not given to tenant_admin or viewer — Route Map is a
-- Route-Manager-specific working view, not part of the Admin overview
-- (which already covers routes via the Depots/Analytics pages).
-- item_key matches PAGE_REGISTRY's 'transport_routemap' entry in
-- DashboardRenderer.tsx. Icon 'MapPin' is already registered in
-- iconRegistry.ts, no frontend change needed there.
-- Not applied by scripts/migrate.js (see 017's header comment) — applied by hand.

INSERT INTO nav_item (role_name, item_key, label, icon, sort_order, is_active, vertical) VALUES
  ('site_admin', 'transport_routemap', 'Route Map', 'MapPin', 35, true, 'transport');
