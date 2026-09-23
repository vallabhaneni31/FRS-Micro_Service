-- Migration 019: Seed nav items for the new retail Owner admin pages
-- (Store Management, User Management, Device Management). Owner-only
-- (tenant_admin, per FRS_ROLE_MAP's retail OWNER mapping) — the pages
-- themselves also gate on retail_users.role === 'OWNER', mirroring
-- how 'retail_settings' (Store Settings) is tenant_admin-only today.
INSERT INTO public.nav_item (role_name, item_key, label, icon, sort_order, is_active, vertical)
VALUES
  ('tenant_admin', 'retail_stores',  'Store Management',  'Building2', 41, true, 'retail'),
  ('tenant_admin', 'retail_users',   'User Management',   'Users',     42, true, 'retail'),
  ('tenant_admin', 'retail_devices', 'Device Management', 'Server',    43, true, 'retail')
ON CONFLICT (role_name, item_key) DO NOTHING;
