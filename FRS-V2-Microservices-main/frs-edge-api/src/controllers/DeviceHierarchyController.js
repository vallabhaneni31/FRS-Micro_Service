import { pool } from '../db/pool.js';
import wsManager from '../websocket/index.js';
import * as svc from '../services/business/DeviceHierarchyService.js';
import { resolvePhotoByFilename } from '../services/photoResolverService.js';
import { getFileStream } from '../services/storageService.js';

const { NotFoundError, ForbiddenError, ValidationError } = svc;

// req.auth.scope is resolved and validated by requireAuth (JWT-locked tenantId,
// membership-checked siteId) — the raw x-tenant-id/x-site-id headers must never
// be consulted directly here, or a caller could escalate to another tenant's
// scope simply by setting a header when req.auth.scope happens to be unset.
const getSiteId = (req) => req.auth?.scope?.siteId ?? req.headers['x-site-id'] ?? null;
const getTenantId = (req) => req.auth?.scope?.tenantId ?? req.headers['x-tenant-id'] ?? null;

function handleKnownError(err, res) {
  if (err instanceof NotFoundError) return res.status(404).json({ message: err.message });
  if (err instanceof ForbiddenError) return res.status(403).json({ message: err.message });
  if (err instanceof ValidationError) return res.status(err.statusCode || 400).json({ error: err.message });
  return null;
}

const DeviceHierarchyController = {
  // ── Top-level list ───────────────────────────────────────────────────────
  async listAllDevices(req, res) {
    const data = await svc.listAllDevices(getTenantId(req));
    res.json({ data });
  },

  // ── Buildings ─────────────────────────────────────────────────────────────
  async listBuildings(req, res) {
    const data = await svc.listBuildings(getSiteId(req));
    res.json({ data });
  },

  async createBuilding(req, res) {
    const { name, address } = req.body;
    if (!name) return res.status(400).json({ message: 'name required' });
    const building = await svc.createBuilding({ siteId: getSiteId(req), name, address }, req);
    res.status(201).json(building);
  },

  async updateBuilding(req, res) {
    const { name, address } = req.body;
    try {
      const building = await svc.updateBuilding({ id: req.params.id, siteId: getSiteId(req), name, address });
      res.json(building);
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async deleteBuilding(req, res) {
    try {
      await svc.deleteBuilding({ id: req.params.id, siteId: getSiteId(req) });
      res.json({ success: true });
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  // ── Floors ────────────────────────────────────────────────────────────────
  async listFloorsForBuilding(req, res) {
    const data = await svc.listFloorsForBuilding(req.params.buildingId, getSiteId(req));
    res.json({ data });
  },

  async createFloor(req, res) {
    const { floor_number, floor_name } = req.body;
    if (!floor_number) return res.status(400).json({ message: 'floor_number required' });
    try {
      const floor = await svc.createFloor({ buildingId: req.params.buildingId, siteId: getSiteId(req), floorNumber: floor_number, floorName: floor_name });
      res.status(201).json(floor);
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async listFloorsForSite(req, res) {
    const data = await svc.listFloorsForSite(getSiteId(req));
    res.json({ data });
  },

  async createFloorForSite(req, res) {
    const { floor_number, floor_name } = req.body;
    if (!floor_number) return res.status(400).json({ message: 'floor_number required' });
    try {
      const floor = await svc.createFloorForSite({ siteId: getSiteId(req), floorNumber: floor_number, floorName: floor_name });
      res.status(201).json(floor);
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async updateFloor(req, res) {
    const { floor_name, floor_number, floor_plan_url, floor_plan_data } = req.body;
    try {
      const floor = await svc.updateFloor({
        id: req.params.id, siteId: getSiteId(req), floorName: floor_name, floorNumber: floor_number,
        floorPlanUrl: floor_plan_url, floorPlanData: floor_plan_data,
      });
      wsManager.broadcastDeviceChange(req);
      res.json(floor);
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async deleteFloor(req, res) {
    try {
      await svc.deleteFloor({ id: req.params.id, siteId: getSiteId(req) });
      res.json({ success: true });
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  // ── Zones ─────────────────────────────────────────────────────────────────
  async listZonesForFloor(req, res) {
    const data = await svc.listZonesForFloor(req.params.floorId, getSiteId(req));
    res.json({ data });
  },

  async createZone(req, res) {
    const { zone_name, zone_type } = req.body;
    if (!zone_name) return res.status(400).json({ message: 'zone_name required' });
    try {
      const zone = await svc.createZone({ floorId: req.params.floorId, siteId: getSiteId(req), zoneName: zone_name, zoneType: zone_type });
      res.status(201).json(zone);
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async deleteZone(req, res) {
    try {
      await svc.deleteZone({ id: req.params.id, siteId: getSiteId(req) });
      res.json({ success: true });
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  // ── NUG boxes ─────────────────────────────────────────────────────────────
  async listNugBoxes(req, res) {
    const data = await svc.listNugBoxes({ siteId: getSiteId(req), tenantId: getTenantId(req) });
    res.json({ data });
  },

  async getNugBox(req, res) {
    try {
      const nug = await svc.getNugBox({
        id: req.params.id,
        tenantId: getTenantId(req),
        isSuperAdmin: req.auth?.memberships?.some(m => m.role === 'super_admin'),
      });
      res.json(nug);
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async createNugBox(req, res) {
    const { name, port,
            match_threshold, conf_threshold, cooldown_seconds, x_threshold, tracking_window } = req.body;
    const device_code = req.body.device_code ?? req.body.deviceCode;
    const ip_address = req.body.ip_address ?? req.body.ipAddress;
    const fk_floor_id = req.body.fk_floor_id ?? req.body.floorId;
    const fk_building_id = req.body.fk_building_id ?? req.body.buildingId;
    const fk_zone_id = req.body.fk_zone_id ?? req.body.zoneId;

    if (!name || !ip_address) return res.status(400).json({ message: 'name and ip_address required' });

    const nug = await svc.createNugBox({
      tenantId: getTenantId(req), siteId: getSiteId(req),
      name, deviceCode: device_code || null, ipAddress: ip_address, port: port || 5000,
      buildingId: fk_building_id || null, floorId: fk_floor_id || null, zoneId: fk_zone_id || null,
      matchThreshold: match_threshold || 0.38, confThreshold: conf_threshold || 0.35,
      cooldownSeconds: cooldown_seconds || 3, xThreshold: x_threshold || 25, trackingWindow: tracking_window || 6,
    }, req);
    res.status(201).json(nug);
  },

  async updateNugBox(req, res) {
    const { name, ip_address, port, fk_building_id, fk_floor_id, fk_zone_id,
            match_threshold, conf_threshold, cooldown_seconds, x_threshold,
            tracking_window, map_x, map_y } = req.body;
    try {
      const nug = await svc.updateNugBox({
        id: req.params.id, name, ipAddress: ip_address, port,
        buildingId: fk_building_id, floorId: fk_floor_id, zoneId: fk_zone_id,
        matchThreshold: match_threshold, confThreshold: conf_threshold, cooldownSeconds: cooldown_seconds,
        xThreshold: x_threshold, trackingWindow: tracking_window, mapX: map_x, mapY: map_y,
        tenantId: getTenantId(req),
        isSuperAdmin: req.auth?.memberships?.some(m => m.role === 'super_admin'),
      }, req);
      wsManager.broadcastDeviceChange(req);
      res.json(nug);
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async deleteNugBox(req, res) {
    try {
      await svc.deleteNugBox({
        id: req.params.id,
        tenantId: getTenantId(req),
        isSuperAdmin: req.auth?.memberships?.some(m => m.role === 'super_admin'),
      }, req);
      res.json({ success: true });
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async pingNugBox(req, res) {
    try {
      const result = await svc.pingNugBox(req.params.id);
      res.json(result);
    } catch (err) {
      if (err instanceof NotFoundError) return res.status(404).json({ message: err.message });
      if (err instanceof ValidationError) return res.status(422).json({ success: false, message: err.message });
      throw err;
    }
  },

  async rebootNugBox(req, res) {
    const tenantId = req.auth?.scope?.tenantId;
    const isSuperAdmin = req.auth?.memberships?.some(m => m.role === 'super_admin');
    try {
      const result = await svc.rebootNugBox({ id: req.params.id, tenantId, isSuperAdmin }, req);
      res.json(result);
    } catch (err) {
      if (err instanceof NotFoundError) return res.status(404).json({ message: err.message });
      if (err instanceof ForbiddenError) return res.status(403).json({ message: err.message });
      if (err instanceof ValidationError) return res.status(422).json({ success: false, message: err.message });
      if (err.statusCode === 503) return res.status(503).json({ success: false, message: `Could not reach device: ${err.message}` });
      throw err;
    }
  },

  async applyNugBoxConfig(req, res) {
    const tenantId = req.auth?.scope?.tenantId;
    const isSuperAdmin = req.auth?.memberships?.some(m => m.role === 'super_admin');
    try {
      const result = await svc.applyNugBoxConfig({ id: req.params.id, tenantId, isSuperAdmin }, req);
      res.json(result);
    } catch (err) {
      if (err instanceof NotFoundError) return res.status(404).json({ message: err.message });
      if (err instanceof ForbiddenError) return res.status(403).json({ message: err.message });
      if (err instanceof ValidationError) return res.status(422).json({ success: false, message: err.message });
      if (err.statusCode === 503) return res.status(503).json({ success: false, error: err.message });
      throw err;
    }
  },

  // ── Heartbeats (device-authenticated) ────────────────────────────────────
  async cameraHeartbeat(req, res) {
    const { camId } = req.params;
    const { status = 'online' } = req.body || {};
    await svc.cameraHeartbeat(camId, status);
    res.json({ success: true });
  },

  async nugBoxHeartbeat(req, res) {
    if (req.device?.code !== req.params.code) {
      return res.status(403).json({ error: 'Device code mismatch' });
    }
    const sourceIp = (req.ip || '').replace(/^::ffff:/, '').split(',')[0].trim();
    // This route authenticates via the device JWT (authenticateDevice), not
    // requireAuth, so req.auth is never set here — the tenant must come from
    // the device's own verified token (req.device.tenant_id), not a header.
    await svc.nugBoxHeartbeat(req.params.code, req.body, sourceIp, req.device?.tenant_id ?? null);
    res.json({ success: true });
  },

  async listPendingEnrollments(req, res) {
    if (req.device?.code !== req.params.code) {
      return res.status(403).json({ error: 'Device code mismatch' });
    }
    const pending = await svc.listPendingEnrollments(req.params.code);
    res.json({ pending });
  },

  async pushEnrollmentQuality(req, res) {
    if (req.device?.code !== req.params.code) {
      return res.status(403).json({ error: 'Device code mismatch' });
    }
    const { results } = req.body;
    if (!Array.isArray(results) || results.length === 0) {
      return res.status(400).json({ error: 'results array required' });
    }
    const updated = await svc.pushEnrollmentQuality(results);
    res.json({ success: true, updated });
  },

  async serveEnrollmentPhoto(req, res) {
    const filename = req.params.filename;
    if (!/^[a-zA-Z0-9_-]+\.(jpg|jpeg|png)$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const resolved = await resolvePhotoByFilename(filename).catch(() => null);
    if (resolved?.key) {
      try {
        const { stream } = await getFileStream(resolved.bucket, resolved.key);
        res.setHeader('Content-Type', 'image/jpeg');
        return stream.pipe(res);
      } catch (_) {
        return res.status(404).json({ error: 'Photo not found' });
      }
    }

    // Legacy fallback: file still on local disk from before the S3 migration.
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const fsSync = await import('fs');

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const photoDir = process.env.REMOTE_ENROLLMENT_PHOTO_DIR
      || path.resolve(__dirname, '../../uploads/remote-enrollment');
    const filePath = resolved?.legacyLocalPath || path.join(photoDir, filename);

    if (!filePath.startsWith(photoDir) && !resolved?.legacyLocalPath) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!fsSync.default.existsSync(filePath)) {
      return res.status(404).json({ error: 'Photo not found' });
    }
    res.setHeader('Content-Type', 'image/jpeg');
    fsSync.default.createReadStream(filePath).pipe(res);
  },

  // ── Cameras ───────────────────────────────────────────────────────────────
  async listCameras(req, res) {
    const data = await svc.listCameras(req.query.nug_id);
    res.json({ data });
  },

  async createCamera(req, res) {
    const { name, cam_id, rtsp_url, ip_address, model, fk_nug_id,
            fk_floor_id, fk_zone_id, map_x, map_y, map_angle,
            parent_device_pk } = req.body;
    if (!name || !cam_id) return res.status(400).json({ message: 'name and cam_id required' });

    const tenantId = getTenantId(req);
    const siteId = getSiteId(req);
    // FIX: this previously defaulted to the hardcoded customer "1" whenever
    // x-customer-id was absent, silently mis-filing the camera under whatever
    // tenant happens to own customer 1. Use the already-validated scope from
    // requireAuth; if no customer can be resolved, leave it null (the column
    // is nullable) rather than guessing.
    const customerId = req.auth?.scope?.customerId || null;
    const cameraMode = ['IN', 'OUT', 'MIXED'].includes(req.body.camera_mode) ? req.body.camera_mode : 'MIXED';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const camera = await svc.createCamera({
        tenantId, siteId, customerId, name, camId: cam_id, rtspUrl: rtsp_url, ipAddress: ip_address,
        model, nugId: fk_nug_id || null, floorId: fk_floor_id || null, zoneId: fk_zone_id || null,
        mapX: map_x || null, mapY: map_y || null, mapAngle: map_angle || 0,
        parentDevicePk: parent_device_pk, cameraMode,
      }, req, client);
      await client.query('COMMIT');
      res.status(201).json(camera);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        return res.status(409).json({ error: `A camera with ID "${cam_id}" already exists. Please use a unique Camera ID.` });
      }
      throw err;
    } finally {
      client.release();
    }
  },

  async updateCamera(req, res) {
    const { name, cam_id, rtsp_url, ip_address, model, fk_nug_id,
            fk_floor_id, fk_zone_id, map_x, map_y, map_angle, camera_mode,
            site_id, customer_id } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const camera = await svc.updateCamera({
        id: req.params.id, tenantId: getTenantId(req), name, camId: cam_id, rtspUrl: rtsp_url,
        ipAddress: ip_address, model, nugId: fk_nug_id, floorId: fk_floor_id, zoneId: fk_zone_id,
        mapX: map_x, mapY: map_y, mapAngle: map_angle, cameraMode: camera_mode,
        // Explicit-only reassignment — moves this camera to a different site
        // independent of its parent edge device, so one box can serve
        // cameras that each belong to a different site.
        siteId: site_id || null, customerId: customer_id || null,
      }, req, client);
      await client.query('COMMIT');
      wsManager.broadcastDeviceChange(req);
      res.json(camera);
    } catch (err) {
      await client.query('ROLLBACK');
      if (handleKnownError(err, res)) return;
      if (err.code === '23505') {
        return res.status(409).json({ error: 'A camera with that ID already exists. Please use a unique Camera ID.' });
      }
      throw err;
    } finally {
      client.release();
    }
  },

  async updateCameraMode(req, res) {
    try {
      const result = await svc.updateCameraMode({ cameraMode: req.body.camera_mode, camId: req.params.camId, tenantId: getTenantId(req) });
      wsManager.broadcastDeviceChange(req);
      res.json({ success: true, camera_mode: result.camera_mode });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      throw err;
    }
  },

  async deleteCamera(req, res) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await svc.deleteCamera(req.params.id, getTenantId(req), client);
      await client.query('COMMIT');
      res.json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      const handled = handleKnownError(err, res);
      if (handled) return;
      res.status(500).json({ success: false, message: err.message || 'Failed to delete camera' });
    } finally {
      client.release();
    }
  },

  async captureFrame(req, res) {
    try {
      const result = await svc.captureFrame(req.params.id);
      res.json({ success: true, image: result.image });
    } catch (err) {
      if (err instanceof NotFoundError) return res.status(404).json({ message: err.message });
      if (err instanceof ValidationError) return res.status(422).json({ success: false, message: err.message });
      if (err.statusCode === 503) return res.status(503).json({ success: false, message: err.message });
      throw err;
    }
  },

  async streamCamera(req, res) {
    const rawToken = req.headers.authorization?.slice(7) || req.query.token;
    if (!rawToken) return res.status(401).json({ message: 'Unauthorized' });

    let target;
    try {
      target = await svc.getCameraStreamTarget(req.params.id);
    } catch (err) {
      if (err instanceof NotFoundError) return res.status(404).json({ message: err.message });
      if (err instanceof ValidationError) return res.status(422).json({ message: err.message });
      if (err.statusCode === 503) return res.status(503).json({ message: err.message });
      throw err;
    }
    const { cam_id, nug_ip, nug_port } = target;

    try {
      const upstream = await fetch(`https://${nug_ip}:${nug_port || 5000}/camera/${cam_id}/stream`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!upstream.ok || !upstream.body) {
        return res.status(503).json({ message: 'Stream not available from Edge Node' });
      }
      res.setHeader('Content-Type', upstream.headers.get('Content-Type') || 'multipart/x-mixed-replace; boundary=frame');
      res.setHeader('Cache-Control', 'no-cache');
      const reader = upstream.body.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done || res.writableEnded) break;
            res.write(Buffer.from(value));
          }
        } finally {
          res.end();
        }
      };
      pump().catch(() => res.end());
      req.on('close', () => reader.cancel());
    } catch (e) {
      return res.status(503).json({ message: `Edge Node unreachable: ${e.message}` });
    }
  },

  async pingCamera(req, res) {
    try {
      const result = await svc.pingCamera(req.params.id);
      res.json(result);
    } catch (err) {
      if (err instanceof NotFoundError) return res.status(404).json({ message: err.message });
      if (err instanceof ValidationError) return res.status(422).json({ message: err.message });
      throw err;
    }
  },

  // ── Floor plan upload ─────────────────────────────────────────────────────
  async uploadFloorPlan(req, res) {
    const { floor_plan_data, floor_plan_url } = req.body;
    try {
      const floor = await svc.uploadFloorPlan({ id: req.params.id, siteId: getSiteId(req), floorPlanUrl: floor_plan_url, floorPlanData: floor_plan_data });
      wsManager.broadcastDeviceChange(req);
      res.json(floor);
    } catch (err) {
      if (err instanceof NotFoundError) return res.status(404).json({ message: err.message });
      throw err;
    }
  },

  // ── Full hierarchy ────────────────────────────────────────────────────────
  async getFullHierarchy(req, res) {
    const data = await svc.getFullHierarchy(getSiteId(req));
    res.json(data);
  },

  // ── Edge devices ──────────────────────────────────────────────────────────
  async listEdgeDevices(req, res) {
    const siteId = getSiteId(req);
    const data = await svc.listEdgeDevices({ tenantId: getTenantId(req), siteId });
    res.json({ data });
  },

  async decommissionEdgeDevice(req, res) {
    try {
      await svc.decommissionEdgeDevice({ code: req.params.code, tenantId: getTenantId(req) }, req);
      wsManager.broadcastDeviceChange(req);
      res.json({ success: true });
    } catch (err) {
      if (err instanceof NotFoundError) return res.status(404).json({ message: err.message });
      throw err;
    }
  },

  // ── Telemetry ─────────────────────────────────────────────────────────────
  async getTelemetryHistory(req, res) {
    const history = await svc.getTelemetryHistory(getSiteId(req));
    res.json({ history });
  },

  // ── Analytics / heatmaps ──────────────────────────────────────────────────
  async getActivityHeatmap(req, res) {
    const tenantId = getTenantId(req);
    const tz = String(req.query.tz || 'UTC');
    if (!(await svc.validateTimezone(tz))) return res.status(400).json({ error: `invalid timezone: ${tz}` });

    const isoDate = /^\d{4}-\d{2}-\d{2}$/;
    const toDate = isoDate.test(String(req.query.toDate)) ? String(req.query.toDate) : null;
    const fromDate = isoDate.test(String(req.query.fromDate)) ? String(req.query.fromDate) : null;

    const { maxCell, devices } = await svc.getActivityHeatmap({ tenantId, tz, fromDate, toDate });
    res.json({ tz, fromDate, toDate, maxCell, devices });
  },

  async getEmployeeCameraHeatmap(req, res) {
    const tenantId = getTenantId(req);
    const siteId = getSiteId(req);
    const tz = String(req.query.tz || 'UTC');
    if (!(await svc.validateTimezone(tz))) return res.status(400).json({ error: `invalid timezone: ${tz}` });

    const isoDate = /^\d{4}-\d{2}-\d{2}$/;
    const date = isoDate.test(String(req.query.date)) ? String(req.query.date) : null;
    const employeeId = parseInt(String(req.query.employeeId), 10);
    if (!date || isNaN(employeeId)) {
      return res.status(400).json({ error: 'employeeId and date (YYYY-MM-DD) are required' });
    }

    const { maxCell, totalPunches, activeHours, cameras } = await svc.getEmployeeCameraHeatmap({ tenantId, siteId, employeeId, tz, date });
    res.json({ tz, date, maxCell, totalPunches, activeHours, cameras });
  },

  async getActivityByDay(req, res) {
    const tenantId = getTenantId(req);
    const tz = String(req.query.tz || 'UTC');
    if (!(await svc.validateTimezone(tz))) return res.status(400).json({ error: `invalid timezone: ${tz}` });

    const isoDate = /^\d{4}-\d{2}-\d{2}$/;
    const toDate = isoDate.test(String(req.query.toDate)) ? String(req.query.toDate) : null;
    const fromDate = isoDate.test(String(req.query.fromDate)) ? String(req.query.fromDate) : null;
    if (!fromDate || !toDate) return res.status(400).json({ error: 'fromDate and toDate (YYYY-MM-DD) are required' });

    const { days, maxCell, devices } = await svc.getActivityByDay({ tenantId, tz, fromDate, toDate });
    res.json({ tz, fromDate, toDate, days, maxCell, devices });
  },

  async getZoneHeatmap(req, res) {
    const tenantId = getTenantId(req);
    const siteId = getSiteId(req);
    const tz = String(req.query.tz || 'UTC');
    if (!(await svc.validateTimezone(tz))) return res.status(400).json({ error: `invalid timezone: ${tz}` });

    const isoDate = /^\d{4}-\d{2}-\d{2}$/;
    const date = isoDate.test(String(req.query.date)) ? String(req.query.date) : null;

    const { maxCell, zones } = await svc.getZoneHeatmap({ tenantId, siteId, tz, date });
    res.json({ tz, date: date || null, maxCell, zones });
  },
};

export default DeviceHierarchyController;
