import { describe, it, expect, beforeEach, vi } from 'vitest';

// authConfig.ts reads import.meta.env at module top-level, so each test must
// reset the module registry and re-import after stubbing env vars to get a
// fresh evaluation — importing once at file scope would only ever reflect
// whatever env was active on the very first import.
async function loadAuthConfig() {
  vi.resetModules();
  return import('./authConfig');
}

describe('authConfig — VITE_AUTH_MODE resolution', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts a valid mode as-is', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'keycloak');
    const { authConfig } = await loadAuthConfig();
    expect(authConfig.mode).toBe('keycloak');
  });

  it('accepts "api" and "mock" too', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'api');
    expect((await loadAuthConfig()).authConfig.mode).toBe('api');

    vi.stubEnv('VITE_AUTH_MODE', 'mock');
    expect((await loadAuthConfig()).authConfig.mode).toBe('mock');
  });

  it('is case-insensitive', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'KEYCLOAK');
    const { authConfig } = await loadAuthConfig();
    expect(authConfig.mode).toBe('keycloak');
  });

  it('dev mode: falls back to "mock" when unset (developer convenience only)', async () => {
    vi.stubEnv('VITE_AUTH_MODE', undefined);
    vi.stubEnv('PROD', false);
    vi.stubEnv('DEV', true);
    const { authConfig } = await loadAuthConfig();
    expect(authConfig.mode).toBe('mock');
  });

  it('production build: throws instead of silently booting into mock mode when VITE_AUTH_MODE is unset', async () => {
    vi.stubEnv('VITE_AUTH_MODE', undefined);
    vi.stubEnv('PROD', true);
    vi.stubEnv('DEV', false);
    await expect(loadAuthConfig()).rejects.toThrow(/VITE_AUTH_MODE must be one of/);
  });

  it('production build: throws on an invalid mode value rather than silently falling back', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'not-a-real-mode');
    vi.stubEnv('PROD', true);
    vi.stubEnv('DEV', false);
    await expect(loadAuthConfig()).rejects.toThrow(/VITE_AUTH_MODE must be one of/);
  });
});
