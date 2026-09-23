-- Migration 018: Seed nav_item rows for the Transport vertical.
--
-- Per-role page visibility is derived directly from
-- backend/api-transport's TransportPermissions.java ROLE_PERMISSIONS map
-- (confirmed 2026-08-12), not guessed: a role only gets a nav entry for a
-- page it actually holds read access to, so nobody sees a menu item that
-- would just 403.
--
--   tenant_admin (Transport Admin)     — all BUSES/ROUTES/DEVICES/EVENTS/OCCUPANCY read -> all 5 pages
--   site_admin   (Route Manager)       — same read coverage as tenant_admin -> all 5 pages
--   hr_manager   (Operations Manager)  — only EVENTS_READ/OCCUPANCY_READ, no BUSES/ROUTES/DEVICES_* -> dashboard + events only
--   viewer       (Viewer/Auditor)      — read-only on everything -> all 5 pages
--
-- item_key values match PAGE_REGISTRY in frontend/src/app/components/DashboardRenderer.tsx.
-- icon values match frontend/src/app/components/shared/iconRegistry.ts (Bus/Route/History/Cpu
-- added there in the same change as this file, mirroring what each page component itself uses).
-- NOT applied by scripts/migrate.js (see 017's header comment) — applied by hand.

INSERT INTO nav_item (role_name, item_key, label, icon, sort_order, is_active, vertical) VALUES
  ('tenant_admin', 'transport_dashboard', 'Live Dashboard', 'LayoutDashboard', 10, true, 'transport'),
  ('tenant_admin', 'transport_fleet',     'Fleet',          'Bus',             20, true, 'transport'),
  ('tenant_admin', 'transport_routes',    'Routes',         'Route',           30, true, 'transport'),
  ('tenant_admin', 'transport_devices',   'Devices',        'Cpu',             40, true, 'transport'),
  ('tenant_admin', 'transport_events',    'Event History',  'History',         50, true, 'transport'),

  ('site_admin', 'transport_dashboard', 'Live Dashboard', 'LayoutDashboard', 10, true, 'transport'),
  ('site_admin', 'transport_fleet',     'Fleet',          'Bus',             20, true, 'transport'),
  ('site_admin', 'transport_routes',    'Routes',         'Route',           30, true, 'transport'),
  ('site_admin', 'transport_devices',   'Devices',        'Cpu',             40, true, 'transport'),
  ('site_admin', 'transport_events',    'Event History',  'History',         50, true, 'transport'),

  ('hr_manager', 'transport_dashboard', 'Live Dashboard', 'LayoutDashboard', 10, true, 'transport'),
  ('hr_manager', 'transport_events',    'Event History',  'History',         20, true, 'transport'),

  ('viewer', 'transport_dashboard', 'Live Dashboard', 'LayoutDashboard', 10, true, 'transport'),
  ('viewer', 'transport_fleet',     'Fleet',          'Bus',             20, true, 'transport'),
  ('viewer', 'transport_routes',    'Routes',         'Route',           30, true, 'transport'),
  ('viewer', 'transport_devices',   'Devices',        'Cpu',             40, true, 'transport'),
  ('viewer', 'transport_events',    'Event History',  'History',         50, true, 'transport');
