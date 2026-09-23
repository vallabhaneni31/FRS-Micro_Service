import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../src/db/pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, "../src/db/migrations");
const schemaFile = path.join(migrationsDir, "schema.sql");

async function run() {
  // Idempotent — apply base schema.sql if database is uninitialized
  const check = await pool.query(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenant_realm')"
  );
  if (!check.rows[0].exists) {
    const raw = await fs.readFile(schemaFile, "utf8");

    // Strip psql metacommands (lines starting with \) — pg_dump artifacts
    // that node-postgres cannot send to the server.
    const sql = raw
      .split("\n")
      .filter((line) => !/^\s*\\/.test(line))
      .join("\n");

    console.log(`Applying consolidated schema from schema.sql …`);
    await pool.query(sql);
    console.log("Schema applied successfully.");
  } else {
    console.log("Base schema already present.");
  }

  // Apply incremental migrations in numerical order
  const files = await fs.readdir(migrationsDir);
  const migrationFiles = files
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort();

  for (const file of migrationFiles) {
    try {
      const filePath = path.join(migrationsDir, file);
      const content = await fs.readFile(filePath, "utf8");
      const sql = content
        .split("\n")
        .filter((line) => !/^\s*\\/.test(line))
        .join("\n");

      if (sql.trim().length > 0) {
        await pool.query(sql);
        console.log(`Applied migration ${file}`);
      }
    } catch (err) {
      console.warn(`Migration ${file} skipped or notice:`, err.message);
    }
  }
}

run()
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

