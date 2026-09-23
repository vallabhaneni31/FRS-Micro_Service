/**
 * biometricConsentRoutes.js — FIX-025: Biometric consent management API
 *
 * POST /api/consent/biometric/record      — employee records consent via portal
 * POST /api/consent/biometric/withdraw    — employee withdraws consent
 * GET  /api/consent/biometric/:employeeId — HR checks consent status
 *
 * Consent must be recorded before an enrollment invitation can accept photos.
 */
import express from 'express';
import { requireAuth, requirePermission } from '../middleware/authz.js';
import { validateScopeAccess } from '../middleware/scopeExtractor.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { pool } from '../db/pool.js';
import { writeAudit } from '../middleware/auditLog.js';
import logger from '../utils/logger.js';
import { validateBody } from '../validators/schemas.js';
import { recordConsentSchema, withdrawConsentSchema, employeeIdParamSchema } from '../validators/biometricConsentSchemas.js';

const router = express.Router();

const CONSENT_VERSION = process.env.BIOMETRIC_CONSENT_VERSION || '1.0';

// ── Record biometric consent ──────────────────────────────────────────────────
router.post(
  '/record',
  requireAuth,
  validateScopeAccess,
  validateBody(recordConsentSchema),
  asyncHandler(async (req, res) => {
    const { employeeId, consentMethod, consentVersion } = req.validatedBody;
    const method     = consentMethod || 'enrollment_portal';
    const version    = consentVersion || CONSENT_VERSION;

    const tenantId = req.auth?.scope?.tenantId;

    // Verify employee belongs to the requesting tenant
    const { rows: empRows } = await pool.query(
      `SELECT pk_employee_id, tenant_id FROM hr_employee
       WHERE pk_employee_id = $1
         AND ($2::uuid IS NULL OR tenant_id = $2::uuid)`,
      [employeeId, tenantId]
    );
    if (!empRows.length) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const rawIp = req.headers['x-forwarded-for']?.split(',')[0]
               || req.socket?.remoteAddress;
    const ip    = rawIp?.replace('::ffff:', '') || null;

    const { rows } = await pool.query(
      `INSERT INTO biometric_consent
         (fk_employee_id, tenant_id, consent_given, consent_version,
          consent_method, ip_address, user_agent, consented_at)
       VALUES ($1::uuid, $2::uuid, true, $3, $4, $5::inet, $6, NOW())
       ON CONFLICT (fk_employee_id, consent_version) DO UPDATE
         SET consent_given = true,
             consent_method = EXCLUDED.consent_method,
             ip_address     = EXCLUDED.ip_address,
             user_agent     = EXCLUDED.user_agent,
             consented_at   = NOW(),
             withdrawn_at   = NULL,
             withdrawn_reason = NULL,
             updated_at     = NOW()
       RETURNING pk_consent_id, consented_at`,
      [employeeId, empRows[0].tenant_id, version, method, ip,
       req.headers['user-agent']?.slice(0, 500) || null]
    );

    await writeAudit({
      req,
      action:     'biometric.consent.recorded',
      details:    `Biometric consent recorded for employee ${employeeId} (v${version})`,
      entityType: 'employee',
      entityId:   employeeId,
      source:     'ui',
    });

    logger.info({ employeeId, version, method }, '[FIX-025] Biometric consent recorded');

    return res.status(201).json({
      success:    true,
      consentId:  rows[0].pk_consent_id,
      consentedAt: rows[0].consented_at,
    });
  })
);

// ── Withdraw biometric consent ────────────────────────────────────────────────
router.post(
  '/withdraw',
  requireAuth,
  validateScopeAccess,
  validateBody(withdrawConsentSchema),
  asyncHandler(async (req, res) => {
    const { employeeId, reason } = req.validatedBody;

    const tenantId = req.auth?.scope?.tenantId;

    const { rows } = await pool.query(
      `UPDATE biometric_consent
       SET consent_given    = false,
           withdrawn_at     = NOW(),
           withdrawn_reason = $3,
           updated_at       = NOW()
       WHERE fk_employee_id = $1
         AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
         AND consent_given  = true
         AND withdrawn_at   IS NULL
       RETURNING pk_consent_id`,
      [employeeId, tenantId, reason || null]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'No active consent found for this employee' });
    }

    await writeAudit({
      req,
      action:     'biometric.consent.withdrawn',
      details:    `Biometric consent withdrawn for employee ${employeeId}. Reason: ${reason || 'not provided'}`,
      entityType: 'employee',
      entityId:   employeeId,
      source:     'ui',
    });

    logger.info({ employeeId, reason }, '[FIX-025] Biometric consent withdrawn');

    return res.json({ success: true, message: 'Consent withdrawn. A right-to-erasure request will be queued.' });
  })
);

// ── Check consent status ──────────────────────────────────────────────────────
router.get(
  '/:employeeId',
  requireAuth,
  validateScopeAccess,
  requirePermission('employees.view'),
  asyncHandler(async (req, res) => {
    const paramCheck = employeeIdParamSchema.safeParse(req.params);
    if (!paramCheck.success) {
      return res.status(400).json({ error: 'employeeId must be a valid UUID' });
    }
    const { employeeId } = paramCheck.data;
    const tenantId       = req.auth?.scope?.tenantId;

    const { rows } = await pool.query(
      `SELECT bc.pk_consent_id, bc.consent_given, bc.consent_version,
              bc.consent_method, bc.consented_at, bc.withdrawn_at
       FROM biometric_consent bc
       JOIN hr_employee e ON e.pk_employee_id = bc.fk_employee_id
       WHERE bc.fk_employee_id = $1
         AND ($2::uuid IS NULL OR e.tenant_id = $2::uuid)
       ORDER BY bc.consented_at DESC
       LIMIT 5`,
      [employeeId, tenantId]
    );

    const activeConsent = rows.find(r => r.consent_given && !r.withdrawn_at) || null;

    return res.json({
      employeeId,
      hasActiveConsent: !!activeConsent,
      activeConsent,
      history: rows,
    });
  })
);

export { router as biometricConsentRoutes };
