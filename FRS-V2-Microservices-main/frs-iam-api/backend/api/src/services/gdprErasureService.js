/**
 * gdprErasureService.js — FIX-026: GDPR Art.17 right-to-erasure implementation
 *
 * Executes a full biometric data erasure for an employee:
 *   1. Delete face_embedding rows from DB
 *   2. Purge enrollment photos from disk
 *   3. Notify all active Jetson devices for this tenant to clear their SQLite cache
 *   4. Withdraw biometric consent
 *   5. Log the erasure to gdpr_erasure_requests
 *
 * Called from employeeRoutes.js DELETE /api/employees/:id/biometric-data
 */
import fs   from 'fs';
import path from 'path';
import { pool }      from '../db/pool.js';
import logger        from '../utils/logger.js';
import * as storage  from './storageService.js';
import { isLegacyLocalPath } from './photoResolverService.js';

const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');

/**
 * Purge all biometric data for an employee.
 *
 * @param {object} opts
 * @param {string}  opts.employeeId   - UUID
 * @param {string}  opts.tenantId     - UUID
 * @param {string}  [opts.requestedBy] - UUID of the user triggering erasure
 * @returns {Promise<object>} Erasure report
 */
export async function executeGdprErasure({ employeeId, tenantId, requestedBy }) {
  const report = {
    employeeId,
    startedAt:         new Date().toISOString(),
    dbRowsDeleted:     0,
    photosDeleted:     0,
    jetsonDevices:     0,
    jetsonPurgeErrors: [],
    errors:            [],
  };

  // Create erasure request record
  const { rows: reqRows } = await pool.query(
    `INSERT INTO gdpr_erasure_requests
       (fk_employee_id, tenant_id, requested_by, status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'in_progress')
     RETURNING pk_erasure_id`,
    [employeeId, tenantId, requestedBy || null]
  );
  const erasureId = reqRows[0]?.pk_erasure_id;

  try {
    // ── 1. Delete face embeddings from DB ────────────────────────────────────
    const { rowCount: embCount } = await pool.query(
      `DELETE FROM face_embedding WHERE fk_employee_id = $1`,
      [employeeId]
    );
    report.dbRowsDeleted = embCount || 0;

    await pool.query(
      `UPDATE gdpr_erasure_requests SET db_erased_at = NOW() WHERE pk_erasure_id = $1::uuid`,
      [erasureId]
    );

    // ── 2. Purge enrollment photos from disk ─────────────────────────────────
    const { rows: invRows } = await pool.query(
      `SELECT photo_paths FROM enrollment_invitations WHERE fk_employee_id = $1`,
      [employeeId]
    );

    for (const inv of invRows) {
      let photoPaths = inv.photo_paths;
      if (typeof photoPaths === 'string') {
        try { photoPaths = JSON.parse(photoPaths); } catch (_) { photoPaths = {}; }
      }
      for (const storedPath of Object.values(photoPaths || {})) {
        if (!storedPath) continue;

        if (!isLegacyLocalPath(storedPath)) {
          // Post-migration: storedPath is the real S3 key.
          try {
            await storage.deleteFile(storage.USER_DATA_BUCKET, storedPath);
            report.photosDeleted++;
          } catch (err) {
            report.errors.push(`Photo delete failed: ${storedPath} — ${err.message}`);
          }
          continue;
        }

        // Legacy pre-migration local file.
        const filename = path.basename(storedPath);
        if (!/^[\w\-]+\.(jpg|jpeg|png|webp)$/i.test(filename)) continue;

        // Check both enrollment-photos and remote-enrollment dirs
        for (const subdir of ['enrollment-photos', 'remote-enrollment']) {
          const fullPath = path.join(UPLOADS_DIR, subdir, filename);
          try {
            if (fs.existsSync(fullPath)) {
              fs.unlinkSync(fullPath);
              report.photosDeleted++;
            }
          } catch (err) {
            report.errors.push(`Photo delete failed: ${filename} — ${err.message}`);
          }
        }
      }
    }

    // Mark enrollment invitations as purged
    await pool.query(
      `UPDATE enrollment_invitations
       SET photos_purged_at = NOW(), embedding_status = 'purged'
       WHERE fk_employee_id = $1 AND photos_purged_at IS NULL`,
      [employeeId]
    );

    await pool.query(
      `UPDATE gdpr_erasure_requests SET photos_erased_at = NOW() WHERE pk_erasure_id = $1::uuid`,
      [erasureId]
    );

    // ── 3. Notify Jetson devices to purge SQLite face cache ──────────────────
    const { rows: devices } = await pool.query(
      `SELECT fd.pk_device_id, fd.external_device_id, fd.ip_address,
              COALESCE(fd.use_tls, false) AS use_tls,
              fd.device_config
       FROM facility_device fd
       WHERE fd.tenant_id = $1::uuid
         AND fd.decommissioned_at IS NULL
         AND fd.ip_address IS NOT NULL`,
      [tenantId]
    );

    for (const dev of devices) {
      try {
        const scheme = dev.use_tls ? 'https' : 'http';
        const port   = dev.device_config?.port || (dev.use_tls ? 5443 : 5000);
        const url    = `${scheme}://${dev.ip_address}:${port}/api/face/purge`;

        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ employee_id: employeeId }),
          signal:  AbortSignal.timeout(8000),
        });

        if (!resp.ok) {
          report.jetsonPurgeErrors.push({
            deviceId: dev.external_device_id,
            status:   resp.status,
          });
        } else {
          report.jetsonDevices++;
        }
      } catch (err) {
        report.jetsonPurgeErrors.push({
          deviceId: dev.external_device_id,
          error:    err.message,
        });
        logger.warn({ err, deviceId: dev.external_device_id },
          '[gdprErasure] Failed to notify Jetson device');
      }
    }

    await pool.query(
      `UPDATE gdpr_erasure_requests SET jetson_purged_at = NOW() WHERE pk_erasure_id = $1::uuid`,
      [erasureId]
    );

    // ── 4. Withdraw biometric consent ────────────────────────────────────────
    await pool.query(
      `UPDATE biometric_consent
       SET consent_given = false, withdrawn_at = NOW(),
           withdrawn_reason = 'gdpr_erasure', updated_at = NOW()
       WHERE fk_employee_id = $1 AND withdrawn_at IS NULL`,
      [employeeId]
    ).catch(err => {
      // biometric_consent table may not exist yet (pre-042 migration)
      if (err.code !== '42P01') throw err;
    });

    // ── 5. Finalize erasure record ────────────────────────────────────────────
    report.completedAt = new Date().toISOString();

    await pool.query(
      `UPDATE gdpr_erasure_requests
       SET status = 'complete', completed_at = NOW(), completion_report = $2::jsonb
       WHERE pk_erasure_id = $1::uuid`,
      [erasureId, JSON.stringify(report)]
    );

    logger.info({ employeeId, erasureId, report }, '[gdprErasure] Erasure complete');

  } catch (err) {
    report.errors.push(err.message);
    logger.error({ err, employeeId, erasureId }, '[gdprErasure] Erasure failed');

    await pool.query(
      `UPDATE gdpr_erasure_requests
       SET status = 'failed', error_message = $2, completion_report = $3::jsonb
       WHERE pk_erasure_id = $1::uuid`,
      [erasureId, err.message, JSON.stringify(report)]
    ).catch(() => {});

    throw err;
  }

  return report;
}
