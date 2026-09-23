import express from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticateUser, requireOwner, canAccessStore } from '../middleware/authenticateUser.js';

const router = express.Router();
router.use(authenticateUser);

// GET /stores — OWNER sees every store in the tenant; MANAGER sees only
// their own assigned store.
router.get('/', asyncHandler(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'tenant_id = $1';
  if (req.user.role !== 'OWNER') {
    params.push(req.user.store_id);
    where += ' AND id = $2';
  }
  const { rows } = await pool.query(
    `SELECT id, name, address, timezone, max_capacity, warning_threshold,
            store_hours, status, created_at
     FROM stores WHERE ${where} ORDER BY name`,
    params
  );
  return res.json({ stores: rows });
}));

// GET /stores/:id — single store
router.get('/:id', asyncHandler(async (req, res) => {
  if (!canAccessStore(req, req.params.id)) return res.status(404).json({ error: 'store_not_found' });

  const { rows } = await pool.query(
    `SELECT id, name, address, timezone, max_capacity, warning_threshold,
            store_hours, status, created_at
     FROM stores WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [req.params.id, req.user.tenant_id]
  );
  if (!rows.length) return res.status(404).json({ error: 'store_not_found' });
  return res.json({ store: rows[0] });
}));

// POST /stores — create store (OWNER only)
router.post('/', requireOwner, asyncHandler(async (req, res) => {
  const { name, address, timezone = 'Asia/Kolkata', max_capacity = 100,
          warning_threshold = 45, store_hours = {} } = req.body;

  if (!name) return res.status(400).json({ error: 'name is required' });

  const { rows } = await pool.query(
    `INSERT INTO stores (tenant_id, name, address, timezone, max_capacity,
                         warning_threshold, store_hours)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [req.user.tenant_id, name, address || null, timezone,
     max_capacity, warning_threshold, JSON.stringify(store_hours)]
  );
  return res.status(201).json({ store: rows[0] });
}));

// PATCH /stores/:id — update store (OWNER only)
router.patch('/:id', requireOwner, asyncHandler(async (req, res) => {
  const allowed = ['name','address','timezone','max_capacity',
                   'warning_threshold','store_hours','status'];
  const updates = [];
  const values = [];
  let i = 1;

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key} = $${i++}`);
      values.push(key === 'store_hours' ? JSON.stringify(req.body[key]) : req.body[key]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'no_fields_to_update' });

  values.push(req.params.id, req.user.tenant_id);
  const { rows } = await pool.query(
    `UPDATE stores SET ${updates.join(', ')}, updated_at = NOW()
     WHERE id = $${i++} AND tenant_id = $${i} RETURNING *`,
    values
  );
  if (!rows.length) return res.status(404).json({ error: 'store_not_found' });
  return res.json({ store: rows[0] });
}));

export { router as storeRoutes };
