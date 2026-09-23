import { describe, it, expect } from 'vitest';
import { MapPin, LayoutDashboard, Users } from 'lucide-react';
import { applyNavGrouping, isGroupedNavEntry } from './navGrouping';

// specs/0003-zone-analytics — Task 10: NavItem grouping (design.md §2.1/§3).

describe('applyNavGrouping', () => {
  it('manifest with no groupKey renders unchanged (regression guard for every other page)', () => {
    const items = [
      { label: 'Dashboard', icon: LayoutDashboard, value: 'dashboard' },
      { label: 'Employees', icon: Users, value: 'employees' },
    ];
    const out = applyNavGrouping(items);
    expect(out).toEqual(items);
    expect(out.every((e) => !isGroupedNavEntry(e))).toBe(true);
  });

  it('4 items sharing the zone_analytics. key prefix render as one group entry with 4 children', () => {
    const items = [
      { label: 'Dashboard', icon: LayoutDashboard, value: 'dashboard' },
      { label: 'Overview Dashboard', icon: LayoutDashboard, value: 'zone_analytics.overview' },
      { label: 'Zone Deep-Dive', icon: LayoutDashboard, value: 'zone_analytics.deep_dive' },
      { label: 'Compare Zones', icon: LayoutDashboard, value: 'zone_analytics.compare' },
      { label: 'Employee Movement', icon: LayoutDashboard, value: 'zone_analytics.movement' },
    ];
    const out = applyNavGrouping(items);
    // Non-group item passes through, plus exactly one group entry.
    expect(out.length).toBe(2);
    const group = out.find(isGroupedNavEntry);
    expect(group).toBeTruthy();
    expect(group!.label).toBe('Analytics');
    expect(group!.badge).toBe('4 VIEWS');
    expect(group!.value).toBeNull();
    expect(group!.children.length).toBe(4);
    expect(group!.children.map((c) => c.value)).toEqual([
      'zone_analytics.overview', 'zone_analytics.deep_dive', 'zone_analytics.compare', 'zone_analytics.movement',
    ]);
  });

  it('groups hr_manager/analytics and zone_analytics.* into Analytics group with 5 views', () => {
    const items = [
      { label: 'Dashboard', icon: LayoutDashboard, value: 'dashboard' },
      { label: 'Workforce Analytics', icon: Users, value: 'hr_manager/analytics' },
      { label: 'Attendance', icon: LayoutDashboard, value: 'attendance' },
      { label: 'Overview Dashboard', icon: LayoutDashboard, value: 'zone_analytics.overview' },
      { label: 'Zone Deep-Dive', icon: LayoutDashboard, value: 'zone_analytics.deep_dive' },
      { label: 'Compare Zones', icon: LayoutDashboard, value: 'zone_analytics.compare' },
      { label: 'Employee Movement', icon: LayoutDashboard, value: 'zone_analytics.movement' },
    ];
    const out = applyNavGrouping(items);
    expect(out.length).toBe(3); // Dashboard, Analytics group, Attendance
    expect(out[0].label).toBe('Dashboard');
    expect(out[1].label).toBe('Analytics');
    expect(out[2].label).toBe('Attendance');

    const group = out[1];
    expect(isGroupedNavEntry(group)).toBe(true);
    if (isGroupedNavEntry(group)) {
      expect(group.badge).toBe('5 VIEWS');
      expect(group.children.length).toBe(5);
      expect(group.children.map((c) => c.label)).toEqual([
        'Overview Dashboard',
        'Zone Deep-Dive',
        'Compare Zones',
        'Employee Movement',
        'Workforce Analytics',
      ]);
      expect(group.children.map((c) => c.value)).toEqual([
        'zone_analytics.overview',
        'zone_analytics.deep_dive',
        'zone_analytics.compare',
        'zone_analytics.movement',
        'hr_manager/analytics',
      ]);
    }
  });

  it('a server-driven groupKey/groupLabel/groupBadge (future manifest path) takes precedence over the client lookup', () => {
    const items = [
      { label: 'A', icon: MapPin, value: 'custom.a', groupKey: 'custom', groupLabel: 'Custom Group', groupBadge: '2 VIEWS' },
      { label: 'B', icon: MapPin, value: 'custom.b', groupKey: 'custom', groupLabel: 'Custom Group', groupBadge: '2 VIEWS' },
    ];
    const out = applyNavGrouping(items);
    expect(out.length).toBe(1);
    const group = out[0];
    expect(isGroupedNavEntry(group)).toBe(true);
    if (isGroupedNavEntry(group)) {
      expect(group.label).toBe('Custom Group');
      expect(group.badge).toBe('2 VIEWS');
      expect(group.children.length).toBe(2);
    }
  });
});

// AC 1.1 / 1.6 (spec Revision 10, human decision 2026-09-21): the zone views are grouped with the
// existing Workforce Analytics item under one "Analytics" group of 5 views, all zone views inside it.
describe('AC 1.1/1.6 - single Analytics group holding the four zone views plus Workforce Analytics', () => {
  it('renders exactly one group, titled "Analytics", with 5 children including the 4 zone views', () => {
    const items = [
      { label: 'Workforce Analytics', icon: Users, value: 'hr_manager/analytics' },
      { label: 'Overview Dashboard', icon: LayoutDashboard, value: 'zone_analytics.overview' },
      { label: 'Zone Deep-Dive', icon: LayoutDashboard, value: 'zone_analytics.deep_dive' },
      { label: 'Compare Zones', icon: LayoutDashboard, value: 'zone_analytics.compare' },
      { label: 'Employee Movement', icon: LayoutDashboard, value: 'zone_analytics.movement' },
    ];
    const groups = applyNavGrouping(items).filter(isGroupedNavEntry);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Analytics');
    expect(groups[0].children).toHaveLength(5);
    const labels = groups[0].children.map((c) => c.label);
    for (const l of ['Overview Dashboard', 'Zone Deep-Dive', 'Compare Zones', 'Employee Movement']) {
      expect(labels).toContain(l);
    }
  });
});
