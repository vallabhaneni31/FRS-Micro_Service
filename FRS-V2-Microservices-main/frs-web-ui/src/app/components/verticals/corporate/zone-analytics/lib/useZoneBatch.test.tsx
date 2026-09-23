import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// specs/0003-zone-analytics — Task 29 (AC 12.1, 12.5, 12.6): the batch hook. apiRequest is mocked,
// so this is a hook-level test, not a browser E2E test (no Playwright/Cypress harness exists).

const api = vi.hoisted(() => ({ handler: null as any }));
vi.mock('../../../../../contexts/AuthContext', () => ({ useAuth: () => ({ accessToken: 'fake-token', activeScope: null }) }));
vi.mock('../../../../../services/http/apiClient', () => ({ apiRequest: (path: string, o: unknown) => api.handler(path, o) }));

import { useZoneBatch, useZoneFilterLists, latestOf, ZONE_DEBOUNCE_MS } from './api';

interface Call { path: string; signal?: AbortSignal }
let calls: Call[];
let pending: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void; call: Call }>;

beforeEach(() => {
  calls = [];
  pending = [];
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  api.handler = (path: string, o: any) => new Promise((resolve, reject) => {
    const call = { path, signal: o?.signal as AbortSignal | undefined };
    calls.push(call);
    pending.push({ resolve, reject, call });
  });
});
afterEach(() => vi.useRealTimers());

const answer = async (i: number, body: unknown) => { await act(async () => { pending[i].resolve(body); }); };
const KEYS = ['a', 'b'] as const;

describe('useZoneBatch (AC 12.6)', () => {
  it('sends the FIRST request immediately (no debounce), to the batch path, and shows a skeleton state until it returns', async () => {
    const { result } = renderHook(() => useZoneBatch('overview', 'core', KEYS, 'fromDate=2026-09-21'));
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/zones/batch/overview/core?fromDate=2026-09-21');
    expect(result.current.loading).toBe(true);
    expect(result.current.results.a).toEqual({ data: null, error: null });
    await answer(0, { data: { a: [1], b: { x: 2 } }, errors: {}, computedAt: '2026-09-21T10:00:00.000Z' });
    expect(result.current.loading).toBe(false);
    expect(result.current.results.a.data).toEqual([1]);
    expect(result.current.computedAt?.toISOString()).toBe('2026-09-21T10:00:00.000Z');
  });

  it('per-widget isolation: a widget under errors shows its own error, the others keep their data', async () => {
    const { result } = renderHook(() => useZoneBatch('deep-dive', 'core', KEYS, 'q=1'));
    await answer(0, { data: { a: 'ok' }, errors: { b: 'Could not load this section' }, computedAt: '2026-09-21T10:00:00.000Z' });
    expect(result.current.results.a).toEqual({ data: 'ok', error: null });
    expect(result.current.results.b).toEqual({ data: null, error: 'Could not load this section' });
  });

  it('a request-level failure marks every widget with the message', async () => {
    const { result } = renderHook(() => useZoneBatch('overview', 'core', KEYS, 'q=1'));
    await act(async () => { pending[0].reject(new Error('Network down')); });
    expect(result.current.results.a.error).toBe('Network down');
    expect(result.current.results.b.error).toBe('Network down');
    expect(result.current.loading).toBe(false);
  });

  it('later param changes wait 400 ms after the LAST change, then send once', async () => {
    const { rerender } = renderHook(({ q }) => useZoneBatch('overview', 'core', KEYS, q), { initialProps: { q: 'p=1' } });
    await answer(0, { data: {}, errors: {}, computedAt: '2026-09-21T10:00:00.000Z' });
    rerender({ q: 'p=2' });
    await act(async () => { vi.advanceTimersByTime(ZONE_DEBOUNCE_MS - 100); });
    rerender({ q: 'p=3' });
    await act(async () => { vi.advanceTimersByTime(ZONE_DEBOUNCE_MS - 100); });
    expect(calls).toHaveLength(1); // still waiting: each change restarts the 400 ms wait
    await act(async () => { vi.advanceTimersByTime(101); });
    expect(calls).toHaveLength(2);
    expect(calls[1].path).toContain('p=3');
    expect(calls.some((c) => c.path.includes('p=2'))).toBe(false);
  });

  it('does not refetch when the effective params are unchanged (re-render, new array identity, same string)', async () => {
    const { rerender } = renderHook(({ q }) => useZoneBatch('overview', 'core', ['a', 'b'] as const, q), { initialProps: { q: 'p=1' } });
    await answer(0, { data: {}, errors: {}, computedAt: '2026-09-21T10:00:00.000Z' });
    rerender({ q: 'p=1' });
    rerender({ q: 'p=1' });
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(calls).toHaveLength(1);
  });

  it('aborts the superseded in-flight request and ignores its late answer', async () => {
    const { result, rerender } = renderHook(({ q }) => useZoneBatch('overview', 'core', KEYS, q), { initialProps: { q: 'p=1' } });
    expect(calls[0].signal!.aborted).toBe(false);
    rerender({ q: 'p=2' });
    expect(calls[0].signal!.aborted).toBe(true); // aborted as soon as the params change, before the debounce elapses
    await act(async () => { vi.advanceTimersByTime(ZONE_DEBOUNCE_MS + 1); });
    expect(calls).toHaveLength(2);
    await answer(1, { data: { a: 'new' }, errors: {}, computedAt: '2026-09-21T10:01:00.000Z' });
    await answer(0, { data: { a: 'stale' }, errors: {}, computedAt: '2026-09-21T10:00:00.000Z' }); // late answer of the aborted request
    expect(result.current.results.a.data).toBe('new');
  });

  it('aborts on unmount', () => {
    const { unmount } = renderHook(() => useZoneBatch('overview', 'core', KEYS, 'p=1'));
    unmount();
    expect(calls[0].signal!.aborted).toBe(true);
  });

  it('Refresh sends refresh=1 immediately (no debounce) and updates computedAt to the server value', async () => {
    const { result } = renderHook(() => useZoneBatch('overview', 'core', KEYS, 'p=1'));
    await answer(0, { data: {}, errors: {}, computedAt: '2026-09-21T10:00:00.000Z' });
    act(() => result.current.refresh());
    await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(0); });
    expect(calls).toHaveLength(2);
    expect(calls[1].path).toBe('/zones/batch/overview/core?p=1&refresh=1');
    await answer(1, { data: {}, errors: {}, computedAt: '2026-09-21T10:05:00.000Z' });
    expect(result.current.computedAt?.toISOString()).toBe('2026-09-21T10:05:00.000Z');
  });

  it('keeps showing the previous data while new params load (no flash to empty)', async () => {
    const { result, rerender } = renderHook(({ q }) => useZoneBatch('overview', 'core', KEYS, q), { initialProps: { q: 'p=1' } });
    await answer(0, { data: { a: 'first' }, errors: {}, computedAt: '2026-09-21T10:00:00.000Z' });
    rerender({ q: 'p=2' });
    expect(result.current.loading).toBe(true);
    expect(result.current.results.a.data).toBe('first');
  });

  it('a null query sends nothing (e.g. nobody expanded yet)', async () => {
    renderHook(() => useZoneBatch('movement', 'detail', ['movement'] as const, null));
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(calls).toHaveLength(0);
  });

  it('latestOf picks the newest computedAt and tolerates nulls', () => {
    expect(latestOf(null, null)).toBeNull();
    expect(latestOf(new Date(1000), null, new Date(5000))?.getTime()).toBe(5000);
  });
});

describe('useZoneFilterLists (AC 12.1, 12.4)', () => {
  it('loads zones, entry points, departments and cameras from ONE batch/filters request', async () => {
    const { result } = renderHook(() => useZoneFilterLists());
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toMatch(/^\/zones\/batch\/filters\?tz=/);
    await answer(0, { data: { zones: [{ zone: 'Lobby' }], entryPoints: [{ deviceId: 'C1' }], departments: [{ departmentId: 1 }], cameras: [{ cameraId: 'C1' }] }, errors: {}, computedAt: '2026-09-21T10:00:00.000Z' });
    expect(result.current.zones).toHaveLength(1);
    expect(result.current.cameras).toHaveLength(1);
    expect(result.current.entryPoints).toHaveLength(1);
    expect(result.current.departments).toHaveLength(1);
  });

  it('uses the client cache option (ttlMs 10 min) so the lists are fetched once per session', async () => {
    let options: any;
    api.handler = (_p: string, o: any) => { options = o; return new Promise(() => {}); };
    renderHook(() => useZoneFilterLists());
    expect(options.ttlMs).toBe(10 * 60 * 1000);
    expect(options.noCache).toBeUndefined();
  });
});
