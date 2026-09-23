// ── Server-Driven UI manifest types ─────────────────────────────────────────

export interface NavItem {
  key: string;
  label: string;
  icon: string;       // lucide icon name
  sortOrder: number;
  // Optional grouped-nav fields (specs/0003-zone-analytics design.md §2.1/§3).
  // `nav_item` (the DB table backing `navigation` today) has no column for
  // any of these three — they are NOT populated by the server today. Kept
  // here, optional, so a future manifest response CAN carry them without a
  // breaking type change; until then, `navGrouping.ts` resolves the same
  // grouping client-side from `key` prefixes. Every existing manifest
  // response (no groupKey) continues to render exactly as before.
  groupKey?: string;
  groupLabel?: string;
  groupBadge?: string;
}

export interface DashboardWidget {
  id: string;
  type: 'stat' | 'chart' | 'table' | 'map' | 'alert_feed';
  label: string;
  icon?: string;
  span?: number;      // grid column span
  config?: Record<string, unknown>;
}

export interface ManifestTheme {
  primaryColor: string;
  logoUrl: string | null;
}

export type RoleName = 'super_admin' | 'tenant_admin' | 'site_admin' | 'hr_manager';

export interface DashboardManifest {
  role: RoleName;
  userId: string;
  tenantId: string | null;
  tenantName: string | null;
  siteId: string | null;
  navigation: NavItem[];
  widgets: DashboardWidget[];
  features: string[];
  theme: ManifestTheme;
  canManageRoles: string[];
  preferences?: Record<string, any>;
}
