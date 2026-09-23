import { query } from '../db/pool.js';
import process from 'process';

async function getEmp() {
  try {
    const res = await query('SELECT full_name, employee_code FROM hr_employee WHERE pk_employee_id = 12');
    console.log(res.rows);
  } catch (err) {
    console.error(err);
  }
  process.exit();
}

getEmp();
