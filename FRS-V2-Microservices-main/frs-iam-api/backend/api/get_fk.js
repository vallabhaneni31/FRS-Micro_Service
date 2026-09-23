import { pool } from './src/db/pool.js';
async function run() {
  const query = `
    SELECT pg_get_constraintdef(c.oid) AS constraint_def
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE c.conname = 'user_role_fk_site_id_fkey' AND t.relname = 'user_role';
  `;
  try {
    const res = await pool.query(query);
    console.log(res.rows);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
run();
