/**
 * configRoutes.js — Configuration Management APIs
 * Phase 3, Task 3.1-3.2: Config versioning and push
 */
import express from 'express';
import { requireAuth, requirePermission } from '../middleware/authz.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { pool } from '../db/pool.js';
import logger from '../utils/logger.js';
import {
  getMergedConfig,
  updateConfig,
  pushConfigToDevice,
  validateConfig
} from '../services/configService.js';

const router = express.Router();

// ============================================================================
// GET /api/config/:level/:id - Get Config by Level
// ============================================================================
router.get('/:level/:id', requireAuth, requirePermission('devices.read'), asyncHandler(async (req, res) => {
  const { level, id } = req.params;

  try {
    let config = null;

    switch (level) {
      case 'global':
        const global = await pool.query(
          'SELECT setting_value FROM system_settings WHERE setting_key = $1',
          ['global_device_config']
        );
        config = global.rows[0]?.setting_value || {};
        break;

      case 'site':
        const site = await pool.query(
          'SELECT site_config FROM frs_site WHERE pk_site_id = $1',
          [id]
        );
        config = site.rows[0]?.site_config || {};
        break;

      case 'device':
        const device = await pool.query(
          'SELECT device_config FROM facility_device WHERE pk_device_id = $1',
          [id]
        );
        config = device.rows[0]?.device_config || {};
        break;

      default:
        return res.status(400).json({ error: 'Invalid config level' });
    }

    res.json({
      success: true,
      level,
      entity_id: id,
      config
    });

  } catch (error) {
    logger.error('Get config error:', error);
    res.status(500).json({ error: 'Failed to get config' });
  }
}));

// ============================================================================
// PUT /api/config/:level/:id - Update Config
// ============================================================================
router.put('/:level/:id', requireAuth, requirePermission('devices.write'), asyncHandler(async (req, res) => {
  const { level, id } = req.params;
  const { config } = req.body;
  const userId = req.auth?.user?.id;

  if (!config) {
    return res.status(400).json({ error: 'config is required' });
  }

  // Validate config
  const validation = validateConfig(config);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  try {
    const result = await updateConfig(level, id, config, userId);

    // If device config, push to device
    if (level === 'device') {
      await pushConfigToDevice(id);
    }

    res.json({
      success: true,
      message: 'Config updated successfully',
      ...result
    });

  } catch (error) {
    logger.error('Update config error:', error);
    res.status(500).json({ error: 'Failed to update config' });
  }
}));

// ============================================================================
// POST /api/config/push/:deviceId - Force Push Config to Device
// ============================================================================
router.post('/push/:deviceId', requireAuth, requirePermission('devices.write'), asyncHandler(async (req, res) => {
  const { deviceId } = req.params;

  try {
    const result = await pushConfigToDevice(deviceId);

    res.json({
      success: true,
      message: 'Config pushed to device successfully',
      ...result
    });

  } catch (error) {
    logger.error('Push config error:', error);
    res.status(500).json({ error: 'Failed to push config' });
  }
}));

// ============================================================================
// GET /api/config/history/:level/:id - Get Config Change History
// ============================================================================
router.get('/history/:level/:id', requireAuth, requirePermission('devices.read'), asyncHandler(async (req, res) => {
  const { level, id } = req.params;
  const { limit = 50 } = req.query;

  try {
    const history = await pool.query(`
      SELECT 
        ccl.pk_log_id,
        ccl.level,
        ccl.entity_id,
        ccl.new_config,
        ccl.changed_at,
        ccl.change_reason,
        u.email as changed_by_email
      FROM config_change_log ccl
      LEFT JOIN frs_user u ON u.pk_user_id = ccl.changed_by
      WHERE ccl.level = $1 AND ccl.entity_id = $2
      ORDER BY ccl.changed_at DESC
      LIMIT $3
    `, [level, id, parseInt(limit)]);

    res.json({
      success: true,
      count: history.rows.length,
      history: history.rows
    });

  } catch (error) {
    logger.error('Get config history error:', error);
    res.status(500).json({ error: 'Failed to get config history' });
  }
}));

export default router;
