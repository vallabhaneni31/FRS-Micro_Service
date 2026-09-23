/**
 * S-01 — httpOnly Cookie Authentication
 *
 * In API mode and Keycloak mode, tokens are stored in httpOnly cookies by
 * the server (Set-Cookie on /auth/login and /auth/refresh). JavaScript
 * cannot read them — this is intentional and prevents XSS token theft.
 *
 * This module is kept for:
 *   - Mock mode: developer convenience — localStorage still used
 *   - clearTokens(): always clears localStorage to clean up any legacy data
 *
 * In API/Keycloak mode getTokens() returns { accessToken: null, refreshToken: null }
 * so apiClient never injects an Authorization header. The httpOnly cookie is
 * sent automatically by the browser on every same-origin request.
 */

import { authConfig } from '../../config/authConfig';

const ACCESS_TOKEN_KEY  = "attendance.auth.accessToken";
const REFRESH_TOKEN_KEY = "attendance.auth.refreshToken";

const canUseStorage = () => typeof window !== "undefined" && !!window.localStorage;

export const tokenStorage = {
  getTokens(): { accessToken: string | null; refreshToken: string | null } {
    // In production auth modes: tokens are httpOnly cookies — not readable by JS
    if (authConfig.mode !== "mock") {
      return { accessToken: null, refreshToken: null };
    }
    if (!canUseStorage()) return { accessToken: null, refreshToken: null };
    return {
      accessToken:  window.localStorage.getItem(ACCESS_TOKEN_KEY),
      refreshToken: window.localStorage.getItem(REFRESH_TOKEN_KEY),
    };
  },

  setTokens(accessToken: string | null, refreshToken: string | null) {
    // In production auth modes: cookies are set server-side, nothing to do here
    if (authConfig.mode !== "mock" || !canUseStorage()) return;
    if (accessToken)  window.localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    else              window.localStorage.removeItem(ACCESS_TOKEN_KEY);
    if (refreshToken) window.localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    else              window.localStorage.removeItem(REFRESH_TOKEN_KEY);
  },

  clearTokens() {
    // Always clear localStorage — removes any legacy tokens from pre-S-01 builds
    if (!canUseStorage()) return;
    window.localStorage.removeItem(ACCESS_TOKEN_KEY);
    window.localStorage.removeItem(REFRESH_TOKEN_KEY);
  },
};
