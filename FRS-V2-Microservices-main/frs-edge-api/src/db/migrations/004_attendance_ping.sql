-- 003_attendance_ping.sql
-- Per-recognition presence log. attendance_record only keeps first-in/last-out
-- per day, which is too coarse to reconstruct where someone spent their time.
-- Every face recognition writes one ping here (device + real event time), which
-- powers dwell-time (time per location) and the device-activity heatmap.
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.attendance_ping (
  pk_ping_id     bigserial PRIMARY KEY,
  tenant_id      uuid        NOT NULL,
  fk_employee_id bigint,                 -- corporate vertical
  fk_student_id  bigint,                 -- education vertical
  device_code    text,
  direction      varchar(10),            -- 'entry' | 'exit' | '' (mixed)
  confidence     numeric,
  occurred_at    timestamptz NOT NULL DEFAULT now(),  -- real event time
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Dwell query: one subject's pings for a day, ordered by time.
CREATE INDEX IF NOT EXISTS idx_attendance_ping_emp_time
  ON public.attendance_ping (tenant_id, fk_employee_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_attendance_ping_stu_time
  ON public.attendance_ping (tenant_id, fk_student_id, occurred_at);
-- Heatmap query: all pings for a tenant over a date window, by device.
CREATE INDEX IF NOT EXISTS idx_attendance_ping_device_time
  ON public.attendance_ping (tenant_id, device_code, occurred_at);
