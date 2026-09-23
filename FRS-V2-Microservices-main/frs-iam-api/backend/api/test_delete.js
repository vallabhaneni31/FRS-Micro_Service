import { pool } from './src/db/pool.js';
import express from 'express';
import siteRoutes from './src/routes/siteManagementRoutes.js';
import request from 'supertest';

const app = express();
app.use(express.json());

// Mock requireAuth and requirePermission middleware
app.use((req, res, next) => {
  req.auth = {
    scope: { tenantId: '11111111-1111-1111-1111-111111111111' }, // Dummy tenant
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

  try {
    // 1. Insert dummy customer
    const custRes = await client.query(`
      INSERT INTO frs_customer (customer_name, fk_tenant_id)
      VALUES ('Test Customer', '11111111-1111-1111-1111-111111111111')
      RETURNING pk_customer_id
    `);
    customerId = custRes.rows[0].pk_customer_id;

    // 2. Insert dummy site
    const siteRes = await client.query(`
      INSERT INTO frs_site (site_name, fk_customer_id, city, country, status)
      VALUES ('Test Delete Site', $1, 'Test City', 'Test Country', 'active')
      RETURNING pk_site_id
    `, [customerId]);
    siteId = siteRes.rows[0].pk_site_id;

    // 3. Insert dummy floor dependency
    const floorRes = await client.query(`
      INSERT INTO frs_floor (floor_name, fk_site_id, floor_level, created_by_user_id)
      VALUES ('Test Floor', $1, 1, 1)
      RETURNING pk_floor_id
    `, [siteId]);
    floorId = floorRes.rows[0].pk_floor_id;

    // 4. Hit the DELETE endpoint
    const res = await request(app)
      .delete(`/api/site-management/sites/${siteId}`)
      .send();

    console.log('Status Code:', res.statusCode);
    console.log('Response Body:', res.body);

    if (res.statusCode === 409 && res.body.error && res.body.error.includes('floors')) {
      console.log('✅ TEST PASSED: Returned 409 Conflict with proper message');
    } else {
      console.error('❌ TEST FAILED');
    }

  } catch (err) {
    console.error(err);
  } finally {
    // Clean up
    if (floorId) await client.query('DELETE FROM frs_floor WHERE pk_floor_id = $1', [floorId]);
    if (siteId) await client.query('DELETE FROM frs_site WHERE pk_site_id = $1', [siteId]);
    if (customerId) await client.query('DELETE FROM frs_customer WHERE pk_customer_id = $1', [customerId]);
    client.release();
    pool.end();
  }
}

run();
