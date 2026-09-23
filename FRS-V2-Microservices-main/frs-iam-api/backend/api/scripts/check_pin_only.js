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
    const res = await pool.query(`
      SELECT activation_pin, used_at, expires_at 
      FROM device_activation_code 
      WHERE activation_pin = '441-312'
    `);
    
    if (res.rows.length === 0) {
      console.log('PIN_NOT_FOUND');
    } else {
      const row = res.rows[0];
      if (row.used_at) {
        console.log(`PIN_USED_AT:${row.used_at.toISOString()}`);
      } else {
        console.log('PIN_PENDING');
      }
    }
  } catch (err) {
    console.log(`DB_ERROR:${err.message}`);
  } finally {
    await pool.end();
  }
}

main();
