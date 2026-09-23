// Regenerates src/docs/openapi.generated.json by statically parsing every
// router.get/post/put/patch/delete(...) call in src/routes/*.js, exactly the
// way Express itself would register them, then combining that with the
// app.use() mount table this file keeps in sync with server.js.
//
// Run after adding/removing routes or changing a mount prefix:
//   node scripts/generate-openapi.js
//
// This intentionally does NOT introspect the live Express app instance —
// walking a running app's internal router stack is possible but relies on
// undocumented Express internals. Static source parsing is slower to write
// but produces the exact same result without depending on Express version
// quirks, and can run in CI without booting the server or a database.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.join(__dirname, '..', 'src', 'routes');
const CONTROLLERS_DIR = path.join(__dirname, '..', 'src', 'controllers');

// Cache of ControllerName -> Map<methodName, methodBodyText>, built lazily so
// each controller file is only read/parsed once even though many routes in
// the same file reference it.
const controllerMethodCache = new Map();

function loadControllerMethods(controllerName) {
  if (controllerMethodCache.has(controllerName)) return controllerMethodCache.get(controllerName);
  const methods = new Map();
  const filePath = path.join(CONTROLLERS_DIR, controllerName + '.js');
  if (fs.existsSync(filePath)) {
    const src = fs.readFileSync(filePath, 'utf8');
    // `async methodName(req, res) { ... }` or `methodName(req, res) { ... }` —
    // this codebase's controllers are plain object literals with method
    // shorthand (`const XController = { async listUsers(req, res) {...}, ... }`).
    const methodRe = /(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(\s*req\s*,\s*res\b[^)]*\)\s*\{/g;
    let m;
    while ((m = methodRe.exec(src)) !== null) {
      const braceOpenIdx = src.indexOf('{', m.index + m[0].length - 1);
      const braceCloseIdx = matchBracketClose(src, braceOpenIdx, '{', '}');
      methods.set(m[1], src.slice(braceOpenIdx, braceCloseIdx + 1));
    }
  }
  controllerMethodCache.set(controllerName, methods);
  return methods;
}

function resolveControllerHandler(window) {
  const m = window.match(/([A-Za-z_$][\w$]*Controller)\.([A-Za-z_$][\w$]*)/);
  if (!m) return null;
  const [, controllerName, methodName] = m;
  const methods = loadControllerMethods(controllerName);
  if (!methods.has(methodName)) return null;
  return { controllerName, methodName, body: methods.get(methodName) };
}
const OUT_PATH = path.join(__dirname, '..', 'src', 'docs', 'openapi.generated.json');

// Keep this in sync with the app.use(...) calls in src/server.js.
const MOUNTS = {
  'authRoutes.js': ['/api/auth'],
  'mfaRoutes.js': ['/api/auth/mfa'],
  'alertRoutes.js': ['/api/alerts'],
  'incidentRoutes.js': ['/api/incidents'],
  'watchlistRoutes.js': ['/api/watchlists'],
  'confidenceReviewRoutes.js': ['/api/confidence-reviews'],
  'rbacRoutes.js': ['/api/admin/rbac'],
  'appAdminRoutes.js': ['/api/app-admin', '/api/activity-log', '/api/activity-logs', '/api/activity_log'],
  'manifestRoutes.js': ['/api/me'],
  'tenantAdminRoutes.js': ['/api/tenant-admin'],
  'meRoutes.js': ['/api/me'],
  'deviceRoutes.js': ['/api/devices'],
  'deviceManagementRoutes.js': ['/api/device-management', '/device-management'],
  'hrmsIntegrationRoutes.js': ['/api/hrms'],
  'internalRoutes.js': ['/api/internal'],
  'siteManagementRoutes.js': ['/api/site-management'],
  'monitoringRoutes.js': ['/api/monitoring'],
  'configRoutes.js': ['/api/config'],
  'bootstrapRoutes.js': ['/api/bootstrap'],
  'deviceEventsRoutes.js': ['/api/events'],
  'faceSyncRoutes.js': ['/api/face/sync'],
  'deviceTokenRoutes.js': ['/api/device-tokens'],
  'biometricConsentRoutes.js': ['/api/consent/biometric'],
  'studentsRoutes.js': ['/api/students'],
  'attendanceRoutes.js': ['/api/attendance'],
  'employeeRoutes.js': ['/api/employees'],
  'peopleRoutes.js': ['/api/people'],
  'dashboardRoutes.js': ['/api/dashboard'],
  'searchRoutes.js': ['/api/search'],
  'faceRoutes.js': ['/api/face'],
  'siteRoutes.js': ['/api/site'],
  'reportRoutes.js': ['/api/reports'],
  'userRoutes.js': ['/api/users'],
  'hrRoutes.js': ['/api/hr'],
  'cameraRoutes.js': ['/api/cameras'],
  'jetsonRoutes.js': ['/api/jetson'],
  'enrollmentRoutes.js': ['/api/enroll', '/api/enrollment'],
  'liveRoutes.js': ['/api/live'],
  // Not mounted at all in server.js today — excluded from the generated spec
  // since they're unreachable. See docs/api/API_Specifications.xlsx's
  // "Unreachable" sheet for the audit that found this.
  'healthRoutes.js': [],
};

const AUTH_PATTERNS = [
  [/authenticateDevice/, 'DeviceJwt'],
  [/requireAuth/, 'CookieAuth'],
];

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

function extractPermission(text) {
  const m = text.match(/requirePermission\(\s*['"`]([^'"`]+)['"`]/);
  return m ? m[1] : null;
}

// Generic bracket matcher — same walk as matchParenClose but for any open/close
// pair, so it also works on the `{...}` object literals res.json(...) and
// destructuring assignments build.
function matchBracketClose(src, openIdx, openCh, closeCh) {
  let depth = 0, i = openIdx, inStr = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === openCh) depth++;
    else if (ch === closeCh) { depth--; if (depth === 0) break; }
  }
  return i;
}

// Splits an object literal's *top-level* entries only (depth-aware, so nested
// {}/[] inside a value never gets mistaken for a new top-level field), and
// gives each a coarse OpenAPI type guessed from the literal on its right side.
function parseObjectLiteralFields(innerText) {
  const fields = [];
  let depth = 0, inStr = null, start = 0;
  const parts = [];
  for (let i = 0; i < innerText.length; i++) {
    const ch = innerText[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) { parts.push(innerText.slice(start, i)); start = i + 1; }
  }
  parts.push(innerText.slice(start));

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;
    if (part.startsWith('...')) continue; // spread — can't statically know the keys
    const colonIdx = (() => {
      // first top-level ':' — depth-aware so a ternary/object value's colon
      // deeper in the expression doesn't get mistaken for the key separator
      let d = 0, s = null;
      for (let i = 0; i < part.length; i++) {
        const c = part[i];
        if (s) { if (c === '\\') { i++; continue; } if (c === s) s = null; continue; }
        if (c === '"' || c === "'" || c === '`') { s = c; continue; }
        if (c === '{' || c === '[' || c === '(') d++;
        else if (c === '}' || c === ']' || c === ')') d--;
        else if (c === ':' && d === 0) return i;
      }
      return -1;
    })();

    let name, valueText;
    if (colonIdx === -1) {
      name = part.replace(/^\[.*\]$/, part); // computed key `[x]:` unlikely without colon; just fall through
      valueText = part;
    } else {
      name = part.slice(0, colonIdx).trim().replace(/^['"`]|['"`]$/g, '');
      valueText = part.slice(colonIdx + 1).trim();
    }
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue; // skip computed/spread/invalid keys

    let type = 'string';
    if (/^-?\d+(\.\d+)?$/.test(valueText)) type = 'number';
    else if (/^(true|false)$/.test(valueText)) type = 'boolean';
    else if (/^null$/.test(valueText)) type = 'null';
    else if (valueText.startsWith('{')) type = 'object';
    else if (valueText.startsWith('[')) type = 'array';
    else if (/^['"`]/.test(valueText)) type = 'string';
    else type = 'unknown'; // a variable/expression — value's real type isn't statically known here

    fields.push({ name, type });
  }
  return fields;
}

// Scans a route's full source window (middleware args + handler body — safe to
// scan as one blob since none of this codebase's middleware helpers reference
// req.body/req.query/res.json) for the fields each Express handler actually
// reads from the request and writes to the response.
function extractRequestFields(window, sourceExpr) {
  const fields = new Map();
  // const { a, b: alias, c = default } = req.body;
  const destructureRe = new RegExp(`const\\s*\\{([^}]+)\\}\\s*=\\s*${sourceExpr}\\??\\s*(?:\\|\\|[^;]*)?;`, 'g');
  let m;
  while ((m = destructureRe.exec(window)) !== null) {
    m[1].split(',').forEach(raw => {
      const name = raw.trim().split(':')[0].split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) fields.set(name, { name, type: 'unknown', source: 'destructured' });
    });
  }
  // req.body.fieldName / req.query.fieldName direct access
  const accessRe = new RegExp(`${sourceExpr}\\??\\.(\\w+)`, 'g');
  while ((m = accessRe.exec(window)) !== null) {
    if (!fields.has(m[1])) fields.set(m[1], { name: m[1], type: 'unknown', source: 'accessed' });
  }
  return [...fields.values()];
}

// res.json({...}) / res.status(NNN).json({...}) — collects the field set per
// status code actually used, split by whether the status is >=400 (error
// shape) so the generated spec doesn't conflate error and success bodies.
function extractResponses(window) {
  const byStatus = {}; // status(string) -> Map<fieldName, type>
  const callRe = /res\.(?:status\((\d+)\)\.)?json\(/g;
  let m;
  while ((m = callRe.exec(window)) !== null) {
    const status = m[1] || '200';
    const openParenIdx = window.indexOf('(', m.index + m[0].length - 1);
    const closeParenIdx = matchBracketClose(window, openParenIdx, '(', ')');
    const argText = window.slice(openParenIdx + 1, closeParenIdx).trim();

    if (!byStatus[status]) byStatus[status] = { fields: new Map(), dynamic: false };

    if (argText.startsWith('{')) {
      const braceClose = matchBracketClose(argText, 0, '{', '}');
      const inner = argText.slice(1, braceClose);
      parseObjectLiteralFields(inner).forEach(f => {
        if (!byStatus[status].fields.has(f.name)) byStatus[status].fields.set(f.name, f.type);
      });
    } else if (argText) {
      byStatus[status].dynamic = true; // res.json(someVariable) — shape not statically known here
    }
  }
  return byStatus;
}

function parseRouterUseGuards(src) {
  const guards = [];
  const re = /^router\.use\(/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const openParenIdx = src.indexOf('(', m.index);
    const closeIdx = matchParenClose(src, openParenIdx);
    const args = src.slice(openParenIdx + 1, closeIdx).trim();
    const lineIdx = src.slice(0, m.index).split('\n').length - 1;
    if (/^['"`]/.test(args)) continue;
    if (/=>|function/.test(args)) continue; // custom inline middleware — not a named security scheme
    const names = args.split(',').map(s => s.trim()).filter(Boolean);
    names.forEach(n => guards.push({ line: lineIdx, label: n }));
  }
  return guards;
}

function findDescription(lines, routeLineIdx) {
  let i = routeLineIdx - 1;
  const collected = [];
  while (i >= 0) {
    const l = lines[i].trim();
    if (l.startsWith('//') || l.startsWith('/*') || l.startsWith('*')) {
      const cleaned = l
        .replace(/^[/*]+/, '')      // leading comment markers
        .replace(/\*\/$/, '')       // trailing block-comment close
        .replace(/─+/g, ' ')        // box-drawing separator runs used as visual dividers
        .replace(/\s+/g, ' ')
        .trim();
      collected.unshift(cleaned);
      i--;
    } else if (l === '') break;
    else break;
  }
  const full = collected.filter(Boolean).join(' ').trim();
  if (!full) return { summary: '', description: '' };
  // Short summary: up to the first sentence-ish break, capped so Swagger's
  // operation list stays scannable; the full text still goes in description.
  const firstBreak = full.search(/[.!?](\s|$)/);
  const summary = firstBreak > 0 && firstBreak < 100 ? full.slice(0, firstBreak + 1) : full.slice(0, 100);
  return { summary: summary.trim(), description: full };
}

function parseFile(filename) {
  const filePath = path.join(ROUTES_DIR, filename);
  const src = fs.readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  const endpoints = [];
  const blanketGuards = parseRouterUseGuards(src);

  const routeCallRe = /router\.(get|post|put|patch|delete)\(/g;
  let match;
  while ((match = routeCallRe.exec(src)) !== null) {
    const method = match[1];
    const startIdx = match.index;
    const openParenIdx = src.indexOf('(', startIdx);
    const closeIdx = matchParenClose(src, openParenIdx);
    const window = src.slice(startIdx, closeIdx + 1);

    const pathMatch = window.match(/router\.\w+\(\s*(['"`])((?:(?!\1).)*)\1/);
    const routePath = pathMatch ? pathMatch[2] : null;
    if (!routePath) continue;

    const perm = extractPermission(window);
    const isDevice = /authenticateDevice/.test(window);
    const isAuthed = /requireAuth/.test(window);

    const upToMatch = src.slice(0, startIdx);
    const lineIdx = upToMatch.split('\n').length - 1;
    const { summary, description } = findDescription(lines, lineIdx);

    const inheritedAuthed = blanketGuards.some(g => g.line < lineIdx && g.label === 'requireAuth');

    // Many routes just delegate to a `const XController = { async method(req, res) {...} }`
    // object (`ac(XController.method)`) — the actual req.body/req.query/res.json
    // calls live in that controller file, not in this route registration text,
    // so resolve and scan the real handler body when this route is one of those.
    const controllerHandler = resolveControllerHandler(window);
    const handlerSource = controllerHandler ? controllerHandler.body : window;

    const bodyFields = ['post', 'put', 'patch'].includes(method)
      ? extractRequestFields(handlerSource, 'req\\.body')
      : [];
    const queryFields = extractRequestFields(handlerSource, 'req\\.query');
    const responses = extractResponses(handlerSource);

    endpoints.push({
      file: filename, method, path: routePath, permission: perm,
      security: isDevice ? 'DeviceJwt' : (isAuthed || inheritedAuthed ? 'CookieAuth' : null),
      summary, description, bodyFields, queryFields, responses,
      handlerLocation: controllerHandler
        ? `src/controllers/${controllerHandler.controllerName}.js#${controllerHandler.methodName}`
        : `src/routes/${filename}`,
    });
  }
  return endpoints;
}

// Maps this script's coarse type guesses onto an OpenAPI schema fragment.
// 'unknown' (a variable/expression whose literal type isn't visible at the
// call site) deliberately gets no `type` key — OpenAPI 3.0 treats a typeless
// schema as "unconstrained", which is the honest representation of "this
// field exists, its exact type isn't statically known from this scan".
function fieldToSchema(type) {
  switch (type) {
    case 'number': return { type: 'number' };
    case 'boolean': return { type: 'boolean' };
    case 'array': return { type: 'array', items: {} };
    case 'object': return { type: 'object' };
    case 'null': return { nullable: true };
    case 'string': return { type: 'string' };
    default: return {}; // unknown — unconstrained
  }
}

const GENERIC_RESPONSES = {
  200: { description: 'Success' },
  401: { description: 'Unauthorized — missing or invalid credentials' },
  403: { description: 'Forbidden — authenticated but missing the required permission' },
};

// Turns the {status -> {fields, dynamic}} map extractResponses() built into
// real OpenAPI response objects, falling back to the generic placeholder set
// for any status this scan found no res.json(...) call for at all (routes
// whose handler builds the response through several branches/helpers rather
// than a literal object the scan can see into).
function buildResponses(responsesByStatus, security) {
  const out = {};
  for (const [status, info] of Object.entries(responsesByStatus || {})) {
    if (info.fields.size > 0) {
      const properties = {};
      info.fields.forEach((type, name) => { properties[name] = fieldToSchema(type); });
      out[status] = {
        description: Number(status) >= 400 ? 'Error' : 'Success',
        content: { 'application/json': { schema: { type: 'object', properties } } },
      };
    } else if (info.dynamic) {
      out[status] = {
        description: (Number(status) >= 400 ? 'Error' : 'Success') + ' — response body is a computed/passed-through value, not a literal object this scan could read a shape from.',
      };
    }
  }
  if (!out['200'] && !out['201'] && !out['202'] && !out['204']) out['200'] = GENERIC_RESPONSES[200];
  if (security && !out['401']) out['401'] = GENERIC_RESPONSES[401];
  if (security && !out['403']) out['403'] = GENERIC_RESPONSES[403];
  return out;
}

function classifyDomain(file) {
  if (file === 'authRoutes.js' || file === 'mfaRoutes.js') return 'Auth & Session';
  if (file === 'rbacRoutes.js') return 'Access Control (RBAC)';
  if (file === 'attendanceRoutes.js') return 'Attendance';
  if (['employeeRoutes.js', 'hrRoutes.js'].includes(file)) return 'Corporate HR';
  if (file === 'studentsRoutes.js') return 'Education';
  if (file === 'hrmsIntegrationRoutes.js') return 'HRMS Integration';
  if (['deviceRoutes.js', 'deviceManagementRoutes.js', 'deviceTokenRoutes.js', 'deviceEventsRoutes.js', 'cameraRoutes.js', 'jetsonRoutes.js', 'faceSyncRoutes.js'].includes(file)) return 'Device Fleet & Edge Ingest';
  if (['enrollmentRoutes.js', 'faceRoutes.js', 'biometricConsentRoutes.js'].includes(file)) return 'Biometric Enrollment';
  if (file === 'peopleRoutes.js') return 'Identity / Person Registry';
  if (['alertRoutes.js', 'incidentRoutes.js', 'watchlistRoutes.js', 'confidenceReviewRoutes.js'].includes(file)) return 'Alerts, Incidents & Watchlists';
  if (['siteRoutes.js', 'siteManagementRoutes.js'].includes(file)) return 'Sites & Facilities';
  if (['tenantAdminRoutes.js', 'appAdminRoutes.js', 'configRoutes.js', 'manifestRoutes.js', 'meRoutes.js'].includes(file)) return 'Platform / Tenant Admin';
  if (['dashboardRoutes.js', 'reportRoutes.js', 'searchRoutes.js'].includes(file)) return 'Dashboards & Reporting';
  if (['monitoringRoutes.js', 'healthRoutes.js'].includes(file)) return 'System Health & Monitoring';
  if (['internalRoutes.js', 'bootstrapRoutes.js'].includes(file)) return 'Internal / Bootstrap';
  if (file === 'userRoutes.js') return 'User Management';
  if (file === 'liveRoutes.js') return 'Live Dashboard Feed';
  return 'Other';
}

function toOpenApiPath(expressPath) {
  const params = [];
  const converted = expressPath.replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
    params.push(name);
    return `{${name}}`;
  });
  return { converted, params };
}

const paths = {};
const tagsSeen = new Set();

for (const file of Object.keys(MOUNTS)) {
  const prefixes = MOUNTS[file];
  if (!prefixes.length) continue; // not mounted -> not reachable -> excluded
  const filePath = path.join(ROUTES_DIR, file);
  if (!fs.existsSync(filePath)) { console.error('Missing route file:', file); continue; }
  const domain = classifyDomain(file);
  tagsSeen.add(domain);

  for (const ep of parseFile(file)) {
    for (const prefix of prefixes) {
      const joined = (prefix + ep.path).replace(/\/{2,}/g, '/');
      // Express treats a trailing slash as equivalent to no trailing slash by
      // default (strict routing is off) — collapse "/api/users/" to
      // "/api/users" so the doc doesn't show the same resource as two paths.
      const fullExpressPath = joined.length > 1 ? joined.replace(/\/$/, '') : joined;
      const { converted, params } = toOpenApiPath(fullExpressPath);

      if (!paths[converted]) paths[converted] = {};
      const operation = {
        summary: ep.summary || `${ep.method.toUpperCase()} ${fullExpressPath}`,
        tags: [domain],
        'x-source-file': ep.handlerLocation,
      };
      if (ep.description && ep.description !== ep.summary) {
        operation.description = ep.description;
      }
      const parameters = params.map(name => ({
        name, in: 'path', required: true, schema: { type: 'string' },
      }));
      // query fields, skipping anything already covered as a path param
      ep.queryFields.filter(f => !params.includes(f.name)).forEach(f => {
        parameters.push({
          name: f.name, in: 'query', required: false,
          schema: fieldToSchema(f.type),
          description: 'Inferred from req.query.' + f.name + ' in the handler source.',
        });
      });
      if (parameters.length) operation.parameters = parameters;

      if (ep.security) {
        operation.security = [{ [ep.security]: [] }];
      }
      if (ep.permission) {
        operation['x-required-permission'] = ep.permission;
      }

      if (ep.bodyFields.length) {
        const properties = {};
        ep.bodyFields.forEach(f => { properties[f.name] = fieldToSchema(f.type); });
        operation.requestBody = {
          required: true,
          description: 'Inferred from the fields the handler reads off req.body — not a hand-authored contract, so an optional field the handler happens not to check for yet may still be silently accepted.',
          content: { 'application/json': { schema: { type: 'object', properties } } },
        };
      }

      operation.responses = buildResponses(ep.responses, ep.security);
      paths[converted][ep.method] = operation;
    }
  }
}

const tagOrder = [
  'Auth & Session', 'Access Control (RBAC)', 'User Management', 'Identity / Person Registry',
  'Biometric Enrollment', 'Attendance', 'Corporate HR', 'Education', 'HRMS Integration',
  'Device Fleet & Edge Ingest', 'Alerts, Incidents & Watchlists', 'Sites & Facilities',
  'Live Dashboard Feed', 'Dashboards & Reporting', 'Platform / Tenant Admin',
  'System Health & Monitoring', 'Internal / Bootstrap', 'Other',
];

const spec = {
  openapi: '3.0.0',
  info: {
    title: 'Motivity Face Recognition System API',
    description: 'Full API surface, generated from src/routes/*.js — every mounted endpoint, not a hand-picked sample. Regenerate with `node scripts/generate-openapi.js` after route changes.',
    version: '2.0.0-generated',
  },
  servers: [{ url: '/api', description: 'Default relative API gateway' }],
  tags: tagOrder.filter(t => tagsSeen.has(t)).map(name => ({ name })),
  paths,
  components: {
    securitySchemes: {
      DeviceJwt: {
        type: 'apiKey', in: 'header', name: 'Authorization',
        description: 'Bearer <DeviceJWT> — issued to Jetson/edge devices',
      },
      CookieAuth: {
        type: 'apiKey', in: 'cookie', name: 'KEYCLOAK_IDENTITY',
        description: 'httpOnly session cookie set on login',
      },
    },
  },
};

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(spec, null, 2));

const pathCount = Object.keys(paths).length;
const opCount = Object.values(paths).reduce((n, ops) => n + Object.keys(ops).length, 0);
console.log(`Generated ${opCount} operations across ${pathCount} paths -> ${path.relative(process.cwd(), OUT_PATH)}`);
