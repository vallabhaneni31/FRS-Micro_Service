import { pool } from "../src/db/pool.js";

async function run() {
  console.log("Altering subscription_plans_vertical_check constraint...");
  await pool.query(`
    ALTER TABLE subscription_plans 
    DROP CONSTRAINT IF EXISTS subscription_plans_vertical_check;
    
    ALTER TABLE subscription_plans
    ADD CONSTRAINT subscription_plans_vertical_check
    CHECK (vertical IN ('corporate', 'education', 'retail', 'transport'));
  `);
  console.log("Constraint altered successfully.");

  console.log("Updating 'College' vertical to 'education'...");
  const result = await pool.query(`
    UPDATE subscription_plans 
    SET vertical = 'education' 
    WHERE name ILIKE 'College' OR name ILIKE '%college%';
  `);
  console.log(`Updated ${result.rowCount} row(s).`);
}

run()
  .catch((err) => {
    console.error("Failed to alter constraint:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
