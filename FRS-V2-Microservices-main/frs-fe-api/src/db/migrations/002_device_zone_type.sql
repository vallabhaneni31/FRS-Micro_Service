-- 002_device_zone_type.sql
-- Tag each device with the physical location/zone it monitors, so attendance
-- events can be rolled up into dwell-time per location (e.g. workplace vs
-- cafeteria vs other workstation). Idempotent — safe to re-run.

ALTER TABLE public.facility_device
  ADD COLUMN IF NOT EXISTS zone_type  character varying(20) NOT NULL DEFAULT 'unassigned',
  ADD COLUMN IF NOT EXISTS zone_label character varying(120);

-- zone_type buckets dwell time: 'work' counts as productive, 'break' as away,
-- 'other' as neutral, 'unassigned' = not yet tagged by an admin.
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
