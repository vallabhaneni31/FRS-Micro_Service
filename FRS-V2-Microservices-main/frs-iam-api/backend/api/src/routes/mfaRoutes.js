/**
 * mfaRoutes.js — S-02: MFA (TOTP) endpoints
 */
import express from 'express';
import crypto from 'crypto';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { authenticator } = _require('otplib');
import QRCode from 'qrcode';
import bcrypt from 'bcrypt';
import { requireAuth } from '../middleware/authz.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { pool } from '../db/pool.js';
import { writeAudit } from '../middleware/auditLog.js';
import { authRateLimiter } from '../middleware/rateLimit.js';
import logger from '../utils/logger.js';
import { env } from '../config/env.js';
import { validateBody } from '../validators/schemas.js';
import { enableMfaSchema, disableMfaSchema, verifyMfaSchema } from '../validators/mfaSchemas.js';

const router = express.Router();

// ── GET /api/auth/mfa/status ──────────────────────────────────────────────────
router.get('/status', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.auth.user.id;
  const { rows } = await pool.query(
    `SELECT mfa_enabled, mfa_enabled_at FROM frs_user WHERE pk_user_id = $1`,
    [userId]
  );
  if (!rows.length) return res.status(404).json({ message: 'User not found' });
  return res.json({ enabled: rows[0].mfa_enabled, enabledAt: rows[0].mfa_enabled_at });
}));

// ── POST /api/auth/mfa/setup ──────────────────────────────────────────────────
// Generates TOTP secret + QR code. Does NOT enable MFA yet.
router.post('/setup', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.auth.user.id;
  const { rows } = await pool.query(
    `SELECT email, mfa_enabled FROM frs_user WHERE pk_user_id = $1`,
    [userId]
  );
  if (!rows.length) return res.status(404).json({ message: 'User not found' });
  if (rows[0].mfa_enabled) return res.status(409).json({ message: 'MFA is already enabled' });

  const secret = authenticator.generateSecret(20);
  const otpauth = authenticator.keyuri(rows[0].email, 'FRS Platform', secret);
  const qrCodeUrl = await QRCode.toDataURL(otpauth);

  // Generate 10 one-time backup codes
  const backupCodes = Array.from({ length: 10 }, () =>
    crypto.randomBytes(4).toString('hex').toUpperCase()
  );

  // Store secret temporarily (not enabled yet — enabled only after verify)
  await pool.query(
    `UPDATE frs_user SET mfa_secret = $1 WHERE pk_user_id = $2`,
    [secret, userId]
  );

  return res.json({ secret, qrCodeUrl, backupCodes });
}));

// ── POST /api/auth/mfa/enable ────────────────────────────────────────────────
// Verifies TOTP + stores hashed backup codes + enables MFA.
router.post('/enable', requireAuth, validateBody(enableMfaSchema), asyncHandler(async (req, res) => {
  const { totp, backupCodes } = req.validatedBody;

  const userId = req.auth.user.id;
  const { rows } = await pool.query(
    `SELECT mfa_secret, mfa_enabled FROM frs_user WHERE pk_user_id = $1`,
    [userId]
  );
  if (!rows.length) return res.status(404).json({ message: 'User not found' });
  if (rows[0].mfa_enabled) return res.status(409).json({ message: 'MFA already enabled' });
  if (!rows[0].mfa_secret) return res.status(400).json({ message: 'Call /mfa/setup first' });

  const valid = authenticator.verify({ token: totp, secret: rows[0].mfa_secret });
  if (!valid) return res.status(401).json({ message: 'Invalid TOTP code' });

  // Hash backup codes for storage
  const hashedCodes = await Promise.all(
    (backupCodes || []).map((c) => bcrypt.hash(c.toUpperCase().replace(/-/g, ''), 10))
  );

  await pool.query(
    `UPDATE frs_user SET mfa_enabled = TRUE, mfa_enabled_at = NOW(), mfa_backup_codes = $1
     WHERE pk_user_id = $2`,
    [hashedCodes, userId]
  );

  await writeAudit({ req, action: 'user.mfa_enabled', entityType: 'user', entityId: userId });
  return res.json({ ok: true });
}));

// ── POST /api/auth/mfa/disable ───────────────────────────────────────────────
router.post('/disable', requireAuth, validateBody(disableMfaSchema), asyncHandler(async (req, res) => {
  const { password } = req.validatedBody;

  const userId = req.auth.user.id;
  const { rows } = await pool.query(
    `SELECT password_hash, mfa_enabled FROM frs_user WHERE pk_user_id = $1`,
    [userId]
  );
  if (!rows.length) return res.status(404).json({ message: 'User not found' });
  if (!rows[0].mfa_enabled) return res.status(409).json({ message: 'MFA is not enabled' });

  const passwordMatch = await bcrypt.compare(password, rows[0].password_hash);
  if (!passwordMatch) return res.status(401).json({ message: 'Invalid password' });

  await pool.query(
    `UPDATE frs_user SET mfa_enabled = FALSE, mfa_secret = NULL, mfa_backup_codes = '{}', mfa_enabled_at = NULL
     WHERE pk_user_id = $1`,
    [userId]
  );

  await writeAudit({ req, action: 'user.mfa_disabled', entityType: 'user', entityId: userId });
  return res.json({ ok: true });
}));

// ── POST /api/auth/mfa/verify ────────────────────────────────────────────────
// Called after successful credentials login when mfa_enabled=true.
// Body: { mfaChallengeToken, totp } OR { mfaChallengeToken, backupCode }
router.post('/verify', authRateLimiter, validateBody(verifyMfaSchema), asyncHandler(async (req, res) => {
  const { mfaChallengeToken, totp, backupCode } = req.validatedBody;

  // Validate challenge token
  const { rows: challengeRows } = await pool.query(
    `SELECT c.pk_challenge_id, c.user_id, c.expires_at, c.used_at,
            u.mfa_secret, u.mfa_backup_codes, u.email, u.username, u.role
     FROM frs_mfa_challenge c
     JOIN frs_user u ON u.pk_user_id = c.user_id
     WHERE c.challenge_token = $1`,
    [mfaChallengeToken]
  );

  if (!challengeRows.length) return res.status(401).json({ message: 'Invalid or expired challenge' });
  const challenge = challengeRows[0];
  if (challenge.used_at) return res.status(401).json({ message: 'Challenge already used' });
  if (new Date(challenge.expires_at) < new Date()) return res.status(401).json({ message: 'Challenge expired' });

  let verified = false;

  if (totp) {
    verified = authenticator.verify({ token: totp, secret: challenge.mfa_secret });
  } else if (backupCode) {
    const normalized = backupCode.toUpperCase().replace(/-/g, '');
    const codes = challenge.mfa_backup_codes || [];
    for (let i = 0; i < codes.length; i++) {
      if (await bcrypt.compare(normalized, codes[i])) {
        // Remove used backup code
        const newCodes = codes.filter((_, idx) => idx !== i);
        await pool.query(`UPDATE frs_user SET mfa_backup_codes = $1 WHERE pk_user_id = $2`, [newCodes, challenge.user_id]);
        verified = true;
        break;
      }
    }
  }

  if (!verified) {
    await writeAudit({ req, action: 'auth.mfa_failed', entityId: challenge.user_id, entityType: 'user' });
    return res.status(401).json({ message: 'Invalid MFA code' });
  }

  // Mark challenge as used
  await pool.query(`UPDATE frs_mfa_challenge SET used_at = NOW() WHERE pk_challenge_id = $1`, [challenge.pk_challenge_id]);

  // Import token generation and session cookie helpers
  const { generateSessionTokens, hashToken } = await import('../services/tokenService.js');
  const { saveSessionToken } = await import('../repositories/authRepository.js');

  let ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const context = { ipAddress: ip, userAgent: req.headers['user-agent'] || 'unknown' };

  const tokens = generateSessionTokens();
  await saveSessionToken({
    userId:           challenge.user_id,
    accessToken:      hashToken(tokens.accessToken),
    refreshToken:     hashToken(tokens.refreshToken),
    accessExpiresAt:  tokens.accessExpiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
    userAgent:        context.userAgent,
    ipAddress:        context.ipAddress,
  });

  const cookieOpts = (maxAgeMs) => ({
    httpOnly: true,
    secure:   env.nodeEnv === 'production',
    sameSite: 'strict',
    path:     '/',
    maxAge:   maxAgeMs,
  });

  res.cookie('access_token',  tokens.accessToken,  cookieOpts(env.token.accessTokenTtlMinutes * 60 * 1000));
  res.cookie('refresh_token', tokens.refreshToken, cookieOpts(env.token.refreshTokenTtlDays * 24 * 60 * 60 * 1000));

  await writeAudit({ req, action: 'auth.mfa_verified', entityId: challenge.user_id, entityType: 'user' });
  return res.json({ ok: true });
}));

export default router;
