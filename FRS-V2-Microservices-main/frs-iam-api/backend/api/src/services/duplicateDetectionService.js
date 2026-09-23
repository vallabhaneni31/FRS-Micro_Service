/**
 * duplicateDetectionService.js — FIX-023: Cosine similarity duplicate enrollment detection
 *
 * Before an enrollment is approved, this service compares the candidate's
 * face embeddings against all existing active employees in the same tenant.
 * If similarity exceeds the threshold, the invitation is flagged for review.
 *
 * Thresholds (configurable via env):
 *   DUPLICATE_SIMILARITY_BLOCK   (default 0.97) — auto-reject, too similar
 *   DUPLICATE_SIMILARITY_FLAG    (default 0.90) — flag for HR review
 *
 * Returns:
 *   { isDuplicate: bool, flags: [{employeeId, similarity}], shouldBlock: bool }
 */
import { pool }        from '../db/pool.js';
import { decryptEmbedding, isEncryptedBlob } from '../utils/embeddingEncryption.js';
import logger          from '../utils/logger.js';

const BLOCK_THRESHOLD = Number(process.env.DUPLICATE_SIMILARITY_BLOCK || 0.97);
const FLAG_THRESHOLD  = Number(process.env.DUPLICATE_SIMILARITY_FLAG  || 0.90);

/**
 * Compute cosine similarity between two numeric vectors.
 * Returns value in [-1, 1]; identical vectors → 1.0.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Check a candidate embedding against all existing embeddings in the tenant.
 *
 * @param {object} opts
 * @param {string}   opts.tenantId       - UUID of the tenant
 * @param {string}   opts.invitationId   - UUID of the enrollment invitation
 * @param {string}   opts.employeeId     - UUID of the employee being enrolled
 * @param {number[]} opts.candidateEmbed - 512-dim embedding to check
 * @returns {Promise<{isDuplicate:boolean, shouldBlock:boolean, flags:Array}>}
 */
export async function checkForDuplicates({ tenantId, invitationId, employeeId, candidateEmbed }) {
  if (!candidateEmbed || candidateEmbed.length === 0) {
    return { isDuplicate: false, shouldBlock: false, flags: [] };
  }

  // Fetch all existing embeddings for this tenant (excluding the same employee)
  const { rows } = await pool.query(
    `SELECT fe.pk_embedding_id, fe.fk_employee_id, fe.face_embedding_vector,
            fe.encrypted_embedding, fe.embedding_key_id,
            e.employee_code
     FROM face_embedding fe
     JOIN hr_employee e ON e.pk_employee_id = fe.fk_employee_id
     WHERE e.tenant_id   = $1::uuid
       AND fe.fk_employee_id != $2::uuid
       AND fe.is_active   = true
     ORDER BY fe.created_at DESC`,
    [tenantId, employeeId]
  );

  const flags       = [];
  let   shouldBlock = false;

  for (const row of rows) {
    let existingEmbed;
    try {
      if (row.encrypted_embedding && isEncryptedBlob(row.encrypted_embedding)) {
        existingEmbed = decryptEmbedding(row.encrypted_embedding);
      } else {
        // Legacy unencrypted
        existingEmbed = typeof row.face_embedding_vector === 'string'
          ? JSON.parse(row.face_embedding_vector)
          : row.face_embedding_vector;
      }
    } catch (err) {
      logger.warn({ err, embeddingId: row.pk_embedding_id },
        '[duplicateDetection] Could not deserialize embedding — skipping');
      continue;
    }

    const sim = cosineSimilarity(candidateEmbed, existingEmbed);

    if (sim >= FLAG_THRESHOLD) {
      flags.push({
        employeeId:    row.fk_employee_id,
        employeeCode:  row.employee_code,
        embeddingId:   row.pk_embedding_id,
        similarity:    Math.round(sim * 10000) / 10000,
      });

      if (sim >= BLOCK_THRESHOLD) {
        shouldBlock = true;
      }
    }
  }

  const isDuplicate = flags.length > 0;

  // Persist flagged results to DB for HR review
  if (isDuplicate) {
    for (const flag of flags) {
      await pool.query(
        `INSERT INTO enrollment_duplicate_checks
           (invitation_id, duplicate_emp_id, similarity_score, threshold_used, status)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [
          invitationId,
          flag.employeeId,
          flag.similarity,
          FLAG_THRESHOLD,
          shouldBlock ? 'blocked' : 'flagged',
        ]
      ).catch(err => logger.warn({ err }, '[duplicateDetection] Failed to persist flag'));
    }

    logger.warn({
      invitationId,
      employeeId,
      flagCount: flags.length,
      shouldBlock,
      topSimilarity: flags[0]?.similarity,
    }, '[duplicateDetection] Duplicate enrollment detected');
  }

  return { isDuplicate, shouldBlock, flags };
}
