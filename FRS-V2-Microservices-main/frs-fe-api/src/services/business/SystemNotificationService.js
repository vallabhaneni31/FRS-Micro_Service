import { query } from '../../db/pool.js';
import logger from '../../utils/logger.js';
import wsManager from '../../websocket/index.js';

/**
 * Synchronizes and routes notifications based on the user hierarchy, roles, tenant, and organization mappings.
 * @param {Object} alert
 * @param {string} alert.tenant_id
 * @param {string} [alert.site_id] - Limits visibility to HR Managers of specific organizations
 * @param {string} alert.alert_type - e.g., 'EMPLOYEE_ENROLLMENT', 'ATTENDANCE_UPDATE', 'DEVICE_STATUS'
 * @param {string} alert.severity - 'low', 'medium', 'high', 'critical'
 * @param {string} alert.title
 * @param {string} alert.message
 * @param {string} [alert.fk_employee_id] - Optional, related employee
 * @param {string} [alert.fk_device_id] - Optional, related device (facility_device.pk_device_id)
 * @param {string} [alert.photo_url] - Optional, the photo captured for the event this alert is about
 */
export async function createSystemNotification({
  tenant_id,
  site_id = null,
  alert_type,
  severity = 'medium',
  title,
  message,
  fk_employee_id = null,
  fk_device_id = null,
  customer_id = null,
  unit_id = null,
  photo_url = null
}) {
  try {
    const validSeverities = ['low', 'medium', 'high', 'critical'];
    const dbSeverity = validSeverities.includes(severity) ? severity : 'medium';

    const { rows } = await query(
      `INSERT INTO system_alert (tenant_id, site_id, customer_id, unit_id, alert_type, severity, title, message, fk_employee_id, fk_device_id, photo_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [tenant_id, site_id, customer_id, unit_id, alert_type, dbSeverity, title, message, fk_employee_id, fk_device_id, photo_url]
    );
    logger.info({ tenant_id, site_id, alert_type }, `System notification created: ${title}`);
    
    // Broadcast in real-time
    try {
      wsManager.getIO()?.to(`tenant:${tenant_id}`).emit('system.alert.new', rows[0]);
    } catch (_) {}
  } catch (err) {
    logger.error({ err, tenant_id, alert_type }, 'Failed to create system notification');
  }
}
