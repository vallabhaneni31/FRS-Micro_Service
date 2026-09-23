import jwt from 'jsonwebtoken';
import { pool } from '../db/pool.js';

/**
 * Verifies device JWT (HS256, per-device secret stored in edge_devices.device_secret).
 * Attaches req.device = { id, store_id, external_id }
 */
export async function authenticateDevice(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_device_token' });
  }
  const token = auth.slice(7);

  try {
    // Decode header to get device id from sub without verifying yet
    const decoded = jwt.decode(token);
    if (!decoded?.sub) return res.status(401).json({ error: 'invalid_device_token' });

    const { rows } = await pool.query(
      `SELECT id, store_id, external_id, device_secret, status
       FROM edge_devices WHERE id = $1 LIMIT 1`,
      [decoded.sub]
    );

    if (!rows.length) return res.status(401).json({ error: 'device_not_found' });

    const device = rows[0];

    // Verify signature using the per-device secret
    jwt.verify(token, device.device_secret);

    req.device = {
      id: device.id,
      store_id: device.store_id,
      external_id: device.external_id,
    };

    // Update last_heartbeat + status non-fatally
    pool.query(
      `UPDATE edge_devices SET last_heartbeat = NOW(), status = 'online' WHERE id = $1`,
      [device.id]
    ).catch(() => {});

    return next();
  } catch (err) {
    return res.status(401).json({ error: 'device_auth_failed', detail: err.message });
  }
}
