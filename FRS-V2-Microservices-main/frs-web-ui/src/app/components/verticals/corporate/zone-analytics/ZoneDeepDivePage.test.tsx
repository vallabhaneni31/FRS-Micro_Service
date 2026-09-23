import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { configure } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeApi, OVERVIEW_ROUTES, HEATMAP, ENTRY_POINTS, TIME_SPENT, MATRIX, EVENTS, EVENT_ROWS, SUMMARY } from './testing/fixtures';
import { presetRange } from './lib/format';

// specs/0003-zone-analytics — Task 20: Zone Deep-Dive (AC 7.1-7.4, 3.9, 6.6-6.8).
// Component-level tier: no Playwright/Cypress harness exists in frs-web-ui, so this is
// NOT a browser E2E test; the network is mocked at apiRequest and every request path is asserted.

configure({ asyncUtilTimeout: 3000 }); // param changes are debounced 400 ms (AC 12.6)
const api = vi.hoisted(() => ({ handler: null as any }));
vi.mock('../../../../contexts/AuthContext', () => ({ useAuth: () => ({ accessToken: 'fake-token', activeScope: null }) }));
vi.mock('../../../../services/http/apiClient', () => ({ apiRequest: (path: string, o: unknown) => api.handler(path, o) }));

import { ZoneDeepDivePage } from './ZoneDeepDivePage';

const ROUTES = {
  ...OVERVIEW_ROUTES,
  '/zones/analytics/heatmap': HEATMAP,
  '/zones/analytics/entry-points': ENTRY_POINTS,
  '/zones/analytics/time-spent': TIME_SPENT,
  '/zones/movement/matrix': MATRIX,
};
let mock: ReturnType<typeof makeApi>;
const setApi = (overrides: Record<string, unknown> = {}) => { mock = makeApi({ ...overrides, ...ROUTES, ...overrides }); api.handler = mock.handler; };

const renderPage = (entry = '/dashboard/zone_analytics.deep_dive') => render(
  <MemoryRouter initialEntries={[entry]}>
    <Routes><Route path="/dashboard/zone_analytics.deep_dive" element={<ZoneDeepDivePage />} /></Routes>
  </MemoryRouter>
);
const lastQuery = (prefix: string) => new URLSearchParams(mock.widgetCalls.filter((c) => c.path.startsWith(prefix)).slice(-1)[0].path.split('?')[1]);
const ready = async () => { await waitFor(() => expect(screen.getByTestId('hero-headcount-value')).toHaveTextContent('8')); await waitFor(() => expect(screen.getAllByTestId('event-row').length).toBeGreaterThan(0)); };
const ANALYTICS = ['/zones/analytics/summary', '/zones/analytics/peak-hours', '/zones/analytics/heatmap', '/zones/analytics/entry-points', '/zones/analytics/time-spent', '/zones/movement/matrix', '/zones/events/recent'];

describe('ZoneDeepDivePage — layout (AC 7.1, 7.2)', () => {
  beforeEach(() => setApi());

  it('renders the filter bar, 3 hero cards, six charts, Top Entrances and the full events table', async () => {
    renderPage();
    await ready();
    expect(screen.getByText('Zone Analytics - Zone Deep-Dive')).toBeInTheDocument();
    // filter bar
    expect(screen.getByTestId('zone-trigger-label')).toHaveTextContent('All Zones');
    for (const label of ['Entrance', 'Department', 'Time Interval', 'Today', 'This Week', 'This Month', 'Custom', 'More Filters']) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.getByText('Active Scope:')).toBeInTheDocument();
    // hero cards (same 3 as the Overview)
    for (const id of ['hero-headcount', 'hero-flow', 'hero-dwell']) expect(screen.getByTestId(id)).toBeInTheDocument();
    // six charts + the two tables
    for (const id of ['chart-hourly-zone-traffic', 'chart-zone-occupancy-heatmap', 'chart-entrypoint-traffic', 'chart-entries-vs-exits', 'chart-time-spent-histogram', 'chart-employee-movement-matrix', 'table-top-entry-points', 'table-recent-zone-events']) {
      expect(document.getElementById(id), id).not.toBeNull();
    }
    // Top Entrances columns and computed rows
    for (const h of ['Rank', 'Entrance', 'Total Entries', 'Total Exits', 'Net Flow', 'Unique Employees', 'Traffic Share', 'Peak Activity Time']) expect(screen.getAllByText(h).length).toBeGreaterThan(0);
    const rows = screen.getAllByTestId('entrance-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Front Camera')).toBeInTheDocument();
    expect(within(rows[0]).getByText('+40')).toBeInTheDocument();
    expect(within(rows[1]).getByText('-20')).toBeInTheDocument();
    // computed chart facts
    expect(screen.getByTestId('chip-peak')).toHaveTextContent('Peak: 09:00 (43)');
    expect(screen.getByTestId('chip-low')).toHaveTextContent('Low: 18:00 (2)');
    expect(screen.getByTestId('modal-range')).toHaveTextContent('Under 1 hour (60%)');
    expect(screen.getByTestId('top-flow')).toHaveTextContent('Lobby → ODC');
    expect(screen.getAllByTestId('heatmap-cell').length).toBeGreaterThan(20);
    // no capacity / floor / spatial elements, no mock numbers
    const text = document.body.textContent || '';
    for (const banned of ['Capacity', 'Cap)', 'Floor', 'floor plan', '625', '3,336', 'Portal', 'Turnstile', 'Shift', 'Overtime']) expect(text.includes(banned), banned).toBe(false);
  });

  it('the heatmap "Peak Usage" is a share of the observed peak, never a capacity (AC 7.2)', async () => {
    renderPage();
    await ready();
    const cells = screen.getAllByTestId('heatmap-cell');
    const peakCell = cells.find((c) => c.getAttribute('data-count') === '40')!;
    fireEvent.mouseEnter(peakCell, { clientX: 10, clientY: 10 });
    expect(await screen.findAllByText(/Peak Usage/)).not.toHaveLength(0);
    expect(screen.getAllByText('100%').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/capacity|utilization/i);
  });
});

describe('ZoneDeepDivePage — every filter control changes the requests (AC 7.1, 7.3, 3.9)', () => {
  beforeEach(() => setApi());

  it('initial request: today, no zone, no confidence floor (off by default), no security filter', async () => {
    renderPage();
    await ready();
    const today = presetRange('today');
    for (const p of ANALYTICS) {
      const q = lastQuery(p);
      expect(q.get('fromDate'), p).toBe(today.fromDate);
      expect(q.get('toDate'), p).toBe(today.toDate);
      expect(q.has('zone'), p).toBe(false);
      expect(q.has('minConfidence'), p).toBe(false);
      expect(q.has('securityOnly'), p).toBe(false);
      expect(q.get('tz'), p).toBeTruthy();
    }
  });

  it('zone multi-select: pick zones, "Only" isolates one, every endpoint receives the zone', async () => {
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /Zones/ , expanded: false }));
    const listbox = await screen.findByRole('listbox', { name: 'Zones' });
    // per-zone live headcount and peak from the API
    expect(within(listbox).getByTestId('zone-live-0')).toHaveTextContent('6 inside');
    expect(within(listbox).getAllByText(/Peak: 12/).length).toBe(1);
    // search
    fireEvent.change(within(listbox).getByLabelText('Search zones'), { target: { value: 'odc' } });
    expect(within(listbox).getAllByRole('option').filter((o) => o.getAttribute('data-zone'))).toHaveLength(1);
    fireEvent.change(within(listbox).getByLabelText('Search zones'), { target: { value: '' } });
    // unchecking one zone from "all" selects the rest
    fireEvent.click(within(listbox).getAllByRole('option').find((o) => o.getAttribute('data-zone') === 'Innovate Area')!);
    await waitFor(() => expect(lastQuery('/zones/analytics/summary').getAll('zone')).toEqual(['Lobby', 'ODC']));
    for (const p of ANALYTICS) await waitFor(() => expect(lastQuery(p).getAll('zone'), p).toEqual(['Lobby', 'ODC']));
    expect(screen.getAllByTestId('scope-zone-chip')).toHaveLength(2);
    // Only
    const lobby = within(listbox).getAllByRole('option').find((o) => o.getAttribute('data-zone') === 'Lobby')!;
    fireEvent.click(within(lobby).getByRole('button', { name: 'Only' }));
    await waitFor(() => expect(lastQuery('/zones/analytics/summary').getAll('zone')).toEqual(['Lobby']));
    expect(screen.getByTestId('zone-trigger-label')).toHaveTextContent('Lobby');
    // chip removal returns to all zones
    fireEvent.click(screen.getByRole('button', { name: 'Remove Lobby' }));
    await waitFor(() => expect(lastQuery('/zones/analytics/summary').has('zone')).toBe(false));
  });

  it('entrance, department and time interval selects change the requests', async () => {
    renderPage();
    await ready();
    fireEvent.change(screen.getByLabelText('Entrance'), { target: { value: 'CAM-1' } });
    await waitFor(() => expect(lastQuery('/zones/analytics/heatmap').get('entryPointId')).toBe('CAM-1'));
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: '1' } });
    await waitFor(() => expect(lastQuery('/zones/analytics/heatmap').get('departmentId')).toBe('1'));
    fireEvent.change(screen.getByLabelText('Time Interval'), { target: { value: 'morning' } });
    await waitFor(() => expect(lastQuery('/zones/analytics/heatmap').get('timeRange')).toBe('morning'));
    for (const p of ANALYTICS) {
      await waitFor(() => {
        const q = lastQuery(p);
        expect([q.get('entryPointId'), q.get('departmentId'), q.get('timeRange')], p).toEqual(['CAM-1', '1', 'morning']);
      });
    }
    // the time-interval options are the real named windows (no hardcoded hours, no shift wording)
    const opts = within(screen.getByLabelText('Time Interval')).getAllByRole('option').map((o) => o.textContent);
    expect(opts).toEqual(['Full Day', 'Morning', 'Afternoon', 'Evening', 'Busiest Hours']);
  });

  it('date presets: This Week / This Month / Today set the range; Custom exposes two working date inputs', async () => {
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'This Week' }));
    await waitFor(() => expect(lastQuery('/zones/analytics/summary').get('fromDate')).toBe(presetRange('week').fromDate));
    fireEvent.click(screen.getByRole('button', { name: 'This Month' }));
    await waitFor(() => expect(lastQuery('/zones/analytics/summary').get('fromDate')).toBe(presetRange('month').fromDate));
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-08-15' } });
    await waitFor(() => { const q = lastQuery('/zones/analytics/summary'); expect([q.get('fromDate'), q.get('toDate')]).toEqual(['2026-08-01', '2026-08-15']); });
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(lastQuery('/zones/analytics/summary').get('fromDate')).toBe(presetRange('today').fromDate));
  });

  it('More Filters: camera / minimum match confidence / security-only are drafts committed only by Apply, and Reset clears the draft', async () => {
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /More Filters/ }));
    const panel = screen.getByRole('dialog', { name: 'More Filters' });
    expect(within(panel).getByText('Specific Camera')).toBeInTheDocument();
    expect(within(panel).getByText('Minimum Match Confidence')).toBeInTheDocument();
    expect(within(panel).getByText('Only unknown-face and camera-offline events')).toBeInTheDocument();
    expect(within(panel).getByTestId('min-confidence-value')).toHaveTextContent('Off');
    const slider = within(panel).getByLabelText('Minimum Match Confidence') as HTMLInputElement;
    expect(slider.min).toBe('50');
    expect(slider.max).toBe('98');
    fireEvent.change(within(panel).getByLabelText('Specific Camera'), { target: { value: 'CAM-1' } });
    fireEvent.change(slider, { target: { value: '80' } });
    fireEvent.click(within(panel).getByLabelText('Only unknown-face and camera-offline events'));
    expect(within(panel).getByTestId('min-confidence-value')).toHaveTextContent('80%');
    // not applied yet
    expect(lastQuery('/zones/analytics/summary').has('cameraId')).toBe(false);
    expect(lastQuery('/zones/events/recent').has('securityOnly')).toBe(false);
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    for (const p of ANALYTICS) {
      await waitFor(() => { const q = lastQuery(p); expect([q.get('cameraId'), q.get('minConfidence'), q.get('securityOnly')], p).toEqual(['CAM-1', '0.8', 'true']); });
    }
    expect(screen.queryByRole('dialog', { name: 'More Filters' })).toBeNull();
    expect(screen.getByText(/Match confidence ≥ 80%/)).toBeInTheDocument();
    expect(screen.getByText('Camera: Front Camera')).toBeInTheDocument();
    expect(screen.getByText('Unknown faces and camera outages only')).toBeInTheDocument();
    // Reset inside the panel resets the draft, Apply commits the defaults
    fireEvent.click(screen.getByRole('button', { name: /More Filters/ }));
    const panel2 = screen.getByRole('dialog', { name: 'More Filters' });
    fireEvent.click(within(panel2).getByRole('button', { name: 'Reset' }));
    fireEvent.click(within(panel2).getByRole('button', { name: 'Apply' }));
    await waitFor(() => { const q = lastQuery('/zones/analytics/summary'); expect([q.has('cameraId'), q.has('minConfidence'), q.has('securityOnly')]).toEqual([false, false, false]); });
  });

  it('Reset Filters / "Undo / Reset all" restore the defaults and chips can be removed one by one', async () => {
    renderPage();
    await ready();
    fireEvent.change(screen.getByLabelText('Entrance'), { target: { value: 'CAM-1' } });
    fireEvent.change(screen.getByLabelText('Time Interval'), { target: { value: 'evening' } });
    fireEvent.click(screen.getByRole('button', { name: 'This Month' }));
    await waitFor(() => expect(screen.getByText('Entrance: Front Camera')).toBeInTheDocument());
    expect(screen.getByText('Period: This Month')).toBeInTheDocument();
    expect(screen.getByText('Time: Evening')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove entrance filter' }));
    await waitFor(() => expect(lastQuery('/zones/analytics/summary').has('entryPointId')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /Undo \/ Reset all/ }));
    await waitFor(() => {
      const q = lastQuery('/zones/analytics/summary');
      expect([q.has('timeRange'), q.get('fromDate')]).toEqual([false, presetRange('today').fromDate]);
    });
    expect(screen.queryByText('Undo / Reset all')).toBeNull();
  });

  it('AC 7.3 — the whole view refetches when a filter changes (summary, charts and events all reload)', async () => {
    renderPage();
    await ready();
    const before = mock.calls.length;
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: '1' } });
    await waitFor(() => expect(mock.calls.length).toBeGreaterThanOrEqual(before + 2));
  });
});

describe('ZoneDeepDivePage — Recent Zone Events table (AC 5.3, 7.2)', () => {
  beforeEach(() => setApi({ '/zones/events/recent': (p: string) => EVENTS(EVENT_ROWS, 25) }));

  it('event type, status, search and page are sent to the API; the filters reset the page to 1', async () => {
    renderPage();
    await ready();
    expect(screen.getByTestId('events-total')).toHaveTextContent('25 Records');
    expect(screen.getByText(/Page/).textContent).toContain('1');
    expect(lastQuery('/zones/events/recent').get('pageSize')).toBe('10');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(lastQuery('/zones/events/recent').get('page')).toBe('2'));
    fireEvent.change(screen.getByLabelText('Event type'), { target: { value: 'unknown_face' } });
    await waitFor(() => { const q = lastQuery('/zones/events/recent'); expect([q.get('eventType'), q.get('page')]).toEqual(['unknown_face', '1']); });
    fireEvent.change(screen.getByLabelText('Recognition status'), { target: { value: 'unrecognized' } });
    await waitFor(() => expect(lastQuery('/zones/events/recent').get('status')).toBe('unrecognized'));
    fireEvent.change(screen.getByLabelText('Search events'), { target: { value: 'jane' } });
    await waitFor(() => expect(lastQuery('/zones/events/recent').get('q')).toBe('jane'));
    // event-table controls do not reload the analytics endpoints
    const analyticsBefore = mock.widgetCalls.filter((c) => c.path.startsWith('/zones/analytics/summary')).length;
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(lastQuery('/zones/events/recent').get('page')).toBe('2'));
    expect(mock.widgetCalls.filter((c) => c.path.startsWith('/zones/analytics/summary')).length).toBe(analyticsBefore);
    // clear
    fireEvent.click(screen.getByText('Clear Event Filters'));
    await waitFor(() => { const q = lastQuery('/zones/events/recent'); expect([q.has('eventType'), q.has('status'), q.has('q'), q.get('page')]).toEqual([false, false, false, '1']); });
  });

  it('the four event types are the only options; no failure / unauthorized / after-hours types', async () => {
    renderPage();
    await ready();
    const opts = within(screen.getByLabelText('Event type')).getAllByRole('option').map((o) => o.textContent);
    expect(opts).toEqual(['All Event Types', 'Entry', 'Exit', 'Unknown Face', 'Camera Offline']);
    const statuses = within(screen.getByLabelText('Recognition status')).getAllByRole('option').map((o) => o.textContent);
    expect(statuses).toEqual(['All Statuses', 'Verified', 'Unrecognized', 'System']);
  });

  it('AC 6.8 — arriving with #zone-events scrolls to the events table', async () => {
    const scroll = vi.fn();
    (HTMLElement.prototype as any).scrollIntoView = scroll;
    renderPage('/dashboard/zone_analytics.deep_dive#zone-events');
    await ready();
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(document.getElementById('zone-events')!.contains(document.getElementById('table-recent-zone-events'))).toBe(true);
  });
});

describe('ZoneDeepDivePage — empty and failing widgets (AC 7.4), header controls (AC 6.6, 6.7)', () => {
  it('a scope with no data shows an empty state per widget, not zeros presented as facts', async () => {
    setApi({
      '/zones/analytics/summary': { ...SUMMARY, hasData: false, headcount: { current: null, peak: null, average: null, lowest: null, pctOfPeak: null, changeVs1hPct: null }, flow: { entries: null, exits: null, net: null, pctIn: null, pctOut: null, uniqueEmployees: null }, dwell: { avgVisitMinutes: null, avgTimeInsideMinutes: null, peakInflowWindow: null, peakEgressWindow: null, totalVisits: null } },
      '/zones/analytics/peak-hours': { highestWindow: null, lowestWindow: null, peakHeadcountMoment: null, hourly: [], byZone: [] },
      '/zones/analytics/heatmap': { maxCell: 0, cells: [] },
      '/zones/analytics/entry-points': [],
      '/zones/analytics/time-spent': TIME_SPENT.map((b) => ({ ...b, count: 0, pct: 0 })),
      '/zones/movement/matrix': { matrix: [], mostVisited: [] },
      '/zones/events/recent': EVENTS([], 0),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hero-headcount-value')).toHaveTextContent('—'));
    await waitFor(() => expect(screen.getAllByTestId('widget-empty').length).toBeGreaterThanOrEqual(6));
    expect(screen.getByTestId('chip-peak')).toHaveTextContent('Peak: —');
    expect(screen.getByTestId('modal-range')).toHaveTextContent('—');
    expect(screen.getByTestId('events-total')).toHaveTextContent('0 Records');
    expect(screen.queryAllByTestId('heatmap-cell')).toHaveLength(0);
  });

  it('one failing endpoint shows an inline error while the other widgets still render', async () => {
    setApi({ '/zones/analytics/heatmap': new Error('heatmap unavailable') });
    renderPage();
    expect(await screen.findByText('heatmap unavailable')).toBeInTheDocument();
    await ready();
    expect(screen.getByTestId('chip-peak')).toHaveTextContent('Peak: 09:00 (43)');
  });

  it('Refresh refetches every endpoint and Export downloads a CSV of what is shown', async () => {
    setApi();
    const blobs: Blob[] = [];
    (URL as any).createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return 'blob:x'; });
    (URL as any).revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderPage();
    await ready();
    const before = mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mock.calls.length).toBeGreaterThanOrEqual(before + 2));
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    const text: string = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(blobs[0]); });
    for (const part of ['Summary', 'Hourly traffic', 'Top entrances', 'Time spent inside zone', 'Movement between zones', 'Recent zone events', 'Front Camera', 'Lobby']) expect(text).toContain(part);
    click.mockRestore();
  });
});

describe('ZoneDeepDivePage — responsiveness (AC 10.2-10.4)', () => {
  beforeEach(() => setApi());
  it('tables scroll horizontally, chart grids collapse below lg, the filter bar stacks', async () => {
    renderPage();
    await ready();
    for (const id of ['table-top-entry-points', 'table-recent-zone-events', 'chart-employee-movement-matrix']) {
      expect(document.getElementById(id)!.querySelector('.overflow-x-auto'), id).not.toBeNull();
    }
    const grids = [...document.querySelectorAll('div')].filter((d) => d.className.includes('lg:grid-cols-2'));
    expect(grids.length).toBe(3);
    grids.forEach((g) => expect(g.className).toContain('grid-cols-1'));
    expect(document.getElementById('global-filters-panel')!.firstElementChild!.className).toContain('flex-col');
  });
});
