#!/usr/bin/env node
/**
 * reenroll_jetson_embeddings.js
 *
 * Re-generates face embeddings for all employees whose enrollment photos are
 * still on disk by sending each photo through the Jetson's /enroll-image
 * endpoint and replacing the stored vectors in Postgres.
 *
 * Background: TRT engine recompilation (arcface-r50-fp16 → arcface-r50-gpu-fp16)
 * produces numerically different vector spaces. All stored embeddings must be
 * regenerated through the new engine so query vectors and stored vectors live
 * in the same space.
 *
 * ── Two modes ────────────────────────────────────────────────────────────────
 *
 * DIRECT mode  (run from a machine that can reach the Jetson):
 *   The script POSTs each photo to /enroll-image, receives the 512-d vector,
 *   and writes it to Postgres directly. Gives immediate, observable results.
 *
 *   JETSON_URL=http://182.76.136.42:5003 node scripts/reenroll_jetson_embeddings.js
 *
 * QUEUE mode  (run from AWS — Jetson not directly reachable):
 *   The script inserts `enroll_from_photo` commands into device_command_queue.
 *   The Jetson polls the queue every ~30 s, processes each command using
 *   arcface-r50-gpu-fp16.engine, and posts the resulting embedding back to the
 *   backend. Old embeddings are deleted first so no mixed-model vectors remain.
 *
 *   QUEUE_MODE=1 node scripts/reenroll_jetson_embeddings.js
 *
 * ── Env vars ─────────────────────────────────────────────────────────────────
 *   JETSON_URL        — Jetson base URL (required for direct mode)
 *   QUEUE_MODE        — set to 1 to use command-queue path instead
 *   DRY_RUN           — print plan; no DB writes, no Jetson calls
 *   NEW_MODEL         — model_version tag (default: arcface-r50-gpu-fp16)
 *   PUBLIC_BASE_URL   — public URL prefix for photo URLs in queue mode
 *                       (default: https://frs.motivitylabs.com)
 *   DB_HOST           — postgres host     (default: localhost)
 *   DB_USER           — postgres user     (default: postgres)
 *   DB_PASS           — postgres password (default: postgres123)
 *   DB_NAME           — postgres database (default: attendance_intelligence)
 */

import fs   from 'fs';
import path from 'path';
import pg   from 'pg';
import FormData from 'form-data';

// ── Config ───────────────────────────────────────────────────────────────────
const JETSON_URL     = process.env.JETSON_URL;
const QUEUE_MODE     = Boolean(process.env.QUEUE_MODE);
const DRY_RUN        = Boolean(process.env.DRY_RUN);
const SKIP_DELETE    = Boolean(process.env.SKIP_DELETE);  // keep existing embeddings until new ones land
const NEW_MODEL      = process.env.NEW_MODEL || 'arcface-r50-gpu-fp16';
const PUBLIC_BASE    = process.env.PUBLIC_BASE_URL || 'https://frs.motivitylabs.com';
const TIMEOUT_MS     = 15_000;

if (!QUEUE_MODE && !JETSON_URL && !DRY_RUN) {
  console.error('ERROR: Set JETSON_URL for direct mode or QUEUE_MODE=1 for queue mode.');
  console.error('  Direct: JETSON_URL=http://192.168.x.x:5003 node scripts/reenroll_jetson_embeddings.js');
  console.error('  Queue:  QUEUE_MODE=1 node scripts/reenroll_jetson_embeddings.js');
  process.exit(1);
}

const pool = new pg.Pool({
  host:     process.env.DB_HOST || 'localhost',
  user:     process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || 'postgres123',
  database: process.env.DB_NAME || 'attendance_intelligence',
  port:     5432,
});

// ── Helpers ──────────────────────────────────────────────────────────────────
const sep = (c = '─', n = 62) => c.repeat(n);

async function postToJetson(photoPath, angle) {
  const imgBuf = fs.readFileSync(photoPath);
  const form   = new FormData();
  form.append('image', imgBuf, { filename: `${angle}.jpg`, contentType: 'image/jpeg' });

  const resp = await fetch(`${JETSON_URL}/enroll-image`, {
    method:  'POST',
    body:    form,
    headers: form.getHeaders(),
    signal:  AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json().catch(() => ({}));
  if (!data?.embedding || data.embedding.length !== 512) {
    throw new Error(`Bad embedding: ${data?.embedding?.length ?? 0} dims. ${data?.error ?? ''}`);
  }
  return data;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const mode = DRY_RUN ? 'DRY RUN' : QUEUE_MODE ? 'QUEUE' : 'DIRECT';

  console.log(sep('═'));
  console.log('  Jetson Re-enrollment Script');
  console.log(`  Mode       : ${mode}`);
  if (!QUEUE_MODE) console.log(`  Jetson URL : ${JETSON_URL ?? '(not used in queue/dry mode)'}`);
  console.log(`  New model  : ${NEW_MODEL}`);
  if (SKIP_DELETE) console.log(`  Skip delete: YES — old embeddings preserved until new ones confirmed`);
  if (QUEUE_MODE) console.log(`  Photo URL  : ${PUBLIC_BASE}/uploads/remote-enrollment/<filename>`);
  console.log(sep('═'));

  // Current DB state snapshot
  const { rows: [state] } = await pool.query(`
    SELECT
      COUNT(*)                                        AS total,
      COUNT(*) FILTER (WHERE model_version = 'arcface-r50-fp16') AS old_count,
      COUNT(*) FILTER (WHERE model_version = $1)     AS new_count
    FROM employee_face_embeddings
  `, [NEW_MODEL]);

  console.log(`\nCurrent embeddings in DB:`);
  console.log(`  Total                    : ${state.total}`);
  console.log(`  arcface-r50-fp16 (old)   : ${state.old_count}  ← to be replaced`);
  console.log(`  ${NEW_MODEL.padEnd(25)}: ${state.new_count}`);

  // Invitations with photos still on disk
  const { rows: invitations } = await pool.query(`
    SELECT
      ei.pk_invitation_id,
      ei.fk_employee_id,
      ei.photo_paths,
      ei.quality_scores,
      ei.mt_tenant_id,
      e.full_name,
      e.employee_code
    FROM enrollment_invitations ei
    JOIN hr_employee e ON e.pk_employee_id = ei.fk_employee_id
    WHERE ei.photos_purged_at IS NULL
      AND ei.photo_paths IS NOT NULL
      AND ei.photo_paths::text != '{}'
    ORDER BY ei.fk_employee_id
  `);

  if (invitations.length === 0) {
    console.log('\n⚠️  No invitations with intact photos found. Cannot re-enroll.');
    console.log('   If photos were purged (photos_purged_at IS NOT NULL), physical re-enrollment');
    console.log('   at the kiosk is required.');
    await pool.end();
    return;
  }

  console.log(`\nFound ${invitations.length} invitation(s) with photos on disk.\n`);

  let okCount = 0, failCount = 0, skipCount = 0;

  for (const inv of invitations) {
    const { pk_invitation_id, fk_employee_id, full_name, employee_code, mt_tenant_id } = inv;

    let photoPaths = inv.photo_paths;
    if (typeof photoPaths === 'string') {
      try { photoPaths = JSON.parse(photoPaths); } catch { photoPaths = {}; }
    }
    const qualityScores = inv.quality_scores || {};
    const angles = Object.entries(photoPaths || {});

    console.log(sep());
    console.log(`[${employee_code ?? fk_employee_id}] ${full_name}  (id=${fk_employee_id}, inv=${pk_invitation_id})`);

    if (angles.length === 0) {
      console.log('  ⚠️  photo_paths is empty — skipping');
      skipCount++;
      continue;
    }

    // ── QUEUE MODE ──────────────────────────────────────────────────────────
    if (QUEUE_MODE) {
      if (DRY_RUN) {
        console.log(`  [DRY RUN] Would delete all existing embeddings for employee ${fk_employee_id}`);
        for (const [angle, photoPath] of angles) {
          const filename = path.basename(photoPath);
          console.log(`  [DRY RUN] Would queue enroll_from_photo: angle=${angle} → ${PUBLIC_BASE}/uploads/remote-enrollment/${filename}`);
        }
        okCount++;
        continue;
      }

      // Get the active Jetson device for this tenant
      const { rows: devRows } = await pool.query(`
        SELECT fd.pk_device_id
        FROM facility_device fd
        LEFT JOIN device_type dt ON dt.pk_device_type_id = fd.device_type_id
        WHERE fd.tenant_id = $1::uuid
          AND dt.category = 'edge_node'
          AND fd.status != 'decommissioned'
        ORDER BY fd.last_heartbeat DESC NULLS LAST LIMIT 1
      `, [mt_tenant_id]);

      if (!devRows.length) {
        console.error(`  ❌  No active Jetson device for tenant ${mt_tenant_id} — skipping`);
        failCount++;
        continue;
      }
      const deviceId = devRows[0].pk_device_id;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Delete old embeddings unless caller wants to preserve them until new ones land
        let deleted = 0;
        if (!SKIP_DELETE) {
          ({ rowCount: deleted } = await client.query(
            'DELETE FROM employee_face_embeddings WHERE employee_id = $1',
            [fk_employee_id]
          ));
          console.log(`  🗑   Deleted ${deleted} old embedding(s)`);
        } else {
          console.log(`  ⏭   SKIP_DELETE — keeping existing embeddings until new ones confirmed`);
        }

        // Clear any stale enroll_from_photo commands for this employee
        await client.query(
          `DELETE FROM device_command_queue
           WHERE device_id = $1
             AND command_type = 'enroll_from_photo'
             AND (command_payload->>'employee_id')::text = $2::text`,
          [deviceId, String(fk_employee_id)]
        );

        // Queue one command per angle
        for (const [angle, photoPath] of angles) {
          const filename = path.basename(photoPath);
          const photoUrl = `${PUBLIC_BASE}/uploads/remote-enrollment/${filename}`;

          await client.query(
            `INSERT INTO device_command_queue
               (device_id, command_type, command_payload, priority, expires_at)
             VALUES ($1, 'enroll_from_photo', $2::jsonb, 8, NOW() + INTERVAL '2 hours')`,
            [deviceId, JSON.stringify({
              employee_id:   fk_employee_id,
              employee_code: employee_code,
              full_name:     full_name,
              photo_url:     photoUrl,
              angle:         angle,
              model_version: NEW_MODEL,
              requested_by:  'reenroll_script',
            })]
          );
          console.log(`  📋  Queued angle=${angle} → ${photoUrl}`);
        }

        await client.query('COMMIT');
        console.log(`  ✅  ${angles.length} command(s) queued for device ${deviceId}`);
        okCount++;
      } catch (dbErr) {
        await client.query('ROLLBACK');
        console.error(`  ❌  DB error: ${dbErr.message}`);
        failCount++;
      } finally {
        client.release();
      }
      continue;
    }

    // ── DIRECT MODE ─────────────────────────────────────────────────────────
    if (DRY_RUN) {
      for (const [angle, photoPath] of angles) {
        const exists = fs.existsSync(photoPath);
        console.log(`  [DRY RUN] ${angle}: ${exists ? '✅ file found' : '❌ file MISSING'} → ${photoPath}`);
      }
      console.log(`  [DRY RUN] Would replace existing embeddings with ${angles.length} new row(s) tagged '${NEW_MODEL}'`);
      okCount++;
      continue;
    }

    const newEmbeddings = [];

    for (const [angle, photoPath] of angles) {
      if (!fs.existsSync(photoPath)) {
        console.warn(`  ⚠️  ${angle}: file not found → ${photoPath}`);
        continue;
      }
      try {
        const data    = await postToJetson(photoPath, angle);
        const quality = qualityScores[angle] ?? data.quality_score ?? null;
        newEmbeddings.push({ angle, embedding: data.embedding, quality, photoPath });
        console.log(`  ✅  ${angle}: 512-d vector  quality=${quality != null ? Number(quality).toFixed(3) : '—'}`);
      } catch (err) {
        console.warn(`  ❌  ${angle}: ${err.message}`);
      }
    }

    if (newEmbeddings.length === 0) {
      console.error('  ❌  No embeddings returned from Jetson — skipping DB write');
      failCount++;
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let deleted = 0;
      if (!SKIP_DELETE) {
        ({ rowCount: deleted } = await client.query(
          'DELETE FROM employee_face_embeddings WHERE employee_id = $1',
          [fk_employee_id]
        ));
        console.log(`  🗑   Deleted ${deleted} old embedding(s)`);
      } else {
        console.log(`  ⏭   SKIP_DELETE — keeping existing embeddings`);
      }

      for (const emb of newEmbeddings) {
        const embStr = `[${emb.embedding.join(',')}]`;
        await client.query(
          `INSERT INTO employee_face_embeddings
             (employee_id, embedding, angle, quality_score, is_primary,
              model_version, photo_path, enrolled_at)
           VALUES ($1, $2::vector, $3, $4, $5, $6, $7, NOW())`,
          [fk_employee_id, embStr, emb.angle, emb.quality,
           emb.angle === 'front', NEW_MODEL, emb.photoPath]
        );
      }

      await client.query('COMMIT');
      console.log(`  ✅  Inserted ${newEmbeddings.length} embedding(s) tagged '${NEW_MODEL}'`);
      okCount++;
    } catch (dbErr) {
      await client.query('ROLLBACK');
      console.error(`  ❌  DB error: ${dbErr.message}`);
      failCount++;
    } finally {
      client.release();
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${sep('═')}`);
  console.log('  Summary');
  console.log(`  ✅  OK      : ${okCount}`);
  console.log(`  ❌  Failed  : ${failCount}`);
  console.log(`  ⏭   Skipped : ${skipCount}`);
  console.log(sep('═'));

  if (!DRY_RUN && !QUEUE_MODE && okCount > 0) {
    const { rows: [after] } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE model_version = 'arcface-r50-fp16') AS old_remaining,
        COUNT(*) FILTER (WHERE model_version = $1)                 AS new_count
      FROM employee_face_embeddings
    `, [NEW_MODEL]);

    console.log(`\nPost-run DB state:`);
    console.log(`  arcface-r50-fp16 remaining : ${after.old_remaining}  ${Number(after.old_remaining) > 0 ? '⚠️  MIXED INDEX' : '✅ clean'}`);
    console.log(`  ${NEW_MODEL.padEnd(27)}: ${after.new_count}`);

    if (Number(after.old_remaining) > 0) {
      console.warn('\n⚠️  WARNING: Old-model embeddings still exist. Mixed vectors will degrade');
      console.warn('   recognition. Re-run for any employees that failed above.');
    } else {
      console.log('\nJetson sync in ~60 s. Watch for: [WatchlistSync] ✅ Index reloaded');
    }
  }

  if (QUEUE_MODE && !DRY_RUN && okCount > 0) {
    console.log(`\nCommands are in device_command_queue. Jetson polls every ~30 s.`);
    console.log(`Old embeddings for ${okCount} employee(s) are already deleted.`);
    console.log(`After Jetson processes the queue, run this to verify:`);
    console.log(`  PGPASSWORD=postgres123 psql -h localhost -U postgres -d attendance_intelligence -c \\`);
    console.log(`    "SELECT model_version, COUNT(*) FROM employee_face_embeddings GROUP BY model_version;"`);
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
