import { pool } from './src/db/pool.js';
async function run() {
  const query = `
    SELECT t.relname AS table_name, c.conname AS constraint_name, 
           CASE c.confdeltype 
             WHEN 'a' THEN 'NO ACTION'
             WHEN 'r' THEN 'RESTRICT'
             WHEN 'c' THEN 'CASCADE'
             WHEN 'n' THEN 'SET NULL'
             WHEN 'd' THEN 'SET DEFAULT'
           END AS on_delete
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE c.confrelid = (SELECT oid FROM pg_class WHERE relname = 'frs_site')
      AND c.contype = 'f';
  `;
  try {
    const res = await pool.query(query);
    console.table(res.rows);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
run();
