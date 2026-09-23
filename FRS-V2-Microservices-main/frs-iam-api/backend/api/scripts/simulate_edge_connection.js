#!/usr/bin/env node

/**
 * simulate_edge_connection.js
 * 
 * A comprehensive Edge Box Simulator to establish and demonstrate full
 * device-to-server communication including:
 *   1. Auto-generation of a Zero-Touch Provisioning (ZTP) Activation PIN (via direct DB connection)
 *   2. Edge Box Handshake Activation (ZTP) via the HTTP API to obtain a JWT token
 *   3. Ongoing periodic heartbeats with realistic hardware telemetry metrics
 *   4. Active polling for remote commands (reboot, config update, etc.)
 *   5. Simulated biometric attendance events (face.recognized) using real database records
 */

import pg from 'pg';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'attendance_intelligence',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ANSI Colors for beautiful UI logs
const C_RESET = '\x1b[0m';
const C_BRIGHT = '\x1b[1m';
const C_GREEN = '\x1b[32m';
const C_BLUE = '\x1b[34m';
const C_CYAN = '\x1b[36m';
const C_YELLOW = '\x1b[33m';
const C_RED = '\x1b[31m';
const C_MAGENTA = '\x1b[35m';

function logInfo(msg) {
  console.log(`${C_CYAN}[INFO]${C_RESET} ${msg}`);
}
function logSuccess(msg) {
  console.log(`${C_GREEN}✔ [SUCCESS]${C_RESET} ${C_BRIGHT}${msg}${C_RESET}`);
}
function logWarn(msg) {
  console.log(`${C_YELLOW}⚠ [WARNING]${C_RESET} ${msg}`);
}
function logError(msg, err = '') {
  console.error(`${C_RED}✖ [ERROR]${C_RESET} ${C_BRIGHT}${msg}${C_RESET}`, err);
}

async function runSimulator() {
  console.clear();
  console.log(`\x1b[46m\x1b[30m${' '.repeat(80)}\x1b[0m`);
  console.log(`\x1b[46m\x1b[30m   FRS EDGE BOX SIMULATOR - ZERO-TOUCH PROVISIONING & DEVICE-SERVER LINK        \x1b[0m`);
  console.log(`\x1b[46m\x1b[30m${' '.repeat(80)}\x1b[0m\n`);

  const serverUrl = process.env.PUBLIC_BASE_URL || process.env.APP_URL || `http://localhost:${process.env.PORT || 8080}`;
  logInfo(`Connecting to server at: ${C_BRIGHT}${serverUrl}${C_RESET}`);

  let tenantId, userId, siteId, employeeRecords = [];

  // --- Step 1: Query Database for Context & Autogenerate PIN ---
  logInfo('Connecting to PostgreSQL database to resolve tenant contexts...');
  try {
    // Get tenant
    const tenantRes = await pool.query('SELECT pk_tenant_id, name, vertical FROM frs_tenant LIMIT 1');
    if (tenantRes.rows.length === 0) {
      logError('No tenants found in frs_tenant table. Please seed the database first.');
      await pool.end();
      return;
    }
    const tenant = tenantRes.rows[0];
    tenantId = tenant.pk_tenant_id;
    logSuccess(`Found active Tenant: ${tenant.name} (${tenant.vertical} vertical) [${tenantId}]`);

    // Get site
    const siteRes = await pool.query(
      `SELECT s.pk_site_id, s.site_name FROM frs_site s
       JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
       WHERE c.fk_tenant_id = $1::uuid LIMIT 1`,
      [tenantId]
    );
    if (siteRes.rows.length > 0) {
      siteId = siteRes.rows[0].pk_site_id;
      logSuccess(`Found Target Site: ${siteRes.rows[0].site_name} [ID: ${siteId}]`);
    } else {
      logWarn('No sites found for this tenant. Device will be activated without site auto-assignment.');
    }

    // Get a user for PIN creation
    const userRes = await pool.query('SELECT pk_user_id FROM frs_user LIMIT 1');
    userId = userRes.rows[0]?.pk_user_id || null;

    // Get real employees/students to simulate realistic scans
    if (tenant.vertical === 'education') {
      const studRes = await pool.query(
        'SELECT pk_student_id as id, roll_number as code, name FROM edu_student WHERE fk_tenant_id = $1 LIMIT 20',
        [tenantId]
      );
      employeeRecords = studRes.rows;
    } else {
      const empRes = await pool.query(
        'SELECT pk_employee_id as id, employee_code as code, first_name || \' \' || last_name as name FROM hr_employee WHERE tenant_id = $1 LIMIT 20',
        [tenantId]
      );
      employeeRecords = empRes.rows.map(r => ({ id: r.id, code: r.code, name: r.name }));
    }
    logSuccess(`Loaded ${employeeRecords.length} identity profiles for simulated attendance checks.`);

  } catch (err) {
    logError('Failed to query Database.', err.message);
    await pool.end();
    return;
  }

  // --- Step 2: Generate ZTP PIN ---
  let pin;
  logInfo('Generating Zero-Touch Provisioning (ZTP) Activation PIN...');
  try {
    const pinNum = Math.floor(100000 + Math.random() * 900000);
    pin = `${String(pinNum).slice(0, 3)}-${String(pinNum).slice(3)}`;
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 mins

    await pool.query(`
      INSERT INTO device_activation_code
        (fk_tenant_id, activation_pin, token_validity_days, created_by, expires_at, fk_site_id, device_role, zone_name)
      VALUES ($1, $2, 365, $3, $4, $5, 'entry_point', 'Main Lobby')
    `, [tenantId, pin, userId, expiresAt, siteId || null]);

    logSuccess(`Generated PIN: ${C_BRIGHT}${pin}${C_RESET} (Expires at: ${expiresAt.toLocaleTimeString()})`);
  } catch (err) {
    logError('Failed to generate PIN in database.', err.message);
    await pool.end();
    return;
  }

  // Close the direct pool connection as we'll use API routes for edge communication
  await pool.end();

  // --- Step 3: Device Activation Handshake (ZTP) ---
  const mockDeviceCode = `EDGE-SIM-${Math.floor(1000 + Math.random() * 9000)}`;
  const activationBody = {
    pin,
    external_device_id: mockDeviceCode,
    device_type_code: 'jetson_orin_nx',
    name: `Simulated Jetson Box (${mockDeviceCode})`,
    location_label: 'Main Entrance Lobby',
    ip_address: '192.168.1.189',
    serial_number: `JNX-${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
    mac_address: '00:04:4b:2b:81:8f',
    notes: 'Edge Box simulator instance established for communications test.'
  };

  logInfo(`Attempting ZTP handshake for new device: ${C_BRIGHT}${mockDeviceCode}${C_RESET}...`);
  let deviceToken, deviceConfig = {};

  try {
    const activateRes = await fetch(`${serverUrl}/api/device-management/devices/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(activationBody)
    });

    const activateData = await activateRes.json();
    if (!activateRes.ok) {
      throw new Error(activateData.message || activateData.error || 'Activation rejected by server');
    }

    deviceToken = activateData.token;
    logSuccess(`Edge Box registered successfully! Received JWT production token.`);
    console.log(`   └─ Site Assignment: ${C_CYAN}Auto-assigned (Site ID: ${activateData.site_id})${C_RESET}`);
    console.log(`   └─ Device Role:     ${C_CYAN}${activateData.device_role}${C_RESET}`);
    console.log(`   └─ Zone:            ${C_CYAN}${activateData.zone_name}${C_RESET}`);

  } catch (err) {
    logError('Activation handshake failed.', err.message);
    return;
  }

  // --- Step 4: Periodic Loop (Telemetry Heartbeats, Command Polling, Mock Events) ---
  console.log('\n' + '─'.repeat(80));
  logInfo(`Starting Simulated Active State for ${C_BRIGHT}${mockDeviceCode}${C_RESET}`);
  console.log('─'.repeat(80));

  let ticks = 0;

  // Heartbeat function
  async function sendHeartbeat() {
    const cpu = (35 + Math.sin(ticks / 5) * 15).toFixed(1);
    const temp = (45 + Math.sin(ticks / 8) * 8).toFixed(1);
    const mem = (4200 + Math.sin(ticks / 3) * 300).toFixed(0);

    const heartbeatPayload = {
      event_type: 'heartbeat',
      event_time: new Date().toISOString(),
      payload: {
        status: 'online',
        firmware_version: 'v2.4.12-lts',
        ip_address: '192.168.1.189',
        metrics: {
          cpu_percent: parseFloat(cpu),
          gpu_percent: Math.floor(Math.random() * 20),
          memory_used_mb: parseInt(mem),
          memory_total_mb: 8192,
          temperature_c: parseFloat(temp),
          disk_used_gb: 42,
          uptime_seconds: ticks * 15
        }
      }
    };

    try {
      const hbRes = await fetch(`${serverUrl}/api/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${deviceToken}`
        },
        body: JSON.stringify(heartbeatPayload)
      });
      const hbData = await hbRes.json();
      if (hbRes.ok) {
        console.log(`${C_BLUE}[HEARTBEAT]${C_RESET} telemetry status reported: CPU ${cpu}% | Temp ${temp}°C | RAM ${mem}MB/8192MB`);
      } else {
        logWarn(`Heartbeat rejected: ${JSON.stringify(hbData)}`);
      }
    } catch (err) {
      logError('Failed to send heartbeat.', err.message);
    }
  }

  // Command Polling function
  async function pollCommands() {
    try {
      const cmdRes = await fetch(`${serverUrl}/api/events/commands`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${deviceToken}`
        }
      });
      const cmdData = await cmdRes.json();
      if (cmdRes.ok && cmdData.commands && cmdData.commands.length > 0) {
        for (const cmd of cmdData.commands) {
          console.log(`\n\x1b[45m\x1b[37m[COMMAND RECEIVED]${C_RESET} Execute action: ${C_BRIGHT}${cmd.command_type}${C_RESET}`);
          console.log(`   Payload: ${JSON.stringify(cmd.payload)}`);
          console.log('   Execution Status: Successful\n');
        }
      }
    } catch (err) {
      logError('Failed to poll commands.', err.message);
    }
  }

  // Attendance Event simulation
  async function simulateAttendanceEvent() {
    if (employeeRecords.length === 0) return;
    const randomProfile = employeeRecords[Math.floor(Math.random() * employeeRecords.length)];
    const direction = Math.random() > 0.5 ? 'in' : 'out';

    const eventPayload = {
      event_type: 'face.recognized',
      event_time: new Date().toISOString(),
      payload: {
        employee_code: randomProfile.code,
        employee_id: randomProfile.id,
        confidence: parseFloat((0.85 + Math.random() * 0.14).toFixed(4)),
        direction,
        photo_url: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?q=80&w=256&h=256&fit=crop'
      }
    };

    try {
      const evRes = await fetch(`${serverUrl}/api/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${deviceToken}`
        },
        body: JSON.stringify(eventPayload)
      });
      const evData = await evRes.json();
      if (evRes.ok) {
        console.log(`\x1b[42m\x1b[30m[BIOMETRIC EVENT]${C_RESET} Checked ${direction.toUpperCase()}: ${C_BRIGHT}${randomProfile.name}${C_RESET} (Code: ${randomProfile.code}) with ${Math.round(eventPayload.payload.confidence * 100)}% match confidence.`);
      } else {
        logWarn(`Biometric event rejected: ${JSON.stringify(evData)}`);
      }
    } catch (err) {
      logError('Failed to send biometric attendance event.', err.message);
    }
  }

  // Run initial heartbeat and poll
  await sendHeartbeat();
  await pollCommands();

  // Schedule intervals
  const hbInterval = setInterval(() => {
    ticks++;
    sendHeartbeat();
  }, 15000);

  const cmdInterval = setInterval(() => {
    pollCommands();
  }, 20000);

  const scanInterval = setInterval(() => {
    simulateAttendanceEvent();
  }, 30000);

  logSuccess('Edge Box active loop running. Press Ctrl+C to stop simulation.');
}

runSimulator();
