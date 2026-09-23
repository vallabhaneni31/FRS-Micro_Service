import { EventEmitter } from 'events';

/**
 * In-memory "latest frame per camera" store for the live retail snapshot
 * feature. This is a live view, not a record — no history/archive, each POST
 * overwrites the previous frame for that camera.
 *
 * Keyed by (deviceId, cameraId), NOT deviceId alone. A single edge device can
 * run several cameras — a Jetson pushing three RTSP streams is normal — and
 * every one of them POSTs to the same /devices/:id/snapshot route. Keying by
 * device alone meant all of them overwrote a single slot, so the live view
 * showed whichever camera happened to write last and visibly strobed between
 * unrelated scenes at the combined push rate.
 *
 * Map growth is bounded: cameraId here is already resolved against the
 * cameras table by resolveCameraId(), so an unregistered or absent slug
 * collapses to DEFAULT_CAMERA rather than minting a new key. Worst case is
 * one entry per registered camera per device, plus one shared unattributed
 * slot. Note the corollary: frames from two *unregistered* cameras still
 * share DEFAULT_CAMERA and still overwrite each other — register a camera
 * (cameras.external_id must equal the slug the device sends) to separate it.
 */
const frames = new Map(); // `${deviceId}::${cameraKey}` -> { buffer, contentType, capturedAt, cameraId }
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const DEFAULT_CAMERA = '_';

const frameKey = (deviceId, cameraId) => `${deviceId}::${cameraId || DEFAULT_CAMERA}`;

export function setSnapshot(deviceId, buffer, contentType, capturedAt, cameraId = null) {
  const entry = { buffer, contentType, capturedAt, cameraId: cameraId || null };
  frames.set(frameKey(deviceId, cameraId), entry);

  // Per-camera subscribers (the live view pins one camera at a time).
  emitter.emit(frameKey(deviceId, cameraId), buffer);
  // Device-wide subscribers: every camera on the device. For a single-camera
  // device this is identical to the per-camera feed; for a multi-camera one
  // it is the interleaved stream, which is only ever what a caller that
  // passed no camera_id asked for.
  emitter.emit(deviceId, buffer);
}

/**
 * Latest frame for one camera. With no cameraId, falls back to the most
 * recently captured frame across every camera on the device — which keeps
 * single-camera callers (and anything that predates camera support) working
 * unchanged, since such a device has exactly one entry.
 */
export function getSnapshot(deviceId, cameraId = null) {
  if (cameraId) return frames.get(frameKey(deviceId, cameraId)) || null;

  let newest = null;
  for (const [key, entry] of frames) {
    if (!key.startsWith(`${deviceId}::`)) continue;
    if (!newest || entry.capturedAt > newest.capturedAt) newest = entry;
  }
  return newest;
}

/**
 * Which cameras currently have a live frame for this device, newest first.
 * Lets the viewer render one tile per real camera instead of one per device.
 */
export function listDeviceCameras(deviceId) {
  const out = [];
  for (const [key, entry] of frames) {
    if (!key.startsWith(`${deviceId}::`)) continue;
    out.push({ camera_id: entry.cameraId, captured_at: entry.capturedAt });
  }
  return out.sort((a, b) => b.captured_at - a.captured_at);
}

/** Subscribe to one camera's frames, or to every camera when cameraId is null. */
export function subscribeToSnapshots(deviceId, cameraId, listener) {
  const topic = cameraId ? frameKey(deviceId, cameraId) : deviceId;
  emitter.on(topic, listener);
  return () => emitter.off(topic, listener);
}
