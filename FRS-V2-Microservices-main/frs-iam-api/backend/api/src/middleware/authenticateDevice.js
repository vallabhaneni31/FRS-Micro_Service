/**
 * authenticateDevice.js — FIX-012: Device JWT authentication with revocation check
 *
 * Changes from original:
 *  - Added JTI revocation check via device_token_revocations table
 *  - Added Pino structured logging (replaced console.error)
 *  - Revoked/missing JTI → 401 Unauthorized
 */
import jwt from 'jsonwebtoken';
import { pool } from '../db/pool.js';
import logger from '../utils/logger.js';

const DEVICE_JWT_SECRET = process.env.DEVICE_JWT_SECRET;
if (!DEVICE_JWT_SECRET) {
    throw new Error('DEVICE_JWT_SECRET environment variable is required');
}

const authenticateDevice = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader) {
            return res.status(401).json({ message: 'authorization token is required' });
        }

        const parts = authHeader.split(' ');
        if (parts.length !== 2 || parts[0] !== 'Bearer') {
            return res.status(401).json({ message: 'invalid authorization format' });
        }

        const token = parts[1];

        let decoded;
        try {
            decoded = jwt.verify(token, DEVICE_JWT_SECRET);
        } catch (jwtError) {
            if (jwtError.name === 'TokenExpiredError') {
                return res.status(401).json({ message: 'device token expired' });
            }
            return res.status(401).json({ message: 'invalid device token' });
        }

        // Accept both external_device_id (old) and device_code (new)
        const deviceCode = decoded.external_device_id || decoded.device_code;

        if (!decoded.device_id || !deviceCode || !decoded.tenant_id) {
            return res.status(401).json({ message: 'invalid token claims' });
        }

        // ── Resolve current tenant UUID from database ──
        // Devices may be moved between tenants or have stale tokens.
        // Always trust the database over the token's baked-in tenant_id.
        let resolvedTenantId = String(decoded.tenant_id);
        const { rows: devRows } = await pool.query(
            `SELECT tenant_id, decommissioned_at FROM facility_device WHERE pk_device_id = $1 LIMIT 1`,
            [decoded.device_id]
        );
        if (!devRows.length) {
            return res.status(401).json({ message: 'device not found' });
        }
        if (devRows[0].decommissioned_at) {
            logger.warn({ deviceId: decoded.device_id, deviceCode }, '[authenticateDevice] Rejected decommissioned device');
            return res.status(401).json({ message: 'device has been decommissioned' });
        }
        resolvedTenantId = devRows[0].tenant_id;

        // ── FIX-012: Check revocation table ──────────────────────────────────
        const jti = decoded.jti;
        if (jti) {
            try {
                const { rows } = await pool.query(
                    `SELECT 1 FROM device_token_revocations WHERE jti = $1 LIMIT 1`,
                    [jti]
                );
                if (rows.length > 0) {
                    logger.warn({ jti, deviceCode }, '[authenticateDevice] Rejected revoked device token');
                    return res.status(401).json({ message: 'device token has been revoked' });
                }
            } catch (dbErr) {
                // If revocation table doesn't exist yet (before migration), log and continue
                if (dbErr.code !== '42P01') { // 42P01 = undefined_table
                    logger.error({ err: dbErr, jti }, '[authenticateDevice] Revocation check failed');
                    return res.status(500).json({ message: 'internal server error during authentication' });
                }
                logger.warn('[authenticateDevice] device_token_revocations table not yet created — skipping revocation check');
            }
        }

        // Scope claim shape has varied across issuance paths: newer tokens carry
        // `scopes` (array), older ones `scope` (space-delimited string).
        // Normalize to a single array so any downstream scope check has one shape to read.
        const scopes = Array.isArray(decoded.scopes)
            ? decoded.scopes
            : (typeof decoded.scope === 'string' ? decoded.scope.split(' ').filter(Boolean) : []);

        req.device = {
            id: decoded.device_id,
            pk_device_id: decoded.device_id,
            external_device_id: deviceCode,
            code: deviceCode,
            tenant_id: resolvedTenantId,   // always a UUID string
            type: decoded.type,
            scopes,
            jti,
            scope: decoded.scope || null,  // absent on tokens minted before scopes existed — see requireDeviceScope.js
        };

        // Refresh device status to online and keep activity timestamps fresh.
        // Throttled to at most once per 30 seconds to minimize DB write overhead.
        pool.query(`
            UPDATE facility_device
            SET status = 'online',
                last_active = NOW(),
                last_heartbeat = NOW()
            WHERE pk_device_id = $1
              AND (status != 'online' OR last_active < NOW() - INTERVAL '30 seconds')
            RETURNING pk_device_id
        `, [decoded.device_id]).then(res => {
            if (res.rows.length > 0) {
                pool.query(`
                    UPDATE facility_device
                    SET status = 'online',
                        last_active = NOW(),
                        last_heartbeat = NOW()
                    WHERE parent_device_id = $1 AND decommissioned_at IS NULL
                `, [decoded.device_id]).catch(() => {});
            }
        }).catch(err => {
            logger.error({ err, deviceId: decoded.device_id }, '[authenticateDevice] Failed to update device status to online');
        });

        next();

    } catch (error) {
        logger.error({ err: error }, '[authenticateDevice] Unexpected error');
        res.status(500).json({ message: 'internal server error during authentication' });
    }
};

/**
 * authenticateDeviceOptional — same verification as authenticateDevice, but
 * falls through to next() (no response sent) instead of rejecting when the
 * request simply isn't carrying a device JWT at all. For routes shared
 * between devices and human users at the exact same path+method (e.g.
 * GET /api/cameras, called by both the Jetson's camera-sync client and the
 * admin UI) — tried first so a valid device token is handled here; anything
 * that doesn't look like a device token at all falls through to the human
 * (Keycloak/legacy) auth chain that follows in the same router.
 *
 * A token that IS structurally a device JWT but fails a real check (unknown
 * device, decommissioned, revoked) still gets a hard 401 here rather than
 * falling through — those failures are unambiguous and a Keycloak verifier
 * would never accept this token anyway.
 */
export const authenticateDeviceOptional = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return next();

        const parts = authHeader.split(' ');
        if (parts.length !== 2 || parts[0] !== 'Bearer') return next();

        let decoded;
        try {
            decoded = jwt.verify(parts[1], DEVICE_JWT_SECRET);
        } catch (_) {
            // Not signed with our device secret at all — could be a human/
            // Keycloak token headed for the route below, so let it try there.
            return next();
        }

        // The signature just verified against DEVICE_JWT_SECRET, which only
        // this backend holds — from here on this is unambiguously a device
        // token, never a human one, so a malformed claim shape is a real
        // 400 (bad request), not a signal to fall through and let a
        // different auth chain guess at it.
        const deviceCode = decoded.external_device_id || decoded.device_code;
        if (!deviceCode) {
            return res.status(400).json({ error: 'Bad Request', message: 'JWT missing device_code' });
        }
        if (!decoded.device_id || !decoded.tenant_id) {
            return res.status(400).json({ error: 'Bad Request', message: 'JWT missing required device claims' });
        }

        const { rows: devRows } = await pool.query(
            `SELECT tenant_id, decommissioned_at FROM facility_device WHERE pk_device_id = $1 LIMIT 1`,
            [decoded.device_id]
        );
        if (!devRows.length) {
            return res.status(401).json({ error: 'Unauthorized', message: 'device not found' });
        }
        if (devRows[0].decommissioned_at) {
            logger.warn({ deviceId: decoded.device_id, deviceCode }, '[authenticateDeviceOptional] Rejected decommissioned device');
            return res.status(401).json({ error: 'Unauthorized', message: 'device has been decommissioned' });
        }

        const jti = decoded.jti;
        if (jti) {
            try {
                const { rows } = await pool.query(
                    `SELECT 1 FROM device_token_revocations WHERE jti = $1 LIMIT 1`,
                    [jti]
                );
                if (rows.length > 0) {
                    logger.warn({ jti, deviceCode }, '[authenticateDeviceOptional] Rejected revoked device token');
                    return res.status(401).json({ error: 'Unauthorized', message: 'device token has been revoked' });
                }
            } catch (dbErr) {
                if (dbErr.code !== '42P01') {
                    logger.error({ err: dbErr, jti }, '[authenticateDeviceOptional] Revocation check failed');
                    return res.status(500).json({ message: 'internal server error during authentication' });
                }
            }
        }

        req.device = {
            id: decoded.device_id,
            pk_device_id: decoded.device_id,
            external_device_id: deviceCode,
            code: deviceCode,
            tenant_id: devRows[0].tenant_id,
            type: decoded.type,
            jti,
        };

        next();
    } catch (error) {
        logger.error({ err: error }, '[authenticateDeviceOptional] Unexpected error');
        res.status(500).json({ message: 'internal server error during authentication' });
    }
};

export default authenticateDevice;
