/**
 * Data hooks for Zone Analytics (specs/0003-zone-analytics, Requirement 12).
 *
 * A view loads with at most three HTTP requests instead of one per widget:
 *   GET /zones/batch/filters               (filter lists, cached client-side for 10 min)
 *   GET /zones/batch/<view>/core           (hero cards + charts)
 *   GET /zones/batch/<view>/detail         (tables / events)
 * each answering { data: {<widget>: ...}, errors: {<widget>: message}, computedAt }.
 * `useZoneBatch` debounces param changes (400 ms), skips a refetch when the params are
 * unchanged, aborts a superseded request, and exposes per-widget results so a failing
 * widget shows an inline error while the rest render. Refresh sends refresh=1 (the server
 * cache is bypassed) and the "last updated" time is the server's computedAt. No mock data.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../../../hooks/useScopeHeaders';
import { apiRequest } from '../../../../../services/http/apiClient';
import { browserTz, presetRange } from './format';
import type { DeepDiveFilters } from './types';

export const DEFAULT_DEEP_DIVE_FILTERS: DeepDiveFilters = {
  selectedZones: [],
  entryPointId: '',
  departmentId: '',
  timeRange: 'full',
  datePreset: 'today',
  ...presetRange('today'),
  cameraId: '',
  minConfidence: null,
  securityOnly: false,
};

/** Shared filter query string (design.md 2.1): every filter reaches every request. */
export function buildQuery(f: Partial<DeepDiveFilters>, extra: Record<string, string | number | undefined> = {}): string {
  const q = new URLSearchParams();
  (f.selectedZones ?? []).forEach((z) => q.append('zone', z));
  if (f.entryPointId) q.set('entryPointId', f.entryPointId);
  if (f.departmentId) q.set('departmentId', f.departmentId);
  if (f.cameraId) q.set('cameraId', f.cameraId);
  if (f.fromDate) q.set('fromDate', f.fromDate);
  if (f.toDate) q.set('toDate', f.toDate);
  if (f.timeRange && f.timeRange !== 'full') q.set('timeRange', f.timeRange);
  if (f.minConfidence !== null && f.minConfidence !== undefined) q.set('minConfidence', String(f.minConfidence / 100));
  if (f.securityOnly) q.set('securityOnly', 'true');
  q.set('tz', browserTz());
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') q.set(k, String(v));
  return q.toString();
}

export interface Widget<T> { data: T | null; error: string | null }

export type ZoneView = 'overview' | 'deep-dive' | 'compare' | 'movement';
export type ZonePart = 'core' | 'detail';

/** Debounce applied to every param change after the first load (AC 12.6). */
export const ZONE_DEBOUNCE_MS = 400;
/** Client-side lifetime of the filter lists (AC 12.4: 10 minutes). */
export const FILTER_LIST_TTL_MS = 10 * 60 * 1000;

interface BatchResponse { data?: Record<string, unknown>; errors?: Record<string, string>; computedAt?: string }

interface BatchState {
  data: Record<string, unknown>;
  errors: Record<string, string>;
  requestError: string | null;
  computedAt: Date | null;
}

const EMPTY: BatchState = { data: {}, errors: {}, requestError: null, computedAt: null };

/**
 * Generic batch loader. `path` null (or enabled=false) means "nothing to load yet".
 * The first request for a hook instance is sent immediately; later param changes wait
 * `debounceMs` after the last change; the same params never refetch; a request that is
 * superseded (new params, Refresh, unmount) is aborted and its result ignored.
 */
function useBatchRequest(path: string | null, opts: { enabled?: boolean; debounceMs?: number; ttlMs?: number } = {}) {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const { enabled = true, debounceMs = ZONE_DEBOUNCE_MS, ttlMs } = opts;
  const [state, setState] = useState<BatchState>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const first = useRef(true);
  const handledNonce = useRef(0);
  const seq = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const latest = useRef({ accessToken, scopeHeaders });
  latest.current = { accessToken, scopeHeaders };
  const scopeKey = JSON.stringify(scopeHeaders ?? {});

  useEffect(() => {
    if (!enabled || path === null) { setLoading(false); return undefined; }
    const isRefresh = nonce !== handledNonce.current;
    const delay = first.current || isRefresh ? 0 : debounceMs;
    setLoading(true);
    const fire = () => {
      first.current = false;
      handledNonce.current = nonce;
      const ac = new AbortController();
      controller.current = ac;
      const mine = ++seq.current;
      const sep = path.includes('?') ? '&' : '?';
      const url = isRefresh ? `${path}${sep}refresh=1` : path;
      // Aggregates are cached by the server (60 s); only the filter lists use the client cache.
      const cacheOpts = ttlMs && !isRefresh ? { ttlMs } : { noCache: true };
      apiRequest<BatchResponse>(url, { accessToken: latest.current.accessToken, scopeHeaders: latest.current.scopeHeaders, signal: ac.signal, ...cacheOpts } as any)
        .then((res) => {
          if (mine !== seq.current || ac.signal.aborted) return;
          setState({ data: res?.data ?? {}, errors: res?.errors ?? {}, requestError: null, computedAt: res?.computedAt ? new Date(res.computedAt) : new Date() });
          setLoading(false);
        })
        .catch((err) => {
          if (mine !== seq.current || ac.signal.aborted) return;
          setState({ data: {}, errors: {}, requestError: (err as Error)?.message || 'Could not load this section', computedAt: null });
          setLoading(false);
        });
    };
    // The first load and Refresh go out at once; later param changes wait for the debounce.
    const timer = delay === 0 ? null : setTimeout(fire, delay);
    if (delay === 0) fire();
    return () => {
      if (timer) clearTimeout(timer);
      // New params / Refresh / unmount: cancel the in-flight request and ignore its result.
      seq.current += 1;
      controller.current?.abort();
      controller.current = null;
    };
    // The token and scope headers are read through a ref so a token refresh alone never refetches;
    // a real scope change (scopeKey) does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, enabled, debounceMs, ttlMs, scopeKey]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { state, loading, refresh };
}

/**
 * Load one part of a view. `keys` are the widget names this part returns; the result has one
 * `{data, error}` entry per key, so a failing widget only affects itself. `query` null skips
 * the request (nothing selected yet).
 */
export function useZoneBatch<K extends string>(view: ZoneView, part: ZonePart, keys: readonly K[], query: string | null, opts: { enabled?: boolean; debounceMs?: number } = {}) {
  const path = query === null ? null : `/zones/batch/${view}/${part}?${query}`;
  const { state, loading, refresh } = useBatchRequest(path, opts);
  const keyList = keys.join('|');
  const results = useMemo(() => {
    const out = {} as Record<K, Widget<any>>;
    for (const k of keys) {
      out[k] = { data: (state.data[k] as any) ?? null, error: state.errors[k] ?? state.requestError ?? null };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, keyList]);
  return { results, loading, computedAt: state.computedAt, refresh };
}

/** The most recent of several computedAt times (a view with core + detail shows the newest). */
export function latestOf(...times: (Date | null)[]): Date | null {
  const real = times.filter((t): t is Date => t instanceof Date);
  return real.length ? real.reduce((a, b) => (b > a ? b : a)) : null;
}

/** Filter-list sources loaded once per session via the batch endpoint (10 min client cache). */
export function useZoneFilterLists(_withCameras = true) {
  const path = `/zones/batch/filters?${new URLSearchParams({ tz: browserTz() }).toString()}`;
  const { state } = useBatchRequest(path, { ttlMs: FILTER_LIST_TTL_MS });
  return useMemo(() => ({
    zones: (state.data.zones ?? []) as import('./types').ZoneListItem[],
    entryPoints: (state.data.entryPoints ?? []) as import('./types').EntryPointOption[],
    departments: (state.data.departments ?? []) as import('./types').DepartmentOption[],
    cameras: (state.data.cameras ?? []) as import('./types').CameraOption[],
  }), [state]);
}
