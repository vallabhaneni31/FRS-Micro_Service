import { randomUUID } from 'crypto';
import { validateEventPayload, MAX_BATCH_EVENTS } from '../validators/deviceEventSchemas.js';
import * as svc from '../services/business/DeviceEventService.js';
import kafkaProducer from '../core/kafka/KafkaProducer.js';
import * as storage from '../services/storageService.js';
import { purgeApiCache } from '../middleware/apiCache.js';

// Decoupled ingestion: the controller only authenticates (already done by
// authenticateDevice before this runs), validates, and publishes — it no
// longer runs decode/S3/DB/broadcast inline before responding. That work
// happens in workers/deviceEventConsumer.js, off the request path. See that
// file for the idempotency handling (event_uid + event_dedup table) that
// this publish side must populate.
const JETSON_EVENTS_TOPIC = 'frs.jetson-device-events';

const DeviceEventController = {
  // POST /api/events/photo — device uploads an attendance photo, receives a public URL back
  // Used by Jetson firmware when it cannot embed base64 in the event payload.
  // The returned url can then be passed as frameUrl / photo_url in the attendance event.
  async uploadPhoto(req, res) {
    if (!req.file) {
      return res.status(400).json({ error: 'photo file is required (field name: photo)' });
    }
    const { url, filename } = await svc.saveDevicePhoto({
      tenantId: req.device.tenant_id,
      fileBuffer: req.file.buffer,
      mimetype: req.file.mimetype,
      employeeCode: req.body.employee_code,
      visitorId: req.body.visitor_id,
      direction: req.body.direction,
    });
    return res.json({ success: true, url, filename });
  },

  // POST /api/events/photo-upload-url — mint a presigned S3 PUT URL so the
  // device can upload a photo directly to S3 instead of embedding it as
  // base64 in the event payload (Option B from the architecture review —
  // removes photo bandwidth from the API tier). The device calls this
  // first, PUTs the JPEG straight to the returned url, then posts the real
  // event with `photo_key` set to the same key instead of photo_base64.
  // Key is always derived server-side (resolveEventPhotoKey) — the device
  // never chooses its own key, so it can't write outside its own
  // tenant/identity scope.
  async getPhotoUploadUrl(req, res) {
    const { event_type, payload = {} } = req.body || {};
    const tenantId = req.device.tenant_id;

    if (!event_type) {
      return res.status(400).json({ error: 'event_type is required' });
    }

    const key = await svc.resolveEventPhotoKey({ tenantId, eventType: event_type, payload });
    const url = await storage.getUploadUrl(storage.LOGS_BUCKET, key, { contentType: 'image/jpeg', expiresSeconds: 300 });

    return res.json({ success: true, url, key, expiresIn: 300 });
  },

  // POST /api/events/photo-upload — Option C: device sends the JPEG bytes
  // directly in the same request (multipart, field name "image") instead of
  // a separate presigned-PUT round trip. Same key derivation as Option B
  // (resolveEventPhotoKey), so the returned `key` plugs into the follow-up
  // attendance/visitor event's `payload.photo_key` exactly like Option B's
  // does — processEvent() already verifies+rewrites that field, no change
  // needed there. image_id/image_url are aliases of filename/key so the
  // response is usable directly without the caller knowing our key format;
  // retrieval reuses the existing GET /api/jetson/photos/:filename endpoint.
  async uploadEventImage(req, res) {
    if (!req.file) {
      return res.status(400).json({ error: 'image file is required (field name: image)' });
    }
    const { event_type, employee_code, employee_id, visitor_id, direction, event_time, timestamp } = req.body || {};
    if (!event_type) {
      return res.status(400).json({ error: 'event_type is required' });
    }
    const tenantId = req.device.tenant_id;
    const payload = { employee_code, employee_id, visitor_id, direction, event_time: event_time || timestamp };

    const key = await svc.uploadEventPhoto({ tenantId, eventType: event_type, payload, buffer: req.file.buffer });
    const imageId = key.split('/').pop();

    return res.json({
      success: true,
      image_id: imageId,
      image_url: key,
      key,
      size_bytes: req.file.buffer.length,
      stored_at: new Date().toISOString(),
    });
  },

  // POST /api/events — single event from Jetson
  async postEvent(req, res) {
    const { event_type, payload, event_time } = req.body || {};
    const deviceCode = req.device.code;
    const tenantId = req.device.tenant_id;

    if (!event_type) {
      return res.status(400).json({ error: 'event_type is required' });
    }

    // Accept both the documented { event_type, payload: {...} } shape and the
    // flat shape live firmware actually sends for some event types (e.g.
    // device.heartbeat: status/metrics/etc. directly on the body, no
    // "payload" wrapper at all). Without this fallback, `payload = {}` silently
    // discarded every field the device sent — event_type still came through
    // (it's a top-level key either way) so the event looked "received", but
    // the body was empty by the time it reached validation/Kafka/consumer.
    const basePayload = (payload && typeof payload === 'object' && Object.keys(payload).length > 0)
      ? payload
      : (req.body || {});

    const fullPayload = { ...basePayload, event_time: event_time || basePayload.event_time };

    // Reject malformed payloads for known event types before any DB writes.
    const validation = validateEventPayload(event_type, fullPayload);
    if (validation.error) {
      return res.status(400).json({ error: 'invalid_payload', message: validation.error });
    }

    const eventUid = randomUUID();
    await kafkaProducer.sendEvent(
      JETSON_EVENTS_TOPIC,
      {
        event_uid: eventUid,
        device_code: deviceCode,
        tenant_id: tenantId,
        event_type,
        payload: validation.value || fullPayload,
      },
      tenantId
    );
    // NOTE: processing is now async (workers/deviceEventConsumer.js), so this
    // purge fires at queue-time, not at actual-write-time — it clears stale
    // reads immediately, but a request landing in the few hundred ms before
    // the consumer's DB write completes can still re-cache stale data until
    // the next purge or TTL expiry (15s, see apiCache.js). Also only purges
    // the /live cache on *this* frs-backend cluster worker's own in-memory
    // store, not its sibling worker's — a pre-existing limitation of
    // apiCache.js's per-process Map, not introduced by the async pipeline.
    purgeApiCache('/live');

    return res.status(202).json({ success: true, received: event_type, event_id: eventUid, status: 'queued' });
  },

  // POST /api/events/batch — drain offline queue
  async postBatch(req, res) {
    const { events } = req.body || {};
    const deviceCode = req.device.code;
    const tenantId = req.device.tenant_id;

    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'events array is required' });
    }

    // Bound batch size so a single device cannot block the event loop / DB.
    if (events.length > MAX_BATCH_EVENTS) {
      return res.status(413).json({
        error: 'batch_too_large',
        message: `batch exceeds max of ${MAX_BATCH_EVENTS} events`,
        max: MAX_BATCH_EVENTS,
      });
    }

    const results = [];
    const toPublish = [];
    for (const ev of events) {
      if (!ev || !ev.event_type) {
        results.push({ id: ev?.id, status: 'error', message: 'event_type is required' });
        continue;
      }
      const payload = { ...(ev.payload || {}), event_time: ev.event_time || ev.payload?.event_time };
      const validation = validateEventPayload(ev.event_type, payload);
      if (validation.error) {
        results.push({ id: ev.id, status: 'error', message: validation.error });
        continue;
      }
      const eventUid = randomUUID();
      toPublish.push({
        topic: JETSON_EVENTS_TOPIC,
        key: tenantId,
        event: {
          event_uid: eventUid,
          device_code: deviceCode,
          tenant_id: tenantId,
          event_type: ev.event_type,
          payload: validation.value || payload,
        },
      });
      results.push({ id: ev.id, status: 'queued', event_id: eventUid });
    }

    if (toPublish.length) {
      await kafkaProducer.sendBatch(toPublish);
    }

    purgeApiCache('/live');
    return res.status(202).json({ success: true, processed: results.length, results });
  },

  // GET /api/events/commands — Jetson polls for queued commands (reboot, config-update, enroll-trigger)
  async getCommands(req, res) {
    const deviceCode = req.device.code;
    const deviceId = req.device.id;

    const commands = await svc.drainCommands({ deviceCode, deviceId });
    return res.json({ commands });
  },
};

export default DeviceEventController;
