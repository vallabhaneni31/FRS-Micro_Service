import React from 'react';
import { MemoryRouter } from 'react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ accessToken: 'fake-token' }),
}));

vi.mock('../../services/http/apiClient', () => ({
  apiRequest: vi.fn().mockResolvedValue({
    summary: {
      tenants: 6, customers: 3, sites: 4, users: 10,
      edgeNodes: 2, edgeNodesOnline: 2, cameras: 7, camerasOnline: 6,
    },
    deviceStatus: [],
    systemHealth: {
      total_scans: 128340,
      avg_accuracy: 96.4,
      active_alerts: 3,
      critical_alerts: 1,
    },
    recentAlerts: [],
    tenantActivity: [],
    mapLocations: [],
  }),
}));

vi.mock('./OperationalWorkMap', () => ({
  OperationalWorkMap: () => <div data-testid="mock-map" />,
}));

import { SuperAdminDashboard } from './SuperAdminDashboard';

describe('SuperAdminDashboard — Core System Health card', () => {
  it('renders core system health metrics', async () => {
    render(
      <MemoryRouter>
        <SuperAdminDashboard />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText('Global Operational Map')).toBeInTheDocument());

    expect(screen.getByText('EDGE NODES')).toBeInTheDocument();
    expect(screen.getAllByText('CAMERAS').length).toBeGreaterThan(0);
    expect(screen.getAllByText('ONLINE').length).toBeGreaterThan(0);
  });

  it('renders overall health status', async () => {
    render(
      <MemoryRouter>
        <SuperAdminDashboard />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText('98% Overall Health')).toBeInTheDocument());
  });
});
