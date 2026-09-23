/**
 * siteManagementRoutes.js — Site Management APIs
 * Phase 2, Task 2.5-2.7: Complete CRUD for sites
 */
import express from 'express';
import { requireAuth, requirePermission } from '../middleware/authz.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { pool } from '../db/pool.js';
import logger from '../utils/logger.js';
import { createKeycloakOrganization } from '../services/keycloakProvisioner.js';
import { env } from '../config/env.js';
import { cacheApi } from '../middleware/apiCache.js';

const router = express.Router();

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

// AB#2812: a client-supplied customer_id was only validated when a tenantId
// was also present (`if (customerId && tenantId)`) — a super_admin (whose
// tenantId is always null) skipped validation entirely and a stale/wrong id
// hit the INSERT's fk_customer_id foreign key directly, surfacing as a
// generic 500 instead of a clean 404. Exported for direct unit testing.
async function validateCustomerId(dbPool, customerId, tenantId) {
  if (Number.isNaN(Number(customerId))) {
    return { ok: false, status: 400, error: 'customer_id must be numeric' };
  }
  const row = tenantId
    ? await dbPool.query(
        'SELECT pk_customer_id FROM frs_customer WHERE pk_customer_id = $1 AND fk_tenant_id = $2',
        [Number(customerId), tenantId]
      )
    : await dbPool.query(
        'SELECT pk_customer_id FROM frs_customer WHERE pk_customer_id = $1',
        [Number(customerId)]
      );
  if (row.rows.length === 0) {
    return { ok: false, status: 404, error: 'Customer not found' };
  }
  return { ok: true };
}

// ============================================================================
// POST /api/site-management/sites - Create New Site
// ============================================================================
router.post('/sites', requireAuth, requirePermission('sites.write'), asyncHandler(async (req, res) => {
  const {
    site_name,
    city,
    country,
    timezone_offset = 'UTC',
    timezone_label,
    latitude,
    longitude,
    location_address,
    site_config,
    status = 'active'
  } = req.body;

  // Validation
  if (!site_name) {
    return res.status(400).json({ error: 'site_name is required' });
  }
  const trimmedSiteName = site_name.trim();
  if (trimmedSiteName.length < 3) {
    return res.status(400).json({ error: 'Branch name must be at least 3 characters long.' });
  }
  if (/^\d+$/.test(trimmedSiteName)) {
    return res.status(400).json({ error: 'Branch name cannot be entirely numeric.' });
  }

  if (!country) {
    return res.status(400).json({ error: 'country is required' });
  }
  if (!city) {
    return res.status(400).json({ error: 'city is required' });
  }

  const tenantId = req.auth?.scope?.tenantId;
  let customerId = req.body.customer_id || req.auth?.scope?.customerId;

  // FIX: a client-supplied req.body.customer_id was previously trusted with
  // no check that it belongs to the caller's own tenant — any tenant holding
  // sites.write could plant a site under ANOTHER tenant's customer.
  // AB#2812: now validated whenever customerId is supplied (not only when a
  // tenantId is also present — see validateCustomerId's comment above).
  if (customerId) {
    const validation = await validateCustomerId(pool, customerId, tenantId);
    if (!validation.ok) {
      return res.status(validation.status).json({ error: validation.error });
    }
  }

  // Resolve customerId from tenant when not in scope
  if (!customerId && tenantId) {
    const custRow = await pool.query(
      'SELECT pk_customer_id FROM frs_customer WHERE fk_tenant_id = $1 ORDER BY pk_customer_id LIMIT 1',
      [tenantId]
    );
    if (custRow.rows.length === 0) {
      // Auto-provision a default customer on the fly for this tenant
      const newCust = await pool.query(
        "INSERT INTO frs_customer (customer_name, fk_tenant_id) VALUES ('Default Customer', $1) RETURNING pk_customer_id",
        [tenantId]
      );
      customerId = newCust.rows[0].pk_customer_id;
      logger.info(`[SiteManagement] Auto-provisioned default customer ID ${customerId} for tenant ${tenantId}`);
    } else {
      customerId = custRow.rows[0].pk_customer_id;
    }
  }
  if (!customerId) return res.status(400).json({ error: 'Could not resolve customer for site' });

  const duplicateBranchCheck = await pool.query(
    `SELECT s.pk_site_id FROM frs_site s
     WHERE s.fk_customer_id = $1 AND LOWER(TRIM(s.site_name)) = LOWER($2)`,
    [customerId, trimmedSiteName]
  );
  if (duplicateBranchCheck.rows.length > 0) {
    return res.status(409).json({ error: 'This Branch Name already exists.' });
  }

  // AB#2812: pass null (never undefined) to the INSERT below — created_by_user_id
  // is nullable, but an undefined bound parameter is a driver-level footgun
  // distinct from a clean, intentional NULL.
  const userId = req.auth?.user?.id ?? null;

  // Default site config with all required fields
  const defaultConfig = {
    attendance_rules: {
      work_hours_start: "09:00",
      work_hours_end: "18:00",
      grace_period_minutes: 15,
      auto_checkout_enabled: true,
      auto_checkout_time: "20:00"
    },
    recognition_settings: {
      match_threshold: 0.38,
      confidence_threshold: 0.40,
      cooldown_seconds: 30
    },
    direction_detection: {
      enabled: true,
      entry_direction: "y_increasing",
      y_threshold_pixels: 45,
      tracking_window_frames: 4
    },
    unauthorized_access_policy: {
      action: "block_with_override",
      notify_employee: true,
      allow_override: true,
      flag_for_review: true,
      escalation_threshold: 3,
      escalation_recipients: ["admin@company.com"]
    }
  };

  // Merge user-provided config with defaults
  const mergedConfig = {
    ...defaultConfig,
    ...(site_config || {})
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Retrieve realm details for the tenant
    const realmRes = await client.query(`
      SELECT tr.realm_slug
      FROM tenant_realm tr
      JOIN frs_customer c ON c.fk_tenant_id = tr.fk_tenant_id
      WHERE c.pk_customer_id = $1
    `, [customerId]);
    const realmSlug = realmRes.rows[0]?.realm_slug;

    const orgSlug = slugify(site_name);

    const result = await client.query(`
      INSERT INTO frs_site (
        site_name, fk_customer_id, city, country, timezone_offset, timezone, timezone_label,
        latitude, longitude, location_address, site_config,
        status, created_by_user_id, keycloak_org_id, keycloak_org_alias
      ) VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING pk_site_id, site_name, city, country, timezone_offset, timezone, timezone_label, status, keycloak_org_id
    `, [
      site_name, customerId, city, country, timezone_offset,
      timezone_label || timezone_offset,
      latitude, longitude, location_address,
      JSON.stringify(mergedConfig), status, userId, orgSlug, orgSlug
    ]);

    // Provision Keycloak Organization if in Keycloak auth mode and realm is configured
    if (env.authMode === 'keycloak' && realmSlug) {
      try {
        await createKeycloakOrganization({
          realmSlug,
          orgSlug,
          orgName: site_name
        });
      } catch (kcErr) {
        logger.warn(`[KeycloakProvisioner] Failed to provision Keycloak organization, proceeding with core database setup: ${kcErr.message}`);
      }
    }

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Site created and Keycloak Organization provisioned successfully',
      site: result.rows[0]
    });

  } catch (error) {
    await client.query('ROLLBACK');
    // AB#2812: the response body is intentionally generic (no internal detail
    // leaked to the client), but the swallowed error previously left no way
    // to diagnose *which* constraint failed without live DB access — log the
    // actual Postgres error fields (code/constraint/detail) server-side.
    logger.error(
      { code: error.code, constraint: error.constraint, detail: error.detail, message: error.message },
      'Create site error'
    );
    res.status(500).json({ error: 'Failed to create site' });
  } finally {
    client.release();
  }
}));


// ============================================================================
// GET /api/site-management/sites - List All Sites
// ============================================================================
router.get('/sites', requireAuth, cacheApi(15000), requirePermission('sites.read'), asyncHandler(async (req, res) => {
  const { status, search } = req.query;
  const isGlobal = req.auth?.memberships?.some(m => m.scope.tenantId === null);
  const tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || null;

  try {
    let query = `
      SELECT
        s.pk_site_id,
        s.site_name,
        s.city,
        s.country,
        s.timezone_offset,
        s.latitude,
        s.longitude,
        s.location_address,
        s.status,
        s.enhanced_at as created_at,
        s.fk_customer_id,
        c.customer_name,
        (
          SELECT COUNT(*)::int
          FROM hr_employee e
          WHERE e.tenant_id = c.fk_tenant_id
            AND (s.pk_site_id = ANY(e.site_ids) OR e.site_ids IS NULL OR cardinality(e.site_ids) = 0)
            AND e.status = 'active'
            AND (e.join_date IS NULL OR e.join_date <= (NOW() AT TIME ZONE COALESCE(s.timezone, 'UTC'))::date)
        ) AS member_count,
        (
          SELECT COUNT(*)::int
          FROM site_device_assignment sda
          JOIN facility_device fd ON fd.pk_device_id = sda.device_id
          WHERE sda.site_id = s.pk_site_id
            AND sda.is_active = TRUE
            AND fd.decommissioned_at IS NULL
        ) AS devices_total,
        (
          SELECT COUNT(*)::int
          FROM site_device_assignment sda
          JOIN facility_device fd ON fd.pk_device_id = sda.device_id
          WHERE sda.site_id = s.pk_site_id
            AND sda.is_active = TRUE
            AND fd.decommissioned_at IS NULL
        ) AS device_count,
        (
          SELECT COUNT(*)::int
          FROM site_device_assignment sda
          JOIN facility_device fd ON fd.pk_device_id = sda.device_id
          WHERE sda.site_id = s.pk_site_id
            AND sda.is_active = TRUE
            AND fd.decommissioned_at IS NULL
            AND fd.status = 'online'
        ) AS devices_online,
        (
          SELECT COALESCE(
            ROUND(
              (COUNT(DISTINCT a.fk_employee_id) * 100.0) / NULLIF(
                (
                  SELECT COUNT(*)::int
                  FROM hr_employee e2
                  WHERE e2.tenant_id = c.fk_tenant_id
                    AND (s.pk_site_id = ANY(e2.site_ids) OR e2.site_ids IS NULL OR cardinality(e2.site_ids) = 0)
                    AND e2.status = 'active'
                    AND (e2.join_date IS NULL OR e2.join_date <= (NOW() AT TIME ZONE COALESCE(s.timezone, 'UTC'))::date)
                ),
                0
              )
            )::int,
            0
          )
          FROM attendance_record a
          JOIN hr_employee e ON e.pk_employee_id = a.fk_employee_id
          WHERE a.tenant_id = c.fk_tenant_id
            AND a.attendance_date = (NOW() AT TIME ZONE COALESCE(s.timezone, 'UTC'))::date
            AND a.status IN ('present', 'late')
            AND (s.pk_site_id = ANY(e.site_ids) OR e.site_ids IS NULL OR cardinality(e.site_ids) = 0)
        ) AS attendance_rate
      FROM frs_site s
      JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
    `;

    const params = [];
    let paramIndex = 1;

    if (tenantId) {
      query += ` WHERE c.fk_tenant_id = $${paramIndex}::uuid`;
      params.push(tenantId);
      paramIndex++;
    } else {
      query += ` WHERE 1=1`;
    }

    // Filter by status
    if (status) {
      query += ` AND s.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    // Search by name or city
    if (search) {
      query += ` AND (s.site_name ILIKE $${paramIndex} OR s.city ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += `
      ORDER BY s.site_name ASC
    `;

    const result = await pool.query(query, params);

    res.json({
      success: true,
      count: result.rows.length,
      sites: result.rows
    });

  } catch (error) {
    logger.error('List sites error:', error);
    res.status(500).json({ error: 'Failed to list sites' });
  }
}));


// ============================================================================
// GET /api/site-management/sites/:siteId - Get Site Details
// ============================================================================
router.get('/sites/:siteId', requireAuth, requirePermission('sites.read'), asyncHandler(async (req, res) => {
  const { siteId } = req.params;
  // FIX: this endpoint previously queried by pk_site_id alone — any tenant
  // holding sites.read could view any OTHER tenant's site by incrementing the
  // ID. Scoped the same way the list endpoint above already is (isGlobal
  // bypass for super-admin memberships, tenant_id join otherwise).
  const isGlobal = req.auth?.memberships?.some(m => m.scope.tenantId === null);
  const tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || null;

  try {
    // Get site with config
    const siteParams = [siteId];
    let siteQuery = `
      SELECT
        s.*,
        c.customer_name,
        jsonb_pretty(s.site_config) as site_config_formatted
      FROM frs_site s
      JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
      WHERE s.pk_site_id = $1
    `;
    if (!isGlobal && tenantId) {
      siteQuery += ` AND c.fk_tenant_id = $2::uuid`;
      siteParams.push(tenantId);
    }
    const site = await pool.query(siteQuery, siteParams);

    if (site.rows.length === 0) {
      return res.status(404).json({ error: 'Site not found' });
    }

    // Get device count and list
    const devices = await pool.query(`
      SELECT 
        fd.pk_device_id,
        fd.external_device_id,
        fd.name,
        fd.status,
        dt.type_name,
        sda.device_role,
        sda.zone_name
      FROM site_device_assignment sda
      JOIN facility_device fd ON fd.pk_device_id = sda.device_id
      LEFT JOIN device_type dt ON dt.pk_device_type_id = fd.device_type_id
      WHERE sda.site_id = $1 AND sda.is_active = TRUE
      ORDER BY sda.assigned_at DESC
    `, [siteId]);

    res.json({
      success: true,
      site: site.rows[0],
      devices: devices.rows,
      device_count: devices.rows.length
    });

  } catch (error) {
    logger.error('Get site details error:', error);
    res.status(500).json({ error: 'Failed to get site details' });
  }
}));

// ============================================================================
// PATCH /api/site-management/sites/:siteId - Update Site Config
// ============================================================================
router.patch('/sites/:siteId', requireAuth, requirePermission('sites.write'), asyncHandler(async (req, res) => {
  const { siteId } = req.params;
  // FIX: previously checked/updated by pk_site_id alone — any tenant holding
  // sites.write could edit any OTHER tenant's site by ID. Scoped the
  // existence check the same way GET/LIST above are; the UPDATE below is
  // safe once this check passes since ownership can't change mid-request.
  const isGlobal = req.auth?.memberships?.some(m => m.scope.tenantId === null);
  const tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || null;
  const {
    site_name,
    city,
    country,
    timezone_offset,
    timezone_label,
    latitude,
    longitude,
    location_address,
    site_config,
    status
  } = req.body;

  if (site_name !== undefined) {
    const trimmedSiteName = site_name.trim();
    if (trimmedSiteName.length < 3) {
      return res.status(400).json({ error: 'Branch name must be at least 3 characters long.' });
    }
    if (/^\d+$/.test(trimmedSiteName)) {
      return res.status(400).json({ error: 'Branch name cannot be entirely numeric.' });
    }
  }

  try {
    // Check if site exists (and belongs to this tenant, unless global scope)
    const existingParams = [siteId];
    let existingQuery = `
      SELECT s.pk_site_id FROM frs_site s
      JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
      WHERE s.pk_site_id = $1
    `;
    if (!isGlobal && tenantId) {
      existingQuery += ` AND c.fk_tenant_id = $2::uuid`;
      existingParams.push(tenantId);
    }
    const existing = await pool.query(existingQuery, existingParams);

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Site not found' });
    }

    if (site_name !== undefined) {
      const trimmedSiteName = site_name.trim();
      const siteTenantRes = await pool.query(`
        SELECT c.fk_tenant_id 
        FROM frs_site s 
        JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id 
        WHERE s.pk_site_id = $1
      `, [siteId]);
      const siteTenantId = siteTenantRes.rows[0]?.fk_tenant_id;
      if (siteTenantId) {
        const dupCheck = await pool.query(
          `SELECT s.pk_site_id FROM frs_site s
           JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
           WHERE c.fk_tenant_id = $1 AND LOWER(TRIM(s.site_name)) = LOWER($2) AND s.pk_site_id != $3`,
          [siteTenantId, trimmedSiteName, siteId]
        );
        if (dupCheck.rows.length > 0) {
          return res.status(409).json({ error: 'This Branch Name already exists.' });
        }
      }
    }

    if (country !== undefined && !country) {
      return res.status(400).json({ error: 'country cannot be empty' });
    }
    if (city !== undefined && !city) {
      return res.status(400).json({ error: 'city cannot be empty' });
    }

    // Build dynamic update query
    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (site_name !== undefined) {
      updates.push(`site_name = $${paramIndex}`);
      params.push(site_name);
      paramIndex++;
    }

    if (city !== undefined) {
      updates.push(`city = $${paramIndex}`);
      params.push(city);
      paramIndex++;
    }

    if (country !== undefined) {
      updates.push(`country = $${paramIndex}`);
      params.push(country);
      paramIndex++;
    }

    if (timezone_offset !== undefined) {
      updates.push(`timezone_offset = $${paramIndex}`);
      updates.push(`timezone = $${paramIndex}`);
      params.push(timezone_offset);
      paramIndex++;
      updates.push(`timezone_label = $${paramIndex}`);
      params.push(timezone_label || timezone_offset);
      paramIndex++;
    }

    if (latitude !== undefined) {
      updates.push(`latitude = $${paramIndex}`);
      params.push(latitude);
      paramIndex++;
    }

    if (longitude !== undefined) {
      updates.push(`longitude = $${paramIndex}`);
      params.push(longitude);
      paramIndex++;
    }

    if (location_address !== undefined) {
      updates.push(`location_address = $${paramIndex}`);
      params.push(location_address);
      paramIndex++;
    }

    if (site_config !== undefined) {
      updates.push(`site_config = $${paramIndex}::jsonb`);
      params.push(JSON.stringify(site_config));
      paramIndex++;
    }

    if (status !== undefined) {
      updates.push(`status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    // Add WHERE clause param
    params.push(siteId);

    const query = `
      UPDATE frs_site
      SET ${updates.join(', ')}
      WHERE pk_site_id = $${paramIndex}
      RETURNING pk_site_id, site_name, city, country, status
    `;

    const result = await pool.query(query, params);

    res.json({
      success: true,
      message: 'Site updated successfully',
      site: result.rows[0]
    });

  } catch (error) {
    logger.error('Update site error:', error);
    res.status(500).json({ error: 'Failed to update site' });
  }
}));


// ============================================================================
// DELETE /api/site-management/sites/:siteId - Decommission Site
// ============================================================================
router.delete('/sites/:siteId', requireAuth, requirePermission('sites.write'), asyncHandler(async (req, res) => {
  const { siteId } = req.params;
  // FIX: previously checked/deleted by pk_site_id alone — any tenant holding
  // sites.write could delete any OTHER tenant's site (and cascade-clear its
  // devices/employees/audit-log references below) by ID. Scoped the same
  // way GET/LIST/PATCH above are.
  const isGlobal = req.auth?.memberships?.some(m => m.scope.tenantId === null);
  const tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || null;

  try {
    // Check if site exists (and belongs to this tenant, unless global scope)
    const siteParams = [siteId];
    let siteQuery = `
      SELECT s.pk_site_id, s.site_name FROM frs_site s
      JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
      WHERE s.pk_site_id = $1
    `;
    if (!isGlobal && tenantId) {
      siteQuery += ` AND c.fk_tenant_id = $2::uuid`;
      siteParams.push(tenantId);
    }
    const site = await pool.query(siteQuery, siteParams);

    if (site.rows.length === 0) {
      return res.status(404).json({ error: 'Site not found' });
    }

    // Check if site has active devices
    const devices = await pool.query(`
      SELECT COUNT(*) as count 
      FROM site_device_assignment sda
      JOIN facility_device fd ON fd.pk_device_id = sda.device_id
      WHERE sda.site_id = $1 AND sda.is_active = TRUE AND fd.decommissioned_at IS NULL
    `, [siteId]);

    // Check if site has associated active employees
    const employees = await pool.query(
      "SELECT COUNT(*) as count FROM hr_employee WHERE ($1 = ANY(site_ids)) AND status = 'active'",
      [siteId]
    );

    if (parseInt(devices.rows[0].count) > 0 || parseInt(employees.rows[0].count) > 0) {
      return res.status(409).json({ 
        error: 'This branch cannot be deleted because it has active associated users or devices. Please remove or reassign the active dependencies before deleting the branch.',
        active_devices: parseInt(devices.rows[0].count),
        active_employees: parseInt(employees.rows[0].count)
      });
    }

    await pool.query('BEGIN');
    
    // Clear references on dependent tables to satisfy foreign key constraints
    await pool.query('UPDATE attendance_record SET site_id = NULL, unit_id = NULL WHERE site_id = $1 OR unit_id IN (SELECT pk_unit_id FROM frs_unit WHERE fk_site_id = $1)', [siteId]);
    await pool.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable');
    try {
      await pool.query('UPDATE audit_log SET site_id = NULL, unit_id = NULL WHERE site_id = $1 OR unit_id IN (SELECT pk_unit_id FROM frs_unit WHERE fk_site_id = $1)', [siteId]);
    } finally {
      await pool.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable');
    }
    await pool.query('UPDATE facility_device SET site_id = NULL, unit_id = NULL WHERE site_id = $1 OR unit_id IN (SELECT pk_unit_id FROM frs_unit WHERE fk_site_id = $1)', [siteId]);
    await pool.query('UPDATE hr_employee SET site_id = NULL, unit_id = NULL WHERE site_id = $1 OR unit_id IN (SELECT pk_unit_id FROM frs_unit WHERE fk_site_id = $1)', [siteId]);
    await pool.query('UPDATE system_alert SET site_id = NULL, unit_id = NULL WHERE site_id = $1 OR unit_id IN (SELECT pk_unit_id FROM frs_unit WHERE fk_site_id = $1)', [siteId]);
    
    await pool.query('DELETE FROM frs_user_membership WHERE site_id = $1 OR unit_id IN (SELECT pk_unit_id FROM frs_unit WHERE fk_site_id = $1)', [siteId]);
    await pool.query('DELETE FROM frs_unit WHERE fk_site_id = $1', [siteId]);
    await pool.query('DELETE FROM frs_building WHERE fk_site_id = $1', [siteId]);
    await pool.query('DELETE FROM site_device_assignment WHERE site_id = $1', [siteId]);
    await pool.query('DELETE FROM user_role WHERE fk_site_id = $1', [siteId]);
    
    // Delete the site itself
    const result = await pool.query('DELETE FROM frs_site WHERE pk_site_id = $1', [siteId]);
    
    if (result.rowCount === 0) {
      await pool.query('ROLLBACK');
      return res.status(404).json({ error: 'Site not found during deletion' });
    }

    await pool.query('COMMIT');

    res.json({
      success: true,
      message: 'Site deleted successfully',
      site_id: siteId,
      site_name: site.rows[0].site_name
    });

  } catch (error) {
    await pool.query('ROLLBACK');
    logger.error('Delete site error:', error);

    if (error.code === '23503') { // Postgres foreign_key_violation
      let dependency = 'associated records';
      if (error.constraint === 'frs_floor_fk_site_id_fkey') dependency = 'floors';
      else if (error.constraint === 'visitor_buffer_site_id_fkey') dependency = 'visitor records';
      else if (error.constraint === 'device_activation_code_fk_site_id_fkey') dependency = 'device activation codes';
      else if (error.constraint === 'hr_employee_site_map_fk_site_id_fkey') dependency = 'employee assignments';
      else if (error.constraint === 'group_role_map_fk_site_id_fkey') dependency = 'group roles';
      else if (error.constraint === 'user_role_fk_site_id_fkey') dependency = 'user roles';
      else if (error.constraint === 'attendance_record_site_id_fkey') dependency = 'attendance records';
      else if (error.constraint === 'audit_log_site_id_fkey') dependency = 'audit logs';
      else if (error.constraint === 'facility_device_site_id_fkey') dependency = 'devices';
      else if (error.constraint === 'frs_unit_fk_site_id_fkey') dependency = 'units';
      else if (error.constraint === 'frs_user_membership_site_id_fkey') dependency = 'user memberships';
      else if (error.constraint === 'hr_employee_site_id_fkey') dependency = 'employees';
      else if (error.constraint === 'site_device_assignment_site_id_fkey') dependency = 'device assignments';
      else if (error.constraint === 'system_alert_site_id_fkey') dependency = 'system alerts';

      return res.status(409).json({ error: `Cannot delete branch because it still has ${dependency} linked to it. Please remove these dependencies first.` });
    }

    res.status(500).json({ error: 'Failed to delete site' });
  }
}));

export { validateCustomerId };
export default router;
