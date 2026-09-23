import { LucideIcon } from 'lucide-react';
import { getIcon } from './iconRegistry';

/** Flat sidebar nav item shape produced by DashboardRenderer.tsx's toSidebarNav. */
export interface FlatSidebarNavItem {
  label: string;
  icon: LucideIcon;
  value: string;
}

/** A grouped sidebar nav entry — Sidebar.tsx renders this as a collapsible section. */
export interface GroupedSidebarNavItem {
  label: string;
  icon: LucideIcon;
  value: null;
  badge: string;
  children: FlatSidebarNavItem[];
}

export type SidebarNavEntry = FlatSidebarNavItem | GroupedSidebarNavItem;

export function isGroupedNavEntry(entry: SidebarNavEntry): entry is GroupedSidebarNavItem {
  return entry.value === null;
}

/**
 * Client-side group metadata lookup (design.md §3's fallback path): `nav_item`
 * (the table backing the manifest's `navigation`, frs-fe-api/src/db/migrations
 * /001_init_schema.sql:2401-2412) has no column that could carry a group
 * label/badge, so — rather than a schema change — every key sharing this
 * prefix is grouped under this hardcoded header. A manifest item that already
 * carries `groupKey`/`groupLabel`/`groupBadge` (a future server-driven path)
 * takes precedence over this table when present.
 */
interface GroupConfig {
  prefix?: string;
  prefixes?: string[];
  exactKeys?: string[];
  groupKey: string;
  groupLabel: string;
  groupBadge?: string;
  icon: string;
  childOrder?: string[];
}

const GROUP_BY_KEY_PREFIX: GroupConfig[] = [
  {
    prefixes: ['zone_analytics.'],
    exactKeys: ['hr_manager/analytics', 'analytics'],
    groupKey: 'analytics',
    groupLabel: 'Analytics',
    icon: 'BarChart3',
    childOrder: [
      'zone_analytics.overview',
      'zone_analytics.deep_dive',
      'zone_analytics.compare',
      'zone_analytics.movement',
      'hr_manager/analytics',
      'analytics',
    ],
  },
];

function resolveGroupForKey(key: string): GroupConfig | null {
  const match = GROUP_BY_KEY_PREFIX.find((g) => {
    if (g.exactKeys?.includes(key)) return true;
    if (g.prefix && key.startsWith(g.prefix)) return true;
    if (g.prefixes?.some((p) => key.startsWith(p))) return true;
    return false;
  });
  return match ?? null;
}

interface UngroupedEntry {
  label: string;
  icon: LucideIcon;
  value: string;
  groupKey?: string;
  groupLabel?: string;
  groupBadge?: string;
}

/**
 * Groups consecutive-or-not items sharing a groupKey into one
 * `{label, icon, value: null, badge, children}` entry, preserving each
 * group's position at its first member's position and preserving child
 * order. Items with no resolvable groupKey pass through unchanged — this is
 * a no-op for every manifest that doesn't use grouping (regression guard for
 * every other page's sidebar, per Task 10's test requirement).
 */
export function applyNavGrouping(items: UngroupedEntry[]): SidebarNavEntry[] {
  const result: SidebarNavEntry[] = [];
  const groupIndexByKey = new Map<string, number>();

  for (const item of items) {
    // A future server-driven manifest carrying groupKey/groupLabel/groupBadge
    // directly takes precedence over the client-side lookup table.
    const fromServer = item.groupKey
      ? { groupKey: item.groupKey, groupLabel: item.groupLabel ?? item.groupKey, groupBadge: item.groupBadge ?? '' }
      : null;
    const fromClientLookup = !fromServer ? resolveGroupForKey(item.value) : null;
    const resolved: { groupKey: string; groupLabel: string; groupBadge?: string; childOrder?: string[] } | null = fromServer ?? fromClientLookup;

    if (!resolved) {
      result.push({ label: item.label, icon: item.icon, value: item.value });
      continue;
    }

    const existingIdx = groupIndexByKey.get(resolved.groupKey);
    const child: FlatSidebarNavItem = { label: item.label, icon: item.icon, value: item.value };

    if (existingIdx !== undefined) {
      const grouped = result[existingIdx] as GroupedSidebarNavItem;
      grouped.children.push(child);
      if (!fromServer) {
        grouped.badge = `${grouped.children.length} VIEWS`;
      }
      if (resolved.childOrder) {
        const order = resolved.childOrder;
        grouped.children.sort((a, b) => {
          const idxA = order.indexOf(a.value);
          const idxB = order.indexOf(b.value);
          if (idxA !== -1 && idxB !== -1) return idxA - idxB;
          if (idxA !== -1) return -1;
          if (idxB !== -1) return 1;
          return 0;
        });
      }
      continue;
    }

    // Server-driven grouping has no dedicated group icon field, so the first
    // child's icon doubles as the group icon in that path; the client-side
    // lookup table supplies its own.
    const groupIcon = fromServer ? item.icon : getIcon((fromClientLookup as NonNullable<typeof fromClientLookup>).icon);
    const group: GroupedSidebarNavItem = {
      label: resolved.groupLabel,
      icon: groupIcon,
      value: null,
      badge: fromServer ? resolved.groupBadge : '1 VIEWS',
      children: [child],
    };
    groupIndexByKey.set(resolved.groupKey, result.length);
    result.push(group);
  }

  return result;
}
