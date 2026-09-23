-- ============================================================================
-- Migration: 006_facility_device_column_defaults.sql
--
-- Purpose: Add safe column defaults to facility_device so that partial /
--          missing data from the application layer can never trigger a
--          NOT NULL constraint violation.
--
-- Affected columns:
--   location_label  — was NOT NULL with no default; now defaults to 'Not set'
--   ip_address      — was NOT NULL with no default; now defaults to '0.0.0.0'
--   status          — was NOT NULL with no default; now defaults to 'offline'
-- ============================================================================

ALTER TABLE public.facility_device
  ALTER COLUMN location_label SET DEFAULT 'Not set';

ALTER TABLE public.facility_device
  ALTER COLUMN ip_address SET DEFAULT '0.0.0.0';

ALTER TABLE public.facility_device
  ALTER COLUMN status SET DEFAULT 'offline';

-- Also make location_label explicitly safe by back-filling any existing NULLs
-- (should not exist, but guards against legacy data)
UPDATE public.facility_device
SET
  location_label = COALESCE(NULLIF(TRIM(location_label), ''), 'Not set'),
  ip_address     = COALESCE(NULLIF(TRIM(ip_address),     ''), '0.0.0.0'),
  status         = COALESCE(NULLIF(TRIM(status),         ''), 'offline')
WHERE
  location_label IS NULL OR TRIM(location_label) = ''
  OR ip_address  IS NULL OR TRIM(ip_address)     = ''
  OR status      IS NULL OR TRIM(status)         = '';
