import React from 'react';
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react';
import { configure } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeApi, ZONES, EMPLOYEES, MOVEMENT } from './testing/fixtures';
import { presetRange } from './lib/format';

// specs/0003-zone-analytics — Task 22: Employee Movement (AC 9.1-9.9, 10.2, 11.*).
// Component-level tier: there is no Playwright/Cypress harness in frs-web-ui, so this is NOT a
// browser E2E test; the network is mocked at apiRequest and photos at useAuthedPhotoUrl.

configure({ asyncUtilTimeout: 3000 }); // param changes are debounced 400 ms (AC 12.6)
const api = vi.hoisted(() => ({ handler: null as any, photoPaths: [] as (string | null | undefined)[] }));
vi.mock('../../../../contexts/AuthContext', () => ({ useAuth: () => ({ accessToken: 'fake-token', activeScope: null }) }));
vi.mock('../../../../services/http/apiClient', () => ({ apiRequest: (path: string, o: unknown) => api.handler(path, o) }));
vi.mock('../../../../services/http/authedPhoto', () => ({
  useAuthedPhotoUrl: (p: string | null | undefined) => { api.photoPaths.push(p); return { url: p ? `blob:${p}` : null, loading: false, error: false }; },
}));

import { EmployeeMovementPage } from './EmployeeMovementPage';

let mock: ReturnType<typeof makeApi>;
const setApi = (overrides: Record<string, unknown> = {}) => {
  mock = makeApi({ '/zones/movement/': MOVEMENT, '/zones/employees': EMPLOYEES, '/zones/departments': [{ departmentId: 1, name: 'Sales' }, { departmentId: 2, name: 'COE' }], '/zones': ZONES, ...overrides });
  api.handler = mock.handler;
  api.photoPaths.length = 0;
};
const empCalls = () => mock.widgetCalls.filter((c) => c.path.startsWith('/zones/employees'));
const q = (path: string) => new URLSearchParams(path.split('?')[1]);
const lastList = () => q(empCalls().filter((c) => q(c.path).get('pageSize') === '12').slice(-1)[0].path);
const lastTop = () => q(empCalls().filter((c) => q(c.path).get('pageSize') === '10').slice(-1)[0].path);
const ready = async () => { await waitFor(() => expect(screen.getAllByTestId('employee-card')).toHaveLength(2)); await waitFor(() => expect(screen.getAllByTestId('top-employee-row')).toHaveLength(2)); };
const card = (id: number) => document.getElementById(`employee-zone-card-${id}`)!;

describe('EmployeeMovementPage — layout and summary (AC 9.1)', () => {
  beforeEach(() => setApi());

  it('renders the section title, the four summary cards from real data, the view toggle and all controls', async () => {
    render(<EmployeeMovementPage />);
    expect(screen.getByText('Employee-Wise Zone Analytics & Movement')).toBeInTheDocument();
    await ready();
    expect(screen.getByTestId('summary-tracked')).toHaveTextContent('2');
    expect(screen.getByTestId('summary-mean-time')).toHaveTextContent('4h 35m');
    expect(screen.getByTestId('summary-most-active')).toHaveTextContent('Asha Rao');
    expect(screen.getByText('4 zone visits')).toBeInTheDocument();
    expect(screen.getByTestId('summary-mean-confidence')).toHaveTextContent('81%');
    for (const t of ['Tracked Employees', 'Mean Time in Zone', 'Most Active Employee', 'Mean Match Confidence']) expect(screen.getByText(t)).toBeInTheDocument();
    // one-line plain descriptions on every summary card (AC 11.2)
    expect(screen.getByText('On average, how sure the system was that it matched the right person.')).toBeInTheDocument();
    // view toggle wording
    for (const t of ['Employee Profiles', 'Zone Time Matrix', 'Compare (0)']) expect(screen.getByRole('button', { name: new RegExp(t.replace(/[()]/g, '\\$&')) })).toBeInTheDocument();
    // controls
    for (const l of ['Search employees', 'Department', 'Status', 'Sort by', 'Toggle sort direction']) expect(screen.getByLabelText(l)).toBeInTheDocument();
    expect(within(screen.getByLabelText('Status')).getAllByRole('option').map((o) => o.textContent)).toEqual(['All Employees', 'Currently in Zone', 'Long Stay (>4h)', 'Multi-Zone']);
    expect(within(screen.getByLabelText('Sort by')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Time in Zone', 'Total Visits', 'Match Confidence', 'First Seen']);
    expect(screen.getByText('HR Manager')).toBeInTheDocument();
  });

  it('AC 11.1 — no engineer, attendance, shift or capacity wording anywhere on the page', async () => {
    render(<EmployeeMovementPage />);
    await ready();
    const text = document.body.textContent || '';
    for (const banned of ['Portal', 'Turnstile', 'Optical', 'telemetry', 'SLA', 'cosine', 'Shift', 'Overtime', 'Personnel', 'FRS Confidence', 'Biometric', 'Attendance']) expect(text.includes(banned), banned).toBe(false);
  });
});

describe('EmployeeMovementPage — employee cards (AC 9.2, 9.8)', () => {
  beforeEach(() => setApi());

  it('shows an initials avatar, name, id, role, department, status, real per-zone time bar, four tiles and the recent flow', async () => {
    render(<EmployeeMovementPage />);
    await ready();
    const c = card(7);
    expect(within(c).getByTestId('avatar')).toHaveTextContent('AR');
    expect(within(c).getByText('Asha Rao')).toBeInTheDocument();
    expect(within(c).getByText('E7')).toBeInTheDocument();
    expect(within(c).getByText('Engineer')).toBeInTheDocument();
    expect(within(c).getByText('Sales')).toBeInTheDocument();
    expect(within(c).getByText('Inside a zone now')).toBeInTheDocument();
    // time across zones: Lobby 200 min, ODC 50 min -> 80% / 20% of the bar
    const bar = within(c).getByTestId('zone-time-bar');
    const segs = [...bar.querySelectorAll('[data-zone]')] as HTMLElement[];
    expect(segs.map((s) => s.getAttribute('data-zone'))).toEqual(['Lobby', 'ODC']);
    expect(segs.map((s) => s.style.width)).toEqual(['80%', '20%']);
    expect(within(c).getByText('Lobby:')).toBeInTheDocument();
    // tiles
    for (const t of ['Time in Zone', 'Zone Visits', 'Match Confidence', 'Last Seen']) expect(within(c).getByText(t)).toBeInTheDocument();
    expect(within(c).getByText('4h 10m')).toBeInTheDocument();
    expect(within(c).getByText('4 visits')).toBeInTheDocument();
    expect(within(c).getByText('91%')).toBeInTheDocument();
    expect(within(c).getByTestId('recent-flow')).toHaveTextContent('Recent Flow: Lobby → ODC → Lobby');
    // the second employee is not currently inside
    expect(within(card(8)).getByText('Primary zone: ODC')).toBeInTheDocument();
  });

  it('AC 9.8 — no photo avatars or stock images, and no map/floor/spatial element', async () => {
    render(<EmployeeMovementPage />);
    await ready();
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(document.querySelector('canvas, iframe, [class*="leaflet"], [class*="floorplan"], [class*="floor-plan"], [id*="map"], [data-testid*="map"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/floor plan|\bfloor\b|coordinate|\bmap\b/i);
  });

  it('AC 9.3 — expanding a card fetches that employee for the selected range and shows the chronological stream, photos and preferred entrances', async () => {
    render(<EmployeeMovementPage />);
    await ready();
    fireEvent.click(within(card(7)).getByRole('button', { name: /View Activity Trail/ }));
    const trail = await within(card(7)).findByTestId('activity-trail');
    const call = mock.widgetCalls.find((c) => c.path.startsWith('/zones/movement/7'))!;
    const params = q(call.path);
    const today = presetRange('today');
    expect([params.get('fromDate'), params.get('toDate')]).toEqual([today.fromDate, today.toDate]);
    expect(params.get('tz')).toBeTruthy();
    await waitFor(() => expect(within(trail).getAllByTestId('trail-event')).toHaveLength(2));
    const [first, second] = within(trail).getAllByTestId('trail-event');
    expect(first).toHaveTextContent('Entry • Lobby');
    expect(first).toHaveTextContent('Entrance: Front Camera');
    expect(first).toHaveTextContent('90% (CAM-1)');
    expect(second).toHaveTextContent('Exit • Lobby');
    expect(second).toHaveTextContent('—'); // null confidence is a dash, not a number
    // photo: served through the existing authorised /uploads path by bare filename; null -> "No photo recorded"
    expect(api.photoPaths).toContain('/uploads/Asha_Rao_2026-09-21_04-00-00-111.jpg');
    expect(within(first).getByAltText('Event photo evidence')).toHaveAttribute('src', 'blob:/uploads/Asha_Rao_2026-09-21_04-00-00-111.jpg');
    expect(within(second).getAllByText('No photo recorded').length).toBeGreaterThan(0);
    // preferred entrance counts
    expect(within(trail).getByText('Front Camera')).toBeInTheDocument();
    expect(within(trail).getByText('5x')).toBeInTheDocument();
    fireEvent.click(within(card(7)).getByRole('button', { name: /Hide Activity Trail/ }));
    expect(within(card(7)).queryByTestId('activity-trail')).toBeNull();
  });
});

describe('EmployeeMovementPage — filters, sort, paging and date presets (AC 9.1, 9.9)', () => {
  beforeEach(() => setApi());

  it('AC 9.9 — defaults to Today; This Week / This Month / Custom change the range for cards, table and details', async () => {
    render(<EmployeeMovementPage />);
    await ready();
    const today = presetRange('today');
    expect([lastList().get('fromDate'), lastList().get('toDate')]).toEqual([today.fromDate, today.toDate]);
    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'This Week' }));
    await waitFor(() => expect(lastList().get('fromDate')).toBe(presetRange('week').fromDate));
    await waitFor(() => expect(lastTop().get('fromDate')).toBe(presetRange('week').fromDate));
    fireEvent.click(screen.getByRole('button', { name: 'This Month' }));
    await waitFor(() => expect(lastList().get('fromDate')).toBe(presetRange('month').fromDate));
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-08-15' } });
    await waitFor(() => { expect([lastList().get('fromDate'), lastList().get('toDate')]).toEqual(['2026-08-01', '2026-08-15']); });
    await ready();
    // drilldown timeline uses the same range
    fireEvent.click(within(card(7)).getByRole('button', { name: 'Open drilldown for Asha Rao' }));
    await waitFor(() => expect(mock.widgetCalls.some((c) => c.path.startsWith('/zones/movement/7') && q(c.path).get('fromDate') === '2026-08-01')).toBe(true));
    expect(screen.getByText(/Period: 2026-08-01 to 2026-08-15/)).toBeInTheDocument();
  });

  it('search, department, status, sort field, sort direction and paging are sent to the API', async () => {
    render(<EmployeeMovementPage />);
    await ready();
    expect(lastList().get('sort')).toBe('time');
    expect(lastList().get('dir')).toBe('desc');
    expect(lastList().has('status')).toBe(false);
    fireEvent.change(screen.getByLabelText('Search employees'), { target: { value: 'asha' } });
    await waitFor(() => expect(lastList().get('q')).toBe('asha'));
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: '2' } });
    await waitFor(() => expect(lastList().get('departmentId')).toBe('2'));
    expect(lastTop().get('departmentId')).toBe('2');
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'currently' } });
    await waitFor(() => expect(lastList().get('status')).toBe('currently'));
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'confidence' } });
    await waitFor(() => expect(lastList().get('sort')).toBe('confidence'));
    fireEvent.click(screen.getByLabelText('Toggle sort direction'));
    await waitFor(() => expect(lastList().get('dir')).toBe('asc'));
    expect(lastList().get('page')).toBe('1');
    // paging (2 employees, page size 12 -> single page, Next disabled)
    expect(screen.getByLabelText('Next page')).toBeDisabled();
  });

  it('paging: with more employees than a page, Next requests page 2', async () => {
    setApi({ '/zones/employees': (p: string) => (q(p).get('pageSize') === '12' ? { ...EMPLOYEES, total: 30 } : EMPLOYEES) });
    render(<EmployeeMovementPage />);
    await ready();
    fireEvent.click(screen.getByLabelText('Next page'));
    await waitFor(() => expect(lastList().get('page')).toBe('2'));
    expect(screen.getByText(/2 \/ 3/)).toBeInTheDocument();
  });

  it('view toggle: Zone Time Matrix shows stacked bars per employee; Compare (n) shows inline cards', async () => {
    render(<EmployeeMovementPage />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /Zone Time Matrix/ }));
    const rows = screen.getAllByTestId('matrix-employee');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Total time in zones: 4h 10m');
    expect(rows[0]).toHaveTextContent('4 visits • 91% match');
    fireEvent.click(screen.getByRole('button', { name: /Compare \(0\)/ }));
    expect(screen.getByText('No employees selected for comparison')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Select the 3 most active'));
    await waitFor(() => expect(screen.getAllByTestId('compare-card')).toHaveLength(2));
    expect(screen.getByRole('button', { name: /Compare \(2\)/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ravi Kumar from comparison' }));
    expect(screen.getAllByTestId('compare-card')).toHaveLength(1);
  });
});

describe('EmployeeMovementPage — Top Employees table and selection (AC 9.4)', () => {
  beforeEach(() => setApi());

  it('columns, ranking, search, sort and select-all / Compare Selected (n)', async () => {
    render(<EmployeeMovementPage />);
    await ready();
    const table = document.getElementById('table-top-employees-activity')!;
    for (const h of ['Rank', 'Employee', 'Department', 'Zone Visits', 'Total Time Inside', 'Avg Duration', 'Entries', 'Exits', 'Match Confidence', 'Last Seen', 'Drilldown']) expect(within(table).getAllByText(h).length).toBeGreaterThan(0);
    const rows = within(table).getAllByTestId('top-employee-row');
    expect(rows[0]).toHaveTextContent('#1');
    expect(rows[0]).toHaveTextContent('Asha Rao');
    expect(rows[0]).toHaveTextContent('4h 10m');
    expect(rows[0]).toHaveTextContent('+4');
    expect(rows[0]).toHaveTextContent('-3');
    expect(lastTop().get('sort')).toBe('visits');
    fireEvent.click(within(table).getByLabelText('Sort by total time inside'));
    await waitFor(() => expect(lastTop().get('sort')).toBe('time'));
    fireEvent.change(within(table).getByLabelText('Search top employees'), { target: { value: 'ravi' } });
    await waitFor(() => expect(lastTop().get('q')).toBe('ravi'));
    // selection
    expect(within(table).queryByText(/Compare Selected/)).toBeNull();
    fireEvent.click(within(table).getByLabelText('Select Asha Rao'));
    expect(within(table).getByText('Compare Selected (1)')).toBeInTheDocument();
    fireEvent.click(within(table).getByLabelText('Select all for comparison'));
    expect(within(table).getByText('Compare Selected (2)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Compare \(2\)/ })).toBeInTheDocument(); // card selection stays in sync
    fireEvent.click(within(table).getByLabelText('Select all for comparison'));
    expect(within(table).queryByText(/Compare Selected/)).toBeNull();
  });
});

describe('EmployeeMovementPage — Employee Drilldown modal (AC 9.5, 9.6, 9.7)', () => {
  beforeEach(() => setApi());

  it('shows metrics, entrance usage, zone movement history and the event timeline with labelled evidence photos', async () => {
    render(<EmployeeMovementPage />);
    await ready();
    fireEvent.click(within(card(7)).getByRole('button', { name: 'Open drilldown for Asha Rao' }));
    const modal = await screen.findByRole('dialog', { name: 'Drilldown for Asha Rao' });
    expect(within(modal).getByTestId('dd-visits')).toHaveTextContent('4');
    expect(within(modal).getByTestId('dd-time')).toHaveTextContent('4h 10m');
    expect(within(modal).getByTestId('dd-avg')).toHaveTextContent('1h 3m');
    expect(within(modal).getByText('+4 In')).toBeInTheDocument();
    expect(within(modal).getByText('-3 Out')).toBeInTheDocument();
    expect(within(modal).getByText('First Seen')).toBeInTheDocument();
    expect(within(modal).getByText('Last Seen')).toBeInTheDocument();
    expect(within(modal).getByTestId('dd-confidence')).toHaveTextContent('91%');
    // entrance usage distribution
    expect(within(modal).getByText('5 passages')).toBeInTheDocument();
    // zone movement history: Lobby then ODC (a move from Lobby to ODC)
    const transitions = await within(modal).findByTestId('dd-transitions');
    expect(transitions).toHaveTextContent('Lobby');
    expect(transitions).toHaveTextContent('ODC');
    expect(transitions).toHaveTextContent('no exit recorded');
    // event timeline with per-event photos, labelled
    const events = await within(modal).findAllByTestId('dd-event');
    expect(events).toHaveLength(2);
    expect(within(events[0]).getByTestId('evidence-photo')).toHaveAttribute('data-kind', 'Event photo');
    expect(within(events[1]).getByText('No photo recorded')).toBeInTheDocument();
    // day-level check-in / check-out photos as the fallback, labelled, with an honest note
    const daily = within(modal).getByTestId('dd-daily-photos');
    const kinds = within(daily).getAllByTestId('evidence-photo').map((f) => f.getAttribute('data-kind'));
    expect(kinds).toEqual(['Check-in', 'Check-out']);
    expect(api.photoPaths).toContain('/uploads/in_1.jpg');
    expect(within(daily).getByText('One photo per day, not per zone move')).toBeInTheDocument();
    expect(within(daily).getByText('No photo recorded')).toBeInTheDocument(); // null checkout photo
    fireEvent.click(within(modal).getByRole('button', { name: 'Close Drilldown' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens from the Top Employees table and closes on backdrop click', async () => {
    render(<EmployeeMovementPage />);
    await ready();
    const table = document.getElementById('table-top-employees-activity')!;
    fireEvent.click(within(table).getByLabelText('Open drilldown for Ravi Kumar'));
    expect(await screen.findByRole('dialog', { name: 'Drilldown for Ravi Kumar' })).toBeInTheDocument();
    fireEvent.click(document.getElementById('employee-drilldown-modal-backdrop')!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a failing detail request shows an inline error inside the modal, not a crash', async () => {
    setApi({ '/zones/movement/': new Error('details unavailable') });
    render(<EmployeeMovementPage />);
    await ready();
    fireEvent.click(within(card(7)).getByRole('button', { name: 'Open drilldown for Asha Rao' }));
    expect((await screen.findAllByText('details unavailable')).length).toBeGreaterThan(0);
    expect(screen.getByTestId('dd-visits')).toHaveTextContent('4'); // the list data still renders
  });
});

describe('EmployeeMovementPage — Multi-Employee Compare modal (AC 9.5)', () => {
  beforeEach(() => setApi());

  it('tabs are Zone Visits & Movements, Time Spent Inside, Match Confidence (mean only, no latency) and a side-by-side matrix', async () => {
    render(<EmployeeMovementPage />);
    await ready();
    const table = document.getElementById('table-top-employees-activity')!;
    fireEvent.click(within(table).getByLabelText('Select all for comparison'));
    fireEvent.click(within(table).getByText('Compare Selected (2)'));
    const modal = await screen.findByRole('dialog', { name: 'Compare employees' });
    expect(within(modal).getByTestId('compare-modal-count')).toHaveTextContent('2 Selected');
    const tabs = within(modal).getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Zone Visits & Movements', 'Time Spent Inside', 'Match Confidence', 'Side-by-Side Comparison Matrix']);
    expect(modal.textContent).not.toMatch(/latency|accuracy|success match|cosine|vector/i);
    fireEvent.click(within(modal).getByRole('tab', { name: 'Match Confidence' }));
    expect(within(modal).getByText('Mean Match Confidence')).toBeInTheDocument();
    fireEvent.click(within(modal).getByRole('tab', { name: 'Time Spent Inside' }));
    expect(within(modal).getByText('Time Spent Inside and Average Visit')).toBeInTheDocument();
    fireEvent.click(within(modal).getByRole('tab', { name: 'Side-by-Side Comparison Matrix' }));
    const matrix = within(modal).getByTestId('compare-matrix');
    for (const row of ['Employee ID', 'Department', 'Total Zone Visits', 'Total Time Inside', 'Average Visit', 'Entries / Exits', 'Mean Match Confidence']) expect(within(matrix).getByText(row)).toBeInTheDocument();
    expect(matrix).toHaveTextContent('E7');
    expect(matrix).toHaveTextContent('+4 / -3');
    expect(matrix).toHaveTextContent('70%');
  });

  it('remove / add employees and open a drilldown from the matrix', async () => {
    render(<EmployeeMovementPage />);
    await ready();
    fireEvent.click(within(card(7)).getByLabelText('Compare Asha Rao'));
    fireEvent.click(within(card(8)).getByLabelText('Compare Ravi Kumar'));
    fireEvent.click(screen.getByRole('button', { name: /Full Comparison/ }));
    const modal = await screen.findByRole('dialog', { name: 'Compare employees' });
    fireEvent.click(within(modal).getByLabelText('Remove Ravi Kumar'));
    expect(within(modal).getByTestId('compare-modal-count')).toHaveTextContent('1 Selected');
    fireEvent.change(within(modal).getByLabelText('Add employee'), { target: { value: '8' } });
    expect(within(modal).getByTestId('compare-modal-count')).toHaveTextContent('2 Selected');
    fireEvent.click(within(modal).getByRole('tab', { name: 'Side-by-Side Comparison Matrix' }));
    fireEvent.click(within(modal).getAllByText('Open Drilldown')[0]);
    expect(await screen.findByRole('dialog', { name: /Drilldown for/ })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Compare employees' })).toBeNull();
  });
});

describe('EmployeeMovementPage — states, header (AC 6.6, 6.7, 7.4, 10.2)', () => {
  it('empty result shows an empty state, not zeros', async () => {
    setApi({ '/zones/employees': { rows: [], total: 0, summary: { trackedEmployees: 0, meanTimeInZoneMinutes: null, mostActiveEmployee: null, meanMatchConfidence: null } } });
    render(<EmployeeMovementPage />);
    await waitFor(() => expect(screen.getAllByTestId('widget-empty').length).toBeGreaterThanOrEqual(1));
    expect(screen.getByTestId('summary-mean-time')).toHaveTextContent('—');
    expect(screen.getByTestId('summary-most-active')).toHaveTextContent('—');
    expect(screen.getByTestId('summary-mean-confidence')).toHaveTextContent('—');
  });

  it('a failing list request shows an inline error', async () => {
    setApi({ '/zones/employees': new Error('employees unavailable') });
    render(<EmployeeMovementPage />);
    expect((await screen.findAllByText('employees unavailable')).length).toBeGreaterThan(0);
  });

  it('Refresh refetches the lists; Export downloads a CSV of the employees shown', async () => {
    setApi();
    const blobs: Blob[] = [];
    (URL as any).createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return 'blob:x'; });
    (URL as any).revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<EmployeeMovementPage />);
    await ready();
    const before = mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mock.calls.length).toBeGreaterThanOrEqual(before + 1));
    expect(mock.calls[mock.calls.length - 1].path).toContain('refresh=1'); // Refresh bypasses the server cache (AC 12.5)
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    const text: string = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(blobs[0]); });
    expect(text).toContain('Employees (Today)');
    expect(text).toContain('Asha Rao');
    expect(text).toContain('mean_match_confidence');
    click.mockRestore();
  });

  it('AC 10.2/10.3 — the top table scrolls horizontally; cards collapse to one column', async () => {
    setApi();
    render(<EmployeeMovementPage />);
    await ready();
    expect(document.getElementById('table-top-employees-activity')!.querySelector('.overflow-x-auto')).not.toBeNull();
    const grid = card(7).parentElement!;
    expect(grid.className).toContain('grid-cols-1');
    expect(grid.className).toContain('lg:grid-cols-2');
    cleanup();
  });
});
