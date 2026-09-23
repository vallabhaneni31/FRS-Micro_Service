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
    // 1. Resolve Tenant Context
    const tenantRes = await pool.query('SELECT pk_tenant_id, tenant_name FROM frs_tenant LIMIT 1');
    if (tenantRes.rows.length === 0) {
      console.error('❌ Error: No tenants found in database. Please seed the database first.');
      process.exit(1);
    }
    const tenant = tenantRes.rows[0];
    const tenantId = tenant.pk_tenant_id;

    // 2. Resolve Site Context
    const siteRes = await pool.query(
      `SELECT s.pk_site_id, s.site_name FROM frs_site s
       JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
       WHERE c.fk_tenant_id = $1::uuid LIMIT 1`,
      [tenantId]
    );
    const siteId = siteRes.rows[0]?.pk_site_id || null;
    const siteName = siteRes.rows[0]?.site_name || 'None';

    // 3. Resolve Admin User ID for audit reference
    const userRes = await pool.query('SELECT pk_user_id FROM frs_user LIMIT 1');
    const userId = userRes.rows[0]?.pk_user_id || null;

    // 4. Generate random 6-digit PIN
    const pinNum = Math.floor(100000 + Math.random() * 900000);
    const pin = `${String(pinNum).slice(0, 3)}-${String(pinNum).slice(3)}`;
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 mins from now

    // 5. Insert into device_activation_code
    await pool.query(`
      INSERT INTO device_activation_code
        (fk_tenant_id, activation_pin, token_validity_days, created_by, expires_at, fk_site_id, device_role, zone_name)
      VALUES ($1, $2, 365, $3, $4, $5, 'entry_point', 'Main Lobby')
    `, [tenantId, pin, userId, expiresAt, siteId]);

    console.log('\n\x1b[32m\x1b[1m=== FRESH ACTIVATION PIN GENERATED ===\x1b[0m');
    console.log(`🔑 PIN CODE:          \x1b[36m\x1b[1m${pin}\x1b[0m`);
    console.log(`⏱️ Expiry:             \x1b[33m${expiresAt.toLocaleTimeString()} (30 minutes)\x1b[0m`);
    console.log(`🏢 Tenant Assignment: \x1b[35m${tenant.tenant_name} (${tenantId})\x1b[0m`);
    console.log(`📍 Site Auto-Assign:  \x1b[35m${siteName} (ID: ${siteId || 'None'})\x1b[0m`);
    console.log('======================================\n');

    console.log('\x1b[1m👉 Handshake API Call configuration:\x1b[0m');
    console.log(`Method: \x1b[32mPOST\x1b[0m`);
    console.log(`URL:    \x1b[34mhttp://<your-server-ip>:8080/api/device-management/devices/activate\x1b[0m`);
    console.log(`Header: \x1b[33mContent-Type: application/json\x1b[0m`);
    console.log('JSON Payload Body:');
    console.log(JSON.stringify({
      pin,
      external_device_id: "REAL-JETSON-ORIN-01",
      device_type_code: "jetson_orin_nx",
      name: "Entrance Edge Box",
      location_label: "Main Lobby Entrance",
      ip_address: "192.168.1.100"
    }, null, 2));
    console.log();

  } catch (err) {
    console.error('❌ Database error:', err.message);
  } finally {
    await pool.end();
  }
}

main();
