/**
 * Formatting + presentation helpers shared by every Zone Analytics widget.
 * Colours are assigned by index from the design-system palette (not data).
 */
import type { DatePreset, HourWindow } from './types';

/** Design-system palette (blue/emerald/amber/rose/sky/indigo family) assigned to zones by index. */
export const ZONE_PALETTE = ['#2563EB', '#10B981', '#F59E0B', '#F43F5E', '#0EA5E9', '#6366F1', '#14B8A6', '#A855F7'];
export const zoneColor = (index: number) => ZONE_PALETTE[((index % ZONE_PALETTE.length) + ZONE_PALETTE.length) % ZONE_PALETTE.length];

export const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const pad2 = (n: number) => String(n).padStart(2, '0');
export const hourLabel = (h: number) => `${pad2(h)}:00`;

/** "09:00 – 10:00" for a computed window; "—" when there is no data. */
export function windowLabel(w: HourWindow | null | undefined): string {
  return w ? `${hourLabel(w.startHour)} – ${hourLabel(w.endHour)}` : '—';
}

/** 135 -> "2h 15m", 45 -> "45m", null -> "—". */
export function fmtMinutes(mins: number | null | undefined): string {
  if (mins === null || mins === undefined || Number.isNaN(mins)) return '—';
  const m = Math.round(mins);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

export const fmtNumber = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString());
/** 0.912 -> "91%". Confidence is stored on a 0-1 scale. */
export const fmtConfidence = (c: number | null | undefined) => (c === null || c === undefined ? '—' : `${Math.round(c * 100)}%`);
export const fmtPct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n}%`);

export function fmtTime(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
export function fmtDateTime(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/** Initials avatar text (no photos, no stock images — Req 9.2, 9.8). */
export function initials(name: string | null | undefined): string {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export const browserTz = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
};

const iso = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Date range for a preset: Today, This Week (Monday to today), This Month (1st to today). */
export function presetRange(preset: DatePreset, now: Date = new Date()): { fromDate: string; toDate: string } {
  const today = iso(now);
  if (preset === 'week') {
    const d = new Date(now);
    const back = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - back);
    return { fromDate: iso(d), toDate: today };
  }
  if (preset === 'month') {
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    return { fromDate: iso(d), toDate: today };
  }
  return { fromDate: today, toDate: today };
}

export const DATE_PRESET_LABELS: Record<DatePreset, string> = { today: 'Today', week: 'This Week', month: 'This Month', custom: 'Custom' };
export const TIME_RANGE_LABELS: Record<string, string> = {
  full: 'Full Day', morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', peak: 'Busiest Hours',
};

/** `YYYY-MM-DDTHH:MM:SS` local wall-clock string from the API -> short axis label. */
export function seriesLabel(ts: string, granularity: 'hour' | 'day' | 'week'): string {
  if (granularity === 'hour') return ts.slice(11, 16);
  const d = new Date(`${ts.slice(0, 10)}T00:00:00`);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
