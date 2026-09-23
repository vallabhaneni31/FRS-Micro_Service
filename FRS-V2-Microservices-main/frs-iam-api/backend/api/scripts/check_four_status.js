import { pool } from "../src/db/pool.js";

async function checkFour() {
  try {
    const codes = ["MLII45", "MLII60", "MLI1494", "MLII71"];

    const { rows: queue } = await pool.query(
      `SELECT 
         pk_command_id,
         device_id,
         status,
         created_at,
         executed_at,
         command_payload->>'employee_code' as employee_code,
         command_payload->>'full_name' as name,
         command_payload->>'angle' as angle,
         result_payload
       FROM device_command_queue
       WHERE command_type = 'enroll_from_photo'
         AND command_payload->>'employee_code' = ANY($1::text[])
       ORDER BY employee_code, pk_command_id DESC`,
      [codes]
    );

    console.log("=== QUEUE STATUS FOR THE 4 EMPLOYEES ===");
    console.table(queue);

    // Let's also check if they have any embeddings already
    const { rows: embeddings } = await pool.query(
      `SELECT 
         e.employee_code,
         e.full_name,
         efe.angle,
         efe.model_version,
         efe.enrolled_at
       FROM employee_face_embeddings efe
       JOIN hr_employee e ON e.pk_employee_id = efe.employee_id
       WHERE e.employee_code = ANY($1::text[])
       ORDER BY e.employee_code, efe.angle`,
      [codes]
    );

    console.log("\n=== EMBEDDINGS CURRENTLY IN DATABASE ===");
    console.table(embeddings);

  } catch (error) {
    console.error(error);
  } finally {
    await pool.end();
  }
}

checkFour();
