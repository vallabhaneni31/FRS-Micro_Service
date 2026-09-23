import { pool } from "../src/db/pool.js";

const { rows } = await pool.query(
  "SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND column_name LIKE $2",
  ["visitor_buffer", "vlm_%"]
);
console.log(rows);
await pool.end();
