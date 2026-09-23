/**
 * bootstrapRoutes.js — Public device token bootstrap (no auth required)
 *
 * A Jetson that has no token yet cannot reach any authenticated endpoint.
 * This route lets it claim the token that was placed in device_command_queue
 * by the /provision admin action — one-time use, rate-limited.
 *
 * GET /api/bootstrap/:deviceCode
 *   → 200 { token, expires_at, server_url, heartbeat_interval_seconds }
 *   → 404 { error: 'no_pending_token' }   – device not provisioned yet
 *   → 429                                  – rate limit hit
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { pool } from '../db/pool.js';
import logger from '../utils/logger.js';

const router = express.Router();

// 10 attempts per 15 min per IP — enough for retries, not enough for enumeration
const bootstrapLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many bootstrap requests. Try again in 15 minutes.' },
});

router.use(bootstrapLimiter);

// ── GET /api/bootstrap/:deviceCode ──────────────────────────────────────────
router.get('/:deviceCode', asyncHandler(async (req, res) => {
  const { deviceCode } = req.params;

  if (!deviceCode || !/^[a-zA-Z0-9_-]{1,80}$/.test(deviceCode)) {
    return res.status(400).json({ error: 'invalid_device_code' });
  }

  // Resolve the internal device id
  const { rows: deviceRows } = await pool.query(
    `SELECT pk_device_id, tenant_id, name
     FROM facility_device
     WHERE external_device_id = $1
       AND decommissioned_at IS NULL
     LIMIT 1`,
    [deviceCode]
  );

  if (!deviceRows.length) {
    return res.status(404).json({ error: 'device_not_found' });
  }

  const device = deviceRows[0];

  // Claim the oldest un-expired update_token command (one-time use)
  const { rows: cmdRows } = await pool.query(
    `UPDATE device_command_queue
     SET status = 'executed', executed_at = NOW()
     WHERE pk_command_id = (
       SELECT pk_command_id
       FROM device_command_queue
       WHERE device_id = $1
         AND command_type = 'update_token'
         AND status = 'pending'
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at DESC
       LIMIT 1
     )
     RETURNING command_payload`,
    [device.pk_device_id]
  );

  if (!cmdRows.length) {
    logger.warn({ deviceCode }, '[bootstrap] No pending token for device');
    return res.status(404).json({
      error: 'no_pending_token',
      hint: 'Ask your administrator to run the provision action for this device.',
    });
  }

  const { token, expires_at } = cmdRows[0].command_payload;

  logger.info({ deviceCode, deviceName: device.name }, '[bootstrap] Token claimed by device');

  return res.json({
    token,
    expires_at,
    heartbeat_interval_seconds: 15,
    server_url: process.env.BACKEND_URL || process.env.PUBLIC_BASE_URL || process.env.APP_URL || `${req.protocol}://${req.get('host')}`,
  });
}));

export default router;
