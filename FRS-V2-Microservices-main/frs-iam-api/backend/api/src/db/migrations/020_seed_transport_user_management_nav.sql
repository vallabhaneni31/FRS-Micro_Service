-- Migration 020: Add the User Management nav item for Transport's
-- tenant_admin and site_admin roles only — hr_manager (Operations Manager)
-- deliberately does not get this page, matching the persona spec ("no
-- list/index pages" for that role). item_key matches PAGE_REGISTRY's
-- 'transport_users' entry in DashboardRenderer.tsx. Icon 'Users' is
-- already registered in iconRegistry.ts, no frontend change needed there.
-- Not applied by scripts/migrate.js (see 017's header comment) — applied by hand.

INSERT INTO nav_item (role_name, item_key, label, icon, sort_order, is_active, vertical) VALUES
  ('tenant_admin', 'transport_users', 'User Management', 'Users', 45, true, 'transport'),
  ('site_admin',   'transport_users', 'User Management', 'Users', 45, true, 'transport');
