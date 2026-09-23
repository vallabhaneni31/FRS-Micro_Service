-- 015_device_events_payload_employee_index.sql
-- HR dashboard performance incident: /live/attendance's "today" query runs 4
-- correlated subqueries per employee row against device_events (497K rows,
-- 1.3GB), filtered on COALESCE(payload_json->>'employee_id',
-- payload_json->>'employeeId') with no supporting index. Measured live
-- (39-employee tenant): 14,980ms per dashboard load before this index,
-- 23ms after (~645x). device_events.fk_person_id exists but is never
-- populated for EMPLOYEE_ENTRY/EMPLOYEE_EXIT rows, so the JSONB path is the
-- only real linkage today — indexing it directly, not routing around it.
--
-- CONCURRENTLY: do not wrap this migration in a transaction when applying to
-- a live table (non-blocking build; must run outside BEGIN/COMMIT).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_events_payload_employee
ON device_events (
  tenant_id,
  event_type,
  (COALESCE(payload_json->>'employee_id', payload_json->>'employeeId')),
  occurred_at DESC
);
