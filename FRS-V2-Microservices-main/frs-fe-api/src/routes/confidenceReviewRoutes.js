import express from 'express';
import { pool } from '../db/pool.js';
import { requireAuth, requirePermission } from '../middleware/authz.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { writeAudit } from '../middleware/auditLog.js';

const router = express.Router();
router.use(requireAuth);

function tid(req) { return req.auth?.scope?.tenantId ?? req.headers['x-tenant-id'] ?? null; }
function uid(req) { return req.auth?.user?.id ?? null; }

/* ── GET /api/confidence-reviews ── list pending/filtered reviews */
router.get('/', requirePermission('confidence_review.read'), asyncHandler(async (req, res) => {
  const tenantId = tid(req);
  const { status = 'pending', page = '1', limit = '50', from, to, siteId } = req.query;
  const lim = Math.min(Number(limit) || 50, 100);
  const off = (Math.max(Number(page), 1) - 1) * lim;

  let where = ['cr.tenant_id = $1::uuid'];
  const params = [tenantId];
  const p = () => `$${params.length}`;

  if (status)  { params.push(status);         where.push(`cr.review_status = ${p()}`); }
  if (siteId)  { params.push(Number(siteId)); where.push(`cr.site_id = ${p()}`); }
  if (from)    { params.push(from);           where.push(`cr.created_at >= ${p()}`); }
  if (to)      { params.push(to);             where.push(`cr.created_at <= ${p()}`); }

  params.push(lim, off);
  const { rows } = await pool.query(
    `SELECT cr.*, u.username AS reviewer_name
     FROM frs_confidence_review cr
     LEFT JOIN frs_user u ON u.pk_user_id = cr.reviewer_id
     WHERE ${where.join(' AND ')}
     ORDER BY cr.ai_confidence ASC, cr.created_at ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return res.json({ reviews: rows, page: Number(page), limit: lim });
}));

/* ── GET /api/confidence-reviews/stats ── */
router.get('/stats', requirePermission('confidence_review.read'), asyncHandler(async (req, res) => {
  const tenantId = tid(req);
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE review_status='pending')   AS pending_count,
       COUNT(*) FILTER (WHERE review_status='confirmed') AS confirmed_count,
       COUNT(*) FILTER (WHERE review_status='rejected')  AS rejected_count,
       COUNT(*) FILTER (WHERE review_status='escalated') AS escalated_count,
       ROUND(AVG(ai_confidence)::numeric, 4)             AS avg_confidence,
       COUNT(*) FILTER (WHERE ai_confidence < 0.7)       AS low_confidence_count,
       COUNT(*)                                          AS total
     FROM frs_confidence_review WHERE tenant_id = $1::uuid`,
    [tenantId]
  );
  return res.json(rows[0]);
}));

/* ── GET /api/confidence-reviews/threshold ── get tenant threshold config */
router.get('/threshold', requirePermission('confidence_review.read'), asyncHandler(async (req, res) => {
  const tenantId = tid(req);
  const { rows } = await pool.query(
    `SELECT * FROM frs_confidence_threshold WHERE tenant_id = $1::uuid`,
    [tenantId]
  );
  // Return defaults if not configured yet
  if (!rows.length) {
    return res.json({
      auto_accept_above: 0.95,
      auto_reject_below: 0.50,
      review_band_low:   0.50,
      review_band_high:  0.95,
      alert_on_low:      true,
    });
  }
  return res.json(rows[0]);
}));

/* ── PUT /api/confidence-reviews/threshold ── upsert threshold config */
router.put('/threshold', requirePermission('confidence_review.write'), asyncHandler(async (req, res) => {
  const tenantId = tid(req);
  const userId   = uid(req);
  const { autoAcceptAbove = 0.95, autoRejectBelow = 0.50, alertOnLow = true } = req.body;

  if (autoAcceptAbove <= autoRejectBelow) {
    return res.status(400).json({ message: 'autoAcceptAbove must be greater than autoRejectBelow' });
  }

  const { rows } = await pool.query(
    `INSERT INTO frs_confidence_threshold
       (tenant_id, auto_accept_above, auto_reject_below, review_band_low, review_band_high, alert_on_low, updated_by)
     VALUES ($1::uuid, $2, $3, $3, $2, $4, $5)
     ON CONFLICT (tenant_id) DO UPDATE SET
       auto_accept_above = $2,
       auto_reject_below = $3,
       review_band_low   = $3,
       review_band_high  = $2,
       alert_on_low      = $4,
       updated_by        = $5,
       updated_at        = NOW()
     RETURNING *`,
    [tenantId, autoAcceptAbove, autoRejectBelow, alertOnLow, userId]
  );
  await writeAudit({ req, action: 'confidence_threshold.updated', entityType: 'threshold', entityId: String(rows[0].pk_threshold_id) });
  return res.json(rows[0]);
}));

/* ── GET /api/confidence-reviews/:id ── */
router.get('/:id', requirePermission('confidence_review.read'), asyncHandler(async (req, res) => {
  const tenantId = tid(req);
  const { rows } = await pool.query(
    `SELECT cr.*, u.username AS reviewer_name
     FROM frs_confidence_review cr
     LEFT JOIN frs_user u ON u.pk_user_id = cr.reviewer_id
     WHERE cr.pk_review_id = $1 AND cr.tenant_id = $2::uuid`,
    [req.params.id, tenantId]
  );
  if (!rows.length) return res.status(404).json({ message: 'Review not found' });
  return res.json(rows[0]);
}));

/* ── POST /api/confidence-reviews ── create a review item (usually called by system) */
router.post('/', requirePermission('confidence_review.write'), asyncHandler(async (req, res) => {
  const tenantId = tid(req);
  const { eventId, siteId, faceSnapshotUrl, aiConfidence, aiMatchId, aiMatchName, flaggedForAudit = false } = req.body;
  if (aiConfidence === undefined) return res.status(400).json({ message: 'aiConfidence is required' });

  const { rows } = await pool.query(
    `INSERT INTO frs_confidence_review
       (tenant_id, site_id, event_id, face_snapshot_url, ai_confidence, ai_match_id, ai_match_name, flagged_for_audit)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [tenantId, siteId || null, eventId || null, faceSnapshotUrl || null, aiConfidence, aiMatchId || null, aiMatchName || null, flaggedForAudit]
  );
  return res.status(201).json(rows[0]);
}));

/* ── PATCH /api/confidence-reviews/:id/review ── confirm / reject / escalate */
router.patch('/:id/review', requirePermission('confidence_review.write'), asyncHandler(async (req, res) => {
  const tenantId = tid(req);
  const userId   = uid(req);
  const { action, notes, correctMatchId } = req.body;
  const VALID = ['confirmed', 'rejected', 'escalated'];
  if (!VALID.includes(action)) {
    return res.status(400).json({ message: `action must be one of: ${VALID.join(',')}` });
  }

  const { rows } = await pool.query(
    `UPDATE frs_confidence_review
     SET review_status = $1, reviewer_id = $2, reviewed_at = NOW(),
         reviewer_notes = $3, correct_match_id = $4, updated_at = NOW()
     WHERE pk_review_id = $5 AND tenant_id = $6::uuid
     RETURNING *`,
    [action, userId, notes || null, correctMatchId || null, req.params.id, tenantId]
  );
  if (!rows.length) return res.status(404).json({ message: 'Review not found' });
  await writeAudit({ req, action: `confidence_review.${action}`, entityType: 'confidence_review', entityId: req.params.id });
  return res.json(rows[0]);
}));

export { router as confidenceReviewRoutes };
