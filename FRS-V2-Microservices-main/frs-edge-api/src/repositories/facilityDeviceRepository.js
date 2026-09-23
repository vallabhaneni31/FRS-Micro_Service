import { pool } from '../db/pool.js';

// ============================================================================
// TOP-LEVEL LIST (cameras + nug boxes)
// ============================================================================

export async function listCamerasForTenant(tenantId) {
  const { rows } = await pool.query(`
    SELECT c.pk_camera_id::text as id, c.name, c.ip_address, c.status,
           'camera' as device_type, c.last_active, c.model
    FROM frs_camera c
    LEFT JOIN frs_nug_box n ON n.pk_nug_id = c.fk_nug_id
    LEFT JOIN frs_site s ON s.pk_site_id = n.fk_site_id
    LEFT JOIN frs_customer cu ON cu.pk_customer_id = s.fk_customer_id
    WHERE cu.fk_tenant_id = $1::uuid
    ORDER BY c.name
  `, [tenantId]);
  return rows;
}

export async function listNugBoxesForTenant(tenantId) {
  const { rows } = await pool.query(`
    SELECT n.pk_nug_id::text as id, n.name, n.ip_address,
           CASE WHEN n.last_heartbeat > NOW() - INTERVAL '90 seconds' THEN 'online' ELSE 'offline' END as status,
           'ai_node' as device_type, n.last_heartbeat as last_active, 'Jetson Orin' as model
    FROM frs_nug_box n
    LEFT JOIN frs_site s ON s.pk_site_id = n.fk_site_id
    LEFT JOIN frs_customer cu ON cu.pk_customer_id = s.fk_customer_id
    WHERE cu.fk_tenant_id = $1::uuid
    ORDER BY n.name
  `, [tenantId]);
  return rows;
}

// ============================================================================
// BACKGROUND MAINTENANCE
// ============================================================================

export async function cleanupOldTelemetryHistory() {
  await pool.query("DELETE FROM frs_telemetry_history WHERE timestamp < NOW() - INTERVAL '2 days'");
}

export async function cleanupOldPresencePings(retentionDays) {
  await pool.query(
    `DELETE FROM attendance_ping WHERE occurred_at < NOW() - ($1 || ' days')::interval`,
    [String(retentionDays)]
  );
}

// ============================================================================
// BUILDINGS
// ============================================================================

export async function listBuildings(siteId) {
  const { rows } = await pool.query(`
    SELECT b.*,
      COUNT(DISTINCT f.pk_floor_id)::int as floor_count,
      COUNT(DISTINCT n.pk_nug_id)::int as nug_count,
      COUNT(DISTINCT c.pk_camera_id)::int as camera_count
    FROM frs_building b
    LEFT JOIN frs_floor f ON f.fk_building_id = b.pk_building_id
    LEFT JOIN frs_nug_box n ON n.fk_building_id = b.pk_building_id
    LEFT JOIN frs_camera c ON c.fk_floor_id = f.pk_floor_id
    WHERE b.fk_site_id = $1
    GROUP BY b.pk_building_id ORDER BY b.name
  `, [siteId]);
  return rows;
}

export async function createBuilding({ siteId, name, address }) {
  const { rows } = await pool.query(
    `INSERT INTO frs_building (fk_site_id, name, address) VALUES ($1,$2,$3) RETURNING *`,
    [siteId, name, address || null]
  );
  return rows[0];
}

export async function updateBuilding({ id, siteId, name, address }) {
  const { rows } = await pool.query(
    `UPDATE frs_building SET name=COALESCE($2,name), address=COALESCE($3,address)
     WHERE pk_building_id=$1 AND fk_site_id=$4 RETURNING *`,
    [id, name, address, siteId]
  );
  return rows[0] ?? null;
}

export async function deleteBuilding({ id, siteId }) {
  const { rowCount } = await pool.query(
    `DELETE FROM frs_building WHERE pk_building_id=$1 AND fk_site_id=$2`,
    [id, siteId]
  );
  return rowCount > 0;
}

// ============================================================================
// FLOORS
// ============================================================================

export async function listFloorsForBuilding(buildingId, siteId) {
  const { rows } = await pool.query(`
    SELECT f.*,
      COUNT(DISTINCT z.pk_zone_id)::int as zone_count,
      (SELECT COUNT(*)::int FROM facility_device c JOIN facility_device p ON p.pk_device_id = c.parent_device_id WHERE p.fk_floor_id = f.pk_floor_id AND c.decommissioned_at IS NULL AND p.decommissioned_at IS NULL) as camera_count,
      (SELECT COUNT(*)::int FROM facility_device fd WHERE fd.fk_floor_id = f.pk_floor_id AND fd.parent_device_id IS NULL AND fd.decommissioned_at IS NULL) as device_count
    FROM frs_floor f
    JOIN frs_building b ON b.pk_building_id = f.fk_building_id
    LEFT JOIN frs_zone z ON z.fk_floor_id = f.pk_floor_id
    WHERE f.fk_building_id = $1 AND b.fk_site_id = $2
    GROUP BY f.pk_floor_id ORDER BY f.floor_number
  `, [buildingId, siteId]);
  return rows;
}

export async function findBuildingForSite(buildingId, siteId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM frs_building WHERE pk_building_id=$1 AND fk_site_id=$2',
    [buildingId, siteId]
  );
  return rows.length > 0;
}

export async function createFloor({ buildingId, floorNumber, floorName }) {
  const { rows } = await pool.query(
    `INSERT INTO frs_floor (fk_building_id, floor_number, floor_name) VALUES ($1,$2,$3) RETURNING *`,
    [buildingId, floorNumber, floorName || `Floor ${floorNumber}`]
  );
  return rows[0];
}

export async function findFloorOwnedBySite(floorId, siteId) {
  const parsedSiteId = (siteId && !isNaN(Number(siteId))) ? parseInt(String(siteId), 10) : null;
  const { rows } = await pool.query(
    `SELECT 1 FROM frs_floor f
     WHERE f.pk_floor_id = $1 AND ($2::bigint IS NULL OR f.fk_site_id = $2::bigint OR EXISTS (
       SELECT 1 FROM frs_building b WHERE b.pk_building_id = f.fk_building_id AND b.fk_site_id = $2::bigint
     ))`,
    [floorId, parsedSiteId]
  );
  return rows.length > 0;
}

export async function updateFloor({ id, siteId, floorName, floorNumber, floorPlanUrl, floorPlanData }) {
  const parsedSiteId = (siteId && !isNaN(Number(siteId))) ? parseInt(String(siteId), 10) : null;
  const { rows } = await pool.query(
    `UPDATE frs_floor f SET
      floor_name=COALESCE($2,f.floor_name),
      floor_number=COALESCE($3,f.floor_number),
      floor_plan_url=COALESCE($4,f.floor_plan_url),
      floor_plan_data=COALESCE($5,f.floor_plan_data)
     WHERE f.pk_floor_id=$1 AND ($6::bigint IS NULL OR f.fk_site_id = $6::bigint OR EXISTS (
       SELECT 1 FROM frs_building b WHERE b.pk_building_id = f.fk_building_id AND b.fk_site_id = $6::bigint
     ))
     RETURNING f.*`,
    [id, floorName, floorNumber, floorPlanUrl, floorPlanData ? JSON.stringify(floorPlanData) : null, parsedSiteId]
  );
  return rows[0] ?? null;
}

export async function deleteFloor({ id, siteId }) {
  const parsedSiteId = (siteId && !isNaN(Number(siteId))) ? parseInt(String(siteId), 10) : null;
  const { rowCount } = await pool.query(
    `DELETE FROM frs_floor f
     WHERE f.pk_floor_id = $1 AND ($2::bigint IS NULL OR f.fk_site_id = $2::bigint OR EXISTS (
       SELECT 1 FROM frs_building b WHERE b.pk_building_id = f.fk_building_id AND b.fk_site_id = $2::bigint
     ))`,
    [id, parsedSiteId]
  );
  return rowCount > 0;
}

export async function updateFloorPlan({ id, siteId, floorPlanUrl, floorPlanData }) {
  const parsedSiteId = (siteId && !isNaN(Number(siteId))) ? parseInt(String(siteId), 10) : null;
  const { rows } = await pool.query(`
    UPDATE frs_floor f SET
      floor_plan_url = COALESCE($2, f.floor_plan_url),
      floor_plan_data = COALESCE($3, f.floor_plan_data)
    WHERE f.pk_floor_id = $1 AND ($4::bigint IS NULL OR f.fk_site_id = $4::bigint OR EXISTS (
      SELECT 1 FROM frs_building b WHERE b.pk_building_id = f.fk_building_id AND b.fk_site_id = $4::bigint
    ))
    RETURNING f.*
  `, [id, floorPlanUrl || null, floorPlanData ? JSON.stringify(floorPlanData) : null, parsedSiteId]);
  return rows[0] ?? null;
}

export async function listFloorsForSite(siteId) {
  const parsedSiteId = (siteId && !isNaN(Number(siteId))) ? parseInt(String(siteId), 10) : null;
  const { rows } = await pool.query(`
    SELECT f.*,
      (SELECT COUNT(*)::int FROM frs_camera fc JOIN frs_nug_box fn ON fn.pk_nug_id = fc.fk_nug_id WHERE fn.fk_floor_id = f.pk_floor_id) as camera_count,
      (SELECT COUNT(*)::int FROM frs_nug_box fn WHERE fn.fk_floor_id = f.pk_floor_id) as device_count
    FROM frs_floor f
    LEFT JOIN frs_building b ON b.pk_building_id = f.fk_building_id
    WHERE ($1::bigint IS NULL OR b.fk_site_id = $1::bigint OR f.fk_site_id = $1::bigint)
    ORDER BY f.floor_number
  `, [parsedSiteId]);
  return rows;
}

export async function createFloorForSite({ siteId, floorNumber, floorName }) {
  const parsedSiteId = (siteId && !isNaN(Number(siteId))) ? parseInt(String(siteId), 10) : null;

  let buildingRes = await pool.query(
    `SELECT pk_building_id FROM frs_building WHERE ($1::bigint IS NULL OR fk_site_id = $1::bigint) ORDER BY pk_building_id LIMIT 1`,
    [parsedSiteId]
  );
  let buildingId = buildingRes.rows[0]?.pk_building_id;
  if (!buildingId) {
    const newBld = await pool.query(
      `INSERT INTO frs_building (fk_site_id, name) VALUES ($1, 'Main Building') RETURNING pk_building_id`,
      [parsedSiteId]
    );
    buildingId = newBld.rows[0].pk_building_id;
  }

  const { rows } = await pool.query(
    `INSERT INTO frs_floor (fk_building_id, floor_number, floor_name) VALUES ($1,$2,$3) RETURNING *`,
    [buildingId, floorNumber, floorName || `Floor ${floorNumber}`]
  );
  return rows[0];
}

// ============================================================================
// ZONES
// ============================================================================

export async function listZonesForFloor(floorId, siteId) {
  const { rows } = await pool.query(
    `SELECT z.*, COUNT(c.pk_camera_id)::int as camera_count
     FROM frs_zone z
     JOIN frs_floor f ON f.pk_floor_id = z.fk_floor_id
     JOIN frs_building b ON b.pk_building_id = f.fk_building_id
     LEFT JOIN frs_camera c ON c.fk_zone_id = z.pk_zone_id
     WHERE z.fk_floor_id=$1 AND b.fk_site_id = $2
     GROUP BY z.pk_zone_id ORDER BY z.zone_name`,
    [floorId, siteId]
  );
  return rows;
}

export async function createZone({ floorId, zoneName, zoneType }) {
  const { rows } = await pool.query(
    `INSERT INTO frs_zone (fk_floor_id, zone_name, zone_type) VALUES ($1,$2,$3) RETURNING *`,
    [floorId, zoneName, zoneType || 'common']
  );
  return rows[0];
}

export async function deleteZone({ id, siteId }) {
  const { rowCount } = await pool.query(
    `DELETE FROM frs_zone z
     USING frs_floor f, frs_building b
     WHERE z.pk_zone_id = $1 AND z.fk_floor_id = f.pk_floor_id AND f.fk_building_id = b.pk_building_id AND b.fk_site_id = $2`,
    [id, siteId]
  );
  return rowCount > 0;
}

export async function getZoneName(zoneId) {
  const z = await pool.query('SELECT zone_name FROM frs_zone WHERE pk_zone_id = $1', [zoneId]);
  return z.rows[0]?.zone_name ?? null;
}

export async function getFloorName(floorId) {
  const f = await pool.query('SELECT floor_name FROM frs_floor WHERE pk_floor_id = $1', [floorId]);
  return f.rows[0]?.floor_name ?? null;
}

// ============================================================================
// NUG BOXES
// ============================================================================

export async function listNugBoxes({ siteId, tenantId }) {
  const whereClause = siteId
    ? 'WHERE n.fk_site_id = $1'
    : `WHERE n.fk_site_id IN (
         SELECT s.pk_site_id FROM frs_site s
         JOIN frs_customer cu ON cu.pk_customer_id = s.fk_customer_id
         WHERE cu.fk_tenant_id = $1::uuid)`;
  const { rows } = await pool.query(`
    SELECT n.*,
      b.name as building_name,
      f.floor_name, f.floor_number,
      z.zone_name,
      COUNT(c.pk_camera_id)::int as camera_count,
      COUNT(CASE WHEN c.status='online' THEN 1 END)::int as cameras_online
    FROM frs_nug_box n
    LEFT JOIN frs_building b ON b.pk_building_id = n.fk_building_id
    LEFT JOIN frs_floor f ON f.pk_floor_id = n.fk_floor_id
    LEFT JOIN frs_zone z ON z.pk_zone_id = n.fk_zone_id
    LEFT JOIN frs_camera c ON c.fk_nug_id = n.pk_nug_id
    ${whereClause}
    GROUP BY n.pk_nug_id, b.name, f.floor_name, f.floor_number, z.zone_name
    ORDER BY f.floor_number, n.name
  `, [siteId ?? tenantId]);
  return rows;
}

export async function getNugBoxWithCameras(id) {
  const { rows } = await pool.query(`
    SELECT n.*,
      b.name as building_name,
      f.floor_name, f.floor_number,
      z.zone_name,
      json_agg(json_build_object(
        'pk_camera_id', c.pk_camera_id,
        'name', c.name,
        'cam_id', c.cam_id,
        'ip_address', c.ip_address,
        'rtsp_url', c.rtsp_url,
        'status', c.status,
        'recognition_accuracy', c.recognition_accuracy,
        'total_scans', c.total_scans,
        'map_x', c.map_x, 'map_y', c.map_y, 'map_angle', c.map_angle,
        'last_active', c.last_active
      ) ORDER BY c.name) FILTER (WHERE c.pk_camera_id IS NOT NULL) as cameras
    FROM frs_nug_box n
    LEFT JOIN frs_building b ON b.pk_building_id = n.fk_building_id
    LEFT JOIN frs_floor f ON f.pk_floor_id = n.fk_floor_id
    LEFT JOIN frs_zone z ON z.pk_zone_id = n.fk_zone_id
    LEFT JOIN frs_camera c ON c.fk_nug_id = n.pk_nug_id
    WHERE n.pk_nug_id = $1
    GROUP BY n.pk_nug_id, b.name, f.floor_name, f.floor_number, z.zone_name
  `, [id]);
  return rows[0] ?? null;
}

export async function siteBelongsToTenant(siteId, tenantId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM frs_site s
     JOIN frs_customer cu ON cu.pk_customer_id = s.fk_customer_id
     WHERE s.pk_site_id = $1 AND cu.fk_tenant_id = $2::uuid`,
    [siteId, tenantId]
  );
  return rows.length > 0;
}

export async function findFirstSiteForTenant(tenantId) {
  const { rows } = await pool.query(
    `SELECT s.pk_site_id FROM frs_site s
     JOIN frs_customer cu ON cu.pk_customer_id = s.fk_customer_id
     WHERE cu.fk_tenant_id = $1::uuid ORDER BY s.pk_site_id LIMIT 1`,
    [tenantId]
  );
  return rows[0]?.pk_site_id ?? null;
}

export async function createNugBox(fields) {
  const { rows } = await pool.query(`
    INSERT INTO frs_nug_box (fk_site_id, fk_building_id, fk_floor_id, fk_zone_id,
      name, device_code, ip_address, port, match_threshold, conf_threshold,
      cooldown_seconds, x_threshold, tracking_window)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *
  `, [fields.siteId, fields.buildingId, fields.floorId, fields.zoneId,
      fields.name, fields.deviceCode, fields.ipAddress, fields.port,
      fields.matchThreshold, fields.confThreshold, fields.cooldownSeconds,
      fields.xThreshold, fields.trackingWindow]);
  return rows[0];
}

export async function upsertFacilityDeviceForNug({ tenantId, siteId, deviceCode, name, ipAddress, port, floorId }) {
  await pool.query(`
    INSERT INTO facility_device
      (tenant_id, site_id, external_device_id, name, location_label, ip_address,
       status, device_type_id, device_config, fk_floor_id)
    VALUES ($1::uuid, $2, $3, $4, $5, $6, 'offline',
            (SELECT pk_device_type_id FROM device_type WHERE type_code = 'jetson_orin_nx'),
            jsonb_build_object('port', $7::int), $8)
    ON CONFLICT (tenant_id, external_device_id) DO UPDATE
      SET name = EXCLUDED.name, ip_address = EXCLUDED.ip_address, site_id = EXCLUDED.site_id, fk_floor_id = EXCLUDED.fk_floor_id
  `, [tenantId, siteId, deviceCode, name, name, ipAddress, port, floorId || null]);
}

export async function updateNugBox(fields) {
  const { rows } = await pool.query(`
    UPDATE frs_nug_box SET
      name=COALESCE($2,name), ip_address=COALESCE($3,ip_address),
      port=COALESCE($4,port), fk_building_id=COALESCE($5,fk_building_id),
      fk_floor_id=COALESCE($6,fk_floor_id), fk_zone_id=COALESCE($7,fk_zone_id),
      match_threshold=COALESCE($8,match_threshold), conf_threshold=COALESCE($9,conf_threshold),
      cooldown_seconds=COALESCE($10,cooldown_seconds), x_threshold=COALESCE($11,x_threshold),
      tracking_window=COALESCE($12,tracking_window),
      map_x=COALESCE($13,map_x), map_y=COALESCE($14,map_y)
    WHERE pk_nug_id=$1 RETURNING *
  `, [fields.id, fields.name, fields.ipAddress, fields.port, fields.buildingId, fields.floorId,
      fields.zoneId, fields.matchThreshold, fields.confThreshold, fields.cooldownSeconds,
      fields.xThreshold, fields.trackingWindow, fields.mapX, fields.mapY]);
  return rows[0] ?? null;
}

export async function getNugBoxName(id) {
  const { rows } = await pool.query(`SELECT name FROM frs_nug_box WHERE pk_nug_id=$1`, [id]);
  return rows[0]?.name ?? null;
}

export async function deleteNugBox(id) {
  await pool.query(`DELETE FROM frs_nug_box WHERE pk_nug_id=$1`, [id]);
}

export async function getNugBoxConnection(id) {
  const { rows } = await pool.query(`SELECT ip_address, port FROM frs_nug_box WHERE pk_nug_id=$1`, [id]);
  return rows[0] ?? null;
}

export async function markNugBoxOnline(id) {
  await pool.query(`UPDATE frs_nug_box SET status='online', last_heartbeat=NOW() WHERE pk_nug_id=$1`, [id]);
}

export async function markNugBoxOffline(id) {
  await pool.query(`UPDATE frs_nug_box SET status='offline' WHERE pk_nug_id=$1`, [id]);
}

export async function getNugBoxWithTenant(id) {
  const { rows } = await pool.query(`
    SELECT n.*, cu.fk_tenant_id
    FROM frs_nug_box n
    JOIN frs_site s ON s.pk_site_id = n.fk_site_id
    JOIN frs_customer cu ON cu.pk_customer_id = s.fk_customer_id
    WHERE n.pk_nug_id = $1
  `, [id]);
  return rows[0] ?? null;
}

export async function markNugBoxRebooting(id) {
  await pool.query(`UPDATE frs_nug_box SET status='rebooting', last_heartbeat=NOW() WHERE pk_nug_id=$1`, [id]);
}

// ============================================================================
// HEARTBEATS (device-authenticated, called by live Jetson devices)
// ============================================================================

export async function updateCameraHeartbeat(camId, status) {
  await pool.query(
    `UPDATE frs_camera SET status=$2, last_active=NOW() WHERE cam_id=$1`,
    [camId, status]
  );
  await pool.query(
    `UPDATE facility_device SET status=$2, last_active=NOW(), last_heartbeat=NOW() WHERE external_device_id=$1`,
    [camId, status]
  );
}

export async function updateNugBoxHeartbeat(code, fields) {
  const { rows } = await pool.query(`
    UPDATE frs_nug_box SET
      status=COALESCE($2,status),
      cpu_percent=$3, memory_used_mb=$4, memory_total_mb=$5,
      gpu_percent=$6, temperature_c=$7, disk_used_gb=$8,
      uptime_seconds=$9, last_heartbeat=NOW(),
      ip_address=COALESCE(NULLIF($10,''), ip_address),
      disk_total_gb=$11, disk_free_gb=$12
    WHERE device_code=$1 RETURNING pk_nug_id
  `, [code, fields.status || 'online', fields.cpuPercent ?? null, fields.memoryUsedMb ?? null,
      fields.memoryTotalMb ?? null, fields.gpuPercent ?? null, fields.temperatureC ?? null,
      fields.diskUsedGb ?? null, fields.uptimeSeconds ?? null, fields.resolvedIp || '',
      fields.diskTotalGb ?? null, fields.diskFreeGb ?? null]);
  return rows;
}

export async function syncFacilityDeviceHeartbeat(code, fields) {
  await pool.query(`
    UPDATE facility_device SET
      status = $2,
      last_active = NOW(),
      last_heartbeat = NOW(),
      device_config = COALESCE(device_config, '{}'::jsonb) || jsonb_build_object(
        'cpu_percent',    $3::numeric,
        'memory_used_mb', $4::numeric,
        'memory_total_mb',$5::numeric,
        'gpu_percent',    $6::numeric,
        'temperature_c',  $7::numeric,
        'disk_used_gb',   $8::numeric,
        'disk_total_gb',  $9::numeric,
        'disk_free_gb',   $10::numeric,
        'uptime_seconds', $11::numeric
      )
    WHERE external_device_id = $1
  `, [
    code,
    fields.status || 'online',
    fields.cpuPercent ?? null,
    fields.memoryUsedMb ?? null,
    fields.memoryTotalMb ?? null,
    fields.gpuPercent ?? null,
    fields.temperatureC ?? null,
    fields.diskUsedGb ?? null,
    fields.diskTotalGb ?? null,
    fields.diskFreeGb ?? null,
    fields.uptimeSeconds ?? null,
  ]);
}

export async function updateCameraStatsFromHeartbeat(cam) {
  const accuracy = parseFloat(cam.accuracy);
  const sanitizedAccuracy = isNaN(accuracy) ? null : accuracy;
  const totalScans = cam.total_scans !== undefined ? parseInt(cam.total_scans) : null;
  const errorRate = cam.error_rate !== undefined ? parseFloat(cam.error_rate) : null;

  await pool.query(`
    UPDATE frs_camera SET 
      status=$2, 
      recognition_accuracy=COALESCE($3, recognition_accuracy),
      total_scans=COALESCE($4, total_scans), 
      error_rate=COALESCE($5, error_rate), 
      last_active=NOW()
    WHERE cam_id=$1
  `, [cam.cam_id, cam.status || 'online', sanitizedAccuracy, totalScans, errorRate]);

  await pool.query(`
    UPDATE facility_device SET 
      status=$2, 
      recognition_accuracy=COALESCE($3, recognition_accuracy),
      total_scans=COALESCE($4, total_scans), 
      last_active=NOW(), 
      last_heartbeat=NOW()
    WHERE external_device_id=$1
  `, [cam.cam_id, cam.status || 'online', sanitizedAccuracy, totalScans]);
}

export async function updateEdgeNodeStatsFromCameras(code) {
  await pool.query(`
    UPDATE facility_device parent
    SET 
      total_scans = (
        SELECT COALESCE(SUM(child.total_scans), 0)
        FROM facility_device child
        WHERE child.parent_device_id = parent.pk_device_id
          AND child.decommissioned_at IS NULL
      ),
      recognition_accuracy = (
        SELECT COALESCE(AVG(child.recognition_accuracy), 0)
        FROM facility_device child
        WHERE child.parent_device_id = parent.pk_device_id
          AND child.decommissioned_at IS NULL
          AND child.recognition_accuracy IS NOT NULL
      )
    WHERE parent.external_device_id = $1
  `, [code]);
}

// ============================================================================
// ENROLLMENT QUALITY (Jetson polling)
// ============================================================================

export async function findTenantForDeviceCode(code) {
  const { rows } = await pool.query(`
    SELECT tenant_id
    FROM facility_device
    WHERE external_device_id = $1 LIMIT 1
  `, [code]);
  return rows[0]?.tenant_id ?? null;
}

export async function listInvitationsPendingQuality(tenantId) {
  const { rows } = await pool.query(`
    SELECT pk_invitation_id, fk_employee_id, photo_paths, quality_scores
    FROM enrollment_invitations
    WHERE mt_tenant_id = $1::uuid
      AND status IN ('in_progress','completed')
      AND photo_paths IS NOT NULL
      AND quality_scores IS NOT NULL
      AND quality_scores::text LIKE '%null%'
    ORDER BY updated_at ASC
    LIMIT 20
  `, [tenantId]);
  return rows;
}

export async function getInvitationQuality(invitationId) {
  const { rows } = await pool.query(
    `SELECT pk_invitation_id, quality_scores FROM enrollment_invitations WHERE pk_invitation_id=$1`,
    [invitationId]
  );
  return rows[0] ?? null;
}

export async function updateInvitationQuality(invitationId, { qualities, avgQuality, newApprovalStatus }) {
  await pool.query(
    `UPDATE enrollment_invitations
     SET quality_scores=$1,
         average_quality=$2,
         approval_status=COALESCE($3, approval_status),
         updated_at=NOW()
     WHERE pk_invitation_id=$4`,
    [JSON.stringify(qualities), avgQuality, newApprovalStatus, invitationId]
  );
}

// ============================================================================
// CAMERAS
// ============================================================================

export async function listCameras(nugId) {
  const { rows } = await pool.query(`
    SELECT c.*,
      n.name as nug_name, n.ip_address as nug_ip,
      f.floor_name, f.floor_number,
      z.zone_name
    FROM frs_camera c
    LEFT JOIN frs_nug_box n ON n.pk_nug_id = c.fk_nug_id
    LEFT JOIN frs_floor f ON f.pk_floor_id = c.fk_floor_id
    LEFT JOIN frs_zone z ON z.pk_zone_id = c.fk_zone_id
    ${nugId ? 'WHERE c.fk_nug_id=$1' : ''}
    ORDER BY f.floor_number, c.name
  `, nugId ? [nugId] : []);
  return rows;
}

export async function findNugDeviceCode(client, nugId) {
  const nugRow = await client.query(
    'SELECT device_code FROM frs_nug_box WHERE pk_nug_id = $1', [nugId]
  );
  return nugRow.rows[0]?.device_code ?? null;
}

export async function findFacilityDeviceByExternalId(client, tenantId, externalDeviceId) {
  const devRow = await client.query(
    'SELECT pk_device_id FROM facility_device WHERE tenant_id = $1::uuid AND external_device_id = $2',
    [tenantId, externalDeviceId]
  );
  return devRow.rows[0]?.pk_device_id ?? null;
}

export async function findFacilityDeviceByIdTx(client, tenantId, deviceId) {
  const { rows } = await client.query(
    'SELECT pk_device_id, fk_floor_id FROM facility_device WHERE tenant_id = $1::uuid AND pk_device_id = $2',
    [tenantId, deviceId]
  );
  return rows[0] ?? null;
}

export async function getZoneNameTx(client, zoneId) {
  const z = await client.query('SELECT zone_name FROM frs_zone WHERE pk_zone_id = $1', [zoneId]);
  return z.rows[0]?.zone_name ?? null;
}

export async function getFloorNameTx(client, floorId) {
  const f = await client.query('SELECT floor_name FROM frs_floor WHERE pk_floor_id = $1', [floorId]);
  return f.rows[0]?.floor_name ?? null;
}

export async function getCameraDeviceTypeId(client) {
  const dtRow = await client.query(
    `SELECT pk_device_type_id FROM device_type WHERE category = 'camera' LIMIT 1`
  );
  return dtRow.rows[0]?.pk_device_type_id ?? null;
}

export async function insertCamera(client, fields) {
  const { rows } = await client.query(`
    INSERT INTO frs_camera (fk_nug_id, fk_floor_id, fk_zone_id, name, cam_id,
      rtsp_url, ip_address, model, map_x, map_y, map_angle)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
  `, [fields.nugId, fields.floorId, fields.zoneId, fields.name, fields.camId,
      fields.rtspUrl, fields.ipAddress, fields.model, fields.mapX, fields.mapY, fields.mapAngle]);
  return rows[0];
}

export async function upsertFacilityDeviceForCamera(client, fields) {
  await client.query(`
    INSERT INTO facility_device
      (tenant_id, customer_id, site_id, external_device_id, name,
       ip_address, status, model, location_label, parent_device_id, device_type_id, camera_mode, fk_floor_id)
    VALUES ($1, $2, $3, $4, $5, $6, 'offline', $7, $8, $9, $10, $11, $12)
    ON CONFLICT (tenant_id, external_device_id) DO UPDATE SET
      name             = EXCLUDED.name,
      ip_address       = EXCLUDED.ip_address,
      location_label   = EXCLUDED.location_label,
      parent_device_id = EXCLUDED.parent_device_id,
      device_type_id   = EXCLUDED.device_type_id,
      camera_mode      = EXCLUDED.camera_mode,
      fk_floor_id      = EXCLUDED.fk_floor_id,
      customer_id      = EXCLUDED.customer_id,
      site_id          = EXCLUDED.site_id,
      status           = 'offline',
      -- Re-creating a camera whose cam_id was previously decommissioned must
      -- resurrect this row, not leave it silently hidden: listEdgeDevices
      -- (and every other listing) filters on decommissioned_at IS NULL, so a
      -- stale decommission here made the new camera invisible in the UI even
      -- though frs_camera + this upsert both "succeeded".
      decommissioned_at = NULL,
      decommissioned_by = NULL
  `, [fields.tenantId, fields.customerId, fields.siteId, fields.camId, fields.name,
      fields.ipAddress, fields.model, fields.locationLabel, fields.parentDeviceId,
      fields.cameraDeviceTypeId, fields.cameraMode, fields.floorId || null]);
}

// Cameras have no tenant_id/site_id column of their own — ownership is
// verified via the facility_device mirror row every camera is upserted into
// (keyed on cam_id == external_device_id), which IS tenant-scoped.
export async function findCameraForUpdate(client, id, tenantId) {
  const existing = await client.query(
    `SELECT c.cam_id, c.fk_zone_id, c.fk_floor_id, c.fk_nug_id
     FROM frs_camera c
     JOIN facility_device fd ON fd.external_device_id = c.cam_id AND fd.tenant_id = $2::uuid
     WHERE c.pk_camera_id = $1`,
    [id, tenantId]
  );
  return existing.rows[0] ?? null;
}

export async function updateCamera(client, fields) {
  const { rows } = await client.query(`
    UPDATE frs_camera c SET
      name=COALESCE($2,c.name), cam_id=COALESCE($3,c.cam_id),
      rtsp_url=COALESCE($4,c.rtsp_url), ip_address=COALESCE($5,c.ip_address),
      model=COALESCE($6,c.model), fk_nug_id=COALESCE($7,c.fk_nug_id),
      fk_floor_id=COALESCE($8,c.fk_floor_id), fk_zone_id=COALESCE($9,c.fk_zone_id),
      map_x=COALESCE($10,c.map_x), map_y=COALESCE($11,c.map_y),
      map_angle=COALESCE($12,c.map_angle)
    FROM facility_device fd
    WHERE c.pk_camera_id=$1 AND fd.external_device_id = c.cam_id AND fd.tenant_id = $13::uuid
    RETURNING c.*
  `, [fields.id, fields.name, fields.camId, fields.rtspUrl, fields.ipAddress, fields.model,
      fields.nugId, fields.floorId, fields.zoneId, fields.mapX, fields.mapY, fields.mapAngle, fields.tenantId]);
  return rows[0] ?? null;
}

export async function syncFacilityDeviceForCameraUpdate(client, fields) {
  await client.query(`
    UPDATE facility_device SET
      external_device_id = $2,
      name               = $3,
      ip_address         = COALESCE(NULLIF($4, ''), '0.0.0.0'),
      model              = COALESCE($5, 'IP Camera'),
      location_label     = $6,
      -- Only overwrite when a parent was actually resolved. Cameras whose
      -- fk_nug_id is empty (the norm — attachment is tracked via
      -- facility_device.parent_device_id, not the legacy nug_box FK) would
      -- otherwise always resolve to null here and silently detach the
      -- camera from its device on every unrelated edit (e.g. renaming its
      -- cam_id), making it vanish from the device's attached-cameras list
      -- while cam_id stays reserved system-wide.
      parent_device_id   = COALESCE($7, parent_device_id),
      camera_mode        = COALESCE($9, camera_mode, 'MIXED'),
      -- Explicit reassignment only — a camera's site is otherwise permanent
      -- once set, so a single edge box's cameras can each be independently
      -- assigned to whichever site they physically belong to.
      site_id            = COALESCE($10, site_id),
      customer_id        = COALESCE($11, customer_id)
    WHERE tenant_id = $1::uuid AND external_device_id = $8
  `, [fields.tenantId, fields.newCamId, fields.name,
      fields.ipAddress, fields.model, fields.locationLabel, fields.parentDeviceId, fields.oldCamId, fields.cameraMode,
      fields.siteId ?? null, fields.customerId ?? null]);
}

export async function updateCameraModeByExternalOrPk({ cameraMode, camId, tenantId }) {
  const { rows } = await pool.query(
    `UPDATE facility_device SET camera_mode = $1
     WHERE (external_device_id = $2 OR pk_device_id::text = $2)
       AND ($3::uuid IS NULL OR tenant_id = $3::uuid)
     RETURNING pk_device_id, external_device_id, camera_mode`,
    [cameraMode, camId, tenantId]
  );
  return rows[0] ?? null;
}

export async function findCameraCamId(client, id, tenantId) {
  const { rows } = await client.query(
    `SELECT COALESCE(fd.external_device_id, c.cam_id) AS cam_id
     FROM facility_device fd
     FULL OUTER JOIN frs_camera c ON c.cam_id = fd.external_device_id
     WHERE (
       (CASE WHEN $1 ~ '^[0-9]+$' THEN fd.pk_device_id = $1::bigint ELSE false END)
       OR (CASE WHEN $1 ~ '^[0-9]+$' THEN c.pk_camera_id = $1::int ELSE false END)
       OR fd.external_device_id = $1
       OR c.cam_id = $1
     )
     AND ($2::uuid IS NULL OR fd.tenant_id = $2::uuid OR fd.tenant_id IS NULL)
     LIMIT 1`,
    [String(id), tenantId]
  );
  return rows[0]?.cam_id ?? String(id);
}

export async function deleteCamera(client, id, camId) {
  try {
    await client.query(
      `DELETE FROM frs_camera 
       WHERE (
         (CASE WHEN $1 ~ '^[0-9]+$' THEN pk_camera_id = $1::int ELSE false END)
         OR cam_id = $1 
         OR cam_id = $2
       )`,
      [String(id), String(camId || id)]
    );
  } catch (err) {
    await client.query(
      `UPDATE frs_camera 
       SET fk_nug_id = NULL, status = 'offline'
       WHERE (
         (CASE WHEN $1 ~ '^[0-9]+$' THEN pk_camera_id = $1::int ELSE false END)
         OR cam_id = $1 
         OR cam_id = $2
       )`,
      [String(id), String(camId || id)]
    );
  }
}

export async function deleteFacilityDeviceByExternalId(client, camId, tenantId, id) {
  await client.query(
    `UPDATE facility_device 
     SET decommissioned_at = NOW(), parent_device_id = NULL
     WHERE (
       (CASE WHEN $2 ~ '^[0-9]+$' THEN pk_device_id = $2::bigint ELSE false END)
       OR external_device_id = $1 
       OR external_device_id = $2
     )
     AND ($3::uuid IS NULL OR tenant_id = $3::uuid)`,
    [String(camId || id), String(id), tenantId]
  );
}

// Shared by GET /api/cameras (device's FaceSync client) and the
// device-config poll (GET /api/device-management/device/config/:code) —
// both need the exact same camera list/shape for a given edge box, and
// keeping one source of truth avoids the two drifting apart.
export async function getCamerasForDevice(parentDeviceId, tenantId, callerDeviceCode) {
  const { rows } = await pool.query(`
    SELECT
      c.external_device_id AS code,
      c.name,
      c.location_label AS location,
      c.ip_address::text AS "ipAddress",
      c.status,
      c.camera_mode,
      c.device_config,
      fc.rtsp_url
    FROM facility_device c
    LEFT JOIN frs_camera fc ON fc.cam_id = c.external_device_id
    WHERE c.parent_device_id = $1
      AND c.tenant_id = $2::uuid
      AND c.decommissioned_at IS NULL
    ORDER BY c.name
  `, [parentDeviceId, tenantId]);

  // Only set if the deployment configures a shared camera admin credential;
  // never hardcode a real password here. Cameras created through the normal
  // "+ Attach New" flow already have a full rtsp_url on frs_camera and never
  // need this fallback — it only applies to cameras registered without one.
  const defaultCreds = process.env.DEFAULT_CAMERA_RTSP_CREDENTIALS || '';

  return rows.map((c) => {
    const cfg = c.device_config || {};
    const rtspUrl = c.rtsp_url || cfg.rtsp_url || (defaultCreds
      ? `rtsp://${defaultCreds}@${c.ipAddress}:554/video/live`
      : `rtsp://${c.ipAddress}:554/video/live`);

    let role = cfg.role || (c.camera_mode === 'OUT' ? 'exit' : c.camera_mode === 'IN' ? 'entry' : null);
    if (!role) {
      role = `${c.name} ${c.code}`.toLowerCase().includes('exit') ? 'exit' : 'entry';
    }

    return {
      code: c.code,
      name: c.name,
      location: c.location || 'Not set',
      ipAddress: c.ipAddress,
      device_code: callerDeviceCode,
      status: c.status,
      config: {
        rtsp_url: rtspUrl,
        role,
        enabled: cfg.enabled ?? true,
        fps_target: cfg.fps_target ?? 25,
        width: cfg.width ?? 1920,
        height: cfg.height ?? 1080,
        hw_decode: cfg.hw_decode ?? true,
        ...(cfg.MaskIn ? { MaskIn: cfg.MaskIn } : {}),
        ...(cfg.MaskOut ? { MaskOut: cfg.MaskOut } : {}),
        ...(cfg.notes ? { notes: cfg.notes } : {}),
      },
    };
  });
}

// ============================================================================
// EDGE-BOX-INITIATED CAMERA SYNC
// (POST /api/cameras/device-sync — box pushes its own current camera list so
// the app catches up, then the normal GET /api/cameras pull-sync continues.)
// ============================================================================

export async function getParentDeviceScope(client, parentDeviceId, tenantId) {
  const { rows } = await client.query(
    `SELECT customer_id, site_id, fk_floor_id FROM facility_device
     WHERE pk_device_id = $1 AND tenant_id = $2::uuid`,
    [parentDeviceId, tenantId]
  );
  return rows[0] ?? null;
}

// All cameras this box currently claims as children, so the caller can
// report which ones the incoming push DIDN'T mention (without deleting
// them — a camera missing from one push may just be temporarily
// unreachable from the box's own local config, not actually gone).
export async function listChildCameraCodes(client, parentDeviceId, tenantId) {
  const { rows } = await client.query(
    `SELECT external_device_id AS code FROM facility_device
     WHERE parent_device_id = $1 AND tenant_id = $2::uuid AND decommissioned_at IS NULL`,
    [parentDeviceId, tenantId]
  );
  return rows.map(r => r.code);
}

// Upserts one camera's facility_device mirror row + frs_camera row from a
// device-pushed record. Returns 'created' or 'updated'.
export async function upsertCameraFromDeviceSync(client, fields) {
  const {
    tenantId, customerId, siteId, floorId, parentDeviceId,
    code, name, locationLabel, ipAddress, model, cameraMode, deviceConfig,
    rtspUrl,
  } = fields;

  const cameraDeviceTypeId = await getCameraDeviceTypeId(client);

  const existing = await client.query(
    `SELECT pk_device_id FROM facility_device WHERE tenant_id = $1::uuid AND external_device_id = $2`,
    [tenantId, code]
  );
  const isNew = existing.rows.length === 0;

  await client.query(`
    INSERT INTO facility_device
      (tenant_id, customer_id, site_id, external_device_id, name, ip_address,
       status, model, location_label, parent_device_id, device_type_id,
       camera_mode, fk_floor_id, device_config)
    VALUES ($1,$2,$3,$4,$5,$6,'offline',$7,$8,$9,$10,$11,$12,$13::jsonb)
    ON CONFLICT (tenant_id, external_device_id) DO UPDATE SET
      name             = EXCLUDED.name,
      ip_address       = EXCLUDED.ip_address,
      model            = EXCLUDED.model,
      location_label   = EXCLUDED.location_label,
      parent_device_id = EXCLUDED.parent_device_id,
      device_type_id   = EXCLUDED.device_type_id,
      camera_mode      = EXCLUDED.camera_mode,
      fk_floor_id      = COALESCE(EXCLUDED.fk_floor_id, facility_device.fk_floor_id),
      -- Once set (default-inherited at creation, or explicitly reassigned by
      -- an admin via updateCamera), a camera's site/customer is sticky —
      -- a routine device-sync push must never silently move it back to the
      -- parent box's site. This is what lets one edge box serve cameras
      -- that each belong to a different site.
      site_id          = COALESCE(facility_device.site_id, EXCLUDED.site_id),
      customer_id      = COALESCE(facility_device.customer_id, EXCLUDED.customer_id),
      -- Merge, don't replace — a field the box didn't report this round
      -- (e.g. an admin-set threshold) is kept rather than wiped to null.
      device_config    = COALESCE(facility_device.device_config, '{}'::jsonb) || EXCLUDED.device_config,
      decommissioned_at = NULL,
      decommissioned_by = NULL
  `, [tenantId, customerId, siteId, code, name, ipAddress || '0.0.0.0', model || 'IP Camera',
      locationLabel || 'Not set', parentDeviceId, cameraDeviceTypeId, cameraMode, floorId || null,
      JSON.stringify(deviceConfig || {})]);

  await client.query(`
    INSERT INTO frs_camera (fk_nug_id, fk_floor_id, name, cam_id, rtsp_url, ip_address, model)
    VALUES (NULL, $1, $2, $3, $4, $5, $6)
    ON CONFLICT (cam_id) DO UPDATE SET
      name       = EXCLUDED.name,
      rtsp_url   = COALESCE(EXCLUDED.rtsp_url, frs_camera.rtsp_url),
      ip_address = EXCLUDED.ip_address,
      model      = EXCLUDED.model
  `, [floorId || null, name, code, rtspUrl || null, ipAddress || null, model || 'IP Camera']);

  return isNew ? 'created' : 'updated';
}

export async function getCameraWithNugConnection(id) {
  const { rows } = await pool.query(`
    SELECT c.cam_id, n.ip_address AS nug_ip, n.port AS nug_port
    FROM frs_camera c
    LEFT JOIN frs_nug_box n ON n.pk_nug_id = c.fk_nug_id
    WHERE c.pk_camera_id = $1
  `, [id]);
  return rows[0] ?? null;
}

export async function getCameraIp(id) {
  const { rows } = await pool.query(`SELECT ip_address FROM frs_camera WHERE pk_camera_id=$1`, [id]);
  return rows[0]?.ip_address ?? null;
}

export async function markCameraOnline(id) {
  await pool.query(`UPDATE frs_camera SET status='online', last_active=NOW() WHERE pk_camera_id=$1`, [id]);
}

export async function markCameraOffline(id) {
  await pool.query(`UPDATE frs_camera SET status='offline' WHERE pk_camera_id=$1`, [id]);
}

// ============================================================================
// FULL HIERARCHY (for UI)
// ============================================================================

export async function getFullHierarchy(siteId) {
  const [buildings, floors, zones, nugs, cameras] = await Promise.all([
    pool.query(`SELECT * FROM frs_building WHERE fk_site_id=$1 ORDER BY name`, [siteId]),
    pool.query(`SELECT f.* FROM frs_floor f JOIN frs_building b ON b.pk_building_id=f.fk_building_id WHERE b.fk_site_id=$1 ORDER BY f.floor_number`, [siteId]),
    pool.query(`SELECT z.* FROM frs_zone z JOIN frs_floor f ON f.pk_floor_id=z.fk_floor_id JOIN frs_building b ON b.pk_building_id=f.fk_building_id WHERE b.fk_site_id=$1`, [siteId]),
    pool.query(`SELECT n.*, f.floor_name, f.floor_number, b.name as building_name, z.zone_name FROM frs_nug_box n LEFT JOIN frs_floor f ON f.pk_floor_id=n.fk_floor_id LEFT JOIN frs_building b ON b.pk_building_id=n.fk_building_id LEFT JOIN frs_zone z ON z.pk_zone_id=n.fk_zone_id WHERE n.fk_site_id=$1 ORDER BY f.floor_number, n.name`, [siteId]),
    pool.query(`SELECT c.*, n.name as nug_name, f.floor_name, z.zone_name FROM frs_camera c LEFT JOIN frs_nug_box n ON n.pk_nug_id=c.fk_nug_id LEFT JOIN frs_floor f ON f.pk_floor_id=c.fk_floor_id LEFT JOIN frs_zone z ON z.pk_zone_id=c.fk_zone_id JOIN frs_building b ON b.pk_building_id=f.fk_building_id WHERE b.fk_site_id=$1 ORDER BY f.floor_number, c.name`, [siteId]),
  ]);
  return {
    buildings: buildings.rows,
    floors: floors.rows,
    zones: zones.rows,
    nug_boxes: nugs.rows,
    cameras: cameras.rows,
  };
}

// ============================================================================
// EDGE DEVICES (unified fleet view)
// ============================================================================

export async function listEdgeDevices({ tenantId, siteId, offlineMin }) {
  const camFields = `json_build_object(
              'id', COALESCE(fc.pk_camera_id::text, c.pk_device_id::text),
              'name', c.name,
              'cam_id', c.external_device_id,
              'stream_name', c.external_device_id,
              'status', c.status,
              'ip_address', c.ip_address,
              'rtsp_url', COALESCE(fc.rtsp_url, ''),
              'model', COALESCE(fc.model, c.model, 'IP Camera'),
              'last_active', c.last_active,
              'zone_type', COALESCE(c.zone_type, 'unassigned'),
              'zone_label', c.zone_label,
              'camera_mode', COALESCE(c.camera_mode, 'MIXED'),
              'floor_id', COALESCE(c.fk_floor_id, fc.fk_floor_id)
          )`;

  const parsedSiteId = (siteId && !isNaN(Number(siteId))) ? parseInt(String(siteId), 10) : null;

  const { rows } = await pool.query(`
    SELECT
      fd.pk_device_id,
      fn.pk_nug_id                                             AS pk_nug_id,
      fd.external_device_id                                    AS device_code,
      fd.name,
      CASE
        WHEN fd.last_heartbeat < NOW() - INTERVAL '90 seconds'
          OR fd.last_heartbeat IS NULL
        THEN 'offline'
        ELSE fd.status
      END                                                      AS status,
      fd.ip_address,
      COALESCE(NULLIF(fd.device_config->>'port','')::int, 5000) AS port,
      COALESCE(NULLIF(fd.device_config->>'cpu_percent','')::numeric,    0) AS cpu_percent,
      COALESCE(NULLIF(fd.device_config->>'memory_used_mb','')::numeric, 0) AS memory_used_mb,
      COALESCE(NULLIF(fd.device_config->>'memory_total_mb','')::numeric, 0) AS memory_total_mb,
      COALESCE(NULLIF(fd.device_config->>'gpu_percent','')::numeric,    0) AS gpu_percent,
      COALESCE(NULLIF(fd.device_config->>'temperature_c','')::numeric,  0) AS temperature_c,
      COALESCE(NULLIF(fd.device_config->>'disk_used_gb','')::numeric,   0) AS disk_used_gb,
      COALESCE(NULLIF(fd.device_config->>'disk_total_gb','')::numeric,  0) AS disk_total_gb,
      COALESCE(NULLIF(fd.device_config->>'disk_free_gb','')::numeric,   0) AS disk_free_gb,
      COALESCE(NULLIF(fd.device_config->>'uptime_seconds','')::numeric, 0) AS uptime_seconds,
      fd.last_heartbeat,
      COALESCE(fd.zone_type, 'unassigned')                     AS zone_type,
      fd.zone_label,
      COALESCE(fd.fk_floor_id, fn.fk_floor_id)                 AS floor_id,
      COUNT(c.pk_device_id)::int                               AS camera_count,
      json_agg(${camFields} ORDER BY c.name) FILTER (WHERE c.pk_device_id IS NOT NULL) AS cameras
    FROM facility_device fd
    LEFT JOIN frs_nug_box fn ON fn.device_code = fd.external_device_id
    LEFT JOIN facility_device c ON c.parent_device_id = fd.pk_device_id AND c.decommissioned_at IS NULL
    LEFT JOIN frs_camera fc ON fc.cam_id = c.external_device_id
    WHERE ($1::uuid IS NULL OR fd.tenant_id = $1::uuid)
      AND ($2::bigint IS NULL
        OR fd.site_id = $2::bigint
        OR fd.site_id IS NULL
        OR COALESCE(fd.fk_floor_id, fn.fk_floor_id) IN (SELECT f.pk_floor_id FROM frs_floor f JOIN frs_building b ON b.pk_building_id = f.fk_building_id WHERE b.fk_site_id = $2::bigint)
        -- A box explicitly assigned to multiple sites (site_device_assignment
        -- — e.g. one edge node serving several logical sites) shows up in
        -- every site it's assigned to, not just its single facility_device.site_id.
        OR EXISTS (
          SELECT 1 FROM site_device_assignment sda
          WHERE sda.device_id = fd.pk_device_id AND sda.site_id = $2::bigint AND sda.is_active = TRUE
        ))
      AND fd.decommissioned_at IS NULL
      AND fd.parent_device_id IS NULL
      AND (fd.device_type_id IS NULL OR fd.device_type_id IN (SELECT pk_device_type_id FROM device_type WHERE type_code LIKE 'jetson%' OR category = 'edge_ai' OR category = 'edge_node'))
    GROUP BY fd.pk_device_id, fn.pk_nug_id, fd.external_device_id, fd.name, fd.status, fd.ip_address, fd.device_config, fd.last_heartbeat, fd.zone_type, fd.zone_label, fd.fk_floor_id, fn.fk_floor_id
    ORDER BY fd.name
  `, [tenantId || null, parsedSiteId]);
  return rows;
}

export async function decommissionEdgeDevice({ code, tenantId }) {
  const { rows } = await pool.query(
    `UPDATE facility_device
       SET decommissioned_at = NOW()
     WHERE external_device_id = $1
       AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
       AND decommissioned_at IS NULL
     RETURNING pk_device_id, name`,
    [code, tenantId]
  );
  return rows[0] ?? null;
}

export async function deleteNugBoxByDeviceCode(code) {
  await pool.query(`DELETE FROM frs_nug_box WHERE device_code = $1`, [code]).catch(() => {});
}

// ============================================================================
// TELEMETRY HISTORY
// ============================================================================

export async function getTelemetryHistory(siteId) {
  const { rows } = await pool.query(`
    WITH latest_history AS (
      SELECT
        fk_nug_id,
        cpu, gpu, ram,
        timestamp as time,
        ROW_NUMBER() OVER (PARTITION BY fk_nug_id ORDER BY timestamp DESC) as rn
      FROM frs_telemetry_history
      WHERE fk_nug_id IN (SELECT pk_nug_id FROM frs_nug_box WHERE fk_site_id = $1)
    )
    SELECT fk_nug_id, cpu, gpu, ram, time
    FROM latest_history
    WHERE rn <= 2000
    ORDER BY fk_nug_id, time ASC
  `, [siteId]);
  return rows;
}

// ============================================================================
// ANALYTICS / HEATMAPS
// ============================================================================

export async function validateTimezone(tz) {
  try {
    await pool.query('SELECT now() AT TIME ZONE $1', [tz]);
    return true;
  } catch {
    return false;
  }
}

export async function getActivityHeatmap({ tenantId, tz, fromDate, toDate }) {
  const params = [tenantId, tz];
  let dateFilter;
  if (fromDate && toDate) {
    params.push(fromDate, toDate);
    dateFilter = `(ap.occurred_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date`;
  } else {
    dateFilter = `(ap.occurred_at AT TIME ZONE $2) >= date_trunc('day', now() AT TIME ZONE $2) - INTERVAL '6 days'`;
  }

  const { rows } = await pool.query(`
    SELECT
      ap.device_code,
      COALESCE(fd.name, ap.device_code) AS name,
      EXTRACT(HOUR FROM (ap.occurred_at AT TIME ZONE $2))::int AS hour,
      COUNT(*)::int AS cnt
    FROM attendance_ping ap
    LEFT JOIN facility_device fd
      ON fd.external_device_id = ap.device_code AND fd.tenant_id = ap.tenant_id
    WHERE ap.tenant_id = $1::uuid
      AND ap.device_code IS NOT NULL
      AND ${dateFilter}
    GROUP BY ap.device_code, fd.name, hour
    ORDER BY ap.device_code, hour
  `, params);
  return rows;
}

export async function getEmployeeCameraHeatmap({ tenantId, siteId, employeeId, tz, date }) {
  const params = [tenantId, employeeId, tz, date];
  const siteClause = siteId
    ? (params.push(Number(siteId)), `AND (fd.site_id = $${params.length}
         OR EXISTS (
           SELECT 1 FROM site_device_assignment sda
           WHERE sda.device_id = fd.pk_device_id
             AND sda.site_id = $${params.length}
             AND sda.is_active = TRUE
         )
         OR fd.pk_device_id IS NULL)`)
    : '';

  const { rows } = await pool.query(`
    SELECT
      de.payload_json->>'camera_id'                                   AS camera_id,
      COALESCE(fc.name, fd.name, de.payload_json->>'camera_id')       AS name,
      EXTRACT(HOUR FROM (de.occurred_at AT TIME ZONE $3))::int        AS hour,
      COUNT(*)::int                                                    AS cnt
    FROM device_events de
    LEFT JOIN facility_device fd
      ON fd.external_device_id = de.payload_json->>'camera_id'
     AND fd.tenant_id = $1::uuid
    LEFT JOIN frs_camera fc
      ON fc.cam_id = de.payload_json->>'camera_id'
    WHERE de.tenant_id = $1::uuid
      AND COALESCE(de.payload_json->>'employee_id', de.payload_json->>'employeeId')::bigint = $2
      AND de.event_type IN ('EMPLOYEE_ENTRY', 'EMPLOYEE_EXIT', 'FACE_DETECTED')
      AND de.payload_json->>'camera_id' IS NOT NULL
      AND (de.occurred_at AT TIME ZONE $3)::date = $4::date
      ${siteClause}
    GROUP BY camera_id, COALESCE(fc.name, fd.name, de.payload_json->>'camera_id'), hour
    ORDER BY camera_id, hour
  `, params);
  return rows;
}

export async function getActivityByDay({ tenantId, tz, fromDate, toDate }) {
  const { rows } = await pool.query(`
    SELECT
      ap.device_code,
      COALESCE(fd.name, ap.device_code) AS name,
      (ap.occurred_at AT TIME ZONE $2)::date::text AS day,
      COUNT(*)::int AS cnt
    FROM attendance_ping ap
    LEFT JOIN facility_device fd
      ON fd.external_device_id = ap.device_code AND fd.tenant_id = ap.tenant_id
    WHERE ap.tenant_id = $1::uuid
      AND ap.device_code IS NOT NULL
      AND (ap.occurred_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
    GROUP BY ap.device_code, fd.name, day
    ORDER BY ap.device_code, day
  `, [tenantId, tz, fromDate, toDate]);
  return rows;
}

export async function getZoneHeatmap({ tenantId, siteId, tz, date }) {
  const params = [tenantId, tz];
  const dateExpr = date
    ? (params.push(date), `$${params.length}::date`)
    : `(NOW() AT TIME ZONE $2)::date`;

  let siteFdFilter = '';
  if (siteId) {
    params.push(Number(siteId));
    const sn = params.length;
    siteFdFilter = `AND (fd.site_id = $${sn} OR EXISTS (
      SELECT 1 FROM site_device_assignment sda
      WHERE sda.device_id = fd.pk_device_id AND sda.site_id = $${sn} AND sda.is_active = TRUE
    ))`;
  }

  const { rows } = await pool.query(`
    WITH zone_unique AS (
      SELECT
        COALESCE(
          NULLIF(TRIM(fd.zone_label), ''),
          NULLIF(TRIM(z.zone_name), ''),
          NULLIF(TRIM(pfd.zone_label), ''),
          NULLIF(TRIM(fd.location_label), ''),
          ap.device_code
        )                                                          AS zone,
        COUNT(DISTINCT ap.fk_employee_id)::int                    AS total_unique_employees
      FROM attendance_ping ap
      LEFT JOIN facility_device fd
        ON (fd.external_device_id = ap.device_code OR fd.pk_device_id::text = ap.device_code)
       AND (fd.tenant_id = ap.tenant_id OR fd.tenant_id IS NULL)
      LEFT JOIN frs_camera fc
        ON (fc.cam_id = ap.device_code OR fc.pk_camera_id::text = ap.device_code)
      LEFT JOIN frs_zone z
        ON z.pk_zone_id = fc.fk_zone_id
      LEFT JOIN facility_device pfd
        ON pfd.pk_device_id = fd.parent_device_id OR pfd.pk_device_id = fc.fk_nug_id
      WHERE ap.tenant_id = $1::uuid
        AND (ap.occurred_at AT TIME ZONE $2)::date = ${dateExpr}
        AND ap.fk_employee_id IS NOT NULL
        ${siteFdFilter}
      GROUP BY 1
    ),
    activity_raw AS (
      SELECT
        COALESCE(
          NULLIF(TRIM(fd.zone_label), ''),
          NULLIF(TRIM(z.zone_name), ''),
          NULLIF(TRIM(pfd.zone_label), ''),
          NULLIF(TRIM(fd.location_label), ''),
          ap.device_code
        )                                                          AS zone,
        COALESCE(fd.zone_type, z.zone_type, pfd.zone_type, 'unassigned') AS zone_type,
        COALESCE(fd.zone_label, z.zone_name, pfd.zone_label)       AS zone_label,
        EXTRACT(HOUR FROM (ap.occurred_at AT TIME ZONE $2))::int  AS hour,
        COUNT(DISTINCT ap.fk_employee_id)::int                    AS unique_employees,
        COUNT(*)::int                                              AS total_pings
      FROM attendance_ping ap
      LEFT JOIN facility_device fd
        ON (fd.external_device_id = ap.device_code OR fd.pk_device_id::text = ap.device_code)
       AND (fd.tenant_id = ap.tenant_id OR fd.tenant_id IS NULL)
      LEFT JOIN frs_camera fc
        ON (fc.cam_id = ap.device_code OR fc.pk_camera_id::text = ap.device_code)
      LEFT JOIN frs_zone z
        ON z.pk_zone_id = fc.fk_zone_id
      LEFT JOIN facility_device pfd
        ON pfd.pk_device_id = fd.parent_device_id OR pfd.pk_device_id = fc.fk_nug_id
      WHERE ap.tenant_id = $1::uuid
        AND (ap.occurred_at AT TIME ZONE $2)::date = ${dateExpr}
        AND ap.fk_employee_id IS NOT NULL
        ${siteFdFilter}
      GROUP BY 1, 2, 3, 4
    ),
    activity AS (
      SELECT
        ar.zone, ar.zone_type, ar.zone_label, ar.hour, ar.unique_employees, ar.total_pings,
        COALESCE(zu.total_unique_employees, 0)::int AS total_unique_employees
      FROM activity_raw ar
      LEFT JOIN zone_unique zu ON zu.zone = ar.zone
    ),
    active_zones AS (
      SELECT DISTINCT zone FROM activity
    ),
    configured AS (
      SELECT DISTINCT
        NULLIF(TRIM(fd.zone_label), '')  AS zone,
        COALESCE(fd.zone_type, 'unassigned') AS zone_type,
        fd.zone_label,
        NULL::int                    AS hour,
        0                            AS unique_employees,
        0                            AS total_pings,
        0                            AS total_unique_employees
      FROM facility_device fd
      WHERE fd.tenant_id = $1::uuid
        AND fd.decommissioned_at IS NULL
        AND fd.zone_label IS NOT NULL
        AND TRIM(fd.zone_label) != ''
        ${siteFdFilter}
        AND NULLIF(TRIM(fd.zone_label), '') NOT IN (SELECT zone FROM active_zones)
    )
    SELECT zone, zone_type, zone_label, hour, unique_employees, total_pings, total_unique_employees
    FROM activity
    UNION ALL
    SELECT zone, zone_type, zone_label, hour, unique_employees, total_pings, total_unique_employees
    FROM configured
    ORDER BY zone, hour NULLS LAST
  `, params);
  return rows;
}
