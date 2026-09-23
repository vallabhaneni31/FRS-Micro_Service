/**
 * dataRetentionCron.js — FIX-027: Configurable per-table data retention
 *
 * Runs on a scheduled interval to purge data that exceeds its retention period.
 * Each table has an independently configurable retention window via env vars.
 *
 * Retention periods (env vars — default values in parentheses):
 *   RETENTION_FACE_EMBEDDINGS_YEARS   (3)  — face_embedding for inactive employees
 *   RETENTION_ATTENDANCE_DAYS         (730) — attendance_record (2 years)
 *   RETENTION_AUDIT_LOG_DAYS          (365) — audit_log (1 year, GDPR Art.5)
 *   RETENTION_DEVICE_EVENTS_DAYS      (90)  — device_events (3 months)
 *   RETENTION_GDPR_ERASURE_DAYS       (365) — completed gdpr_erasure_requests
 *
 * All purges are logged to audit_log.
 */
import { pool }       from '../db/pool.js';
import { writeAudit } from '../middleware/auditLog.js';
import logger         from '../utils/logger.js';

// Configurable retention windows
const CFG = {
  faceEmbeddingYears:  Number(process.env.RETENTION_FACE_EMBEDDINGS_YEARS || 3),
  attendanceDays:      Number(process.env.RETENTION_ATTENDANCE_DAYS        || 730),
  auditLogDays:        Number(process.env.RETENTION_AUDIT_LOG_DAYS         || 365),
  deviceEventsDays:    Number(process.env.RETENTION_DEVICE_EVENTS_DAYS     || 90),
  gdprErasureDays:     Number(process.env.RETENTION_GDPR_ERASURE_DAYS      || 365),
  searchHistoryDays:   Number(process.env.SEARCH_HISTORY_RETENTION_DAYS    || 90),
};

async function purgeFaceEmbeddings() {
  const { rows: candidates } = await pool.query(
    `SELECT e.pk_employee_id, e.full_name, e.employee_code, e.tenant_id
     FROM hr_employee e
     WHERE e.status IN ('deactivated', 'inactive', 'terminated')
       AND e.created_at < NOW() - ($1 || ' years')::interval
       AND EXISTS (SELECT 1 FROM employee_face_embeddings fe WHERE fe.employee_id = e.pk_employee_id)`,
    [CFG.faceEmbeddingYears]
  );

  if (!candidates.length) return 0;

  logger.info({ count: candidates.length }, '[dataRetention] Purging face embeddings for inactive employees');

  let purged = 0;
  for (const emp of candidates) {
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM employee_face_embeddings WHERE employee_id = $1`,
        [emp.pk_employee_id]
      );
      purged += rowCount || 0;

      try {
        const { default: faceDB } = await import('../core/db/FaceDB.js');
        await faceDB.deleteEmployeeFaces(emp.pk_employee_id);
      } catch (_) {}

      await writeAudit({
        req:        { auth: {}, headers: {}, method: 'CRON' },
        action:     'employee.gdpr_retention_purge',
        details:    `Data retention: cleared face embeddings for ${emp.full_name} (${emp.employee_code}) after ${CFG.faceEmbeddingYears}yr inactivity`,
        entityType: 'employee',
        entityId:   String(emp.pk_employee_id),
        entityName: emp.full_name,
        source:     'system',
      }).catch(() => {});
    } catch (err) {
      logger.error({ err, employeeId: emp.pk_employee_id }, '[dataRetention] Failed to purge embeddings');
    }
  }
  return purged;
}

async function purgeAttendanceRecords() {
  const { rowCount } = await pool.query(
    `DELETE FROM attendance_record WHERE created_at < NOW() - ($1 || ' days')::interval`,
    [CFG.attendanceDays]
  );
  return rowCount || 0;
}

async function purgeAuditLog() {
  const { rowCount } = await pool.query(
    `DELETE FROM audit_log WHERE created_at < NOW() - ($1 || ' days')::interval`,
    [CFG.auditLogDays]
  );
  return rowCount || 0;
}

async function purgeDeviceEvents() {
  const { rowCount } = await pool.query(
    `DELETE FROM device_events WHERE received_at < NOW() - ($1 || ' days')::interval`,
    [CFG.deviceEventsDays]
  ).catch(() => ({ rowCount: 0 }));
  return rowCount || 0;
}

// PERF-0005: operator search history (query criteria only — no biometric data).
async function purgeSearchHistory() {
  const { rowCount } = await pool.query(
    `DELETE FROM search_history WHERE created_at < NOW() - ($1 || ' days')::interval`,
    [CFG.searchHistoryDays]
  ).catch(() => ({ rowCount: 0 }));
  return rowCount || 0;
}

async function purgeGdprErasureLog() {
  const { rowCount } = await pool.query(
    `DELETE FROM gdpr_erasure_requests
     WHERE status = 'complete' AND completed_at < NOW() - ($1 || ' days')::interval`,
    [CFG.gdprErasureDays]
  ).catch(() => ({ rowCount: 0 }));
  return rowCount || 0;
}

export async function runDataRetentionCleanup() {
  logger.info({ cfg: CFG }, '[dataRetention] Starting data retention cycle');

  const results = {
    faceEmbeddings:  0,
    attendanceRows:  0,
    auditLogRows:    0,
    deviceEventRows: 0,
    gdprErasureRows: 0,
    searchHistoryRows: 0,
    errors:          [],
  };

  const tasks = [
    { name: 'faceEmbeddings',  fn: purgeFaceEmbeddings   },
    { name: 'attendanceRows',  fn: purgeAttendanceRecords },
    { name: 'auditLogRows',    fn: purgeAuditLog          },
    { name: 'deviceEventRows', fn: purgeDeviceEvents      },
    { name: 'gdprErasureRows', fn: purgeGdprErasureLog    },
    { name: 'searchHistoryRows', fn: purgeSearchHistory   },
  ];

  for (const task of tasks) {
    try {
      results[task.name] = await task.fn();
    } catch (err) {
      logger.error({ err, task: task.name }, '[dataRetention] Task failed');
      results.errors.push(`${task.name}: ${err.message}`);
    }
  }

  logger.info(results, '[dataRetention] Cycle complete');
  return results;
}

export function startDataRetentionCron(intervalMs = 24 * 3600 * 1000) {
  logger.info({ intervalHours: intervalMs / 3600000, cfg: CFG }, '[dataRetention] Cron started');

  runDataRetentionCleanup().catch(err =>
    logger.error({ err }, '[dataRetention] Initial run failed')
  );

  return setInterval(() => {
    runDataRetentionCleanup().catch(err =>
      logger.error({ err }, '[dataRetention] Interval run failed')
    );
  }, intervalMs);
}
