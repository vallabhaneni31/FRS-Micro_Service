import {
  AccessScope,
  Customer,
  Permission,
  Site,
  Tenant,
  Unit,
  User,
  UserMembership,
} from "../../types";

export interface AuthSession {
  user: User;
  accessToken: string | null;
  refreshToken: string | null;
  memberships: UserMembership[];
  activeScope: AccessScope | null;
}

export interface AuthCatalog {
  tenants: Tenant[];
  customers: Customer[];
  sites: Site[];
  units: Unit[];
}

/**
 * Multitenant bundle returned by /api/auth/bootstrap (Phase 3+).
 * Populated from the new tenants/scopes/roles/groups model.
 * Components should consult these — they're vertical-aware, hierarchy-aware,
 * and plan-aware — instead of the legacy memberships.
 */
export type MtVertical = "corporate" | "education" | "retail" | "transport";

export interface MtScope {
  scope_code: string;
  menu_name: string;
  sub_menu: string | null;
  action: string;
  vertical: MtVertical | null;
}

export interface MtPlan {
  name: string;
  type: string;
  vertical: MtVertical;
  limits: {
    maxUsers: number | null;
    maxSites: number | null;
    maxUnits: number | null;
    maxDevices: number | null;
    maxEmployees: number | null;
    dataRetentionDays: number | null;
    apiRateLimitPerHour: number | null;
  };
  usage: {
    users: number;
    sites: number;
    devices: number;
    employees: number;
  };
}

export interface MtBundle {
  userId: string;
  homeTenantId: string | null;
  vertical: MtVertical | null;
  isSuperAdmin: boolean;
  scopeCodes: string[];
  scopes: MtScope[];
  features: string[];
  plan: MtPlan | null;
  minPasswordLength?: number;
}

export interface AuthBootstrap {
  session: AuthSession | null;
  catalog: AuthCatalog;
  // Optional: only the Keycloak provider populates this today. Legacy mock/api
  // providers leave it undefined and will be retired in Phase 7.
  mt?: MtBundle | null;
}

export interface AuthProvider {
  initialize: (tokens: {
    accessToken: string | null;
    refreshToken: string | null;
  }) => Promise<AuthBootstrap>;
  login: (email: string, password: string) => Promise<AuthSession | null>;
  logout: (refreshToken?: string | null) => Promise<void>;
  derivePermissions: (memberships: UserMembership[], scope: AccessScope | null) => Permission[];
}

