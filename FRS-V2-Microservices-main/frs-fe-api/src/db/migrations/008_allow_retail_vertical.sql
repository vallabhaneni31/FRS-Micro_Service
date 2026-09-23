-- Migration 008: Allow 'retail' vertical in tenants table
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_vertical_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_vertical_check CHECK (vertical IN ('corporate', 'education', 'retail'));
