// Trimmed from backend/api-retail/src/routes/deviceRoutes.js: this repo is
// the user/admin-facing half of the retail vertical, so only the
// authenticateUser-guarded routes are kept. The device-facing routes below
// (both authenticateDevice) were dropped — they live in frs-edge-api:
//   POST /:id/heartbeat — device telemetry ping
//   POST /:id/health    — alias for heartbeat
import express from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticateUser, requireOwner, canAccessStore } from '../middleware/authenticateUser.js';
import { generateDeviceSecret, issueDeviceToken } from '../services/jwtService.js';

const router = express.Router();

// POST /devices/register — register new edge device, returns device JWT (OWNER only)
router.post('/register', authenticateUser, requireOwner, asyncHandler(async (req, res) => {
  const { store_id, external_id } = req.body;
  if (!store_id || !external_id) {
    return res.status(400).json({ error: 'store_id and external_id are required' });
  }

  // Verify store belongs to tenant
  const { rows: storeRows } = await pool.query(
    `SELECT id FROM stores WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [store_id, req.user.tenant_id]
  );
  if (!storeRows.length) return res.status(404).json({ error: 'store_not_found' });

  const secret = generateDeviceSecret();

  const { rows } = await pool.query(
    `INSERT INTO edge_devices (store_id, external_id, device_secret)
     VALUES ($1,$2,$3)
     ON CONFLICT (external_id) DO UPDATE
       SET store_id = EXCLUDED.store_id, device_secret = EXCLUDED.device_secret
     RETURNING id, store_id, external_id, status, created_at`,
    [store_id, external_id, secret]
  );

  const device = rows[0];
  const token = issueDeviceToken(device.id, secret);

  return res.status(201).json({ device, token });
}));

// GET /devices — list devices for store (authenticated user)
router.get('/', authenticateUser, asyncHandler(async (req, res) => {
  const storeId = req.query.store_id || req.user.store_id;
  if (!storeId) return res.status(400).json({ error: 'store_id required' });
  if (!canAccessStore(req, storeId)) return res.status(404).json({ error: 'store_not_found' });

  const { rows } = await pool.query(
    `SELECT ed.id, ed.external_id, ed.status, ed.last_heartbeat, ed.created_at
     FROM edge_devices ed
     JOIN stores s ON s.id = ed.store_id
     WHERE ed.store_id = $1 AND s.tenant_id = $2
     ORDER BY ed.external_id`,
    [storeId, req.user.tenant_id]
  );
  return res.json({ devices: rows });
}));

export { router as deviceRoutes };
