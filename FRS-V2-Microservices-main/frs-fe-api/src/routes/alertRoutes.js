import express from 'express';
import { pool } from '../db/pool.js';
import { requireAuth, requirePermission } from '../middleware/authz.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { writeAudit } from '../middleware/auditLog.js';
import { validateBody } from '../validators/schemas.js';
import { createAlertSchema, assignAlertSchema } from '../validators/alertSchemas.js';

const router = express.Router();
router.use(requireAuth);

/* ── helpers ── */
function tenantId(req) {
  return req.auth?.scope?.tenantId ?? req.headers['x-tenant-id'] ?? null;
}

/* ── GET /api/alerts ── list with filters */
router.get('/', requirePermission('alerts.read'), asyncHandler(async (req, res) => {
  const tid = tenantId(req);
  const { status, severity, type, siteId, from, to, page = '1', limit = '50' } = req.query;

  const lim  = Math.min(Number(limit) || 50, 200);
  const off  = (Math.max(Number(page) || 1, 1) - 1) * lim;

  let where = ['a.tenant_id = $1::uuid'];
  const params = [tid];
  const p = () => `$${params.length}`;

  if (status)   { params.push(status);   where.push(`a.status = ${p()}`); }
  if (severity) { params.push(severity); where.push(`a.severity = ${p()}`); }
  if (type)     { params.push(type);     where.push(`a.alert_type = ${p()}`); }
  if (siteId)   { params.push(Number(siteId)); where.push(`a.site_id = ${p()}`); }
  if (from)     { params.push(from);     where.push(`a.created_at >= ${p()}`); }
  if (to)       { params.push(to);       where.push(`a.created_at <= ${p()}`); }

  params.push(lim, off);
  const { rows } = await pool.query(
    `SELECT a.*,
       ack.username AS acknowledged_by_name,
       res.username AS resolved_by_name,
       asg.username AS assigned_to_name
     FROM frs_alert a
     LEFT JOIN frs_user ack ON ack.pk_user_id = a.acknowledged_by
     LEFT JOIN frs_user res ON res.pk_user_id = a.resolved_by
     LEFT JOIN frs_user asg ON asg.pk_user_id = a.assigned_to
     WHERE ${where.join(' AND ')}
     ORDER BY
       CASE a.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
       a.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return res.json({ alerts: rows, page: Number(page), limit: lim });
}));

/* ── GET /api/alerts/stats ── severity + status counts */
router.get('/stats', requirePermission('alerts.read'), asyncHandler(async (req, res) => {
  const tid = tenantId(req);
  const { rows } = await pool.query(
    `SELECT
       SUM(CASE WHEN severity = 'critical' AND status = 'open' THEN 1 ELSE 0 END) AS critical_open,
       SUM(CASE WHEN severity = 'high'     AND status = 'open' THEN 1 ELSE 0 END) AS high_open,
       SUM(CASE WHEN severity = 'medium'   AND status = 'open' THEN 1 ELSE 0 END) AS medium_open,
       SUM(CASE WHEN severity = 'low'      AND status = 'open' THEN 1 ELSE 0 END) AS low_open,
       SUM(CASE WHEN status = 'open'         THEN 1 ELSE 0 END) AS total_open,
       SUM(CASE WHEN status = 'acknowledged' THEN 1 ELSE 0 END) AS total_acknowledged,
       SUM(CASE WHEN status = 'resolved'     THEN 1 ELSE 0 END) AS total_resolved,
       COUNT(*) AS total
     FROM frs_alert WHERE tenant_id = $1::uuid`,
    [tid]
  );
  return res.json(rows[0]);
}));

/* ── GET /api/alerts/:id ── single alert */
router.get('/:id', requirePermission('alerts.read'), asyncHandler(async (req, res) => {
  const tid = tenantId(req);
  const { rows } = await pool.query(
    `SELECT a.*,
       ack.username AS acknowledged_by_name,
       res.username AS resolved_by_name,
       asg.username AS assigned_to_name
     FROM frs_alert a
     LEFT JOIN frs_user ack ON ack.pk_user_id = a.acknowledged_by
     LEFT JOIN frs_user res ON res.pk_user_id = a.resolved_by
     LEFT JOIN frs_user asg ON asg.pk_user_id = a.assigned_to
     WHERE a.pk_alert_id = $1 AND a.tenant_id = $2::uuid`,
    [req.params.id, tid]
  );
  if (!rows.length) return res.status(404).json({ message: 'Alert not found' });
  return res.json(rows[0]);
}));

/* ── POST /api/alerts ── create */
router.post('/', requirePermission('alerts.write'), validateBody(createAlertSchema), asyncHandler(async (req, res) => {
  const tid = tenantId(req);
  const { alertType, severity, title, description, entityType, entityId, snapshotUrl, siteId, metadata } = req.validatedBody;

  const { rows } = await pool.query(
    `INSERT INTO frs_alert (tenant_id, site_id, alert_type, severity, title, description, entity_type, entity_id, snapshot_url, metadata)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [tid, siteId || null, alertType, severity, title, description || null, entityType || null, entityId || null, snapshotUrl || null, JSON.stringify(metadata)]
  );
  return res.status(201).json(rows[0]);
}));

/* ── PATCH /api/alerts/:id/acknowledge ── */
router.patch('/:id/acknowledge', requirePermission('alerts.write'), asyncHandler(async (req, res) => {
  const tid = tenantId(req);
  const userId = req.auth.user.id;
  const { rows } = await pool.query(
    `UPDATE frs_alert SET status='acknowledged', acknowledged_by=$1, acknowledged_at=NOW(), updated_at=NOW()
     WHERE pk_alert_id=$2 AND tenant_id=$3::uuid AND status='open'
     RETURNING *`,
    [userId, req.params.id, tid]
  );
  if (!rows.length) return res.status(404).json({ message: 'Alert not found or already actioned' });
  await writeAudit({ req, action: 'alert.acknowledged', entityType: 'alert', entityId: req.params.id });
  return res.json(rows[0]);
}));

/* ── PATCH /api/alerts/:id/resolve ── */
router.patch('/:id/resolve', requirePermission('alerts.write'), asyncHandler(async (req, res) => {
  const tid = tenantId(req);
  const userId = req.auth.user.id;
  const { rows } = await pool.query(
    `UPDATE frs_alert SET status='resolved', resolved_by=$1, resolved_at=NOW(), updated_at=NOW()
     WHERE pk_alert_id=$2 AND tenant_id=$3::uuid AND status IN ('open','acknowledged')
     RETURNING *`,
    [userId, req.params.id, tid]
  );
  if (!rows.length) return res.status(404).json({ message: 'Alert not found or already resolved' });
  await writeAudit({ req, action: 'alert.resolved', entityType: 'alert', entityId: req.params.id });
  return res.json(rows[0]);
}));

/* ── PATCH /api/alerts/:id/dismiss ── */
router.patch('/:id/dismiss', requirePermission('alerts.write'), asyncHandler(async (req, res) => {
  const tid = tenantId(req);
  const { rows } = await pool.query(
    `UPDATE frs_alert SET status='dismissed', updated_at=NOW()
     WHERE pk_alert_id=$1 AND tenant_id=$2::uuid AND status='open'
     RETURNING *`,
    [req.params.id, tid]
  );
  if (!rows.length) return res.status(404).json({ message: 'Alert not found or already actioned' });
  return res.json(rows[0]);
}));

/* ── PATCH /api/alerts/:id/assign ── */
router.patch('/:id/assign', requirePermission('alerts.write'), validateBody(assignAlertSchema), asyncHandler(async (req, res) => {
  const tid = tenantId(req);
  const { userId } = req.validatedBody;
  const { rows } = await pool.query(
    `UPDATE frs_alert SET assigned_to=$1, updated_at=NOW()
     WHERE pk_alert_id=$2 AND tenant_id=$3::uuid
     RETURNING *`,
    [userId || null, req.params.id, tid]
  );
  if (!rows.length) return res.status(404).json({ message: 'Alert not found' });
  return res.json(rows[0]);
}));

export { router as alertRoutes };
