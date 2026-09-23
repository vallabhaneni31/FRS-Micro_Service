import { pool } from '../db/pool.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Devices send a human-readable camera slug (e.g. "cam-360-entrance"), not the
// internal cameras.id UUID — resolve it against cameras.external_id, scoped to
// the device's own store. Never throws: an unresolvable/missing camera_id must
// not fail the caller's request.
export async function resolveCameraId(rawCameraId, storeId) {
  if (!rawCameraId) return null;
  if (UUID_RE.test(rawCameraId)) return rawCameraId;

  const { rows } = await pool.query(
    `SELECT id FROM cameras WHERE store_id = $1 AND external_id = $2 LIMIT 1`,
    [storeId, rawCameraId]
  );
  return rows[0]?.id ?? null;
}
