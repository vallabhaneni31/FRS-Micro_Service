import { pool } from '../src/db/pool.js';
import path from 'path';

const targetList = [
  { name: 'Meghana Battula', code: 'MLI1461', aws_id: '52' },
  { name: 'Sreeram Kaushik Nandagiri', code: 'MLI1654', aws_id: '55' },
  { name: 'Ramesh Mannepalli', code: 'MLI1494', aws_id: '57' },
  { name: 'Sri Charitha Thota', code: 'MLII45', aws_id: '54' },
  { name: 'Keshav Mundada', code: 'MLI1517', aws_id: '61' },
  { name: 'Sai Rushith Kaleru', code: 'MLI1518', aws_id: '62' },
  { name: 'Pavani Manne', code: 'MLI1527', aws_id: '64' },
  { name: 'Anjali Bypureddy', code: 'MLI1523', aws_id: '65' },
  { name: 'Gnana Venkata Prasuna Polakam', code: 'MLII60', aws_id: '66' },
  { name: 'Sarika Manikonda', code: 'MLI1490', aws_id: '67' },
  { name: 'Sekireddy Vasudha', code: 'MLII69', aws_id: '42' }
];

async function main() {
  console.log('Re-seeding correct device commands for target employees...');

  for (const user of targetList) {
    const dbEmpId = Number(user.aws_id);

    // 1. Find completed invitation in enrollment_invitations
    const { rows: invs } = await pool.query(
      `SELECT pk_invitation_id, photo_paths
       FROM enrollment_invitations
       WHERE fk_employee_id = $1 
         AND status = 'completed' 
         AND photo_paths IS NOT NULL
       ORDER BY completed_at DESC
       LIMIT 1`,
      [dbEmpId]
    );

    if (invs.length === 0) {
      console.warn(`⚠️ User: ${user.name} (DB ID: ${dbEmpId}) | No completed invitation with photo_paths found`);
      continue;
    }

    let photoPaths = invs[0].photo_paths;
    if (typeof photoPaths === 'string') {
      try { photoPaths = JSON.parse(photoPaths); } catch {}
    }

    const front = photoPaths.front || photoPaths.left || photoPaths.right || photoPaths.up || photoPaths.down;
    if (!front) {
      console.warn(`⚠️ User: ${user.name} | Completed invitation contains no front/fallback photo path`);
      continue;
    }

    const filename = path.basename(front);
    const baseUrl = process.env.PUBLIC_BASE_URL || 'https://frs.motivitylabs.com';
    const photoUrl = `${baseUrl}/uploads/remote-enrollment/${filename}`;

    // 2. Clean up any existing old/incorrect commands for this employee (matching either aws_id or code)
    await pool.query(
      `DELETE FROM device_commands
       WHERE device_code = 'jetson-09'
         AND command_type = 'enroll_from_photo'
         AND (
           payload->>'employee_id' = $1::text 
           OR payload->>'employee_code' = $2::text
           OR payload->>'employee_id' = $3::text
         )`,
      [user.aws_id, user.code, String(dbEmpId)]
    );

    // 3. Construct and insert the correct command payload
    const commandPayload = {
      employee_id: String(user.aws_id),
      employee_code: user.code,
      photo_url: photoUrl,
      angle: 'front'
    };

    await pool.query(
      `INSERT INTO device_commands (device_code, command_type, payload, status)
       VALUES ('jetson-09', 'enroll_from_photo', $1::jsonb, 'pending')`,
      [JSON.stringify(commandPayload)]
    );

    console.log(`✅ User: ${user.name} | Re-issued command: ${user.code} (AWS ID: ${user.aws_id}) -> ${filename}`);
  }

  console.log('Re-seeding completed successfully.');
}

main()
  .catch(console.error)
  .finally(async () => {
    await pool.end();
  });
