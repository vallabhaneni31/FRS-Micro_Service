/**
 * storageService.js — centralized S3 storage abstraction.
 *
 * Two buckets are used across the app (see env.js):
 *   - env.aws.s3LogsBucket:     temporal check-in/out & unrecognized-face photos
 *   - env.aws.s3UserDataBucket: permanent enrollment + profile photos
 *
 * Callers pass the bucket explicitly (LOGS_BUCKET / USER_DATA_BUCKET below)
 * rather than this module guessing — key-namespace conventions live with the
 * caller (DeviceEventService, EnrollmentService, PersonService, ...).
 */
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';
import logger from '../utils/logger.js';

const s3Client = new S3Client({
  region: env.aws.region,
  credentials: (env.aws.accessKeyId && env.aws.secretAccessKey)
    ? { accessKeyId: env.aws.accessKeyId, secretAccessKey: env.aws.secretAccessKey }
    : undefined,
  ...(env.aws.s3Endpoint ? { endpoint: env.aws.s3Endpoint, forcePathStyle: env.aws.s3ForcePathStyle } : {}),
});

export const LOGS_BUCKET = env.aws.s3LogsBucket;
export const USER_DATA_BUCKET = env.aws.s3UserDataBucket;

/**
 * Upload a buffer to S3. Every image-upload code path (event photos,
 * enrollment angles, profile photos) funnels through here, so this is the
 * single place that logs initiated/succeeded/failed for the whole upload
 * flow — see docs/runbooks or README for the `pm2 logs` command that tails
 * just these lines in real time.
 * @returns {Promise<string>} the key, for convenience chaining
 */
export async function uploadFile(bucket, key, buffer, contentType = 'image/jpeg') {
  if (!bucket) throw new Error(`[storageService] Missing S3 bucket for key: ${key}`);

  const startedAt = Date.now();
  logger.info(
    { bucket, key, contentType, sizeBytes: buffer?.length },
    '[storageService] S3 upload initiated'
  );

  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }));
    logger.info(
      { bucket, key, durationMs: Date.now() - startedAt },
      '[storageService] S3 upload succeeded'
    );
    return key;
  } catch (err) {
    logger.error(
      { err, bucket, key, durationMs: Date.now() - startedAt },
      '[storageService] S3 upload failed'
    );
    throw err;
  }
}

/**
 * Delete an object from S3. Resolves to false (does not throw) if the
 * object was already gone — callers treat that the same as a successful purge.
 */
export async function deleteFile(bucket, key) {
  if (!bucket || !key) return false;
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return false;
    logger.error({ err, bucket, key }, '[storageService] deleteFile failed');
    throw err;
  }
}

/**
 * Fetch an object from S3 as a readable stream (for the backend-proxy
 * serving pattern — see jetsonRoutes.js / EnrollmentController.servePhoto).
 * @returns {Promise<{stream: import('stream').Readable, contentType?: string, contentLength?: number}>}
 */
export async function getFileStream(bucket, key) {
  const res = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return {
    stream: res.Body,
    contentType: res.ContentType,
    contentLength: res.ContentLength,
  };
}

/**
 * Fetch an object from S3 fully buffered into memory. Convenience wrapper
 * for callers that need the whole buffer (e.g. forwarding to the Jetson
 * /enroll-image endpoint or running an integrity check).
 */
export async function getFileBuffer(bucket, key) {
  const { stream } = await getFileStream(bucket, key);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Generate a short-lived pre-signed GET URL. Not used while the app proxies
 * images through the backend (Option A), but kept available for a future
 * move to direct-from-S3 delivery (Option B).
 */
export async function getDownloadUrl(bucket, key, expiresSeconds = 900) {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(s3Client, command, { expiresIn: expiresSeconds });
}

/**
 * Generate a short-lived pre-signed PUT URL so a device can upload a photo
 * straight to S3 instead of embedding it as base64 in the event payload —
 * removes photo bandwidth from the API tier entirely. Callers must derive
 * `key` server-side (see DeviceEventService.resolveEventPhotoKey) and never
 * let the device choose its own key.
 */
export async function getUploadUrl(bucket, key, { contentType = 'image/jpeg', expiresSeconds = 300 } = {}) {
  const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
  return getSignedUrl(s3Client, command, { expiresIn: expiresSeconds });
}

/**
 * Checks whether an object exists without downloading it — used to verify a
 * device's direct-to-S3 upload actually landed before trusting a photo_key
 * reference from the event payload.
 */
export async function objectExists(bucket, key) {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

export default {
  LOGS_BUCKET,
  USER_DATA_BUCKET,
  uploadFile,
  deleteFile,
  getFileStream,
  getFileBuffer,
  getDownloadUrl,
  getUploadUrl,
  objectExists,
};
