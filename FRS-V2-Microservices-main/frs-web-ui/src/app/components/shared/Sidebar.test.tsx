import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { LayoutDashboard, BarChart3, Activity, Route as RouteIcon, MapPin, Users } from 'lucide-react';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { role: 'hr_manager' }, translateRole: (r: string) => r }),
}));

import { Sidebar } from './Sidebar';

// specs/0003-zone-analytics — Task 11: Sidebar.tsx grouped-section rendering.
// AC 1.1-1.4, 1.7.

const zoneAnalyticsChildren = [
  { label: 'Overview Dashboard', icon: LayoutDashboard, value: 'zone_analytics.overview' },
  { label: 'Zone Deep-Dive', icon: BarChart3, value: 'zone_analytics.deep_dive' },
  { label: 'Compare Zones', icon: Activity, value: 'zone_analytics.compare' },
  { label: 'Employee Movement', icon: RouteIcon, value: 'zone_analytics.movement' },
];

const groupedItem = {
  label: 'Zone Analytics',
  icon: MapPin,
  value: null as null,
  badge: '4 VIEWS',
  children: zoneAnalyticsChildren,
};

describe('Sidebar — Zone Analytics group', () => {
  it('AC 1.1 — a "Zone Analytics" group renders once with exactly 4 child items in order', () => {
    render(
      <Sidebar
        title="Test"
        navigationItems={[{ label: 'Employees', icon: Users, value: 'employees' }, groupedItem]}
        activeTab="employees"
      />
    );
    expect(screen.getAllByText('Zone Analytics').length).toBe(1);
    // The group starts expanded (AC 1.2): the children are visible without a click.
    const group = screen.getByTestId('sidebar-group');
    const kids = within(group).getAllByRole('button').slice(1).map((b) => b.textContent);
    expect(kids).toEqual(zoneAnalyticsChildren.map((c) => c.label));
    expect(screen.getAllByTestId('sidebar-group')).toHaveLength(1);
  });

  it('AC 1.2 — group has a "4 VIEWS" badge, a chevron, an indented child list with a connector line, and starts expanded', () => {
    render(<Sidebar title="Test" navigationItems={[groupedItem]} />);
    expect(screen.getByText('4 VIEWS')).toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: /Zone Analytics/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger.querySelector('svg.lucide-chevron-down')).not.toBeNull();
    expect(trigger.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2);
    const list = screen.getByText('Overview Dashboard').closest('div.border-l')!;
    expect(list.className).toContain('ml-4');
    expect(list.className).toContain('pl-3');
    expect(list.className).toContain('border-l');
  });

  it('AC 1.2 — the chevron rotates when the group is collapsed', () => {
    render(<Sidebar title="Test" navigationItems={[groupedItem]} />);
    const trigger = screen.getByRole('button', { name: /Zone Analytics/ });
    const chevron = () => trigger.querySelector('svg.lucide-chevron-down')!.getAttribute('class')!;
    expect(chevron()).toContain('rotate-0');
    fireEvent.click(trigger);
    expect(chevron()).toContain('-rotate-90');
  });

  it('AC 1.2/1.3 — the active child is a filled accent pill with white text and the group shows as active', () => {
    render(<Sidebar title="Test" navigationItems={[groupedItem]} activeTab="zone_analytics.deep_dive" />);
    const active = screen.getByText('Zone Deep-Dive').closest('button')!;
    expect(active.className).toContain('bg-primary');
    expect(active.className).toContain('text-primary-foreground');
    expect(active).toHaveAttribute('aria-current', 'page');
    const inactive = screen.getByText('Overview Dashboard').closest('button')!;
    expect(inactive.className).not.toContain('text-primary-foreground');
    expect(screen.getByRole('button', { name: /Zone Analytics/ }).className).toContain('bg-blue-600/10');
  });

  it('AC 1.3 — the group is expanded and its active child shown when a child route is active', () => {
    render(<Sidebar title="Test" navigationItems={[groupedItem]} activeTab="zone_analytics.overview" />);
    expect(screen.getByText('Overview Dashboard')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Zone Analytics/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('AC 1.4 — clicking the chevron collapses / expands the children without navigating', () => {
    const onNavigate = vi.fn();
    render(<Sidebar title="Test" navigationItems={[groupedItem]} onNavigate={onNavigate} />);
    expect(screen.getByText('Overview Dashboard')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Zone Analytics'));
    expect(screen.queryByText('Overview Dashboard')).not.toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Zone Analytics'));
    expect(screen.getByText('Overview Dashboard')).toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('AC 1.5 — clicking a child navigates to that view', () => {
    const onNavigate = vi.fn();
    render(<Sidebar title="Test" navigationItems={[groupedItem]} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText('Zone Deep-Dive'));
    expect(onNavigate).toHaveBeenCalledWith('zone_analytics.deep_dive');
    fireEvent.click(screen.getByText('Employee Movement'));
    expect(onNavigate).toHaveBeenLastCalledWith('zone_analytics.movement');
  });

  it('AC 1.7 — icon-only sidebar (w-20) shows the group icon with a hover tooltip listing all 4 views', () => {
    render(<Sidebar title="Test" navigationItems={[groupedItem]} isCollapsed />);
    expect(document.querySelector('aside')!.className).toContain('w-20');
    const groupIconButton = screen.getByTestId('sidebar-group-collapsed');
    fireEvent.mouseEnter(groupIconButton);
    const tooltip = screen.getByRole('tooltip');
    for (const child of zoneAnalyticsChildren) {
      expect(tooltip).toHaveTextContent(child.label);
    }
  });

  it('AC 10.1 — desktop sidebar is w-64 (expanded) / w-20 (icon-only) and hidden below md', () => {
    const { unmount } = render(<Sidebar title="Test" navigationItems={[groupedItem]} />);
    const aside = document.querySelector('aside')!;
    expect(aside.className).toContain('hidden');
    expect(aside.className).toContain('md:flex');
    expect(aside.className).toContain('w-64');
    unmount();
    render(<Sidebar title="Test" navigationItems={[groupedItem]} isCollapsed />);
    expect(document.querySelector('aside')!.className).toContain('w-20');
  });
});
