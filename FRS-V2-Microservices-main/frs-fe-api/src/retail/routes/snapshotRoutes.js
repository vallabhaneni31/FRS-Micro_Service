// Trimmed from backend/api-retail/src/routes/snapshotRoutes.js: this repo is
// the user/admin-facing half of the retail vertical, so only the
// authenticateUser-guarded read routes are kept. The device-facing push
// route below (authenticateDevice) was dropped — it lives in frs-edge-api:
//   POST /:id/snapshot — device pushes latest annotated frame
import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticateUser } from '../middleware/authenticateUser.js';
import { pool } from '../db/pool.js';
import {
  getSnapshot,
  subscribeToSnapshots,
  listDeviceCameras,
} from '../services/snapshotStore.js';
import { resolveCameraId } from '../services/cameraResolver.js';

const router = express.Router();

const SSE_KEEPALIVE_MS = 20_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// EventSource (used by the browser viewer) can't set an Authorization
// header, so the two browser-facing read routes below also accept the
// access token as ?token=. Device pushes always use the Bearer header.
function tokenFromQuery(req, _res, next) {
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}

/**
 * ?camera_id= on the read routes. The viewer passes the cameras.id UUID it
 * already holds from /stores/:id/live, which needs no lookup; a human-facing
 * slug ("bullet-camera-02") is also accepted and costs one extra query to
 * resolve against the device's own store. Returns null for absent/unknown,
 * which the callers treat as "no camera pinned".
 */
async function cameraIdFromQuery(req) {
  const raw = req.query.camera_id;
  if (!raw) return null;
  if (UUID_RE.test(raw)) return raw;

  const { rows } = await pool.query(
    `SELECT store_id FROM edge_devices WHERE id = $1 LIMIT 1`,
    [req.params.id]
  );
  if (!rows.length) return null;
  return resolveCameraId(raw, rows[0].store_id);
}

// GET /devices/:id/snapshot/cameras — which cameras on this device currently
// have a live frame. The viewer needs this to render one tile per camera:
// cameras.store_id ties a camera to a store, never to a device, so the
// database alone can't say which camera is behind which device. Only the
// frames actually arriving can.
router.get('/:id/snapshot/cameras', tokenFromQuery, authenticateUser, asyncHandler(async (req, res) => {
  const live = listDeviceCameras(req.params.id);
  if (!live.length) return res.json({ cameras: [] });

  const ids = live.map(c => c.camera_id).filter(Boolean);
  const { rows } = ids.length
    ? await pool.query(
        `SELECT id, name, external_id, position FROM cameras WHERE id = ANY($1::uuid[])`,
        [ids]
      )
    : { rows: [] };
  const byId = new Map(rows.map(r => [r.id, r]));

  return res.json({
    cameras: live.map(c => ({
      camera_id: c.camera_id,
      captured_at: c.captured_at,
      // An unregistered camera has no row to name it — surface it anyway so
      // the viewer shows the feed rather than silently dropping it.
      name: byId.get(c.camera_id)?.name ?? 'Unattributed camera',
      external_id: byId.get(c.camera_id)?.external_id ?? null,
      position: byId.get(c.camera_id)?.position ?? null,
      registered: byId.has(c.camera_id),
    })),
  });
}));

// GET /devices/:id/snapshot — latest stored frame as a JPEG. ?camera_id picks
// one camera; without it, the newest frame across the device's cameras.
router.get('/:id/snapshot', tokenFromQuery, authenticateUser, asyncHandler(async (req, res) => {
  const snap = getSnapshot(req.params.id, await cameraIdFromQuery(req));
  if (!snap) return res.status(404).json({ error: 'no_snapshot' });

  res.set('Content-Type', snap.contentType || 'image/jpeg');
  res.set('Cache-Control', 'no-cache');
  return res.send(snap.buffer);
}));

// GET /devices/:id/snapshot/stream — SSE push of each new frame as it lands
//
// Latest-only delivery: if the client can't drain writes as fast as frames
// arrive (device pushes ~4/sec of full JPEGs), we must NOT queue every frame
// — SSE is strictly ordered, so a backlog can only grow, never catch up, and
// the viewer ends up permanently behind ("stuck"). Instead, track only the
// single newest pending buffer; anything superseded while a write is still
// draining is dropped in favor of what's current once we're ready to send.
router.get('/:id/snapshot/stream', tokenFromQuery, authenticateUser, asyncHandler(async (req, res) => {
  const deviceId = req.params.id;
  // Pin one camera. Without this a multi-camera device interleaves every
  // feed onto one stream and the viewer strobes between unrelated scenes;
  // the throttle below then makes it worse, since each camera only lands
  // every Nth slot. A single-camera device behaves identically either way.
  const cameraId = await cameraIdFromQuery(req);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  // A client that vanishes without a clean TCP close (sleep, network switch,
  // tab killed) doesn't always fire 'close' promptly — the socket can sit
  // half-open for a long time. Each such zombie still gets a synchronous
  // base64-encode + write on every single frame the device posts, so if
  // enough of these pile up over a long-running dashboard session, real
  // connections start falling behind the event loop's growing backlog of
  // dead work. Force-drop any connection with zero read/write activity for
  // 30s (a healthy one always has at least the 20s keepalive ping).
  req.socket.setTimeout(30_000, () => req.socket.destroy());

  // The drain-based coalescing below only guards against true TCP
  // backpressure — it does nothing to stop the browser's own event queue
  // from backing up. EventSource delivers every message the server
  // actually writes, one at a time, in order; if a client's JS thread can't
  // fully process one frame (base64 decode + JPEG decode + paint) before
  // the next lands, those events queue up client-side and the visible
  // image drifts further behind the longer the connection stays open —
  // even though the network layer never saw any backpressure. A fresh
  // connection to the same device shows the correct current frame
  // immediately, which is what confirmed this is a receive-rate problem,
  // not a stale-data problem. So: throttle the push rate itself to
  // something any browser can keep up with, well under the device's raw
  // ~4/sec capture rate.
  const MIN_SEND_INTERVAL_MS = 300;

  let pending = null;
  let draining = false;
  let lastSentAt = 0;
  let throttleTimer = null;

  const write = () => {
    if (draining || !pending) return;
    const buffer = pending;
    pending = null;
    lastSentAt = Date.now();
    const ok = res.write(`data: ${buffer.toString('base64')}\n\n`);
    if (!ok) {
      draining = true;
      res.once('drain', () => {
        draining = false;
        flush();
      });
    }
  };

  const flush = () => {
    if (draining || !pending || throttleTimer) return;
    const elapsed = Date.now() - lastSentAt;
    if (elapsed >= MIN_SEND_INTERVAL_MS) {
      write();
    } else {
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        write();
      }, MIN_SEND_INTERVAL_MS - elapsed);
    }
  };

  const send = (buffer) => {
    pending = buffer;
    flush();
  };

  const existing = getSnapshot(deviceId, cameraId);
  if (existing) send(existing.buffer);

  const unsubscribe = subscribeToSnapshots(deviceId, cameraId, send);
  const keepAlive = setInterval(() => res.write(':ping\n\n'), SSE_KEEPALIVE_MS);

  req.on('close', () => {
    clearInterval(keepAlive);
    if (throttleTimer) clearTimeout(throttleTimer);
    unsubscribe();
  });
}));

export { router as snapshotRoutes };
