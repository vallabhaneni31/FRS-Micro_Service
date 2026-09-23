-- Migration 020: Give MANAGER (hr_manager) accounts access to the retail
-- "Store Settings" page too — it was Owner-only in the sidebar, but the page
-- itself already degrades correctly for a Manager (profile view/edit works
-- for their own account; store-hours/timezone/uniform-detection PATCH
-- endpoints remain OWNER-only server-side, so a Manager can view but not
-- edit those fields — matching how every other Owner-only action in this
-- app is already gated at the API layer, not just the nav).
INSERT INTO public.nav_item (role_name, item_key, label, icon, sort_order, is_active, vertical)
VALUES
  ('hr_manager', 'retail_settings', 'Store Settings', 'Settings', 40, true, 'retail')
ON CONFLICT (role_name, item_key) DO NOTHING;
