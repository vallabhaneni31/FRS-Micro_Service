import { authConfig } from "../../config/authConfig";
import { AccessScope, User, UserMembership } from "../../types";
import { apiRequest, ApiError } from "../http/apiClient";
import { tokenStorage } from "./tokenStorage";
import { AuthBootstrap, AuthProvider, AuthSession } from "./types";
import { derivePermissionsForScope } from "./permissionUtils";

// S-01: Login response no longer exposes tokens in body (they are httpOnly cookies)
interface LoginResponse {
  accessToken?: string;   // present in mock mode only
  refreshToken?: string;  // present in mock mode only
  user: User | ApiUser;
  memberships: UserMembership[];
  activeScope?: AccessScope | null;
  tenants?: AuthBootstrap["catalog"]["tenants"];
  customers?: AuthBootstrap["catalog"]["customers"];
  sites?: AuthBootstrap["catalog"]["sites"];
  units?: AuthBootstrap["catalog"]["units"];
}

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
}

function normalizeUser(user: User | ApiUser): User {
  return {
    ...user,
    createdAt:
      user.createdAt instanceof Date ? user.createdAt : new Date(user.createdAt),
  };
}

const emptyBootstrap = (): AuthBootstrap => ({
  session: null,
  catalog: { tenants: [], customers: [], sites: [], units: [] },
});

async function fetchBootstrap(accessToken?: string | null): Promise<BootstrapResponse> {
  // In cookie mode (api): no explicit token — httpOnly cookie sent automatically
  // In mock mode: pass token as Bearer header
  return apiRequest<BootstrapResponse>("/auth/bootstrap", {
    method: "GET",
    ...(accessToken ? { accessToken } : {}),
  });
}

function mapBootstrap(
  bootstrap: BootstrapResponse,
  tokens: { accessToken: string | null; refreshToken: string | null }
): AuthBootstrap {
  return {
    session: {
      user: normalizeUser(bootstrap.user),
      accessToken:  tokens.accessToken,
      refreshToken: tokens.refreshToken,
      memberships:  bootstrap.memberships,
      activeScope:
        bootstrap.activeScope ?? bootstrap.memberships[0]?.scope ?? null,
    },
    catalog: {
      tenants:   bootstrap.tenants,
      customers: bootstrap.customers,
      sites:     bootstrap.sites,
      units:     bootstrap.units,
    },
  };
}

export const apiAuthProvider: AuthProvider = {
  async initialize(tokens) {
    const isCookieMode = authConfig.mode === "api";

    if (isCookieMode) {
      // S-01: In cookie mode, always attempt bootstrap — httpOnly cookie is sent
      // automatically. A 401 means no valid session (cookie missing/expired).
      try {
        const bootstrap = await fetchBootstrap(null);
        return mapBootstrap(bootstrap, { accessToken: null, refreshToken: null });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return emptyBootstrap();
        throw err;
      }
    }

    // Mock / Keycloak mode: legacy token-based flow
    const { accessToken, refreshToken } = tokens;
    if (!accessToken && !refreshToken) return emptyBootstrap();

    try {
      const bootstrap = await fetchBootstrap(accessToken);
      return mapBootstrap(bootstrap, {
        accessToken:  accessToken  ?? null,
        refreshToken: refreshToken ?? null,
      });
    } catch (err) {
      // If access token failed and we have a refresh token, try refresh
      if (refreshToken && err instanceof ApiError && err.status === 401) {
        try {
          const refreshRes = await apiRequest<{ accessToken: string; refreshToken?: string }>(
            "/auth/refresh",
            { method: "POST", body: JSON.stringify({ refreshToken }) }
          );
          const newAccess  = refreshRes.accessToken;
          const newRefresh = refreshRes.refreshToken ?? refreshToken;
          tokenStorage.setTokens(newAccess, newRefresh);
          const bootstrap  = await fetchBootstrap(newAccess);
          return mapBootstrap(bootstrap, { accessToken: newAccess, refreshToken: newRefresh });
        } catch {
          return emptyBootstrap();
        }
      }
      return emptyBootstrap();
    }
  },

  async login(email, password) {
    const response = await apiRequest<LoginResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });

    // S-01: In cookie mode tokens are in httpOnly cookies (not in response body).
    // In mock mode they are still in the response for developer convenience.
    const accessToken  = response.accessToken  ?? null;
    const refreshToken = response.refreshToken ?? null;

    if (accessToken) tokenStorage.setTokens(accessToken, refreshToken);

    return {
      user:         normalizeUser(response.user),
      accessToken,
      refreshToken,
      memberships:  response.memberships,
      activeScope:  response.activeScope ?? response.memberships[0]?.scope ?? null,
    } as AuthSession;
  },

  async logout(_refreshToken) {
    try {
      // S-01: Server reads httpOnly cookie to identify session and clears it
      await apiRequest("/auth/logout", { method: "POST" });
    } catch {
      // Clear local state regardless of API response
    }
  },

  derivePermissions: derivePermissionsForScope,
};
