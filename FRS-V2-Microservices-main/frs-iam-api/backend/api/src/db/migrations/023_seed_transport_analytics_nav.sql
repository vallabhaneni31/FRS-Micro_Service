-- Migration 023: Add the Analytics nav item for Transport Admin — the
-- organization hierarchy tree (Depot -> Route Manager -> Routes -> Buses)
-- plus the 30-day boarding density heatmap. item_key matches
-- PAGE_REGISTRY's 'transport_analytics' entry in DashboardRenderer.tsx.
-- Icon 'BarChart3' is already registered in iconRegistry.ts.
-- Not applied by scripts/migrate.js (see 017's header comment) — applied by hand.

INSERT INTO nav_item (role_name, item_key, label, icon, sort_order, is_active, vertical) VALUES
  ('tenant_admin', 'transport_analytics', 'Analytics', 'BarChart3', 25, true, 'transport');
