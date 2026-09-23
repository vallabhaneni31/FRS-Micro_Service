import express from 'express';
import { pool } from '../db/pool.js';
import { requireAuth, requirePermission } from '../middleware/authz.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { writeAudit } from '../middleware/auditLog.js';
import { validateBody } from '../validators/schemas.js';
import { createIncidentSchema, addIncidentCommentSchema } from '../validators/incidentSchemas.js';

const router = express.Router();
router.use(requireAuth);

function tid(req) { return req.auth?.scope?.tenantId ?? req.headers['x-tenant-id'] ?? null; }
function uid(req) { return req.auth?.user?.id ?? null; }

/** Generate incident number: INC-YYYY-NNNNN */
async function genIncidentNumber(tenantId) {
  const year = new Date().getFullYear();
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM frs_incident WHERE tenant_id = $1::uuid AND EXTRACT(YEAR FROM created_at) = $2`,
    [tenantId, year]
  );
  return `INC-${year}-${String(Number(rows[0].cnt) + 1).padStart(5, '0')}`;
}

/* ── GET /api/incidents ── */
router.get('/', requirePermission('incidents.read'), asyncHandler(async (req, res) => {
  const { status, severity, type, assignedTo, from, to, page = '1', limit = '50' } = req.query;
  const lim = Math.min(Number(limit) || 50, 100);
  const off = (Math.max(Number(page), 1) - 1) * lim;
  const tenantId = tid(req);

  let where = ['i.tenant_id = $1::uuid'];
  const params = [tenantId];
  const p = () => `$${params.length}`;

  if (status)     { params.push(status);           where.push(`i.status = ${p()}`); }
  if (severity)   { params.push(severity);         where.push(`i.severity = ${p()}`); }
  if (type)       { params.push(type);             where.push(`i.incident_type = ${p()}`); }
  if (assignedTo) { params.push(Number(assignedTo)); where.push(`i.assigned_to = ${p()}`); }
  if (from)       { params.push(from);             where.push(`i.created_at >= ${p()}`); }
  if (to)         { params.push(to);               where.push(`i.created_at <= ${p()}`); }

  params.push(lim, off);
  const { rows } = await pool.query(
    `SELECT i.*,
       r.username AS reporter_name,
       a.username AS assigned_to_name
     FROM frs_incident i
     LEFT JOIN frs_user r ON r.pk_user_id = i.reporter_id
     LEFT JOIN frs_user a ON a.pk_user_id = i.assigned_to
     WHERE ${where.join(' AND ')}
     ORDER BY
       CASE i.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
       i.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return res.json({ incidents: rows, page: Number(page), limit: lim });
}));

/* ── GET /api/incidents/stats ── */
router.get('/stats', requirePermission('incidents.read'), asyncHandler(async (req, res) => {
  const tenantId = tid(req);
  const { rows } = await pool.query(
    `SELECT
       SUM(CASE WHEN status='open'         THEN 1 ELSE 0 END) AS open_count,
       SUM(CASE WHEN status='investigating' THEN 1 ELSE 0 END) AS investigating_count,
       SUM(CASE WHEN status='resolved'     THEN 1 ELSE 0 END) AS resolved_count,
       SUM(CASE WHEN status='closed'       THEN 1 ELSE 0 END) AS closed_count,
       SUM(CASE WHEN severity='critical'   THEN 1 ELSE 0 END) AS critical_count,
       SUM(CASE WHEN severity='high'       THEN 1 ELSE 0 END) AS high_count,
       COUNT(*) AS total
     FROM frs_incident WHERE tenant_id = $1::uuid`,
    [tenantId]
  );
  return res.json(rows[0]);
}));

/* ── GET /api/incidents/:id ── with timeline */
router.get('/:id', requirePermission('incidents.read'), asyncHandler(async (req, res) => {
  const tenantId = tid(req);
  const { rows: inc } = await pool.query(
    `SELECT i.*, r.username AS reporter_name, a.username AS assigned_to_name
     FROM frs_incident i
     LEFT JOIN frs_user r ON r.pk_user_id = i.reporter_id
     LEFT JOIN frs_user a ON a.pk_user_id = i.assigned_to
     WHERE i.pk_incident_id = $1 AND i.tenant_id = $2::uuid`,
    [req.params.id, tenantId]
  );
  if (!inc.length) return res.status(404).json({ message: 'Incident not found' });

  const { rows: timeline } = await pool.query(
    `SELECT t.*, u.username AS user_name
     FROM frs_incident_timeline t
     LEFT JOIN frs_user u ON u.pk_user_id = t.user_id
     WHERE t.fk_incident_id = $1
     ORDER BY t.created_at ASC`,
    [req.params.id]
  );
  return res.json({ ...inc[0], timeline });
}));

/* ── POST /api/incidents ── create */
router.post('/', requirePermission('incidents.write'), validateBody(createIncidentSchema), asyncHandler(async (req, res) => {
  const tenantId = tid(req);
  const userId   = uid(req);
  const { title, description, incidentType, severity, siteId, tags, metadata } = req.validatedBody;

  const incNum = await genIncidentNumber(tenantId);
  const { rows } = await pool.query(
    `INSERT INTO frs_incident
       (tenant_id, site_id, incident_number, title, description, incident_type, severity, reporter_id, tags, metadata)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [tenantId, siteId || null, incNum, title, description || null, incidentType, severity, userId, tags, JSON.stringify(metadata)]
  );
  const incident = rows[0];

  // Timeline entry
  await pool.query(
    `INSERT INTO frs_incident_timeline (fk_incident_id, user_id, action, new_value)
     VALUES ($1, $2, 'created', $3)`,
    [incident.pk_incident_id, userId, `Incident ${incNum} created`]
  );

  await writeAudit({ req, action: 'incident.created', entityType: 'incident', entityId: String(incident.pk_incident_id) });
  return res.status(201).json(incident);
}));

/* ── PATCH /api/incidents/:id ── update fields */
router.patch('/:id', requirePermission('incidents.write'), asyncHandler(async (req, res) => {
  const tenantId = tid(req);
  const { title, description, severity, assignedTo, tags } = req.body;
  const sets = [];
  const params = [req.params.id, tenantId];
  const p = () => `$${params.length}`;

  if (title !== undefined)      { params.push(title);           sets.push(`title = ${p()}`); }
  if (description !== undefined){ params.push(description);     sets.push(`description = ${p()}`); }
  if (severity !== undefined)   { params.push(severity);        sets.push(`severity = ${p()}`); }
  if (assignedTo !== undefined) { params.push(assignedTo || null); sets.push(`assigned_to = ${p()}`); }
  if (tags !== undefined)       { params.push(tags);            sets.push(`tags = ${p()}`); }
  if (!sets.length) return res.status(400).json({ message: 'No fields to update' });

  sets.push(`updated_at = NOW()`);
  const { rows } = await pool.query(
    `UPDATE frs_incident SET ${sets.join(', ')} WHERE pk_incident_id=$1 AND tenant_id=$2::uuid RETURNING *`,
    params
  );
  if (!rows.length) return res.status(404).json({ message: 'Incident not found' });
  return res.json(rows[0]);
}));

/* ── PATCH /api/incidents/:id/status ── change status */
router.patch('/:id/status', requirePermission('incidents.write'), asyncHandler(async (req, res) => {
  const tenantId = tid(req);
  const userId   = uid(req);
  const { status, comment } = req.body;
  const VALID = ['open', 'investigating', 'resolved', 'closed'];
  if (!VALID.includes(status)) return res.status(400).json({ message: `status must be one of: ${VALID.join(',')}` });

  const extraSets = status === 'resolved' ? ', resolved_at = NOW()' : status === 'closed' ? ', closed_at = NOW()' : '';
  const { rows } = await pool.query(
    `UPDATE frs_incident SET status=$1, updated_at=NOW()${extraSets}
     WHERE pk_incident_id=$2 AND tenant_id=$3::uuid RETURNING *`,
    [status, req.params.id, tenantId]
  );
  if (!rows.length) return res.status(404).json({ message: 'Incident not found' });

  await pool.query(
    `INSERT INTO frs_incident_timeline (fk_incident_id, user_id, action, new_value, comment)
     VALUES ($1, $2, 'status_changed', $3, $4)`,
    [req.params.id, userId, status, comment || null]
  );
  return res.json(rows[0]);
}));

/* ── POST /api/incidents/:id/comments ── */
router.post('/:id/comments', requirePermission('incidents.write'), validateBody(addIncidentCommentSchema), asyncHandler(async (req, res) => {
  const userId = uid(req);
  const { comment } = req.validatedBody;

  const { rows } = await pool.query(
    `INSERT INTO frs_incident_timeline (fk_incident_id, user_id, action, comment)
     VALUES ($1, $2, 'comment', $3) RETURNING *`,
    [req.params.id, userId, comment]
  );
  return res.status(201).json(rows[0]);
}));

export { router as incidentRoutes };
