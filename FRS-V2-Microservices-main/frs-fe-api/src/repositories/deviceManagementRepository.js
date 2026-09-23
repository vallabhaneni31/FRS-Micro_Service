import { pool } from '../db/pool.js';

// ============================================================================
// OVERVIEW
// ============================================================================

export async function getDeviceSummary(tenantId) {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int as total,
      COUNT(CASE WHEN status = 'active' THEN 1 END)::int as active,
      COUNT(CASE WHEN status = 'inactive' THEN 1 END)::int as inactive
    FROM facility_device
    WHERE ($1::uuid IS NULL OR tenant_id = $1::uuid)
  `, [tenantId]);
  return rows[0];
}

// ============================================================================
// DEVICE REGISTRATION
// ============================================================================

export async function findDeviceByTenantAndCode(client, tenantId, externalDeviceId) {
  const result = await client.query(
    'SELECT pk_device_id FROM facility_device WHERE ($1::uuid IS NULL OR tenant_id = $1::uuid) AND external_device_id = $2',
    [tenantId, externalDeviceId]
  );
  return result.rows[0] ?? null;
}

export async function findDeviceType(client, typeCode) {
  const result = await client.query(
    `SELECT pk_device_type_id FROM device_type 
     WHERE type_code = $1 
        OR type_name ILIKE $1 
        OR type_code = LOWER(REPLACE($1, ' ', '_')) 
     LIMIT 1`,
    [typeCode || 'jetson_orin_nx']
  );
  return result.rows[0] ?? null;
}

export async function insertDevice(client, fields) {
  const result = await client.query(`
    INSERT INTO facility_device (
      tenant_id, external_device_id, name, location_label, ip_address,
      device_type_id, serial_number, mac_address, device_notes,
      status, created_by, device_config
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'offline', $10, '{}'::jsonb)
    RETURNING pk_device_id, external_device_id, name, status, ip_address
  `, [
    fields.tenantId, fields.externalDeviceId, fields.name, fields.locationLabel, fields.ipAddress,
    fields.deviceTypeId, fields.serialNumber, fields.macAddress, fields.notes, fields.userId,
  ]);
  return result.rows[0];
}

// ============================================================================
// PROVISIONING
// ============================================================================

export async function findDeviceForProvision(tenantId, code) {
  const result = await pool.query(
    'SELECT pk_device_id, external_device_id, name, status, ip_address FROM facility_device WHERE ($1::uuid IS NULL OR tenant_id = $1::uuid) AND external_device_id = $2',
    [tenantId, code]
  );
  return result.rows[0] ?? null;
}

export async function setDeviceTokenIssued(deviceId, { deviceSecretHash, expiresAt }) {
  await pool.query(`
    UPDATE facility_device
    SET device_secret_hash = $1,
        token_issued_at = NOW(),
        token_expires_at = $2,
        status = 'offline'
    WHERE pk_device_id = $3
  `, [deviceSecretHash, expiresAt, deviceId]);
}

export async function queueUpdateTokenCommand({ deviceId, token, expiresAt, userId }) {
  await pool.query(`
    INSERT INTO device_command_queue (
      device_id, command_type, command_payload, priority, created_by, expires_at
    ) VALUES ($1, 'update_token', $2, 10, $3, NOW() + INTERVAL '24 hours')
  `, [deviceId, JSON.stringify({ token, expires_at: expiresAt }), userId]);
}

// ============================================================================
// HEARTBEAT
// ============================================================================

export async function findDeviceForHeartbeat(code, tenantId) {
  const result = await pool.query(
    'SELECT pk_device_id FROM facility_device WHERE external_device_id = $1 AND ($2::uuid IS NULL OR tenant_id = $2::uuid)',
    [code, tenantId]
  );
  return result.rows[0]?.pk_device_id ?? null;
}

export async function findDeviceById(deviceId) {
  const result = await pool.query(
    'SELECT pk_device_id FROM facility_device WHERE pk_device_id = $1',
    [deviceId]
  );
  return result.rows.length > 0;
}

export async function insertHeartbeat({ deviceId, status, metrics, ip }) {
  await pool.query(`
    INSERT INTO device_heartbeat (device_id, status, metrics, ip_address, timestamp)
    VALUES ($1, $2, $3, $4, NOW())
  `, [deviceId, status, JSON.stringify(metrics), ip]);
}

export async function syncDeviceHeartbeatStatus({ deviceId, status, telemetry }) {
  await pool.query(`
    UPDATE facility_device
    SET status = $1,
        last_heartbeat = NOW(),
        last_active = NOW(),
        device_config = COALESCE(device_config, '{}'::jsonb) || $3::jsonb
    WHERE pk_device_id = $2
  `, [status, deviceId, JSON.stringify(telemetry)]);
}

export async function getPendingCommandsForDevice(deviceId, limit = 5) {
  const result = await pool.query(`
    SELECT pk_command_id, command_type, command_payload, priority
    FROM device_command_queue
    WHERE device_id = $1 AND status = 'pending'
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY priority ASC, created_at ASC
    LIMIT $2
  `, [deviceId, limit]);
  return result.rows;
}

// ============================================================================
// LIST / GET / UPDATE / DELETE DEVICES
// ============================================================================

export async function listDevices({ tenantId, status, deviceType, siteId, search }) {
  let query = `
    SELECT
      fd.pk_device_id,
      fd.external_device_id,
      fd.name,
      fd.location_label,
      fd.ip_address,
      fd.status,
      fd.last_active,
      fd.last_heartbeat,
      fd.serial_number,
      fd.mac_address,
      fd.recognition_accuracy,
      fd.total_scans,
      dt.type_name as device_type,
      dt.category as device_category,
      s.site_name,
      sda.device_role,
      sda.zone_name,
      CASE
        WHEN fd.last_heartbeat IS NOT NULL
        THEN EXTRACT(EPOCH FROM (NOW() - fd.last_heartbeat))::INTEGER
        ELSE NULL
      END as seconds_since_heartbeat
    FROM facility_device fd
    LEFT JOIN device_type dt ON dt.pk_device_type_id = fd.device_type_id
    LEFT JOIN site_device_assignment sda ON sda.device_id = fd.pk_device_id AND sda.is_active = TRUE
    LEFT JOIN frs_site s ON s.pk_site_id = sda.site_id
    WHERE fd.tenant_id = $1
    AND fd.decommissioned_at IS NULL
  `;

  const params = [tenantId];
  let paramIndex = 2;

  if (status) {
    query += ` AND fd.status = $${paramIndex}`;
    params.push(status);
    paramIndex++;
  }
  if (deviceType) {
    query += ` AND dt.type_code = $${paramIndex}`;
    params.push(deviceType);
    paramIndex++;
  }
  if (siteId) {
    query += ` AND sda.site_id = $${paramIndex}`;
    params.push(siteId);
    paramIndex++;
  }
  if (search) {
    query += ` AND (fd.external_device_id ILIKE $${paramIndex} OR fd.name ILIKE $${paramIndex})`;
    params.push(`%${search}%`);
    paramIndex++;
  }

  query += ` ORDER BY fd.pk_device_id DESC`;

  const result = await pool.query(query, params);
  return result.rows;
}

export async function getDeviceDetails(tenantId, code) {
  const device = await pool.query(`
    SELECT
      fd.*,
      dt.type_name as device_type,
      dt.type_code as device_type_code,
      dt.category as device_category,
      dt.manufacturer,
      dt.model,
      s.site_name,
      s.pk_site_id as site_id,
      sda.device_role,
      sda.zone_name,
      sda.assigned_at,
      parent.external_device_id as parent_device_code,
      parent.name as parent_device_name
    FROM facility_device fd
    LEFT JOIN device_type dt ON dt.pk_device_type_id = fd.device_type_id
    LEFT JOIN facility_device parent ON parent.pk_device_id = fd.parent_device_id
    WHERE ($1::uuid IS NULL OR fd.tenant_id = $1::uuid) AND fd.external_device_id = $2
    AND fd.decommissioned_at IS NULL
  `, [tenantId, code]);
  return device.rows[0] ?? null;
}

export async function getSiteAssignmentsForDevice(deviceId) {
  const result = await pool.query(`
    SELECT sda.pk_assignment_id, sda.site_id, s.site_name, sda.device_role, sda.zone_name, sda.assigned_at
    FROM site_device_assignment sda
    JOIN frs_site s ON s.pk_site_id = sda.site_id
    WHERE sda.device_id = $1 AND sda.is_active = TRUE
    ORDER BY sda.assigned_at ASC
  `, [deviceId]);
  return result.rows;
}

export async function getLatestHeartbeat(deviceId) {
  const result = await pool.query(`
    SELECT timestamp, status, metrics
    FROM device_heartbeat
    WHERE device_id = $1
    ORDER BY timestamp DESC
    LIMIT 1
  `, [deviceId]);
  return result.rows[0] ?? null;
}

export async function getStatusHistory(deviceId) {
  const result = await pool.query(`
    SELECT old_status, new_status, transition_reason, changed_at, duration_seconds
    FROM device_status_history
    WHERE device_id = $1
    ORDER BY changed_at DESC
    LIMIT 10
  `, [deviceId]);
  return result.rows;
}

export async function getChildDevices(deviceId) {
  const result = await pool.query(`
    SELECT external_device_id, name, status, ip_address
    FROM facility_device
    WHERE parent_device_id = $1
  `, [deviceId]);
  return result.rows;
}

export async function updateDeviceFields(deviceId, { updates, params }) {
  const query = `
    UPDATE facility_device
    SET ${updates.join(', ')}
    WHERE pk_device_id = $${params.length + 1}
    RETURNING pk_device_id, external_device_id, name, location_label, ip_address, status, zone_type, zone_label, fk_floor_id
  `;
  const result = await pool.query(query, [...params, deviceId]);
  const updatedDevice = result.rows[0];

  if (updatedDevice) {
    // Sync to legacy tables if fk_floor_id was updated
    const floorIndex = updates.findIndex(u => u.startsWith('fk_floor_id') || u.includes('fk_floor_id'));
    if (floorIndex !== -1) {
      const floorVal = params[floorIndex];
      await pool.query(
        `UPDATE frs_camera SET fk_floor_id = $2 WHERE cam_id = $1`,
        [updatedDevice.external_device_id, floorVal]
      );
      await pool.query(
        `UPDATE frs_nug_box SET fk_floor_id = $2 WHERE device_code = $1`,
        [updatedDevice.external_device_id, floorVal]
      );
    }
  }

  return updatedDevice;
}

export async function findDeviceForDelete(tenantId, code) {
  const result = await pool.query(
    'SELECT pk_device_id, status FROM facility_device WHERE ($1::uuid IS NULL OR tenant_id = $1::uuid) AND external_device_id = $2',
    [tenantId, code]
  );
  return result.rows[0] ?? null;
}

export async function decommissionDevice(deviceId, userId) {
  await pool.query(`
    UPDATE facility_device
    SET status = 'offline',
        decommissioned_at = NOW(),
        decommissioned_by = $1
    WHERE pk_device_id = $2
  `, [userId, deviceId]);
}

export async function deactivateSiteAssignmentsForDevice(deviceId) {
  await pool.query(`
    UPDATE site_device_assignment
    SET is_active = FALSE,
        unassigned_at = NOW(),
        unassignment_reason = 'Device decommissioned'
    WHERE device_id = $1 AND is_active = TRUE
  `, [deviceId]);
}

// ============================================================================
// SITE ASSIGNMENT
// ============================================================================

export async function findSiteForTenant(client, siteId, tenantId) {
  const result = await client.query(
    `SELECT s.pk_site_id, s.site_name
     FROM frs_site s
     JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
     WHERE s.pk_site_id = $1 AND ($2::uuid IS NULL OR c.fk_tenant_id = $2::uuid)`,
    [siteId, tenantId]
  );
  return result.rows[0] ?? null;
}

export async function findDeviceByCodeTx(client, tenantId, deviceCode) {
  const result = await client.query(
    'SELECT pk_device_id, external_device_id, name, status FROM facility_device WHERE ($1::uuid IS NULL OR tenant_id = $1::uuid) AND external_device_id = $2',
    [tenantId, deviceCode]
  );
  return result.rows[0] ?? null;
}

export async function setDevicePrimarySite(client, deviceId, siteId) {
  await client.query(`UPDATE facility_device SET site_id = $1 WHERE pk_device_id = $2`, [siteId, deviceId]);
}

// The Tenant Admin Portal's hierarchy view (edge nodes/cameras/zones per
// site) only ever shows a device under the one site named by
// facility_device.site_id — it never surfaces multi-site membership. So a
// leftover active row here from an earlier reassignment silently leaks that
// device's zone activity into a site the admin UI shows as having 0 devices.
// Enforce one active site per device: assigning to a new site retires any
// other still-active assignment for that device.
export async function deactivateOtherActiveSiteAssignments(client, deviceId, keepSiteId) {
  await client.query(`
    UPDATE site_device_assignment
    SET is_active = FALSE,
        unassigned_at = NOW(),
        unassignment_reason = 'Superseded by reassignment to another site'
    WHERE device_id = $1 AND site_id != $2 AND is_active = TRUE
  `, [deviceId, keepSiteId]);
}

export async function findExistingAssignment(client, deviceId, siteId) {
  const result = await client.query(
    'SELECT pk_assignment_id, device_role, zone_name, assigned_at FROM site_device_assignment WHERE device_id = $1 AND site_id = $2 AND is_active = TRUE',
    [deviceId, siteId]
  );
  return result.rows[0] ?? null;
}

export async function updateAssignmentRoleZone(client, { deviceRole, zoneName, deviceId, siteId }) {
  const result = await client.query(`
    UPDATE site_device_assignment
    SET device_role = $1, zone_name = $2
    WHERE device_id = $3 AND site_id = $4 AND is_active = TRUE
    RETURNING pk_assignment_id, device_role, zone_name, assigned_at
  `, [deviceRole, zoneName, deviceId, siteId]);
  return result.rows[0];
}

export async function insertSiteAssignment(client, { siteId, deviceId, deviceRole, zoneName, userId }) {
  const result = await client.query(`
    INSERT INTO site_device_assignment (
      site_id, device_id, device_role, zone_name, is_active, assigned_by
    ) VALUES ($1, $2, $3, $4, TRUE, $5)
    RETURNING pk_assignment_id, device_role, zone_name, assigned_at
  `, [siteId, deviceId, deviceRole, zoneName, userId]);
  return result.rows[0];
}

export async function findSiteBelongingToTenant(siteId, tenantId) {
  const result = await pool.query(
    `SELECT 1 FROM frs_site s
     JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
     WHERE s.pk_site_id = $1 AND ($2::uuid IS NULL OR c.fk_tenant_id = $2::uuid)`,
    [siteId, tenantId]
  );
  return result.rows.length > 0;
}

export async function listSiteDevices(siteId) {
  const result = await pool.query(`
    SELECT
      fd.pk_device_id,
      fd.external_device_id,
      fd.name as device_name,
      fd.status,
      fd.ip_address,
      fd.last_active,
      fd.last_heartbeat,
      dt.type_name as device_type,
      dt.category as device_category,
      sda.device_role,
      sda.zone_name,
      sda.assigned_at,
      sda.pk_assignment_id,
      s.site_name,
      CASE
        WHEN fd.last_heartbeat IS NOT NULL
        THEN EXTRACT(EPOCH FROM (NOW() - fd.last_heartbeat))::INTEGER
        ELSE NULL
      END as seconds_since_heartbeat
    FROM site_device_assignment sda
    JOIN facility_device fd ON fd.pk_device_id = sda.device_id
    LEFT JOIN device_type dt ON dt.pk_device_type_id = fd.device_type_id
    JOIN frs_site s ON s.pk_site_id = sda.site_id
    WHERE sda.site_id = $1
      AND sda.is_active = TRUE
      AND fd.decommissioned_at IS NULL
    ORDER BY sda.assigned_at DESC
  `, [siteId]);
  return result.rows;
}

export async function findDeviceByTenantCode(tenantId, deviceCode) {
  const result = await pool.query(
    'SELECT pk_device_id FROM facility_device WHERE ($1::uuid IS NULL OR tenant_id = $1::uuid) AND external_device_id = $2',
    [tenantId, deviceCode]
  );
  return result.rows[0] ?? null;
}

export async function unassignDeviceFromSite({ userId, reason, siteId, deviceId }) {
  const result = await pool.query(`
    UPDATE site_device_assignment
    SET is_active = FALSE,
        unassigned_at = NOW(),
        unassigned_by = $1,
        unassignment_reason = $2
    WHERE site_id = $3 AND device_id = $4 AND is_active = TRUE
    RETURNING pk_assignment_id, device_role, zone_name
  `, [userId, reason, siteId, deviceId]);
  return result.rows[0] ?? null;
}

// ============================================================================
// EFFECTIVE CONFIG
// ============================================================================

export async function getEffectiveConfig(deviceId) {
  try {
    const result = await pool.query(
      'SELECT get_effective_device_config($1) as config',
      [deviceId]
    );
    return result.rows[0]?.config || {};
  } catch (err) {
    if (err.code === '42883') {
      const fallbackResult = await pool.query(`
        SELECT 
          d.device_config,
          s.site_config
        FROM facility_device d
        LEFT JOIN frs_site s ON s.pk_site_id = d.site_id
        WHERE d.pk_device_id = $1
      `, [deviceId]);

      if (!fallbackResult.rows.length) return {};
      const row = fallbackResult.rows[0];
      const siteConfig = row.site_config && typeof row.site_config === 'object' ? row.site_config : {};
      const deviceConfig = row.device_config && typeof row.device_config === 'object' ? row.device_config : {};
      return { ...siteConfig, ...deviceConfig };
    }
    throw err;
  }
}

export async function getEffectiveConfigForDevicePolling(deviceId) {
  return getEffectiveConfig(deviceId);
}

// ============================================================================
// COMMANDS (device-authenticated polling)
// ============================================================================

export async function getPendingCommands(deviceId) {
  const result = await pool.query(`
    SELECT
      pk_command_id,
      command_type,
      command_payload,
      priority,
      created_at,
      expires_at
    FROM device_command_queue
    WHERE device_id = $1
      AND executed_at IS NULL
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY priority DESC, created_at ASC
    LIMIT 10
  `, [deviceId]);
  return result.rows;
}

export async function markCommandExecuted({ commandId, deviceId, success, errorMessage }) {
  await pool.query(`
    UPDATE device_command_queue
    SET executed_at = NOW(),
        execution_success = $1,
        execution_error = $2
    WHERE pk_command_id = $3 AND device_id = $4
  `, [success, errorMessage, commandId, deviceId]);
}

// ============================================================================
// ACTIVATION CODES (ZTP)
// ============================================================================

export async function findSiteWithTenant(siteId) {
  const result = await pool.query(
    `SELECT s.pk_site_id, s.status, c.fk_tenant_id FROM frs_site s
     JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
     WHERE s.pk_site_id = $1`,
    [siteId]
  );
  return result.rows[0] ?? null;
}

export async function insertActivationCode(fields) {
  await pool.query(`
    INSERT INTO device_activation_code
      (fk_tenant_id, activation_pin, token_validity_days, created_by, expires_at, fk_site_id, device_role, zone_name)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [
    fields.tenantId, fields.pin, fields.tokenValidityDays, fields.userId, fields.expiresAt,
    fields.siteId, fields.deviceRole, fields.zoneName,
  ]);
}

export async function getActivationCodeStatus(pin, tenantId) {
  const result = await pool.query(`
    SELECT pk_activation_id, used_at, expires_at, fk_site_id, device_role, zone_name, claimed_device_id
    FROM device_activation_code
    WHERE activation_pin = $1 AND fk_tenant_id = $2::uuid
    LIMIT 1
  `, [pin, tenantId]);
  return result.rows[0] ?? null;
}

export async function findDeviceByIdForActivationStatus(deviceId) {
  const result = await pool.query(
    `SELECT pk_device_id, external_device_id, name, status, ip_address, serial_number
     FROM facility_device WHERE pk_device_id = $1`,
    [deviceId]
  );
  return result.rows[0] ?? null;
}

export async function findMostRecentlyProvisionedDevice(tenantId) {
  const result = await pool.query(
    `SELECT pk_device_id, external_device_id, name, status, ip_address, serial_number
     FROM facility_device
     WHERE tenant_id = $1::uuid AND decommissioned_at IS NULL
     ORDER BY token_issued_at DESC NULLS LAST
     LIMIT 1`,
    [tenantId]
  );
  return result.rows[0] ?? null;
}

// ── ZTP handshake activation (transactional) ────────────────────────────────

export async function findActivationForUpdate(client, pin) {
  const cleanPin = String(pin || '').trim().toLowerCase();
  const result = await client.query(`
    SELECT pk_activation_id, fk_tenant_id, token_validity_days, expires_at, used_at,
           fk_site_id, device_role, zone_name
    FROM device_activation_code
    WHERE LOWER(TRIM(activation_pin)) = $1
    LIMIT 1
    FOR UPDATE
  `, [cleanPin]);
  return result.rows[0] ?? null;
}

export async function findExistingDeviceForUpdate(client, tenantId, externalDeviceId) {
  const result = await client.query(
    `SELECT pk_device_id, decommissioned_at
       FROM facility_device
      WHERE ($1::uuid IS NULL OR tenant_id = $1::uuid) AND external_device_id = $2
      FOR UPDATE`,
    [tenantId, externalDeviceId]
  );
  return result.rows[0] ?? null;
}

export async function reviveDecommissionedDevice(client, fields) {
  const result = await client.query(`
    UPDATE facility_device
       SET name = $3, location_label = $4, ip_address = $5,
           device_type_id = $6, serial_number = $7, mac_address = $8,
           device_notes = $9, status = 'online', last_heartbeat = NOW(), last_active = NOW(),
           decommissioned_at = NULL, decommissioned_by = NULL
     WHERE pk_device_id = $1 AND tenant_id = $2
   RETURNING pk_device_id, external_device_id, name, status, ip_address
  `, [
    fields.deviceId, fields.tenantId, fields.name, fields.locationLabel, fields.ipAddress,
    fields.deviceTypeId, fields.serialNumber, fields.macAddress, fields.notes,
  ]);
  return result.rows[0];
}

export async function insertNewActivatedDevice(client, fields) {
  const result = await client.query(`
    INSERT INTO facility_device (
      tenant_id, external_device_id, name, location_label, ip_address,
      device_type_id, serial_number, mac_address, device_notes,
      status, last_heartbeat, last_active, device_config
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'online', NOW(), NOW(), '{}'::jsonb)
    RETURNING pk_device_id, external_device_id, name, status, ip_address
  `, [
    fields.tenantId, fields.externalDeviceId, fields.name, fields.locationLabel, fields.ipAddress,
    fields.deviceTypeId, fields.serialNumber, fields.macAddress, fields.notes,
  ]);
  return result.rows[0];
}

export async function setActivationDeviceToken(client, deviceId, { deviceSecretHash, expiresAt }) {
  await client.query(`
    UPDATE facility_device
    SET device_secret_hash = $1,
        token_issued_at = NOW(),
        token_expires_at = $2
    WHERE pk_device_id = $3
  `, [deviceSecretHash, expiresAt, deviceId]);
}

export async function autoAssignDeviceToSite(client, { siteId, deviceId, deviceRole, zoneName }) {
  await client.query(`
    UPDATE facility_device SET site_id = $1 WHERE pk_device_id = $2
  `, [siteId, deviceId]);

  await deactivateOtherActiveSiteAssignments(client, deviceId, siteId);

  await client.query(`
    INSERT INTO site_device_assignment
      (site_id, device_id, device_role, zone_name, is_active, assigned_by)
    VALUES ($1, $2, $3, $4, TRUE, NULL)
    ON CONFLICT DO NOTHING
  `, [siteId, deviceId, deviceRole, zoneName]);
}

export async function claimActivationCode(client, { activationId, deviceId }) {
  const result = await client.query(`
    UPDATE device_activation_code
    SET used_at = NOW(), claimed_device_id = $2
    WHERE pk_activation_id = $1 AND used_at IS NULL
  `, [activationId, deviceId]);
  return result.rowCount;
}
