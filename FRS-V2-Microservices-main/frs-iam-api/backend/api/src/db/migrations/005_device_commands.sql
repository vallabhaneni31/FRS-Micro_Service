-- Migration 005: Create device_commands table
CREATE TABLE IF NOT EXISTS public.device_commands (
  id           SERIAL PRIMARY KEY,
  device_code  VARCHAR,
  command_type VARCHAR,
  payload      JSONB,
  status       VARCHAR DEFAULT 'pending',  -- pending / delivered / done / failed
  created_at   TIMESTAMP DEFAULT NOW()
);
