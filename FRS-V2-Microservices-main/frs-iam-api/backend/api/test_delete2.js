import { pool } from './src/db/pool.js';
import siteRoutes from './src/routes/siteManagementRoutes.js';

// Get the delete handler function from the router
// The router is an express router which has stack array
const deleteLayer = siteRoutes.stack.find(layer => layer.route && layer.route.path === '/sites/:siteId' && layer.route.methods.delete);
const deleteHandler = deleteLayer.route.stack.find(layer => layer.name === 'asyncUtilWrap').handle;

async function run() {
  const client = await pool.connect();
  let siteId;
  let customerId;
  let floorId;

  try {
    const custRes = await client.query(`
      INSERT INTO frs_customer (customer_name, fk_tenant_id)
      VALUES ('Test Customer 2', '22222222-2222-2222-2222-222222222222')
      RETURNING pk_customer_id
    `);
    customerId = custRes.rows[0].pk_customer_id;

    const siteRes = await client.query(`
      INSERT INTO frs_site (site_name, fk_customer_id, city, country, status)
      VALUES ('Test Delete Site 2', $1, 'Test City', 'Test Country', 'active')
      RETURNING pk_site_id
    `, [customerId]);
    siteId = siteRes.rows[0].pk_site_id;

    const floorRes = await client.query(`
      INSERT INTO frs_floor (floor_name, fk_site_id, floor_level, created_by_user_id)
      VALUES ('Test Floor', $1, 1, 1)
      RETURNING pk_floor_id
    `, [siteId]);
    floorId = floorRes.rows[0].pk_floor_id;

    // Mock Express Request and Response
    const req = {
      params: { siteId },
      auth: {
        scope: { tenantId: '22222222-2222-2222-2222-222222222222' },
        memberships: []
      },
      headers: {}
    };

    const res = {
      status: function(code) {
        this.statusCode = code;
        return this;
      },
      json: function(data) {
        this.body = data;
        return this;
      }
    };

    console.log('Executing handler...');
    await deleteHandler(req, res, () => {});

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
    if (floorId) await client.query('DELETE FROM frs_floor WHERE pk_floor_id = $1', [floorId]);
    if (siteId) await client.query('DELETE FROM frs_site WHERE pk_site_id = $1', [siteId]);
    if (customerId) await client.query('DELETE FROM frs_customer WHERE pk_customer_id = $1', [customerId]);
    client.release();
    pool.end();
  }
}

run();
