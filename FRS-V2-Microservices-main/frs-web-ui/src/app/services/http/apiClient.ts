import { authConfig } from "../../config/authConfig";
import { tokenStorage } from "../auth/tokenStorage";
import { setLogCorrelationId } from "../../utils/logger";
import { isCacheable, cacheGet, cacheSet, invalidatePrefix } from "./apiCache";
import { resolveMock } from "./mockData";
import keycloak from "../auth/keycloakInstance";
export { clearCache as clearApiCache, invalidatePrefix as invalidateApiCache } from "./apiCache";

export class ApiError extends Error {
  status: number;
  correlationId?: string;
  /** If the server returned a `field` hint, the specific form field that triggered the error. */
  field?: string;
  /**
   * AB#3267: on a failed /auth/keycloak-login, how many attempts remain before
   * Keycloak's brute-force protection locks the account. Only present when the
   * server was able to compute it (best-effort Admin API lookup) — absent for
   * every other error, including other auth failures.
   */
  remainingAttempts?: number;
  get retryable() { return this.status >= 500 || this.status === 429; }

  constructor(message: string, status: number, correlationId?: string, field?: string, remainingAttempts?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.correlationId = correlationId;
    this.field = field;
    this.remainingAttempts = remainingAttempts;
  }
}

interface RequestOptions extends RequestInit {
  accessToken?: string | null;
  timeoutMs?: number;
  scopeHeaders?: Record<string, string>;
  _skipRefresh?: boolean;
  /** TTL in ms for GET response caching. Pass 0 or set noCache to bypass. */
  ttlMs?: number;
  /** Explicitly bypass the cache for this request. */
  noCache?: boolean;
}

// Singleton refresh promise — prevents parallel refresh races when multiple
// requests 401 simultaneously.
let _refreshPromise: Promise<string | null> | null = null;

async function attemptTokenRefresh(): Promise<string | null> {
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = (async () => {
    try {
      // Keycloak mode: use keycloak-js to refresh against KC's token endpoint.
      // The backend has no /api/auth/refresh route in this mode.
      if (authConfig.mode === "keycloak") {
        try {
          await keycloak.updateToken(30);
          if (keycloak.token) {
            tokenStorage.setTokens(keycloak.token, keycloak.refreshToken ?? null);
            if (localStorage.getItem("frs_ropc_access_token")) {
              localStorage.setItem("frs_ropc_access_token", keycloak.token);
              if (keycloak.refreshToken) localStorage.setItem("frs_ropc_refresh_token", keycloak.refreshToken);
            }
            window.dispatchEvent(
              new CustomEvent("ropc-token-refreshed", {
                detail: { accessToken: keycloak.token, refreshToken: keycloak.refreshToken },
              })
            );
            return keycloak.token;
          }
        } catch {
          // updateToken failed — try direct OIDC refresh fallback below
        }

        const currentRealm = localStorage.getItem("frs_current_realm") || authConfig.keycloak.realm;
        const { refreshToken } = tokenStorage.getTokens();
        const ropcRefreshToken = localStorage.getItem("frs_ropc_refresh_token");
        const effectiveRefresh = refreshToken || ropcRefreshToken;

        if (effectiveRefresh && authConfig.keycloak.url && authConfig.keycloak.clientId) {
          try {
            // Route through backend proxy to avoid CORS when running from a tenant subdomain
            const data = await apiRequest<{ access_token: string; refresh_token?: string }>('/auth/keycloak-refresh', {
              method: "POST",
              body: JSON.stringify({ refreshToken: effectiveRefresh, realm: currentRealm }),
              _skipRefresh: true, // prevent infinite loop
            });

            if (data && data.access_token) {
              keycloak.token = data.access_token;
              keycloak.refreshToken = data.refresh_token || effectiveRefresh;
              try {
                keycloak.tokenParsed = JSON.parse(atob(data.access_token.split(".")[1]));
              } catch {}
              tokenStorage.setTokens(data.access_token, data.refresh_token || effectiveRefresh);
              localStorage.setItem("frs_ropc_access_token", data.access_token);
              if (data.refresh_token) {
                localStorage.setItem("frs_ropc_refresh_token", data.refresh_token);
              }
              window.dispatchEvent(
                new CustomEvent("ropc-token-refreshed", {
                  detail: { accessToken: data.access_token, refreshToken: data.refresh_token || effectiveRefresh },
                })
              );
              return data.access_token;
            }
          } catch (err) {
            console.error("[apiClient] Backend-proxy Keycloak refresh failed:", err);
          }
        }

        tokenStorage.clearTokens();
        localStorage.removeItem("frs_ropc_access_token");
        localStorage.removeItem("frs_ropc_refresh_token");
        window.dispatchEvent(new CustomEvent("auth-session-expired"));
        return null;
      }

      const { refreshToken } = tokenStorage.getTokens();
      const isCookieMode = authConfig.mode === "api";

      const res = await fetch(`${authConfig.apiBaseUrl}/auth/refresh`, {
        method: "POST",
        credentials: "include",          // send httpOnly cookie in cookie mode
        headers: { "Content-Type": "application/json" },
        // Cookie mode: no body needed — server reads httpOnly refresh_token cookie
        // Token mode (mock/keycloak): send token in body
        body: JSON.stringify(refreshToken ? { refreshToken } : {}),
      });

      if (!res.ok) {
        tokenStorage.clearTokens();
        return null;
      }

      if (isCookieMode) {
        // Server set new access_token cookie. Signal caller to retry with cookie.
        return "__cookie_refreshed__";
      }

      const data: { accessToken: string; refreshToken?: string } = await res.json();
      tokenStorage.setTokens(data.accessToken, data.refreshToken ?? refreshToken);

      window.dispatchEvent(
        new CustomEvent("ropc-token-refreshed", {
          detail: {
            accessToken:  data.accessToken,
            refreshToken: data.refreshToken ?? refreshToken,
          },
        })
      );
      return data.accessToken;
    } catch {
      tokenStorage.clearTokens();
      return null;
    } finally {
      _refreshPromise = null;
    }
  })();

  return _refreshPromise;
}

/**
 * Wait briefly for keycloak-js to populate `keycloak.token`. Closes the race
 * where the first wave of `apiRequest` calls fire before keycloak.init()
 * has finished — without this, those calls 401 and rely on the refresh
 * handler to retry. The retries succeed but devtools shows noisy 401s.
 *
 * Returns the current token (possibly still null after timeout) so callers
 * can decide what to do — but in practice 2s is enough for the init handshake.
 */
async function waitForKeycloakToken(timeoutMs = 2000): Promise<string | null> {
  if (keycloak.token) return keycloak.token;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (keycloak.token) return keycloak.token;
    // If we have a refresh token but no access token, force an update.
    if (keycloak.refreshToken) {
      try { await keycloak.updateToken(0); } catch { /* swallow */ }
      if (keycloak.token) return keycloak.token;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  return keycloak.token ?? null;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  // Cache check — only for safe GET requests when not explicitly bypassed
  const method = (options.method ?? 'GET').toUpperCase();

  if (method !== 'GET') {
    const segments = path.split('/').filter(Boolean);
    if (segments.length > 0) {
      const firstSegment = '/' + segments[0];
      invalidatePrefix(firstSegment);
      if (segments.length > 1) {
        const secondSegment = firstSegment + '/' + segments[1];
        invalidatePrefix(secondSegment);
      }
      // Modifying users/sites should invalidate tenant-admin cache too
      if (firstSegment === '/users' || firstSegment === '/sites' || firstSegment === '/site-management') {
        invalidatePrefix('/tenant-admin');
      }
      // Modifying attendance or employees should invalidate live dashboard cache too
      if (firstSegment === '/attendance' || firstSegment === '/employees') {
        invalidatePrefix('/live');
      }
    }
  }

  // Local mock interception (dev-only; see mockData.ts). Returns canned data for
  // known live endpoints and falls through to the real backend for everything else.
  const mock = resolveMock(path, method);
  if (mock !== undefined) return mock as T;

  const useCache = !options.noCache && isCacheable(path, method);
  if (useCache) {
    const cacheKey = path + (options.scopeHeaders ? JSON.stringify(options.scopeHeaders) : '');
    const cached = cacheGet<T>(cacheKey);
    if (cached !== null) return cached;

    const result = await apiRequest<T>(path, { ...options, noCache: true });
    cacheSet(cacheKey, result, options.ttlMs);
    return result;
  }

  const controller = new AbortController();
  // Honour a caller-supplied AbortSignal (the request's own controller replaces `signal` in the
  // fetch options below, so without this a caller could never cancel a superseded request).
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener("abort", () => controller.abort(options.signal!.reason), { once: true });
  }
  let isTimeout = false;
  const timeoutMs = options.timeoutMs ?? authConfig.timeoutMs;
  const timeout = setTimeout(
    () => {
      isTimeout = true;
      controller.abort(new Error("Request timed out after " + timeoutMs + "ms"));
    },
    timeoutMs
  );

  // In cookie mode (api): storedAccess is null → no Authorization header → cookie auto-sent
  // In mock/keycloak mode: use passed or stored token as Bearer
  let storedAccess   = tokenStorage.getTokens().accessToken;
  // `?? storedAccess` (not `!== undefined`): a caller passing an explicit `null`
  // accessToken (e.g. ManifestContext before useAuth's token has propagated) must
  // still fall back to the stored Keycloak token — otherwise the request goes out
  // with no Authorization header and hits the dev-bypass as a synthetic super_admin.
  let resolvedToken  = options.accessToken ?? storedAccess;

  // Keycloak mode race-fix: if a component fires before keycloak.init() has set
  // the token, wait briefly for it before sending. Avoids the first-wave 401s
  // that otherwise trigger a refresh+retry cycle. Runs whenever no token resolved,
  // regardless of whether the caller passed null/undefined explicitly.
  if (
    authConfig.mode === "keycloak" &&
    !resolvedToken &&
    !options._skipRefresh
  ) {
    const t = await waitForKeycloakToken(2000);
    if (t) {
      tokenStorage.setTokens(t, keycloak.refreshToken ?? null);
      storedAccess = t;
      resolvedToken = t;
    }
  }

  try {
    const response = await fetch(`${authConfig.apiBaseUrl}${path}`, {
      ...options,
      cache: (options.noCache || !isCacheable(path, method)) ? "no-store" : options.cache,
      credentials: "include", // Always send cookies (httpOnly session + CSRF-safe SameSite=Strict)
      headers: {
        ...(options.body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
        // Only inject Authorization header when we actually have a token
        ...(resolvedToken ? { Authorization: `Bearer ${resolvedToken}` } : {}),
        ...(options.scopeHeaders ?? {}),
        ...(options.headers ?? {}),
      },
      signal: controller.signal,
    });

    // Extract correlation ID for error tracing (set by backend middleware)
    const correlationId = response.headers.get("X-Request-ID") ?? undefined;
    if (correlationId) setLogCorrelationId(correlationId);

    // Endpoints where a 401 is a normal, expected outcome (wrong credentials,
    // wrong current password, a refresh call that itself fails) rather than a
    // sign that a previously-valid session has expired. Do NOT auto-refresh or
    // fire auth-session-expired for these — that would swallow the real error
    // and force a full redirect to Keycloak's hosted login page instead of
    // letting the caller show an inline message. Add any new unauthenticated
    // or credential-verification auth route here.
    const isAuthEndpoint =
      path === "/auth/refresh" ||
      path === "/auth/login" ||
      path === "/auth/keycloak-login" ||
      path === "/auth/change-password";

    if (response.status === 401 && !options._skipRefresh && !isAuthEndpoint) {
      clearTimeout(timeout);
      const newToken = await attemptTokenRefresh();
      if (newToken) {
        return apiRequest<T>(path, {
          ...options,
          // "__cookie_refreshed__" = new cookie set; retry without explicit token
          accessToken:   newToken === "__cookie_refreshed__" ? undefined : newToken,
          _skipRefresh:  true,
        });
      }
      window.dispatchEvent(new CustomEvent("auth-session-expired"));
      throw new ApiError("Session expired. Please sign in again.", 401, correlationId);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const body =
      contentType.includes("application/json")
        ? await response.json()
        : await response.text();

    if (!response.ok) {
      // Prefer body.error, then body.message, then fall back to a generic string
      const errMsg =
        typeof body === "string"
          ? body
          : (body?.error ?? body?.message ?? "Request failed");
      const errField = typeof body === "object" ? body?.field : undefined;
      // AB#3267: /auth/keycloak-login includes this on a fresh bad-credentials
      // 401 when the best-effort Keycloak Admin API lookup succeeded.
      const remainingAttempts = typeof body === "object" && typeof body?.remainingAttempts === "number"
        ? body.remainingAttempts
        : undefined;
      throw new ApiError(errMsg, response.status, correlationId, errField, remainingAttempts);
    }

    return body as T;
  } catch (err: any) {
    if (isTimeout) {
      throw new ApiError(`Request timed out after ${timeoutMs}ms`, 408);
    }
    if (err?.name === "AbortError") {
      const abortErr = new ApiError("Request was cancelled", 499);
      abortErr.name = "AbortError";
      throw abortErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
