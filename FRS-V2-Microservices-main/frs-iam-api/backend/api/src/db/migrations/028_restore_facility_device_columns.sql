-- ============================================================================
-- Migration: 028_restore_facility_device_columns.sql
--
-- Purpose: Restore facility_device columns that 001_init_schema.sql and
--          002_device_zone_type.sql define but this live database never
--          received — per 017_allow_transport_vertical.sql's note,
--          scripts/migrate.js no-ops on an already-initialized database, so
--          numbered migrations after bootstrap require manual application
--          and this table evidently missed several. Confirmed 2026-09-08:
--          17 of ~34 intended columns absent, breaking the HR/attendance
--          dashboard, camera routes, device management, live zone/dwell-time
--          analytics, and employee records wherever they read/write
--          facility_device.
--
-- Safety: all additions are backward compatible (existing readers/writers
--         unaffected by new columns) and NOT NULL columns are added with a
--         DEFAULT so this cannot fail against existing rows. `name` is
--         backfilled from external_device_id (the only per-row identifier
--         guaranteed present) rather than a placeholder string.
-- ============================================================================

ALTER TABLE public.facility_device
  ADD COLUMN IF NOT EXISTS name character varying(200),
  ADD COLUMN IF NOT EXISTS location_label character varying(200) NOT NULL DEFAULT 'Not set',
  ADD COLUMN IF NOT EXISTS ip_address character varying(64) NOT NULL DEFAULT '0.0.0.0',
  ADD COLUMN IF NOT EXISTS recognition_accuracy numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_scans integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS error_rate numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS model character varying(120),
  ADD COLUMN IF NOT EXISTS last_active timestamp with time zone NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS device_type_id integer,
  ADD COLUMN IF NOT EXISTS serial_number character varying(100),
  ADD COLUMN IF NOT EXISTS mac_address character varying(100),
  ADD COLUMN IF NOT EXISTS device_notes text,
  ADD COLUMN IF NOT EXISTS device_config jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_heartbeat timestamp with time zone,
  ADD COLUMN IF NOT EXISTS mt_tenant_id uuid,
  ADD COLUMN IF NOT EXISTS zone_type character varying(20) NOT NULL DEFAULT 'unassigned',
  ADD COLUMN IF NOT EXISTS zone_label character varying(120);

-- name has no natural default (001_init_schema.sql defines it NOT NULL with
-- none) — backfill from external_device_id, the only value guaranteed set on
-- every existing row, then enforce NOT NULL to match the intended schema.
UPDATE public.facility_device
SET name = external_device_id
WHERE name IS NULL;

ALTER TABLE public.facility_device
  ALTER COLUMN name SET NOT NULL;

-- device_type_id -> device_type, per 001_init_schema.sql. NULL on every
-- existing row (column is brand new here), so this cannot violate the FK.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'facility_device_device_type_id_fkey'
  ) THEN
    ALTER TABLE public.facility_device
      ADD CONSTRAINT facility_device_device_type_id_fkey
      FOREIGN KEY (device_type_id) REFERENCES public.device_type(pk_device_type_id);
  END IF;
END $$;

-- zone_type check constraint, per 002_device_zone_type.sql.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'facility_device_zone_type_check'
  ) THEN
    ALTER TABLE public.facility_device
      ADD CONSTRAINT facility_device_zone_type_check
      CHECK (zone_type IN ('work', 'break', 'other', 'unassigned'));
  END IF;
END $$;
