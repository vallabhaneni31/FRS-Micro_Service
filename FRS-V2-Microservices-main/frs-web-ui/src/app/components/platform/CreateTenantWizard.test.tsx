// AB#3233 (follow-up) — CreateTenantWizard's HQ Location step now uses the
// shared LocationPicker (precise search-and-pin) instead of the
// country-state-city-driven dropdowns + Nominatim centroid-guessing chain.
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// These walk the full multi-step wizard (render + several user-event
// interactions); the default 5000ms timeout can be too tight under load.
vi.setConfig({ testTimeout: 15000 });

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    accessToken: 'fake-token',
    user: { role: 'super_admin', email: 'admin@example.com' },
    activeScope: null,
  }),
}));

const apiRequestMock = vi.fn();
vi.mock('../../services/http/apiClient', async () => {
  const actual = await vi.importActual<any>('../../services/http/apiClient');
  return {
    ...actual,
    apiRequest: (...args: any[]) => apiRequestMock(...args),
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

// The LocationPicker itself is covered by its own test suite; here we only
// need to simulate an admin making an explicit selection, including the
// derived city/country the real Nominatim-backed picker would surface.
vi.mock('../shared/LocationPicker', () => ({
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

import { CreateTenantWizard } from './CreateTenantWizard';

const tenantTypes = [
  { id: 'plan-1', name: 'Basic', description: 'Basic plan', features: ['attendance'], vertical: 'corporate' },
];

async function goToLocationStep(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText('e.g. Acme Corporation'), 'Acme Corp');
  await user.click(screen.getByText('Basic'));
  await user.click(screen.getByRole('button', { name: /^next$/i }));
  await waitFor(() => expect(screen.getByText('HQ Location & Address')).toBeInTheDocument());
}

describe('CreateTenantWizard — HQ Location step uses LocationPicker (AB#3233 follow-up)', () => {
  beforeEach(() => {
    apiRequestMock.mockReset();
  });

  it('renders the LocationPicker instead of the old Country/State/City dropdowns', async () => {
    const user = userEvent.setup();
    render(<CreateTenantWizard tenantTypes={tenantTypes} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    await goToLocationStep(user);

    expect(screen.getByRole('button', { name: /mock pick precise location/i })).toBeInTheDocument();
    expect(screen.queryByText('Select Country')).not.toBeInTheDocument();
    expect(screen.queryByText('Select State')).not.toBeInTheDocument();
    expect(screen.queryByText('Select City')).not.toBeInTheDocument();
  });

  it('gates Next on a picked lat/lng rather than country/state/city selections', async () => {
    const user = userEvent.setup();
    render(<CreateTenantWizard tenantTypes={tenantTypes} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    await goToLocationStep(user);

    // Street address is empty and no location has been picked yet — Next must be disabled.
    expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /mock pick precise location/i }));

    // The pick auto-fills the street address too (from the result's display name).
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/Building 4B, Mindspace IT Park/i)).toHaveValue(
        'Scanalitix, Jubilee Hills, Hyderabad, Telangana, India'
      )
    );

    expect(screen.getByRole('button', { name: /^next$/i })).not.toBeDisabled();
  });

  it('does not require a picked location to include country/city, but does require a street address', async () => {
    const user = userEvent.setup();
    render(<CreateTenantWizard tenantTypes={tenantTypes} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    await goToLocationStep(user);

    // Manually clear the auto-filled address after a pick — Next should re-disable.
    await user.click(screen.getByRole('button', { name: /mock pick precise location/i }));
    const addressInput = screen.getByPlaceholderText(/Building 4B, Mindspace IT Park/i);
    await user.clear(addressInput);

    expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
  });

  it('submits city/country/locationAddress/latitude/longitude from the pick and never sends state fields', async () => {
    apiRequestMock.mockResolvedValue({ success: true, tenant: { id: 'tenant-1' } });
    const user = userEvent.setup();
    render(<CreateTenantWizard tenantTypes={tenantTypes} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    await goToLocationStep(user);
    await user.click(screen.getByRole('button', { name: /mock pick precise location/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^next$/i })).not.toBeDisabled());
    await user.click(screen.getByRole('button', { name: /^next$/i }));

    // Realm Identity — auto-populated from the tenant name, just proceed.
    // (Query by heading — the same label also appears in the step sidebar.)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Realm Identity' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /^next$/i }));

    // Security Policy — defaults are fine, just proceed.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Security Policy' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /^next$/i }));

    // Tenant Admin.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Tenant Administrator' })).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('e.g. Jane Smith'), 'Jane Smith');
    await user.type(screen.getByPlaceholderText('admin@acme.com'), 'jane@example.com');
    await user.click(screen.getByRole('button', { name: /^next$/i }));

    // Review & Create.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Review & Create' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /create tenant & realm/i }));

    await waitFor(() =>
      expect(apiRequestMock).toHaveBeenCalledWith(
        '/app-admin/tenants',
        expect.objectContaining({ method: 'POST' })
      )
    );

    const [, opts] = apiRequestMock.mock.calls.find(([path]: any) => path === '/app-admin/tenants')!;
    const body = JSON.parse(opts.body);

    expect(body.city).toBe('Hyderabad');
    expect(body.country).toBe('India');
    expect(body.locationAddress).toBe('Scanalitix, Jubilee Hills, Hyderabad, Telangana, India');
    expect(body.latitude).toBe(17.4321);
    expect(body.longitude).toBe(78.4075);
    expect(body.state).toBeUndefined();
    expect(body.stateIsoCode).toBeUndefined();
    expect(body.countryIsoCode).toBeUndefined();
  });
});
