import React from 'react';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PEAK_HOURS, DEPARTMENTS, ENTRY_POINTS, TIME_SPENT, ZONES, OCCUPANCY, EMPLOYEES, COMPARE } from '../testing/fixtures';

// specs/0003-zone-analytics — design.md 4 (test row 11.x, "every chart mounts with fixture data,
// recharts 2.15.2 smoke test"). jsdom has no layout, so ResponsiveContainer is given a fixed size;
// everything else is the real recharts 2.15.2 renderer. Each chart must produce real SVG marks
// (bars / lines / pie sectors) for the fixture data and log no React or recharts error.

vi.mock('recharts', async () => {
  const actual = await vi.importActual<any>('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: any) => <div style={{ width: 800, height: 300 }}>{React.cloneElement(children, { width: 800, height: 300 })}</div>,
  };
});

import { ZoneOccupancyTrend } from './ZoneOccupancyTrend';
import { DepartmentDistributionChart } from './DepartmentDistributionChart';
import { PeakHoursAnalysis } from './PeakHoursAnalysis';
import { HourlyTrafficChart } from './HourlyTrafficChart';
import { EntryPointTrafficChart } from './EntryPointTrafficChart';
import { EntriesExitsChart } from './EntriesExitsChart';
import { TimeSpentHistogram } from './TimeSpentHistogram';
import { CompareZonesDashboard } from '../compare/CompareZonesDashboard';
import { MultiEmployeeCompareModal } from '../modals/MultiEmployeeCompareModal';
import { ZoneOccupancyHeatmap } from './ZoneOccupancyHeatmap';
import { EmployeeMovementMatrix } from './EmployeeMovementMatrix';
import { HEATMAP, MATRIX } from '../testing/fixtures';

const count = (c: HTMLElement, sel: string) => c.querySelectorAll(sel).length;
const errors: unknown[][] = [];
const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });
afterEach(() => { errors.length = 0; });

describe('recharts 2.15.2 smoke: every chart mounts with fixture data and draws real marks', () => {
  it('Zone Occupancy Trend: one line per plotted zone, in all three periods', () => {
    const series = { hourly: OCCUPANCY('hour').series, daily: OCCUPANCY('day').series, weekly: OCCUPANCY('week').series };
    const { container } = render(<ZoneOccupancyTrend zones={ZONES} series={series} cameras={{ online: 3, total: 4 }} />);
    expect(count(container, '.recharts-line-curve')).toBe(2); // Lobby + ODC have data; Innovate Area has none
    fireEvent.click(screen.getByRole('button', { name: 'Weekly' }));
    expect(count(container, '.recharts-line-curve')).toBe(2);
    expect(errors).toEqual([]);
  });

  it('Department donut: one pie sector per department', async () => {
    const { container } = render(<DepartmentDistributionChart data={DEPARTMENTS} />);
    // the Pie animates in over a few frames; wait for the last sector
    await waitFor(() => expect(count(container, '.recharts-pie-sector')).toBe(DEPARTMENTS.length));
    expect(errors).toEqual([]);
  });

  it('Peak Hours & Traffic: composed bars + two lines', () => {
    const { container } = render(<PeakHoursAnalysis data={PEAK_HOURS} />);
    expect(count(container, '.recharts-bar-rectangle')).toBe(PEAK_HOURS.hourly.length);
    expect(count(container, '.recharts-line-curve')).toBe(2);
    expect(errors).toEqual([]);
  });

  it('Hourly Zone Traffic: one bar per hour with data', () => {
    const { container } = render(<HourlyTrafficChart hourly={PEAK_HOURS.hourly} />);
    expect(count(container, '.recharts-bar-rectangle')).toBe(PEAK_HOURS.hourly.length);
    expect(errors).toEqual([]);
  });

  it('Entrance-wise Traffic: grouped entries and exits bars per entrance', () => {
    const { container } = render(<EntryPointTrafficChart data={ENTRY_POINTS} />);
    expect(count(container, '.recharts-bar-rectangle')).toBe(ENTRY_POINTS.length * 2);
    expect(errors).toEqual([]);
  });

  it('Entries vs Exits: hourly timeline and compare-all-zones views', () => {
    const { container } = render(<EntriesExitsChart data={PEAK_HOURS} zones={['Lobby', 'ODC']} />);
    expect(count(container, '.recharts-bar-rectangle')).toBe(2 * 2); // hours 9 and 13 x (entries, exits)
    fireEvent.click(screen.getByRole('button', { name: 'Compare All Zones' }));
    expect(count(container, '.recharts-bar-rectangle')).toBe(2 * 2); // two zones x (entries, exits)
    expect(errors).toEqual([]);
  });

  it('Time Spent histogram: one bar per bucket', () => {
    const { container } = render(<TimeSpentHistogram data={TIME_SPENT} />);
    expect(count(container, '.recharts-bar-rectangle')).toBeGreaterThanOrEqual(TIME_SPENT.filter((b) => b.count > 0).length);
    expect(errors).toEqual([]);
  });

  it('Heatmap and Movement Matrix (non-recharts) render their cells / rows', () => {
    const h = render(<ZoneOccupancyHeatmap data={HEATMAP} />);
    expect(h.getAllByTestId('heatmap-cell').length).toBeGreaterThan(0);
    const m = render(<EmployeeMovementMatrix transitions={MATRIX.matrix} />);
    expect(m.getAllByTestId('transition-row')).toHaveLength(MATRIX.matrix.length);
    expect(errors).toEqual([]);
  });

  it('Compare Zones: line chart (occupancy, dwell) and bar chart (traffic) from real series', () => {
    const noop = () => {};
    const props = { zones: ZONES, selected: ['Lobby', 'ODC'], onSelectedChange: noop, onMetricChange: noop, onGranularityChange: noop, granularity: 'hour' as const };
    const occ = render(<CompareZonesDashboard {...props} metric="occupancy" data={COMPARE('occupancy', 'hour')} />);
    expect(count(occ.container, '.recharts-line-curve')).toBe(2);
    occ.unmount();
    const traffic = render(<CompareZonesDashboard {...props} metric="traffic" data={COMPARE('traffic', 'hour')} />);
    expect(count(traffic.container, '.recharts-bar-rectangle')).toBe(2 * 2 * 2); // 2 zones x (in, out) x 2 buckets
    traffic.unmount();
    const dwell = render(<CompareZonesDashboard {...props} metric="dwell" data={COMPARE('dwell', 'hour')} />);
    expect(count(dwell.container, '.recharts-line-curve')).toBe(2);
    expect(errors).toEqual([]);
  });

  it('Multi-Employee Compare modal: all three chart tabs draw bars', () => {
    const { container } = render(<MultiEmployeeCompareModal selectedEmployees={EMPLOYEES.rows} candidates={EMPLOYEES.rows} onClose={() => {}} onToggleEmployee={() => {}} onSelectEmployeeForDrilldown={() => {}} />);
    expect(count(container, '.recharts-bar-rectangle')).toBe(2 * 3);
    fireEvent.click(screen.getByRole('tab', { name: 'Time Spent Inside' }));
    expect(count(container, '.recharts-bar-rectangle')).toBe(2 * 2);
    fireEvent.click(screen.getByRole('tab', { name: 'Match Confidence' }));
    expect(count(container, '.recharts-bar-rectangle')).toBe(2);
    expect(errors).toEqual([]);
  });

  it('a chart given no data shows an empty state instead of an empty SVG', () => {
    const { container } = render(<HourlyTrafficChart hourly={[]} />);
    expect(count(container, 'svg.recharts-surface')).toBe(0);
    expect(screen.getByTestId('widget-empty')).toBeInTheDocument();
    spy.mockClear();
  });
});
