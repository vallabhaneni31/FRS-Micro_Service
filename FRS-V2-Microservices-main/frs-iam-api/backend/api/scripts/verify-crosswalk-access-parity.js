// For every resolved row in the crosswalk, compares "which roles have the
// legacy permission today (live ROLE_PERMISSIONS map, Keycloak mode)" against
// "which roles would get the chosen scope (role_scope_mapping)". Flags any
// mismatch so Phase 2 doesn't silently expand or contract access per route.
//
// Usage: node scripts/verify-crosswalk-access-parity.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import ExcelJS from 'exceljs';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_PATH = path.join(__dirname, '..', '..', '..', 'docs', 'api', 'Permission_Scope_Crosswalk.xlsx');

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

  const rolesWithPermission = (perm) =>
    new Set(ALL_ROLES.filter(r => (ROLE_PERMISSIONS[r] || []).includes(perm)));

  const client = new pg.Client({
    host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  const { rows: grants } = await client.query(`
    select s.scope_code, rr.role_name
    from role_scope_mapping rsm
    join rbac_role rr on rr.pk_role_id_uuid = rsm.fk_role_id_rbac
    join scopes s on s.pk_scope_id = rsm.fk_scope_id
  `);
  await client.end();

  const rolesWithScope = {};
  for (const { scope_code, role_name } of grants) {
    (rolesWithScope[scope_code] = rolesWithScope[scope_code] || new Set()).add(role_name);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE_PATH);
  const ws = wb.getWorksheet('Crosswalk');

  const pairs = new Map(); // "perm=>scope" -> {perm, scope, count, files}
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const perm = row.getCell(5).value;
    const scope = row.getCell(8).value;
    const key = `${perm}=>${scope}`;
    if (!pairs.has(key)) pairs.set(key, { perm, scope, count: 0, files: new Set() });
    const p = pairs.get(key);
    p.count++;
    p.files.add(row.getCell(1).value);
  });

  const setEq = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
  const mismatches = [];
  for (const { perm, scope, count, files } of pairs.values()) {
    const before = rolesWithPermission(perm);
    const after = rolesWithScope[scope] || new Set();
    if (!setEq(before, after)) {
      const gained = [...after].filter(r => !before.has(r));
      const lost = [...before].filter(r => !after.has(r));
      mismatches.push({ perm, scope, count, files: [...files], before: [...before], after: [...after], gained, lost });
    }
  }

  mismatches.sort((a, b) => b.count - a.count);
  console.log(`${pairs.size} distinct (permission -> scope) pairs checked.`);
  console.log(`${mismatches.length} pairs have a role-set mismatch (${mismatches.reduce((s, m) => s + m.count, 0)} call sites affected).\n`);
  for (const m of mismatches) {
    console.log(`### ${m.perm} -> ${m.scope}  (${m.count} call sites: ${m.files.join(', ')})`);
    console.log(`    before: [${m.before.join(', ') || '(none)'}]`);
    console.log(`    after:  [${m.after.join(', ') || '(none)'}]`);
    if (m.gained.length) console.log(`    GAINS access: ${m.gained.join(', ')}`);
    if (m.lost.length) console.log(`    LOSES access: ${m.lost.join(', ')}`);
    console.log();
  }

  fs.writeFileSync(
    '/tmp/claude-1000/-home-ubuntu-FRS-DEV-Motivity-Face-Recognition-System/8f57a4b7-daff-428d-800f-ec61c507cfa2/scratchpad/parity_report.json',
    JSON.stringify(mismatches, null, 2)
  );
}

main().catch(err => { console.error(err); process.exit(1); });
