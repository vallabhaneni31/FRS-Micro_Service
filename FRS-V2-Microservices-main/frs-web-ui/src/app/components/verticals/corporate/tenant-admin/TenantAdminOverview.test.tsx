// AB#3233 — a site's real, stored latitude/longitude must never be
// overwritten by the legacy AREA_COORDINATES text-match guess. The guess is
// a fallback ONLY for sites that still have no stored coordinates at all
// (matches OperationalWorkMap's getCoords priority order).
import React from 'react';
import { MemoryRouter } from 'react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../contexts/AuthContext', () => ({
  useAuth: () => ({
    accessToken: 'fake-token',
    isAuthenticated: true,
    can: () => true,
    activeScope: null,
  }),
}));

vi.mock('../../../../hooks/useLiveData', () => ({
  useLiveData: () => ({ employees: [], attendance: [], devices: [], alerts: [], isLoading: false, error: null }),
}));

vi.mock('../../../../engine/RealTimeEngine', () => ({
  realtimeEngine: { subscribe: () => () => {}, connectSocket: () => {} },
  RteEventType: { EMPLOYEE_ENTRY: 'EMPLOYEE_ENTRY' },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: any) => <div data-testid="map-container">{children}</div>,
  TileLayer: () => null,
  CircleMarker: ({ center, children }: any) => (
    <div data-testid="circle-marker" data-center={JSON.stringify(center)}>
      {children}
    </div>
  ),
  Tooltip: ({ children }: any) => <div>{children}</div>,
  useMap: () => ({ zoomIn: vi.fn(), zoomOut: vi.fn() }),
}));

// A site whose address text contains an AREA_COORDINATES match ("Jubilee Hills")
// but that already has real, precise, previously-saved coordinates from the
// new LocationPicker — these must win over the text-match guess.
const REAL_LAT = 17.41234;
const REAL_LON = 78.41234;

const apiRequestMock = vi.fn((path: string) => {
  if (path === '/site-management/sites') {
    return Promise.resolve({
      success: true,
      sites: [
        {
          pk_site_id: 501,
          site_name: 'Scanalitix',
          city: 'Hyderabad',
          country: 'India',
          latitude: REAL_LAT,
          longitude: REAL_LON,
          location_address: 'Scanalitix, Jubilee Hills, Road No. 36',
          status: 'active',
          device_count: 4,
        },
      ],
    });
  }
  if (path === '/live/metrics') return Promise.resolve({});
  if (path === '/devices/edge-devices') return Promise.resolve({ data: [] });
  if (path === '/live/trends/weekly') return Promise.resolve({ data: [] });
  return Promise.resolve({});
});

vi.mock('../../../../services/http/apiClient', () => ({
  apiRequest: (...args: any[]) => apiRequestMock(...args),
}));

import { TenantAdminOverview } from './TenantAdminOverview';

describe('TenantAdminOverview — real coordinates are never overwritten by a text-match guess (AB#3233)', () => {
  it('plots the site at its real, stored latitude/longitude instead of the Jubilee Hills area guess', async () => {
    render(
      <MemoryRouter>
        <TenantAdminOverview />
      </MemoryRouter>
    );

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledWith('/site-management/sites', expect.anything()));

    await waitFor(() => {
      const markers = screen.getAllByTestId('circle-marker');
      const hasRealCoords = markers.some((m) => {
        const center = JSON.parse(m.getAttribute('data-center') || '[]');
        return center[0] === REAL_LAT && center[1] === REAL_LON;
      });
      expect(hasRealCoords).toBe(true);
    });

    // The AREA_COORDINATES guess for "jubilee hills" (17.4319, 78.4072) must not appear.
    const markers = screen.getAllByTestId('circle-marker');
    const hasGuessedCoords = markers.some((m) => {
      const center = JSON.parse(m.getAttribute('data-center') || '[]');
      return center[0] === 17.4319 && center[1] === 78.4072;
    });
    expect(hasGuessedCoords).toBe(false);
  });
});
