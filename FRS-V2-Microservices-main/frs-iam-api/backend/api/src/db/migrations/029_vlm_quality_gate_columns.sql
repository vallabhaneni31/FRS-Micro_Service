-- Migration 029: VLM photo-quality gate columns on visitor_buffer (observability/audit)
--
-- Backs the server-side VLM frame-quality gate in visitorValidationService.js:
-- before a buffered visitor sighting is promoted to the `person` table, its
-- photo is checked by a self-hosted VLM (backend/api/scripts/vlm_quality_service.py).
-- These columns just record the verdict for audit — they never affect the
-- `status` state machine (still only 'pending'|'employee_match'|'promoted'|'rejected'
-- from migration 007); a rejected frame still promotes normally, it just
-- withholds photo_url instead.
BEGIN;

ALTER TABLE public.visitor_buffer
  ADD COLUMN IF NOT EXISTS vlm_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS vlm_usable     BOOLEAN,
  ADD COLUMN IF NOT EXISTS vlm_reason     TEXT;

COMMIT;
