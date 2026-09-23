import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../src/db/pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const migrations = [
  { file: "003_employee_site_ids.sql", label: "employee site_ids" },
  { file: "003_visitor_enrollment_invitation.sql", label: "Visitor enrollment invitation schema" },
];

async function main() {
  for (const { file, label } of migrations) {
    const sqlPath = path.resolve(__dirname, `../src/db/migrations/${file}`);
    console.log(`Running migration from: ${sqlPath}`);
    const sql = await fs.readFile(sqlPath, "utf8");
    await pool.query(sql);
    console.log(`Migration 003 (${label}) executed successfully!`);
  }
}

main()
  .catch((err) => {
    console.error("Migration 003 failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
