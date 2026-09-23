-- Tracks the last time an unfinished-enrollment reminder email was sent for
-- an invitation, so the reminder cron sends at most one per local day.
ALTER TABLE enrollment_invitations ADD COLUMN IF NOT EXISTS last_reminder_sent_at TIMESTAMPTZ;
