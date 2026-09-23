import { pool } from '../db/pool.js';

export const CATEGORY_MAP = {
  Attendance: ['attendance.%'],
  Enrollment: ['face.enroll%'],
  Employee:   ['employee.%'],
  User:       ['user.%'],
  Auth:       ['user.login%', 'user.logout%', 'security.%'],
  Security:   ['security.%'],
  HR:         ['dept.%', 'shift.%'],
  Roster:     ['roster.%'],
  Device:     ['nug.%', 'camera.%', 'building.%'],
  Settings:   ['settings.%'],
};

// prefix: 'a.' for the /audit query (aliased `FROM audit_log a`), '' for
// /audit/summary (queries `FROM audit_log` directly, unaliased) — the two
// original routes differed on exactly this, so the alias must stay a param
// rather than being hardcoded, or /audit/summary would emit invalid SQL
// referencing a nonexistent table alias "a".
function buildAuditWhere({ tenantId, siteId, userId, search, category, from, to, isSiteAdmin }, prefix = 'a.') {
  const whereClauses = [];
  const params = [];

  if (tenantId) {
    params.push(tenantId);
    whereClauses.push(`${prefix}tenant_id = $${params.length}`);
  }
  if (isSiteAdmin) {
    if (siteId) {
      params.push(siteId);
      whereClauses.push(`${prefix}site_id = $${params.length}`);
    } else {
      whereClauses.push(`${prefix}site_id IS NOT NULL`);
    }
    const roleCol = prefix ? `COALESCE(${prefix}user_role, u.role, '')` : `user_role`;
    const nameCol = prefix ? `COALESCE(${prefix}user_name, u.username, '')` : `user_name`;
    whereClauses.push(
      `LOWER(${roleCol}) NOT IN ('super_admin', 'superadmin', 'super admin', 'tenant_admin', 'tenant admin', 'admin', 'dev_user', 'dev user', 'dev', 'system', 'hr_manager', 'hr manager', 'hr')` +
      ` AND LOWER(${roleCol}) NOT LIKE '%super%'` +
      ` AND LOWER(${roleCol}) NOT LIKE '%tenant%'` +
      ` AND LOWER(${roleCol}) NOT LIKE '%dev%'` +
      ` AND LOWER(${nameCol}) NOT LIKE '%dev user%'` +
      ` AND LOWER(${nameCol}) NOT LIKE '%dev_user%'` +
      ` AND LOWER(${nameCol}) NOT LIKE '%super admin%'` +
      ` AND LOWER(${nameCol}) NOT LIKE '%tenant admin%'`
    );
  } else if (siteId) {
    params.push(siteId);
    whereClauses.push(`(${prefix}site_id = $${params.length} OR ${prefix}site_id IS NULL)`);
  }
  if (userId) {
    params.push(userId);
    whereClauses.push(`${prefix}fk_user_id = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    whereClauses.push(
      `(${prefix}action ILIKE $${params.length} OR ${prefix}details ILIKE $${params.length}` +
      ` OR COALESCE(${prefix}user_name,'') ILIKE $${params.length}` +
      ` OR COALESCE(${prefix}entity_name,'') ILIKE $${params.length}` +
      ` OR COALESCE(${prefix}ip_address,'') ILIKE $${params.length})`
    );
  }
  if (category && CATEGORY_MAP[category]) {
    const clauses = CATEGORY_MAP[category].map(p => {
      params.push(p);
      return `${prefix}action ILIKE $${params.length}`;
    });
    whereClauses.push(`(${clauses.join(' OR ')})`);
  }
  if (from) {
    params.push(from);
    whereClauses.push(`${prefix}created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    whereClauses.push(`${prefix}created_at <= $${params.length}::date + interval '1 day'`);
  }

  return { where: whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '', params };
}

export async function listAuditEntries({ tenantId, siteId, userId, search, category, from, to, limit, offset }) {
  const { where, params } = buildAuditWhere({ tenantId, siteId, userId, search, category, from, to });

  const { rows } = await pool.query(
    `SELECT
       a.pk_audit_id,
       a.action,
       a.details,
       a.ip_address,
       a.created_at,
       a.user_agent,
       a.method,
       a.entity_type,
       a.entity_id,
       a.entity_name,
       a.before_data,
       a.after_data,
       a.source,
       a.tenant_id,
       t.tenant_name,
       COALESCE(a.user_name, u.email, u.username) AS user_name,
       COALESCE(a.user_role, u.role)               AS user_role
     FROM audit_log a
     LEFT JOIN frs_user u   ON u.pk_user_id = a.fk_user_id
     LEFT JOIN frs_tenant t ON t.pk_tenant_id::text = a.tenant_id::text
     ${where}
     ORDER BY a.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  const countRes = await pool.query(
    `SELECT count(*)::int AS total FROM audit_log a ${where}`,
    params
  );

  return { rows, total: countRes.rows[0].total };
}

export async function getAuditCategorySummary({ tenantId, siteId, from, to }) {
  const { where, params } = buildAuditWhere({ tenantId, siteId, from, to }, '');

  const { rows } = await pool.query(`
    SELECT
      CASE
        WHEN action LIKE 'attendance.%' THEN 'Attendance'
        WHEN action LIKE 'face.enroll%' THEN 'Enrollment'
        WHEN action LIKE 'employee.%'   THEN 'Employee'
        WHEN action LIKE 'user.%'       THEN 'User'
        WHEN action LIKE 'user.login%' OR action LIKE 'user.logout%' OR action LIKE 'security.%' THEN 'Auth'
        WHEN action LIKE 'roster.%'     THEN 'Roster'
        WHEN action LIKE 'nug.%' OR action LIKE 'camera.%' OR action LIKE 'building.%' THEN 'Device'
        WHEN action LIKE 'settings.%'   THEN 'Settings'
        ELSE 'Other'
      END AS category,
      COUNT(*)::int AS count
    FROM audit_log
    ${where}
    GROUP BY category
    ORDER BY count DESC
  `, params);

  return rows;
}
