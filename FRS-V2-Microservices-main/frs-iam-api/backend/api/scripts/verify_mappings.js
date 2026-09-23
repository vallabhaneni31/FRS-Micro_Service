import { query } from '../src/db/pool.js';
import path from 'path';

const userList = [
  { name: 'Pavani Manne', code: 'MLII70', aws_id: 62 },
  { name: 'Meghana Battula', code: 'MLII71', aws_id: 63 },
  { name: 'Sarika Manikonda', code: 'MLII72', aws_id: 64 },
  { name: 'Ramesh Mannepalli', code: 'MLII73', aws_id: 65 },
  { name: 'Keshav Mundada', code: 'MLII74', aws_id: 66 },
  { name: 'Sai Rushith Kaleru', code: 'MLII75', aws_id: 67 },
  { name: 'Anjali Bypureddy', code: 'MLII76', aws_id: 68 },
  { name: 'Sreeram Kaushik Nandagiri', code: 'MLII77', aws_id: 69 },
  { name: 'Sri Charitha Thota', code: 'MLII79', aws_id: 71 },
  { name: 'Gnana Venkata Prasuna Polakam', code: 'MLII80', aws_id: 72 },
  { name: 'Sekireddy Vasudha', code: 'MLII81', aws_id: 73 },
  { name: 'Sai Santosh Suroju Hom', code: 'MLII83', aws_id: 75 },
  { name: 'Kalyan Bapanapalli', code: 'MLII85', aws_id: 77 },
  { name: 'Vasavisritha Bikkumalla', code: 'MLII88', aws_id: 80 },
  { name: 'Satvika Gadepalli', code: 'MLII89', aws_id: 81 }
];

async function main() {
  console.log('Verifying mappings filtering for completed invitations with photos...');
  for (const user of userList) {
    const { rows: emps } = await query(
      `SELECT pk_employee_id, employee_code, full_name 
       FROM hr_employee 
       WHERE full_name ILIKE $1`,
      [`%${user.name}%`]
    );
    if (emps.length === 0) {
      console.log(`User: ${user.name} | hr_employee NOT FOUND`);
      continue;
    }
    const dbEmp = emps[0];
    const { rows: invs } = await query(
      `SELECT pk_invitation_id, photo_paths, status
       FROM enrollment_invitations
       WHERE fk_employee_id = $1 AND status = 'completed' AND photo_paths IS NOT NULL
       ORDER BY completed_at DESC`,
      [dbEmp.pk_employee_id]
    );
    
    let photo = 'NOT FOUND';
    if (invs.length > 0) {
      let paths = invs[0].photo_paths;
      if (typeof paths === 'string') {
        try { paths = JSON.parse(paths); } catch {}
      }
      const front = paths.front || paths.left || paths.right || paths.up || paths.down;
      if (front) {
        photo = path.basename(front);
      }
    }
    console.log(`User: ${user.name} | DB Name: ${dbEmp.full_name} | DB ID: ${dbEmp.pk_employee_id} | DB Code: ${dbEmp.employee_code} | Photo: ${photo}`);
  }
}

main().catch(console.error);
