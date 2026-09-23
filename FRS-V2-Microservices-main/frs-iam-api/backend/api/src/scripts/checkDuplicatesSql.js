import { query } from '../db/pool.js';
import process from 'process';

async function runQueries() {
  try {
    const res = await query(`
      SELECT e1.employee_id as emp1, e2.employee_id as emp2, e1.photo_path
      FROM employee_face_embeddings e1
      JOIN employee_face_embeddings e2 ON e1.photo_path = e2.photo_path
      WHERE e1.employee_id < e2.employee_id AND e1.photo_path IS NOT NULL
    `);
    console.log('Duplicates by photo path:', res.rows);
    
    const res2 = await query(`
      SELECT employee_id, COUNT(*)
      FROM employee_face_embeddings
      GROUP BY employee_id
      HAVING COUNT(*) > 10
    `);
    console.log('Employees with >10 embeddings:', res2.rows);

    const res3 = await query(`
      SELECT e1.employee_id as emp1, e2.employee_id as emp2
      FROM employee_face_embeddings e1
      JOIN employee_face_embeddings e2 ON e1.embedding::text = e2.embedding::text
      WHERE e1.employee_id < e2.employee_id
    `);
    console.log('Exact duplicate embeddings:', res3.rows);

    const res4 = await query(`
      SELECT full_name, employee_code, count(*)
      FROM hr_employee
      GROUP BY full_name, employee_code
      HAVING count(*) > 1
    `);
    console.log('Duplicate employee records:', res4.rows);

    // Let's check duplicate full_names (same person registered under different names? Wait, maybe same name, different employee code)
    const res5 = await query(`
      SELECT full_name, array_agg(employee_code) as codes
      FROM hr_employee
      GROUP BY full_name
      HAVING count(*) > 1
    `);
    console.log('Employees with same name but multiple codes:', res5.rows);

  } catch (err) {
    console.error(err);
  }
  process.exit();
}

runQueries();
