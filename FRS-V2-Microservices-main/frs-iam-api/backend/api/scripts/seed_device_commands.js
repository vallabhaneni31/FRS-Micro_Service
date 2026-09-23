import { pool } from '../src/db/pool.js';
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
  console.log('Seeding device_commands for target employees...');

  // Ensure table exists (precautionary check)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.device_commands (
      id           SERIAL PRIMARY KEY,
      device_code  VARCHAR,
      command_type VARCHAR,
      payload      JSONB,
      status       VARCHAR DEFAULT 'pending',
      created_at   TIMESTAMP DEFAULT NOW()
    );
  `);

  for (const user of userList) {
    // 1. Find the database employee matching the name
    const { rows: emps } = await pool.query(
      `SELECT pk_employee_id, employee_code, full_name 
       FROM hr_employee 
       WHERE full_name ILIKE $1`,
      [`%${user.name}%`]
    );

    if (emps.length === 0) {
      console.warn(`User: ${user.name} | NOT FOUND in hr_employee`);
      continue;
    }

    const dbEmp = emps[0];

    // 2. Find completed invitation in enrollment_invitations
    const { rows: invs } = await pool.query(
      `SELECT pk_invitation_id, photo_paths
       FROM enrollment_invitations
       WHERE fk_employee_id = $1 
         AND status = 'completed' 
         AND photo_paths IS NOT NULL
       ORDER BY completed_at DESC
       LIMIT 1`,
      [dbEmp.pk_employee_id]
    );

    if (invs.length === 0) {
      console.warn(`User: ${user.name} | No completed invitation with photo_paths found`);
      continue;
    }

    let photoPaths = invs[0].photo_paths;
    if (typeof photoPaths === 'string') {
      try { photoPaths = JSON.parse(photoPaths); } catch {}
    }

    const front = photoPaths.front || photoPaths.left || photoPaths.right || photoPaths.up || photoPaths.down;
    if (!front) {
      console.warn(`User: ${user.name} | Completed invitation contains no front/fallback photo path`);
      continue;
    }

    const filename = path.basename(front);
    const baseUrl = process.env.PUBLIC_BASE_URL || 'https://frs.motivitylabs.com';
    const photoUrl = `${baseUrl}/uploads/remote-enrollment/${filename}`;

    // 3. Insert command into device_commands
    const commandPayload = {
      employee_id: String(user.aws_id),
      employee_code: user.code,
      photo_url: photoUrl,
      angle: 'front'
    };

    // Insert only if not already enqueued (prevent double seeding)
    const { rows: existing } = await pool.query(
      `SELECT id FROM device_commands
       WHERE device_code = 'jetson-09'
         AND command_type = 'enroll_from_photo'
         AND (payload->>'employee_id' = $1::text OR payload->>'employee_code' = $2::text)
         AND status = 'pending'
       LIMIT 1`,
      [String(user.aws_id), user.code]
    );

    if (existing.length === 0) {
      await pool.query(
        `INSERT INTO device_commands (device_code, command_type, payload, status)
         VALUES ('jetson-09', 'enroll_from_photo', $1::jsonb, 'pending')`,
        [JSON.stringify(commandPayload)]
      );
      console.log(`User: ${user.name} | Enqueued command: ${user.code} (AWS ID: ${user.aws_id}) -> ${filename}`);
    } else {
      console.log(`User: ${user.name} | Command already pending — skipping`);
    }
  }

  console.log('Seeding completed successfully.');
}

main()
  .catch(console.error)
  .finally(async () => {
    await pool.end();
  });
