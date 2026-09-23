/**
 * embeddingEncryption.js — FIX-021: AES-256-GCM face embedding encryption
 *
 * Encrypts 512-dimensional face embeddings before DB storage and decrypts on
 * retrieval.  Each encryption call produces a unique IV (nonce) that is stored
 * with the ciphertext so the same plaintext produces different ciphertext each
 * time (IND-CPA security).
 *
 * Format stored in DB: base64(iv[12] || ciphertext || authTag[16])
 *
 * Key derivation:
 *   EMBEDDING_ENCRYPTION_KEY env var — must be 64 hex chars (32 bytes → 256 bit)
 *   Optionally, EMBEDDING_ENCRYPTION_KEY_ID tags the version so key rotation is
 *   possible without re-encrypting all rows at once.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALG      = 'aes-256-gcm';
const IV_LEN   = 12;   // 96-bit nonce recommended for GCM
const TAG_LEN  = 16;   // 128-bit auth tag

function getKey() {
  const hex = process.env.EMBEDDING_ENCRYPTION_KEY;
  if (!hex) throw new Error('[FIX-021] EMBEDDING_ENCRYPTION_KEY is required');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('[FIX-021] EMBEDDING_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

function getKeyId() {
  return process.env.EMBEDDING_ENCRYPTION_KEY_ID || 'v1';
}

/**
 * Encrypt a face embedding (Float32Array or number[]) → base64 blob.
 *
 * @param {number[]|Float32Array} embedding - Raw embedding vector
 * @returns {{ blob: string, key_id: string }} - blob to store in DB
 */
export function encryptEmbedding(embedding) {
  const key  = getKey();
  const iv   = randomBytes(IV_LEN);

  // Serialize to a compact binary format: 4 bytes per float32, little-endian
  const floats = Float32Array.from(embedding);
  const plain  = Buffer.from(floats.buffer);

  const cipher    = createCipheriv(ALG, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag   = cipher.getAuthTag();

  // Concatenate: IV || ciphertext || authTag
  const blob = Buffer.concat([iv, encrypted, authTag]).toString('base64');
  return { blob, key_id: getKeyId() };
}

/**
 * Decrypt a stored blob back to a number array.
 *
 * @param {string} blob   - base64 blob from DB
 * @returns {number[]}    - decrypted embedding vector
 */
export function decryptEmbedding(blob) {
  const key  = getKey();
  const data = Buffer.from(blob, 'base64');

  if (data.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('[FIX-021] Encrypted embedding blob is too short — data may be corrupted');
  }

  const iv         = data.subarray(0, IV_LEN);
  const authTag    = data.subarray(data.length - TAG_LEN);
  const ciphertext = data.subarray(IV_LEN, data.length - TAG_LEN);

  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(authTag);

  const plain  = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const floats = new Float32Array(plain.buffer, plain.byteOffset, plain.byteLength / 4);
  return Array.from(floats);
}

/**
 * Returns true if the given DB value looks like an encrypted blob
 * (base64 string) rather than a raw JSON array.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isEncryptedBlob(value) {
  return typeof value === 'string' && /^[A-Za-z0-9+/]+=*$/.test(value);
}
