-- 016_photo_lookup_trgm_indexes.sql
-- Site-wide slowness incident: every authenticated photo request
-- (GET /photos/:filename, and the generic /uploads mount) resolves the
-- bare filename back to its stored location via photoResolverService.js
-- and verifies tenant ownership via photoAccess.js's tenantOwnsPhoto —
-- both do a sequence of `col ILIKE '%filename%'` scans across several
-- tables. A leading-wildcard ILIKE can never use a plain btree index, so
-- every one of these was a full table scan.
--
-- device_events is the worst case: 539K rows (~1.3GB), scanned TWICE per
-- photo request (once in tenantOwnsPhoto, once in resolvePhotoByFilename).
-- Measured live: ~245ms per scan in isolation; under the concurrency of a
-- single Visitor Directory page load (~50 rows, each firing its own photo
-- request), these piled up and exhausted pgbouncer's 20-connection pool
-- shared by the whole app — starving unrelated requests (/employees,
-- /alerts, /attendance, /bootstrap all observed at 10-17s) across the
-- entire site, not just the page loading the photos.
--
-- Fix: pg_trgm GIN indexes let Postgres use an index for ILIKE '%x%'
-- instead of a full scan. Same technique, same house style as
-- 015_device_events_payload_employee_index.sql (which fixed an analogous
-- device_events scan, 14,980ms -> 23ms).
--
-- CONCURRENTLY: do not wrap this migration in a transaction when applying
-- to a live table (non-blocking build; must run outside BEGIN/COMMIT).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Highest priority: hit twice per photo request, by far the largest table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_events_photo_url_trgm
ON device_events USING gin ((payload_json->>'photo_url') gin_trgm_ops)
WHERE payload_json->>'photo_url' IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_person_photo_url_trgm
ON person USING gin (photo_url gin_trgm_ops)
WHERE photo_url IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_person_face_embeddings_photo_trgm
ON person_face_embeddings USING gin (photo_path gin_trgm_ops)
WHERE photo_path IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attendance_record_checkin_photo_trgm
ON attendance_record USING gin (checkin_photo_url gin_trgm_ops)
WHERE checkin_photo_url IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attendance_record_checkout_photo_trgm
ON attendance_record USING gin (checkout_photo_url gin_trgm_ops)
WHERE checkout_photo_url IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_employee_face_embeddings_photo_trgm
ON employee_face_embeddings USING gin (photo_path gin_trgm_ops)
WHERE photo_path IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_enrollment_invitations_photo_paths_trgm
ON enrollment_invitations USING gin ((photo_paths::text) gin_trgm_ops)
WHERE photo_paths IS NOT NULL;
