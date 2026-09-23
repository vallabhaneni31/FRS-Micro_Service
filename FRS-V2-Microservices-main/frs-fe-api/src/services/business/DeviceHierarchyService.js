/**
 * DeviceHierarchyService.js — business logic extracted from deviceRoutes.js.
 * Site → Building → Floor → Zone → NUG Box → Camera hierarchy management,
 * plus device-authenticated heartbeat/enrollment-polling endpoints used by
 * live Jetson edge devices, and analytics/heatmap read endpoints.
 * Backed by repositories/facilityDeviceRepository.js.
 */
import path from 'path';
import { writeAudit } from '../../middleware/auditLog.js';
import wsManager from '../../websocket/index.js';
import { validateIp, validateNugIp } from '../../utils/validateIp.js';
import logger from '../../utils/logger.js';
import * as repo from '../../repositories/facilityDeviceRepository.js';

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.statusCode = 404;
  }
}

export class ForbiddenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ForbiddenError';
    this.statusCode = 403;
  }
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

// ============================================================================
// BACKGROUND MAINTENANCE
// ============================================================================

const PING_RETENTION_DAYS = parseInt(process.env.ATTENDANCE_PING_RETENTION_DAYS || '90', 10);

export function startMaintenanceTasks() {
  setInterval(async () => {
    try {
      await repo.cleanupOldTelemetryHistory();
    } catch (err) {
      logger.error('[Device Maintenance] History cleanup failed:', err.message);
    }
    try {
      await repo.cleanupOldPresencePings(PING_RETENTION_DAYS);
    } catch (err) {
      logger.error('[Device Maintenance] Presence ping cleanup failed:', err.message);
    }
  }, 10 * 60 * 1000); // Run every 10 minutes
}

// ============================================================================
// TOP-LEVEL LIST
// ============================================================================

export async function listAllDevices(tenantId) {
  const [cameras, nugs] = await Promise.all([
    repo.listCamerasForTenant(tenantId),
    repo.listNugBoxesForTenant(tenantId),
  ]);
  return [...cameras, ...nugs];
}

// ============================================================================
// BUILDINGS
// ============================================================================

export async function listBuildings(siteId) {
  return repo.listBuildings(siteId);
}

export async function createBuilding({ siteId, name, address }, req) {
  const building = await repo.createBuilding({ siteId, name, address });
  await writeAudit({ req, action: 'building.create', details: `Building created: ${name}` });
  return building;
}

export async function updateBuilding({ id, siteId, name, address }) {
  const building = await repo.updateBuilding({ id, siteId, name, address });
  if (!building) throw new NotFoundError('Not found');
  return building;
}

export async function deleteBuilding({ id, siteId }) {
  const deleted = await repo.deleteBuilding({ id, siteId });
  if (!deleted) throw new NotFoundError('Not found');
}

// ============================================================================
// FLOORS
// ============================================================================

export async function listFloorsForBuilding(buildingId, siteId) {
  return repo.listFloorsForBuilding(buildingId, siteId);
}

export async function createFloor({ buildingId, siteId, floorNumber, floorName }) {
  const owned = await repo.findBuildingForSite(buildingId, siteId);
  if (!owned) throw new NotFoundError('Building not found');
  return repo.createFloor({ buildingId, floorNumber, floorName });
}

export async function listFloorsForSite(siteId) {
  return repo.listFloorsForSite(siteId);
}

export async function createFloorForSite({ siteId, floorNumber, floorName }) {
  return repo.createFloorForSite({ siteId, floorNumber, floorName });
}

export async function updateFloor({ id, siteId, floorName, floorNumber, floorPlanUrl, floorPlanData }) {
  const owned = await repo.findFloorOwnedBySite(id, siteId);
  if (!owned) throw new NotFoundError('Not found');
  const floor = await repo.updateFloor({ id, siteId, floorName, floorNumber, floorPlanUrl, floorPlanData });
  if (!floor) throw new NotFoundError('Not found');
  return floor;
}

export async function deleteFloor({ id, siteId }) {
  const deleted = await repo.deleteFloor({ id, siteId });
  if (!deleted) throw new NotFoundError('Not found');
}

export async function uploadFloorPlan({ id, siteId, floorPlanUrl, floorPlanData }) {
  const owned = await repo.findFloorOwnedBySite(id, siteId);
  if (!owned) throw new NotFoundError('Floor not found');
  const floor = await repo.updateFloorPlan({ id, siteId, floorPlanUrl, floorPlanData });
  if (!floor) throw new NotFoundError('Floor not found');
  return floor;
}

// ============================================================================
// ZONES
// ============================================================================

export async function listZonesForFloor(floorId, siteId) {
  return repo.listZonesForFloor(floorId, siteId);
}

export async function createZone({ floorId, siteId, zoneName, zoneType }) {
  const owned = await repo.findFloorOwnedBySite(floorId, siteId);
  if (!owned) throw new NotFoundError('Floor not found');
  return repo.createZone({ floorId, zoneName, zoneType });
}

export async function deleteZone({ id, siteId }) {
  const deleted = await repo.deleteZone({ id, siteId });
  if (!deleted) throw new NotFoundError('Not found');
}

// ============================================================================
// NUG BOXES
// ============================================================================

export async function listNugBoxes({ siteId, tenantId }) {
  return repo.listNugBoxes({ siteId, tenantId });
}

export async function getNugBox({ id, tenantId, isSuperAdmin }) {
  const owner = await repo.getNugBoxWithTenant(id);
  if (!owner) throw new NotFoundError('Not found');
  if (!isSuperAdmin && tenantId !== owner.fk_tenant_id) {
    throw new ForbiddenError('Forbidden: NUG box belongs to another tenant');
  }
  const nug = await repo.getNugBoxWithCameras(id);
  if (!nug) throw new NotFoundError('Not found');
  return nug;
}

export async function createNugBox(fields, req) {
  let resolvedSiteId = fields.siteId;
  if (!resolvedSiteId) {
    resolvedSiteId = await repo.findFirstSiteForTenant(fields.tenantId);
  }

  const nug = await repo.createNugBox({ ...fields, siteId: resolvedSiteId });
  await writeAudit({ req, action: 'nug.create', details: `NUG Box created: ${fields.name} (${fields.ipAddress})` });

  // Mirror into facility_device — the canonical, tenant-scoped registry the
  // fleet UI now reads. Keeps manually-provisioned nodes visible alongside
  // ZTP-activated devices under one source of truth.
  if (fields.deviceCode) {
    await repo.upsertFacilityDeviceForNug({
      tenantId: fields.tenantId, siteId: resolvedSiteId, deviceCode: fields.deviceCode,
      name: fields.name, ipAddress: fields.ipAddress, port: fields.port,
      floorId: fields.floorId,
    }).catch(e => logger.error('[nug→facility_device sync]', e.message));
  }

  return nug;
}

export async function updateNugBox(fields, req) {
  const owner = await repo.getNugBoxWithTenant(fields.id);
  if (!owner) throw new NotFoundError('Not found');
  if (!fields.isSuperAdmin && fields.tenantId !== owner.fk_tenant_id) {
    throw new ForbiddenError('Forbidden: NUG box belongs to another tenant');
  }

  const nug = await repo.updateNugBox(fields);
  if (!nug) throw new NotFoundError('Not found');

  await writeAudit({
    req,
    action: 'device.config_update',
    details: `Updated configuration for NUG box: ${nug.name} (ID: ${fields.id})`,
    entityType: 'device',
    entityId: fields.id,
    source: 'api',
  }).catch(() => {});

  return nug;
}

export async function deleteNugBox({ id, tenantId, isSuperAdmin }, req) {
  const owner = await repo.getNugBoxWithTenant(id);
  if (!owner) throw new NotFoundError('Not found');
  if (!isSuperAdmin && tenantId !== owner.fk_tenant_id) {
    throw new ForbiddenError('Forbidden: NUG box belongs to another tenant');
  }

  const name = (await repo.getNugBoxName(id)) ?? id;
  await repo.deleteNugBox(id);

  await writeAudit({
    req,
    action: 'device.delete',
    details: `Deleted NUG box: ${name} (ID: ${id})`,
    entityType: 'device',
    entityId: id,
    source: 'api',
  }).catch(() => {});
}

export async function pingNugBox(id) {
  const conn = await repo.getNugBoxConnection(id);
  if (!conn) throw new NotFoundError('Not found');
  const { ip_address, port } = conn;
  if (!validateNugIp(ip_address)) {
    const err = new ValidationError('Private or invalid IP address restricted');
    err.statusCode = 422;
    throw err;
  }
  try {
    const start = Date.now();
    const resp = await fetch(`https://${ip_address}:${port}/health`, { signal: AbortSignal.timeout(5000) });
    const data = await resp.json();
    const latency = Date.now() - start;
    await repo.markNugBoxOnline(id);
    return { online: true, latency_ms: latency, data };
  } catch (e) {
    await repo.markNugBoxOffline(id);
    return { online: false, error: e.message };
  }
}

export async function rebootNugBox({ id, tenantId, isSuperAdmin }, req) {
  const nug = await repo.getNugBoxWithTenant(id);
  if (!nug) throw new NotFoundError('NUG box not found');

  if (!isSuperAdmin && tenantId !== nug.fk_tenant_id) {
    throw new ForbiddenError('Forbidden: NUG box belongs to another tenant');
  }

  if (!validateNugIp(nug.ip_address)) {
    const err = new ValidationError('Private or invalid IP address restricted');
    err.statusCode = 422;
    throw err;
  }

  // Write audit log BEFORE forwarding command
  await writeAudit({ req, action: 'device.reboot', details: `Reboot command sent to NUG box: ${nug.name} (IP: ${nug.ip_address})` });

  try {
    await fetch(`https://${nug.ip_address}:${nug.port}/reboot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    await repo.markNugBoxRebooting(id);
    return { success: true, message: `Reboot command sent to ${nug.name}` };
  } catch (e) {
    const err = new Error(`Could not reach device: ${e.message}`);
    err.statusCode = 503;
    throw err;
  }
}

export async function applyNugBoxConfig({ id, tenantId, isSuperAdmin }, req) {
  const nug = await repo.getNugBoxWithTenant(id);
  if (!nug) throw new NotFoundError('Not found');

  if (!isSuperAdmin && tenantId !== nug.fk_tenant_id) {
    throw new ForbiddenError('Forbidden: NUG box belongs to another tenant');
  }

  if (!validateNugIp(nug.ip_address)) {
    const err = new ValidationError('Private or invalid IP address restricted');
    err.statusCode = 422;
    throw err;
  }

  // Write audit log BEFORE forwarding config
  await writeAudit({ req, action: 'device.config_push', details: `Config pushed to NUG box: ${nug.name} (IP: ${nug.ip_address})` });

  try {
    const resp = await fetch(`https://${nug.ip_address}:${nug.port}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        match_threshold: Number(nug.match_threshold),
        conf_threshold: Number(nug.conf_threshold),
        cooldown_seconds: nug.cooldown_seconds,
        direction: { x_threshold: nug.x_threshold, tracking_window: nug.tracking_window },
      }),
      signal: AbortSignal.timeout(5000),
    });
    return { success: resp.ok, status: resp.status };
  } catch (e) {
    const err = new Error(e.message);
    err.statusCode = 503;
    throw err;
  }
}

// ============================================================================
// HEARTBEATS (device-authenticated, called by live Jetson devices)
// ============================================================================

export async function cameraHeartbeat(camId, status) {
  await repo.updateCameraHeartbeat(camId, status);
}

/**
 * NUG box heartbeat, called directly by live Jetson devices every few
 * seconds. Resolves the Jetson's reachable IP (body-reported, else the
 * request's source IP), updates frs_nug_box + facility_device + any
 * per-camera stats, then pushes a real-time WebSocket delta.
 *
 * @param {string} code - device_code / external_device_id from the URL
 * @param {object} body - the heartbeat payload
 * @param {string} sourceIp - req.ip, pre-stripped of the ::ffff: IPv6-mapped prefix
 * @param {string|null} tenantId
 */
export async function nugBoxHeartbeat(code, body, sourceIp, tenantId) {
  const { status, cpu_percent, memory_used_mb, memory_total_mb, gpu_percent,
          temperature_c, disk_used_gb, disk_total_gb, disk_free_gb,
          uptime_seconds, cameras, ip_address: reportedIp } = body;

  const resolvedIp = (reportedIp && reportedIp !== '0.0.0.0' && reportedIp.trim() !== '')
    ? reportedIp.trim()
    : (sourceIp && sourceIp !== '127.0.0.1' ? sourceIp : null);

  const heartbeatFields = {
    status, cpuPercent: cpu_percent, memoryUsedMb: memory_used_mb, memoryTotalMb: memory_total_mb,
    gpuPercent: gpu_percent, temperatureC: temperature_c, diskUsedGb: disk_used_gb,
    diskTotalGb: disk_total_gb, diskFreeGb: disk_free_gb, uptimeSeconds: uptime_seconds, resolvedIp,
  };

  const rows = await repo.updateNugBoxHeartbeat(code, heartbeatFields);
  await repo.syncFacilityDeviceHeartbeat(code, heartbeatFields);

  if (cameras && Array.isArray(cameras)) {
    for (const cam of cameras) {
      await repo.updateCameraStatsFromHeartbeat(cam);
    }
    await repo.updateEdgeNodeStatsFromCameras(code);
  }

  if (rows.length) {
    wsManager.broadcastSingleDevice(tenantId, code).catch(() => {});
    if (cameras && Array.isArray(cameras)) {
      cameras.forEach(cam => {
        wsManager.broadcastSingleDevice(tenantId, cam.cam_id).catch(() => {});
      });
    }
  }
}

// ============================================================================
// ENROLLMENT QUALITY (Jetson polling)
// ============================================================================

export async function listPendingEnrollments(code) {
  const tenantId = await repo.findTenantForDeviceCode(code);
  if (!tenantId) return [];

  const rows = await repo.listInvitationsPendingQuality(tenantId);

  const baseUrl = (process.env.PUBLIC_BASE_URL || 'https://frs.motivitylabs.com').replace(/\/$/, '');
  const pending = [];
  for (const inv of rows) {
    const photos = inv.photo_paths || {};
    const qualities = inv.quality_scores || {};
    for (const [angle, photoPath] of Object.entries(photos)) {
      if (qualities[angle] === null) {
        // Return a full absolute public URL — the Jetson downloads without a JWT header
        // so we must use the unauthenticated public /uploads/ path, not the JWT-gated endpoint.
        const filename = path.basename(photoPath);
        pending.push({
          invitation_id: inv.pk_invitation_id,
          angle,
          photo_url: `${baseUrl}/uploads/remote-enrollment/${filename}`,
        });
      }
    }
  }
  return pending;
}

export async function pushEnrollmentQuality(results) {
  let updated = 0;
  for (const { invitation_id, angle, confidence } of results) {
    if (!invitation_id || !angle || typeof confidence !== 'number') continue;

    const inv = await repo.getInvitationQuality(invitation_id);
    if (!inv) continue;

    const qualities = inv.quality_scores || {};
    qualities[angle] = confidence;

    const scored = Object.values(qualities).filter(v => v !== null);
    const avgQuality = scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null;

    const allScored = Object.values(qualities).every(v => v !== null);

    let newApprovalStatus = null;
    if (allScored && avgQuality !== null) {
      newApprovalStatus = 'pending';
    }

    await repo.updateInvitationQuality(invitation_id, { qualities, avgQuality, newApprovalStatus });
    logger.info(`✅ Jetson quality: invitation=${invitation_id} angle=${angle} confidence=${confidence} avg=${avgQuality?.toFixed(3)} allScored=${allScored}`);
    updated++;
  }
  return updated;
}

// ============================================================================
// CAMERAS
// ============================================================================

export async function listCameras(nugId) {
  return repo.listCameras(nugId);
}

export async function createCamera(fields, req, client) {
  // 1. Resolve the parent facility_device pk.
  //    The frontend now sends parent_device_pk (pk_device_id of the edge node).
  //    We also support the legacy fk_nug_id path for backwards compatibility.
  let parentDeviceId = fields.parentDevicePk ? parseInt(fields.parentDevicePk, 10) : null;
  if (!parentDeviceId && fields.nugId) {
    const deviceCode = await repo.findNugDeviceCode(client, fields.nugId);
    if (deviceCode) {
      parentDeviceId = await repo.findFacilityDeviceByExternalId(client, fields.tenantId, deviceCode);
    }
  }

  // If parent device has a floor assigned, let the camera inherit it
  if (parentDeviceId && !fields.floorId) {
    const parentDev = await repo.findFacilityDeviceByIdTx(client, fields.tenantId, parentDeviceId);
    if (parentDev && parentDev.fk_floor_id) {
      fields.floorId = parentDev.fk_floor_id;
    }
  }

  // 2. Resolve a human-readable location label (zone → floor → 'Not set')
  //    DB column now has DEFAULT 'Not set' so this is belt-and-suspenders.
  let locationLabel = 'Not set';
  if (fields.zoneId) {
    locationLabel = (await repo.getZoneNameTx(client, fields.zoneId)) ?? 'Not set';
  } else if (fields.floorId) {
    locationLabel = (await repo.getFloorNameTx(client, fields.floorId)) ?? 'Not set';
  }

  // 3. Safe defaults for NOT NULL columns
  const safeIp = (fields.ipAddress?.trim() || '0.0.0.0');

  // 4. Look up the camera device_type_id (category = 'camera')
  const cameraDeviceTypeId = await repo.getCameraDeviceTypeId(client);

  const safeCameraMode = ['IN', 'OUT', 'MIXED'].includes(fields.cameraMode) ? fields.cameraMode : 'MIXED';

  // 5. Insert camera record into frs_camera
  const camera = await repo.insertCamera(client, fields);

  // 6. Mirror into facility_device (fleet overview / heartbeat hierarchy table)
  //    device_type_id marks it as a camera so the edge-devices query can treat it as a child.
  await repo.upsertFacilityDeviceForCamera(client, {
    tenantId: fields.tenantId, customerId: fields.customerId, siteId: fields.siteId,
    camId: fields.camId, name: fields.name, ipAddress: safeIp, model: fields.model || 'IP Camera',
    locationLabel, parentDeviceId, cameraDeviceTypeId, cameraMode: safeCameraMode, floorId: fields.floorId,
  });

  writeAudit({ req, action: 'camera.create', details: `Camera created: ${fields.name} (${fields.camId})` }).catch(() => {});

  return camera;
}

export async function updateCamera(fields, req, client) {
  const existing = await repo.findCameraForUpdate(client, fields.id, fields.tenantId);
  if (!existing) throw new NotFoundError('Not found');
  const oldCamId = existing.cam_id;

  if (fields.siteId && !(await repo.siteBelongsToTenant(fields.siteId, fields.tenantId))) {
    throw new ValidationError('site does not belong to this tenant');
  }

  const camera = await repo.updateCamera(client, fields);

  // Re-resolve location_label from the updated row's zone/floor
  const resolvedZoneId = camera.fk_zone_id;
  const resolvedFloorId = camera.fk_floor_id;
  let locationLabel = 'Not set';
  if (resolvedZoneId) {
    locationLabel = (await repo.getZoneNameTx(client, resolvedZoneId)) ?? 'Not set';
  } else if (resolvedFloorId) {
    locationLabel = (await repo.getFloorNameTx(client, resolvedFloorId)) ?? 'Not set';
  }

  // Resolve parent facility_device row
  let parentDeviceId = null;
  const resolvedNugId = camera.fk_nug_id;
  if (resolvedNugId) {
    const deviceCode = await repo.findNugDeviceCode(client, resolvedNugId);
    if (deviceCode) {
      parentDeviceId = await repo.findFacilityDeviceByExternalId(client, fields.tenantId, deviceCode);
    }
  }

  const safeCameraMode = ['IN', 'OUT', 'MIXED'].includes(fields.cameraMode) ? fields.cameraMode : null;

  // Sync to facility_device
  await repo.syncFacilityDeviceForCameraUpdate(client, {
    tenantId: fields.tenantId, newCamId: camera.cam_id, name: camera.name,
    ipAddress: fields.ipAddress, model: fields.model, locationLabel, parentDeviceId,
    oldCamId, cameraMode: safeCameraMode,
    // Explicit only — omitting these in the request leaves the camera's
    // current site/customer untouched (see syncFacilityDeviceForCameraUpdate).
    siteId: fields.siteId ?? null, customerId: fields.customerId ?? null,
  });

  return camera;
}

export async function updateCameraMode({ cameraMode, camId, tenantId }) {
  if (!['IN', 'OUT', 'MIXED'].includes(cameraMode)) {
    throw new ValidationError('camera_mode must be IN, OUT, or MIXED');
  }
  const result = await repo.updateCameraModeByExternalOrPk({ cameraMode, camId, tenantId });
  if (!result) throw new NotFoundError('Camera not found');
  return result;
}

export async function deleteCamera(id, tenantId, client) {
  const camId = await repo.findCameraCamId(client, id, tenantId);
  await repo.deleteCamera(client, id, camId);
  await repo.deleteFacilityDeviceByExternalId(client, camId, tenantId, id);
}

// Edge-box-initiated reconciliation: the box pushes what it currently has
// configured for its own attached cameras, and this becomes the app's
// record going forward — after this one-time catch-up, the normal
// GET /api/cameras pull-sync (device polls the app) is what keeps things
// in sync day to day. Never deletes a camera absent from the payload —
// that's reported back instead, since "not in this push" could just mean
// the box's local scan didn't currently see it, not that it's gone.
export async function syncCamerasFromDevice({ tenantId, parentDeviceId, cameras }, client) {
  const parentScope = await repo.getParentDeviceScope(client, parentDeviceId, tenantId);
  if (!parentScope) throw new NotFoundError('Calling device not found');

  const existingCodes = new Set(await repo.listChildCameraCodes(client, parentDeviceId, tenantId));
  const seenCodes = new Set();
  const results = { created: [], updated: [], failed: [] };

  for (const cam of cameras) {
    const code = cam.code || cam.external_device_id;
    if (!code) {
      results.failed.push({ code: null, reason: 'missing code' });
      continue;
    }
    seenCodes.add(code);

    const cfg = cam.config || {};
    const cameraMode = cfg.role === 'exit' ? 'OUT' : cfg.role === 'entry' ? 'IN'
      : ['IN', 'OUT', 'MIXED'].includes(cam.camera_mode) ? cam.camera_mode : 'MIXED';

    try {
      const outcome = await repo.upsertCameraFromDeviceSync(client, {
        tenantId,
        customerId: parentScope.customer_id,
        siteId: parentScope.site_id,
        floorId: parentScope.fk_floor_id,
        parentDeviceId,
        code,
        name: cam.name || code,
        locationLabel: cam.location,
        ipAddress: cam.ipAddress || cam.ip_address,
        model: cam.model,
        cameraMode,
        rtspUrl: cfg.rtsp_url,
        deviceConfig: {
          role: cfg.role,
          enabled: cfg.enabled,
          fps_target: cfg.fps_target,
          width: cfg.width,
          height: cfg.height,
          hw_decode: cfg.hw_decode,
          ...(cfg.MaskIn ? { MaskIn: cfg.MaskIn } : {}),
          ...(cfg.MaskOut ? { MaskOut: cfg.MaskOut } : {}),
          ...(cfg.notes ? { notes: cfg.notes } : {}),
          ...(cfg.threshold !== undefined ? { threshold: cfg.threshold } : {}),
          ...(cfg.cooldown !== undefined ? { cooldown: cfg.cooldown } : {}),
        },
      });
      results[outcome].push(code);
    } catch (err) {
      logger.error({ err, code }, '[syncCamerasFromDevice] Failed to upsert camera');
      results.failed.push({ code, reason: err.message });
    }
  }

  const notInPayload = [...existingCodes].filter(code => !seenCodes.has(code));

  return { ...results, notInPayload };
}

export async function captureFrame(id) {
  const conn = await repo.getCameraWithNugConnection(id);
  if (!conn) throw new NotFoundError('Camera not found');
  const { cam_id, nug_ip, nug_port } = conn;
  if (!nug_ip) {
    const err = new Error('Camera not attached to an Edge Node');
    err.statusCode = 503;
    throw err;
  }
  if (!validateNugIp(nug_ip)) {
    const err = new ValidationError('Private or invalid IP address restricted');
    err.statusCode = 422;
    throw err;
  }
  try {
    const resp = await fetch(`https://${nug_ip}:${nug_port || 5000}/camera/${cam_id}/capture`, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`Edge Node returned ${resp.status}`);
    const data = await resp.json();
    return { image: data.image };
  } catch (e) {
    const err = new Error(`Edge Node unreachable: ${e.message}`);
    err.statusCode = 503;
    throw err;
  }
}

export async function getCameraStreamTarget(id) {
  const conn = await repo.getCameraWithNugConnection(id);
  if (!conn) throw new NotFoundError('Camera not found');
  const { cam_id, nug_ip, nug_port } = conn;
  if (!nug_ip) {
    const err = new Error('Camera not attached to an Edge Node');
    err.statusCode = 503;
    throw err;
  }
  if (!validateNugIp(nug_ip)) {
    const err = new ValidationError('Private or invalid IP address restricted');
    err.statusCode = 422;
    throw err;
  }
  return { cam_id, nug_ip, nug_port };
}

export async function pingCamera(id) {
  const ip = await repo.getCameraIp(id);
  if (ip === null) throw new NotFoundError('Not found');

  if (!validateIp(ip)) {
    const err = new ValidationError('Invalid IP address format');
    err.statusCode = 422;
    throw err;
  }

  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  try {
    await execFileAsync('ping', ['-c', '1', '-W', '2', ip], { timeout: 5000 });
    await repo.markCameraOnline(id);
    return { online: true };
  } catch (e) {
    await repo.markCameraOffline(id);
    return { online: false, error: e.message };
  }
}

// ============================================================================
// FULL HIERARCHY (for UI)
// ============================================================================

export async function getFullHierarchy(siteId) {
  return repo.getFullHierarchy(siteId);
}

// ============================================================================
// EDGE DEVICES (unified fleet view)
// ============================================================================

export async function listEdgeDevices({ tenantId, siteId }) {
  const offlineMin = parseInt(process.env.DEVICE_OFFLINE_THRESHOLD_MIN || '5', 10);
  return repo.listEdgeDevices({ tenantId, siteId, offlineMin });
}

export async function decommissionEdgeDevice({ code, tenantId }, req) {
  const device = await repo.decommissionEdgeDevice({ code, tenantId });
  if (!device) throw new NotFoundError('Device not found');

  // Cascade-remove the operational hierarchy if this device has a nug box.
  await repo.deleteNugBoxByDeviceCode(code);

  await writeAudit({
    req,
    action: 'device.decommission',
    details: `Decommissioned edge device: ${device.name} (${code})`,
    entityType: 'device',
    entityId: code,
    source: 'api',
  }).catch(() => {});

  return device;
}

// ============================================================================
// TELEMETRY HISTORY
// ============================================================================

export async function getTelemetryHistory(siteId) {
  const rows = await repo.getTelemetryHistory(siteId);

  // Group by NUG ID
  const historyMap = rows.reduce((acc, row) => {
    if (!acc[row.fk_nug_id]) acc[row.fk_nug_id] = [];
    acc[row.fk_nug_id].push({
      time: new Date(row.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      cpu: Number(row.cpu),
      gpu: Number(row.gpu),
      ram: Number(row.ram),
    });
    return acc;
  }, {});

  return historyMap;
}

// ============================================================================
// ANALYTICS / HEATMAPS
// ============================================================================

export async function validateTimezone(tz) {
  return repo.validateTimezone(tz);
}

export async function getActivityHeatmap({ tenantId, tz, fromDate, toDate }) {
  const rows = await repo.getActivityHeatmap({ tenantId, tz, fromDate, toDate });

  const byDevice = new Map();
  let maxCell = 0;
  for (const r of rows) {
    if (!byDevice.has(r.device_code)) {
      byDevice.set(r.device_code, { deviceCode: r.device_code, name: r.name, total: 0, hours: Array(24).fill(0) });
    }
    const d = byDevice.get(r.device_code);
    d.hours[r.hour] = r.cnt;
    d.total += r.cnt;
    if (r.cnt > maxCell) maxCell = r.cnt;
  }

  const devices = Array.from(byDevice.values()).sort((a, b) => b.total - a.total);
  return { maxCell, devices };
}

export async function getEmployeeCameraHeatmap({ tenantId, siteId, employeeId, tz, date }) {
  const rows = await repo.getEmployeeCameraHeatmap({ tenantId, siteId, employeeId, tz, date });

  const byCamera = new Map();
  let maxCell = 0;
  let totalPunches = 0;
  for (const r of rows) {
    const key = r.camera_id;
    if (!byCamera.has(key)) {
      byCamera.set(key, { deviceCode: r.camera_id, name: r.name, total: 0, hours: Array(24).fill(0) });
    }
    const cam = byCamera.get(key);
    cam.hours[r.hour] = r.cnt;
    cam.total += r.cnt;
    totalPunches += r.cnt;
    if (r.cnt > maxCell) maxCell = r.cnt;
  }

  const cameras = Array.from(byCamera.values()).sort((a, b) => b.total - a.total);
  const activeHours = cameras.reduce((sum, c) => sum + c.hours.filter(h => h > 0).length, 0);
  return { maxCell, totalPunches, activeHours, cameras };
}

export async function getActivityByDay({ tenantId, tz, fromDate, toDate }) {
  const rows = await repo.getActivityByDay({ tenantId, tz, fromDate, toDate });

  const days = [];
  for (let d = new Date(fromDate + 'T00:00:00Z'), end = new Date(toDate + 'T00:00:00Z'); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }

  const byDevice = new Map();
  let maxCell = 0;
  for (const r of rows) {
    if (!byDevice.has(r.device_code)) {
      byDevice.set(r.device_code, { deviceCode: r.device_code, name: r.name, total: 0, days: {} });
    }
    const dev = byDevice.get(r.device_code);
    dev.days[r.day] = r.cnt;
    dev.total += r.cnt;
    if (r.cnt > maxCell) maxCell = r.cnt;
  }

  const devices = Array.from(byDevice.values()).sort((a, b) => b.total - a.total);
  return { days, maxCell, devices };
}

export async function getZoneHeatmap({ tenantId, siteId, tz, date }) {
  const rows = await repo.getZoneHeatmap({ tenantId, siteId, tz, date });

  const byZone = new Map();
  let maxCell = 0;
  for (const r of rows) {
    const key = r.zone;
    if (!byZone.has(key)) {
      byZone.set(key, {
        zone: r.zone,
        zoneType: r.zone_type,
        zoneLabel: r.zone_label || null,
        total: 0,
        uniqueEmployees: 0,
        hours: Array(24).fill(0),
      });
    }
    if (r.hour === null) continue; // configured-but-inactive zone, counts stay 0
    const z = byZone.get(key);
    z.hours[r.hour] = r.unique_employees;
    z.total += r.total_pings;
    // Use total_unique_employees (sum across all hours) for the tile display count
    // This shows the real unique-employee-visits for the day, not just the peak hour
    if (r.total_unique_employees > z.uniqueEmployees) z.uniqueEmployees = r.total_unique_employees;
    if (r.unique_employees > maxCell) maxCell = r.unique_employees;
  }

  // Active zones first, then zero-activity zones sorted by name.
  const zones = Array.from(byZone.values()).sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.zone.localeCompare(b.zone);
  });
  return { maxCell, zones };
}
