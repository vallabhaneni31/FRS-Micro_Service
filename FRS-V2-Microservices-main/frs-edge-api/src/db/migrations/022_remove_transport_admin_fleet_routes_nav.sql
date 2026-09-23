-- Migration 022: Transport Admin no longer gets direct Fleet (raw bus CRUD)
-- or Routes (raw route CRUD) nav items — those stay Route-Manager-only
-- (site_admin already has both). Transport Admin's equivalent view is the
-- Depots hierarchy overview page (Depot -> Route Manager -> Routes -> Buses),
-- not a flat bus/route table. site_admin and viewer rows are untouched.
-- Not applied by scripts/migrate.js (see 017's header comment) — applied by hand.

DELETE FROM nav_item
WHERE vertical = 'transport'
  AND role_name = 'tenant_admin'
  AND item_key IN ('transport_fleet', 'transport_routes');
