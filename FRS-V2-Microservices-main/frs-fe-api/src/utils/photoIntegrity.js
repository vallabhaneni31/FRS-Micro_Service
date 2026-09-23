/**
 * photoIntegrity.js — FIX-008: Replace MD5 passive liveness with SHA-256 HMAC
 *
 * Provides cryptographic integrity tokens for enrollment photos.
 * - Token = HMAC-SHA256(photoBuffer + invitationId, ENROLLMENT_TOKEN_SECRET)
 * - Constant-time comparison prevents timing oracle attacks.
 * - Generated at upload time; verified at approval time.
 */
import { createHmac, timingSafeEqual, randomBytes } from 'crypto';

function getSecret() {
  const secret = process.env.ENROLLMENT_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('[FATAL] ENROLLMENT_TOKEN_SECRET missing or too short');
  }
  return secret;
}

/**
 * Generates a HMAC-SHA256 integrity token for an enrollment photo.
 *
 * @param {Buffer} photoBuffer - Raw photo bytes
 * @param {string} invitationId - UUID of the enrollment invitation
 * @param {string} angle - 'front' | 'left' | 'right' | 'up' | 'down'
 * @returns {string} hex-encoded HMAC token
 */
export function generatePhotoIntegrityToken(photoBuffer, invitationId, angle) {
  const secret = getSecret();
  return createHmac('sha256', secret)
    .update(photoBuffer)
    .update(invitationId)
    .update(angle)
    .digest('hex');
}

/**
 * Verifies a photo's integrity token using constant-time comparison.
 *
 * @param {Buffer} photoBuffer - Raw photo bytes (read from disk)
 * @param {string} invitationId - UUID of the enrollment invitation
 * @param {string} angle - Photo angle
 * @param {string} storedToken - Token stored at upload time
 * @returns {boolean} true if photo is intact and unmodified
 */
export function verifyPhotoIntegrityToken(photoBuffer, invitationId, angle, storedToken) {
  if (!storedToken || typeof storedToken !== 'string') return false;

  const expected = generatePhotoIntegrityToken(photoBuffer, invitationId, angle);

  const expectedBuf = Buffer.from(expected, 'hex');
  const storedBuf   = Buffer.from(storedToken, 'hex');

  // Constant-length comparison to prevent timing attacks
  if (expectedBuf.length !== storedBuf.length) return false;
  return timingSafeEqual(expectedBuf, storedBuf);
}
