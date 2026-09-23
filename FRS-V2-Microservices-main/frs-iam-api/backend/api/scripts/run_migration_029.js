import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../src/db/pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const sqlPath = path.resolve(__dirname, "../src/db/migrations/029_vlm_quality_gate_columns.sql");
  console.log(`Running migration from: ${sqlPath}`);
  const sql = await fs.readFile(sqlPath, "utf8");
  await pool.query(sql);
  console.log("Migration 029 executed successfully!");
}

main()
  .catch((err) => {
    console.error("Migration 029 failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
