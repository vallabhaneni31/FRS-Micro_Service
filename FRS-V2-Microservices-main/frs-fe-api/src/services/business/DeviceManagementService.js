/**
 * DeviceManagementService.js — business logic extracted from
 * deviceManagementRoutes.js. Device lifecycle (register/provision/ZTP
 * activate/decommission), heartbeat, site assignment, effective config, and
 * command-queue polling for device-authenticated Jetson clients.
 * Backed by repositories/deviceManagementRepository.js.
 */
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from '../../db/pool.js';
import { writeAudit } from '../../middleware/auditLog.js';
import logger from '../../utils/logger.js';
import * as repo from '../../repositories/deviceManagementRepository.js';
import { getCamerasForDevice } from '../../repositories/facilityDeviceRepository.js';

const DEVICE_JWT_SECRET = process.env.DEVICE_JWT_SECRET;
if (!DEVICE_JWT_SECRET) {
  throw new Error('DEVICE_JWT_SECRET environment variable is required');
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.statusCode = 404;
  }
}

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.statusCode = 409;
  }
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

export class ForbiddenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ForbiddenError';
    this.statusCode = 403;
  }
}

// Returns false (and sets a 403 via the thrown error) if the requesting
// user's scope is locked to a different site than the one being operated on.
// Super admins and tenant admins (no siteId in scope) pass through unconditionally.
export function enforceSiteScope(req, requestedSiteId) {
  const scopedSiteId = req.auth?.scope?.siteId;
  if (scopedSiteId && String(scopedSiteId) !== String(requestedSiteId)) {
    throw new ForbiddenError('Access denied: this operation targets a site outside your scope');
  }
}

// ============================================================================
// OVERVIEW
// ============================================================================

export async function getDeviceSummary(tenantId) {
  return repo.getDeviceSummary(tenantId);
}

// ============================================================================
// DEVICE REGISTRATION
// ============================================================================

export async function registerDevice(fields, client) {
  const existing = await repo.findDeviceByTenantAndCode(client, fields.tenantId, fields.externalDeviceId);
  if (existing) {
    throw new ConflictError('Device with this ID already exists');
  }

  const deviceType = await repo.findDeviceType(client, fields.deviceTypeCode);
  if (!deviceType) {
    throw new ValidationError('Invalid device type code');
  }

  const device = await repo.insertDevice(client, { ...fields, deviceTypeId: deviceType.pk_device_type_id });
  return device;
}

// ============================================================================
// PROVISIONING
// ============================================================================

export async function provisionDevice({ code, tenantId, userId, tokenValidityDays }, req) {
  const device = await repo.findDeviceForProvision(tenantId, code);
  if (!device) throw new NotFoundError('Device not found');

  const deviceSecret = crypto.randomBytes(32).toString('hex');
  const deviceSecretHash = await bcrypt.hash(deviceSecret, 10);

  const expiresInSeconds = tokenValidityDays * 24 * 60 * 60;
  const tokenPayload = {
    device_id: parseInt(device.pk_device_id),
    device_code: device.external_device_id,
    tenant_id: tenantId, // keep as UUID string — parseInt was a bug
    iss: 'frs2-backend',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  };

  const deviceToken = jwt.sign(tokenPayload, DEVICE_JWT_SECRET);
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

  await repo.setDeviceTokenIssued(device.pk_device_id, { deviceSecretHash, expiresAt });

  // Always queue the token in DB so the device can claim it via /api/bootstrap
  // (24-hour window — wide enough for any restart cycle)
  await repo.queueUpdateTokenCommand({ deviceId: device.pk_device_id, token: deviceToken, expiresAt, userId });

  // Best-effort Kafka push — failure does NOT prevent provisioning
  let autoPushed = false;
  try {
    const { publishToKafka } = await import('../kafkaProducer.js');
    await publishToKafka('device-commands', {
      command: 'update_token',
      device_code: device.external_device_id,
      token: deviceToken,
      expires_at: expiresAt.toISOString(),
      timestamp: new Date().toISOString(),
    });
    autoPushed = true;
    logger.info(`Token pushed to device ${device.external_device_id} via Kafka`);
  } catch (pushError) {
    logger.warn({ err: pushError }, 'Kafka push failed — device will bootstrap via /api/bootstrap');
  }

  return { device, deviceToken, expiresAt, autoPushed };
}

// ============================================================================
// HEARTBEAT
// ============================================================================

export async function processHeartbeat({ code, body, device, ip }) {
  const { status = 'online', metrics } = body;
  const deviceId = device?.id;

  // Accept both nested ({ metrics: { cpu_percent } }) and flat ({ cpu_percent }) formats.
  const m = (metrics && typeof metrics === 'object' && Object.keys(metrics).length > 0)
    ? metrics
    : (body || {});

  let realDeviceId = await repo.findDeviceForHeartbeat(code, device?.tenant_id);

  if (!realDeviceId && deviceId) {
    const exists = await repo.findDeviceById(deviceId);
    if (exists) realDeviceId = deviceId;
  }

  if (!realDeviceId) {
    logger.warn(`[heartbeat] Device ${code} not found — skipping`);
    return { success: true, acknowledged_at: new Date().toISOString(), next_heartbeat_seconds: 15, commands_pending: 0, commands: [] };
  }

  await repo.insertHeartbeat({ deviceId: realDeviceId, status, metrics: m, ip });

  const telemetry = {
    cpu_percent: m.cpu_percent ?? null,
    gpu_percent: m.gpu_percent ?? null,
    memory_used_mb: m.memory_used_mb ?? null,
    memory_total_mb: m.memory_total_mb ?? null,
    temperature_c: m.temperature_c ?? m.cpu_temp ?? null,
    disk_used_gb: m.disk_used_gb ?? null,
    disk_total_gb: m.disk_total_gb ?? null,
    disk_free_gb: m.disk_free_gb ?? null,
    uptime_seconds: m.uptime_seconds ?? null,
    load_avg_1m: m.load_avg_1m ?? null,
    fps: m.fps ?? null,
    updated_at: new Date().toISOString(),
  };

  await repo.syncDeviceHeartbeatStatus({ deviceId: realDeviceId, status, telemetry });

  const pendingCommands = await repo.getPendingCommandsForDevice(realDeviceId, 5);

  return {
    success: true,
    acknowledged_at: new Date().toISOString(),
    next_heartbeat_seconds: 15,
    commands_pending: pendingCommands.length,
    commands: pendingCommands,
  };
}

export async function simulateHeartbeat({ code, tenantId }) {
  const metrics = {
    cpu_percent: Number((12 + Math.random() * 15).toFixed(1)),
    gpu_percent: Number((8 + Math.random() * 20).toFixed(1)),
    memory_used_mb: 3200,
    memory_total_mb: 8192,
    temperature_c: Number((41 + Math.random() * 5).toFixed(1)),
    disk_used_gb: 18.5,
    disk_total_gb: 64.0,
    disk_free_gb: 45.5,
    uptime_seconds: 7200,
    load_avg_1m: 0.75,
    fps: 30,
  };
  return processHeartbeat({
    code,
    body: { status: 'online', metrics },
    device: { tenant_id: tenantId },
    ip: '127.0.0.1',
  });
}

// ============================================================================
// LIST / GET / UPDATE / DELETE DEVICES
// ============================================================================

export async function listDevices(params) {
  return repo.listDevices(params);
}

export async function getDeviceDetails(tenantId, code) {
  const device = await repo.getDeviceDetails(tenantId, code);
  if (!device) throw new NotFoundError('Device not found');

  const [siteAssignments, latestHeartbeat, statusHistory, childDevices] = await Promise.all([
    repo.getSiteAssignmentsForDevice(device.pk_device_id),
    repo.getLatestHeartbeat(device.pk_device_id),
    repo.getStatusHistory(device.pk_device_id),
    repo.getChildDevices(device.pk_device_id),
  ]);

  return {
    device,
    site_assignments: siteAssignments,
    latest_heartbeat: latestHeartbeat || null,
    status_history: statusHistory,
    child_devices: childDevices,
  };
}

const ALLOWED_ZONES = ['work', 'break', 'other', 'unassigned'];

export async function updateDevice({ tenantId, code, name, locationLabel, ipAddress, deviceConfig, notes, zoneType, zoneLabel, floorId }) {
  if (zoneType !== undefined && !ALLOWED_ZONES.includes(zoneType)) {
    throw new ValidationError(`zone_type must be one of ${ALLOWED_ZONES.join(', ')}`);
  }

  const existing = await repo.findDeviceByTenantCode(tenantId, code);
  if (!existing) throw new NotFoundError('Device not found');

  const updates = [];
  const params = [];
  let paramIndex = 1;

  const push = (column, value) => {
    updates.push(`${column} = $${paramIndex}`);
    params.push(value);
    paramIndex++;
  };

  if (name !== undefined) push('name', name);
  if (locationLabel !== undefined) push('location_label', locationLabel);
  if (ipAddress !== undefined) push('ip_address', ipAddress);
  if (deviceConfig !== undefined) {
    updates.push(`device_config = $${paramIndex}::jsonb`);
    params.push(JSON.stringify(deviceConfig));
    paramIndex++;
  }
  if (notes !== undefined) push('device_notes', notes);
  if (zoneType !== undefined) push('zone_type', zoneType);
  if (zoneLabel !== undefined) push('zone_label', zoneLabel);
  if (floorId !== undefined) {
    const val = (floorId === null || floorId === 0 || floorId === 'unassigned') ? null : parseInt(floorId, 10);
    push('fk_floor_id', val);
  }

  if (updates.length === 0) {
    throw new ValidationError('No fields to update');
  }

  return repo.updateDeviceFields(existing.pk_device_id, { updates, params });
}

export async function deleteDevice({ tenantId, code }, req) {
  const device = await repo.findDeviceForDelete(tenantId, code);
  if (!device) throw new NotFoundError('Device not found');

  const deviceId = device.pk_device_id;

  await repo.decommissionDevice(deviceId, req.auth?.user?.id);
  await repo.deactivateSiteAssignmentsForDevice(deviceId);

  await writeAudit({
    req,
    action: 'device.decommission',
    details: `Decommissioned device (external code: ${code}, ID: ${deviceId})`,
    entityType: 'device',
    entityId: String(deviceId),
    source: 'api',
  }).catch(err => logger.error('[device-management] decommission audit log failed:', err.message));

  return deviceId;
}

// ============================================================================
// SITE ASSIGNMENT
// ============================================================================

export async function assignDeviceToSite({ siteId, deviceCode, deviceRole, zoneName, tenantId, userId }, client) {
  const site = await repo.findSiteForTenant(client, siteId, tenantId);
  if (!site) throw new NotFoundError('Site not found');

  const device = await repo.findDeviceByCodeTx(client, tenantId, deviceCode);
  if (!device) throw new NotFoundError('Device not found');

  const deviceId = device.pk_device_id;

  // One active site per device — the Tenant Admin hierarchy view (edge
  // nodes/cameras/zones) only ever shows a device under a single site, so a
  // device left "active" on its previous site after being reassigned here
  // leaked that device's zone activity into both sites on HR-facing
  // dashboards even though the admin UI showed it under the new site only.
  // Keep facility_device.site_id (what the hierarchy view trusts) and
  // site_device_assignment (what HR-portal queries fall back to) in sync.
  await repo.setDevicePrimarySite(client, deviceId, siteId);
  await repo.deactivateOtherActiveSiteAssignments(client, deviceId, siteId);

  const existingAssignment = await repo.findExistingAssignment(client, deviceId, siteId);

  if (existingAssignment) {
    const updated = await repo.updateAssignmentRoleZone(client, { deviceRole, zoneName, deviceId, siteId });
    return {
      updated: true,
      assignment: { ...updated, site_name: site.site_name, device_code: device.external_device_id, device_name: device.name },
    };
  }

  const assignment = await repo.insertSiteAssignment(client, { siteId, deviceId, deviceRole, zoneName, userId });
  return {
    updated: false,
    assignment: { ...assignment, site_name: site.site_name, device_code: device.external_device_id, device_name: device.name },
  };
}

export async function listSiteDevices({ siteId, tenantId }) {
  const belongs = await repo.findSiteBelongingToTenant(siteId, tenantId);
  if (!belongs) throw new NotFoundError('Site not found');
  return repo.listSiteDevices(siteId);
}

export async function unassignDevice({ siteId, deviceCode, reason, tenantId, userId }) {
  const device = await repo.findDeviceByTenantCode(tenantId, deviceCode);
  if (!device) throw new NotFoundError('Device not found');

  const result = await repo.unassignDeviceFromSite({
    userId, reason: reason || 'Manual unassignment', siteId, deviceId: device.pk_device_id,
  });
  if (!result) throw new NotFoundError('Device is not assigned to this site');
  return result;
}

// ============================================================================
// EFFECTIVE CONFIG
// ============================================================================

export async function getEffectiveConfig(tenantId, deviceCode) {
  const device = await repo.findDeviceByTenantCode(tenantId, deviceCode);
  if (!device) throw new NotFoundError('Device not found');

  const config = await repo.getEffectiveConfig(device.pk_device_id);
  return { deviceId: device.pk_device_id, config };
}

export async function getEffectiveConfigForDevicePolling(deviceId, code, tenantId) {
  let id = deviceId;
  if (!id && code) {
    const res = await pool.query('SELECT pk_device_id FROM facility_device WHERE external_device_id = $1', [code]);
    if (res.rows[0]) id = res.rows[0].pk_device_id;
  }
  if (!id) throw new NotFoundError('Device not found or no config available');
  const config = await repo.getEffectiveConfig(id);

  // The device's single config poll is the only call some firmware makes —
  // cameras used to be invisible to it entirely (a separate endpoint,
  // GET /api/cameras, that assumed a second poller existed). Folding the
  // same camera list in here means one poll delivers both, for firmware
  // that never calls the camera-specific endpoint.
  config.cameras = await getCamerasForDevice(id, tenantId, code);
  return config;
}

// ============================================================================
// COMMANDS (device-authenticated polling)
// ============================================================================

export async function getPendingCommands(deviceId) {
  return repo.getPendingCommands(deviceId);
}

export async function markCommandExecuted({ commandId, deviceId, success, errorMessage }) {
  await repo.markCommandExecuted({ commandId, deviceId, success, errorMessage });
}

// ============================================================================
// ACTIVATION CODES (ZTP)
// ============================================================================

export async function generateActivationCode({ tenantId, userId, tokenValidityDays, siteId, deviceRole, zoneName }, req) {
  let resolvedTenantId = tenantId;

  if (siteId) {
    const site = await repo.findSiteWithTenant(siteId);
    if (!site) throw new NotFoundError('Site not found');

    if (site.status === 'inactive') {
      throw new ValidationError('Cannot provision a device to an inactive site. Please activate the site before generating an activation PIN.');
    }

    if (!resolvedTenantId) {
      resolvedTenantId = site.fk_tenant_id;
    } else if (resolvedTenantId !== site.fk_tenant_id) {
      throw new NotFoundError('Site does not belong to this tenant');
    }
  }

  if (!resolvedTenantId) {
    throw new ValidationError('Tenant isolation context is required. Please select a site.');
  }

  // Generate a cryptographically secure SHA-256 activation token.
  // 32 random bytes → SHA-256 → 64-char lowercase hex.
  const rawSecret = crypto.randomBytes(32);
  const pin = crypto.createHash('sha256').update(rawSecret).digest('hex');
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30-minute expiry

  await repo.insertActivationCode({
    tenantId: resolvedTenantId, pin, tokenValidityDays, userId, expiresAt, siteId, deviceRole, zoneName,
  });

  await writeAudit({
    req,
    action: 'device.activation_code_generated',
    details: `Generated device activation code for site ${siteId} (role: ${deviceRole})`,
    entityType: 'device',
    entityId: pin,
    source: 'api',
  }).catch(err => logger.error('[device-management] activation code audit log failed:', err.message));

  return { pin, expiresAt, siteId, deviceRole, zoneName };
}

export async function getActivationCodeStatus({ pin, tenantId }) {
  if (!tenantId) throw new ValidationError('Tenant isolation context is required');

  const row = await repo.getActivationCodeStatus(pin, tenantId);
  if (!row) throw new NotFoundError('PIN not found');

  if (row.used_at) {
    // Fetch the device that activated using this PIN.
    // Prefer the direct FK set during activation; fall back to most-recently
    // registered device for the tenant (handles PINs created before the FK column existed).
    let device = null;
    if (row.claimed_device_id) {
      device = await repo.findDeviceByIdForActivationStatus(row.claimed_device_id);
    }
    if (!device) {
      device = await repo.findMostRecentlyProvisionedDevice(tenantId);
    }
    return { claimed: true, used_at: row.used_at, device };
  }

  const isExpired = new Date(row.expires_at) < new Date();
  return { claimed: false, expired: isExpired, expires_at: row.expires_at };
}

// ── ZTP handshake activation (transactional) ────────────────────────────────

export async function activateDevice(fields, client) {
  const { pin, externalDeviceId, deviceTypeCode, name, locationLabel, ipAddress, serialNumber, macAddress, notes } = fields;

  // 1. Fetch device type (read-only, safe to do via the same client before the transaction body).
  const deviceType = await repo.findDeviceType(client, deviceTypeCode);
  if (!deviceType) {
    const err = new ValidationError('invalid_device_type');
    err.code = 'invalid_device_type';
    throw err;
  }

  // 2. Verify + lock the PIN row. FOR UPDATE serializes concurrent
  //    activations of the same PIN so it can only be claimed once.
  const actData = await repo.findActivationForUpdate(client, pin);
  if (!actData) {
    const err = new NotFoundError('The activation code is incorrect.');
    err.code = 'invalid_pin';
    throw err;
  }

  if (new Date(actData.expires_at) < new Date()) {
    const err = new Error('The activation code has expired.');
    err.code = 'expired_pin';
    err.statusCode = 410;
    throw err;
  }

  if (actData.used_at) {
    const err = new ConflictError('The activation code was already claimed.');
    err.code = 'used_pin';
    throw err;
  }

  const tenantId = actData.fk_tenant_id;

  // 3. Look up any existing device with this code under the tenant (locked).
  //    A decommissioned row still occupies (tenant_id, external_device_id) due
  //    to the unique constraint, so re-activation must REVIVE it rather than
  //    insert a duplicate. Only a live (non-decommissioned) device blocks.
  const existing = await repo.findExistingDeviceForUpdate(client, tenantId, externalDeviceId);

  let deviceData;
  if (existing) {
    // Revive or update existing device with new activation details & IP
    deviceData = await repo.reviveDecommissionedDevice(client, {
      deviceId: existing.pk_device_id, tenantId, name, locationLabel: locationLabel || 'Not set', ipAddress,
      deviceTypeId: deviceType.pk_device_type_id, serialNumber: serialNumber || null, macAddress: macAddress || null, notes: notes || null,
    });
  } else {
    // 4b. Register a brand-new device row with self-reported metadata.
    deviceData = await repo.insertNewActivatedDevice(client, {
      tenantId, externalDeviceId, name, locationLabel: locationLabel || 'Not set', ipAddress,
      deviceTypeId: deviceType.pk_device_type_id, serialNumber: serialNumber || null, macAddress: macAddress || null, notes: notes || null,
    });
  }

  const deviceSecret = crypto.randomBytes(32).toString('hex');
  const deviceSecretHash = await bcrypt.hash(deviceSecret, 10);

  // 5. Generate secure production JWT
  const expiresInSeconds = actData.token_validity_days * 24 * 60 * 60;
  const tokenPayload = {
    device_id: parseInt(deviceData.pk_device_id),
    device_code: deviceData.external_device_id,
    tenant_id: tenantId,
    scopes: ['device:read', 'device:write', 'cameras:read'],
    iss: 'frs2-backend',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  };

  const deviceToken = jwt.sign(tokenPayload, DEVICE_JWT_SECRET);
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

  // 6. Update device with secret/token timestamps
  await repo.setActivationDeviceToken(client, deviceData.pk_device_id, { deviceSecretHash, expiresAt });

  // 7. Auto-assign device to site if PIN carried a site_id
  if (actData.fk_site_id) {
    await repo.autoAssignDeviceToSite(client, {
      siteId: actData.fk_site_id, deviceId: deviceData.pk_device_id,
      deviceRole: actData.device_role || 'entry_point', zoneName: actData.zone_name || null,
    });
    logger.info(
      { deviceCode: deviceData.external_device_id, siteId: actData.fk_site_id },
      '[ZTP] Device auto-assigned to site'
    );
  }

  // 8. Claim the activation PIN. The guard re-asserts used_at IS NULL under
  //    the row lock; rowCount === 0 means it was claimed concurrently.
  const claimedCount = await repo.claimActivationCode(client, { activationId: actData.pk_activation_id, deviceId: deviceData.pk_device_id });
  if (claimedCount === 0) {
    const err = new ConflictError('The activation code was already claimed.');
    err.code = 'used_pin';
    throw err;
  }

  logger.info({ deviceCode: deviceData.external_device_id }, '[ZTP] Device successfully self-activated using PIN');

  return {
    deviceCode: deviceData.external_device_id,
    token: deviceToken,
    expiresAt,
    siteId: actData.fk_site_id || null,
    deviceRole: actData.device_role || null,
    zoneName: actData.zone_name || null,
  };
}
