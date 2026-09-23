#!/usr/bin/env node
/**
 * generateDeviceJWT.js — One-time script to mint a long-lived JWT for a Jetson device.
 * Run on the AWS instance, copy the token to the Jetson device's .env.
 *
 * Usage:
 *   node src/scripts/generateDeviceJWT.js --code jetson-01 --tenant <uuid> [--expires 365d]
 *
 * The token is verified by authenticateDevice.js middleware using DEVICE_JWT_SECRET.
 * Store the output in Jetson's environment as: DEVICE_JWT_TOKEN=<token>
 */
import jwt from 'jsonwebtoken';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { pool } from '../db/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env manually (dotenv may not be configured when running as a script)
try {
  const envPath = path.resolve(__dirname, '../../.env');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && !key.startsWith('#') && !process.env[key.trim()]) {
      process.env[key.trim()] = rest.join('=').trim().replace(/^["']|["']$/g, '');
    }
  }
} catch (_) {}

const DEVICE_JWT_SECRET = process.env.DEVICE_JWT_SECRET;
if (!DEVICE_JWT_SECRET || DEVICE_JWT_SECRET.includes('CHANGE_THIS')) {
  console.error('❌ DEVICE_JWT_SECRET is not set or is still the default value.');
  console.error('   Set it in backend/.env before generating tokens.');
  process.exit(1);
}

// Parse CLI arguments
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
}

const deviceCode = getArg('code');
const tenantId = getArg('tenant');
const expiresIn = getArg('expires') || '365d';

if (!deviceCode || !tenantId) {
  console.error('Usage: node src/scripts/generateDeviceJWT.js --code <device_code> --tenant <tenant_uuid> [--expires 365d]');
  process.exit(1);
}

try {
  // Look up device in DB to get its numeric pk
  const { rows } = await pool.query(
    `SELECT pk_device_id, external_device_id, name
     FROM facility_device
     WHERE external_device_id = $1 AND tenant_id = $2::uuid`,
    [deviceCode, tenantId]
  );

  if (!rows.length) {
    console.error(`❌ Device '${deviceCode}' not found for tenant '${tenantId}'.`);
    console.error('   Register the device first via POST /api/device-management/devices');
    await pool.end();
    process.exit(1);
  }

  const device = rows[0];

  const payload = {
    device_id: device.pk_device_id,
    device_code: device.external_device_id,
    external_device_id: device.external_device_id, // legacy compat
    tenant_id: tenantId,
    type: 'jetson',
    iat: Math.floor(Date.now() / 1000),
  };

  const token = jwt.sign(payload, DEVICE_JWT_SECRET, { expiresIn });

  console.log('\n✅ Device JWT generated successfully\n');
  console.log(`Device : ${device.name} (${device.external_device_id})`);
  console.log(`Tenant : ${tenantId}`);
  console.log(`Expires: ${expiresIn} from now\n`);
  console.log('─'.repeat(80));
  console.log('Add this to the Jetson device .env:');
  console.log('─'.repeat(80));
  console.log(`DEVICE_JWT_TOKEN=${token}`);
  console.log(`AWS_BACKEND_URL=https://<your-aws-domain>/api`);
  console.log('─'.repeat(80));
  console.log('\nThe Jetson should include this token in every request:');
  console.log('  Authorization: Bearer <token>\n');

  await pool.end();
  process.exit(0);
} catch (err) {
  console.error('❌ Error:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
