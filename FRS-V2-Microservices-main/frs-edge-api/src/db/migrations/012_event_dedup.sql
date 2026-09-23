-- 012_event_dedup.sql
-- Idempotency table for the Kafka device-event consumer.
-- Records each event_uid claimed by deviceEventConsumer.js so that
-- Kafka at-least-once redeliveries (consumer restart, rebalance, broker
-- retry) never re-run the same attendance/visitor logic twice.
-- A periodic cleanup job (or pg_partman) should prune rows older than
-- the Kafka retention window to keep this table bounded in size.

CREATE TABLE IF NOT EXISTS event_dedup (
  event_uid  UUID        PRIMARY KEY,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Allow fast range-delete cleanup of old dedup entries.
CREATE INDEX IF NOT EXISTS idx_event_dedup_claimed_at
  ON event_dedup (claimed_at);
