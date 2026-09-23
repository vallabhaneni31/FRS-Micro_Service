ALTER TABLE hr_employee ADD COLUMN IF NOT EXISTS fk_manager_id BIGINT REFERENCES hr_employee(pk_employee_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_hr_employee_manager ON hr_employee(fk_manager_id);
