import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

/**
 * Two-way bind a single URL query param to component state for deep-linking.
 *
 * - Reads return `defaultValue` when the param is absent.
 * - Writes that equal `defaultValue` (or '') remove the param, keeping URLs clean.
 * - History is *replaced*, not pushed, so tweaking filters doesn't flood the back button.
 * - Other params are preserved, so several useQueryParam calls coexist on one screen.
 */
export function useQueryParam(
  key: string,
  defaultValue = ''
): [string, (value: string | ((prev: string) => string)) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const value = searchParams.get(key) ?? defaultValue;

  const setValue = useCallback((next: string | ((prev: string) => string)) => {
    setSearchParams(prev => {
      const params = new URLSearchParams(prev);
      const current = params.get(key) ?? defaultValue;
      const resolved = typeof next === 'function' ? next(current) : next;
      if (resolved === defaultValue || resolved === '') params.delete(key);
      else params.set(key, resolved);
      return params;
    }, { replace: true, preventScrollReset: true });
  }, [key, defaultValue, setSearchParams]);

  return [value, setValue];
}

/** Numeric variant for params like `page`. Clamps to >= 1. */
export function useNumberQueryParam(
  key: string,
  defaultValue = 1
): [number, (value: number | ((prev: number) => number)) => void] {
  const [raw, setRaw] = useQueryParam(key, String(defaultValue));
  const value = Math.max(1, parseInt(raw || String(defaultValue), 10) || defaultValue);
  const setValue = useCallback((next: number | ((prev: number) => number)) => {
    const resolved = typeof next === 'function' ? next(value) : next;
    setRaw(String(Math.max(1, resolved)));
  }, [value, setRaw]);
  return [value, setValue];
}

/**
 * Write MULTIPLE query params atomically in a single setSearchParams call.
 * Use this whenever two or more params must change together (e.g. status + page)
 * — calling separate useQueryParam setters back-to-back can race, since each
 * independently calls React Router's setSearchParams and the second call can
 * silently clobber the first.
 */
export function useQueryParams(): (
  updates: Record<string, string | null>
) => void {
  const [, setSearchParams] = useSearchParams();

  return useCallback((updates: Record<string, string | null>) => {
    setSearchParams(prev => {
      const params = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === '' || value === 'all') params.delete(key);
        else params.set(key, value);
      }
      return params;
    }, { replace: true, preventScrollReset: true });
  }, [setSearchParams]);
}

