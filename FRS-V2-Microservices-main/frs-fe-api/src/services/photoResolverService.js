/**
 * photoResolverService.js — resolves a bare photo filename (the only thing
 * the frontend ever sends — see authedPhoto.ts's resolvePhotoPath, which
 * strips any directory info before hitting /api/jetson/photos/:filename or
 * /api/enroll/photos/:filename) back to the actual stored location.
 *
 * Post-S3-migration, "actual stored location" means the full S3 key plus
 * which bucket it lives in — DeviceEventService/PersonService write to the
 * logs bucket, EnrollmentService writes to the user-data bucket. Pre-migration
 * rows (and any file an admin hasn't migrated yet) still hold a local disk
 * path or a fully-qualified `http(s)://.../uploads/...` URL; every S3 key
 * built by this app is a bare `{tenantId}/...` prefix with no leading slash
 * and no scheme — that's the discriminator isLegacyLocalPath() below relies on.
 */
import { pool } from '../db/pool.js';
import { LOGS_BUCKET, USER_DATA_BUCKET } from './storageService.js';

export function isLegacyLocalPath(value) {
  return typeof value === 'string' && (value.startsWith('/') || value.startsWith('uploads/') || /^https?:\/\//i.test(value));
}

/**
 * @returns {Promise<{ bucket: string, key: string } | { legacyLocalPath: string } | null>}
 */
export async function resolvePhotoByFilename(filename, tenantId = null) {
  const like = `%${filename}%`;
  const tenantClause = tenantId ? 'AND tenant_id = $2::uuid' : '';
  const tenantParams = tenantId ? [like, tenantId] : [like];

  // 1. Attendance check-in/check-out photos (logs bucket)
  {
    const { rows } = await pool.query(
      `SELECT checkin_photo_url, checkout_photo_url FROM attendance_record
       WHERE (checkin_photo_url ILIKE $1 OR checkout_photo_url ILIKE $1) ${tenantClause}
       LIMIT 1`,
      tenantParams
    );
    if (rows.length) {
      const value = rows[0].checkin_photo_url?.includes(filename)
        ? rows[0].checkin_photo_url
        : rows[0].checkout_photo_url;
      return toResult(value, LOGS_BUCKET);
    }
  }

  // 2. Per-punch device event photos (logs bucket)
  {
    const { rows } = await pool.query(
      `SELECT payload_json->>'photo_url' AS photo_url FROM device_events
       WHERE payload_json->>'photo_url' ILIKE $1 ${tenantClause}
       LIMIT 1`,
      tenantParams
    );
    if (rows.length) return toResult(rows[0].photo_url, LOGS_BUCKET);
  }

  // 3. Employee face embedding photos (user-data bucket)
  {
    const employeeTenantClause = tenantId ? 'AND e.tenant_id = $2::uuid' : '';
    const { rows } = await pool.query(
      `SELECT efe.photo_path FROM employee_face_embeddings efe
       JOIN hr_employee e ON e.pk_employee_id = efe.employee_id
       WHERE efe.photo_path ILIKE $1 ${employeeTenantClause}
       LIMIT 1`,
      tenantParams
    );
    if (rows.length) return toResult(rows[0].photo_path, USER_DATA_BUCKET);
  }

  // 4. Person (visitor/unknown) face embedding photos (user-data bucket)
  {
    const personTenantClause = tenantId ? 'AND p.tenant_id = $2::uuid' : '';
    const { rows } = await pool.query(
      `SELECT pfe.photo_path FROM person_face_embeddings pfe
       JOIN person p ON p.person_id = pfe.person_id
       WHERE pfe.photo_path ILIKE $1 ${personTenantClause}
       LIMIT 1`,
      tenantParams
    );
    if (rows.length) return toResult(rows[0].photo_path, USER_DATA_BUCKET);
  }

  // 5. Person profile photo (user-data bucket)
  {
    const { rows } = await pool.query(
      `SELECT photo_url FROM person
       WHERE photo_url ILIKE $1 ${tenantId ? 'AND tenant_id = $2::uuid' : ''}
       LIMIT 1`,
      tenantParams
    );
    if (rows.length) return toResult(rows[0].photo_url, USER_DATA_BUCKET);
  }

  // 6. Queued remote-enrollment commands (user-data bucket) — the photo hasn't
  //    landed on any entity row yet, it's still in-flight to the Jetson device
  //    (see employeeRoutes.js POST /:employeeId/enroll-remote). The command
  //    payload stores the real S3 key separately from the public photo_url
  //    the Jetson fetches, since photo_url is a full URL, not a bare key.
  {
    const { rows } = await pool.query(
      `SELECT command_payload->>'photo_key' AS photo_key FROM device_command_queue
       WHERE command_payload->>'photo_key' ILIKE $1
       LIMIT 1`,
      [like]
    );
    if (rows.length && rows[0].photo_key) return toResult(rows[0].photo_key, USER_DATA_BUCKET);
  }

  // 7. Enrollment invitation staging photos (user-data bucket) — photo_paths
  //    is a jsonb object keyed by angle, so the match has to be pulled out
  //    of the object rather than read straight off a column.
  {
    const invitationTenantClause = tenantId ? 'AND inv.mt_tenant_id = $2::uuid' : '';
    const { rows } = await pool.query(
      `SELECT inv.photo_paths FROM enrollment_invitations inv
       WHERE inv.photo_paths::text ILIKE $1 ${invitationTenantClause}
       LIMIT 1`,
      tenantParams
    );
    if (rows.length) {
      let photoPaths = rows[0].photo_paths;
      if (typeof photoPaths === 'string') {
        try { photoPaths = JSON.parse(photoPaths); } catch (_) { photoPaths = {}; }
      }
      const match = Object.values(photoPaths || {}).find(v => typeof v === 'string' && v.includes(filename));
      if (match) return toResult(match, USER_DATA_BUCKET);
    }
  }

  return null;
}

function toResult(value, bucket) {
  if (!value) return null;
  if (isLegacyLocalPath(value)) return { legacyLocalPath: value };
  return { bucket, key: value };
}
