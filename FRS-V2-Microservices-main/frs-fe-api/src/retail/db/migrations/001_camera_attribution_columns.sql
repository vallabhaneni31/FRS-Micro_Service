-- 001_camera_attribution_columns.sql
--
-- Backfills the schema that commit f6387c55 ("feat: implement global store
-- selection and management system with cross-platform navigation support")
-- assumed but never shipped a migration for. That commit added
-- cameraResolver.js plus external_id reads/writes in cameraRoutes.js, and
-- started writing camera_id into three tables. Only
-- people_count_events.camera_id was ever applied, so every other path 500s:
--
--   GET/POST /stores/:id/cameras     -> column "external_id" does not exist
--   POST     /devices/:id/snapshot   -> same, whenever a camera slug is sent
--   POST     /devices/:id/occupancy  -> occupancy_snapshots.camera_id missing
--   POST     /devices/:id/count      -> same
--   POST     /devices/:id/heartbeat  -> device_health.camera_id missing
--
-- All columns are nullable with no default, so on PostgreSQL 11+ these are
-- catalog-only changes: no table rewrite, existing rows keep their data and
-- simply read NULL for the new column.
--
-- NOTE: retail_intelligence (RETAIL_DB_URL) has no migration runner in this
-- repo yet — apply by hand with
--   psql "$RETAIL_DB_URL" -f 001_camera_attribution_columns.sql
-- on EVERY environment. Re-running is safe.

BEGIN;

-- Root cause. cameraRoutes.js both SELECTs and INSERTs external_id, so
-- without this column a camera can never be listed or registered at all,
-- and resolveCameraId() throws on its own lookup query rather than
-- returning NULL as its contract promises.
ALTER TABLE cameras
  ADD COLUMN IF NOT EXISTS external_id varchar(128);

-- Device-facing slug ("bullet-camera-02"), resolved per store. Scoped to
-- store_id rather than global: edge_devices.external_id is globally unique,
-- which makes re-registering a device silently MOVE it between tenants.
-- Don't repeat that here. Partial so multiple NULLs remain allowed.
CREATE UNIQUE INDEX IF NOT EXISTS cameras_store_external_id_key
  ON cameras (store_id, external_id)
  WHERE external_id IS NOT NULL;

-- Leaf writes. countRoutes.js and deviceRoutes.js pass resolveCameraId()
-- output into these inserts unconditionally, so they fail even when the
-- device sends no camera_id at all.
ALTER TABLE occupancy_snapshots
  ADD COLUMN IF NOT EXISTS camera_id uuid REFERENCES cameras(id) ON DELETE SET NULL;

ALTER TABLE device_health
  ADD COLUMN IF NOT EXISTS camera_id uuid REFERENCES cameras(id) ON DELETE SET NULL;

COMMIT;
