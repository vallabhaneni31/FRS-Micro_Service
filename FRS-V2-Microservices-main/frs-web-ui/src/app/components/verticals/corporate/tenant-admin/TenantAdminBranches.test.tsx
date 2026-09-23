// AB#3233 — Precise location picker: Save must be blocked until an admin
// picks a real latitude/longitude via the new LocationPicker (search result
// selection or marker drag), and the picked coordinates must be submitted.
// Follow-up (AB#3233): the old hardcoded Region/State/City dropdowns are
// gone — country/city are free-text inputs auto-filled from the pick.
import React from 'react';
import { MemoryRouter } from 'react-router';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// These are full-form integration tests (render + several user-event
// interactions); the default 5000ms timeout can be too tight under load.
vi.setConfig({ testTimeout: 15000 });

vi.mock('../../../../contexts/AuthContext', () => ({
  useAuth: () => ({
    accessToken: 'fake-token',
    user: { role: 'tenant_admin', email: 'admin@example.com' },
    isAuthenticated: true,
    verticalLabel: (corporate: string) => corporate,
    activeScope: null,
  }),
}));

const apiRequestMock = vi.fn();
vi.mock('../../../../services/http/apiClient', () => ({
  apiRequest: (...args: any[]) => apiRequestMock(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

// The LocationPicker itself is covered by its own test suite; here we only
// need to simulate an admin making an explicit selection, including the
// derived city/state/country the real Nominatim-backed picker would surface.
vi.mock('../../../shared/LocationPicker', () => ({
  LocationPicker: ({ onLocationSelected }: any) => (
    <button
      type="button"
      onClick={() => onLocationSelected({
        latitude: 17.4321,
        longitude: 78.4075,
        displayName: 'Scanalitix, Jubilee Hills, Hyderabad, Telangana, India',
        city: 'Hyderabad',
        state: 'Telangana',
        country: 'India',
      })}
    >
      Mock Pick Precise Location
    </button>
  ),
}));

import { TenantAdminBranches } from './TenantAdminBranches';
import { toast } from 'sonner';

function mockApiForInitialLoad() {
  apiRequestMock.mockImplementation((path: string) => {
    if (path === '/site-management/sites') return Promise.resolve({ success: true, sites: [] });
    return Promise.resolve({});
  });
}

async function openCreateDialog() {
  render(
    <MemoryRouter>
      <TenantAdminBranches />
    </MemoryRouter>
  );

  const user = userEvent.setup();
  await waitFor(() => expect(apiRequestMock).toHaveBeenCalledWith('/site-management/sites', expect.anything()));

  await user.click(screen.getByRole('button', { name: /add new branch/i }));
  await waitFor(() => expect(screen.getByText('Create New Branch')).toBeInTheDocument());

  return user;
}

async function fillRequiredFieldsWithoutPickingLocation(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText('Midtown Hub'), 'Test Branch');

  // Country / City are now free-text inputs (no longer LOCATION_DATA-backed
  // selects) — fireEvent (not user.type) since we only need the final value.
  fireEvent.change(screen.getByPlaceholderText('Country'), { target: { value: 'India' } });
  fireEvent.change(screen.getByPlaceholderText('City'), { target: { value: 'Hyderabad' } });
  fireEvent.change(screen.getByPlaceholderText('e.g. Suite 402, 123 Main St'), { target: { value: 'Road 36' } });

  // Timezone is a hand-rolled dropdown, not a Radix combobox.
  const tzButton = screen.getByText(/Select timezone|Asia\/Kolkata/);
  await user.click(tzButton);
  const utcOption = await screen.findByText(/UTC — Coordinated Universal Time/);
  await user.click(utcOption);
}

describe('TenantAdminBranches — precise location required to save (AB#3233)', () => {
  beforeEach(() => {
    apiRequestMock.mockReset();
    (toast.success as any).mockClear();
    (toast.error as any).mockClear();
  });

  it('blocks save when no location has been picked', async () => {
    mockApiForInitialLoad();
    const user = await openCreateDialog();
    await fillRequiredFieldsWithoutPickingLocation(user);

    await user.click(screen.getByRole('button', { name: /create branch/i }));

    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/precise location/i));
    expect(apiRequestMock).not.toHaveBeenCalledWith(
      '/site-management/sites',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('saves and submits the picked latitude/longitude once a location is chosen', async () => {
    mockApiForInitialLoad();
    const user = await openCreateDialog();
    await fillRequiredFieldsWithoutPickingLocation(user);

    await user.click(screen.getByRole('button', { name: /mock pick precise location/i }));

    apiRequestMock.mockImplementation((path: string, opts?: any) => {
      if (path === '/site-management/sites' && opts?.method === 'POST') {
        return Promise.resolve({ success: true });
      }
      if (path === '/site-management/sites') return Promise.resolve({ success: true, sites: [] });
      return Promise.resolve({});
    });

    await user.click(screen.getByRole('button', { name: /create branch/i }));

    await waitFor(() =>
      expect(apiRequestMock).toHaveBeenCalledWith(
        '/site-management/sites',
        expect.objectContaining({ method: 'POST' })
      )
    );
    const [, opts] = apiRequestMock.mock.calls.find(
      ([path, o]: any) => path === '/site-management/sites' && o?.method === 'POST'
    )!;
    const body = JSON.parse(opts.body);
    expect(body.latitude).toBe(17.4321);
    expect(body.longitude).toBe(78.4075);
    expect(body.state).toBeUndefined();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('auto-fills the editable Country, City, and Street Address fields from the picked location', async () => {
    mockApiForInitialLoad();
    const user = await openCreateDialog();

    await user.type(screen.getByPlaceholderText('Midtown Hub'), 'Test Branch');
    await user.click(screen.getByRole('button', { name: /mock pick precise location/i }));

    expect(screen.getByPlaceholderText('Country')).toHaveValue('India');
    expect(screen.getByPlaceholderText('City')).toHaveValue('Hyderabad');
    expect(screen.getByPlaceholderText('e.g. Suite 402, 123 Main St')).toHaveValue(
      'Scanalitix, Jubilee Hills, Hyderabad, Telangana, India'
    );

    // The auto-filled fields stay editable — an admin can correct Nominatim's spelling.
    const countryInput = screen.getByPlaceholderText('Country');
    await user.clear(countryInput);
    await user.type(countryInput, 'Bharat');
    expect(countryInput).toHaveValue('Bharat');
  });
});
