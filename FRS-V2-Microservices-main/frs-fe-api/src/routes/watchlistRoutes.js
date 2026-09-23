import express from 'express';
import { pool } from '../db/pool.js';
import { requireAuth, requirePermission } from '../middleware/authz.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { writeAudit } from '../middleware/auditLog.js';
import { validateBody } from '../validators/schemas.js';
import { createWatchlistSchema, addWatchlistPersonSchema } from '../validators/watchlistSchemas.js';

const router = express.Router();
router.use(requireAuth);

function tid(req) { return req.auth?.scope?.tenantId ?? req.headers['x-tenant-id'] ?? null; }
function uid(req) { return req.auth?.user?.id ?? null; }

/* ── GET /api/watchlists ── list watchlists */
router.get('/', requirePermission('watchlist.read'), asyncHandler(async (req, res) => {
  const tenantId = tid(req);
  const { active, category, page = '1', limit = '50' } = req.query;
  const lim = Math.min(Number(limit) || 50, 100);
  const off = (Math.max(Number(page), 1) - 1) * lim;

  let where = ['w.tenant_id = $1::uuid'];
  const params = [tenantId];
  const p = () => `$${params.length}`;

  if (active !== undefined) { params.push(active === 'true'); where.push(`w.is_active = ${p()}`); }
  if (category)             { params.push(category);          where.push(`w.category = ${p()}`); }

  params.push(lim, off);
  const { rows } = await pool.query(
    `SELECT w.*,
       u.username AS created_by_name,
       COUNT(wp.pk_person_id) FILTER (WHERE wp.is_active) AS person_count
     FROM frs_watchlist w
     LEFT JOIN frs_user u ON u.pk_user_id = w.created_by
     LEFT JOIN frs_watchlist_person wp ON wp.fk_watchlist_id = w.pk_watchlist_id
     WHERE ${where.join(' AND ')}
     GROUP BY w.pk_watchlist_id, u.username
     ORDER BY
       CASE w.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
       w.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return res.json({ watchlists: rows, page: Number(page), limit: lim });
}));

/* ── GET /api/watchlists/stats ── */
router.get('/stats', requirePermission('watchlist.read'), asyncHandler(async (req, res) => {
  const tenantId = tid(req);
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE is_active)   AS active_lists,
       COUNT(*) FILTER (WHERE NOT is_active) AS inactive_lists,
       COUNT(*) FILTER (WHERE priority='critical' AND is_active) AS critical_lists,
       COUNT(*) AS total_lists
     FROM frs_watchlist WHERE tenant_id = $1::uuid`,
    [tenantId]
  );
  const { rows: persons } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE wp.is_active) AS active_persons
     FROM frs_watchlist_person wp
     JOIN frs_watchlist w ON w.pk_watchlist_id = wp.fk_watchlist_id
     WHERE w.tenant_id = $1::uuid`,
    [tenantId]
  );
  return res.json({ ...rows[0], ...persons[0] });
}));

/* ── GET /api/watchlists/:id ── single watchlist with persons */
router.get('/:id', requirePermission('watchlist.read'), asyncHandler(async (req, res) => {
  const tenantId = tid(req);
  const { rows: wl } = await pool.query(
    `SELECT w.*, u.username AS created_by_name
     FROM frs_watchlist w
     LEFT JOIN frs_user u ON u.pk_user_id = w.created_by
     WHERE w.pk_watchlist_id = $1 AND w.tenant_id = $2::uuid`,
    [req.params.id, tenantId]
  );
  if (!wl.length) return res.status(404).json({ message: 'Watchlist not found' });

  const { rows: persons } = await pool.query(
    `SELECT wp.*, u.username AS added_by_name
     FROM frs_watchlist_person wp
     LEFT JOIN frs_user u ON u.pk_user_id = wp.added_by
     WHERE wp.fk_watchlist_id = $1
     ORDER BY wp.added_at DESC`,
    [req.params.id]
  );
  return res.json({ ...wl[0], persons });
}));

/* ── POST /api/watchlists ── create watchlist */
router.post('/', requirePermission('watchlist.write'), validateBody(createWatchlistSchema), asyncHandler(async (req, res) => {
  const tenantId = tid(req);
  const userId   = uid(req);
  const { name, description, category, priority, alertOnMatch, notifyEmails, metadata } = req.validatedBody;

  const { rows } = await pool.query(
    `INSERT INTO frs_watchlist
       (tenant_id, name, description, category, priority, alert_on_match, notify_emails, metadata, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [tenantId, name.trim(), description || null, category, priority, alertOnMatch, notifyEmails, JSON.stringify(metadata), userId]
  );
  await writeAudit({ req, action: 'watchlist.created', entityType: 'watchlist', entityId: String(rows[0].pk_watchlist_id) });
  return res.status(201).json(rows[0]);
}));

/* ── PATCH /api/watchlists/:id ── update watchlist */
router.patch('/:id', requirePermission('watchlist.write'), asyncHandler(async (req, res) => {
  const tenantId = tid(req);
  const { name, description, category, priority, isActive, alertOnMatch, notifyEmails } = req.body;
  const sets = [];
  const params = [req.params.id, tenantId];
  const p = () => `$${params.length}`;

  if (name !== undefined)         { params.push(name);          sets.push(`name = ${p()}`); }
  if (description !== undefined)  { params.push(description);   sets.push(`description = ${p()}`); }
  if (category !== undefined)     { params.push(category);      sets.push(`category = ${p()}`); }
  if (priority !== undefined)     { params.push(priority);      sets.push(`priority = ${p()}`); }
  if (isActive !== undefined)     { params.push(isActive);      sets.push(`is_active = ${p()}`); }
  if (alertOnMatch !== undefined) { params.push(alertOnMatch);  sets.push(`alert_on_match = ${p()}`); }
  if (notifyEmails !== undefined) { params.push(notifyEmails);  sets.push(`notify_emails = ${p()}`); }
  if (!sets.length) return res.status(400).json({ message: 'No fields to update' });

  sets.push('updated_at = NOW()');
  const { rows } = await pool.query(
    `UPDATE frs_watchlist SET ${sets.join(', ')}
     WHERE pk_watchlist_id=$1 AND tenant_id=$2::uuid RETURNING *`,
    params
  );
  if (!rows.length) return res.status(404).json({ message: 'Watchlist not found' });
  return res.json(rows[0]);
}));

/* ── DELETE /api/watchlists/:id ── */
router.delete('/:id', requirePermission('watchlist.write'), asyncHandler(async (req, res) => {
  const tenantId = tid(req);
  const { rowCount } = await pool.query(
    `DELETE FROM frs_watchlist WHERE pk_watchlist_id=$1 AND tenant_id=$2::uuid`,
    [req.params.id, tenantId]
  );
  if (!rowCount) return res.status(404).json({ message: 'Watchlist not found' });
  await writeAudit({ req, action: 'watchlist.deleted', entityType: 'watchlist', entityId: req.params.id });
  return res.json({ success: true });
}));

/* ── POST /api/watchlists/:id/persons ── add person */
router.post('/:id/persons', requirePermission('watchlist.write'), validateBody(addWatchlistPersonSchema), asyncHandler(async (req, res) => {
  const tenantId = tid(req);
  const userId   = uid(req);
  const { fullName, aliases, photoUrl, notes, expiresAt, metadata } = req.validatedBody;

  // Verify watchlist belongs to tenant
  const { rows: wl } = await pool.query(
    'SELECT pk_watchlist_id FROM frs_watchlist WHERE pk_watchlist_id=$1 AND tenant_id=$2::uuid',
    [req.params.id, tenantId]
  );
  if (!wl.length) return res.status(404).json({ message: 'Watchlist not found' });

  const { rows } = await pool.query(
    `INSERT INTO frs_watchlist_person
       (fk_watchlist_id, tenant_id, full_name, aliases, photo_url, notes, expires_at, metadata, added_by)
     VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [req.params.id, tenantId, fullName.trim(), aliases, photoUrl || null, notes || null, expiresAt || null, JSON.stringify(metadata), userId]
  );
  return res.status(201).json(rows[0]);
}));

/* ── DELETE /api/watchlists/:id/persons/:personId ── */
router.delete('/:id/persons/:personId', requirePermission('watchlist.write'), asyncHandler(async (req, res) => {
  const tenantId = tid(req);
  const { rowCount } = await pool.query(
    `DELETE FROM frs_watchlist_person
     WHERE pk_person_id=$1 AND fk_watchlist_id=$2 AND tenant_id=$3::uuid`,
    [req.params.personId, req.params.id, tenantId]
  );
  if (!rowCount) return res.status(404).json({ message: 'Person not found' });
  return res.json({ success: true });
}));

export { router as watchlistRoutes };
