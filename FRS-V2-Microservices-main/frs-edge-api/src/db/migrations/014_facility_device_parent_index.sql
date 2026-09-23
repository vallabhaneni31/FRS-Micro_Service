-- 014_facility_device_parent_index.sql
-- FRS-ARCH-002 Phase 4 (D6): facility_device.parent_device_id is read on every
-- device-auth check, the 30s device-offline cron, and face-sync/device-management
-- lookups, with no supporting index.

CREATE INDEX IF NOT EXISTS idx_facility_device_parent_device_id
ON facility_device (parent_device_id)
WHERE parent_device_id IS NOT NULL;
