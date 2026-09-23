/**
 * bulk_reenroll_adaface.mjs
 *
 * Re-enrolls all employees at jetson-box-2's sites (14 & 15) using the new
 * adaface-r100-v1 model running on jetson-box-2's sidecar at 172.18.3.214:5000.
 *
 * Flow:
 *   1. Fetch employees with completed enrollment photos (sites 14 & 15)
 *   2. POST each front-face photo as raw JPEG to jetson-box-2 sidecar /enroll-image
 *   3. Save returned 512-d embedding to employee_face_embeddings with model adaface-r100-v1
 *
 * Usage:
 *   node bulk_reenroll_adaface.mjs
 *   node bulk_reenroll_adaface.mjs --dry-run     # just list employees, don't enroll
 *   node bulk_reenroll_adaface.mjs --all-angles  # enroll all 5 angles, not just front
 */

import { pool } from './src/db/pool.js';
import { readFileSync, existsSync } from 'fs';
import http from 'http';

// All of these are specific to the one bulk re-enrollment run this script was
// written for — override via env vars rather than editing the script when
// re-running against a different device/tenant/site set.
const JETSON_HOST = process.env.REENROLL_JETSON_HOST || '172.18.3.214';
const JETSON_PORT = process.env.REENROLL_JETSON_PORT || 5000;
const MODEL_VERSION = process.env.REENROLL_MODEL_VERSION || 'adaface-r100-v1';
const TENANT_ID = process.env.REENROLL_TENANT_ID || '5aa1dbdd-d15f-4766-bdd7-6ca864cbd065';
const TARGET_SITES = (process.env.REENROLL_TARGET_SITES || '14,15').split(',').map(Number);
const DRY_RUN = process.argv.includes('--dry-run');
const ALL_ANGLES = process.argv.includes('--all-angles');
const ANGLE_ORDER = ALL_ANGLES
  ? ['front', 'up', 'down', 'left', 'right']
  : ['front'];

const DELAY_MS = 500; // delay between sidecar calls

// ─── Send raw JPEG to Jetson /enroll-image → returns { embedding, confidence } ─
async function getEmbeddingFromJetson(jpegBuffer) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: JETSON_HOST,
      port: JETSON_PORT,
      path: '/enroll-image',
      method: 'POST',
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': jpegBuffer.length,
      },
      timeout: 20000,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON from sidecar: ${data.slice(0, 100)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Sidecar timeout')); });
    req.write(jpegBuffer);
    req.end();
  });
}

// ─── Save embedding directly to DB ──────────────────────────────────────────
async function saveEmbedding(client, employeeId, embedding, confidence, angle) {
  const vectorStr = `[${embedding.join(',')}]`;

  // Check for duplicate across other employees (not self)
  const { rows: dupes } = await client.query(
    `SELECT ef.employee_id, e.full_name,
            1 - (ef.embedding <=> $1::vector) AS similarity
     FROM employee_face_embeddings ef
     JOIN hr_employee e ON e.pk_employee_id = ef.employee_id
     WHERE 1 - (ef.embedding <=> $1::vector) >= 0.50
       AND ef.employee_id != $2
       AND ef.model_version = $3
     ORDER BY ef.embedding <=> $1::vector ASC
     LIMIT 1`,
    [vectorStr, employeeId, MODEL_VERSION]
  );
  if (dupes.length > 0) {
    return { ok: false, reason: `Duplicate: matches ${dupes[0].full_name} (sim=${dupes[0].similarity.toFixed(3)})` };
  }

  // Keep max 8 per employee per model — delete oldest if over limit
  const { rows: existing } = await client.query(
    `SELECT id FROM employee_face_embeddings
     WHERE employee_id = $1 AND model_version = $2
     ORDER BY enrolled_at ASC`,
    [employeeId, MODEL_VERSION]
  );
  if (existing.length >= 8) {
    await client.query(`DELETE FROM employee_face_embeddings WHERE id = $1`, [existing[0].id]);
  }

  const shouldBePrimary = angle === 'front' && confidence > 0.65;
  if (shouldBePrimary) {
    await client.query(
      `UPDATE employee_face_embeddings SET is_primary = FALSE
       WHERE employee_id = $1 AND model_version = $2`,
      [employeeId, MODEL_VERSION]
    );
  }

  await client.query(
    `INSERT INTO employee_face_embeddings
       (employee_id, embedding, quality_score, is_primary, model_version, angle)
     VALUES ($1, $2::vector, $3, $4, $5, $6)`,
    [employeeId, vectorStr, confidence || null, shouldBePrimary, MODEL_VERSION, angle]
  );

  return { ok: true };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Bulk Re-enrollment → adaface-r100-v1`);
  console.log(`  Jetson: ${JETSON_HOST}:${JETSON_PORT}`);
  console.log(`  Sites:  ${TARGET_SITES.join(', ')}`);
  console.log(`  Angles: ${ANGLE_ORDER.join(', ')}`);
  if (DRY_RUN) console.log(`  Mode:   DRY RUN (no DB writes)`);
  console.log(`${'═'.repeat(60)}\n`);

  // Step 1: Check sidecar reachability
  if (!DRY_RUN) {
    console.log('Checking Jetson sidecar connectivity...');
    try {
      const testBuf = readFileSync(
        new URL('./uploads/remote-enrollment', import.meta.url)
          .pathname
          .replace('remote-enrollment', ''), // just check dir exists
      );
    } catch {}
    // Simple TCP check
    await new Promise((resolve, reject) => {
      const conn = http.request({ hostname: JETSON_HOST, port: JETSON_PORT, path: '/health', method: 'GET', timeout: 5000 }, r => {
        console.log(`  ✅ Sidecar reachable (HTTP ${r.statusCode})\n`);
        resolve();
      });
      conn.on('error', (e) => {
        console.error(`  ❌ Sidecar unreachable: ${e.message}`);
        console.error(`  Make sure frs-runner is running on ${JETSON_HOST}:${JETSON_PORT}`);
        reject(e);
      });
      conn.on('timeout', () => { conn.destroy(); reject(new Error('Timeout')); });
      conn.end();
    }).catch(() => process.exit(1));
  }

  // Step 2: Fetch all employees with completed photos for target sites
  const { rows: invitations } = await pool.query(`
    SELECT DISTINCT ON (ei.fk_employee_id)
      ei.pk_invitation_id    AS invitation_id,
      ei.fk_employee_id      AS employee_id,
      e.full_name,
      e.site_ids[1] AS site_id,
      ei.photo_paths
    FROM enrollment_invitations ei
    JOIN hr_employee e ON e.pk_employee_id = ei.fk_employee_id
    WHERE e.tenant_id = $1::uuid
      AND (e.site_ids && $2::bigint[])
      AND e.status = 'active'
      AND ei.status = 'completed'
      AND ei.photo_paths IS NOT NULL
      AND ei.photos_purged_at IS NULL
    ORDER BY ei.fk_employee_id, ei.completed_at DESC
  `, [TENANT_ID, TARGET_SITES]);

  console.log(`Found ${invitations.length} employees with enrollment photos.\n`);

  if (DRY_RUN) {
    for (const inv of invitations) {
      const paths = typeof inv.photo_paths === 'string' ? JSON.parse(inv.photo_paths) : inv.photo_paths;
      const available = ANGLE_ORDER.filter(a => paths[a] && existsSync(paths[a]));
      console.log(`  [${inv.site_id}] ${inv.full_name} (id=${inv.employee_id}) — photos: ${available.join(', ') || 'NONE'}`);
    }
    console.log('\nDry run complete. Run without --dry-run to execute.');
    await pool.end();
    return;
  }

  // Step 3: Process each employee
  const client = await pool.connect();
  let enrolled = 0, skipped = 0, failed = 0;

  for (const inv of invitations) {
    const paths = typeof inv.photo_paths === 'string' ? JSON.parse(inv.photo_paths) : inv.photo_paths;
    console.log(`\n  ${inv.full_name} (id=${inv.employee_id}, site=${inv.site_id})`);

    let employeeEnrolled = 0;

    for (const angle of ANGLE_ORDER) {
      const photoPath = paths[angle];
      if (!photoPath || !existsSync(photoPath)) {
        console.log(`    [${angle}] ⏭️  No photo on disk`);
        continue;
      }

      process.stdout.write(`    [${angle}] Sending to Jetson... `);

      let jpegBuffer;
      try {
        jpegBuffer = readFileSync(photoPath);
      } catch (e) {
        console.log(`❌ Cannot read file: ${e.message}`);
        failed++;
        continue;
      }

      let sidecarResult;
      try {
        sidecarResult = await getEmbeddingFromJetson(jpegBuffer);
      } catch (e) {
        console.log(`❌ Sidecar error: ${e.message}`);
        if (e.message.includes('ECONNREFUSED') || e.message.includes('timeout')) {
          console.error('\n  Sidecar is unreachable. Stopping.');
          process.exit(1);
        }
        failed++;
        await new Promise(r => setTimeout(r, DELAY_MS));
        continue;
      }

      if (!Array.isArray(sidecarResult?.embedding) || sidecarResult.embedding.length !== 512) {
        const err = sidecarResult?.error || 'No 512-d embedding returned';
        console.log(`❌ ${err}`);
        failed++;
        await new Promise(r => setTimeout(r, DELAY_MS));
        continue;
      }

      try {
        await client.query('BEGIN');
        const saveResult = await saveEmbedding(
          client,
          inv.employee_id,
          sidecarResult.embedding,
          sidecarResult.confidence,
          angle
        );
        if (!saveResult.ok) {
          await client.query('ROLLBACK');
          console.log(`⏭️  ${saveResult.reason}`);
          skipped++;
        } else {
          await client.query('COMMIT');
          console.log(`✅  confidence=${sidecarResult.confidence?.toFixed(3) ?? 'n/a'}`);
          employeeEnrolled++;
          enrolled++;
        }
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.log(`❌ DB error: ${e.message}`);
        failed++;
      }

      await new Promise(r => setTimeout(r, DELAY_MS));
    }

    if (employeeEnrolled === 0) {
      console.log(`    → No new embeddings added for this employee`);
    }
  }

  client.release();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Results`);
  console.log(`  ✅ Embeddings enrolled : ${enrolled}`);
  console.log(`  ⏭️  Skipped (duplicate) : ${skipped}`);
  console.log(`  ❌ Failed              : ${failed}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`\nJetson-box-2 will sync embeddings via GET /api/face/sync/embeddings`);
  console.log(`(model filter: adaface-r100-v1 — ensure device_config is updated)\n`);

  await pool.end();
}

main().catch(e => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
