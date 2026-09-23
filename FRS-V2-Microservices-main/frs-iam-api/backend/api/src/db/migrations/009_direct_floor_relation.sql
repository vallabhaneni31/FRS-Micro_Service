-- 009_direct_floor_relation.sql
-- Add fk_site_id directly to frs_floor table to support floor management at the site level (without building constraints)
ALTER TABLE public.frs_floor ADD COLUMN IF NOT EXISTS fk_site_id bigint REFERENCES public.frs_site(pk_site_id) ON DELETE CASCADE;

-- Add fk_floor_id directly to facility_device table to support locating AI nodes and mirrored cameras under a floor
ALTER TABLE public.facility_device ADD COLUMN IF NOT EXISTS fk_floor_id integer REFERENCES public.frs_floor(pk_floor_id) ON DELETE SET NULL;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_frs_floor_site ON public.frs_floor(fk_site_id);
CREATE INDEX IF NOT EXISTS idx_facility_device_floor ON public.facility_device(fk_floor_id);
