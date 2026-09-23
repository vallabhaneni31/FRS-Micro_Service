import { pool } from './src/db/pool.js';
async function run() {
  const query = `
    SELECT indexdef 
    FROM pg_indexes 
    WHERE indexname = 'uq_user_role_global';
  `;
  try {
    const res = await pool.query(query);
    console.log("uq_user_role_global", res.rows);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
run();
