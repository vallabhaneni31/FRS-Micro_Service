/**
 * photoPurgeCron.js — FIX-022: Auto-purge enrollment photos after embedding creation
 *
 * DISABLED as of the S3 storage migration: enrollment photos now live in the
 * permanent S3 user-data bucket by design, and are kept indefinitely rather
 * than purged after embedding creation (product decision — this bucket is
 * explicitly the "permanent data" store, unlike the old local-disk copy this
 * cron was written to clean up). purgeCompletedEnrollmentPhotos() below is a
 * no-op kept only so the exported shape doesn't change; startPhotoPurgeCron()
 * is no longer called from server.js.
 *
 * Original behavior (pre-migration, local disk only), preserved in case this
 * needs to be re-enabled for legacy on-disk files:
 * Once a face embedding is successfully created from an enrollment invitation's
 * photos, the raw photos are no longer needed and must be deleted for:
 *   - GDPR Art.5(1)(e) — data minimisation / storage limitation
 *   - Reducing the blast radius of a file-system compromise
 *
 * Schedule: runs every PHOTO_PURGE_INTERVAL_MINUTES (default: 60) minutes.
 *
 * Safety: only purges invitations where:
 *   1. embedding_status = 'complete'
 *   2. photos_purged_at IS NULL
 *   3. The invitation was approved at least PHOTO_PURGE_DELAY_HOURS ago (default 24h)
 *      — gives staff time to review before photos are gone.
 */
import fs   from 'fs';
import path from 'path';
import { pool } from '../db/pool.js';
import logger from '../utils/logger.js';

const UPLOADS_DIR           = path.resolve(process.cwd(), 'uploads', 'enrollment-photos');
const PURGE_DELAY_HOURS     = Number(process.env.PHOTO_PURGE_DELAY_HOURS     || 24);
const PURGE_INTERVAL_MINUTES = Number(process.env.PHOTO_PURGE_INTERVAL_MINUTES || 60);

/**
 * Delete a single file, returning true on success, false if file not found,
 * throwing on other errors.
 */
function safeDelete(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false; // already gone
    throw err;
  }
}

/**
 * Purge enrollment photos for all invitations that have completed embeddings
 * and have waited the configured delay period.
 *
 * @returns {{ purged: number, skipped: number, errors: number }}
 */
export async function purgeCompletedEnrollmentPhotos() {
  logger.info('[photoPurgeCron] Disabled — enrollment photos are kept indefinitely in the permanent S3 user-data bucket');
  return { purged: 0, skipped: 0, errors: 0 };
}

// eslint-disable-next-line no-unused-vars
async function _legacyPurgeCompletedEnrollmentPhotos() {
  let purged = 0, skipped = 0, errors = 0;

  const { rows } = await pool.query(
    `SELECT pk_invitation_id, photo_paths, fk_employee_id
     FROM enrollment_invitations
     WHERE embedding_status = 'complete'
       AND photos_purged_at IS NULL
       AND approved_at <= NOW() - $1::interval
     ORDER BY approved_at
     LIMIT 100`,
    [`${PURGE_DELAY_HOURS} hours`]
  );

  if (!rows.length) {
    logger.info('[photoPurgeCron] No photos to purge this cycle');
    return { purged: 0, skipped: 0, errors: 0 };
  }

  for (const inv of rows) {
    try {
      let photoPaths = inv.photo_paths;
      if (typeof photoPaths === 'string') {
        try { photoPaths = JSON.parse(photoPaths); } catch (_) { photoPaths = {}; }
      }

      let deletedCount = 0;
      const angles     = Object.values(photoPaths || {});

      for (const relPath of angles) {
        if (!relPath) continue;
        // Sanitise path — only allow basename inside enrollment-photos dir
        const filename = path.basename(relPath);
        if (!/^[\w\-]+\.(jpg|jpeg|png|webp)$/i.test(filename)) {
          logger.warn({ filename, invitationId: inv.pk_invitation_id },
            '[photoPurgeCron] Skipping suspicious filename');
          continue;
        }

        const fullPath = path.join(UPLOADS_DIR, filename);
        const deleted  = safeDelete(fullPath);
        if (deleted) deletedCount++;
      }

      // Mark as purged in DB regardless of whether files existed
      // (they may have been cleaned up manually already)
      await pool.query(
        `UPDATE enrollment_invitations
         SET photos_purged_at = NOW(), embedding_status = 'purged'
         WHERE pk_invitation_id = $1`,
        [inv.pk_invitation_id]
      );

      logger.info({
        invitationId: inv.pk_invitation_id,
        employeeId:   inv.fk_employee_id,
        deletedFiles: deletedCount,
        totalAngles:  angles.length,
      }, '[photoPurgeCron] Purged enrollment photos');

      purged++;
    } catch (err) {
      logger.error({ err, invitationId: inv.pk_invitation_id },
        '[photoPurgeCron] Error purging photos');
      errors++;
    }
  }

  logger.info({ purged, skipped, errors }, '[photoPurgeCron] Cycle complete');
  return { purged, skipped, errors };
}

/**
 * Start the photo purge cron job.
 * Call once from server.js startup after DB/WS are ready.
 */
export function startPhotoPurgeCron() {
  logger.info(
    { intervalMinutes: PURGE_INTERVAL_MINUTES, delayHours: PURGE_DELAY_HOURS },
    '[photoPurgeCron] Starting photo purge cron'
  );

  // Run immediately on startup, then on interval
  purgeCompletedEnrollmentPhotos().catch(err =>
    logger.error({ err }, '[photoPurgeCron] Initial run failed')
  );

  return setInterval(() => {
    purgeCompletedEnrollmentPhotos().catch(err =>
      logger.error({ err }, '[photoPurgeCron] Interval run failed')
    );
  }, PURGE_INTERVAL_MINUTES * 60 * 1000);
}
