import pg from 'pg';

const { Pool } = pg;

// Read/write connection to the retail vertical's separate database
// (retail_intelligence), used only for the handful of cross-vertical
// touchpoints where the corporate backend needs to know about retail_users
// accounts (e.g. forgot-password, which has no visibility into frs_user for
// retail-only accounts otherwise). Most retail logic lives in
// backend/api-retail and should keep using its own pool — this exists
// specifically so backend/api doesn't need a network hop for a single query.
export const retailPool = process.env.RETAIL_DB_URL
  ? new Pool({
      connectionString: process.env.RETAIL_DB_URL,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    })
  : null;

retailPool?.on('error', (err) => {
  console.error('[retail-db] Unexpected pool error', err.message);
});
