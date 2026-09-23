import express from 'express';
import { requireAuth, requirePermission } from '../middleware/authz.js';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { sendTestEmail } from '../services/emailService.js';
import { validateBody } from '../validators/schemas.js';
import {
  createSiteSchema, updateSiteSettingsSchema, createHolidaySchema,
  notificationSettingsSchema, testEmailSchema,
} from '../validators/siteSchemas.js';

const router = express.Router();
router.use(requireAuth);

const DEFAULT_NOTIFICATION_SETTINGS = {
  email_enabled: false,
  email_recipients: '',
  smtp_host: '',
  smtp_port: '587',
  smtp_user: '',
  smtp_pass: '',
  sms_enabled: false,
  sms_recipients: '',
  inapp_enabled: true,
  alert_on_device_offline: true,
  alert_on_low_accuracy: true,
  alert_on_unauthorized_access: true,
  alert_on_late_arrival: false,
  low_accuracy_threshold: '80',
};

// FIX: this previously trusted an explicit siteId from the header/body/query
// with ZERO check that it belongs to the caller's own tenant — any
// authenticated user could read/write another tenant's site (and, via
// callers further down this file, its notification settings including SMTP
// credentials) just by passing a different x-site-id. Now verified against
// the caller's tenant before being trusted, same join pattern used elsewhere
// in this file (frs_site has no direct tenant_id column — it goes through
// frs_customer).
async function resolveCurrentSiteId(req) {
  const tenantId = req.auth?.scope?.tenantId;
  const explicitSiteId = req.headers['x-site-id'] || req.body?.siteId || req.query?.siteId;

  if (explicitSiteId) {
    if (!tenantId) return null; // no scope to verify ownership against — deny
    const { rows } = await pool.query(
      `SELECT s.pk_site_id
       FROM frs_site s
       JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
       WHERE s.pk_site_id = $1 AND c.fk_tenant_id = $2`,
      [Number(explicitSiteId), tenantId]
    );
    return rows[0]?.pk_site_id || null;
  }

  if (!tenantId) return null;

  const { rows } = await pool.query(
    `SELECT s.pk_site_id
     FROM frs_site s
     JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
     WHERE c.fk_tenant_id = $1
     ORDER BY s.pk_site_id
     LIMIT 1`,
    [tenantId]
  );

  return rows[0]?.pk_site_id || null;
}

function publicNotificationSettings(settings = {}) {
  return {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    ...settings,
    smtp_pass: '',
  };
}

// 1. GET ALL SITES (Registry List)
router.get('/', requirePermission('devices.read'), asyncHandler(async (req, res) => {
  const scope = req.auth?.scope || {};
  const tenantId = scope.tenantId;

  if (!tenantId) return res.status(400).json({ message: 'tenantId is required in scope' });

  const { rows } = await pool.query(
    `SELECT s.pk_site_id as id, s.site_name as name, s.timezone, s.timezone_label,
     s.location_address as address, c.customer_name 
     FROM frs_site s 
     JOIN frs_customer c ON s.fk_customer_id = c.pk_customer_id
     WHERE c.fk_tenant_id = $1 ORDER BY s.site_name`,
    [tenantId]
  );
  return res.json({ data: rows, scope });
}));

// 2. GET CURRENT SITE SETTINGS
router.get('/settings', asyncHandler(async (req, res) => {
  const siteId = req.headers['x-site-id'];
  const tenantId = req.auth?.scope?.tenantId;
  const isGlobal = req.auth?.memberships?.some(m => m.scope.tenantId === null);

  let rows;
  if (siteId) {
    // FIX: previously queried by pk_site_id alone — any authenticated user
    // could read another tenant's site settings via x-site-id. Scoped to
    // the caller's tenant (global-scope memberships bypass, matching
    // siteManagementRoutes.js's pattern), same join used in the branch below.
    const params = [Number(siteId)];
    let query = `
      SELECT s.pk_site_id, s.site_name, s.timezone, s.timezone_label, s.location_address
      FROM frs_site s
      JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
      WHERE s.pk_site_id = $1
    `;
    if (!isGlobal) {
      if (!tenantId) return res.status(403).json({ message: 'Forbidden' });
      query += ` AND c.fk_tenant_id = $2`;
      params.push(tenantId);
    }
    ({ rows } = await pool.query(query, params));
  } else if (tenantId) {
    // No specific site selected — return the first active site for this tenant
    ({ rows } = await pool.query(
      `SELECT s.pk_site_id, s.site_name, s.timezone, s.timezone_label, s.location_address
       FROM frs_site s
       JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
       WHERE c.fk_tenant_id = $1 AND s.status = 'active'
       ORDER BY s.pk_site_id LIMIT 1`,
      [tenantId]
    ));
  } else {
    return res.json(null);
  }

  if (!rows.length) return res.json(null);
  return res.json(rows[0]);
}));

// 2a. GET NOTIFICATION SETTINGS
router.get('/settings/notifications', requirePermission('devices.read'), asyncHandler(async (req, res) => {
  const siteId = await resolveCurrentSiteId(req);
  if (!siteId) return res.status(400).json({ message: 'Site ID is required' });

  const { rows } = await pool.query(
    `SELECT COALESCE(site_config->'notification_settings', '{}'::jsonb) AS notification_settings
     FROM frs_site
     WHERE pk_site_id = $1`,
    [siteId]
  );

  if (!rows.length) return res.status(404).json({ message: 'Site not found' });

  return res.json({
    success: true,
    data: publicNotificationSettings(rows[0].notification_settings),
  });
}));

// 2b. SAVE NOTIFICATION SETTINGS
router.patch('/settings/notifications', requirePermission('devices.write'), validateBody(notificationSettingsSchema), asyncHandler(async (req, res) => {
  const siteId = await resolveCurrentSiteId(req);
  if (!siteId) return res.status(400).json({ message: 'Site ID is required' });

  const { rows } = await pool.query(
    `SELECT COALESCE(site_config->'notification_settings', '{}'::jsonb) AS notification_settings
     FROM frs_site
     WHERE pk_site_id = $1`,
    [siteId]
  );

  if (!rows.length) return res.status(404).json({ message: 'Site not found' });

  const existing = rows[0].notification_settings || {};
  const incoming = { ...req.validatedBody };

  if (!incoming.smtp_pass) {
    delete incoming.smtp_pass;
  }

  const nextSettings = {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    ...existing,
    ...incoming,
  };

  await pool.query(
    `UPDATE frs_site
     SET site_config = jsonb_set(
       COALESCE(site_config, '{}'::jsonb),
       '{notification_settings}',
       $1::jsonb,
       true
     )
     WHERE pk_site_id = $2`,
    [JSON.stringify(nextSettings), siteId]
  );

  await writeAudit({
    req,
    action: 'site.notifications.update',
    details: `Notification settings updated for site ${siteId}`,
    entityType: 'site',
    entityId: String(siteId),
    source: 'ui',
  }).catch(() => {});

  return res.json({
    success: true,
    data: publicNotificationSettings(nextSettings),
  });
}));

// 2c. SEND TEST EMAIL
router.post('/settings/notifications/test-email', requirePermission('devices.write'), validateBody(testEmailSchema), asyncHandler(async (req, res) => {
  const siteId = await resolveCurrentSiteId(req);
  if (!siteId) return res.status(400).json({ message: 'Site ID is required' });

  const { recipients } = req.validatedBody;

  const { rows } = await pool.query(
    `SELECT COALESCE(site_config->'notification_settings', '{}'::jsonb) AS notification_settings
     FROM frs_site
     WHERE pk_site_id = $1`,
    [siteId]
  );

  if (!rows.length) return res.status(404).json({ message: 'Site not found' });

  const settings = {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    ...(rows[0].notification_settings || {}),
  };

  const result = await sendTestEmail({
    recipients,
    config: {
      host: settings.smtp_host,
      port: settings.smtp_port,
      user: settings.smtp_user,
      pass: settings.smtp_pass,
      fromName: 'FRS Notifications',
    },
  });

  return res.json({
    success: true,
    message: 'Test email sent',
    messageId: result.messageId,
  });
}));

// 3. CREATE NEW SITE
router.post('/', requirePermission('devices.write'), validateBody(createSiteSchema), asyncHandler(async (req, res) => {
  const { name, timezone, address, status = 'active' } = req.validatedBody;
  let { customerId } = req.validatedBody;

  const creatorId = req.auth.user.id;
  const currentMembership = req.auth.memberships[0];
  const tenantId = req.auth.scope.tenantId;

  // Auto-discover customerId from the tenant when not provided
  if (!customerId) {
    const { rows: cRows } = await pool.query(
      'SELECT pk_customer_id FROM frs_customer WHERE fk_tenant_id = $1 LIMIT 1', [tenantId]
    );
    if (!cRows.length) return res.status(400).json({ message: 'No customer found for this tenant. Create a customer first or provide customerId.' });
    customerId = cRows[0].pk_customer_id;
  } else {
    // FIX: a client-supplied customerId was previously trusted with no check
    // that it belongs to the caller's own tenant — any tenant holding
    // devices.write could plant a site under ANOTHER tenant's customer.
    // Verify ownership the same way the auto-discovery path above guarantees it.
    const { rows: ownedRows } = await pool.query(
      'SELECT pk_customer_id FROM frs_customer WHERE pk_customer_id = $1 AND fk_tenant_id = $2',
      [Number(customerId), tenantId]
    );
    if (!ownedRows.length) return res.status(404).json({ message: 'Customer not found' });
  }

  await pool.query('BEGIN');
  try {
    const { rows: siteRows } = await pool.query(
      `INSERT INTO frs_site (site_name, fk_customer_id, timezone, timezone_label, location_address, status) 
       VALUES ($1, $2, $3, $3, $4, $5) RETURNING pk_site_id as id, site_name as name`,
      [name, Number(customerId), timezone || 'UTC', address || '', status]
    );
    const newSiteId = siteRows[0].id;

    // AUTO-GRANT MEMBERSHIP: Link the creator to the new site if they don't have global access
    const isGlobalAdmin = !currentMembership.site_id;
    if (!isGlobalAdmin) {
      await pool.query(
        `INSERT INTO frs_user_membership (fk_user_id, role, tenant_id, customer_id, site_id, permissions)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [
          Number(creatorId),
          currentMembership.role,
          tenantId,
          Number(customerId),
          Number(newSiteId),
          currentMembership.permissions
        ]
      );
    }

    await pool.query('COMMIT');
    res.status(201).json(siteRows[0]);
  } catch (err) {
    await pool.query('ROLLBACK');
    throw err;
  }
}));

// 4. UPDATE SITE (Timezone + Metadata + Status)
router.patch('/settings', requirePermission('devices.write'), validateBody(updateSiteSettingsSchema), asyncHandler(async (req, res) => {
  const siteId = req.headers['x-site-id'] || req.validatedBody.siteId;
  const { name, timezone, timezone_label, address, status } = req.validatedBody;

  if (!siteId) return res.status(400).json({ message: 'Site ID is required' });

  // FIX: previously updated by pk_site_id alone — any tenant holding
  // devices.write could edit any OTHER tenant's site by ID. Scoped via
  // frs_customer the same way GET /settings above is (global-scope
  // memberships bypass).
  const tenantId = req.auth?.scope?.tenantId;
  const isGlobal = req.auth?.memberships?.some(m => m.scope.tenantId === null);
  if (!isGlobal) {
    if (!tenantId) return res.status(403).json({ message: 'Forbidden' });
    const { rows: ownedRows } = await pool.query(
      `SELECT s.pk_site_id FROM frs_site s
       JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
       WHERE s.pk_site_id = $1 AND c.fk_tenant_id = $2`,
      [Number(siteId), tenantId]
    );
    if (!ownedRows.length) return res.status(404).json({ message: 'Site not found' });
  }

  const { rows } = await pool.query(
    `UPDATE frs_site SET
        site_name = COALESCE($1, site_name),
        timezone = COALESCE($2, timezone),
        timezone_label = COALESCE($3, timezone_label),
        location_address = COALESCE($4, location_address),
        status = COALESCE($5, status)
     WHERE pk_site_id = $6
     RETURNING pk_site_id, site_name, timezone, timezone_label, location_address, status`,
    [name, timezone, timezone_label, address, status, Number(siteId)]
  );
  if (!rows.length) return res.status(404).json({ message: 'Site not found' });

  await writeAudit({ req, action: 'site.update',
    details: `Site updated: ${rows[0].site_name} (Status: ${rows[0].status})`,
    entityType: 'site', entityId: String(siteId), source: 'ui',
    after_data: JSON.stringify(rows[0])
  }).catch(() => {});
  return res.json(rows[0]);
}));

// 5. DELETE SITE
router.post('/delete', requirePermission('devices.write'), asyncHandler(async (req, res) => {
  const { siteId } = req.body;
  if (!siteId) return res.status(400).json({ message: 'siteId is required' });

  // FIX: previously deleted by pk_site_id alone with no ownership check at
  // all — any tenant holding devices.write could destructively wipe out any
  // OTHER tenant's entire site (buildings, units, device assignments,
  // employee/attendance references) below just by passing its ID. Scoped via
  // frs_customer the same way the rest of this file now is.
  const tenantId = req.auth?.scope?.tenantId;
  const isGlobal = req.auth?.memberships?.some(m => m.scope.tenantId === null);
  if (!isGlobal) {
    if (!tenantId) return res.status(403).json({ message: 'Forbidden' });
    const { rows: ownedRows } = await pool.query(
      `SELECT s.pk_site_id FROM frs_site s
       JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
       WHERE s.pk_site_id = $1 AND c.fk_tenant_id = $2`,
      [Number(siteId), tenantId]
    );
    if (!ownedRows.length) return res.status(404).json({ message: 'Site not found' });
  }

  await pool.query('BEGIN');
  try {
    // 1. Delete dependent data that doesn't cascade
    await pool.query('UPDATE attendance_record SET site_id = NULL, unit_id = NULL WHERE site_id = $1 OR unit_id IN (SELECT pk_unit_id FROM frs_unit WHERE fk_site_id = $1)', [Number(siteId)]);
    await pool.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable');
    try {
      await pool.query('UPDATE audit_log SET site_id = NULL, unit_id = NULL WHERE site_id = $1 OR unit_id IN (SELECT pk_unit_id FROM frs_unit WHERE fk_site_id = $1)', [Number(siteId)]);
    } finally {
      await pool.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable');
    }
    await pool.query('UPDATE facility_device SET site_id = NULL, unit_id = NULL WHERE site_id = $1 OR unit_id IN (SELECT pk_unit_id FROM frs_unit WHERE fk_site_id = $1)', [Number(siteId)]);
    await pool.query('UPDATE hr_employee SET site_id = NULL, unit_id = NULL WHERE site_id = $1 OR unit_id IN (SELECT pk_unit_id FROM frs_unit WHERE fk_site_id = $1)', [Number(siteId)]);
    await pool.query('UPDATE system_alert SET site_id = NULL, unit_id = NULL WHERE site_id = $1 OR unit_id IN (SELECT pk_unit_id FROM frs_unit WHERE fk_site_id = $1)', [Number(siteId)]);
    
    await pool.query('DELETE FROM frs_user_membership WHERE site_id = $1 OR unit_id IN (SELECT pk_unit_id FROM frs_unit WHERE fk_site_id = $1)', [Number(siteId)]);
    await pool.query('DELETE FROM frs_unit WHERE fk_site_id = $1', [Number(siteId)]);
    
    // 2. Delete buildings (if they don't cascade to floors/zones, this might still fail)
    // Actually Buildings in 009 have CASCADE for floors, so deleting building is enough.
    await pool.query(`DELETE FROM frs_building WHERE fk_site_id = $1`, [Number(siteId)]);
    
    // 3. Delete the site itself
    const { rowCount } = await pool.query(`DELETE FROM frs_site WHERE pk_site_id = $1`, [Number(siteId)]);
    
    if (!rowCount) {
      await pool.query('ROLLBACK');
      return res.status(404).json({ message: 'Site not found' });
    }

    await writeAudit({ req, action: 'site.delete',
      details: `Site deleted ID: ${siteId}`,
      entityType: 'site', entityId: String(siteId), source: 'ui'
    }).catch(() => {});

    await pool.query('COMMIT');
    res.json({ success: true, message: 'Site deleted successfully' });
  } catch (err) {
    await pool.query('ROLLBACK');
    logger.error('[site.delete] Error:', err);
    res.status(500).json({ 
      message: 'Failed to delete site. Some active resources may still be attached.' 
    });
  }
}));

// 6. GET HOLIDAYS
router.get('/holidays', requirePermission('attendance.read'), asyncHandler(async (req, res) => {
  const tenantId = req.auth?.scope?.tenantId;
  if (!tenantId) return res.json({ data: [] });

  const year = Number(req.query.year || new Date().getFullYear());
  const { rows } = await pool.query(
    `SELECT pk_holiday_id as id, name, date::text, type, recurring
     FROM tenant_holidays
     WHERE fk_tenant_id = $1
       AND EXTRACT(YEAR FROM date) = $2
     ORDER BY date`,
    [tenantId, year]
  );
  return res.json({ data: rows });
}));

// 7. CREATE HOLIDAY
router.post('/holidays', requirePermission('attendance.write'), validateBody(createHolidaySchema), asyncHandler(async (req, res) => {
  const tenantId = req.auth?.scope?.tenantId;
  if (!tenantId) return res.status(400).json({ message: 'tenantId required' });

  const { name, date, type = 'public', recurring = false } = req.validatedBody;

  const { rows } = await pool.query(
    `INSERT INTO tenant_holidays (fk_tenant_id, name, date, type, recurring)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING pk_holiday_id as id, name, date::text, type, recurring`,
    [tenantId, name, date, type, recurring]
  );
  return res.status(201).json(rows[0]);
}));

// 8. DELETE HOLIDAY
router.delete('/holidays/:id', requirePermission('attendance.write'), asyncHandler(async (req, res) => {
  const tenantId = req.auth?.scope?.tenantId;
  const { id } = req.params;

  const { rowCount } = await pool.query(
    `DELETE FROM tenant_holidays WHERE pk_holiday_id = $1 AND fk_tenant_id = $2`,
    [id, tenantId]
  );
  if (!rowCount) return res.status(404).json({ message: 'Holiday not found' });
  return res.json({ success: true });
}));

import { writeAudit } from '../middleware/auditLog.js';
import logger from '../utils/logger.js';
export { router as siteRoutes };
