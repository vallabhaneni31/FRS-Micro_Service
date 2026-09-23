// Phase 1b: fills in "Chosen scope" on every row of
// docs/api/Permission_Scope_Crosswalk.xlsx using actual route behavior
// (not the legacy permission code's name — several of those turned out to
// be reused across unrelated domains; see the resolver comments below).
//
// Rows this script can't resolve against the existing scope catalog get
// "NEW_SCOPE_NEEDED: <proposed-code>" instead of a guess.
//
// Usage: node scripts/resolve-permission-scope-crosswalk.js

import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_PATH = path.join(__dirname, '..', '..', '..', 'docs', 'api', 'Permission_Scope_Crosswalk.xlsx');

// Each entry: [permission code, array of [pathSubstring-or-null, method-or-null, scope, note?]]
// Matched top-to-bottom, first match wins. A null pathSubstring/method matches anything.
// note is shown in the Notes column when set (used to flag real findings, not just mapping rationale).
const RULES = {
  'alerts.read': [
    [null, null, 'alerts.list.read'],
  ],
  'alerts.write': [
    ['/acknowledge', null, 'alerts.list.acknowledge'],
    [null, null, 'alerts.list.write'],
  ],
  'attendance.read': [
    ['/site/delete', null, 'sites.list.delete', 'BUG in legacy code: a READ permission (attendance.read) guards a destructive POST /api/site/delete route.'],
    ['/devices/zone-heatmap', null, 'devices.events.read'],
    ['/jetson/photos', null, 'attendance.records.read', 'Device-facing route also gated by a user permission — verify this is intentional (dual auth) rather than leftover from a refactor.'],
    ['/live/alerts/mark-read', null, 'alerts.list.acknowledge'],
    ['/live/alerts', 'DELETE', 'alerts.list.write', 'Misfiled under attendance.read.'],
    ['/live/alerts', null, 'alerts.list.read', 'Misfiled under attendance.read in legacy code — this is alert data, not attendance.'],
    ['/live/audit', null, 'activity.log.read', 'Misfiled under attendance.read — this is audit/activity log data.'],
    ['/live/activity', null, 'activity.log.read', 'Misfiled under attendance.read — this is audit/activity log data.'],
    ['/live/shifts', null, 'attendance.shifts.read'],
    ['/live/calendar', null, 'attendance.calendar.read'],
    ['/live/trends', null, 'dashboard.analytics.read'],
    ['/live/dept-shift-analytics', null, 'dashboard.analytics.read'],
    ['/live/departments', null, 'attendance.status.read'],
    ['/live/metrics', null, 'dashboard.overview.read'],
    ['/live/visitor-buffer', null, 'visitors.list.read'],
    ['/live/attendance', null, 'attendance.records.read'],
    ['/site/holidays', null, 'sites.settings.read'],
    [null, null, 'attendance.records.read'],
  ],
  'attendance.write': [
    ['/site/delete', null, 'sites.list.delete', 'BUG in legacy code: attendance.write guards a site-deletion route — unrelated domain.'],
    ['/site/holidays', null, 'sites.settings.write'],
    ['/correct', null, 'attendance.records.correct'],
    ['/correction', null, 'attendance.records.correct'],
    ['/hr/roster', null, 'attendance.rosters.write'],
    [null, null, 'attendance.records.write'],
  ],
  'analytics.read': [
    // Checked first: /api/search/face/batch etc. would otherwise false-match
    // the '/face/' substring rules below and get miscategorized as face_recognition.
    // Split by real behavior, not HTTP verb — the search-execution endpoints
    // (face/appearance/vehicle matching) are POST only because they carry an
    // image/attribute payload, not because they mutate anything; only the
    // saved-profile and history CRUD actually writes.
    ['/search/profiles', 'GET', 'search.records.read'],
    ['/search/profiles', null, 'search.records.write'],
    ['/search/history', 'DELETE', 'search.records.write'],
    ['/search/', null, 'search.records.read'],
    // face_recognition CRUD, currently guarded by a generic "analytics" permission
    ['/face/register', null, 'face_recognition.embeddings.write', 'SECURITY-RELEVANT: face enrollment is guarded by analytics.read, not a face_recognition scope — anyone with analytics access can register faces today.'],
    ['/face/groups', 'GET', 'face_recognition.embeddings.read', 'Misfiled under analytics.read — this is face-recognition data, not analytics.'],
    ['/face/groups', null, 'face_recognition.embeddings.write', 'SECURITY-RELEVANT: face group CRUD guarded by analytics.read, not a face_recognition scope.'],
    ['/face/visitors/blacklist', null, 'face_recognition.embeddings.write', 'SECURITY-RELEVANT: blacklisting is guarded by analytics.read, not a face_recognition scope.'],
    ['/face/verify', null, 'face_recognition.matching.configure'],
    ['/face/search', null, 'face_recognition.matching.configure'],
    ['/face/snapshot', null, 'face_recognition.matching.configure'],
    ['/face/:id', 'PUT', 'face_recognition.embeddings.write'],
    ['/face/:id', 'DELETE', 'face_recognition.embeddings.write', 'SECURITY-RELEVANT: deleting a face record is guarded by analytics.read.'],
    ['/face/stats', null, 'face_recognition.embeddings.read'],
    ['/face/visitors', null, 'face_recognition.embeddings.read'],
    ['/face/', null, 'face_recognition.embeddings.read'],
    ['/face/employee', null, 'face_recognition.embeddings.read'],
    // reports
    ['/reports/export/', null, 'reports.generate.export'],
    ['/reports/scheduled', 'GET', 'reports.scheduled.read'],
    ['/reports/scheduled', null, 'reports.scheduled.write'],
    ['/reports/schedules', 'GET', 'reports.scheduled.read'],
    ['/reports/schedules', null, 'reports.scheduled.write'],
    ['/reports/completed', null, 'reports.scheduled.read'],
    ['/reports/templates', 'GET', 'reports.scheduled.read'],
    ['/reports/templates', null, 'reports.scheduled.write'],
    ['/reports/', null, 'reports.generate.generate', 'GET report data mapped to the "generate" action — no read-only action exists under Reports > Generate; review whether that submenu needs a .read action added.'],
    ['/attendance/', null, 'dashboard.analytics.read'],
    // dashboard
    ['/dashboard/admin/', null, 'dashboard.overview.read'],
    ['/dashboard/live/', null, 'dashboard.overview.read'],
    ['/dashboard/hr/', null, 'dashboard.analytics.read'],
    ['/dashboard/analytics/', null, 'dashboard.analytics.read'],
  ],
  'employees.view': [
    [null, null, 'employees.profile.read'],
  ],
  'devices.read': [
    ['/monitoring/alerts', null, 'alerts.list.read', 'Misfiled under devices.read — this is alert data.'],
    ['/site/', null, 'sites.settings.read', 'Misfiled under devices.read — this is site settings, not devices.'],
    ['/activity-heatmap', null, 'devices.events.read'],
    ['/employee-camera-heatmap', null, 'devices.events.read'],
    ['/activity-by-day', null, 'devices.events.read'],
    ['/accuracy-trend', null, 'devices.events.read'],
    ['/monitoring/devices', null, 'devices.events.read'],
    [null, null, 'devices.list.read'],
  ],
  'users.read': [
    ['/devices/', null, 'devices.list.read', 'Misfiled under users.read — this is device/building/camera infrastructure data, not users.'],
    ['/hr/shifts', null, 'attendance.shifts.read', 'Misfiled under users.read.'],
    ['/hr/roster', null, 'attendance.rosters.read', 'Misfiled under users.read.'],
    ['/hr/departments', null, 'employees.list.read', 'Misfiled under users.read.'],
    ['/admin/rbac/users/', null, 'users.roles.manage'],
    ['/admin/rbac/users', null, 'users.list.read'],
    ['/admin/rbac/roles', null, 'users.roles.read'],
    ['/admin/rbac/permissions', null, 'users.roles.read'],
    ['/admin/rbac/sites', null, 'sites.list.read'],
    ['/admin/rbac/', null, 'users.roles.read'],
    [null, null, 'users.list.read'],
  ],
  'attendance.manage': [
    ['/reboot', null, 'devices.control.reboot'],
    ['/apply-config', null, 'devices.control.configure'],
    ['/camera-mode', null, 'devices.control.configure'],
    ['/edge-devices/', null, 'devices.provisioning.decommission'],
    [null, null, 'devices.list.write', 'Misfiled under attendance.manage — every one of these 20 call sites guards device/building/floor/camera CRUD, not attendance.'],
  ],
  'devices.manage': [
    ['/status', null, 'devices.list.read'],
    [null, null, 'devices.control.configure'],
  ],
  'employees.read': [
    ['/erase', null, 'employees.list.delete', 'A READ permission (employees.read) guards a DELETE/erase route — likely reused rather than employees.list.delete.'],
    ['/embeddings/', null, 'face_recognition.embeddings.read'],
    ['/enroll-face-direct', null, 'face_recognition.embeddings.write'],
    ['/enroll-face', 'POST', 'face_recognition.embeddings.write'],
    ['/enroll-face', null, 'employees.profile.read'],
    ['/hrms/config', null, 'system.configuration.read'],
    ['/hrms/', null, 'enrollment.invitations.read'],
    ['/enroll/', null, 'enrollment.invitations.read'],
    ['/employees/search', null, 'employees.list.read'],
    ['/employees/managers', null, 'employees.list.read'],
    ['/employees/tree', null, 'employees.list.read'],
    ['/employees/:id', null, 'employees.profile.read'],
    ['/live/employees', null, 'employees.list.read'],
    [null, null, 'employees.list.read'],
  ],
  'employees.write': [
    ['/embeddings/', null, 'face_recognition.embeddings.write'],
    ['/enroll-face', null, 'face_recognition.embeddings.write'],
    ['/enroll-remote', null, 'face_recognition.embeddings.write'],
    ['/enroll/pending-approvals', null, 'enrollment.approvals.read', 'A WRITE permission (employees.write) guards a read-only approvals-queue GET — likely reused.'],
    ['/enroll/invitations/', 'POST', 'enrollment.approvals.approve'],
    ['/enroll/', null, 'enrollment.invitations.write'],
    ['/hr/shifts/', null, 'attendance.shifts.assign'],
    ['/hr/departments/', null, 'employees.bulk.assign'],
    ['/hrms/employees/bulk-import', null, 'employees.bulk.import'],
    ['/hrms/employees/sync', null, 'employees.bulk.import'],
    ['/erase', null, 'employees.list.delete'],
    ['/employees/', 'POST', 'employees.list.write'],
    ['/employees/:id', 'PUT', 'employees.profile.write'],
    [null, null, 'employees.profile.write'],
  ],
  'employees.deactivate': [
    ['/erase', null, 'employees.list.delete'],
    [null, null, 'employees.list.deactivate'],
  ],
  'users.manage': [
    [null, null, 'face_recognition.embeddings.write', 'Misfiled: POST /api/face/sync/trigger-enrollment guarded by users.manage — unrelated domain.'],
  ],
  'shifts.write': [
    ['/hr/shifts', null, 'attendance.shifts.write'],
    ['/hr/departments', null, 'employees.department.write'],
  ],
  'users.roles.manage': [
    [null, null, 'users.roles.manage'],
  ],
  'sites.write': [
    ['/sites/:siteId', 'GET', 'sites.list.read', 'A WRITE permission (sites.write) guards a GET route — likely a copy-paste from the adjacent POST route\'s guard.'],
    ['/sites/:siteId', 'DELETE', 'sites.list.delete'],
    [null, null, 'sites.list.write'],
  ],
  'sites.read': [
    ['/sites', 'POST', 'sites.list.write', 'A READ permission (sites.read) guards a POST route (site creation) — also carries sites.write on the same route; likely a leftover duplicate guard.'],
    [null, null, 'sites.list.read'],
  ],
};

function resolve(perm, method, routePath) {
  const rules = RULES[perm];
  if (!rules) return null;
  for (const [sub, m, scope, note] of rules) {
    if (sub && !routePath.includes(sub)) continue;
    if (m && m !== method) continue;
    return { scope, note: note || '' };
  }
  return null;
}

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE_PATH);
  const ws = wb.getWorksheet('Crosswalk');

  let filled = 0, newScopeNeeded = 0, unresolved = 0;
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const method = row.getCell(3).value;
    const routePath = row.getCell(4).value;
    const perm = row.getCell(5).value;
    const confidence = row.getCell(7).value;

    const result = resolve(perm, method, routePath);
    if (!result) {
      if (confidence === 'exact') {
        // Trust the automated exact match — single unambiguous candidate.
        row.getCell(8).value = row.getCell(6).value;
        filled++;
      } else {
        unresolved++;
      }
      return;
    }
    row.getCell(8).value = result.scope;
    if (result.note) {
      const existing = row.getCell(9).value || '';
      row.getCell(9).value = existing ? `${result.note} | ${existing}` : result.note;
    }
    if (result.scope.startsWith('NEW_SCOPE_NEEDED')) newScopeNeeded++;
    filled++;
  });

  await wb.xlsx.writeFile(FILE_PATH);
  console.log(`Filled ${filled} rows (${newScopeNeeded} flagged as needing a new scope). ${unresolved} rows left blank — no rule matched.`);
}

main().catch(err => { console.error(err); process.exit(1); });
