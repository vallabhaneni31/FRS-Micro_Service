// AB#3270 — Reset Password dialog now sends a self-service reset link
//
// The admin no longer types a new password directly: clicking "Reset
// Password" opens a confirmation dialog (no password field), and confirming
// calls PUT /users/:id/password with no body, which now makes the backend
// send the target user a self-service reset-link email instead of setting
// the password. This covers the frontend half: the dialog has no password
// input, and a successful/failed request each surface the expected toast.
import React from 'react';
import { MemoryRouter } from 'react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUser = {
  id: '1', name: 'Alice Admin', email: 'alice@example.com', role: 'hr_manager', is_active: true,
};

vi.mock('../../../../contexts/AuthContext', () => ({
  useAuth: () => ({
    accessToken: 'fake-token',
    verticalLabel: (label: string) => label,
    translateRole: (r: string) => r,
    user: { email: 'admin@example.com', role: 'tenant_admin' },
    activeScope: null,
  }),
}));

vi.mock('../../../../contexts/ManifestContext', () => ({
  useManifest: () => ({ manifest: { role: 'tenant_admin' } }),
}));

const apiRequestMock = vi.fn();
vi.mock('../../../../services/http/apiClient', () => ({
  apiRequest: (...args: any[]) => apiRequestMock(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { UserManagement } from './UserManagement';
import { toast } from 'sonner';

function mockApiForInitialLoad() {
  apiRequestMock.mockImplementation((path: string) => {
    if (path === '/users') return Promise.resolve({ data: [{ pk_user_id: 1, ...mockUser }] });
    if (path === '/live/employees') return Promise.resolve({ data: [] });
    if (path === '/site-management/sites') return Promise.resolve({ success: true, sites: [] });
    return Promise.resolve({});
  });
}

async function openResetDialog() {
  render(
    <MemoryRouter>
      <UserManagement />
    </MemoryRouter>
  );

  await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());

  const user = userEvent.setup();
  await user.click(screen.getByTitle('Reset password'));

  await waitFor(() => expect(screen.getByRole('heading', { name: 'Reset Password' })).toBeInTheDocument());
  return user;
}

describe('UserManagement — Reset Password dialog (AB#3270)', () => {
  beforeEach(() => {
    apiRequestMock.mockReset();
    (toast.success as any).mockClear();
    (toast.warning as any).mockClear();
    (toast.error as any).mockClear();
  });

  it('shows a confirmation dialog with no password field', async () => {
    mockApiForInitialLoad();
    await openResetDialog();

    expect(
      screen.getByText(/Send a password reset link to/i)
    ).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Min 8 chars, uppercase + number')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/new password/i)).not.toBeInTheDocument();
  });

  it('sends the reset link and shows a success toast on confirm', async () => {
    apiRequestMock.mockImplementation((path: string, opts?: any) => {
      if (path === '/users') return Promise.resolve({ data: [{ pk_user_id: 1, ...mockUser }] });
      if (path === '/live/employees') return Promise.resolve({ data: [] });
      if (path === '/site-management/sites') return Promise.resolve({ success: true, sites: [] });
      if (path === '/users/1/password' && opts?.method === 'PUT') {
        expect(opts?.body).toBeUndefined();
        return Promise.resolve({ success: true });
      }
      return Promise.resolve({});
    });

    const user = await openResetDialog();
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Password reset link sent to alice@example.com')
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows an error toast when the request fails', async () => {
    apiRequestMock.mockImplementation((path: string, opts?: any) => {
      if (path === '/users') return Promise.resolve({ data: [{ pk_user_id: 1, ...mockUser }] });
      if (path === '/live/employees') return Promise.resolve({ data: [] });
      if (path === '/site-management/sites') return Promise.resolve({ success: true, sites: [] });
      if (path === '/users/1/password' && opts?.method === 'PUT') {
        return Promise.reject(new Error('Failed to send password reset link'));
      }
      return Promise.resolve({});
    });

    const user = await openResetDialog();
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to send password reset link')
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});
