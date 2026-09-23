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
    console.log('=== Database Diagnostic ===');
    
    // Check tenants
    const tenants = await pool.query('SELECT pk_tenant_id, tenant_name FROM frs_tenant');
    console.log('\nTenants:');
    tenants.rows.forEach(t => console.log(` - ID: ${t.pk_tenant_id} | Name: ${t.tenant_name}`));

    // Check customers
    const customers = await pool.query('SELECT pk_customer_id, customer_name, fk_tenant_id FROM frs_customer');
    console.log('\nCustomers:');
    customers.rows.forEach(c => console.log(` - ID: ${c.pk_customer_id} | Name: ${c.customer_name} | Tenant ID: ${c.fk_tenant_id}`));

    // Check user memberships
    const userRes = await pool.query('SELECT pk_user_id, username, role FROM frs_user');
    console.log('\nUsers:');
    for (const u of userRes.rows) {
      console.log(` - ID: ${u.pk_user_id} | Username: ${u.username} | Role: ${u.role}`);
    }

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

main();
