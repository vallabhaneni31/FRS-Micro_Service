/**
 * validateEventSignature.js — FIX-024: Cloud-side liveness HMAC event signature validation
 *
 * Jetson devices sign each event payload with an HMAC-SHA256 signature so the
 * cloud can verify the event was genuinely produced by a trusted device and has
 * not been tampered with in transit.
 *
 * Header expected:   X-Event-Signature: sha256=<hex-HMAC>
 * Signed payload:    JSON.stringify(req.body) — use a raw body buffer to avoid
 *                    JSON re-serialisation differences.
 *
 * Secret:   JETSON_EVENT_SECRET env var (shared symmetric key, device-specific
 *           secrets are recommended via JETSON_EVENT_SECRET_<DEVICE_CODE> pattern).
 *
 * Usage:
 *   router.post('/events', validateEventSignature, asyncHandler(...));
 */
import { createHmac, timingSafeEqual } from 'crypto';
import logger from '../utils/logger.js';

const SIGNATURE_HEADER = 'x-event-signature';
const ALG              = 'sha256';

/**
 * Get the HMAC secret for a specific device or fall back to the global secret.
 *
 * @param {string} [deviceCode]
 * @returns {string|null}
 */
function getSecret(deviceCode) {
  if (deviceCode) {
    const devSpecific = process.env[`JETSON_EVENT_SECRET_${deviceCode.toUpperCase()}`];
    if (devSpecific && devSpecific.length >= 32) return devSpecific;
  }
  const global = process.env.JETSON_EVENT_SECRET;
  if (!global) return null;
  return global;
}

/**
 * Compute the expected HMAC-SHA256 over the raw request body.
 *
 * @param {Buffer} rawBody
 * @param {string} secret
 * @returns {string} hex digest
 */
export function computeEventSignature(rawBody, secret) {
  return createHmac(ALG, secret).update(rawBody).digest('hex');
}

/**
 * Express middleware: validates X-Event-Signature header.
 *
 * Falls back to a warning (not rejection) when JETSON_EVENT_SECRET is not
 * configured, so existing deployments aren't broken immediately.
 * Set ENFORCE_EVENT_SIGNATURES=true to make failures hard errors.
 */
export function validateEventSignature(req, res, next) {
  const enforce    = process.env.ENFORCE_EVENT_SIGNATURES === 'true';
  const deviceCode = req.device?.code || req.body?.device_code || req.params?.camId;
  const secret     = getSecret(deviceCode);

  if (!secret) {
    if (enforce) {
      logger.error('[validateEventSignature] JETSON_EVENT_SECRET not configured — rejecting event');
      return res.status(500).json({ error: 'Event signature validation misconfigured' });
    }
    logger.warn({ path: req.path }, '[validateEventSignature] JETSON_EVENT_SECRET not set — skipping signature check');
    return next();
  }

  const headerValue = req.headers[SIGNATURE_HEADER];
  if (!headerValue) {
    if (enforce) {
      logger.warn({ path: req.path, deviceCode }, '[validateEventSignature] Missing signature header');
      return res.status(401).json({ error: `Missing ${SIGNATURE_HEADER} header` });
    }
    logger.warn({ path: req.path, deviceCode }, '[validateEventSignature] No signature header — skipping (non-enforced)');
    return next();
  }

  // Header format: "sha256=<hex>"
  const [prefix, receivedHex] = headerValue.split('=');
  if (prefix !== ALG || !receivedHex) {
    return res.status(400).json({ error: `Invalid ${SIGNATURE_HEADER} format — expected sha256=<hex>` });
  }

  // Use the raw body buffer — set by express.raw() or a raw-body capture middleware
  const rawBody = req.rawBody;
  if (!rawBody) {
    // Fallback: re-serialize the parsed body (may differ from original for some edge cases)
    logger.warn('[validateEventSignature] rawBody not available — using JSON.stringify fallback');
  }
  const payload = rawBody || Buffer.from(JSON.stringify(req.body));

  const expected    = computeEventSignature(payload, secret);
  const expectedBuf = Buffer.from(expected,     'hex');
  const receivedBuf = Buffer.from(receivedHex,  'hex');

  if (expectedBuf.length !== receivedBuf.length) {
    logger.warn({ deviceCode, path: req.path }, '[validateEventSignature] Signature length mismatch');
    return res.status(401).json({ error: 'Invalid event signature' });
  }

  if (!timingSafeEqual(expectedBuf, receivedBuf)) {
    logger.warn({ deviceCode, path: req.path }, '[validateEventSignature] Signature mismatch — possible tampering');
    return res.status(401).json({ error: 'Invalid event signature' });
  }

  // Signature valid — attach to req for downstream use
  req.eventSignatureVerified = true;
  next();
}
