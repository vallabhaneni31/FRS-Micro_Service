import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// specs/0003-zone-analytics — Task 12: 4 lazy Zone Analytics pages registered
// in PAGE_REGISTRY, each resolves without a full page reload.

const navigation = [
  { key: 'zone_analytics.overview', label: 'Overview Dashboard', icon: 'MapPin', sortOrder: 90 },
  { key: 'zone_analytics.deep_dive', label: 'Zone Deep-Dive', icon: 'MapPin', sortOrder: 91 },
  { key: 'zone_analytics.compare', label: 'Compare Zones', icon: 'MapPin', sortOrder: 92 },
  { key: 'zone_analytics.movement', label: 'Employee Movement', icon: 'MapPin', sortOrder: 93 },
];

vi.mock('../contexts/ManifestContext', () => ({
  useManifest: () => ({
    manifest: {
      role: 'hr_manager', userId: '1', tenantId: 't1', tenantName: 'Acme', siteId: null,
      navigation, widgets: [], features: [], theme: { primaryColor: '#2563eb', logoUrl: null },
      canManageRoles: [], preferences: {},
    },
    isLoading: false, error: null,
  }),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { role: 'hr_manager' }, translateRole: (r: string) => r, vertical: 'corporate',
    hasFeature: () => false, verticalLabel: (c: string) => c, accessToken: 'fake',
    activeScope: null,
  }),
}));
vi.mock('../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light', setTheme: vi.fn() }) }));
vi.mock('../hooks/useAlerts', () => ({ useAlerts: () => ({ alerts: [], unreadCount: 0, markRead: vi.fn(), dismiss: vi.fn(), dismissAll: vi.fn() }) }));
vi.mock('./shared/Sidebar', () => ({ Sidebar: () => <div data-testid="sidebar-stub" /> }));
vi.mock('./shared/MobileNav', () => ({ MobileNav: () => <div data-testid="mobilenav-stub" /> }));
vi.mock('./shared/AppHeader', () => ({ AppHeader: () => <div data-testid="appheader-stub" /> }));
vi.mock('./shared/AppFooter', () => ({ AppFooter: () => <div data-testid="appfooter-stub" /> }));
vi.mock('./shared/DeviceOfflineBanner', () => ({ DeviceOfflineBanner: () => null }));
vi.mock('./shared/ConnectionStatusBanner', () => ({ ConnectionStatusBanner: () => null }));
// The 4 page components fetch real /api/zones/* data on mount; that's out of
// scope for a route-resolution test (component-level tests for each page's
// own widgets are Task 13-16's job) — stub the 4 lazy modules to a
// distinctive marker so this test only proves PAGE_REGISTRY resolution.
vi.mock('./verticals/corporate/zone-analytics/ZoneAnalyticsOverviewPage', () => ({ ZoneAnalyticsOverviewPage: () => <div>OVERVIEW_PAGE_MARKER</div> }));
vi.mock('./verticals/corporate/zone-analytics/ZoneDeepDivePage', () => ({ ZoneDeepDivePage: () => <div>DEEP_DIVE_PAGE_MARKER</div> }));
vi.mock('./verticals/corporate/zone-analytics/CompareZonesPage', () => ({ CompareZonesPage: () => <div>COMPARE_PAGE_MARKER</div> }));
vi.mock('./verticals/corporate/zone-analytics/EmployeeMovementPage', () => ({ EmployeeMovementPage: () => <div>MOVEMENT_PAGE_MARKER</div> }));

import { DashboardRenderer } from './DashboardRenderer';

async function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dashboard/:page" element={<DashboardRenderer />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('DashboardRenderer — Zone Analytics PAGE_REGISTRY (Task 12, AC 1.5)', () => {
  it('resolves zone_analytics.overview to the Overview Dashboard page', async () => {
    await renderAt('/dashboard/zone_analytics.overview');
    await waitFor(() => expect(screen.getByText('OVERVIEW_PAGE_MARKER')).toBeInTheDocument());
  });

  it('resolves zone_analytics.deep_dive to the Zone Deep-Dive page', async () => {
    await renderAt('/dashboard/zone_analytics.deep_dive');
    await waitFor(() => expect(screen.getByText('DEEP_DIVE_PAGE_MARKER')).toBeInTheDocument());
  });

  it('resolves zone_analytics.compare to the Compare Zones page', async () => {
    await renderAt('/dashboard/zone_analytics.compare');
    await waitFor(() => expect(screen.getByText('COMPARE_PAGE_MARKER')).toBeInTheDocument());
  });

  it('resolves zone_analytics.movement to the Employee Movement page', async () => {
    await renderAt('/dashboard/zone_analytics.movement');
    await waitFor(() => expect(screen.getByText('MOVEMENT_PAGE_MARKER')).toBeInTheDocument());
  });
});
