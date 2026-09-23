#!/usr/bin/env node
/**
 * backfill_encrypt_embeddings.js — FIX-021: Encrypt existing face embeddings
 *
 * Iterates over all face_embedding rows where encrypted_embedding IS NULL,
 * encrypts the raw vector with AES-256-GCM, and writes back the blob.
 *
 * Run ONCE after migration 039 is applied. Safe to re-run (skips already-encrypted rows).
 *
 * Usage:
 *   EMBEDDING_ENCRYPTION_KEY=<64-hex-chars> node backfill_encrypt_embeddings.js
 *   EMBEDDING_ENCRYPTION_KEY=<64-hex-chars> BATCH_SIZE=500 node backfill_encrypt_embeddings.js
 */
import pg from 'pg';
import { encryptEmbedding } from '../src/utils/embeddingEncryption.js';

const BATCH_SIZE = Number(process.env.BATCH_SIZE || 200);

const pool = new pg.Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME     || 'frs',
  user:     process.env.DB_USER     || 'frs_app_user',
  password: process.env.DB_PASSWORD,
  ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : false,
});

async function run() {
  console.log(`[backfill] Starting embedding encryption backfill (batch=${BATCH_SIZE})`);
  let totalProcessed = 0;
  let totalErrors    = 0;

  while (true) {
    const { rows } = await pool.query(
      `SELECT pk_embedding_id, face_embedding_vector
       FROM face_embedding
       WHERE encrypted_embedding IS NULL
       LIMIT $1`,
      [BATCH_SIZE]
    );

    if (!rows.length) break;

    for (const row of rows) {
      try {
        let vector = row.face_embedding_vector;

        // Handle both JSON array string and actual array
        if (typeof vector === 'string') {
          vector = JSON.parse(vector);
        }

        if (!Array.isArray(vector) || vector.length === 0) {
          console.warn(`[backfill] Skipping ${row.pk_embedding_id} — invalid vector`);
          continue;
        }

        const { blob, key_id } = encryptEmbedding(vector);

        await pool.query(
          `UPDATE face_embedding
           SET encrypted_embedding     = $1,
               embedding_key_id        = $2,
               embedding_encrypted_at  = NOW()
           WHERE pk_embedding_id = $3`,
          [blob, key_id, row.pk_embedding_id]
        );

        totalProcessed++;
      } catch (err) {
        console.error(`[backfill] Error on row ${row.pk_embedding_id}:`, err.message);
        totalErrors++;
      }
    }

    process.stdout.write(`\r[backfill] Processed: ${totalProcessed} | Errors: ${totalErrors}`);
  }

  console.log(`\n[backfill] Complete — ${totalProcessed} rows encrypted, ${totalErrors} errors`);
  await pool.end();
  process.exit(totalErrors > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('[backfill] Fatal:', err);
  process.exit(2);
});
