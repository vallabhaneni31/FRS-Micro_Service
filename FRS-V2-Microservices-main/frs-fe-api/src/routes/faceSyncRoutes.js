/**
 * faceSyncRoutes.js — frs-fe-api slice
 *
 * NOTE (frs-fe-api split): the device-authenticated data-pull endpoints
 * formerly here — GET /embeddings, GET /employees, GET /config,
 * GET /cameras, GET /enrollment-pending (all `authenticateDevice`, Jetson
 * polling its own sync data) now live in frs-edge-api. Only the
 * browser/`requireAuth` trigger-enrollment route remains in this repo.
 *
 * POST /api/face/sync/trigger-enrollment — operator clicks "Enroll at
 * Kiosk" in the UI.
 */
import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth, requirePermission } from '../middleware/authz.js';
import { pool } from '../db/pool.js';

const router = express.Router();

// ─── Browser-authenticated endpoints (used by UI) ───────────────────────────

// POST /api/face/sync/trigger-enrollment — operator clicks "Enroll at Kiosk" in UI
// Sets kiosk_enrollment_status = 'pending_kiosk'; Jetson picks it up on next poll
router.post('/trigger-enrollment', requireAuth, requirePermission('users.manage'), asyncHandler(async (req, res) => {
  const { employee_id } = req.body;
  const tenantId = req.auth?.scope?.tenantId;

  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });

  const { rowCount, rows } = await pool.query(
    `UPDATE hr_employee
     SET kiosk_enrollment_status = 'pending_kiosk'
     WHERE pk_employee_id = $1 AND tenant_id = $2::uuid
     RETURNING pk_employee_id, employee_code, full_name, kiosk_enrollment_status`,
    [employee_id, tenantId]
  );

  if (!rowCount) return res.status(404).json({ error: 'Employee not found' });

  res.json({
    success: true,
    message: 'Enrollment queued — employee will be prompted at the next available kiosk',
    employee: rows[0],
  });
}));

export default router;
