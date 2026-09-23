import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Minimal mocks matching the pattern already used in router.test.tsx —
// exercise the REAL apiClient.ts (not a mock of it) against a mocked fetch,
// so this proves the actual fix, not just an assertion about it.
vi.mock('../../config/authConfig', () => ({
  authConfig: {
    mode: 'keycloak',
    apiBaseUrl: '/api',
    timeoutMs: 5000,
    appBaseDomain: '',
    keycloak: { url: 'http://kc.example', realm: 'attendance', clientId: 'attendance-frontend' },
  },
}));

vi.mock('../auth/keycloakInstance', () => ({
  default: { token: undefined, refreshToken: undefined, updateToken: vi.fn() },
}));

vi.mock('./mockData', () => ({ resolveMock: () => undefined }));

import { apiRequest } from './apiClient';

describe('apiRequest — wrong password must not trigger the session-expired redirect path', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => ({ error: 'Invalid user credentials' }),
      text: async () => JSON.stringify({ error: 'Invalid user credentials' }),
    } as unknown as Response);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('/auth/keycloak-login: throws a plain ApiError, never dispatches auth-session-expired', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    const pending = apiRequest('/auth/keycloak-login', {
      method: 'POST',
      body: JSON.stringify({ username: 'someone@example.com', password: 'wrong-password', realm: 'attendance' }),
    }).catch((e) => e);

    // Flush the pre-request "wait for a keycloak token" loop (up to 2000ms of
    // internal setTimeout(40ms) polling) without a real 2s wait.
    await vi.advanceTimersByTimeAsync(2100);
    const result = await pending;

    expect(result).toMatchObject({ name: 'ApiError', message: 'Invalid user credentials', status: 401 });

    const expiredEventFired = dispatchSpy.mock.calls.some(
      (call) => (call[0] as CustomEvent).type === 'auth-session-expired'
    );
    expect(expiredEventFired).toBe(false);
  });

  it('/auth/change-password: wrong current password throws a plain ApiError, never dispatches auth-session-expired', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    const pending = apiRequest('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'newpassword123' }),
      accessToken: 'fake-access-token',
    }).catch((e) => e);

    const result = await pending;

    expect(result).toMatchObject({ name: 'ApiError', status: 401 });

    const expiredEventFired = dispatchSpy.mock.calls.some(
      (call) => (call[0] as CustomEvent).type === 'auth-session-expired'
    );
    expect(expiredEventFired).toBe(false);
  });

  it('control case: a 401 from a NON-auth endpoint still dispatches auth-session-expired (proves the test would catch a regression)', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    const pending = apiRequest('/employees', {
      method: 'GET',
      accessToken: 'fake-access-token',
    }).catch((e) => e);

    await vi.advanceTimersByTimeAsync(100);
    await pending;

    const expiredEventFired = dispatchSpy.mock.calls.some(
      (call) => (call[0] as CustomEvent).type === 'auth-session-expired'
    );
    expect(expiredEventFired).toBe(true);
  });
});
