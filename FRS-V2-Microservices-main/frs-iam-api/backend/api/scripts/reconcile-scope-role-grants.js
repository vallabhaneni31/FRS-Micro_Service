// For every scope used as a "Chosen scope" in the crosswalk, computes the
// union of roles that had ANY legacy permission mapping to it (live
// ROLE_PERMISSIONS map) and INSERTs any missing (scope, role) grant into
// role_scope_mapping so migrating a route never silently drops a role's
// existing access.
//
// This only ever INSERTs — it never removes an existing grant. Roles that
// already had the scope granted (from the pre-existing 299-row design) but
// aren't backed by any legacy permission are left in place and reported
// separately as "gains to review", per the plan: preserve everyone's
// current access first, flag anything extra for a human decision later.
//
// Usage: node scripts/reconcile-scope-role-grants.js [--apply]
// Without --apply, prints the plan only (dry run).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import ExcelJS from 'exceljs';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_PATH = path.join(__dirname, '..', '..', '..', 'docs', 'api', 'Permission_Scope_Crosswalk.xlsx');
const APPLY = process.argv.includes('--apply');

function loadRolePermissions() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'authz.js'), 'utf8');
  const startIdx = src.indexOf('const ROLE_PERMISSIONS = {');
  const braceStart = src.indexOf('{', startIdx);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  // eslint-disable-next-line no-eval
  return eval('(' + src.slice(braceStart, i + 1) + ')');
}

async function main() {
  const ROLE_PERMISSIONS = loadRolePermissions();
  const ALL_ROLES = Object.keys(ROLE_PERMISSIONS);
  const rolesWithPermission = (perm) => ALL_ROLES.filter(r => (ROLE_PERMISSIONS[r] || []).includes(perm));

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE_PATH);
  const ws = wb.getWorksheet('Crosswalk');

  // scope -> Set(role) union across every permission that maps to it
  const targetRoles = {};
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const perm = row.getCell(5).value;
    const scope = row.getCell(8).value;
    const before = rolesWithPermission(perm);
    (targetRoles[scope] = targetRoles[scope] || new Set());
    before.forEach(r => targetRoles[scope].add(r));
  });

  const client = new pg.Client({
    host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  await client.connect();

  const { rows: existing } = await client.query(`
    select s.scope_code, rr.role_name
    from role_scope_mapping rsm
    join rbac_role rr on rr.pk_role_id_uuid = rsm.fk_role_id_rbac
    join scopes s on s.pk_scope_id = rsm.fk_scope_id
  `);
  const existingByScope = {};
  for (const { scope_code, role_name } of existing) {
    (existingByScope[scope_code] = existingByScope[scope_code] || new Set()).add(role_name);
  }

  const toInsert = []; // {scope, role}
  const gainsToReview = []; // {scope, roles: [...]}

  for (const [scope, wanted] of Object.entries(targetRoles)) {
    const have = existingByScope[scope] || new Set();
    for (const role of wanted) {
      if (!have.has(role)) toInsert.push({ scope, role });
    }
    const extras = [...have].filter(r => !wanted.has(r));
    if (extras.length) gainsToReview.push({ scope, roles: extras });
  }

  console.log(`${toInsert.length} missing (scope, role) grants to insert.`);
  console.log(`${gainsToReview.length} scopes have pre-existing grants not backed by any legacy permission (left as-is):`);
  gainsToReview.forEach(g => console.log(`  ${g.scope}: ${g.roles.join(', ')}`));
  console.log();

  if (!APPLY) {
    console.log('Dry run — pass --apply to actually insert. Sample of inserts:');
    toInsert.slice(0, 20).forEach(t => console.log(`  + ${t.scope} -> ${t.role}`));
    await client.end();
    return;
  }

  await client.query('BEGIN');
  try {
    for (const { scope, role } of toInsert) {
      await client.query(`
        INSERT INTO role_scope_mapping (fk_role_id, fk_role_id_rbac, fk_scope_id)
        SELECT r.pk_role_id, rr.pk_role_id_uuid, s.pk_scope_id
        FROM roles r, rbac_role rr, scopes s
        WHERE r.name = $1 AND rr.role_name = $1 AND s.scope_code = $2
        ON CONFLICT DO NOTHING
      `, [role, scope]);
    }
    await client.query('COMMIT');
    console.log(`Inserted ${toInsert.length} grants.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
