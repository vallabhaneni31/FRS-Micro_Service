-- 026_seed_transport_operations_manager_nav.sql
-- Operations Manager (hr_manager, BUS-scoped) Transport UI — the full
-- portal was deferred until Track B's backend existed; it now does, so
-- this seeds the remaining sidebar entries alongside the existing
-- transport_dashboard row (sort 10).
INSERT INTO nav_item (role_name, item_key, label, icon, sort_order, is_active, vertical) VALUES
  ('hr_manager', 'transport_stops',      'Bus Stops',           'MapPin',    15, true, 'transport'),
  ('hr_manager', 'transport_enrollment', 'Enrollment',          'UserPlus',  20, true, 'transport'),
  ('hr_manager', 'transport_attendance', 'Attendance',          'Clock',     25, true, 'transport'),
  ('hr_manager', 'transport_analytics',  'Analytics & Insights','BarChart3', 30, true, 'transport'),
  ('hr_manager', 'transport_settings',   'Settings',            'Settings',  35, true, 'transport')
ON CONFLICT (role_name, item_key) DO NOTHING;
