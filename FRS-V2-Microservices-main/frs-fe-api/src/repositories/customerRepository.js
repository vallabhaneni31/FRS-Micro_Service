import { pool } from '../db/pool.js';

export async function listCustomers(tenantId) {
  let query = `
    SELECT
      c.pk_customer_id                    AS id,
      c.customer_name                     AS name,
      c.fk_tenant_id                      AS "tenantId",
      t.tenant_name                       AS "tenantName",
      COUNT(DISTINCT s.pk_site_id)::int   AS site_count
    FROM frs_customer c
    JOIN  frs_tenant t ON t.pk_tenant_id      = c.fk_tenant_id
    LEFT JOIN frs_site s ON s.fk_customer_id  = c.pk_customer_id AND s.status = 'active'
  `;
  const params = [];
  if (tenantId) {
    query += ' WHERE c.fk_tenant_id = $1';
    params.push(tenantId);
  }
  query += ' GROUP BY c.pk_customer_id, c.customer_name, c.fk_tenant_id, t.tenant_name ORDER BY t.tenant_name, c.customer_name';

  const result = await pool.query(query, params);
  return result.rows;
}

export async function tenantExists(tenantId) {
  const result = await pool.query('SELECT pk_tenant_id FROM frs_tenant WHERE pk_tenant_id = $1', [tenantId]);
  return result.rows.length > 0;
}

export async function createCustomer({ name, tenantId }) {
  const result = await pool.query(
    `INSERT INTO frs_customer (customer_name, fk_tenant_id)
     VALUES ($1, $2)
     RETURNING pk_customer_id AS id, customer_name AS name, fk_tenant_id AS "tenantId"`,
    [name, tenantId]
  );
  return result.rows[0];
}

export async function updateCustomer(id, name) {
  const result = await pool.query(
    `UPDATE frs_customer SET customer_name = $1
     WHERE pk_customer_id = $2
     RETURNING pk_customer_id AS id, customer_name AS name, fk_tenant_id AS "tenantId"`,
    [name, id]
  );
  return result.rows[0] ?? null;
}

export async function countSitesForCustomer(customerId) {
  const result = await pool.query(
    'SELECT COUNT(*) FROM frs_site WHERE fk_customer_id = $1',
    [customerId]
  );
  return parseInt(result.rows[0].count, 10);
}

export async function deleteCustomer(id) {
  const result = await pool.query(
    'DELETE FROM frs_customer WHERE pk_customer_id = $1 RETURNING pk_customer_id',
    [id]
  );
  return result.rows[0] ?? null;
}
