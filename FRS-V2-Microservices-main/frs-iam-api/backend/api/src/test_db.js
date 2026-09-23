import { pool } from './db/pool.js';
async function test() {
  const { rows } = await pool.query(`SELECT checkin_photo_url, all_check_ins FROM attendance_record LIMIT 2`);
  console.log(rows);
  process.exit(0);
}
test();
