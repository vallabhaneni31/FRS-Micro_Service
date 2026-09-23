import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env.retail.local') });
dotenv.config({ path: path.resolve(__dirname, '../../.env.retail') });

const { Pool } = pg;

if (!process.env.RETAIL_DB_URL) {
  throw new Error('[FATAL] RETAIL_DB_URL is required — set it in .env.retail (no fallback default).');
}
if (!process.env.FRS_DB_URL) {
  throw new Error('[FATAL] FRS_DB_URL is required — set it in .env.retail (no fallback default).');
}

export const pool = new Pool({
  connectionString: process.env.RETAIL_DB_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[retail-db] Unexpected pool error', err.message);
});

// Read-only connection to the main FRS DB for cross-DB user/tenant lookups
export const frsPool = new Pool({
  connectionString: process.env.FRS_DB_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

frsPool.on('error', (err) => {
  console.error('[frs-db] Unexpected pool error', err.message);
});
