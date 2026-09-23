/**
 * deviceOfflineCron.js — Mark devices offline when heartbeat goes stale
 * Run as a periodic interval inside server.js (no external cron needed).
 * Jetson pushes heartbeats; if we stop seeing them the device is offline.
 */
import { pool } from '../db/pool.js';
import logger from '../utils/logger.js';

const OFFLINE_THRESHOLD_MINUTES = parseInt(process.env.DEVICE_OFFLINE_THRESHOLD_MIN || '5', 10);

let wsManagerRef = null;

export function setWsManager(wsManager) {
  wsManagerRef = wsManager;
}

export async function runDeviceOfflineCheck() {
  // ── 1. facility_device table (used by overview dashboards) ───────────────
  try {
    const { rows: flipped } = await pool.query(
      `UPDATE facility_device
       SET status = 'offline'
       WHERE status = 'online'
         AND last_heartbeat < NOW() - ($1 || ' minutes')::interval
         AND decommissioned_at IS NULL
       RETURNING pk_device_id, external_device_id, tenant_id`,
      [OFFLINE_THRESHOLD_MINUTES]
    );

    if (flipped.length > 0) {
      logger.info({ count: flipped.length }, '[deviceOfflineCron] Marked device(s) offline in facility_device');

      // Broadcast via Socket.IO grouped by tenant
      if (wsManagerRef) {
        const byTenant = {};
        for (const d of flipped) {
          const tid = String(d.tenant_id);
          (byTenant[tid] = byTenant[tid] || []).push(d);
        }
        for (const [tenantId, devices] of Object.entries(byTenant)) {
          for (const dev of devices) {
            try {
              wsManagerRef.broadcastToTenant(tenantId, 'deviceStatusUpdate', {
                device_code: dev.external_device_id,
                status: 'offline',
                last_heartbeat: null,
              });
            } catch (_) {}
          }
        }
      }

      // Insert status-history records if that table exists
      for (const dev of flipped) {
        await pool.query(
          `INSERT INTO device_status_history (device_id, old_status, new_status, transition_reason, changed_at)
           VALUES ($1, 'online', 'offline', 'heartbeat_timeout', NOW())`,
          [dev.pk_device_id]
        ).catch(() => {});

        // Cascade: also mark all active child cameras of this offline parent device as offline
        await pool.query(
          `UPDATE facility_device
           SET status = 'offline',
               last_active = NOW()
           WHERE parent_device_id = $1 AND status = 'online'`,
          [dev.pk_device_id]
        ).catch(() => {});
      }
    }
  } catch (err) {
    logger.error({ err }, '[deviceOfflineCron] Error running facility_device offline check');
  }

  // ── 2. frs_nug_box table (used by /devices/edge-devices API) ─────────────
  // Critical: without this, the Edge AI Command Center page shows stale status
  // or shows blank when the status check inside the component causes confusion.
  try {
    const { rows: nugFlipped } = await pool.query(
      `UPDATE frs_nug_box
       SET status = 'offline'
       WHERE status = 'online'
         AND last_heartbeat < NOW() - ($1 || ' minutes')::interval
       RETURNING pk_nug_id, device_code`,
      [OFFLINE_THRESHOLD_MINUTES]
    );

    if (nugFlipped.length > 0) {
      logger.info({ count: nugFlipped.length }, '[deviceOfflineCron] Marked NUG box(es) offline in frs_nug_box');

      // Cascade: also mark all cameras attached to offline boxes as offline
      for (const nug of nugFlipped) {
        await pool.query(
          `UPDATE frs_camera SET status = 'offline' WHERE fk_nug_id = $1 AND status = 'online'`,
          [nug.pk_nug_id]
        ).catch(() => {});
      }
    }
  } catch (err) {
    logger.error({ err }, '[deviceOfflineCron] Error syncing frs_nug_box offline status');
  }
}

/**
 * Start the cron. Returns the interval handle so caller can clear it.
 * @param {object} wsManager - wsManager instance (optional, for broadcasting)
 * @param {number} intervalMs - how often to run (default 60s)
 */
export function startDeviceOfflineCron(wsManager, intervalMs = 60_000) {
  if (wsManager) setWsManager(wsManager);
  // Run immediately on start
  runDeviceOfflineCheck();
  return setInterval(runDeviceOfflineCheck, intervalMs);
}
