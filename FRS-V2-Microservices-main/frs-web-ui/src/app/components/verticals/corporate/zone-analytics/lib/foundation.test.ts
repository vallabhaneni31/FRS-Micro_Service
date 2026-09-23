// specs/0003-zone-analytics — Task 18 foundation: query builder, presets,
// formatting, CSV, design tokens (Req 11.3), and the "no mock data" guard.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildQuery, DEFAULT_DEEP_DIVE_FILTERS } from './api';
import { presetRange, fmtMinutes, windowLabel, initials, zoneColor, ZONE_PALETTE, fmtConfidence } from './format';
import { sectionsToCsv } from './csv';

const ROOT = path.resolve(__dirname, '..');
const STYLES = path.resolve(__dirname, '../../../../../../styles');

describe('buildQuery: every shared filter reaches the request (Req 3.9, 7.3)', () => {
  it('serialises zone (repeated), entrance, department, camera, dates, interval, confidence (0-1) and security-only', () => {
    const q = new URLSearchParams(buildQuery({
      selectedZones: ['Lobby', 'ODC'], entryPointId: 'E1', departmentId: '3', cameraId: 'C1',
      fromDate: '2026-09-01', toDate: '2026-09-21', timeRange: 'morning', minConfidence: 80, securityOnly: true,
    }));
    expect(q.getAll('zone')).toEqual(['Lobby', 'ODC']);
    expect(q.get('entryPointId')).toBe('E1');
    expect(q.get('departmentId')).toBe('3');
    expect(q.get('cameraId')).toBe('C1');
    expect(q.get('fromDate')).toBe('2026-09-01');
    expect(q.get('toDate')).toBe('2026-09-21');
    expect(q.get('timeRange')).toBe('morning');
    expect(q.get('minConfidence')).toBe('0.8');
    expect(q.get('securityOnly')).toBe('true');
    expect(q.get('tz')).toBeTruthy();
  });

  it('confidence filter is OFF by default (not 80%) and full-day / no security filter add no params', () => {
    const q = new URLSearchParams(buildQuery(DEFAULT_DEEP_DIVE_FILTERS));
    expect(q.has('minConfidence')).toBe(false);
    expect(q.has('timeRange')).toBe(false);
    expect(q.has('securityOnly')).toBe(false);
    expect(DEFAULT_DEEP_DIVE_FILTERS.minConfidence).toBeNull();
    expect(DEFAULT_DEEP_DIVE_FILTERS.datePreset).toBe('today');
  });

  it('extra params (granularity, page...) are appended', () => {
    expect(new URLSearchParams(buildQuery({}, { granularity: 'week', page: 2, q: '' })).get('granularity')).toBe('week');
    expect(new URLSearchParams(buildQuery({}, { q: '' })).has('q')).toBe(false);
  });
});

describe('date presets (Req 7.1, 9.9)', () => {
  const wed = new Date(2026, 8, 23, 12, 0, 0); // Wed 23 Sep 2026
  it('Today = today..today; This Week = Monday..today; This Month = 1st..today', () => {
    expect(presetRange('today', wed)).toEqual({ fromDate: '2026-09-23', toDate: '2026-09-23' });
    expect(presetRange('week', wed)).toEqual({ fromDate: '2026-09-21', toDate: '2026-09-23' });
    expect(presetRange('month', wed)).toEqual({ fromDate: '2026-09-01', toDate: '2026-09-23' });
  });
  it('a Sunday belongs to the week that started on the previous Monday', () => {
    expect(presetRange('week', new Date(2026, 8, 27)).fromDate).toBe('2026-09-21');
  });
});

describe('formatting: missing data is an em dash, never a fake number', () => {
  it('fmtMinutes / windowLabel / fmtConfidence', () => {
    expect(fmtMinutes(null)).toBe('—');
    expect(fmtMinutes(45)).toBe('45m');
    expect(fmtMinutes(135)).toBe('2h 15m');
    expect(fmtMinutes(120)).toBe('2h');
    expect(windowLabel(null)).toBe('—');
    expect(windowLabel({ startHour: 9, endHour: 10, count: 4 })).toBe('09:00 – 10:00');
    expect(windowLabel({ startHour: 23, endHour: 0, count: 1 })).toBe('23:00 – 00:00');
    expect(fmtConfidence(0.912)).toBe('91%');
    expect(fmtConfidence(null)).toBe('—');
  });
  it('initials avatar text (no photos, Req 9.2)', () => {
    expect(initials('Asha Rao')).toBe('AR');
    expect(initials('Cher')).toBe('C');
    expect(initials('')).toBe('?');
  });
  it('zone colours are assigned by index from the palette and wrap', () => {
    expect(zoneColor(0)).toBe(ZONE_PALETTE[0]);
    expect(zoneColor(ZONE_PALETTE.length)).toBe(ZONE_PALETTE[0]);
    expect(zoneColor(-1)).toBe(ZONE_PALETTE[ZONE_PALETTE.length - 1]);
  });
});

describe('CSV export (Req 6.7)', () => {
  it('writes titled sections, escapes quotes/commas/newlines, skips empty sections', () => {
    const text = sectionsToCsv([
      { title: 'Summary', rows: [{ label: 'a,b', value: 'say "hi"', note: 'x\ny' }] },
      { title: 'Empty', rows: [] },
      { title: 'Events', rows: [{ t: 1 }] },
    ]);
    expect(text).toBe('Summary\nlabel,value,note\n"a,b","say ""hi""","x\ny"\n\nEvents\nt\n1');
  });
});

describe('design tokens (Req 11.3): the FRS theme carries what the prototype uses', () => {
  const theme = fs.readFileSync(path.join(STYLES, 'theme.css'), 'utf8');
  it('.app-canvas, .glass-panel and .glass-card exist', () => {
    for (const cls of ['.app-canvas', '.glass-panel', '.glass-card']) expect(theme.includes(cls), cls).toBe(true);
  });
  it('canvas #EEF1F6 and primary #2563EB', () => {
    expect(/#eef1f6/i.test(theme)).toBe(true);
    const all = ['theme.css', 'index.css', 'tailwind.css'].map((f) => { try { return fs.readFileSync(path.join(STYLES, f), 'utf8'); } catch { return ''; } }).join('\n');
    expect(/#2563EB/i.test(all)).toBe(true);
  });
  it('Inter is the app font', () => {
    const all = fs.readdirSync(STYLES).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(STYLES, f), 'utf8')).join('\n');
    expect(/Inter/.test(all)).toBe(true);
  });
});

describe('no mock data anywhere in the module (hard constraint)', () => {
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  it('no file named mock*, and no import of mockData / data/mock', () => {
    const files = walk(ROOT);
    expect(files.filter((f) => /mock/i.test(path.basename(f)))).toEqual([]);
    for (const f of files.filter((x) => /\.(ts|tsx)$/.test(x) && !/foundation\.test\.ts$/.test(x))) {
      expect(/from ['"][^'"]*(mockData|data\/mock)[^'"]*['"]/.test(fs.readFileSync(f, 'utf8')), f).toBe(false);
    }
  });
});
