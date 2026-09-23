import React from 'react';
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react';
import { configure } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeApi, ZONES, COMPARE } from './testing/fixtures';
import { presetRange } from './lib/format';
import type { CompareData } from './lib/types';

// specs/0003-zone-analytics — Task 21: Compare Zones (AC 8.1-8.5, 10.2-10.3).
// Component-level tier: no Playwright/Cypress harness exists in frs-web-ui, so this is
// NOT a browser E2E test; the network is mocked at apiRequest and every request path is asserted.

configure({ asyncUtilTimeout: 3000 }); // param changes are debounced 400 ms (AC 12.6)
const api = vi.hoisted(() => ({ handler: null as any }));
vi.mock('../../../../contexts/AuthContext', () => ({ useAuth: () => ({ accessToken: 'fake-token', activeScope: null }) }));
vi.mock('../../../../services/http/apiClient', () => ({ apiRequest: (path: string, o: unknown) => api.handler(path, o) }));

import { CompareZonesPage } from './CompareZonesPage';

/** Build a compare response for whatever zones the request names. */
const compareFor = (path: string): CompareData => {
  const q = new URLSearchParams(path.split('?')[1]);
  const names = q.getAll('zone');
  const base = COMPARE((q.get('metric') as any) ?? 'occupancy', (q.get('granularity') as any) ?? 'hour');
  const template = base.zones.Lobby;
  const zones = Object.fromEntries(names.map((n, i) => [n, { profile: { ...template.profile, entries: 10 * (i + 1), exits: 5 * (i + 1), liveHeadcount: i + 1, peak: 4 + i }, series: template.series }]));
  const matrix = names.map((n, i) => ({ zone: n, liveHeadcount: i + 1, peak: 4 + i, entries: 10 * (i + 1), exits: 5 * (i + 1), net: 5 * (i + 1), avgDwellMinutes: 60 }));
  const sum = (k: 'entries' | 'exits' | 'net') => matrix.reduce((s, r) => s + r[k], 0);
  return { ...base, zones, matrix, aggregate: { liveHeadcount: matrix.reduce((s, r) => s + r.liveHeadcount, 0), peak: Math.max(...matrix.map((r) => r.peak)), entries: sum('entries'), exits: sum('exits'), net: sum('net'), avgDwellMinutes: 60 } };
};

let mock: ReturnType<typeof makeApi>;
const setApi = (overrides: Record<string, unknown> = {}) => {
  mock = makeApi({
    '/zones/compare': compareFor,
    '/zones': ZONES, // Lobby 40 entries, Innovate Area 25, ODC 10
    ...overrides,
  });
  api.handler = mock.handler;
};
const compareCalls = () => mock.widgetCalls.filter((c) => c.path.startsWith('/zones/compare'));
const lastCompare = () => new URLSearchParams(compareCalls().slice(-1)[0].path.split('?')[1]);
const toggle = (zone: string) => fireEvent.click(document.querySelector(`[data-zone="${zone}"][id^="compare-zone-toggle"]`)!);

describe('CompareZonesPage', () => {
  beforeEach(() => setApi());

  it('AC 8.1 — title, selected-zone count, zone selector with Select All / Default (2) and data-driven presets', async () => {
    render(<CompareZonesPage />);
    expect(screen.getByText('Compare Zones – Side-by-Side')).toBeInTheDocument();
    // default 2 = the two busiest zones by entries (data-driven, no hardcoded ids)
    await waitFor(() => expect(screen.getByTestId('selected-count')).toHaveTextContent('2 Zones Selected'));
    expect(document.querySelector('[data-zone="Lobby"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-zone="Innovate Area"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-zone="ODC"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('Select All')).toBeInTheDocument();
    expect(screen.getByText('Default (2)')).toBeInTheDocument();
    // presets
    fireEvent.click(screen.getByRole('button', { name: /^All \(3\)/ }));
    expect(screen.getByTestId('selected-count')).toHaveTextContent('3 Zones Selected');
    fireEvent.click(screen.getByRole('button', { name: 'Busiest zones' }));
    expect(screen.getByTestId('selected-count')).toHaveTextContent('3 Zones Selected'); // only 3 zones exist -> top 3 by entries
    toggle('ODC');
    expect(screen.getByTestId('selected-count')).toHaveTextContent('2 Zones Selected');
    fireEvent.click(screen.getByText('Default (2)'));
    await waitFor(() => expect(lastCompare().getAll('zone')).toEqual(['Lobby', 'Innovate Area']));
    // the presets rank by the API's per-zone entries (range-scoped), which is what /zones returned
    expect(mock.widgetCalls.find((c) => c.path.startsWith('/zones?'))!.path).toContain('fromDate=');
  });

  it('AC 8.5 — fewer than 2 zones: prompt, no comparison rendered and no compare request made', async () => {
    render(<CompareZonesPage />);
    await waitFor(() => expect(screen.getByTestId('selected-count')).toHaveTextContent('2 Zones Selected'));
    await waitFor(() => expect(screen.getAllByTestId('zone-profile')).toHaveLength(2));
    const before = compareCalls().length;
    toggle('Innovate Area');
    expect(screen.getByTestId('selected-count')).toHaveTextContent('1 Zones Selected');
    expect(screen.getByTestId('compare-zones-empty-state')).toHaveTextContent('Select at least 2 zones to compare.');
    expect(screen.queryAllByTestId('zone-profile')).toHaveLength(0);
    expect(screen.queryByTestId('metrics-matrix')).toBeNull();
    expect(compareCalls().length).toBe(before);
    toggle('Innovate Area');
    toggle('ODC');
    await waitFor(() => expect(screen.getAllByTestId('zone-profile')).toHaveLength(3));
  });

  it('AC 8.2 — one profile card per selected zone: name, primary department, headcount, peak, % of peak, entries, exits, average stay, entrances; no floor/code/capacity', async () => {
    render(<CompareZonesPage />);
    await waitFor(() => expect(screen.getAllByTestId('zone-profile')).toHaveLength(2));
    const card = screen.getAllByTestId('zone-profile').find((c) => c.getAttribute('data-zone') === 'Lobby')!;
    expect(within(card).getByText('Lobby')).toBeInTheDocument();
    expect(within(card).getByText('Sales')).toBeInTheDocument();
    for (const t of ['Headcount', 'Entries', 'Exits', 'Avg Stay', 'Entrances: 3']) expect(within(card).getByText(t)).toBeInTheDocument();
    expect(within(card).getByText(/Peak:/)).toBeInTheDocument();
    expect(within(card).getByText('50% of Peak')).toBeInTheDocument();
    const text = document.body.textContent || '';
    for (const banned of ['Floor', 'Capacity', 'Cap)', 'floor plan', 'Gates:', 'Terminals']) expect(text.includes(banned), banned).toBe(false);
  });

  it('AC 8.3 — metric tabs and granularity tabs each change the request and re-render', async () => {
    render(<CompareZonesPage />);
    await waitFor(() => expect(screen.getAllByTestId('zone-profile')).toHaveLength(2));
    expect(lastCompare().get('metric')).toBe('occupancy');
    expect(lastCompare().get('granularity')).toBe('hour');
    fireEvent.click(screen.getByRole('button', { name: /Traffic Influx\/Egress/ }));
    await waitFor(() => expect(lastCompare().get('metric')).toBe('traffic'));
    fireEvent.click(screen.getByRole('button', { name: /Average Dwell Time/ }));
    await waitFor(() => expect(lastCompare().get('metric')).toBe('dwell'));
    fireEvent.click(screen.getByRole('button', { name: 'Day of Week' }));
    await waitFor(() => expect(lastCompare().get('granularity')).toBe('dow'));
    fireEvent.click(screen.getByRole('button', { name: 'Multi-Week' }));
    await waitFor(() => expect(lastCompare().get('granularity')).toBe('week'));
    fireEvent.click(screen.getByRole('button', { name: '24-Hour' }));
    await waitFor(() => expect(lastCompare().get('granularity')).toBe('hour'));
    expect(screen.getByRole('button', { name: /Concurrent Occupancy/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Average Dwell Time/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('AC 8.4 — Key Performance Metrics Matrix rows plus an aggregate row for the selection', async () => {
    render(<CompareZonesPage />);
    const matrix = await screen.findByTestId('metrics-matrix');
    await waitFor(() => expect(within(matrix).getAllByTestId('matrix-row')).toHaveLength(2));
    for (const h of ['Zone', 'Live Headcount', 'Peak', 'Total Entries', 'Total Exits', 'Net Flow', 'Average Dwell']) expect(within(matrix).getByText(h)).toBeInTheDocument();
    const rows = within(matrix).getAllByTestId('matrix-row');
    expect(rows[0]).toHaveTextContent('Lobby');
    expect(rows[0]).toHaveTextContent('+10');
    const agg = within(matrix).getByTestId('matrix-aggregate');
    expect(agg).toHaveTextContent('Selected Zones Combined (2)');
    expect(agg).toHaveTextContent('+30'); // 10 + 20 entries
    expect(agg).toHaveTextContent('-15'); // 5 + 10 exits
    expect(agg).toHaveTextContent('+15'); // net
    expect(screen.getByTestId('aggregate-live')).toHaveTextContent('3');
  });

  it('date range: Compare has its own presets (default This Month) that reach the zone list and the comparison', async () => {
    render(<CompareZonesPage />);
    await waitFor(() => expect(screen.getAllByTestId('zone-profile')).toHaveLength(2));
    const month = presetRange('month');
    expect(lastCompare().get('fromDate')).toBe(month.fromDate);
    expect(lastCompare().get('toDate')).toBe(month.toDate);
    fireEvent.click(screen.getByRole('button', { name: 'This Week' }));
    await waitFor(() => expect(lastCompare().get('fromDate')).toBe(presetRange('week').fromDate));
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-08-31' } });
    await waitFor(() => { const q = lastCompare(); expect([q.get('fromDate'), q.get('toDate')]).toEqual(['2026-08-01', '2026-08-31']); });
    const zoneLists = mock.widgetCalls.filter((c) => c.path.startsWith('/zones?'));
    expect(zoneLists.slice(-1)[0].path).toContain('fromDate=2026-08-01');
  });

  it('header: Refresh refetches the list and the comparison; Export downloads a CSV of the matrix', async () => {
    const blobs: Blob[] = [];
    (URL as any).createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return 'blob:x'; });
    (URL as any).revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<CompareZonesPage />);
    await waitFor(() => expect(screen.getAllByTestId('zone-profile')).toHaveLength(2));
    expect(screen.getByText('HR Manager')).toBeInTheDocument();
    const before = mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mock.calls.length).toBeGreaterThanOrEqual(before + 1));
    expect(mock.calls[mock.calls.length - 1].path).toContain('refresh=1'); // Refresh bypasses the server cache (AC 12.5)
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    const text: string = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(blobs[0]); });
    expect(text).toContain('Key metrics');
    expect(text).toContain('Lobby');
    expect(text).toContain('Series');
    click.mockRestore();
  });

  it('a failing comparison shows an inline error; an empty range shows an empty state', async () => {
    setApi({ '/zones/compare': new Error('comparison unavailable') });
    render(<CompareZonesPage />);
    expect((await screen.findAllByText('comparison unavailable')).length).toBeGreaterThan(0);
    cleanup();
    setApi({ '/zones/compare': (p: string) => ({ ...compareFor(p), zones: Object.fromEntries(Object.entries(compareFor(p).zones).map(([k, v]) => [k, { ...v, series: [] }])) }) });
    render(<CompareZonesPage />);
    expect((await screen.findAllByText('No activity recorded for these zones in this period.')).length).toBeGreaterThan(0);
  });

  it('AC 10.2/10.3 — the matrix scrolls horizontally, the zone grid collapses to one column', async () => {
    render(<CompareZonesPage />);
    const matrix = await screen.findByTestId('metrics-matrix');
    expect(matrix.parentElement!.className).toContain('overflow-x-auto');
    await waitFor(() => {
      const grids = [...document.querySelectorAll('div')].filter((d) => /\bgrid\b/.test(d.className) && d.className.includes('grid-cols-1'));
      expect(grids.length).toBeGreaterThanOrEqual(2);
    });
  });
});
