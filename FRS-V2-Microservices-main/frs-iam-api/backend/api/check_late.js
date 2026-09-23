import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config({ path: 'backend/api/.env' });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function run() {
  const { rows } = await pool.query("SELECT pk_attendance_id, status, is_late FROM attendance_record WHERE status ILIKE 'late' OR is_late = true LIMIT 10;");
  console.log("Late records:", rows);
  process.exit(0);
}
run();
