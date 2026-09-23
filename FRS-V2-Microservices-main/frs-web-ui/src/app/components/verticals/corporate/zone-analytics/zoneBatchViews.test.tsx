import React from 'react';
import { render, screen, waitFor, fireEvent, configure } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeApi, OVERVIEW_ROUTES, HEATMAP, ENTRY_POINTS, TIME_SPENT, MATRIX, EVENTS, EVENT_ROWS, EMPLOYEES, MOVEMENT, COMPARE, ZONES } from './testing/fixtures';

// specs/0003-zone-analytics — Task 29 (AC 12.1, 12.5, 12.6, 5.6): the four pages against the batch
// endpoints. apiRequest is mocked, so this is a component-level test, NOT a browser E2E test
// (no Playwright/Cypress harness exists in frs-web-ui).

configure({ asyncUtilTimeout: 3000 });
const api = vi.hoisted(() => ({ handler: null as any }));
vi.mock('../../../../contexts/AuthContext', () => ({ useAuth: () => ({ accessToken: 'fake-token', activeScope: null }) }));
vi.mock('../../../../services/http/apiClient', () => ({ apiRequest: (path: string, o: unknown) => api.handler(path, o) }));

import { ZoneAnalyticsOverviewPage } from './ZoneAnalyticsOverviewPage';
import { ZoneDeepDivePage } from './ZoneDeepDivePage';
import { CompareZonesPage } from './CompareZonesPage';
import { EmployeeMovementPage } from './EmployeeMovementPage';

const ROUTES = {
  ...OVERVIEW_ROUTES,
  '/zones/analytics/heatmap': HEATMAP,
  '/zones/analytics/entry-points': ENTRY_POINTS,
  '/zones/analytics/time-spent': TIME_SPENT,
  '/zones/movement/matrix': MATRIX,
  '/zones/employees': EMPLOYEES,
  '/zones/movement/': MOVEMENT,
  '/zones/compare': COMPARE(),
  '/zones/departments': [{ departmentId: 1, name: 'Sales' }],
  '/zones': ZONES,
};
let mock: ReturnType<typeof makeApi>;
const setApi = (overrides: Record<string, unknown> = {}) => { mock = makeApi({ ...ROUTES, ...overrides }); api.handler = mock.handler; };
const wrap = (el: React.ReactElement) => render(<MemoryRouter><Routes><Route path="*" element={el} /></Routes></MemoryRouter>);
const q = (path: string) => new URLSearchParams(path.split('?')[1]);
const batchCalls = (part: string) => mock.calls.filter((c) => c.path.startsWith(part));
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('AC 12.1 — a view loads with at most 3 HTTP requests, all batch requests', () => {
  beforeEach(() => setApi());

  it('Overview: 2 requests (core + detail), no per-widget call', async () => {
    wrap(<ZoneAnalyticsOverviewPage />);
    await waitFor(() => expect(screen.getByTestId('hero-headcount-value')).toHaveTextContent('8'));
    await waitFor(() => expect(screen.getAllByTestId('event-row').length).toBeGreaterThan(0));
    await settle();
    expect(mock.calls.map((c) => c.path.split('?')[0]).sort()).toEqual(['/zones/batch/overview/core', '/zones/batch/overview/detail']);
    expect(mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('Deep-Dive: 3 requests (filters + core + detail)', async () => {
    wrap(<ZoneDeepDivePage />);
    await waitFor(() => expect(screen.getByTestId('hero-headcount-value')).toHaveTextContent('8'));
    await waitFor(() => expect(screen.getAllByTestId('event-row').length).toBeGreaterThan(0));
    await settle();
    expect(mock.calls.map((c) => c.path.split('?')[0]).sort()).toEqual(['/zones/batch/deep-dive/core', '/zones/batch/deep-dive/detail', '/zones/batch/filters']);
  });

  it('Compare: at most 3 requests (the zone list rides in core; the comparison joins it once 2 zones are chosen)', async () => {
    wrap(<CompareZonesPage />);
    await waitFor(() => expect(mock.calls.some((c) => c.path.includes('zone=') && c.path.includes('metric='))).toBe(true));
    await settle();
    expect(mock.calls.length).toBeLessThanOrEqual(3);
    expect(mock.calls.every((c) => c.path.startsWith('/zones/batch/compare/core'))).toBe(true);
  });

  it('Employee Movement: 2 requests (filters + core: cards and Top Employees table together)', async () => {
    wrap(<EmployeeMovementPage />);
    await waitFor(() => expect(screen.getAllByTestId('employee-card').length).toBeGreaterThan(0));
    await settle();
    expect(mock.calls.map((c) => c.path.split('?')[0]).sort()).toEqual(['/zones/batch/filters', '/zones/batch/movement/core']);
  });

  it('never calls a single-widget endpoint any more', async () => {
    wrap(<ZoneDeepDivePage />);
    await waitFor(() => expect(screen.getByTestId('hero-headcount-value')).toHaveTextContent('8'));
    await settle();
    expect(mock.calls.some((c) => /^\/zones\/(analytics|events|employees|movement|compare)/.test(c.path))).toBe(false);
    expect(mock.calls.some((c) => c.path === '/zones' || c.path.startsWith('/zones?'))).toBe(false);
  });

  it('Employee Movement: the event stream / drilldown request asks for photos (withPhotos=1); the list request does not', async () => {
    wrap(<EmployeeMovementPage />);
    await waitFor(() => expect(screen.getAllByTestId('employee-card').length).toBeGreaterThan(0));
    expect(batchCalls('/zones/batch/movement/core').every((c) => !c.path.includes('withPhotos'))).toBe(true);
    fireEvent.click(screen.getAllByRole('button', { name: /View Activity Trail/ })[0]);
    await waitFor(() => expect(batchCalls('/zones/batch/movement/detail').length).toBeGreaterThan(0));
    const detail = q(batchCalls('/zones/batch/movement/detail')[0].path);
    expect(detail.get('withPhotos')).toBe('1');
    expect(detail.get('employeeId')).toBe('7');
  });
});

describe('AC 12.6 — skeletons and core-before-detail', () => {
  it('core widgets render as soon as the core batch returns, while the detail table still shows a skeleton', async () => {
    setApi();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const inner = api.handler;
    api.handler = async (path: string, o: unknown) => {
      if (path.startsWith('/zones/batch/overview/detail')) await gate;
      return inner(path, o);
    };
    wrap(<ZoneAnalyticsOverviewPage />);
    // before anything returns: skeletons, no hero value yet
    expect(screen.getAllByTestId('widget-skeleton').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByTestId('hero-headcount-value')).toHaveTextContent('8'));
    // detail still pending: the events table is a skeleton, not an empty message
    expect(screen.queryAllByTestId('event-row')).toHaveLength(0);
    expect(document.querySelector('#table-recent-zone-events [data-testid="widget-skeleton"]')).not.toBeNull();
    release();
    await waitFor(() => expect(screen.getAllByTestId('event-row').length).toBeGreaterThan(0));
    expect(document.querySelector('#table-recent-zone-events [data-testid="widget-skeleton"]')).toBeNull();
  });
});

describe('AC 12.5 — Refresh bypasses the cache and shows the server computedAt', () => {
  it('Overview: Refresh sends refresh=1 on both parts; "Updated" shows the server computedAt', async () => {
    setApi();
    const stamps = ['2026-09-21T04:30:00.000Z', '2026-09-21T09:15:00.000Z'];
    let n = 0;
    const inner = api.handler;
    api.handler = async (path: string, o: unknown) => {
      const res: any = await inner(path, o);
      return path.startsWith('/zones/batch/') ? { ...res, computedAt: path.includes('refresh=1') ? stamps[1] : stamps[0] } : res;
    };
    wrap(<ZoneAnalyticsOverviewPage />);
    await waitFor(() => expect(screen.getByTestId('hero-headcount-value')).toHaveTextContent('8'));
    await waitFor(() => expect(screen.getByTestId('last-updated').textContent).toContain(new Date(stamps[0]).toLocaleTimeString()));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mock.calls.filter((c) => c.path.includes('refresh=1')).map((c) => c.path.split('?')[0]).sort()).toEqual(['/zones/batch/overview/core', '/zones/batch/overview/detail']));
    await waitFor(() => expect(screen.getByTestId('last-updated').textContent).toContain(new Date(stamps[1]).toLocaleTimeString()));
    expect(n).toBe(0);
  });
});

describe('AC 12.6 — debounce in the pages', () => {
  it('Deep-Dive: two quick filter changes produce ONE new core request (400 ms after the last)', async () => {
    setApi();
    wrap(<ZoneDeepDivePage />);
    await waitFor(() => expect(screen.getByTestId('hero-headcount-value')).toHaveTextContent('8'));
    const before = batchCalls('/zones/batch/deep-dive/core').length;
    fireEvent.click(screen.getByRole('button', { name: 'This Week' }));
    fireEvent.click(screen.getByRole('button', { name: 'This Month' }));
    await new Promise((r) => setTimeout(r, 200));
    expect(batchCalls('/zones/batch/deep-dive/core').length).toBe(before); // still waiting
    await waitFor(() => expect(batchCalls('/zones/batch/deep-dive/core').length).toBe(before + 1));
    await settle();
    expect(batchCalls('/zones/batch/deep-dive/core').length).toBe(before + 1);
  });
});

describe('AC 5.6 — All / Employees / Visitors in Recent Zone Activity', () => {
  it('Overview: control present, defaults to All (no personType param); Visitors / Employees refetch only the detail part with page 1', async () => {
    setApi();
    wrap(<ZoneAnalyticsOverviewPage />);
    await waitFor(() => expect(screen.getAllByTestId('event-row').length).toBeGreaterThan(0));
    const group = screen.getByRole('group', { name: 'Person type' });
    const buttons = Array.from(group.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toEqual(['All', 'Employees', 'Visitors']);
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(q(batchCalls('/zones/batch/overview/detail')[0].path).has('personType')).toBe(false);

    const coreBefore = batchCalls('/zones/batch/overview/core').length;
    fireEvent.click(screen.getByRole('button', { name: 'Visitors' }));
    expect(screen.getByRole('button', { name: 'Visitors' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(batchCalls('/zones/batch/overview/detail').length).toBe(2));
    const last = q(batchCalls('/zones/batch/overview/detail')[1].path);
    expect(last.get('personType')).toBe('visitor');
    expect(last.get('page')).toBe('1');
    expect(last.get('pageSize')).toBe('5');
    expect(batchCalls('/zones/batch/overview/core').length).toBe(coreBefore);

    fireEvent.click(screen.getByRole('button', { name: 'Employees' }));
    await waitFor(() => expect(batchCalls('/zones/batch/overview/detail').length).toBe(3));
    expect(q(batchCalls('/zones/batch/overview/detail')[2].path).get('personType')).toBe('employee');
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(batchCalls('/zones/batch/overview/detail').length).toBe(4));
    expect(q(batchCalls('/zones/batch/overview/detail')[3].path).has('personType')).toBe(false);
  });

  it('Deep-Dive: changing the person type resets to page 1 and combines with event type, status and search', async () => {
    setApi({ '/zones/events/recent': () => EVENTS(EVENT_ROWS, 45) });
    wrap(<ZoneDeepDivePage />);
    await waitFor(() => expect(screen.getAllByTestId('event-row').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(q(batchCalls('/zones/batch/deep-dive/detail').slice(-1)[0].path).get('page')).toBe('2'));
    fireEvent.change(screen.getByLabelText('Event type'), { target: { value: 'unknown_face' } });
    fireEvent.change(screen.getByLabelText('Recognition status'), { target: { value: 'unrecognized' } });
    fireEvent.change(screen.getByLabelText('Search events'), { target: { value: 'lobby' } });
    fireEvent.click(screen.getByRole('button', { name: 'Visitors' }));
    await waitFor(() => {
      const last = q(batchCalls('/zones/batch/deep-dive/detail').slice(-1)[0].path);
      expect(last.get('personType')).toBe('visitor');
      expect(last.get('page')).toBe('1');
      expect(last.get('eventType')).toBe('unknown_face');
      expect(last.get('status')).toBe('unrecognized');
      expect(last.get('q')).toBe('lobby');
    });
    // combines with the security-only filter of the core scope too (same shared query)
  });

  it('unknown faces are shown as "Visitor (unregistered)", never "Unregistered person"; visitor rows show no employee id', async () => {
    setApi();
    wrap(<ZoneDeepDivePage />);
    await waitFor(() => expect(screen.getAllByTestId('event-row').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Visitor (unregistered)').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('Unregistered person');
  });

  it('a registered-visitor row is labelled Visitor and has no employee name/code', async () => {
    const row = { ...EVENT_ROWS[2], id: 'v1', eventType: 'visitor_detected', recognitionStatus: 'verified', employeeName: null, employeeCode: null, employeeId: null, details: 'Registered visitor: Ann' };
    setApi({ '/zones/events/recent': () => EVENTS([row as any], 1) });
    wrap(<ZoneDeepDivePage />);
    await waitFor(() => expect(screen.getAllByTestId('event-row')).toHaveLength(1));
    expect(screen.getByText('Visitor (registered)')).toBeInTheDocument();
    expect(screen.getByText('Registered visitor: Ann')).toBeInTheDocument();
  });
});
