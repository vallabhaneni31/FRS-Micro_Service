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
  password: process.env.DB_PASSWORD || 'postgres',
});

async function main() {
  try {
    console.log('\n🔍 Checking for registered devices and live heartbeats...\n');

    // 1. Check ZTP activation PIN usage
    const pinRes = await pool.query(`
      SELECT activation_pin, used_at, expires_at, fk_tenant_id, fk_site_id
      FROM device_activation_code
      ORDER BY created_at DESC
      LIMIT 3
    `);

    console.log('📌 Recent Activation PINs status:');
    if (pinRes.rows.length === 0) {
      console.log('   No activation codes found.');
    } else {
      pinRes.rows.forEach(row => {
        console.log(`   - PIN [${row.activation_pin}]: Used: ${row.used_at ? `\x1b[32mYES at ${row.used_at.toLocaleTimeString()}\x1b[0m` : '\x1b[31mNO (Pending)\x1b[0m'} | Expires: ${row.expires_at.toLocaleTimeString()}`);
      });
    }
    console.log();

    // 2. Check recently registered/active devices
    const deviceRes = await pool.query(`
      SELECT pk_device_id, external_device_id, name, status, last_active, last_heartbeat
      FROM facility_device
      ORDER BY last_active DESC NULLS LAST, pk_device_id DESC
      LIMIT 5
    `);

    console.log('📱 Registered Devices status:');
    if (deviceRes.rows.length === 0) {
      console.log('   No registered devices in facility_device table.');
    } else {
      deviceRes.rows.forEach(row => {
        const lastActiveStr = row.last_active ? row.last_active.toLocaleString() : 'Never';
        const lastHbStr = row.last_heartbeat ? row.last_heartbeat.toLocaleString() : 'Never';
        console.log(`   - Code: \x1b[36m\x1b[1m${row.external_device_id}\x1b[0m | Name: ${row.name} | Status: \x1b[33m${row.status}\x1b[0m`);
        console.log(`     └─ Last Active: ${lastActiveStr} | Last Heartbeat: ${lastHbStr}`);
      });
    }
    console.log();

    // 3. Check time-series heartbeats (from device_heartbeat)
    const hbRes = await pool.query(`
      SELECT dh.timestamp, dh.status, dh.metrics, fd.external_device_id
      FROM device_heartbeat dh
      JOIN facility_device fd ON fd.pk_device_id = dh.device_id
      ORDER BY dh.timestamp DESC
      LIMIT 5
    `);

    console.log('💓 Recent heartbeat records:');
    if (hbRes.rows.length === 0) {
      console.log('   No records in device_heartbeat table.');
    } else {
      hbRes.rows.forEach(row => {
        console.log(`   - [${row.timestamp.toLocaleTimeString()}] Device: \x1b[32m\x1b[1m${row.external_device_id}\x1b[0m | Status: ${row.status}`);
        console.log(`     Metrics: ${JSON.stringify(row.metrics)}`);
      });
    }
    console.log();

  } catch (err) {
    console.error('❌ Database error:', err.message);
  } finally {
    await pool.end();
  }
}

main();
