import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: 'backend/api/.env' });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  const { rows } = await pool.query(`
    SELECT 
      count(*) as total_tenant_emps,
      count(*) FILTER (WHERE site_ids IS NULL OR cardinality(site_ids) = 0) as unassigned_emps,
      count(*) FILTER (WHERE 14 = ANY(site_ids)) as ivis_emps,
      count(*) FILTER (WHERE 15 = ANY(site_ids)) as scanalitix_emps
    FROM hr_employee
    WHERE tenant_id = 'e7a57fa8-3010-44ec-9e90-c11dfaf29c54' -- Or we just check all
  `);
  console.log("Stats:", rows[0]);
  process.exit(0);
}
check();
