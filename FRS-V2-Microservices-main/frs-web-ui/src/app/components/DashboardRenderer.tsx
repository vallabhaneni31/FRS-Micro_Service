import React, { useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useManifest } from '../contexts/ManifestContext';
import { Sidebar } from './shared/Sidebar';
import { MobileNav } from './shared/MobileNav';
import { AppHeader } from './shared/AppHeader';
import { AppFooter } from './shared/AppFooter';
import { Loader2, AlertTriangle } from 'lucide-react';
import { cn } from './ui/utils';
import { getIcon } from './shared/iconRegistry';
import { applyNavGrouping } from './shared/navGrouping';
import { NavItem } from '../types/manifest';
import { PageErrorBoundary } from './shared/PageErrorBoundary';
import { useAlerts } from '../hooks/useAlerts';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';

// ── Page registry ─────────────────────────────────────────────────────────
// All page components are lazy-loaded so each role's pages become separate
// chunks, reducing the initial bundle from ~2 MiB to the shared shell only.
import { DeviceOfflineBanner } from './shared/DeviceOfflineBanner';
import { ConnectionStatusBanner } from './shared/ConnectionStatusBanner';

const lazy = <T extends { [k: string]: React.FC }>(
  load: () => Promise<T>,
  key: keyof T
): React.LazyExoticComponent<React.FC> =>
  React.lazy(() =>
    load()
      .then(m => {
        if (typeof window !== 'undefined') {
          window.sessionStorage.removeItem('__frs_chunk_reload__');
        }
        return { default: m[key] as React.FC };
      })
      .catch((error) => {
        const message = String(error?.message ?? error);
        const isChunkLoadFailure =
          message.includes('Failed to fetch dynamically imported module') ||
          message.includes('Loading chunk') ||
          message.includes('ChunkLoadError') ||
          message.includes('Importing a module script failed');

        if (isChunkLoadFailure && typeof window !== 'undefined') {
          const reloadFlag = '__frs_chunk_reload__';
          if (!window.sessionStorage.getItem(reloadFlag)) {
            window.sessionStorage.setItem(reloadFlag, '1');
            window.location.reload();
            return new Promise<never>(() => { });
          }
        }

        throw error;
      })
  );

const SuperAdminDashboard = lazy(() => import('./platform/SuperAdminDashboard'), 'SuperAdminDashboard');
const TenantManagement = lazy(() => import('./platform/TenantManagement'), 'TenantManagement');
const TenantTypeManagement = lazy(() => import('./platform/TenantTypeManagement'), 'TenantTypeManagement');
const SuperAdminAnalytics = lazy(() => import('./platform/SuperAdminAnalytics'), 'SuperAdminAnalytics');
const SuperAdminActivityLog = lazy(() => import('./platform/SuperAdminActivityLog'), 'SuperAdminActivityLog');
const SiteManagement = lazy(() => import('./verticals/corporate/admin/SiteManagement'), 'SiteManagement');
const UserManagement = lazy(() => import('./verticals/corporate/admin/UserManagement'), 'UserManagement');
const UserRoleManagement = lazy(() => import('./verticals/corporate/admin/UserRoleManagement'), 'UserRoleManagement');
const SystemHealth = lazy(() => import('./verticals/corporate/admin/SystemHealth'), 'SystemHealth');
const PeopleManagement = lazy(() => import('./verticals/corporate/admin/PeopleManagement'), 'PeopleManagement');
const VisitorManagement = lazy(() => import('./verticals/corporate/admin/VisitorManagement'), 'VisitorManagement');
const OperationsConsole = lazy(() => import('./verticals/corporate/admin/OperationsConsole'), 'OperationsConsole');
const LogsAndSettings = lazy(() => import('./verticals/corporate/admin/LogsAndSettings'), 'LogsAndSettings');
const ScheduledReports = lazy(() => import('./verticals/corporate/admin/ScheduledReports'), 'ScheduledReports');
const DeviceManagement = lazy(() => import('./verticals/corporate/admin/DeviceManagement'), 'DeviceManagement');
const SiteAdminOverview = lazy(() => import('./verticals/corporate/admin/SiteAdminOverview'), 'SiteAdminOverview');
const TenantAdminOverview = lazy(() => import('./verticals/corporate/tenant-admin/TenantAdminOverview'), 'TenantAdminOverview');
const TenantAdminUsers = lazy(() => import('./verticals/corporate/tenant-admin/TenantAdminUsers'), 'TenantAdminUsers');
const TenantAdminAnalytics = lazy(() => import('./verticals/corporate/tenant-admin/TenantAdminAnalytics'), 'TenantAdminAnalytics');
const TenantAdminBranches = lazy(() => import('./verticals/corporate/tenant-admin/TenantAdminBranches'), 'TenantAdminBranches');
const TenantUiSettings = lazy(() => import('./verticals/corporate/tenant-admin/TenantUiSettings'), 'TenantUiSettings');
const TenantGroups = lazy(() => import('./verticals/corporate/tenant-admin/TenantGroups'), 'TenantGroups');
const SmartDashboard = lazy(() => import('./verticals/corporate/dashboard/SmartDashboard'), 'SmartDashboard');
const AttendanceStatusDashboard = lazy(() => import('./verticals/corporate/hr/AttendanceStatusDashboard'), 'AttendanceStatusDashboard');
const HRManagerDashboard = lazy(() => import('./verticals/corporate/hr/HRManagerDashboard'), 'HRManagerDashboard');
const RemoteEnrollmentManager = lazy(() => import('./verticals/corporate/hr/RemoteEnrollmentManager'), 'RemoteEnrollmentManager');
const DepartmentShiftManagement = lazy(() => import('./verticals/corporate/hr/DepartmentShiftManagement'), 'DepartmentShiftManagement');
const EmployeeAnalytics = lazy(() => import('./verticals/corporate/hr/EmployeeAnalytics'), 'EmployeeAnalytics');
const StudentsPage = React.lazy(() => import('./verticals/education/StudentsPage'));
const Workspace = lazy(() => import('./workspace/Workspace'), 'Workspace');

const HRMSManagement = lazy(() => import('./verticals/corporate/admin/HRMSManagement'), 'HRMSManagement');

// Zone Analytics (specs/0003-zone-analytics) — HR-only, 4 views under one
// grouped sidebar section (Req 1).
const ZoneAnalyticsOverviewPage = lazy(() => import('./verticals/corporate/zone-analytics/ZoneAnalyticsOverviewPage'), 'ZoneAnalyticsOverviewPage');
const ZoneDeepDivePage = lazy(() => import('./verticals/corporate/zone-analytics/ZoneDeepDivePage'), 'ZoneDeepDivePage');
const CompareZonesPage = lazy(() => import('./verticals/corporate/zone-analytics/CompareZonesPage'), 'CompareZonesPage');
const EmployeeMovementPage = lazy(() => import('./verticals/corporate/zone-analytics/EmployeeMovementPage'), 'EmployeeMovementPage');

// Retail vertical pages
const RetailDashboard      = lazy(() => import('./verticals/retail/RetailDashboard'),      'RetailDashboard');
const RetailAnalytics      = lazy(() => import('./verticals/retail/RetailAnalytics'),      'RetailAnalytics');
const RetailReports        = lazy(() => import('./verticals/retail/RetailReports'),        'RetailReports');
const RetailStoreSettings  = lazy(() => import('./verticals/retail/RetailStoreSettings'),  'RetailStoreSettings');
const RetailLiveView       = lazy(() => import('./verticals/retail/RetailLiveView'),       'RetailLiveView');
const RetailStoreManagement = lazy(() => import('./verticals/retail/RetailStoreManagement'), 'RetailStoreManagement');
const RetailUserManagement  = lazy(() => import('./verticals/retail/RetailUserManagement'),  'RetailUserManagement');
const RetailDeviceManagement = lazy(() => import('./verticals/retail/RetailDeviceManagement'), 'RetailDeviceManagement');

// Transport vertical pages
const TransportDashboard = lazy(() => import('./verticals/transport/TransportDashboard'), 'TransportDashboard');
const TransportDepots    = lazy(() => import('./verticals/transport/Depots'),              'Depots');
const TransportAnalytics = lazy(() => import('./verticals/transport/Analytics'),           'Analytics');
const FleetManagement    = lazy(() => import('./verticals/transport/FleetManagement'),    'FleetManagement');
const RouteManagement    = lazy(() => import('./verticals/transport/RouteManagement'),    'RouteManagement');
const TransportRouteMap  = lazy(() => import('./verticals/transport/RouteMap'),           'RouteMap');
const DeviceManagementTransport = lazy(() => import('./verticals/transport/DeviceManagement'), 'DeviceManagement');
const EventHistory       = lazy(() => import('./verticals/transport/EventHistory'),       'EventHistory');
const UserManagementTransport = lazy(() => import('./verticals/transport/UserManagement'), 'UserManagement');

// Operations Manager (hr_manager, BUS-scoped) — Track B UI
const OperationsDashboard = lazy(() => import('./verticals/transport/OperationsDashboard'), 'OperationsDashboard');
const OperationsBusStops  = lazy(() => import('./verticals/transport/OperationsBusStops'),  'OperationsBusStops');
const OperationsEnrollment = lazy(() => import('./verticals/transport/OperationsEnrollment'), 'OperationsEnrollment');
const OperationsAttendance = lazy(() => import('./verticals/transport/OperationsAttendance'), 'OperationsAttendance');
const OperationsAnalytics  = lazy(() => import('./verticals/transport/OperationsAnalytics'),  'OperationsAnalytics');
const OperationsSettings   = lazy(() => import('./verticals/transport/OperationsSettings'),   'OperationsSettings');

// Workspace rollout: gated per-tenant on the 'workspace_tree' feature flag
// (TenantUiSettings.tsx), so canary tenants opt in before GA. Flag OFF
// reproduces the exact pre-Workspace behavior for each key, bug included —
// `workforce` never vertical-branched (site_admin/Principal always saw
// PeopleManagement, mislabeled "Students" by VERTICAL_LABEL_MAP), while
// `employees` correctly dispatched by vertical. That inconsistency is fixed
// as a side effect of opting into Workspace (both keys become vertically
// aware there), not silently changed for everyone ahead of the flag.
const WorkforceOrWorkspace: React.FC = () => {
  const { hasFeature } = useAuth();
  return hasFeature('workspace_tree') ? <Workspace /> : <PeopleManagement />;
};
const EmployeesOrWorkspace: React.FC = () => {
  const { vertical, hasFeature } = useAuth();
  if (hasFeature('workspace_tree')) return <Workspace />;
  return vertical === 'education' ? <StudentsPage /> : <PeopleManagement />;
};

// Keys with '/' are role-scoped: resolveComponent checks `${role}/${pageKey}` first.
const PAGE_REGISTRY = new Map<string, React.ComponentType>([
  // super_admin
  ['super_admin/overview', SuperAdminDashboard],
  ['overview', SmartDashboard],
  ['tenants', TenantManagement],
  ['tenant_types', TenantTypeManagement],
  // ['super_admin/analytics', SuperAdminAnalytics],
  ['super_admin/users', UserManagement],
  ['super_admin/activity_log', SuperAdminActivityLog],
  ['activity_log', SuperAdminActivityLog],
  ['sites', SiteManagement],
  ['system', SystemHealth],

  // tenant_admin (scoped overrides first)
  ['tenant_admin/dashboard', TenantAdminOverview],
  ['tenant_admin/branches', TenantAdminBranches],
  ['tenant_admin/analytics', TenantAdminAnalytics],
  ['tenant_admin/users', TenantAdminUsers],
  ['dashboard', SmartDashboard],
  ['branches', SiteManagement],
  ['devices', DeviceManagement],
  ['settings', TenantUiSettings],
  ['groups', TenantGroups],

  // hr_manager (scoped overrides)
  ['hr_manager/dashboard', HRManagerDashboard],
  ['hr_manager/analytics', EmployeeAnalytics],

  // site_admin (scoped overrides)
  ['site_admin/overview', SmartDashboard],
  ['workforce', WorkforceOrWorkspace],
  ['operations', OperationsConsole],
  ['access', UserRoleManagement],
  ['logs', LogsAndSettings],

  // shared — correct components per feature
  ['attendance', AttendanceStatusDashboard],
  ['employees', EmployeesOrWorkspace],   // education tenants get StudentsPage; Workspace when the tenant's workspace_tree flag is on
  ['visitors', VisitorManagement],   // visitor directory dashboard
  ['reports', ScheduledReports],
  ['enrollment', RemoteEnrollmentManager],
  ['configuration', DepartmentShiftManagement],
  ['configurations', HRMSManagement],

  // retail vertical
  ['retail_dashboard', RetailDashboard],
  ['retail_analytics', RetailAnalytics],
  ['retail_live',      RetailLiveView],
  ['retail_reports',   RetailReports],
  ['retail_settings',  RetailStoreSettings],
  ['retail_stores',    RetailStoreManagement],
  ['retail_users',     RetailUserManagement],
  ['retail_devices',   RetailDeviceManagement],

  // transport vertical
  ['transport_dashboard', TransportDashboard],
  ['transport_depots',    TransportDepots],
  ['transport_analytics', TransportAnalytics],
  ['transport_fleet',     FleetManagement],
  ['transport_routes',    RouteManagement],
  ['transport_routemap',  TransportRouteMap],
  ['transport_devices',   DeviceManagementTransport],
  ['transport_events',    EventHistory],
  ['transport_users',     UserManagementTransport],

  // Operations Manager (hr_manager, BUS-scoped) — scoped overrides for
  // transport_dashboard/transport_analytics keep tenant_admin's and
  // site_admin's existing shared components completely untouched.
  ['hr_manager/transport_dashboard', OperationsDashboard],
  ['transport_stops',       OperationsBusStops],
  ['transport_enrollment',  OperationsEnrollment],
  ['transport_attendance',  OperationsAttendance],
  ['hr_manager/transport_analytics', OperationsAnalytics],
  ['transport_settings',    OperationsSettings],

  // Zone Analytics (specs/0003-zone-analytics) — HR-only, seeded only for
  // hr_manager (frs-fe-api/src/db/migrations/028_seed_zone_analytics_nav.sql).
  ['zone_analytics.overview', ZoneAnalyticsOverviewPage],
  ['zone_analytics.deep_dive', ZoneDeepDivePage],
  ['zone_analytics.compare', CompareZonesPage],
  ['zone_analytics.movement', EmployeeMovementPage],
]);

const NotFound: React.FC<{ pageKey: string }> = ({ pageKey }) => (
  <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-3">
    <AlertTriangle className="w-8 h-8 opacity-50" />
    <p className="text-sm">
      Page <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{pageKey}</code> not yet implemented.
    </p>
  </div>
);

// Shown when the role resolves to zero navigation items (nav_item unseeded for
// this role). Without this the user gets a blank sidebar + an empty/"not
// implemented" body with no explanation of why.
const NoNavConfigured: React.FC<{ role?: string }> = ({ role }) => (
  <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-2 text-center px-6">
    <AlertTriangle className="w-8 h-8 opacity-50" />
    <p className="text-sm font-medium text-foreground">No menu is configured for your role{role ? ` (${role})` : ''}.</p>
    <p className="text-xs text-muted-foreground">Ask an administrator to set up navigation for this account.</p>
  </div>
);

const PageFallback = () => (
  <div role="status" aria-label="Loading page" className="flex items-center justify-center h-64">
    <Loader2 className="w-6 h-6 animate-spin text-primary" aria-hidden="true" />
  </div>
);
function resolveComponent(pageKey: string, role?: string): React.ComponentType {
  const scoped = role ? PAGE_REGISTRY.get(`${role}/${pageKey}`) : undefined;
  const LazyPage = scoped ?? PAGE_REGISTRY.get(pageKey);
  if (!LazyPage) return () => <NotFound pageKey={pageKey} />;
  return LazyPage;
}

/**
 * Maps a nav key to its URL. The `dashboard` home key is special-cased to the
 * bare `/dashboard` so we never emit the duplicated `/dashboard/dashboard`.
 * Role-scoped keys (containing '/') become `/dashboard/:role/:page`.
 */
function keyToPath(key: string): string {
  if (key === 'dashboard') return '/dashboard';
  const segs = key.split('/');
  return segs.length === 2
    ? `/dashboard/${segs[0]}/${segs[1]}`
    : `/dashboard/${key}`;
}

// ── Sidebar nav adapter ───────────────────────────────────────────────────
/**
 * Per-key label override driven by tenants.vertical. Education tenants see
 * Students/Campuses/Classrooms instead of Employees/Sites/Branches.
 */
const VERTICAL_LABEL_MAP: Record<string, { corporate: string; education: string }> = {
  employees: { corporate: 'Employees', education: 'Students' },
  workforce: { corporate: 'Workforce', education: 'Students' },
  sites: { corporate: 'Sites', education: 'Campuses' },
  branches: { corporate: 'Branches', education: 'Campuses' },
  units: { corporate: 'Units', education: 'Classrooms' },
  configuration: { corporate: 'Departments & Shifts', education: 'Departments & Shifts' },
  // Routes to HRMSManagement (HRMS webhook/sync). The API labels this
  // "Configurations", which reads as a near-duplicate of "configuration"
  // above — override to its real purpose so the two are distinguishable.
  configurations: { corporate: 'HRMS Integration', education: 'HRMS Integration' },
  devices:        { corporate: 'Edge Nodes',       education: 'Edge Nodes' },
};

function toSidebarNav(
  items: NavItem[],
  verticalLabel: (corp: string, edu: string) => string,
  role?: string,
) {
  const sorted = [...items].sort((a, b) => a.sortOrder - b.sortOrder);
  const navList = sorted.filter(item => {
    if (item.key === 'reports' && role === 'hr_manager') return false;
    if (item.key === 'analytics' && role === 'super_admin') return false;
    return !['customers', 'tenant_admins', 'roles'].includes(item.key);
  });

  const hasRetailAnalytics = navList.some(i => i.key === 'retail_analytics');
  const hasRetailReports = navList.some(i => i.key === 'retail_reports');
  if (hasRetailAnalytics && !hasRetailReports) {
    const liveIdx = navList.findIndex(i => i.key === 'retail_live');
    const insertIdx = liveIdx !== -1 ? liveIdx + 1 : navList.findIndex(i => i.key === 'retail_analytics') + 1;
    navList.splice(insertIdx, 0, {
      key: 'retail_reports',
      label: 'Reports',
      icon: 'FileText',
      sortOrder: 26,
    });
  }

  const mapped = navList.map(item => {
    const override = VERTICAL_LABEL_MAP[item.key];
    let label = override ? verticalLabel(override.corporate, override.education) : item.label;
    if (item.key === 'retail_analytics') {
      label = 'Insights';
    }
    if (item.key === 'retail_reports') {
      label = 'Reports';
    }
    if (item.key === 'hr_manager/analytics' || (item.key === 'analytics' && role === 'hr_manager')) {
      label = 'Workforce Analytics';
    }
    if (!label || label.trim() === '') {
      const segment = item.key.split('/').pop() || item.key;
      label = segment
        .replace(/[_-]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
    }
    const icon = (item.key === 'hr_manager/analytics' || (item.key === 'analytics' && role === 'hr_manager'))
      ? getIcon('UsersRound')
      : getIcon(item.icon);
    return {
      label,
      icon,
      value: item.key,
      groupKey: item.groupKey,
      groupLabel: item.groupLabel,
      groupBadge: item.groupBadge,
    };
  });

  return applyNavGrouping(mapped);
}

// ── Main renderer ─────────────────────────────────────────────────────────
export const DashboardRenderer: React.FC = () => {
  const { manifest, isLoading, error } = useManifest();
  const { verticalLabel } = useAuth();
  const { theme, setTheme } = useTheme();
  const { alerts, unreadCount, markRead: markAlertsRead, dismiss: dismissAlert, dismissAll: dismissAllAlerts } = useAlerts();
  const navigate = useNavigate();
  // W-01: page key comes from the URL (/dashboard/:page).
  // Role-scoped keys (/dashboard/:role/:page) are joined back with '/'.
  const { page, role } = useParams<{ page?: string; role?: string }>();
  const rawActiveTab = role && page ? `${role}/${page}` : (page ?? '');
  // Bare /dashboard canonically resolves to the 'dashboard' home key when the
  // role has one — this keeps the URL at /dashboard instead of the duplicated
  // /dashboard/dashboard. Roles without a dashboard key fall through to the
  // first-nav redirect effect below.
  const hasDashboardHome = (manifest?.navigation ?? []).some(item => item.key === 'dashboard');
  const activeTab = rawActiveTab || (hasDashboardHome ? 'dashboard' : '');
  const [collapsed, setCollapsed] = React.useState(() =>
    localStorage.getItem('sidebar-collapsed') === 'true'
  );

  useEffect(() => {
    const serverTheme = manifest?.preferences?.theme;
    if (serverTheme && serverTheme !== theme) {
      setTheme(serverTheme, true);
    }
  }, [manifest?.preferences?.theme]);

  useEffect(() => {
    if (activeTab === 'tenant_admins' || activeTab === 'roles') {
      navigate('/dashboard/users', { replace: true });
    }
  }, [activeTab, navigate]);

  // Collapse the legacy /dashboard/dashboard deep-link into the canonical
  // /dashboard so the URL never shows the duplicated segment.
  useEffect(() => {
    if (page === 'dashboard' && !role) {
      navigate('/dashboard', { replace: true });
    }
  }, [page, role, navigate]);

  // If no page in URL, redirect to the first nav item once manifest loads
  useEffect(() => {
    if (manifest?.navigation?.length && !activeTab) {
      const filtered = manifest.navigation.filter(item => {
        if (item.key === 'reports' && manifest.role === 'hr_manager') return false;
        return !['customers', 'tenant_admins', 'roles'].includes(item.key);
      });
      if (filtered.length) {
        navigate(keyToPath(filtered[0].key), { replace: true });
      }
    }
  }, [manifest, activeTab]);

  const navItems = useMemo(
    () => toSidebarNav(manifest?.navigation ?? [], verticalLabel, manifest?.role),
    [manifest?.navigation, verticalLabel, manifest?.role]
  );

  if (isLoading) {
    return (
      <div role="status" aria-label="Loading dashboard" className="app-canvas min-h-screen flex items-center justify-center text-foreground">
        <div className="glass-card flex flex-col items-center gap-3 rounded-2xl border px-10 py-8">
          <Loader2 className="w-8 h-8 animate-spin text-primary" aria-hidden="true" />
          <p className="text-sm tracking-wide uppercase text-muted-foreground">Loading dashboard…</p>
        </div>
      </div>
    );
  }

  if (error || !manifest) {
    return (
      <div role="alert" className="app-canvas min-h-screen flex items-center justify-center text-foreground">
        <div className="glass-card flex flex-col items-center gap-3 rounded-2xl border px-10 py-8 text-center">
          <AlertTriangle className="w-8 h-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-foreground">{error ?? 'Failed to load dashboard'}</p>
        </div>
      </div>
    );
  }

  const title = manifest.tenantName
    ? `${manifest.tenantName}`
    : 'FRS Platform';

  // Resolve the page component, guarding two routing edge cases that otherwise
  // surface as the "Page not yet implemented" message:
  //   1. No nav configured for the role  → explicit empty state.
  //   2. activeTab not yet set (bare /dashboard for a role without a 'dashboard'
  //      home key) → show the loading fallback while the first-nav redirect
  //      effect runs, instead of resolving the empty key to NotFound.
  const PageComponent: React.ComponentType =
    navItems.length === 0
      ? () => <NoNavConfigured role={manifest.role} />
      : activeTab
        ? resolveComponent(activeTab, manifest.role)
        : PageFallback;

  // Title of the active page, derived from the nav item, for the header breadcrumb.
  const activeNav = navItems.find((n) => n.value === activeTab);
  const pageTitle =
    activeNav?.label ??
    (activeTab
      ? (activeTab.split('/').pop() || activeTab).replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      : title);

  return (
    <div
      className={cn('app-canvas relative min-h-screen flex flex-col')}
      style={{ '--primary': manifest.theme.primaryColor } as React.CSSProperties}
    >
      <DeviceOfflineBanner />
      <ConnectionStatusBanner />
      <Sidebar
        title={title}
        navigationItems={navItems}
        activeTab={activeTab}
        onNavigate={(key) => navigate(keyToPath(key))}
        isCollapsed={collapsed}
        onToggleCollapse={() => setCollapsed(c => {
          const next = !c;
          localStorage.setItem('sidebar-collapsed', String(next));
          return next;
        })}
      />
      <AppHeader
        pageTitle={pageTitle}
        collapsed={collapsed}
        unreadAlerts={unreadCount}
        liveAlerts={alerts}
        onMarkRead={markAlertsRead}
        onDismiss={dismissAlert}
        onDismissAll={dismissAllAlerts}
      />
      <MobileNav
        title={title}
        unreadAlerts={unreadCount}
        navigationItems={navItems}
        activeTab={activeTab}
        onNavigate={(key) => navigate(keyToPath(key))}
        liveAlerts={alerts}
        onMarkRead={markAlertsRead}
        onDismiss={dismissAlert}
        onDismissAll={dismissAllAlerts}
      />
      <main
        className={cn(
          'flex-1 px-4 md:px-8 pt-20 md:pt-24 pb-32 transition-all duration-300',
          collapsed ? 'md:ml-20' : 'md:ml-64'
        )}
      >
        <div className="max-w-[1600px] mx-auto">
          <PageErrorBoundary pageName={activeTab}>
            <React.Suspense fallback={<PageFallback />}>
              <PageComponent />
            </React.Suspense>
          </PageErrorBoundary>
        </div>
      </main>
      <AppFooter collapsed={collapsed} />
    </div>
  );
};
