/**
 * Shared time-format preference stored in localStorage.
 * Key: "retail_time_format"  Values: "12h" | "24h"
 */

export type TimeFormat = '12h' | '24h';
const STORAGE_KEY = 'retail_time_format';

/** Read the saved preference (defaults to '12h'). */
export function getTimeFormat(): TimeFormat {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === '24h' || stored === '12h') return stored;
  } catch {}
  return '12h';
}

/** Persist the preference and broadcast to other components. */
export function saveTimeFormat(fmt: TimeFormat): void {
  try {
    localStorage.setItem(STORAGE_KEY, fmt);
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: fmt }));
  } catch {}
}

/**
 * Format a time string (HH:MM) or Date object into the preferred format.
 */
export function formatTime(time: string | Date, fmt: TimeFormat): string {
  try {
    const date = typeof time === 'string'
      ? (() => { const d = new Date(); const [h, m] = time.split(':'); d.setHours(+h, +m); return d; })()
      : time;
    if (fmt === '24h') {
      return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  } catch {
    return String(time);
  }
}
