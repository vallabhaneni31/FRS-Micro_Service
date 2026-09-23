import { User, UserMembership, AccessScope } from "../../types";
import { apiRequest } from "../http/apiClient";
import { AuthBootstrap, AuthProvider, MtBundle } from "./types";
import { derivePermissionsForScope } from "./permissionUtils";
import keycloak from "./keycloakInstance";
import { authConfig, getRedirectUri } from "../../config/authConfig";


/* ------------------------------------------------------------------ */
/*  Types for bootstrap response                                       */
/* ------------------------------------------------------------------ */

interface ApiUser {
    id: string;
    email: string;
    role: "admin" | "hr";
    name: string;
    department?: string;
    createdAt: string | Date;
}

interface BootstrapResponse {
    user: User | ApiUser;
    memberships: UserMembership[];
    activeScope?: AccessScope | null;
    tenants: AuthBootstrap["catalog"]["tenants"];
    customers: AuthBootstrap["catalog"]["customers"];
    sites: AuthBootstrap["catalog"]["sites"];
    units: AuthBootstrap["catalog"]["units"];
    mt?: MtBundle | null;   // Phase 3+ multitenant bundle from backend
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function normalizeUser(user: User | ApiUser): User {
    return {
        ...user,
        createdAt:
            user.createdAt instanceof Date
                ? user.createdAt
                : new Date(user.createdAt),
    };
}

const emptyCatalog = () => ({
    tenants: [] as AuthBootstrap["catalog"]["tenants"],
    customers: [] as AuthBootstrap["catalog"]["customers"],
    sites: [] as AuthBootstrap["catalog"]["sites"],
    units: [] as AuthBootstrap["catalog"]["units"],
});

/* ------------------------------------------------------------------ */
/*  Token refresh interval (Diagram 4: every 30 s, min-validity 60 s) */
/* ------------------------------------------------------------------ */

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Notify AuthContext of a refreshed token so React state stays current. */
function dispatchTokenRefreshed(accessToken: string, refreshToken: string) {
    window.dispatchEvent(
        new CustomEvent("ropc-token-refreshed", { detail: { accessToken, refreshToken } })
    );
}

/** Notify AuthContext that the session can no longer be refreshed. */
function dispatchSessionExpired() {
    window.dispatchEvent(new CustomEvent("auth-session-expired"));
}

// ── ROPC token persistence (in-app login survives page refresh) ──────────────
const ROPC_ACCESS_KEY  = 'frs_ropc_access_token';
const ROPC_REFRESH_KEY = 'frs_ropc_refresh_token';

export function storeRopcTokens(accessToken: string, refreshToken: string) {
    localStorage.setItem(ROPC_ACCESS_KEY, accessToken);
    localStorage.setItem(ROPC_REFRESH_KEY, refreshToken);
}

export function clearRopcTokens() {
    localStorage.removeItem(ROPC_ACCESS_KEY);
    localStorage.removeItem(ROPC_REFRESH_KEY);
}

function getRopcTokens(): { accessToken: string | null; refreshToken: string | null } {
    return {
        accessToken:  localStorage.getItem(ROPC_ACCESS_KEY),
        refreshToken: localStorage.getItem(ROPC_REFRESH_KEY),
    };
}

/**
 * Schedule the next refresh proactively, at ~75% of the access token's
 * remaining lifetime (read from `keycloak.tokenParsed.exp`) rather than polling
 * every 30 s. Falls back to a 60 s tick if the expiry can't be determined.
 * On a terminal refresh failure we surface `auth-session-expired` so the app
 * bounces to Keycloak for re-authentication — we never replay stored credentials.
 */
/**
 * @param onFailure 'clear-and-dispatch' (default) wipes stored tokens and
 *   fires auth-session-expired immediately — used by the one-shot ROPC
 *   restore path in initialize(), which never retries. 'silent' just
 *   returns false without touching storage or firing the event — used by
 *   the retrying refresh loop below, so a transient failure doesn't wipe
 *   the very refresh token the next retry attempt needs.
 */
async function refreshKeycloakTokenDirect(
    refreshToken: string,
    onFailure: 'clear-and-dispatch' | 'silent' = 'clear-and-dispatch'
): Promise<boolean> {
    try {
        const currentRealm = localStorage.getItem("frs_current_realm") || authConfig.keycloak.realm;
        const data = await apiRequest<{ access_token: string; refresh_token?: string }>('/auth/keycloak-refresh', {
            method: "POST",
            body: JSON.stringify({ refreshToken, realm: currentRealm }),
        });

        if (data && data.access_token) {
            keycloak.token = data.access_token;
            keycloak.refreshToken = data.refresh_token || refreshToken;
            try {
                keycloak.tokenParsed = JSON.parse(atob(data.access_token.split('.')[1]));
            } catch {}
            if (getRopcTokens().accessToken) {
                storeRopcTokens(data.access_token, data.refresh_token || refreshToken);
            }
            dispatchTokenRefreshed(data.access_token, data.refresh_token || refreshToken);
            return true;
        }
    } catch (err) {
        console.error("[keycloakAuthProvider] Direct refresh failed:", err);
        if (onFailure === 'clear-and-dispatch') {
            clearRopcTokens();
            dispatchSessionExpired();
        }
    }
    return false;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// A single failed refresh attempt used to trigger an immediate hard logout —
// any transient blip (brief network hiccup, Keycloak momentarily slow, a
// passing 5xx) was enough to bounce an active user back to the login page.
// Retry a few times with backoff before giving up; only a refresh token that
// is genuinely invalid/expired (every attempt fails) should end the session.
const REFRESH_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

async function attemptTokenRefreshOnce(): Promise<boolean> {
    let ok = false;
    try {
        const refreshed = await keycloak.updateToken(30);
        if (refreshed && keycloak.token && keycloak.refreshToken) {
            if (getRopcTokens().accessToken) {
                storeRopcTokens(keycloak.token, keycloak.refreshToken);
            }
            dispatchTokenRefreshed(keycloak.token, keycloak.refreshToken);
            ok = true;
        } else if (keycloak.token) {
            ok = true;
        }
    } catch (e) {
        // keycloak.js updateToken failed; try direct OIDC refresh fallback below
    }

    if (!ok) {
        const storedRefresh = getRopcTokens().refreshToken || keycloak.refreshToken;
        if (storedRefresh) {
            ok = await refreshKeycloakTokenDirect(storedRefresh, 'silent');
        }
    }
    return ok;
}

function scheduleTokenRefresh() {
    stopTokenRefreshLoop();

    const exp = keycloak.tokenParsed?.exp;
    const skew = keycloak.timeSkew ?? 0;
    let delayMs = 60_000;
    if (exp) {
        const remainingMs = (exp + skew) * 1000 - Date.now();
        // Refresh at 75% of remaining lifetime, but never less than 10 s out.
        delayMs = Math.max(remainingMs * 0.75, 10_000);
    }

    refreshTimer = setTimeout(async () => {
        try {
            let ok = await attemptTokenRefreshOnce();

            for (let i = 0; !ok && i < REFRESH_RETRY_DELAYS_MS.length; i++) {
                await sleep(REFRESH_RETRY_DELAYS_MS[i]);
                ok = await attemptTokenRefreshOnce();
            }

            if (ok) {
                scheduleTokenRefresh();
            } else {
                stopTokenRefreshLoop();
                clearRopcTokens();
                dispatchSessionExpired();
            }
        } catch {
            stopTokenRefreshLoop();
            clearRopcTokens();
            dispatchSessionExpired();
        }
    }, delayMs);
}

/** Back-compat alias kept for the call sites below. */
const startTokenRefreshLoop = scheduleTokenRefresh;

function stopTokenRefreshLoop() {
    if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }
}

/* ------------------------------------------------------------------ */
/*  Keycloak Auth Provider                                             */
/* ------------------------------------------------------------------ */

export const keycloakAuthProvider: AuthProvider = {
    /**
     * Initialize Keycloak and fetch memberships from our backend.
     *
     * Flow (Diagram 1 + 2):
     *  1. keycloak.init() — OIDC Auth Code + PKCE
     *  2. GET /api/auth/bootstrap (Bearer JWT)
     *  3. Backend verifies JWT, finds/provisions user, loads memberships
     *  4. Frontend stores AuthSession in Context
     */
    async initialize(_tokens) {
        const isPublicRoute =
            window.location.pathname.startsWith("/setup-password") ||
            window.location.pathname.startsWith("/enroll");

        if (isPublicRoute) {
            return { session: null, catalog: emptyCatalog(), mt: null };
        }

        const sp = new URLSearchParams(window.location.search);
        const isLoginPage = window.location.pathname === '/login';
        const hasAuthCode = sp.has("code") && sp.has("session_state");

        // On the /login page, always skip check-sso (it does a top-level KC redirect
        // which can bring a code back to /login and cause "Code not valid" on next
        // load). Instead, wipe any stale callback params from the URL first (from
        // prior check-sso round-trips stored in browser history), then init() without
        // onLoad to set up the internal #adapter so keycloak.login() is callable.
        if (isLoginPage) {
            if (hasAuthCode) {
                // Stale code in URL — clean it silently before init() scans the URL.
                window.history.replaceState(null, '', window.location.pathname);
            }
            await keycloak.init({
                checkLoginIframe: false,
                pkceMethod: "S256",
                redirectUri: getRedirectUri('/'),
            });
            return { session: null, catalog: emptyCatalog(), mt: null };
        }

        // ── ROPC restore path ────────────────────────────────────────────────
        // In-app login (ROPC) never creates a Keycloak browser session, so
        // check-sso always returns unauthenticated on refresh. Instead we persist
        // the access/refresh tokens in localStorage and restore them here directly.
        const ropc = getRopcTokens();
        if (ropc.accessToken) {
            let isExpired = false;
            try {
                const parsed = JSON.parse(atob(ropc.accessToken.split('.')[1]));
                if (parsed.exp && (parsed.exp * 1000) <= Date.now() + 10000) {
                    isExpired = true;
                }
            } catch {
                isExpired = true;
            }

            if (isExpired && ropc.refreshToken) {
                const ok = await refreshKeycloakTokenDirect(ropc.refreshToken);
                if (ok) {
                    const latest = getRopcTokens();
                    if (latest.accessToken) {
                        ropc.accessToken = latest.accessToken;
                        ropc.refreshToken = latest.refreshToken;
                    }
                } else {
                    clearRopcTokens();
                    return { session: null, catalog: emptyCatalog(), mt: null };
                }
            }

            try {
                await keycloak.init({ checkLoginIframe: false, pkceMethod: 'S256' });
                keycloak.token = ropc.accessToken;
                keycloak.refreshToken = ropc.refreshToken ?? undefined;
                try {
                    keycloak.tokenParsed = JSON.parse(atob(ropc.accessToken.split('.')[1]));
                } catch { /* non-fatal */ }

                const bootstrap = await apiRequest<BootstrapResponse>('/auth/bootstrap', {
                    method: 'GET',
                    accessToken: ropc.accessToken,
                });
                startTokenRefreshLoop();
                return {
                    session: {
                        user: normalizeUser(bootstrap.user),
                        accessToken: ropc.accessToken,
                        refreshToken: ropc.refreshToken,
                        memberships: bootstrap.memberships,
                        activeScope: bootstrap.activeScope ?? bootstrap.memberships[0]?.scope ?? null,
                    },
                    catalog: {
                        tenants: bootstrap.tenants,
                        customers: bootstrap.customers,
                        sites: bootstrap.sites,
                        units: bootstrap.units,
                    },
                    mt: bootstrap.mt ?? null,
                };
            } catch {
                // Token expired — clear and fall through to show login page
                clearRopcTokens();
                return { session: null, catalog: emptyCatalog(), mt: null };
            }
        }

        try {
            const authenticated = await keycloak.init({
                onLoad: "check-sso",
                // Use an iframe for the silent SSO check instead of a top-level
                // browser redirect. The iframe loads /silent-check-sso.html (served
                // from the app), KC responds with prompt=none (no HTML rendered in
                // the iframe, just a server-side redirect), and the script posts the
                // result URL back to the parent. This avoids:
                //  - Top-level redirects that break deep links on page refresh
                //  - Stale auth codes landing at /login causing "Code not valid"
                silentCheckSsoRedirectUri: getRedirectUri('/silent-check-sso.html'),
                checkLoginIframe: false,
                pkceMethod: "S256",
                redirectUri: getRedirectUri('/'),
            });

            if (!authenticated || !keycloak.token) {
                // Not authenticated — router will call keycloak.login() to redirect to KC.
                return { session: null, catalog: emptyCatalog(), mt: null };
            }

            // Start the token refresh loop (Diagram 4)
            startTokenRefreshLoop();

            // Fetch memberships + catalog from our backend
            const bootstrap = await apiRequest<BootstrapResponse>(
                "/auth/bootstrap",
                {
                    method: "GET",
                    accessToken: keycloak.token,
                }
            );

            return {
                session: {
                    user: normalizeUser(bootstrap.user),
                    accessToken: keycloak.token,
                    refreshToken: null, // Keycloak manages refresh internally
                    memberships: bootstrap.memberships,
                    activeScope:
                        bootstrap.activeScope ??
                        bootstrap.memberships[0]?.scope ??
                        null,
                },
                catalog: {
                    tenants: bootstrap.tenants,
                    customers: bootstrap.customers,
                    sites: bootstrap.sites,
                    units: bootstrap.units,
                },
                mt: bootstrap.mt ?? null,
            };
        } catch {
            return { session: null, catalog: emptyCatalog(), mt: null };
        }
    },

    /**
     * Login (Keycloak mode) uses the Authorization Code + PKCE redirect flow.
     * Credentials are entered on Keycloak's hosted login page — never handled
     * by this SPA. This redirects the browser to Keycloak; on return,
     * `initialize()` exchanges the auth code and bootstraps the session, so this
     * promise intentionally never resolves (navigation is already underway).
     *
     * Note: `LoginPage` calls `keycloak.login()` directly for the redirect, so
     * this is a defensive fallback for any generic `authProvider.login()` caller.
     */
    async login() {
        keycloak.login({ redirectUri: getRedirectUri('/') });
        return new Promise<never>(() => { /* navigating to Keycloak */ });
    },

    /**
     * Logout (Diagram 5):
     *  1. Stop the refresh timer
     *  2. Clear the cached realm so the next user on a shared device does not
     *     inherit this tenant's context
     *  3. keycloak.logout({ redirectUri }) — destroys Keycloak session
     */
    async logout(_refreshToken) {
        stopTokenRefreshLoop();
        clearRopcTokens();
        localStorage.removeItem("frs_current_realm");
        keycloak.logout({ redirectUri: getRedirectUri('/') });
    },


    /** Permission derivation — unchanged, same logic as mock/api modes. */
    derivePermissions: derivePermissionsForScope,
};
