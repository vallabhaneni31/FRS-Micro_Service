-- 030: trigram index for the photo ownership lookup.
-- frs-fe-api's tenantOwnsPhoto() / resolvePhotoByFilename() search
--   device_events WHERE payload_json->>'photo_url' ILIKE '%<filename>%'
-- which was a sequential scan (~2.7s at 400k rows, timing out under load).
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so
-- run these statements directly with psql (not wrapped in BEGIN/COMMIT).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_events_photo_url_trgm
  ON device_events USING gin ((payload_json->>'photo_url') gin_trgm_ops);
