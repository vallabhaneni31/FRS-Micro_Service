import { pool } from '../db/pool.js';
import logger from '../utils/logger.js';
import * as svc from '../services/business/DeviceManagementService.js';

const { NotFoundError, ConflictError, ValidationError, ForbiddenError } = svc;

// Generic mapping for the small number of "early return" statuses every route
// used before its own catch-all — 404/400/409/403 must win over the route's
// generic 500 fallback, which only ever wrapped genuinely unexpected errors.
function mapKnownError(err, res) {
  if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
  if (err instanceof ConflictError) return res.status(409).json({ error: err.message });
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  if (err instanceof ForbiddenError) return res.status(403).json({ error: err.message });
  return null;
}

const DeviceManagementController = {
  // ── Overview ──────────────────────────────────────────────────────────────
  async getSummary(req, res) {
    const tenantId = req.auth?.scope?.tenantId || null;
    const summary = await svc.getDeviceSummary(tenantId);
    res.json({ summary });
  },

  // ── Registration ──────────────────────────────────────────────────────────
  async registerDevice(req, res) {
    const { external_device_id, device_type_code, name, location_label, ip_address, serial_number, mac_address, notes } = req.body;

    if (!external_device_id || !device_type_code || !name || !ip_address) {
      return res.status(400).json({ error: 'Missing required fields: external_device_id, device_type_code, name, ip_address' });
    }

    const tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || null;
    const userId = req.auth?.user?.id;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const device = await svc.registerDevice({
        tenantId, externalDeviceId: external_device_id, deviceTypeCode: device_type_code,
        name, locationLabel: location_label || 'Not set', ipAddress: ip_address,
        serialNumber: serial_number, macAddress: mac_address, notes, userId,
      }, client);
      await client.query('COMMIT');
      res.status(201).json({ success: true, message: 'Device registered successfully', device, next_step: 'provision_device' });
    } catch (err) {
      await client.query('ROLLBACK');
      if (mapKnownError(err, res)) return;
      logger.error('Device registration error:', err);
      res.status(500).json({ error: 'Failed to register device' });
    } finally {
      client.release();
    }
  },

  // ── Provisioning ──────────────────────────────────────────────────────────
  async provisionDevice(req, res) {
    const { code } = req.params;
    const { token_validity_days = 365 } = req.body;
    const tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || null;
    const userId = req.auth?.user?.id;

    try {
      const { device, deviceToken, expiresAt, autoPushed } = await svc.provisionDevice(
        { code, tenantId, userId, tokenValidityDays: token_validity_days }, req
      );

      res.json({
        success: true,
        message: 'Device token generated successfully',
        token: deviceToken,
        token_expires_at: expiresAt.toISOString(),
        auto_deployed: autoPushed,
        deployment_status: autoPushed
          ? 'Token pushed automatically via Kafka. Device will update within 5 minutes.'
          : 'Token queued for bootstrap claim. Device will auto-fetch on next startup.',
        bootstrap_url: `${process.env.BACKEND_URL || process.env.PUBLIC_BASE_URL || process.env.APP_URL || (req.protocol + '://' + req.get('host'))}/api/bootstrap/${device.external_device_id}`,
        installation_instructions: {
          auto: 'Device calls GET /api/bootstrap/<device_code> on startup to self-fetch the token.',
          manual_ssh: {
            step_1: `SSH to device: ssh <user>@<device-local-ip>`,
            step_2: `Save token: echo '${deviceToken}' > /opt/frs/device_token.txt`,
            step_3: 'Restart service: sudo systemctl restart frs-runner',
            step_4: 'Verify: Device should appear online within 15 seconds',
          },
        },
      });
    } catch (err) {
      if (mapKnownError(err, res)) return;
      logger.error('Provision device error:', err);
      res.status(500).json({ error: 'Failed to provision device' });
    }
  },

  // ── Heartbeat (device-authenticated) ─────────────────────────────────────
  async heartbeat(req, res) {
    const { code } = req.params;
    try {
      const result = await svc.processHeartbeat({ code, body: req.body, device: req.device, ip: req.ip });
      res.json(result);
    } catch (err) {
      logger.error('Heartbeat processing error:', err);
      res.status(500).json({ error: 'Heartbeat processing failed' });
    }
  },

  // ── Simulate Heartbeat (admin/testing) ──────────────────────────────────
  async simulateHeartbeat(req, res) {
    const { code } = req.params;
    const tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || null;
    try {
      const result = await svc.simulateHeartbeat({ code, tenantId });
      res.json(result);
    } catch (err) {
      logger.error('Simulate heartbeat error:', err);
      res.status(500).json({ error: 'Failed to simulate heartbeat' });
    }
  },

  // ── List / get / update / delete ─────────────────────────────────────────
  async listDevices(req, res) {
    const { status, device_type, site_id, search } = req.query;
    const tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || null;
    try {
      const devices = await svc.listDevices({ tenantId, status, deviceType: device_type, siteId: site_id, search });
      res.json({ success: true, count: devices.length, devices });
    } catch (err) {
      logger.error('List devices error:', err);
      res.status(500).json({ error: 'Failed to list devices' });
    }
  },

  async getDeviceDetails(req, res) {
    const { code } = req.params;
    const tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || null;
    try {
      const result = await svc.getDeviceDetails(tenantId, code);
      res.json({ success: true, ...result });
    } catch (err) {
      if (mapKnownError(err, res)) return;
      logger.error('Get device details error:', err);
      res.status(500).json({ error: 'Failed to get device details' });
    }
  },

  async updateDevice(req, res) {
    const { code } = req.params;
    const { name, location_label, ip_address, device_config, notes, zone_type, zone_label, floor_id } = req.body;
    const tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || null;
    try {
      const device = await svc.updateDevice({
        tenantId, code, name, locationLabel: location_label, ipAddress: ip_address,
        deviceConfig: device_config, notes, zoneType: zone_type, zoneLabel: zone_label,
        floorId: floor_id,
      });
      res.json({ success: true, message: 'Device updated successfully', device });
    } catch (err) {
      if (mapKnownError(err, res)) return;
      logger.error('Update device error:', err);
      res.status(500).json({ error: 'Failed to update device' });
    }
  },

  async deleteDevice(req, res) {
    const { code } = req.params;
    const tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || null;
    try {
      const deviceId = await svc.deleteDevice({ tenantId, code }, req);
      res.json({ success: true, message: 'Device decommissioned successfully', device_id: deviceId, external_device_id: code });
    } catch (err) {
      if (mapKnownError(err, res)) return;
      logger.error('Decommission device error:', err);
      res.status(500).json({ error: 'Failed to decommission device' });
    }
  },

  // ── Site assignment ───────────────────────────────────────────────────────
  async assignDeviceToSite(req, res) {
    const { siteId } = req.params;
    const { device_code, device_role, zone_name } = req.body;
    const tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || null;
    const userId = req.auth?.user?.id;

    if (!device_code || !device_role) {
      return res.status(400).json({ error: 'device_code and device_role are required' });
    }

    try {
      svc.enforceSiteScope(req, siteId);
    } catch (err) {
      return res.status(403).json({ error: err.message });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { updated, assignment } = await svc.assignDeviceToSite(
        { siteId, deviceCode: device_code, deviceRole: device_role, zoneName: zone_name, tenantId, userId }, client
      );
      await client.query('COMMIT');
      if (updated) {
        return res.json({ success: true, message: 'Device assignment updated', assignment });
      }
      return res.status(201).json({ success: true, message: 'Device assigned to site successfully', assignment });
    } catch (err) {
      await client.query('ROLLBACK');
      if (mapKnownError(err, res)) return;
      logger.error('Assign device to site error:', err);
      res.status(500).json({ error: 'Failed to assign device to site' });
    } finally {
      client.release();
    }
  },

  async listSiteDevices(req, res) {
    const { siteId } = req.params;
    const tenantId = req.auth?.scope?.tenantId || null;

    try {
      svc.enforceSiteScope(req, siteId);
    } catch (err) {
      return res.status(403).json({ error: err.message });
    }

    try {
      const devices = await svc.listSiteDevices({ siteId, tenantId });
      res.json({ success: true, site_id: siteId, count: devices.length, devices });
    } catch (err) {
      if (mapKnownError(err, res)) return;
      logger.error('List site devices error:', err);
      res.status(500).json({ error: 'Failed to list site devices' });
    }
  },

  async unassignDevice(req, res) {
    const { siteId, deviceCode } = req.params;
    const { reason } = req.body;
    const tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || null;
    const userId = req.auth?.user?.id;

    try {
      svc.enforceSiteScope(req, siteId);
    } catch (err) {
      return res.status(403).json({ error: err.message });
    }

    try {
      const result = await svc.unassignDevice({ siteId, deviceCode, reason, tenantId, userId });
      res.json({ success: true, message: 'Device unassigned from site successfully', assignment_id: result.pk_assignment_id, device_code: deviceCode });
    } catch (err) {
      if (mapKnownError(err, res)) return;
      logger.error('Unassign device error:', err);
      res.status(500).json({ error: 'Failed to unassign device' });
    }
  },

  // ── Effective config ──────────────────────────────────────────────────────
  async getEffectiveConfig(req, res) {
    const { deviceCode } = req.params;
    const tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || null;
    try {
      const { deviceId, config } = await svc.getEffectiveConfig(tenantId, deviceCode);
      res.json({
        success: true, device_code: deviceCode, device_id: deviceId, effective_config: config,
        note: 'Config merged from: Global → Site → Device (Device overrides win)',
      });
    } catch (err) {
      if (mapKnownError(err, res)) return;
      logger.error('Get effective config error:', err);
      res.status(500).json({ error: 'Failed to get effective config' });
    }
  },

  // Device-authenticated polling endpoint
  async getEffectiveConfigForDevicePolling(req, res) {
    const { code } = req.params;
    const deviceId = req.device?.id;
    const tenantId = req.device?.tenant_id;
    try {
      const effectiveConfig = await svc.getEffectiveConfigForDevicePolling(deviceId, code, tenantId);
      res.json({ success: true, device_code: code, effective_config: effectiveConfig, timestamp: new Date().toISOString() });
    } catch (err) {
      if (err instanceof NotFoundError) return res.status(404).json({ success: false, error: err.message });
      logger.error('Get effective config error:', err);
      res.status(500).json({ success: false, error: 'Failed to retrieve effective config' });
    }
  },

  // ── Commands (device-authenticated polling) ──────────────────────────────
  async getPendingCommands(req, res) {
    const { code } = req.params;
    const deviceId = req.device?.id;
    try {
      const commands = await svc.getPendingCommands(deviceId);
      res.json({ success: true, device_code: code, commands, count: commands.length });
    } catch (err) {
      logger.error('Get device commands error:', err);
      res.status(500).json({ success: false, error: 'Failed to retrieve commands' });
    }
  },

  async markCommandExecuted(req, res) {
    const { commandId } = req.params;
    const deviceId = req.device?.id;
    const { success, error_message } = req.body;
    try {
      await svc.markCommandExecuted({ commandId, deviceId, success, errorMessage: error_message });
      res.json({ success: true });
    } catch (err) {
      logger.error('Mark command executed error:', err);
      res.status(500).json({ success: false, error: 'Failed to update command status' });
    }
  },

  // ── Activation codes (ZTP) ────────────────────────────────────────────────
  // NOTE: neither of these two routes had a try/catch in the original — a
  // genuinely unexpected error propagated to asyncHandler's default handling
  // rather than a route-local 500 message. Preserved: only the explicit
  // known-error cases are caught here; anything else re-throws.
  async generateActivationCode(req, res) {
    const tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || null;
    const userId = req.auth?.user?.id;
    const { token_validity_days = 365, site_id = null, device_role = 'entry_point', zone_name = null } = req.body;

    try {
      const { pin, expiresAt, siteId, deviceRole, zoneName } = await svc.generateActivationCode(
        { tenantId, userId, tokenValidityDays: token_validity_days, siteId: site_id, deviceRole: device_role, zoneName: zone_name }, req
      );
      res.json({ success: true, pin, expires_at: expiresAt.toISOString(), site_id: siteId, device_role: deviceRole, zone_name: zoneName });
    } catch (err) {
      if (mapKnownError(err, res)) return;
      throw err;
    }
  },

  async getActivationCodeStatus(req, res) {
    const { pin } = req.params;
    const tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || null;
    try {
      const result = await svc.getActivationCodeStatus({ pin, tenantId });
      res.json({ success: true, ...result });
    } catch (err) {
      if (mapKnownError(err, res)) return;
      throw err;
    }
  },

  // ── ZTP handshake activation ──────────────────────────────────────────────
  async activateDevice(req, res) {
    const body = req.body || {};
    const pin = (body.pin || body.activation_pin || body.activationPin || body.activationCode || body.code || '').trim();
    const external_device_id = (body.external_device_id || body.device_code || body.deviceCode || body.deviceId || body.serial_number || (pin ? `jetson-${pin}` : 'jetson-node')).trim();
    const name = (body.name || body.deviceName || body.hostname || external_device_id || 'Jetson Edge Node').trim();
    
    // Automatically extract client IP if missing in request payload
    const rawReqIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || req.ip || '';
    const cleanReqIp = rawReqIp.replace(/^.*:/, '');
    const ip_address = (body.ip_address || body.ipAddress || body.ip || (cleanReqIp && cleanReqIp !== '127.0.0.1' ? cleanReqIp : '127.0.0.1')).trim();

    const device_type_code = (body.device_type_code || body.device_type || body.deviceType || 'jetson_orin_nx').trim();
    const location_label = (body.location_label || body.locationLabel || 'Not set').trim();
    const serial_number = body.serial_number || body.serialNumber || null;
    const mac_address = body.mac_address || body.macAddress || null;
    const notes = body.notes || null;

    if (!pin) {
      return res.status(400).json({ error: 'Missing required activation pin' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await svc.activateDevice({
        pin, externalDeviceId: external_device_id, deviceTypeCode: device_type_code,
        name, locationLabel: location_label, ipAddress: ip_address,
        serialNumber: serial_number, macAddress: mac_address, notes,
      }, client);
      await client.query('COMMIT');

      res.json({
        success: true,
        message: 'Edge Box activated and registered successfully',
        device_code: result.deviceCode,
        token: result.token,
        device_token: result.token,
        token_expires_at: result.expiresAt.toISOString(),
        heartbeat_interval_seconds: 15,
        server_url: process.env.PUBLIC_BASE_URL || process.env.APP_URL || `${req.protocol}://${req.get('host')}`,
        site_id: result.siteId || 1,
        device_role: result.deviceRole || 'edge_ai',
        zone_name: result.zoneName || 'unassigned',
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === 'invalid_device_type') return res.status(400).json({ error: 'invalid_device_type', message: err.message });
      if (err.code === 'invalid_pin') return res.status(404).json({ error: 'invalid_pin', message: err.message });
      if (err.code === 'expired_pin') return res.status(410).json({ error: 'expired_pin', message: err.message });
      if (err.code === 'used_pin') return res.status(409).json({ error: 'used_pin', message: err.message });
      if (err.code === 'device_exists') return res.status(409).json({ error: 'device_exists', message: err.message });
      logger.error('ZTP activation error:', err);
      res.status(500).json({ error: 'failed_activation', message: 'Internal activation failure.' });
    } finally {
      client.release();
    }
  },
};

export default DeviceManagementController;
