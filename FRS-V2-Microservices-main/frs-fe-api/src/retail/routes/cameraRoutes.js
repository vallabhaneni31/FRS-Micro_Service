import express from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticateUser, requireOwner, canAccessStore } from '../middleware/authenticateUser.js';

const router = express.Router();
router.use(authenticateUser);

// GET /stores/:storeId/cameras
router.get('/:storeId/cameras', asyncHandler(async (req, res) => {
  if (!canAccessStore(req, req.params.storeId)) return res.status(404).json({ error: 'store_not_found' });

  const { rows: store } = await pool.query(
    `SELECT id FROM stores WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [req.params.storeId, req.user.tenant_id]
  );
  if (!store.length) return res.status(404).json({ error: 'store_not_found' });

  const { rows } = await pool.query(
    `SELECT id, name, position, stream_url, status, last_seen, created_at, external_id
     FROM cameras WHERE store_id = $1 ORDER BY name`,
    [req.params.storeId]
  );
  return res.json({ cameras: rows });
}));

// POST /stores/:storeId/cameras — register camera (OWNER only)
router.post('/:storeId/cameras', requireOwner, asyncHandler(async (req, res) => {
  const { name, position, stream_url, external_id } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const { rows: store } = await pool.query(
    `SELECT id FROM stores WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [req.params.storeId, req.user.tenant_id]
  );
  if (!store.length) return res.status(404).json({ error: 'store_not_found' });

  const { rows } = await pool.query(
    `INSERT INTO cameras (store_id, name, position, stream_url, external_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.params.storeId, name, position || null, stream_url || null, external_id || null]
  );
  return res.status(201).json({ camera: rows[0] });
}));

// PATCH /cameras/:id/status — update camera status (called by device)
router.patch('/:id/status', asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['online','offline','error'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  const { rows } = await pool.query(
    `UPDATE cameras SET status = $1, last_seen = NOW() WHERE id = $2 RETURNING id, status`,
    [status, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'camera_not_found' });
  return res.json({ camera: rows[0] });
}));

export { router as cameraRoutes };
