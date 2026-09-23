import { pool } from '../db/pool.js';

export async function listActiveTenantTypes() {
  const result = await pool.query(`
    SELECT
      pk_plan_id            AS id,
      name,
      description,
      features,
      vertical
    FROM subscription_plans
    WHERE is_active = true
    ORDER BY vertical ASC, base_price ASC NULLS LAST
  `);
  return result.rows;
}

export async function findTenantTypeByName(client, name) {
  const result = await client.query(
    'SELECT pk_plan_id AS id, is_active FROM subscription_plans WHERE name = $1', [name]
  );
  return result.rows[0] ?? null;
}

export async function reactivateTenantType(client, id, { name, description, features, vertical }) {
  const result = await client.query(
    `UPDATE subscription_plans SET
       name        = $1,
       description = $2,
       features    = $3::jsonb,
       vertical    = $4,
       is_active   = true
     WHERE pk_plan_id = $5
     RETURNING pk_plan_id AS id, name, description, features, vertical`,
    [name, description ?? null, JSON.stringify(features), vertical || 'corporate', id]
  );
  return result.rows[0];
}

export async function createTenantType(client, { name, description, features, vertical }) {
  const result = await client.query(
    `INSERT INTO subscription_plans (name, description, features, is_active, plan_type, vertical)
     VALUES ($1, $2, $3::jsonb, true, 'enterprise', $4) RETURNING pk_plan_id AS id, name, description, features, vertical`,
    [name, description ?? null, JSON.stringify(features), vertical || 'corporate']
  );
  return result.rows[0];
}

export async function updateTenantType(id, { name, description, features, vertical }) {
  const result = await pool.query(
    `UPDATE subscription_plans SET
       name        = COALESCE($1, name),
       description = COALESCE($2, description),
       features    = COALESCE($3::jsonb, features),
       vertical    = COALESCE($4, vertical)
     WHERE pk_plan_id = $5
     RETURNING pk_plan_id AS id, name, description, features, vertical`,
    [name?.trim() ?? null, description ?? null, features ? JSON.stringify(features) : null, vertical ?? null, id]
  );
  return result.rows[0] ?? null;
}

export async function countActiveSubscriptionsForPlan(planId) {
  const result = await pool.query(
    "SELECT COUNT(*) FROM tenant_subscriptions WHERE fk_plan_id = $1 AND status = 'active'", [planId]
  );
  return parseInt(result.rows[0].count, 10);
}

export async function deactivateTenantType(id) {
  const result = await pool.query(
    'UPDATE subscription_plans SET is_active = false WHERE pk_plan_id = $1 RETURNING pk_plan_id', [id]
  );
  return result.rows[0] ?? null;
}

export async function getPlanById(client, planId) {
  const result = await client.query(
    `SELECT name, features, vertical FROM subscription_plans WHERE pk_plan_id = $1`,
    [planId]
  );
  return result.rows[0] ?? null;
}

export async function findLegacyTenantTypeIdByName(client, lookupName) {
  const result = await client.query(
    `SELECT pk_tenant_type_id FROM tenant_type WHERE LOWER(type_name) = $1 LIMIT 1`,
    [lookupName]
  );
  return result.rows[0]?.pk_tenant_type_id ?? null;
}
