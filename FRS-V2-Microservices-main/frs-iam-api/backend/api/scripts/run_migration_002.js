import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../src/db/pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const migrations = [
  { file: "002_device_zone_type.sql", label: "device zone_type" },
  { file: "002_visitor_unknown_schema.sql", label: "Visitor & Unknown Person schema" },
];

async function main() {
  for (const { file, label } of migrations) {
    const sqlPath = path.resolve(__dirname, `../src/db/migrations/${file}`);
    console.log(`Running migration from: ${sqlPath}`);
    const sql = await fs.readFile(sqlPath, "utf8");
    await pool.query(sql);
    console.log(`Migration 002 (${label}) executed successfully!`);
  }
}

main()
  .catch((err) => {
    console.error("Migration 002 failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
