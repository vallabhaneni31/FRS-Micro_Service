-- Migration 025: Extend the Analytics nav item to Route Manager (site_admin)
-- — same page as Transport Admin's, naturally scoped by the backend to
-- their own depot (DepotService/RouteService/BusService/EventHistoryService
-- all already scope DEPOT-level callers). Not given to hr_manager
-- (Operations Manager) — a single-bus scope has no organizational hierarchy
-- to show; their own analytics page is a separate, future build.
-- item_key matches PAGE_REGISTRY's 'transport_analytics' entry already
-- wired in DashboardRenderer.tsx.
-- Not applied by scripts/migrate.js (see 017's header comment) — applied by hand.

INSERT INTO nav_item (role_name, item_key, label, icon, sort_order, is_active, vertical) VALUES
  ('site_admin', 'transport_analytics', 'Analytics', 'BarChart3', 25, true, 'transport');
