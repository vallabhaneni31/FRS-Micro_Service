/**
 * photoAccess.js — shared tenant-ownership check for serving stored photos
 * (attendance snapshots / enrollment photos). Extracted from the pattern
 * already hardened in routes/jetsonRoutes.js's GET /photos/:filename, so
 * every place that serves these files enforces the same bar instead of
 * handing biometric photos to anyone who knows/guesses a filename.
 *
 * `tenantOwnsPhoto` is the reusable check (used directly by routes with
 * their own file-resolution logic, e.g. attendanceRoutes.js); `verifyPhotoAccess`
 * is a ready-to-mount middleware wrapper around it (used by the generic
 * /uploads static mount in server.js). Both must run after requireAuth +
 * validateScopeAccess (need req.auth.scope).
 */
import path from 'path';
import { pool } from '../db/pool.js';

export async function tenantOwnsPhoto(tenantId, filename) {
  if (!tenantId) return false;

  const { rows } = await pool.query(
    `SELECT 1 FROM attendance_record
     WHERE (checkin_photo_url ILIKE $1 OR checkout_photo_url ILIKE $1)
       AND tenant_id = $2::uuid LIMIT 1`,
    [`%${filename}%`, tenantId]
  );
  if (rows.length) return true;

  const { rows: faceRows } = await pool.query(
    `SELECT 1 FROM employee_face_embeddings efe
     JOIN hr_employee e ON e.pk_employee_id = efe.employee_id
     WHERE e.tenant_id = $1::uuid
       AND efe.photo_path ILIKE $2
     LIMIT 1`,
    [tenantId, `%${filename}%`]
  );
  if (faceRows.length) return true;

  const { rows: enrollRows } = await pool.query(
    `SELECT 1 FROM enrollment_invitations inv
     JOIN hr_employee e ON e.pk_employee_id = inv.fk_employee_id
     WHERE e.tenant_id = $1::uuid
       AND inv.photo_paths::text ILIKE $2
     LIMIT 1`,
    [tenantId, `%${filename}%`]
  );
  if (enrollRows.length) return true;

  // Per-punch photos (the individual check-in/check-out entries shown in
  // PunchDetailsModal / EmployeeHistoryDrawer's "all_check_ins"/"all_check_outs")
  // come from device_events.payload_json->>'photo_url', not attendance_record —
  // AttendanceService builds those arrays straight from this table. Missing
  // this check here caused legitimately-owned punch photos to 404.
  const { rows: eventRows } = await pool.query(
    `SELECT 1 FROM device_events
     WHERE tenant_id = $1::uuid
       AND payload_json->>'photo_url' ILIKE $2
     LIMIT 1`,
    [tenantId, `%${filename}%`]
  );
  return eventRows.length > 0;
}

export async function verifyPhotoAccess(req, res, next) {
  const filename = path.basename(req.path);

  if (!/^[\w-]+\.(jpg|jpeg|png|gif|webp)$/i.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const tenantId = req.auth?.scope?.tenantId;
  if (!tenantId) {
    // No tenant scope resolved for this caller — deny rather than serve
    // globally, mirroring jetsonRoutes.js's behavior for scoped callers.
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const owned = await tenantOwnsPhoto(tenantId, filename);
    if (!owned) {
      res.set('Cache-Control', 'no-store');
      return res.status(404).json({ error: 'Photo not found' });
    }

    // Cache-Control is intentionally NOT set here — ownership is confirmed,
    // but whether the file actually resolves (local disk vs S3 vs neither)
    // is still unknown at this point. Setting a long max-age here would
    // cache a downstream 404 (e.g. photo not yet uploaded) for an hour,
    // masking the photo once it actually lands. The success/404 branches
    // downstream (express.static's own maxAge, and the S3-fallback handler
    // in server.js) set it themselves once the outcome is known.
    res.set('X-Content-Type-Options', 'nosniff');
    return next();
  } catch (err) {
    return res.status(500).json({ error: 'Photo access check failed' });
  }
}
