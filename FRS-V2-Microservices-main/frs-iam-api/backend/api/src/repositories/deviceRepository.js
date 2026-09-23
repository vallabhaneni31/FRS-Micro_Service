import { pool } from '../db/pool.js';

export async function findDeviceByCode(deviceCode) {
  const result = await pool.query(
    `SELECT fd.*, s.site_name, s.timezone, s.pk_site_id as fk_site_id
     FROM facility_device fd
     LEFT JOIN site_device_assignment sda ON sda.device_id = fd.pk_device_id AND sda.is_active = TRUE
     LEFT JOIN frs_site s ON s.pk_site_id = sda.site_id
     WHERE fd.external_device_id = $1`,
    [deviceCode]
  );
  return result.rows[0] || null;
}

export async function listAllDevices() {
  const result = await pool.query(
    `SELECT fd.*, s.site_name, s.pk_site_id as fk_site_id
     FROM facility_device fd
     LEFT JOIN site_device_assignment sda ON sda.device_id = fd.pk_device_id AND sda.is_active = TRUE
     LEFT JOIN frs_site s ON s.pk_site_id = sda.site_id
     ORDER BY fd.name`
  );
  return result.rows;
}

export async function updateDeviceTelemetry(deviceCode, stats) {
  await pool.query(
    `UPDATE facility_device 
     SET total_scans = COALESCE($2, total_scans),
         recognition_accuracy = COALESCE($3, recognition_accuracy),
         status = $4,
         last_active = NOW(),
         last_heartbeat = NOW()
     WHERE external_device_id = $1`,
    [deviceCode, stats.total_scans, stats.accuracy, stats.status || 'online']
  );
}

export async function createDevice(data) {
  const { code, name, type, ip, config } = data;
  const typeRes = await pool.query('SELECT pk_device_type_id FROM device_type WHERE type_code = $1', [type || 'hikvision_camera']);
  const typeId = typeRes.rows[0]?.pk_device_type_id || null;

  const result = await pool.query(
    `INSERT INTO facility_device (external_device_id, name, ip_address, device_type_id, device_config, status, location_label)
     VALUES ($1, $2, $3, $4, $5, 'offline', 'Not set') RETURNING *`,
    [code, name, ip, typeId, JSON.stringify(config || {})]
  );
  return result.rows[0];
}

// Find device by client ID (for device authentication)
export async function findDeviceByClientId(clientId) {
  const isNumeric = !isNaN(clientId) && !isNaN(parseInt(clientId));
  const result = await pool.query(
    `SELECT fd.*, s.site_name, s.timezone, s.pk_site_id as fk_site_id,
            dt.category as device_type
     FROM facility_device fd
     LEFT JOIN site_device_assignment sda ON sda.device_id = fd.pk_device_id AND sda.is_active = TRUE
     LEFT JOIN frs_site s ON s.pk_site_id = sda.site_id
     LEFT JOIN device_type dt ON dt.pk_device_type_id = fd.device_type_id
     WHERE (CASE WHEN $1::boolean THEN fd.pk_device_id = $2::bigint ELSE FALSE END)
        OR fd.external_device_id = $3`,
    [isNumeric, isNumeric ? parseInt(clientId) : null, String(clientId)]
  );
  return result.rows[0] || null;
}

// Update device last seen timestamp
export async function updateDeviceLastSeen(deviceId) {
  await pool.query(
    `UPDATE facility_device
     SET last_active = NOW(),
         last_heartbeat = NOW()
     WHERE pk_device_id = $1`,
    [deviceId]
  );
}

