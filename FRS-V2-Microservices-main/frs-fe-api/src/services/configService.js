/**
 * configService.js — Configuration Management Service
 * Phase 3, Task 3.1: Config merging with versioning
 */
import { pool } from '../db/pool.js';
import { publishToKafka } from './kafkaProducer.js';
import logger from '../utils/logger.js';

/**
 * Deep merge objects (right overrides left)
 */
function deepMerge(target, source) {
  const output = { ...target };
  
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          output[key] = source[key];
        } else {
          output[key] = deepMerge(target[key], source[key]);
        }
      } else {
        output[key] = source[key];
      }
    });
  }
  
  return output;
}

function isObject(item) {
  return item && typeof item === 'object' && !Array.isArray(item);
}

/**
 * Get merged config with hierarchy: Global → Site → Device
 * Returns config with version tracking
 */
export async function getMergedConfig(deviceId) {
  try {
    const result = await pool.query(
      'SELECT get_effective_device_config($1) as config',
      [deviceId]
    );
    let config = result.rows[0]?.config || {};
    if (typeof config === 'string') {
      try {
        config = JSON.parse(config);
      } catch (e) {
        logger.error({ err: e }, '[configService] Failed to parse config string');
      }
    }
    return config;
  } catch (error) {
    logger.error({ err: error }, '[configService] Config merge error');
    throw error;
  }
}

/**
 * Update config and track version
 */
export async function updateConfig(level, entityId, newConfig, userId) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    let tableName, idColumn, configColumn;
    
    switch (level) {
      case 'global':
        // Update system_settings
        await client.query(`
          INSERT INTO system_settings (setting_key, setting_value, category, data_type, updated_by)
          VALUES ('global_device_config', $1, 'device_config', 'json', $2)
          ON CONFLICT (setting_key) 
          DO UPDATE SET setting_value = $1, updated_by = $2, updated_at = NOW()
        `, [JSON.stringify(newConfig), userId]);
        break;
        
      case 'site':
        tableName = 'frs_site';
        idColumn = 'pk_site_id';
        configColumn = 'site_config';
        
        await client.query(`
          UPDATE ${tableName}
          SET ${configColumn} = $1
          WHERE ${idColumn} = $2
        `, [JSON.stringify(newConfig), entityId]);
        break;
        
      case 'device':
        tableName = 'facility_device';
        idColumn = 'pk_device_id';
        configColumn = 'device_config';
        
        await client.query(`
          UPDATE ${tableName}
          SET ${configColumn} = $1
          WHERE ${idColumn} = $2
        `, [JSON.stringify(newConfig), entityId]);
        break;
        
      default:
        throw new Error(`Invalid config level: ${level}`);
    }

    // Log config change (create table if needed)
    await client.query(`
      CREATE TABLE IF NOT EXISTS config_change_log (
        pk_log_id BIGSERIAL PRIMARY KEY,
        level VARCHAR(20) NOT NULL,
        entity_id INTEGER,
        old_config JSONB,
        new_config JSONB NOT NULL,
        changed_by INTEGER REFERENCES frs_user(pk_user_id),
        changed_at TIMESTAMP DEFAULT NOW(),
        change_reason TEXT
      )
    `);

    await client.query(`
      INSERT INTO config_change_log (level, entity_id, new_config, changed_by)
      VALUES ($1, $2, $3, $4)
    `, [level, entityId, JSON.stringify(newConfig), userId]);

    await client.query('COMMIT');

    return { success: true, level, entityId, config: newConfig };

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Push config to device via Kafka
 */
export async function pushConfigToDevice(deviceId) {
  try {
    // Get device external ID
    const device = await pool.query(
      'SELECT external_device_id FROM facility_device WHERE pk_device_id = $1',
      [deviceId]
    );

    if (device.rows.length === 0) {
      throw new Error('Device not found');
    }

    const deviceCode = device.rows[0].external_device_id;
    
    // Get merged config
    const config = await getMergedConfig(deviceId);

    // Publish to Kafka device-commands topic
    await publishToKafka('device-commands', {
      command: 'update_config',
      device_code: deviceCode,
      config: config,
      timestamp: new Date().toISOString(),
      version: Date.now() // Simple versioning using timestamp
    });

    // Also queue in database for polling fallback
    await pool.query(`
      INSERT INTO device_command_queue (
        device_id, command_type, command_payload, priority
      ) VALUES ($1, 'update_config', $2, 5)
    `, [deviceId, JSON.stringify({ config, version: Date.now() })]);

    return { success: true, device_code: deviceCode, config };

  } catch (error) {
    logger.error({ err: error }, '[configService] Push config error');
    throw error;
  }
}

/**
 * Validate config against JSON schema
 */
export function validateConfig(config) {
  // Basic validation - can be extended with ajv or similar
  const required = ['attendance_rules', 'recognition_settings'];
  
  for (const key of required) {
    if (!config[key]) {
      return { valid: false, error: `Missing required field: ${key}` };
    }
  }

  // Validate attendance_rules
  if (config.attendance_rules) {
    const ar = config.attendance_rules;
    if (!ar.work_hours_start || !ar.work_hours_end) {
      return { valid: false, error: 'attendance_rules missing work hours' };
    }
  }

  // Validate recognition_settings
  if (config.recognition_settings) {
    const rs = config.recognition_settings;
    if (rs.match_threshold < 0 || rs.match_threshold > 1) {
      return { valid: false, error: 'match_threshold must be between 0 and 1' };
    }
  }

  return { valid: true };
}

export default {
  getMergedConfig,
  updateConfig,
  pushConfigToDevice,
  validateConfig
};
