-- Migration 018: Seed the 'retail_live' sidebar nav item (Live View) for the
-- retail vertical, placed right after 'retail_analytics' (Traffic Analytics / Insights).
INSERT INTO public.nav_item (role_name, item_key, label, icon, sort_order, is_active, vertical)
VALUES
  ('hr_manager',   'retail_live', 'Live View', 'Camera', 25, true, 'retail'),
  ('tenant_admin', 'retail_live', 'Live View', 'Camera', 25, true, 'retail')
ON CONFLICT (role_name, item_key) DO NOTHING;
