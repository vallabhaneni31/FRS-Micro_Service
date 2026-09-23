import React from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeApi, OVERVIEW_ROUTES, HEATMAP, ENTRY_POINTS, TIME_SPENT, MATRIX, EMPLOYEES, MOVEMENT, COMPARE, ZONES } from './testing/fixtures';

// specs/0003-zone-analytics — Task 23 (AC 10.1-10.4): class/viewport assertions for all four views.
// jsdom has no layout engine and this repo has no Playwright/Cypress harness, so these assert the
// responsive Tailwind classes that produce the behaviour (tables scroll, grids collapse, headers
// stack); they do NOT prove how the page looks at 640/768/1024/1280 px in a real browser.

const api = vi.hoisted(() => ({ handler: null as any }));
vi.mock('../../../../contexts/AuthContext', () => ({ useAuth: () => ({ accessToken: 'fake-token', activeScope: null }) }));
vi.mock('../../../../services/http/apiClient', () => ({ apiRequest: (path: string, o: unknown) => api.handler(path, o) }));
vi.mock('../../../../services/http/authedPhoto', () => ({ useAuthedPhotoUrl: () => ({ url: null, loading: false, error: false }) }));

import { ZoneAnalyticsOverviewPage } from './ZoneAnalyticsOverviewPage';
import { ZoneDeepDivePage } from './ZoneDeepDivePage';
import { CompareZonesPage } from './CompareZonesPage';
import { EmployeeMovementPage } from './EmployeeMovementPage';

const compareFor = (path: string) => {
  const names = new URLSearchParams(path.split('?')[1]).getAll('zone');
  const base = COMPARE();
  const t = base.zones.Lobby;
  return { ...base, zones: Object.fromEntries(names.map((n) => [n, t])), matrix: names.map((n) => ({ ...base.matrix[0], zone: n })) };
};

beforeEach(() => {
  const mock = makeApi({
    ...OVERVIEW_ROUTES,
    '/zones/analytics/heatmap': HEATMAP,
    '/zones/analytics/entry-points': ENTRY_POINTS,
    '/zones/analytics/time-spent': TIME_SPENT,
    '/zones/movement/matrix': MATRIX,
    '/zones/movement/': MOVEMENT,
    '/zones/compare': compareFor,
    '/zones/employees': EMPLOYEES,
    '/zones': ZONES,
  });
  api.handler = mock.handler;
});

const VIEWS: [string, React.FC, string][] = [
  ['Overview Dashboard', ZoneAnalyticsOverviewPage, 'hero-headcount-value'],
  ['Zone Deep-Dive', ZoneDeepDivePage, 'chip-peak'],
  ['Compare Zones', CompareZonesPage, 'metrics-matrix'],
  ['Employee Movement', EmployeeMovementPage, 'summary-tracked'],
];

const mount = async (Page: React.FC, waitFor_: string) => {
  render(<MemoryRouter><Page /></MemoryRouter>);
  await waitFor(() => expect(screen.getByTestId(waitFor_)).toBeInTheDocument());
  await waitFor(() => expect(document.querySelectorAll('table').length + document.querySelectorAll('.recharts-wrapper, [data-testid="heatmap-cell"]').length).toBeGreaterThan(0));
};

describe.each(VIEWS)('%s — responsiveness', (_name, Page, ready) => {
  it('AC 10.2 — every table sits inside a horizontally scrolling container (never clipped)', async () => {
    await mount(Page, ready);
    const tables = [...document.querySelectorAll('table')];
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) {
      let el: HTMLElement | null = t.parentElement;
      let scrolls = false;
      while (el && !scrolls) { scrolls = /\boverflow-x-auto\b/.test(el.className); el = el.parentElement; }
      expect(scrolls, 'a table has no overflow-x-auto ancestor').toBe(true);
    }
    cleanup();
  });

  it('AC 10.3 — every responsive grid starts at one column and only adds columns at wider breakpoints', async () => {
    await mount(Page, ready);
    const grids = [...document.querySelectorAll<HTMLElement>('[class*="grid-cols-"]')].filter((g) => /\b(sm|md|lg|xl):grid-cols-\d/.test(g.className));
    expect(grids.length).toBeGreaterThan(0);
    for (const g of grids) {
      // an explicit base column count that is lower than the widest breakpoint's count
      const base = Number(/(^|\s)grid-cols-(\d+)/.exec(g.className)?.[2]);
      const widest = Math.max(...[...g.className.matchAll(/\b(?:sm|md|lg|xl):grid-cols-(\d+)/g)].map((m) => Number(m[1])));
      expect(Number.isFinite(base), g.className).toBe(true);
      expect(base, g.className).toBeLessThan(widest);
    }
    cleanup();
  });

  it('AC 10.4 — the page header stacks (column) on narrow screens and lays out in a row from sm', async () => {
    await mount(Page, ready);
    const header = screen.getByTestId('zone-view-header');
    const row = header.querySelector('div.flex.justify-between') as HTMLElement;
    expect(row.className).toContain('flex-col');
    expect(row.className).toContain('sm:flex-row');
    expect(header.querySelector('nav')!.className).toContain('flex-wrap');
    cleanup();
  });
});

describe('Deep-Dive and Employee Movement — filter bars stack before they overflow (AC 10.4)', () => {
  it('the Deep-Dive filter bar is a column below lg and wraps its controls', async () => {
    await mount(ZoneDeepDivePage, 'chip-peak');
    const bar = document.getElementById('global-filters-panel')!.firstElementChild as HTMLElement;
    expect(bar.className).toContain('flex-col');
    expect(bar.className).toContain('lg:flex-row');
    expect(bar.firstElementChild!.className).toContain('flex-wrap');
    cleanup();
  });

  it('the Employee Movement toolbar stacks below md and wraps its selects', async () => {
    await mount(EmployeeMovementPage, 'summary-tracked');
    const toolbar = document.getElementById('input-search-employee-zone')!.closest('div.flex.flex-col') as HTMLElement;
    expect(toolbar.className).toContain('md:flex-row');
    expect(toolbar.querySelector('.flex-wrap')).not.toBeNull();
    cleanup();
  });
});
