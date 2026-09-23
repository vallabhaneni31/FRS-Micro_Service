/**
 * deviceTokenRoutes.js — FIX-012: Device JWT token rotation & revocation
 *
 * POST /api/device-tokens/:deviceId/rotate  — issue a new token, revoke the old one
 * POST /api/device-tokens/:deviceId/revoke  — revoke the current token immediately
 * GET  /api/device-tokens/:deviceId/status  — check whether current token is active
 *
 * All endpoints require: valid Keycloak JWT + devices.manage permission.
 */
import express from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { requireAuth, requirePermission } from '../middleware/authz.js';
import { validateScopeAccess } from '../middleware/scopeExtractor.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { pool } from '../db/pool.js';
import { writeAudit } from '../middleware/auditLog.js';
import logger from '../utils/logger.js';
import { validateBody, revokeDeviceTokenSchema } from '../validators/schemas.js';

const router = express.Router();

const DEVICE_JWT_SECRET = process.env.DEVICE_JWT_SECRET;
const DEVICE_TOKEN_TTL_SECONDS = Number(process.env.DEVICE_TOKEN_TTL_SECONDS || 86400 * 30); // 30 days default

// ── Helper: check revocation table ───────────────────────────────────────────
export async function isTokenRevoked(jti) {
  if (!jti) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM device_token_revocations WHERE jti = $1 LIMIT 1`,
    [jti]
  );
  return rows.length > 0;
}

// ── Helper: revoke a token by JTI ────────────────────────────────────────────
async function revokeToken(jti, deviceId, revokedBy, reason) {
  if (!jti) return;
  await pool.query(
    `INSERT INTO device_token_revocations (device_id, jti, revoked_by, reason)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (jti) DO NOTHING`,
    [deviceId, jti, revokedBy || null, reason || null]
  );
}

// ── Helper: issue a new device JWT ───────────────────────────────────────────
function issueDeviceToken(device) {
  const jti = randomUUID();
  const payload = {
    jti,
    device_id: device.pk_device_id,
    device_code: device.external_device_id,
    tenant_id: device.tenant_id,
    type: device.category || 'device',
    iat: Math.floor(Date.now() / 1000),
  };
  const token = jwt.sign(payload, DEVICE_JWT_SECRET, { expiresIn: DEVICE_TOKEN_TTL_SECONDS });
  return { token, jti };
}

// ── Rotate token ─────────────────────────────────────────────────────────────
router.post(
  '/:deviceId/rotate',
  requireAuth,
  validateScopeAccess,
  requirePermission('devices.manage'),
  asyncHandler(async (req, res) => {
    const { deviceId } = req.params;
    const requestingUserId = req.auth?.user?.id;

    // Load the device — ensures it belongs to the requester's tenant
    const tenantId = req.auth?.scope?.tenantId;
    const { rows: devRows } = await pool.query(
      `SELECT fd.pk_device_id, fd.external_device_id, fd.tenant_id, fd.current_jti,
              dt.category
       FROM facility_device fd
       LEFT JOIN device_type dt ON dt.pk_device_type_id = fd.device_type_id
       WHERE fd.pk_device_id = $1
         AND ($2::uuid IS NULL OR fd.tenant_id = $2::uuid)`,
      [deviceId, tenantId]
    );

    if (!devRows.length) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const device = devRows[0];

    // Revoke the old token (if any)
    if (device.current_jti) {
      await revokeToken(device.current_jti, device.pk_device_id, requestingUserId, 'rotation');
    }

    // Issue a new token
    const { token, jti } = issueDeviceToken(device);

    // Persist new JTI on the device record
    await pool.query(
      `UPDATE facility_device SET current_jti = $1, token_issued_at = NOW()
       WHERE pk_device_id = $2`,
      [jti, device.pk_device_id]
    );

    await writeAudit({
      req,
      action: 'device.token.rotate',
      details: `Device token rotated for device ${device.external_device_id}`,
      entityType: 'device',
      entityId: device.pk_device_id,
      source: 'api',
    });

    logger.info({ deviceId, jti }, '[FIX-012] Device token rotated');

    return res.json({
      success: true,
      token,
      expires_in: DEVICE_TOKEN_TTL_SECONDS,
      device_id: device.pk_device_id,
      device_code: device.external_device_id,
    });
  })
);

// ── Revoke token ─────────────────────────────────────────────────────────────
router.post(
  '/:deviceId/revoke',
  requireAuth,
  validateScopeAccess,
  requirePermission('devices.manage'),
  validateBody(revokeDeviceTokenSchema),
  asyncHandler(async (req, res) => {
    const { deviceId } = req.params;
    const { reason } = req.validatedBody;
    const requestingUserId = req.auth?.user?.id;
    const tenantId = req.auth?.scope?.tenantId;

    const { rows: devRows } = await pool.query(
      `SELECT pk_device_id, external_device_id, tenant_id, current_jti
       FROM facility_device
       WHERE pk_device_id = $1
         AND ($2::uuid IS NULL OR tenant_id = $2::uuid)`,
      [deviceId, tenantId]
    );

    if (!devRows.length) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const device = devRows[0];

    if (!device.current_jti) {
      return res.json({ success: true, message: 'No active token to revoke' });
    }

    await revokeToken(device.current_jti, device.pk_device_id, requestingUserId, reason || 'manual_revocation');

    // Clear the current_jti on the device
    await pool.query(
      `UPDATE facility_device SET current_jti = NULL WHERE pk_device_id = $1`,
      [device.pk_device_id]
    );

    await writeAudit({
      req,
      action: 'device.token.revoke',
      details: `Device token revoked for device ${device.external_device_id}. Reason: ${reason || 'manual_revocation'}`,
      entityType: 'device',
      entityId: device.pk_device_id,
      source: 'api',
    });

    logger.info({ deviceId, reason }, '[FIX-012] Device token revoked');

    return res.json({ success: true, message: 'Token revoked successfully' });
  })
);

// ── Token status check ────────────────────────────────────────────────────────
router.get(
  '/:deviceId/status',
  requireAuth,
  validateScopeAccess,
  requirePermission('devices.manage'),
  asyncHandler(async (req, res) => {
    const { deviceId } = req.params;
    const tenantId = req.auth?.scope?.tenantId;

    const { rows: devRows } = await pool.query(
      `SELECT pk_device_id, external_device_id, current_jti, token_issued_at
       FROM facility_device
       WHERE pk_device_id = $1
         AND ($2::uuid IS NULL OR tenant_id = $2::uuid)`,
      [deviceId, tenantId]
    );

    if (!devRows.length) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const device = devRows[0];
    const hasToken = !!device.current_jti;
    let isRevoked = false;

    if (hasToken) {
      isRevoked = await isTokenRevoked(device.current_jti);
    }

    return res.json({
      device_id: device.pk_device_id,
      device_code: device.external_device_id,
      has_active_token: hasToken && !isRevoked,
      token_issued_at: device.token_issued_at || null,
    });
  })
);

export { router as deviceTokenRoutes };
