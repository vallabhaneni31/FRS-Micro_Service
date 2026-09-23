import { query } from '../db/pool.js';
import process from 'process';

async function printEmployees() {
  try {
    const res = await query('SELECT pk_employee_id, employee_code, full_name, email FROM hr_employee ORDER BY full_name');
    console.table(res.rows);

    const res2 = await query('SELECT employee_id, photo_path FROM employee_face_embeddings WHERE photo_path IS NOT NULL');
    console.table(res2.rows.slice(0, 50));
  } catch (err) {
    console.error(err);
  }
  process.exit();
}

printEmployees();
