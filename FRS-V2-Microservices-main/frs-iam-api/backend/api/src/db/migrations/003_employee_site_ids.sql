-- 003_employee_site_ids.sql
-- Site-based scoping lets an employee belong to multiple sites. The scope filter
-- (scopeSql.js, useArrayForSite) and EmployeeService read/write an array column
-- `site_ids`, while `site_id` is kept in sync as the primary (first) site.
-- Backfills site_ids from the existing scalar site_id. Idempotent — safe to re-run.

ALTER TABLE public.hr_employee
  ADD COLUMN IF NOT EXISTS site_ids bigint[];

-- Backfill: seed the array from the existing single site_id for rows not yet set.
UPDATE public.hr_employee
   SET site_ids = ARRAY[site_id]
 WHERE site_ids IS NULL
   AND site_id IS NOT NULL;

-- Speeds up the `$N = ANY(site_ids)` scope predicate.
CREATE INDEX IF NOT EXISTS hr_employee_site_ids_gin
  ON public.hr_employee USING gin (site_ids);
