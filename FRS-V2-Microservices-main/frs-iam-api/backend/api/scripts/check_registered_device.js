#!/usr/bin/env node

import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'attendance_intelligence',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres123',
});

async function main() {
  try {
    const devRes = await pool.query(`
      SELECT pk_device_id, external_device_id, name, status, last_active, last_heartbeat
      FROM facility_device
      ORDER BY pk_device_id DESC
      LIMIT 5
    `);
    
    if (devRes.rows.length === 0) {
      console.log('DEVICE_NOT_FOUND');
    } else {
      devRes.rows.forEach(dev => {
        console.log(`DEVICE_FOUND|ID:${dev.pk_device_id}|CODE:${dev.external_device_id}|NAME:${dev.name}|STATUS:${dev.status}`);
      });
    }

    const hbRes = await pool.query(`
      SELECT timestamp, status, metrics
      FROM device_heartbeat
      ORDER BY timestamp DESC
      LIMIT 1
    `);

    if (hbRes.rows.length > 0) {
      const hb = hbRes.rows[0];
      console.log(`LATEST_HB_TIME:${hb.timestamp.toISOString()}|STATUS:${hb.status}|METRICS:${JSON.stringify(hb.metrics)}`);
    } else {
      console.log('NO_HB_RECORDS');
    }
  } catch (err) {
    console.log(`DB_ERROR:${err.message}`);
  } finally {
    await pool.end();
  }
}

main();
