import { pool } from './src/db/pool.js';
import siteRoutes from './src/routes/siteManagementRoutes.js';
import express from 'express';

const app = express();
app.use(express.json());

// Mock requireAuth and requirePermission middleware
app.use((req, res, next) => {
  req.auth = {
    scope: { tenantId: '22222222-2222-2222-2222-222222222222' },
    memberships: []
  };
  next();
});

app.use('/api/site-management', siteRoutes);

async function run() {
  const client = await pool.connect();
  let siteId;
  let customerId;
  let floorId;
  let server;

  try {
    const custRes = await client.query(`
      INSERT INTO frs_customer (customer_name, fk_tenant_id)
      VALUES ('Test Customer 3', '22222222-2222-2222-2222-222222222222')
      RETURNING pk_customer_id
    `);
    customerId = custRes.rows[0].pk_customer_id;

    const siteRes = await client.query(`
      INSERT INTO frs_site (site_name, fk_customer_id, city, country, status)
      VALUES ('Test Delete Site 3', $1, 'Test City', 'Test Country', 'active')
      RETURNING pk_site_id
    `, [customerId]);
    siteId = siteRes.rows[0].pk_site_id;

    const floorRes = await client.query(`
      INSERT INTO frs_floor (floor_name, fk_site_id, floor_level, created_by_user_id)
      VALUES ('Test Floor', $1, 1, 1)
      RETURNING pk_floor_id
    `, [siteId]);
    floorId = floorRes.rows[0].pk_floor_id;

    server = app.listen(8081, async () => {
      console.log('Test server running on port 8081');
      
      const response = await fetch(`http://localhost:8081/api/site-management/sites/${siteId}`, {
        method: 'DELETE'
      });
      
      const statusCode = response.status;
      const body = await response.json();
      
      console.log('Status Code:', statusCode);
      console.log('Response Body:', body);

      if (statusCode === 409 && body.error && body.error.includes('floors')) {
        console.log('✅ TEST PASSED: Returned 409 Conflict with proper message');
      } else {
        console.error('❌ TEST FAILED');
      }
      
      // Cleanup and exit
      server.close();
      if (floorId) await client.query('DELETE FROM frs_floor WHERE pk_floor_id = $1', [floorId]);
      if (siteId) await client.query('DELETE FROM frs_site WHERE pk_site_id = $1', [siteId]);
      if (customerId) await client.query('DELETE FROM frs_customer WHERE pk_customer_id = $1', [customerId]);
      client.release();
      pool.end();
    });

  } catch (err) {
    console.error(err);
    if (server) server.close();
    client.release();
    pool.end();
  }
}

run();
