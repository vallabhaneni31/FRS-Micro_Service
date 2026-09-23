/**
 * aiDriftMonitor.js — FIX-037: AI model drift detection
 *
 * Computes weekly recognition accuracy snapshots and compares against the
 * previous snapshot. If accuracy drops by more than DRIFT_THRESHOLD (3%),
 * raises a drift flag and triggers an alert.
 *
 * Drift can indicate:
 *   - Model degradation (distribution shift in employee appearance)
 *   - Camera calibration issues
 *   - Lighting / season changes affecting recognition
 *   - Data poisoning
 */
import { pool }   from '../../db/pool.js';
import logger      from '../../utils/logger.js';

const DRIFT_THRESHOLD = Number(process.env.AI_DRIFT_THRESHOLD  || 0.03);
const WINDOW_DAYS     = Number(process.env.AI_DRIFT_WINDOW_DAYS || 7);

/**
 * Compute drift snapshot for one tenant.
 *
 * @param {string} tenantId
 * @param {number} [threshold] - recognition match threshold
 * @returns {Promise<object|null>}
 */
export async function snapshotDrift(tenantId, threshold = 0.60) {
  // Current window accuracy
  const { rows: current } = await pool.query(
    `SELECT
       COUNT(*)::int                                                         AS total,
       COUNT(*) FILTER (WHERE recognition_accuracy >= $3)::int              AS correct,
       COUNT(*) FILTER (WHERE recognition_accuracy < $3)::int               AS false_negative_count,
       COUNT(*) FILTER (WHERE recognition_accuracy IS NULL)::int            AS no_match_count
     FROM attendance_record
     WHERE tenant_id = $1::uuid
       AND created_at >= NOW() - ($2 || ' days')::interval
       AND recognition_accuracy IS NOT NULL`,
    [tenantId, WINDOW_DAYS, threshold]
  );

  const { total, correct, false_negative_count } = current[0];
  if (total < 20) {
    logger.info({ tenantId, total }, '[driftMonitor] Insufficient data — skipping snapshot');
    return null;
  }

  const accuracy           = total > 0 ? correct / total : null;
  const falseNegativeRate  = total > 0 ? false_negative_count / total : null;

  // Fetch previous snapshot for this tenant
  const { rows: prev } = await pool.query(
    `SELECT accuracy FROM ai_drift_snapshots
     WHERE tenant_id = $1::uuid
     ORDER BY snapshot_date DESC LIMIT 1`,
    [tenantId]
  );

  const previousAccuracy = prev[0]?.accuracy ?? null;
  const delta            = previousAccuracy !== null && accuracy !== null
    ? accuracy - previousAccuracy
    : null;

  const driftFlag = delta !== null && delta < -DRIFT_THRESHOLD;

  const { rows: inserted } = await pool.query(
    `INSERT INTO ai_drift_snapshots (
       tenant_id, threshold_used, window_days,
       total_attempts, total_correct, accuracy,
       previous_accuracy, accuracy_delta, drift_flag, drift_threshold,
       false_negative_rate
     ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      tenantId, threshold, WINDOW_DAYS,
      total, correct, accuracy,
      previousAccuracy, delta, driftFlag, DRIFT_THRESHOLD,
      falseNegativeRate,
    ]
  );

  const snapshot = inserted[0];

  if (driftFlag) {
    logger.warn({
      tenantId,
      accuracy:         accuracy?.toFixed(4),
      previousAccuracy: previousAccuracy?.toFixed(4),
      delta:            delta?.toFixed(4),
    }, '[driftMonitor] ⚠️ MODEL DRIFT DETECTED — accuracy dropped beyond threshold');
  } else {
    logger.info({ tenantId, accuracy, delta }, '[driftMonitor] Snapshot recorded — no drift');
  }

  return snapshot;
}

/**
 * Run drift detection for all active tenants.
 */
export async function runDriftMonitorAllTenants() {
  const { rows: tenants } = await pool.query(
    `SELECT DISTINCT tenant_id FROM attendance_record
     WHERE created_at >= NOW() - '14 days'::interval`
  );

  logger.info({ count: tenants.length }, '[driftMonitor] Running drift snapshots');

  const results = [];
  for (const { tenant_id } of tenants) {
    const snap = await snapshotDrift(tenant_id).catch(err => {
      logger.error({ err, tenant_id }, '[driftMonitor] Snapshot failed');
      return null;
    });
    if (snap) results.push(snap);
  }
  return results;
}

/**
 * Start the weekly drift monitoring cron.
 */
export function startDriftMonitorCron() {
  const INTERVAL_MS = Number(process.env.AI_DRIFT_INTERVAL_MS || 7 * 24 * 3600 * 1000);

  logger.info({ intervalDays: INTERVAL_MS / 86400000 }, '[driftMonitor] Cron started');

  runDriftMonitorAllTenants().catch(err =>
    logger.error({ err }, '[driftMonitor] Initial run failed')
  );

  return setInterval(() => {
    runDriftMonitorAllTenants().catch(err =>
      logger.error({ err }, '[driftMonitor] Interval run failed')
    );
  }, INTERVAL_MS);
}
