import express from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticateDevice } from '../middleware/authenticateDevice.js';
import { resolveCameraId } from '../services/cameraResolver.js';

const router = express.Router();
router.use(authenticateDevice);

// POST /devices/:id/count — ingest people count event
router.post('/:id/count', asyncHandler(async (req, res) => {
  if (req.params.id !== req.device.id) {
    return res.status(403).json({ error: 'device_id_mismatch' });
  }

  const { direction, count = 1, camera_id, occurred_at } = req.body;
  if (!['in','out'].includes(direction)) {
    return res.status(400).json({ error: 'direction must be "in" or "out"' });
  }
  if (count < 1) return res.status(400).json({ error: 'count must be >= 1' });

  const resolvedCameraId = await resolveCameraId(camera_id, req.device.store_id);

  await pool.query(
    `INSERT INTO people_count_events (device_id, camera_id, store_id, direction, count, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [req.device.id, resolvedCameraId, req.device.store_id,
     direction, count, occurred_at ? new Date(occurred_at) : new Date()]
  );

  // Update occupancy snapshot in-place
  const { rows } = await pool.query(
    `SELECT current_count FROM occupancy_snapshots
     WHERE store_id = $1 ORDER BY snapshot_at DESC LIMIT 1`,
    [req.device.store_id]
  );

  const prev = rows[0]?.current_count ?? 0;
  const { rows: storeRows } = await pool.query(
    `SELECT max_capacity FROM stores WHERE id = $1 LIMIT 1`,
    [req.device.store_id]
  );
  const maxCap = storeRows[0]?.max_capacity ?? 100;
  const next = Math.max(0, direction === 'in' ? prev + count : prev - count);

  await pool.query(
    `INSERT INTO occupancy_snapshots (store_id, current_count, max_capacity, camera_id)
     VALUES ($1,$2,$3,$4)`,
    [req.device.store_id, next, maxCap, resolvedCameraId]
  );

  return res.json({ success: true, current_count: next });
}));

// POST /devices/:id/occupancy — device sends absolute current count
router.post('/:id/occupancy', asyncHandler(async (req, res) => {
  if (req.params.id !== req.device.id) {
    return res.status(403).json({ error: 'device_id_mismatch' });
  }

  const { current_count, camera_id } = req.body;
  if (current_count === undefined || current_count < 0) {
    return res.status(400).json({ error: 'current_count required and must be >= 0' });
  }

  const { rows: storeRows } = await pool.query(
    `SELECT max_capacity FROM stores WHERE id = $1 LIMIT 1`,
    [req.device.store_id]
  );
  const maxCap = storeRows[0]?.max_capacity ?? 100;
  const resolvedCameraId = await resolveCameraId(camera_id, req.device.store_id);

  await pool.query(
    `INSERT INTO occupancy_snapshots (store_id, current_count, max_capacity, camera_id)
     VALUES ($1,$2,$3,$4)`,
    [req.device.store_id, current_count, maxCap, resolvedCameraId]
  );

  return res.json({ success: true, current_count });
}));

export { router as countRoutes };
