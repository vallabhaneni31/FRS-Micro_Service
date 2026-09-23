import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { configure } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeApi, OVERVIEW_ROUTES, EMPTY_SUMMARY, SUMMARY, EVENT_ROWS, EVENTS } from './testing/fixtures';

// specs/0003-zone-analytics — Task 19: Overview Dashboard (AC 6.1-6.8, 10.*, 11.*).
//
// Component-level tier only: there is no Playwright/Cypress harness anywhere in
// frs-web-ui, so this is NOT a browser E2E test. Network is mocked at apiRequest
// and every request path is asserted; the real component tree renders.

configure({ asyncUtilTimeout: 3000 }); // param changes are debounced 400 ms (AC 12.6)
const api = vi.hoisted(() => ({ handler: null as any }));
vi.mock('../../../../contexts/AuthContext', () => ({ useAuth: () => ({ accessToken: 'fake-token', activeScope: null }) }));
vi.mock('../../../../services/http/apiClient', () => ({ apiRequest: (path: string, o: unknown) => api.handler(path, o) }));

import { ZoneAnalyticsOverviewPage } from './ZoneAnalyticsOverviewPage';

const Where: React.FC = () => { const l = useLocation(); return <div data-testid="where">{l.pathname + l.hash}</div>; };
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/zone_analytics.overview']}>
      <Routes>
        <Route path="/dashboard/zone_analytics.overview" element={<ZoneAnalyticsOverviewPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );
}
let mock: ReturnType<typeof makeApi>;
const setApi = (overrides: Record<string, unknown> = {}) => { mock = makeApi({ ...overrides, ...OVERVIEW_ROUTES, ...overrides }); api.handler = mock.handler; };

describe('ZoneAnalyticsOverviewPage (facility-wide, no filters)', () => {
  beforeEach(() => setApi());

  it('AC 6.1 — banner, then exactly 3 hero cards with plain descriptions and computed values', async () => {
    renderPage();
    expect(screen.getByText('Facility-Wide Overview')).toBeInTheDocument();
    expect(screen.getByText('Open Zone Deep-Dive')).toBeInTheDocument();
    expect(screen.getByText('Core Vital Indicators')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('hero-headcount-value')).toHaveTextContent('8'));
    for (const id of ['hero-headcount', 'hero-flow', 'hero-dwell']) expect(screen.getByTestId(id)).toBeInTheDocument();
    expect(document.querySelectorAll('[data-testid^="hero-"][class*="glass-card"]').length).toBe(3);
    // titles + one-line descriptions (AC 11.2)
    expect(screen.getByText('Zone Headcount')).toBeInTheDocument();
    expect(screen.getByText('How many employees are inside the selected zones right now.')).toBeInTheDocument();
    expect(screen.getByText('Net Entry/Exit Flow')).toBeInTheDocument();
    expect(screen.getByText('Average Time Inside')).toBeInTheDocument();
    // computed values
    expect(screen.getByText('50% of Peak')).toBeInTheDocument();
    expect(screen.getByTestId('hero-entries')).toHaveTextContent('75');
    expect(screen.getByTestId('hero-exits')).toHaveTextContent('61');
    expect(screen.getByText('+14 Net')).toBeInTheDocument();
    expect(screen.getByTestId('hero-dwell-value')).toHaveTextContent('1h 2m');
    expect(screen.getByTestId('hero-peak-inflow')).toHaveTextContent('09:00 – 10:00');
    expect(screen.getByTestId('hero-peak-egress')).toHaveTextContent('18:00 – 19:00');
    expect(screen.getByTestId('hero-change')).toHaveTextContent('+14%');
  });

  it('AC 6.1 — no hardcoded prototype figures leak into the page (348 / 512 / 1,842 / 96.4% / 138 ms / 625 Cap ...)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hero-headcount-value')).toHaveTextContent('8'));
    const text = document.body.textContent || '';
    for (const banned of ['348', '512', '1,842', '2,390', '3,336', '96.4', '138 ms', '625', '38.5%', 'Capacity', 'Standard Shift', 'Scanalitix']) {
      expect(text.includes(banned), banned).toBe(false);
    }
  });

  it('AC 6.1 — empty data shows em dashes, not zeros presented as facts', async () => {
    setApi({ '/zones/analytics/summary': EMPTY_SUMMARY, '/zones/events/recent': EVENTS([], 0), '/zones/analytics/peak-hours': { highestWindow: null, lowestWindow: null, peakHeadcountMoment: null, hourly: [], byZone: [] } });
    renderPage();
    await waitFor(() => expect(mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.getByTestId('hero-headcount-value')).toHaveTextContent('—'));
    expect(screen.getByTestId('hero-entries')).toHaveTextContent('—');
    expect(screen.getByTestId('hero-dwell-value')).toHaveTextContent('—');
    expect(screen.getByTestId('hero-change')).toHaveTextContent('—');
    expect(screen.getByTestId('peak-highest')).toHaveTextContent('—');
    expect(screen.getAllByTestId('widget-empty').length).toBeGreaterThan(0);
  });

  it('AC 6.2 — no filter bar: no dropdowns, no Apply/Reset, always today', async () => {
    renderPage();
    await waitFor(() => expect(mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.queryByText('Apply')).toBeNull();
    expect(screen.queryByText('Reset')).toBeNull();
    expect(screen.queryByText('More Filters')).toBeNull();
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const summary = mock.widgetCalls.find((c) => c.path.startsWith('/zones/analytics/summary'))!.path;
    expect(summary).toContain(`fromDate=${iso}`);
    expect(summary).toContain(`toDate=${iso}`);
    expect(summary).not.toContain('zone=');
  });

  it('AC 6.3 — Hourly/Daily/Weekly toggle, one chip per zone that isolates it, computed stat tiles incl. Cameras Online', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('stat-active-count')).toHaveTextContent('8'));
    expect(screen.getByTestId('stat-highest-peak')).toHaveTextContent('12');
    expect(screen.getByTestId('stat-active-zones')).toHaveTextContent('2');
    expect(screen.getByTestId('stat-cameras-online')).toHaveTextContent('6 of 13');
    const hourly = screen.getByRole('button', { name: 'Hourly' });
    const daily = screen.getByRole('button', { name: 'Daily' });
    const weekly = screen.getByRole('button', { name: 'Weekly' });
    expect(hourly).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(weekly);
    expect(weekly).toHaveAttribute('aria-pressed', 'true');
    expect(hourly).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(daily);
    expect(daily).toHaveAttribute('aria-pressed', 'true');
    // requests for all three granularities were made with their own look-back
    const occ = mock.widgetCalls.filter((c) => c.path.startsWith('/zones/analytics/occupancy')).map((c) => c.path);
    expect(occ.some((p) => p.includes('granularity=hour'))).toBe(true);
    expect(occ.some((p) => p.includes('granularity=day'))).toBe(true);
    expect(occ.some((p) => p.includes('granularity=week'))).toBe(true);
    // chips
    const chip = screen.getByRole('button', { name: /Lobby/ });
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Reset highlight')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Reset highlight'));
    expect(chip).toHaveAttribute('aria-pressed', 'false');
  });

  it('AC 6.4 — department donut legend with employees/visits/avg time and a leading department computed from the data', async () => {
    renderPage();
    const legend = await screen.findByTestId('department-legend');
    expect(within(legend).getByText('Sales & Marketing')).toBeInTheDocument();
    expect(within(legend).getByText('8 employees • 30 zone visits')).toBeInTheDocument();
    expect(within(legend).getByText('~1h 8m avg')).toBeInTheDocument();
    expect(screen.getByTestId('leading-department')).toHaveTextContent('Sales & Marketing (40% of zone visits)');
  });

  it('AC 6.5 — three peak cards computed from the data and the busiest entry/exit windows', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('peak-highest')).toHaveTextContent('09:00 – 10:00'));
    expect(screen.getByTestId('peak-lowest')).toHaveTextContent('18:00 – 19:00');
    expect(screen.getByTestId('peak-moment')).not.toHaveTextContent('—');
    expect(screen.getByText('Highest Traffic Window')).toBeInTheDocument();
    expect(screen.getByText('Lowest Traffic Window')).toBeInTheDocument();
    expect(screen.getByText('Peak Headcount Moment')).toBeInTheDocument();
    expect(screen.getByText('09:00 (40 entries)')).toBeInTheDocument();
    expect(screen.getByText('13:00 (20 exits)')).toBeInTheDocument();
  });

  it('AC 6.1/5.2 — Recent Zone Activity shows 5 real rows, requested with pageSize=5 for today, statuses mapped', async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('event-row')).toHaveLength(EVENT_ROWS.length));
    expect(screen.getAllByTestId('event-row')).toHaveLength(5);
    const q = mock.widgetCalls.find((c) => c.path.startsWith('/zones/events/recent'))!.path;
    expect(q).toContain('pageSize=5');
    expect(q).toContain('page=1');
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getAllByText('Visitor (unregistered)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Verified').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Unrecognized').length).toBeGreaterThan(0);
    expect(screen.getAllByText('System').length).toBeGreaterThan(0);
    expect(screen.getByText('91%')).toBeInTheDocument();
    // wording (AC 11.1): new column names
    for (const h of ['Entrance', 'Employee', 'Match Confidence', 'Camera', 'Details']) expect(screen.getAllByText(h).length).toBeGreaterThan(0);
    for (const banned of ['Portal', 'Optical', 'Diagnostic', 'Subject', 'Telemetry']) expect(document.body.textContent).not.toContain(banned);
    // recorded-events lower-bound note (AC 5.5)
    expect(screen.getByText(/Shows recorded events only/)).toBeInTheDocument();
  });

  it('AC 6.8 — "View all" opens the Deep-Dive at its events table; "Open Zone Deep-Dive" opens the Deep-Dive', async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('event-row').length).toBe(5));
    fireEvent.click(screen.getByText('View all'));
    expect(screen.getByTestId('where')).toHaveTextContent('/dashboard/zone_analytics.deep_dive#zone-events');
  });

  it('AC 6.1 — "Open Zone Deep-Dive" button navigates to the Deep-Dive', async () => {
    renderPage();
    fireEvent.click(screen.getByText('Open Zone Deep-Dive'));
    expect(screen.getByTestId('where')).toHaveTextContent('/dashboard/zone_analytics.deep_dive');
    expect(screen.getByTestId('where')).not.toHaveTextContent('#');
  });

  it('AC 7.4 — one failing widget shows an inline error while the rest still render', async () => {
    setApi({ '/zones/analytics/departments': new Error('departments unavailable') });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hero-headcount-value')).toHaveTextContent('8'));
    expect(await screen.findByText('departments unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('peak-highest')).toHaveTextContent('09:00 – 10:00');
  });
});

describe('Overview header: Refresh, last updated and Export on the page header (AC 6.6, 6.7)', () => {
  beforeEach(() => { setApi(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 8, 21, 10, 0, 0)); });
  afterEach(() => vi.useRealTimers());

  it('AC 6.6 — Refresh re-fetches the whole view and updates the last-updated time', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hero-headcount-value')).toHaveTextContent('8'));
    const first = screen.getByTestId('last-updated').textContent;
    expect(first).toMatch(/^Updated /);
    const before = mock.calls.length;
    vi.setSystemTime(new Date(2026, 8, 21, 10, 5, 30));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mock.calls.length).toBe(before * 2));
    await waitFor(() => expect(screen.getByTestId('last-updated').textContent).not.toBe(first));
  });

  it('AC 6.7 — Export downloads a CSV containing the data currently shown', async () => {
    const blobs: Blob[] = [];
    (URL as any).createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return 'blob:x'; });
    (URL as any).revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hero-headcount-value')).toHaveTextContent('8'));
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    expect(click).toHaveBeenCalled();
    expect(blobs).toHaveLength(1);
    const text: string = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(blobs[0]); });
    expect(text).toContain('Summary (today)');
    expect(text).toContain('headcount_now');
    expect(text).toContain('Sales & Marketing');
    expect(text).toContain('Lobby');
    expect(text).toContain('Recent zone activity');
    expect(text).toContain('Jane Doe');
    click.mockRestore();
  });
});

describe('AC 11.3 / 10.3 — layout tokens', () => {
  beforeEach(() => setApi());
  it('cards use the glass-card material and grids collapse to one column below lg', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hero-headcount-value')).toHaveTextContent('8'));
    expect(document.querySelector('#hero-kpi-occupancy')!.className).toContain('glass-card');
    const grids = [...document.querySelectorAll('div')].filter((d) => d.className.includes('lg:grid-cols-2'));
    expect(grids.length).toBeGreaterThan(0);
    for (const g of grids) expect(g.className).toContain('grid-cols-1');
    expect(document.querySelector('.md\\:grid-cols-3')!.className).toContain('grid-cols-1');
  });
});
