// Phase 1 of the rbac_role/roles unification (see the plan): produces a
// reviewable spreadsheet mapping every requirePermission() call site in
// src/routes/*.js to its candidate requireScope() replacement(s).
//
// This is NOT a mechanical rename — the scope catalog already anticipated
// finer menu/sub-menu granularity than the legacy permission codes, so a
// single legacy permission commonly has several plausible scope matches.
// This script proposes candidates by matching category<->menu_name and
// action<->action; it does not guess when the match is ambiguous or absent.
// A human (who knows the actual nav structure the scopes' menu_name/sub_menu
// values are meant to mirror) makes the final call before Phase 2 touches
// any route file.
//
// Usage: node scripts/generate-permission-scope-crosswalk.js
// Reads scopes/rbac_permission from the DB (via DB_* env vars) and every
// src/routes/*.js file. Writes docs/api/Permission_Scope_Crosswalk.xlsx.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import ExcelJS from 'exceljs';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.join(__dirname, '..', 'src', 'routes');
const OUT_PATH = path.join(__dirname, '..', '..', '..', 'docs', 'api', 'Permission_Scope_Crosswalk.xlsx');

// Same route-mount table generate-openapi.js keeps in sync with server.js —
// duplicated here rather than imported so this one-off analysis script has
// zero risk of perturbing the shipping OpenAPI generator.
const MOUNTS = {
  'alertRoutes.js': '/api/alerts',
  'attendanceRoutes.js': '/api/attendance',
  'biometricConsentRoutes.js': '/api/consent/biometric',
  'cameraRoutes.js': '/api/cameras',
  'confidenceReviewRoutes.js': '/api/confidence-reviews',
  'configRoutes.js': '/api/config',
  'dashboardRoutes.js': '/api/dashboard',
  'deviceManagementRoutes.js': '/api/device-management',
  'deviceRoutes.js': '/api/devices',
  'deviceTokenRoutes.js': '/api/device-tokens',
  'employeeRoutes.js': '/api/employees',
  'enrollmentRoutes.js': '/api/enroll',
  'faceRoutes.js': '/api/face',
  'faceSyncRoutes.js': '/api/face/sync',
  'hrRoutes.js': '/api/hr',
  'hrmsIntegrationRoutes.js': '/api/hrms',
  'incidentRoutes.js': '/api/incidents',
  'jetsonRoutes.js': '/api/jetson',
  'liveRoutes.js': '/api/live',
  'monitoringRoutes.js': '/api/monitoring',
  'peopleRoutes.js': '/api/people',
  'rbacRoutes.js': '/api/admin/rbac',
  'reportRoutes.js': '/api/reports',
  'searchRoutes.js': '/api/search',
  'siteManagementRoutes.js': '/api/site-management',
  'siteRoutes.js': '/api/site',
  'watchlistRoutes.js': '/api/watchlists',
};

function matchParenClose(src, openParenIdx) {
  let depth = 0, i = openParenIdx, inStr = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) break; }
  }
  return i;
}

function parseRouteFile(filename) {
  const filePath = path.join(ROUTES_DIR, filename);
  const src = fs.readFileSync(filePath, 'utf8');
  const rows = [];

  const routeCallRe = /router\.(get|post|put|patch|delete)\(/g;
  let match;
  while ((match = routeCallRe.exec(src)) !== null) {
    const method = match[1].toUpperCase();
    const startIdx = match.index;
    const openParenIdx = src.indexOf('(', startIdx);
    const closeIdx = matchParenClose(src, openParenIdx);
    const window = src.slice(startIdx, closeIdx + 1);

    const pathMatch = window.match(/router\.\w+\(\s*(['"`])((?:(?!\1).)*)\1/);
    const routePath = pathMatch ? pathMatch[2] : null;
    if (!routePath) continue;

    const line = src.slice(0, startIdx).split('\n').length;

    // A single route can carry more than one requirePermission() guard.
    const permRe = /requirePermission\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
    let pm;
    let found = false;
    while ((pm = permRe.exec(window)) !== null) {
      found = true;
      rows.push({ file: filename, line, method, path: (MOUNTS[filename] || '') + routePath, permission: pm[1] });
    }
    if (!found) continue; // route has no requirePermission() guard — out of scope for this crosswalk
  }
  return rows;
}

function normalizeMenu(menuName) {
  return menuName.toLowerCase().replace(/\s+/g, '_');
}

// The legacy code's last dot-segment is usually the action, but a few use an
// underscore (e.g. "bulk_import", "correct_request") — try both.
function candidateActions(permissionCode) {
  const dotParts = permissionCode.split('.');
  const lastDot = dotParts[dotParts.length - 1];
  const actions = new Set([lastDot]);
  if (lastDot.includes('_')) {
    for (const piece of lastDot.split('_')) actions.add(piece);
  }
  return [...actions];
}

async function main() {
  const client = new pg.Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  const { rows: scopes } = await client.query('SELECT scope_code, menu_name, sub_menu, action, vertical FROM scopes ORDER BY scope_code');
  const { rows: permissions } = await client.query('SELECT permission_code, category FROM rbac_permission ORDER BY permission_code');
  await client.end();

  const permCategoryByCode = new Map(permissions.map(p => [p.permission_code, p.category]));

  const allRows = [];
  for (const filename of fs.readdirSync(ROUTES_DIR)) {
    if (!filename.endsWith('.js')) continue;
    allRows.push(...parseRouteFile(filename));
  }

  const wb = new ExcelJS.Workbook();

  // ---- Sheet 1: Overview ----
  const overview = wb.addWorksheet('Overview');
  overview.columns = [{ width: 42 }, { width: 70 }];
  overview.addRows([
    ['Purpose', 'Phase 1 of the rbac_role/roles unification: propose a requireScope() replacement for every requirePermission() call site before any route file is touched.'],
    ['Call sites found', allRows.length],
    ['Route files scanned', new Set(allRows.map(r => r.file)).size],
    ['Legacy permission codes', permissions.length],
    ['Scope catalog size', scopes.length],
    [''],
    ['How to use this sheet', 'Open the "Crosswalk" tab. Each row is one requirePermission() call site. "Candidate scope(s)" is auto-proposed by matching category<->menu_name and action<->action — it is a starting point, not a final answer. Fill "Chosen scope" once you\'ve reviewed the "Confidence" and "Notes" columns; leave a row blank if a scope needs to be created that does not exist yet.'],
    ['Confidence: exact', 'Exactly one scope matched the legacy code\'s category + action. Highest-confidence default.'],
    ['Confidence: multiple', 'More than one scope matched — the legacy permission likely needs to fan out into several scopes, or you need to pick the one that matches this specific route\'s actual behavior.'],
    ['Confidence: none', 'No scope in the same menu matched the action. Either the category<->menu_name naming diverges (needs manual lookup) or no equivalent scope exists yet.'],
  ]);
  overview.getColumn(1).font = { bold: true };

  // ---- Sheet 2: Crosswalk ----
  const cw = wb.addWorksheet('Crosswalk', { views: [{ state: 'frozen', ySplit: 1 }] });
  cw.columns = [
    { header: 'Route file', key: 'file', width: 26 },
    { header: 'Line', key: 'line', width: 8 },
    { header: 'Method', key: 'method', width: 9 },
    { header: 'Path', key: 'path', width: 40 },
    { header: 'Legacy permission code', key: 'permission', width: 26 },
    { header: 'Candidate scope(s)', key: 'candidates', width: 55 },
    { header: 'Confidence', key: 'confidence', width: 12 },
    { header: 'Chosen scope (fill in)', key: 'chosen', width: 30 },
    { header: 'Notes', key: 'notes', width: 40 },
  ];
  cw.getRow(1).font = { bold: true };

  let exactCount = 0, multiCount = 0, noneCount = 0;

  for (const row of allRows) {
    const category = permCategoryByCode.get(row.permission) ?? row.permission.split('.')[0];
    const actions = candidateActions(row.permission);

    const inMenu = scopes.filter(s => normalizeMenu(s.menu_name) === category.toLowerCase());
    const searchPool = inMenu.length ? inMenu : scopes;
    const matches = searchPool.filter(s => actions.includes(s.action));

    let confidence, candidateList, notes = '';
    if (matches.length === 1) {
      confidence = 'exact'; exactCount++;
      candidateList = matches[0].scope_code;
    } else if (matches.length > 1) {
      confidence = 'multiple'; multiCount++;
      candidateList = matches.map(m => m.scope_code).join(', ');
    } else {
      confidence = 'none'; noneCount++;
      candidateList = inMenu.length
        ? inMenu.map(m => m.scope_code).join(', ')
        : '(no scopes.menu_name matched category "' + category + '")';
      notes = inMenu.length
        ? 'No action match within the matched menu — listing the full menu for manual pick.'
        : 'category "' + category + '" has no corresponding menu_name in scopes — needs manual lookup or a new scope.';
    }

    cw.addRow({
      file: row.file, line: row.line, method: row.method, path: row.path,
      permission: row.permission, candidates: candidateList, confidence, chosen: '', notes,
    });
  }

  overview.addRow(['']);
  overview.addRow(['Exact matches', exactCount]);
  overview.addRow(['Multiple candidates', multiCount]);
  overview.addRow(['No match', noneCount]);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  await wb.xlsx.writeFile(OUT_PATH);
  console.log(`Wrote ${allRows.length} call sites (${exactCount} exact, ${multiCount} multiple, ${noneCount} none) to ${OUT_PATH}`);
}

main().catch(err => { console.error(err); process.exit(1); });
