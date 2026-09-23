/**
 * vlmQualityGateService.js — server-side VLM quality gate for visitor photos.
 *
 * Calls the self-hosted VLM microservice (scripts/vlm_quality_service.py) to
 * judge whether a buffered visitor photo actually shows a usable, correctly
 * captured face before it's allowed to become that visitor's stored photo.
 *
 * Fails open on any error, timeout, or disabled config: an outage of this
 * optional service must never block visitor promotion in
 * visitorValidationService.js.
 */
import * as storage from '../storageService.js';
import { env } from '../../config/env.js';
import logger from '../../utils/logger.js';

/**
 * @param {string} bucket - S3 bucket the photo lives in (storageService.LOGS_BUCKET)
 * @param {string} key - S3 key (visitor_buffer.photo_url)
 * @returns {Promise<{ usable: boolean, reason: string|null, checked: boolean }>}
 */
export async function checkFrameUsable(bucket, key) {
  if (!env.vlmQualityGate.enabled) {
    return { usable: true, reason: null, checked: false };
  }

  try {
    const buffer = await storage.getFileBuffer(bucket, key);

    const form = new FormData();
    form.append('image', new Blob([buffer], { type: 'image/jpeg' }), 'frame.jpg');

    const res = await fetch(`${env.vlmQualityGate.baseUrl}/check-frame`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(env.vlmQualityGate.timeoutMs),
    });

    if (!res.ok) {
      logger.warn({ bucket, key, status: res.status }, '[vlm-quality-gate] non-2xx response, failing open');
      return { usable: true, reason: 'vlm_unavailable', checked: false };
    }

    const data = await res.json();
    if (typeof data.usable !== 'boolean') {
      logger.warn({ bucket, key, data }, '[vlm-quality-gate] malformed response, failing open');
      return { usable: true, reason: 'vlm_unavailable', checked: false };
    }

    return { usable: data.usable, reason: data.reason || null, checked: true };
  } catch (err) {
    logger.warn({ err, bucket, key }, '[vlm-quality-gate] call failed, failing open');
    return { usable: true, reason: 'vlm_unavailable', checked: false };
  }
}
