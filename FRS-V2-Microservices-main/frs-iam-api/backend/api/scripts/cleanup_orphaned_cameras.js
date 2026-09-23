/**
 * cleanup_orphaned_cameras.js
 *
 * Removes cameras from frs_camera that were partially registered
 * (i.e. the frs_camera insert succeeded but the facility_device sync failed),
 * leaving them as orphans with no matching facility_device row.
 *
 * Usage: node scripts/cleanup_orphaned_cameras.js
 */
import { pool } from '../src/db/pool.js';
import logger from '../src/utils/logger.js';

async function main() {
  logger.info('Scanning for orphaned cameras (frs_camera rows with no facility_device match)...');

  const orphans = await pool.query(`
    SELECT c.pk_camera_id, c.name, c.cam_id
    FROM frs_camera c
    LEFT JOIN facility_device fd ON fd.external_device_id = c.cam_id
    WHERE fd.pk_device_id IS NULL
  `);

  if (orphans.rows.length === 0) {
    logger.info('✅ No orphaned cameras found. Database is clean.');
    process.exit(0);
  }

  logger.warn(`Found ${orphans.rows.length} orphaned camera(s):`);
  for (const row of orphans.rows) {
    logger.warn(`  - pk_camera_id=${row.pk_camera_id}  name="${row.name}"  cam_id="${row.cam_id}"`);
  }

  const deleteIds = orphans.rows.map(r => r.pk_camera_id);
  const result = await pool.query(
    `DELETE FROM frs_camera WHERE pk_camera_id = ANY($1::int[])`,
    [deleteIds]
  );

  logger.info(`✅ Deleted ${result.rowCount} orphaned camera record(s).`);
  process.exit(0);
}

main().catch(err => {
  logger.error('Cleanup failed:', err);
  process.exit(1);
});
