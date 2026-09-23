import { pool } from "../src/db/pool.js";

async function main() {
  console.log("Removing 'sites' navigation item for super_admin...");
  const res = await pool.query(
    "DELETE FROM nav_item WHERE role_name = 'super_admin' AND item_key = 'sites'"
  );
  console.log("Successfully removed 'sites' navigation item. Rows deleted:", res.rowCount);
}

main()
  .catch((err) => {
    console.error("Failed to remove 'sites' navigation item:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
