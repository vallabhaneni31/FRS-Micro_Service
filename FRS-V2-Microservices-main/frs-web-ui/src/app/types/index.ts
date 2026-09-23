// ─────────────────────────────────────────────────────────────────────────────
// Role types
// ─────────────────────────────────────────────────────────────────────────────

/** Legacy roles (kept during migration — frs_user.role column values) */
export type LegacyUserRole = 'admin' | 'hr';

/** RBAC Phase 2 role names (rbac_role.role_name values) */
export type RbacRoleName = 'super_admin' | 'site_admin' | 'hr_manager';

/** Union of all role values accepted by frs_user.role check constraint */
export type UserRole = LegacyUserRole | RbacRoleName;

// ─────────────────────────────────────────────────────────────────────────────
// Permission type
// Widened to include all 37 RBAC codes alongside the legacy codes.
// Legacy codes are kept so existing can() checks don't break during migration.
// ─────────────────────────────────────────────────────────────────────────────

export type Permission =
  // ── Legacy (Phase 1 — keep until all routes are migrated) ────────────────
  | 'users.manage'          // superseded by users.write + users.roles.manage
  | 'devices.manage'        // superseded by devices.write
  | 'attendance.manage'     // superseded by attendance.write
  | 'analytics.read'
  | 'audit.read'            // superseded by system.audit.read
  | 'facility.read'
  | 'facility.manage'       // superseded by sites.read / devices.write

  // ── System ───────────────────────────────────────────────────────────────
  | 'system.settings.read'
  | 'system.settings.write'
  | 'system.audit.read'

  // ── Sites ────────────────────────────────────────────────────────────────
  | 'sites.read'
  | 'sites.write'
  | 'sites.delete'

  // ── Devices ──────────────────────────────────────────────────────────────
  | 'devices.read'
  | 'devices.write'
  | 'devices.reboot'
  | 'devices.configure'
  | 'devices.provision'
  | 'devices.decommission'

  // ── Employees ────────────────────────────────────────────────────────────
  | 'employees.read'
  | 'employees.write'
  | 'employees.delete'
  | 'employees.deactivate'
  | 'employees.bulk_import'
  | 'employees.bulk_assign'

  // ── Attendance ───────────────────────────────────────────────────────────
  | 'attendance.read'
  | 'attendance.write'
  | 'attendance.correct'
  | 'attendance.correct_request'

  // ── Shifts ───────────────────────────────────────────────────────────────
  | 'shifts.read'
  | 'shifts.write'
  | 'shifts.assign'

  // ── Leave ────────────────────────────────────────────────────────────────
  | 'leave.read'
  | 'leave.write'

  // ── Reports ──────────────────────────────────────────────────────────────
  | 'reports.generate'
  | 'reports.export'

  // ── Users ────────────────────────────────────────────────────────────────
  | 'users.read'
  | 'users.write'
  | 'users.roles.manage'

  // ── Alerts ───────────────────────────────────────────────────────────────
  | 'alerts.read'
  | 'alerts.acknowledge'
  | 'alerts.configure'

  // ── Workforce config (HR Manager) ────────────────────────────────────────
  | 'breaks.configure'
  | 'overtime.configure'

  // ── Other legacy codes referenced in existing routes ─────────────────────
  | 'aiinsights.read';

export interface Tenant {
  id: string;
  name: string;
}

export interface Customer {
  id: string;
  tenantId: string;
  name: string;
}

export interface Site {
  id: string;
  customerId: string;
  name: string;
  status?: 'active' | 'inactive';
}

export interface Unit {
  id: string;
  siteId: string;
  name: string;
}

export interface AccessScope {
  tenantId: string;
  customerId?: string;
  siteId?: string;
  unitId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// RBAC Phase 2 types
// These match the backend API response shapes exactly.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scope enforcement contract for a role.
 *   global   → user_role.fk_site_id must be NULL       (super_admin)
 *   site     → user_role.fk_site_id must be set        (site_admin)
 *   flexible → either is valid                          (hr_manager)
 */
export type RbacScopeType = 'global' | 'site' | 'flexible';

/**
 * One active user_role row joined with rbac_role and frs_site.
 * Returned inside RbacUser.assignments by GET /api/admin/rbac/users.
 */
export interface RbacRoleAssignment {
  /** user_role.pk_user_role_id */
  id: number;
  /** rbac_role.role_name */
  roleName: RbacRoleName;
  /** rbac_role.display_name */
  displayName: string;
  /** rbac_role.scope_type */
  scopeType: RbacScopeType;
  /** user_role.fk_site_id — null means global scope */
  siteId: number | null;
  /** frs_site.site_name joined for display — null when siteId is null */
  siteName: string | null;
  /** user_role.granted_at as ISO string */
  grantedAt: string;
  /** user_role.expires_at as ISO string — null means never expires */
  expiresAt: string | null;
}

/**
 * A user row with all their active RBAC role assignments.
 * Returned by GET /api/admin/rbac/users.
 */
export interface RbacUser {
  /** frs_user.pk_user_id */
  id: number;
  email: string;
  /** frs_user.username */
  name: string;
  /** frs_user.role — old system column, kept for display during migration */
  legacyRole: string;
  assignments: RbacRoleAssignment[];
}

/**
 * A role definition with its full permission list.
 * Returned by GET /api/admin/rbac/roles — used to power the modal preview.
 */
export interface RbacRoleDefinition {
  /** rbac_role.pk_role_id */
  id: number;
  roleName: RbacRoleName;
  displayName: string;
  description: string;
  scopeType: RbacScopeType;
  /** Flat array of permission_code strings from rbac_permission */
  permissions: string[];
}

/**
 * Minimal site record for the scope-selector dropdown in the assign-role modal.
 * Returned by GET /api/admin/rbac/sites (or reuses existing site endpoint).
 */
export interface RbacSiteOption {
  /** frs_site.pk_site_id */
  id: number;
  name: string;
}

export interface UserMembership {
  id: string;
  userId: string;
  role: UserRole;
  permissions: Permission[];
  scope: AccessScope;
  /** Present for RBAC role assignments; undefined for legacy memberships. */
  scopeType?: RbacScopeType;
}

export interface User {
  id: string;
  email: string;
  role: UserRole;
  name: string;
  department?: string;
  createdAt: Date;
}

export interface Employee {
  id: string;
  name: string;
  email: string;
  department: string;
  position: string;
  employeeId: string;
  shift: ShiftType;
  location: string;
  joinDate: Date;
  avatar?: string;
  status: EmployeeStatus;
}

export type ShiftType = 'morning' | 'evening' | 'night' | 'flexible';
export type EmployeeStatus = 'active' | 'inactive';
export type AttendanceStatus = 'present' | 'late' | 'absent' | 'on-break';

export interface AttendanceRecord {
  id: string;
  employeeId: string;
  date: Date;
  checkIn?: Date;
  checkOut?: Date;
  breakStart?: Date;
  breakEnd?: Date;
  status: AttendanceStatus;
  workingHours: number;
  breakDuration: number;
  overtime: number;
  isLate: boolean;
  isEarlyDeparture: boolean;
  deviceId?: string;
  location?: string;
  recognitionAccuracy?: number;

  duration_minutes?: number;}

export interface Device {
  id: string;
  name: string;
  location: string;
  status: 'online' | 'offline' | 'error' | 'Online' | 'Offline' | 'Warning';
  lastActive: Date | string;
  macAddress?: string;
  port?: number;
  serialNumber?: string;
  recognitionAccuracy: number;
  cpuHistory?: number[];
  totalScans?: number;
  errorRate?: number;
  model?: string;
  ipAddress: string;
  type?: 'Camera' | 'Edge Device';
  deviceRole?: string;
  uptime?: number;
  eventsToday?: number;
}

export interface Alert {
  id: string;
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical' | 'Critical' | 'Warning' | 'Info';
  title?: string;
  message: string;
  employeeId?: string;
  deviceId?: string;
  timestamp: Date | string;
  read?: boolean;
}

export interface AuditLog {
  id: string;
  userId: string;
  userName: string;
  action: string;
  details: string;
  timestamp: Date;
  ipAddress: string;
}

export interface DashboardMetrics {
  totalEmployees: number;
  presentToday: number;
  lateToday: number;
  absentToday: number;
  onBreak: number;
  avgWorkingHours: number;
  totalOvertimeHours: number;
  attendanceRate: number;
  punctualityRate: number;
}

export interface AnalyticsData {
  attendanceTrends: TrendData[];
  workingHoursTrends: TrendData[];
  departmentComparison: ComparisonData[];
  hourlyActivity: HourlyData[];
  weeklyPattern: WeeklyData[];
  topPerformers: PerformerData[];
  bottomPerformers: PerformerData[];
}

export interface TrendData {
  date: string;
  value: number;
  label?: string;
}

export interface ComparisonData {
  name: string;
  value: number;
  percentage: number;
}

export interface HourlyData {
  hour: number;
  checkIns: number;
  checkOuts: number;
  active: number;
}

export interface WeeklyData {
  day: string;
  present: number;
  late: number;
  absent: number;
}

export interface PerformerData {
  employeeId: string;
  name: string;
  department: string;
  score: number;
  attendanceRate: number;
  avgWorkingHours: number;
  punctualityRate: number;
}

export interface AIInsight {
  id: string;
  type: 'anomaly' | 'prediction' | 'recommendation' | 'summary';
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
  timestamp: Date;
  data?: any;
  actions?: string[];
}

export interface FilterOptions {
  dateRange: { start: Date; end: Date };
  departments: string[];
  employees: string[];
  shifts: ShiftType[];
  locations: string[];
  status: AttendanceStatus[];
  timeInterval?: 'hourly' | 'daily' | 'weekly' | 'monthly';
}
