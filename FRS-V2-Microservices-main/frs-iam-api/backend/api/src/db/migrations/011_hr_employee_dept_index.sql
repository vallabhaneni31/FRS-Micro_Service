-- 011_hr_employee_dept_index.sql
-- Speeds up per-department employee counts (GET /api/hr/departments) —
-- hr_employee previously had no index covering tenant_id/fk_department_id/
-- status, so each department's COUNT(*) was a sequential scan of the
-- tenant's whole employee table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hr_employee_tenant_dept_status
  ON public.hr_employee (tenant_id, fk_department_id, status);
