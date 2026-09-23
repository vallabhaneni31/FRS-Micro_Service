#!/usr/bin/env node
/**
 * test_s3_photo_flow.js — end-to-end verification of the S3 storage migration.
 *
 * Exercises the exact same path a real Jetson device + browser UI would:
 *   1. POST a simulated face-recognition event (with a real photo) to
 *      POST /api/events, the same endpoint Jetson devices use. This drives
 *      DeviceEventService.processEvent, which now uploads the photo straight
 *      to the S3 logs bucket instead of local disk.
 *   2. Confirm directly against S3 that the object landed in the bucket.
 *   3. GET the photo back through the same route the frontend's
 *      authedPhoto.ts calls (GET /api/jetson/photos/:filename), proving the
 *      backend-proxy read path (Option A) actually streams from S3.
 *
 * Uses a disposable test employee (created and torn down by this script) so
 * it never touches real attendance data on this shared dev/QA instance.
 *
 * Usage: node scripts/test_s3_photo_flow.js
 */
import pg from 'pg';
import dotenv from 'dotenv';
import sharp from 'sharp';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'attendance_intelligence',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const serverUrl = process.env.PUBLIC_BASE_URL || process.env.APP_URL || `http://localhost:${process.env.PORT || 8080}`;

const C_RESET = '\x1b[0m', C_GREEN = '\x1b[32m', C_RED = '\x1b[31m', C_CYAN = '\x1b[36m', C_YELLOW = '\x1b[33m', C_BRIGHT = '\x1b[1m';
const ok = (msg) => console.log(`${C_GREEN}✔${C_RESET} ${msg}`);
const info = (msg) => console.log(`${C_CYAN}ℹ${C_RESET} ${msg}`);
const warn = (msg) => console.log(`${C_YELLOW}⚠${C_RESET} ${msg}`);
const fail = (msg) => { console.error(`${C_RED}✖ ${msg}${C_RESET}`); process.exitCode = 1; };

let testEmployeeId = null;
let tenantId = null;
let deviceCode = null;

async function cleanup() {
  try {
    if (testEmployeeId) {
      await pool.query('DELETE FROM attendance_record WHERE fk_employee_id = $1', [testEmployeeId]);
      await pool.query('DELETE FROM system_alert WHERE fk_employee_id = $1', [testEmployeeId]);
      await pool.query('DELETE FROM employee_presence_ping WHERE employee_id = $1', [testEmployeeId]).catch(() => {});
      await pool.query('DELETE FROM hr_employee WHERE pk_employee_id = $1', [testEmployeeId]);
      info(`Cleaned up test employee ${testEmployeeId} and its attendance_record/system_alert rows`);
    }
  } catch (err) {
    warn(`Cleanup failed (non-fatal): ${err.message}`);
  }
  await pool.end();
}

async function main() {
  console.log(`${C_BRIGHT}=== S3 photo flow verification ===${C_RESET}`);
  info(`Target server: ${serverUrl}`);

  // ── Setup: tenant + disposable test employee ──────────────────────────────
  const tenantRes = await pool.query('SELECT pk_tenant_id, tenant_name FROM frs_tenant LIMIT 1');
  if (!tenantRes.rows.length) throw new Error('No tenants found — seed the database first');
  tenantId = tenantRes.rows[0].pk_tenant_id;
  ok(`Using tenant: ${tenantRes.rows[0].tenant_name} [${tenantId}]`);

  const empCode = `S3TEST-${Date.now()}`;
  const empRes = await pool.query(
    `INSERT INTO hr_employee (employee_code, full_name, email, position_title, status, join_date, tenant_id)
     VALUES ($1, $2, $3, 'Test', 'active', CURRENT_DATE, $4)
     RETURNING pk_employee_id`,
    [empCode, 'S3 Migration Test Employee', `${empCode.toLowerCase()}@example.invalid`, tenantId]
  );
  testEmployeeId = empRes.rows[0].pk_employee_id;
  ok(`Created disposable test employee ${empCode} [id ${testEmployeeId}]`);

  // ── ZTP device activation (same handshake real Jetson boxes use) ─────────
  const pinNum = Math.floor(100000 + Math.random() * 900000);
  const pin = `${String(pinNum).slice(0, 3)}-${String(pinNum).slice(3)}`;
  await pool.query(
    `INSERT INTO device_activation_code (fk_tenant_id, activation_pin, token_validity_days, expires_at)
     VALUES ($1, $2, 1, NOW() + INTERVAL '30 minutes')`,
    [tenantId, pin]
  );

  deviceCode = `S3-TEST-SIM-${Math.floor(1000 + Math.random() * 9000)}`;
  const activateRes = await fetch(`${serverUrl}/api/device-management/devices/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pin,
      external_device_id: deviceCode,
      device_type_code: 'jetson_orin_nx',
      name: `S3 test simulator (${deviceCode})`,
      ip_address: '192.168.1.199',
    }),
  });
  const activateData = await activateRes.json();
  if (!activateRes.ok) throw new Error(`Device activation failed: ${activateData.message || activateData.error}`);
  const deviceToken = activateData.token;
  ok(`Activated simulated device ${deviceCode} and obtained device JWT`);

  // ── Step 1: POST a face.recognized event with a real photo (photo_base64) ─
  const jpegBuffer = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 20, g: 120, b: 200 } },
  }).jpeg().toBuffer();
  const dataUri = `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`;

  info(`Generated a ${jpegBuffer.length}-byte test JPEG, POSTing as a face.recognized check-in...`);
  const eventRes = await fetch(`${serverUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({
      event_type: 'face.recognized',
      payload: {
        employee_code: empCode,
        employee_id: testEmployeeId,
        confidence: 0.93,
        direction: 'in',
        photo_base64: dataUri,
      },
    }),
  });
  const eventData = await eventRes.json();
  if (!eventRes.ok) throw new Error(`POST /api/events failed: ${JSON.stringify(eventData)}`);
  ok('POST /api/events accepted (200) — DeviceEventService.processEvent ran synchronously');

  // ── Step 2: confirm the DB row now holds a real S3 key, not a local path ──
  const attRes = await pool.query(
    `SELECT checkin_photo_url FROM attendance_record WHERE fk_employee_id = $1 ORDER BY pk_attendance_id DESC LIMIT 1`,
    [testEmployeeId]
  );
  if (!attRes.rows.length) throw new Error('No attendance_record row was created — check-in was not processed');
  const s3Key = attRes.rows[0].checkin_photo_url;
  if (!s3Key || s3Key.startsWith('/')) {
    throw new Error(`checkin_photo_url does not look like an S3 key: ${s3Key}`);
  }
  ok(`attendance_record.checkin_photo_url is a bare S3 key: ${s3Key}`);

  // ── Step 3: confirm the object really exists in the S3 logs bucket ───────
  const storage = await import('../src/services/storageService.js');
  const s3Buffer = await storage.getFileBuffer(storage.LOGS_BUCKET, s3Key);
  if (s3Buffer.length !== jpegBuffer.length) {
    throw new Error(`S3 object size mismatch: uploaded ${jpegBuffer.length} bytes, S3 has ${s3Buffer.length} bytes`);
  }
  ok(`Verified object exists in s3://${storage.LOGS_BUCKET}/${s3Key} (${s3Buffer.length} bytes, matches upload)`);

  // ── Step 4: GET the photo back exactly as the frontend would ─────────────
  // authedPhoto.ts's resolvePhotoPath sends anything that isn't http/"/uploads"
  // to /api/jetson/photos/{basename} — the new S3 keys never start with
  // "/uploads", so this is the real route the UI hits for these photos.
  const filename = s3Key.split('/').pop();
  info(`Fetching GET /api/jetson/photos/${filename} as the browser UI would...`);
  const getRes = await fetch(`${serverUrl}/api/jetson/photos/${filename}`, {
    headers: {
      // requireAuth 401s immediately if no token at all is present — send a
      // deliberately invalid one so the (NODE_ENV=development-only) dev-bypass
      // path kicks in and resolves scope from x-tenant-id instead.
      Authorization: 'Bearer dev-bypass-test-token',
      'x-tenant-id': tenantId,
    },
  });
  if (!getRes.ok) {
    const body = await getRes.text();
    throw new Error(`GET /api/jetson/photos/${filename} failed: ${getRes.status} ${body}`);
  }
  const fetchedBuffer = Buffer.from(await getRes.arrayBuffer());
  if (fetchedBuffer.length !== jpegBuffer.length) {
    throw new Error(`Fetched photo size mismatch: expected ${jpegBuffer.length}, got ${fetchedBuffer.length}`);
  }
  ok(`GET succeeded — fetched ${fetchedBuffer.length} bytes, Content-Type: ${getRes.headers.get('content-type')}`);

  console.log(`\n${C_GREEN}${C_BRIGHT}=== ALL CHECKS PASSED — S3 upload (POST) + backend-proxy fetch (GET) round-trip verified ===${C_RESET}`);
}

main()
  .catch((err) => fail(err.message))
  .finally(cleanup);
