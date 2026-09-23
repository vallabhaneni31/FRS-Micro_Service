-- Migration 021: Add the Depots nav item for Transport's tenant_admin role
-- only — Route Manager (site_admin) is scoped to exactly one depot and
-- manages it implicitly through Routes/Buses, so they don't get a separate
-- Depots list page. item_key matches PAGE_REGISTRY's 'transport_depots'
-- entry in DashboardRenderer.tsx. Icon 'Building2' is already registered in
-- iconRegistry.ts, no frontend change needed there.
-- Not applied by scripts/migrate.js (see 017's header comment) — applied by hand.

INSERT INTO nav_item (role_name, item_key, label, icon, sort_order, is_active, vertical) VALUES
  ('tenant_admin', 'transport_depots', 'Depots', 'Building2', 15, true, 'transport');
