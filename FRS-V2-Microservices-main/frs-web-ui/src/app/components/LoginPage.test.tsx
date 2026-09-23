import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// AB#3267 — "Show remaining login attempts before account lockout".
// On a failed /auth/keycloak-login, LoginPage should append the
// remainingAttempts hint (when present and low enough to matter) to the
// existing friendly error message, without touching any other UI.

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    login: vi.fn(),
    loginWithKeycloakToken: vi.fn().mockResolvedValue(true),
    isAuthLoading: false,
    isAuthenticated: false,
    authError: null,
    clearAuthError: vi.fn(),
  }),
}));

vi.mock('../services/auth/keycloakInstance', () => ({
  default: { token: undefined, refreshToken: undefined, updateToken: vi.fn() },
  realmFromSubdomain: vi.fn(() => null),
}));

// Keep the real ApiError implementation (LoginPage's catch branch checks
// `err instanceof ApiError`) — only apiRequest itself is mocked per-test.
vi.mock('../services/http/apiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/http/apiClient')>();
  return { ...actual, apiRequest: vi.fn() };
});

import { LoginPage } from './LoginPage';
import { apiRequest, ApiError } from '../services/http/apiClient';
import { realmFromSubdomain } from '../services/auth/keycloakInstance';

const mockApiRequest = apiRequest as unknown as ReturnType<typeof vi.fn>;
const mockRealmFromSubdomain = realmFromSubdomain as unknown as ReturnType<typeof vi.fn>;

async function renderCredentialsPhaseAndSubmit() {
  // ?realm=acme puts LoginPage straight into the "credentials" phase (skips
  // the workspace-slug step) per its autoLoginRealm handling.
  window.history.pushState({}, 'Test', '/login?realm=acme');

  render(<LoginPage />);

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/work email/i), 'alice@example.com');
  await user.type(screen.getByLabelText(/^password$/i), 'wrong-password');
  await user.click(screen.getByRole('button', { name: /sign in/i }));
}

describe('LoginPage — keycloak-login failure surfaces AB#3267 remaining-attempts hint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends the remaining-attempts hint when the API response includes it', async () => {
    mockApiRequest.mockRejectedValueOnce(
      new ApiError(
        'Your email or password is incorrect. Please try again.',
        401,
        undefined,
        undefined,
        2
      )
    );

    await renderCredentialsPhaseAndSubmit();

    await waitFor(() => {
      expect(
        screen.getByText(
          'Your email or password is incorrect. Please try again. 2 attempts remaining before your account is temporarily locked.'
        )
      ).toBeInTheDocument();
    });
  });

  it('uses singular "attempt" when exactly 1 remains', async () => {
    mockApiRequest.mockRejectedValueOnce(
      new ApiError(
        'Your email or password is incorrect. Please try again.',
        401,
        undefined,
        undefined,
        1
      )
    );

    await renderCredentialsPhaseAndSubmit();

    await waitFor(() => {
      expect(
        screen.getByText(
          'Your email or password is incorrect. Please try again. 1 attempt remaining before your account is temporarily locked.'
        )
      ).toBeInTheDocument();
    });
  });

  it('does not append the hint when remainingAttempts is absent from the error', async () => {
    mockApiRequest.mockRejectedValueOnce(
      new ApiError('Your email or password is incorrect. Please try again.', 401)
    );

    await renderCredentialsPhaseAndSubmit();

    await waitFor(() => {
      expect(
        screen.getByText('Your email or password is incorrect. Please try again.')
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(/attempts? remaining/i)).not.toBeInTheDocument();
  });

  it('does not append the hint when remainingAttempts is present but too high to be useful', async () => {
    mockApiRequest.mockRejectedValueOnce(
      new ApiError(
        'Your email or password is incorrect. Please try again.',
        401,
        undefined,
        undefined,
        8
      )
    );

    await renderCredentialsPhaseAndSubmit();

    await waitFor(() => {
      expect(
        screen.getByText('Your email or password is incorrect. Please try again.')
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(/attempts? remaining/i)).not.toBeInTheDocument();
  });

  it('omits the hint for a non-ApiError failure (defensive — no crash, plain message shown)', async () => {
    mockApiRequest.mockRejectedValueOnce(new Error('Network request failed'));

    await renderCredentialsPhaseAndSubmit();

    await waitFor(() => {
      expect(screen.getByText('Network request failed')).toBeInTheDocument();
    });
    expect(screen.queryByText(/attempts? remaining/i)).not.toBeInTheDocument();
  });
});

// Any subdomain resolves through the wildcard DNS/nginx setup, so a subdomain is not
// proof a tenant actually exists. LoginPage must validate a subdomain-derived realm
// via the same /auth/workspace/validate endpoint the manual-slug flow already uses,
// before ever rendering the credentials form.
describe('LoginPage — subdomain-derived realm is validated before showing the login form', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealmFromSubdomain.mockReturnValue(null);
    window.history.pushState({}, 'Test', '/login');
  });

  it('blocks with an error and never renders credential fields when the workspace does not exist', async () => {
    mockRealmFromSubdomain.mockReturnValue('ghosttenant');
    mockApiRequest.mockResolvedValueOnce({ valid: false });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByText(/this workspace doesn't exist/i)).toBeInTheDocument();
    });
    expect(mockApiRequest).toHaveBeenCalledWith(
      expect.stringContaining('/auth/workspace/validate?slug=ghosttenant')
    );
    expect(screen.queryByLabelText(/work email/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument();
  });

  it('shows a distinct message and stays blocked when the validate call itself fails', async () => {
    mockRealmFromSubdomain.mockReturnValue('acme');
    mockApiRequest.mockRejectedValueOnce(new Error('network down'));

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByText(/couldn't verify this workspace/i)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/work email/i)).not.toBeInTheDocument();
  });

  it('renders the credentials form once a subdomain-derived workspace validates', async () => {
    mockRealmFromSubdomain.mockReturnValue('acme');
    mockApiRequest.mockResolvedValueOnce({ valid: true });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/work email/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/this workspace doesn't exist/i)).not.toBeInTheDocument();
  });

  it('retries validation when "Try again" is clicked after a blocked check', async () => {
    mockRealmFromSubdomain.mockReturnValue('acme');
    mockApiRequest.mockResolvedValueOnce({ valid: false });

    render(<LoginPage />);
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(/this workspace doesn't exist/i)).toBeInTheDocument();
    });

    mockApiRequest.mockResolvedValueOnce({ valid: true });
    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/work email/i)).toBeInTheDocument();
    });
    expect(mockApiRequest).toHaveBeenCalledTimes(2);
  });

  it('does not gate when there is no subdomain-derived realm (manual workspace entry unaffected)', async () => {
    mockRealmFromSubdomain.mockReturnValue(null);

    render(<LoginPage />);

    expect(screen.queryByText(/checking workspace/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/workspace/i)).toBeInTheDocument();
    expect(mockApiRequest).not.toHaveBeenCalled();
  });
});
