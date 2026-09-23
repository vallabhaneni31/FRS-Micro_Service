import React, { createContext, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import {
  AccessScope,
  Customer,
  Permission,
  Site,
  Tenant,
  Unit,
  User,
  UserMembership,
} from '../types';
import { authProvider } from '../services/auth';
import { tokenStorage } from '../services/auth/tokenStorage';
import { authConfig } from '../config/authConfig';
import keycloak from '../services/auth/keycloakInstance';
import { storeRopcTokens } from '../services/auth/keycloakAuthProvider';
import { apiRequest, clearApiCache } from '../services/http/apiClient';
import { realtimeEngine } from '../engine/RealTimeEngine';
import type { MtBundle, MtVertical } from '../services/auth/types';

interface AuthContextType {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  memberships: UserMembership[];
  permissions: Permission[];
  activeScope: AccessScope | null;
  tenants: Tenant[];
  customers: Customer[];
  sites: Site[];
  units: Unit[];
  login: (email: string, password: string) => Promise<boolean>;
  loginWithKeycloakToken: (accessToken: string, refreshToken: string) => Promise<boolean>;
  logout: () => Promise<void>;
  setActiveScope: (scope: AccessScope) => void;
  can: (permission: Permission) => boolean;
  hasAnyPermission: (requiredPermissions: Permission[]) => boolean;
  isAuthLoading: boolean;
  authError: string | null;
  clearAuthError: () => void;
  isAuthenticated: boolean;

  // Phase 5 — multitenant bundle from /api/auth/bootstrap
  mt: MtBundle | null;
  vertical: MtVertical | null;
  hasScope: (scopeCode: string) => boolean;
  hasFeature: (featureKey: string) => boolean;
  /** Switch a corporate label to its educational counterpart based on current tenant vertical. */
  verticalLabel: (corporate: string, education: string) => string;
  /** Translate core role names to dynamic vertical specific roles */
  translateRole: (role: string) => string;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [memberships, setMemberships] = useState<UserMembership[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [activeScope, setActiveScope] = useState<AccessScope | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [mt, setMt] = useState<MtBundle | null>(null);

  const clearSession = () => {
    setUser(null);
    setAccessToken(null);
    setRefreshToken(null);
    setMemberships([]);
    setPermissions([]);
    setActiveScope(null);
    setMt(null);
    tokenStorage.clearTokens();
    clearApiCache();
    localStorage.removeItem('selectedSiteId');
  };

  const applySession = (
    session: {
      user: User;
      accessToken: string | null;
      refreshToken: string | null;
      memberships: UserMembership[];
      activeScope: AccessScope | null;
    } | null
  ) => {
    if (!session) {
      clearSession();
      return;
    }

    const savedSiteId = localStorage.getItem('selectedSiteId');
    const isValidSite = savedSiteId && (
      session.memberships.some(m => !m.scope.siteId && (!session.activeScope || m.scope.tenantId === session.activeScope.tenantId)) ||
      session.memberships.some(m => m.scope.siteId === savedSiteId && (!session.activeScope || m.scope.tenantId === session.activeScope.tenantId))
    );

    const initialActiveScope = session.activeScope
      ? {
          ...session.activeScope,
          siteId: isValidSite ? savedSiteId : undefined,
          unitId: undefined,
        }
      : null;

    const derivedPermissions = authProvider.derivePermissions(
      session.memberships,
      initialActiveScope
    );

    // ── RUNTIME INSTRUMENTATION ──────────────────────────────────────────────────
    console.group('%c[FRS-RCA] AuthContext.applySession firing', 'color:#dc2626;font-weight:bold');
    console.log('Timestamp:', new Date().toISOString());
    console.log('initialActiveScope:', initialActiveScope);
    console.log('derivedPermissions count:', derivedPermissions?.length ?? 0);
    console.log('accessToken present:', !!session.accessToken);
    console.log('savedSiteId from localStorage:', savedSiteId);
    console.log('isValidSite:', isValidSite);
    console.log('All 4 setState calls will now fire — React may batch or split them across render cycles.');
    console.log('Watch for [FRS-RCA] fetchAll logs immediately after this to see which scope was active.');
    console.groupEnd();
    // ── END INSTRUMENTATION ────────────────────────────────────────────────────

    setUser(session.user);
    setAccessToken(session.accessToken);
    setRefreshToken(session.refreshToken);
    setMemberships(session.memberships);
    setPermissions(derivedPermissions);
    setActiveScope(initialActiveScope);
    tokenStorage.setTokens(session.accessToken, session.refreshToken);
  };

  // When the refresh token has expired:
  //   - keycloak mode: bounce straight to KC for re-authentication (no LoginPage)
  //   - other modes: clear session and let the legacy flow surface the error
  useEffect(() => {
    const onExpired = () => {
      const hasRopcTokens = Boolean(localStorage.getItem('frs_ropc_access_token') || localStorage.getItem('frs_ropc_refresh_token'));
      const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

      if (authConfig.mode === "keycloak" && !hasRopcTokens && !isLocalhost) {
        // keycloakInstance's Proxy resolves `.realm` (and therefore the realm
        // keycloak.login() redirects to) from the "frs_current_realm"
        // localStorage key at call time — but that key is shared across every
        // tab/session on this origin, not scoped to this session. If another
        // tab touched a different tenant (or never set one, e.g. Motivity's
        // own login), it silently clobbers this tab's value, and a session
        // expiring here would then redirect to the WRONG tenant's realm (or
        // the default "attendance" realm) instead of the one this session
        // was actually authenticated against. Re-pin it from this session's
        // own token issuer right before redirecting so it can't be stale.
        try {
          const iss: string | undefined = keycloak.tokenParsed?.iss;
          const realmMatch = iss?.match(/\/realms\/([^/]+)$/);
          if (realmMatch) {
            localStorage.setItem("frs_current_realm", realmMatch[1]);
          }
        } catch { /* fall through to whatever's already stored */ }
        tokenStorage.clearTokens();
        keycloak.login();
        return;
      }
      localStorage.removeItem('frs_ropc_access_token');
      localStorage.removeItem('frs_ropc_refresh_token');
      clearSession();
      setAuthError("Your session has expired. Please sign in again.");
    };
    // Keep React's accessToken in sync when a provider/apiClient silently
    // refreshes the token (otherwise components keep a stale token in state).
    const onTokenRefreshed = (e: Event) => {
      const detail = (e as CustomEvent<{ accessToken?: string }>).detail;
      if (detail?.accessToken) setAccessToken(detail.accessToken);
    };
    window.addEventListener("auth-session-expired", onExpired);
    window.addEventListener("ropc-token-refreshed", onTokenRefreshed);
    return () => {
      window.removeEventListener("auth-session-expired", onExpired);
      window.removeEventListener("ropc-token-refreshed", onTokenRefreshed);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    const initializeAuth = async () => {
      setIsAuthLoading(true);
      setAuthError(null);

      try {
        // ── RUNTIME INSTRUMENTATION ────────────────────────────────────────────
        console.log('%c[FRS-RCA] AuthContext: authProvider.initialize() starting...', 'color:#dc2626');
        const t0 = Date.now();
        // ── END INSTRUMENTATION ──────────────────────────────────────────────────
        const bootstrap = await authProvider.initialize(tokenStorage.getTokens());
        if (!isMounted) return;
        // ── RUNTIME INSTRUMENTATION ────────────────────────────────────────────
        console.log(`%c[FRS-RCA] AuthContext: initialize() completed in ${Date.now() - t0}ms`, 'color:#dc2626');
        console.log('[FRS-RCA] bootstrap.session?.activeScope:', bootstrap.session?.activeScope);
        console.log('[FRS-RCA] About to call setIsAuthLoading(false) via finally block after applySession');
        // ── END INSTRUMENTATION ──────────────────────────────────────────────────
        setTenants(bootstrap.catalog.tenants);
        setCustomers(bootstrap.catalog.customers);
        setSites(bootstrap.catalog.sites);
        setUnits(bootstrap.catalog.units);
        setMt(bootstrap.mt ?? null);
        applySession(bootstrap.session);
        // S-01: In cookie mode token is null; connectSocket uses cookie via withCredentials
        if (bootstrap.session) {
          realtimeEngine.connectSocket(
            bootstrap.session?.accessToken,
            bootstrap.session?.activeScope?.tenantId
          );
        }
      } catch {
        if (!isMounted) return;
        clearSession();
        setAuthError("Unable to restore session. Please sign in again.");
      } finally {
        if (isMounted) {
          // ── RUNTIME INSTRUMENTATION ────────────────────────────────────────────
          console.log('%c[FRS-RCA] AuthContext: setIsAuthLoading(false) firing NOW', 'color:#dc2626;font-weight:bold');
          console.log('[FRS-RCA] Timestamp:', new Date().toISOString());
          // ── END INSTRUMENTATION ──────────────────────────────────────────────────
          setIsAuthLoading(false);
        }
      }
    };

    initializeAuth();

    return () => {
      isMounted = false;
    };
  }, []);

  // Dynamically update the WebSocket room subscription when the active tenant ID changes
  useEffect(() => {
    if (user && activeScope?.tenantId) {
      realtimeEngine.connectSocket(accessToken, activeScope.tenantId);
    }
  }, [user, activeScope?.tenantId, accessToken]);

  const login = async (email: string, password: string): Promise<boolean> => {
    setIsAuthLoading(true);
    setAuthError(null);
    try {
      const session = await authProvider.login(email, password);
      if (!session) {
        if (authConfig.mode !== "keycloak") {
          setAuthError("Invalid email address or password.");
        }
        return false;
      }
      applySession(session);
      // S-01: Connect whether or not we have a JS-visible token (cookie mode has null token)
      if (session) {
        realtimeEngine.connectSocket(
          session.accessToken,
          session.activeScope?.tenantId
        );
      }
      return true;
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Login failed");
      return false;
    } finally {
      setIsAuthLoading(false);
    }
  };

  const loginWithKeycloakToken = async (kcAccessToken: string, kcRefreshToken: string): Promise<boolean> => {
    setIsAuthLoading(true);
    setAuthError(null);
    try {
      // Inject tokens into the keycloak-js instance so apiRequest and refresh loop work
      keycloak.token = kcAccessToken;
      keycloak.refreshToken = kcRefreshToken;
      try {
        keycloak.tokenParsed = JSON.parse(atob(kcAccessToken.split('.')[1]));
      } catch { /* non-fatal — keycloak-js may parse it later */ }

      const bootstrap = await apiRequest<{
        user: User; memberships: UserMembership[]; activeScope: AccessScope | null;
        tenants: Tenant[]; customers: Customer[]; sites: Site[]; units: Unit[];
        mt?: MtBundle | null;
      }>('/auth/bootstrap', { method: 'GET', accessToken: kcAccessToken });

      setTenants(bootstrap.tenants ?? []);
      setCustomers(bootstrap.customers ?? []);
      setSites(bootstrap.sites ?? []);
      setUnits(bootstrap.units ?? []);
      setMt(bootstrap.mt ?? null);
      applySession({
        user: bootstrap.user,
        accessToken: kcAccessToken,
        refreshToken: kcRefreshToken,
        memberships: bootstrap.memberships,
        activeScope: bootstrap.activeScope ?? bootstrap.memberships[0]?.scope ?? null,
      });
      storeRopcTokens(kcAccessToken, kcRefreshToken);
      realtimeEngine.connectSocket(kcAccessToken, bootstrap.activeScope?.tenantId ?? bootstrap.memberships[0]?.scope?.tenantId);
      return true;
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Login failed');
      return false;
    } finally {
      setIsAuthLoading(false);
    }
  };

  const logout = async () => {
    try {
      await authProvider.logout(refreshToken);
    } finally {
      realtimeEngine.disconnectSocket();
      clearSession();
      setAuthError(null);
    }
  };

  // Idle auto-logout — sign the user out after a period of inactivity. Important
  // for shared/kiosk devices so an unattended session can't be hijacked. The
  // timeout is configurable via VITE_IDLE_TIMEOUT_MINUTES (default 30; 0 disables).
  useEffect(() => {
    if (!user) return;
    const minutes = Number(import.meta.env.VITE_IDLE_TIMEOUT_MINUTES ?? 30);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    const idleMs = minutes * 60 * 1000;

    let timer: ReturnType<typeof setTimeout>;
    const onIdle = async () => {
      // logout()'s finally clears authError, so set the reason *after* it
      // resolves. In keycloak mode logout() redirects away and this never runs,
      // which is fine — Keycloak shows its own signed-out state.
      await logout();
      setAuthError("You were signed out due to inactivity.");
    };
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(onIdle, idleMs);
    };
    const events: (keyof WindowEventMap)[] = ["mousemove", "keydown", "click", "scroll", "touchstart"];
    events.forEach((ev) => window.addEventListener(ev, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((ev) => window.removeEventListener(ev, reset));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const can = (permission: Permission) => permissions.includes(permission);

  const hasAnyPermission = (requiredPermissions: Permission[]) =>
    requiredPermissions.some((permission) => can(permission));

  const setScope = (scope: AccessScope) => {
    setActiveScope(scope);
    setPermissions(authProvider.derivePermissions(memberships, scope));
    if (scope && scope.siteId) {
      localStorage.setItem('selectedSiteId', scope.siteId);
    } else {
      localStorage.removeItem('selectedSiteId');
    }
  };

  const availableTenants = useMemo(() => {
    const isGlobal = memberships.some((m) => m.scope.tenantId === null);
    if (isGlobal) return tenants;
    return tenants.filter((tenant) => memberships.some((membership) => membership.scope.tenantId === tenant.id));
  }, [memberships, tenants]);

  const availableCustomers = useMemo(() => {
    const hasGlobalCustomerAccess = memberships.some(m => !m.scope.customerId && (activeScope ? m.scope.tenantId === activeScope.tenantId : true));
    if (hasGlobalCustomerAccess) return customers;

    const customerIds = new Set(
      memberships
        .filter((membership) => (activeScope ? membership.scope.tenantId === activeScope.tenantId : true))
        .map((membership) => membership.scope.customerId)
        .filter(Boolean)
    );
    return customers.filter((customer) => customerIds.has(customer.id));
  }, [memberships, activeScope, customers]);

  const availableSites = useMemo(() => {
    const hasGlobalSiteAccess = memberships.some(m => !m.scope.siteId && (activeScope ? m.scope.tenantId === activeScope.tenantId : true));
    if (hasGlobalSiteAccess) return sites;

    const siteIds = new Set(
      memberships
        .filter((membership) => (activeScope ? membership.scope.tenantId === activeScope.tenantId : true))
        .map((membership) => membership.scope.siteId)
        .filter(Boolean)
    );
    return sites.filter((site) => siteIds.has(site.id));
  }, [memberships, activeScope, sites]);

  const availableUnits = useMemo(() => {
    const unitIds = new Set(memberships.map((membership) => membership.scope.unitId).filter(Boolean));
    return units.filter((unit) => unitIds.has(unit.id));
  }, [memberships, units]);

  // Phase 5 — multitenant helpers
  const vertical = mt?.vertical ?? null;
  const hasScope = (scopeCode: string): boolean => {
    if (!mt) return false;
    if (mt.isSuperAdmin) return true;
    return mt.scopeCodes?.includes(scopeCode) === true;
  };
  const hasFeature = (featureKey: string): boolean => {
    if (!mt) return false;
    if (mt.isSuperAdmin) return true;
    return mt.features?.includes(featureKey) === true;
  };
  const verticalLabel = (corporate: string, education: string): string => {
    return vertical === "education" ? education : corporate;
  };
  const translateRole = (role: string): string => {
    // transport labels match the confirmed persona names (build checklist,
    // Phase 8): tenant_admin=Transport Admin, site_admin=Route Manager,
    // hr_manager=Operations Manager, viewer=Viewer/Auditor — those four are
    // the only ones with an actual sign-off; hr/device_operator below just
    // follow the same generic-staff/device-identity pattern every other
    // vertical already uses for roles that were never a named persona.
    const mapping: Record<string, { corporate: string; education: string; retail: string; transport: string }> = {
      admin:           { corporate: "Tenant Admin",   education: "Tenant admin",  retail: "Store Owner",   transport: "Transport Admin"     },
      tenant_admin:    { corporate: "Tenant Admin",   education: "Tenant admin",  retail: "Store Owner",   transport: "Transport Admin"     },
      site_admin:      { corporate: "Site Admin",     education: "Principal",     retail: "Area Manager",  transport: "Route Manager"       },
      hr_manager:      { corporate: "HR Manager",     education: "Operator",      retail: "Store Manager", transport: "Operations Manager"  },
      hr:              { corporate: "HR Personnel",   education: "Staff / Assistant", retail: "Store Staff", transport: "Staff"             },
      device_operator: { corporate: "Device Operator",education: "Device Manager",retail: "Counter Device", transport: "Onboard Device"     },
      viewer:          { corporate: "Viewer",         education: "Auditor",       retail: "Viewer",        transport: "Viewer / Auditor"    },
    };
    const match = mapping[role.toLowerCase()];
    if (!match) return role;
    if (vertical === "education") return match.education;
    if (vertical === "retail")    return match.retail;
    if (vertical === "transport") return match.transport;
    return match.corporate;
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        accessToken,
        refreshToken,
        memberships,
        permissions,
        activeScope,
        tenants: availableTenants,
        customers: availableCustomers,
        sites: availableSites,
        units: availableUnits,
        login,
        loginWithKeycloakToken,
        logout,
        setActiveScope: setScope,
        can,
        hasAnyPermission,
        isAuthLoading,
        authError,
        clearAuthError: () => setAuthError(null),
        isAuthenticated: !!user,
        // Phase 5 — multitenant
        mt,
        vertical,
        hasScope,
        hasFeature,
        verticalLabel,
        translateRole,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};
