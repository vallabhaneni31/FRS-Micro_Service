/**
 * enrollmentReminderCron.js — Nudge employees with an unfinished enrollment
 *
 * For each tenant with the "Send enrollment reminders" toggle on (HR sets
 * this, along with the send hour, on the Remote Enrollment page — stored in
 * tenant_settings.custom_settings.enrollment_reminders_enabled /
 * enrollment_reminder_hour), find every invitation still sitting in
 * pending/opened/in_progress (sent, not expired, not completed) and send a
 * reminder once per employee-local calendar day — timed to their site's
 * timezone, targeting the tenant's configured hour (default 9 AM), not
 * server time.
 *
 * Runs every REMINDER_CRON_INTERVAL_MINUTES (default 15). A 15-minute-or-finer
 * interval, combined with the local-date dedup below, means each employee
 * gets exactly one reminder in the first tick where their site-local clock
 * reads the configured hour, regardless of how the interval aligns to it.
 */
import logger from '../utils/logger.js';
import { sendEnrollmentReminder } from '../services/emailService.js';
import * as repo from '../repositories/enrollmentRepository.js';

const INTERVAL_MINUTES = Number(process.env.REMINDER_CRON_INTERVAL_MINUTES || 15);
const DEFAULT_TIMEZONE = 'UTC'; // used when a site has no timezone set

function localHour(date, timezone) {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false }).format(date)
  );
}

function localDateKey(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date); // YYYY-MM-DD
}

export async function runEnrollmentReminderCheck() {
  const now = new Date();
  let sent = 0, skipped = 0, errors = 0;

  let tenants;
  try {
    tenants = await repo.listReminderEnabledTenants();
  } catch (err) {
    logger.error({ err }, '[enrollmentReminderCron] Failed to load reminder-enabled tenants');
    return { sent, skipped, errors: errors + 1 };
  }

  for (const { tenantId, hour: reminderHour } of tenants) {
    let candidates;
    try {
      candidates = await repo.getPendingReminderCandidates(tenantId);
    } catch (err) {
      logger.error({ err, tenantId }, '[enrollmentReminderCron] Failed to load candidates for tenant');
      errors++;
      continue;
    }

    for (const inv of candidates) {
      try {
        const timezone = inv.timezone || DEFAULT_TIMEZONE;
        if (localHour(now, timezone) !== reminderHour) {
          continue;
        }

        const today = localDateKey(now, timezone);
        const lastSentDay = inv.last_reminder_sent_at ? localDateKey(new Date(inv.last_reminder_sent_at), timezone) : null;
        if (lastSentDay === today) {
          skipped++;
          continue;
        }

        const enrollmentLink = `${process.env.ENROLLMENT_PORTAL_URL}/${inv.invitation_token}`;
        await sendEnrollmentReminder({
          employeeName: inv.full_name,
          employeeEmail: inv.email,
          enrollmentLink,
          expiresAt: inv.expires_at,
        });
        await repo.markReminderSent(inv.pk_invitation_id);
        sent++;
      } catch (err) {
        logger.error({ err, invitationId: inv.pk_invitation_id }, '[enrollmentReminderCron] Failed to send reminder');
        errors++;
      }
    }
  }

  if (sent || errors) {
    logger.info({ sent, skipped, errors }, '[enrollmentReminderCron] Cycle complete');
  }
  return { sent, skipped, errors };
}

export function startEnrollmentReminderCron() {
  logger.info({ intervalMinutes: INTERVAL_MINUTES }, '[enrollmentReminderCron] Starting enrollment reminder cron');

  runEnrollmentReminderCheck().catch(err =>
    logger.error({ err }, '[enrollmentReminderCron] Initial run failed')
  );

  return setInterval(() => {
    runEnrollmentReminderCheck().catch(err =>
      logger.error({ err }, '[enrollmentReminderCron] Interval run failed')
    );
  }, INTERVAL_MINUTES * 60 * 1000);
}
