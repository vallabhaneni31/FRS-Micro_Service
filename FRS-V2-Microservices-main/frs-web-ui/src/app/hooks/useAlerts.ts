import { useState, useEffect, useCallback, useRef } from 'react';
import { apiRequest } from '../services/http/apiClient';
import { realtimeEngine, RteEventType } from '../engine/RealTimeEngine';
import { useScopeHeaders } from './useScopeHeaders';

export interface Alert {
  pk_alert_id: number;
  title: string;
  message: string;
  severity: string;
  created_at: string;
  is_read: boolean;
  alert_type: string;
  fk_employee_id: number | null;
  fk_device_id: number | null;
  photo_url?: string | null;
}

export function useAlerts(pollMs = 60_000) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const headers = useScopeHeaders();
  const headersKey = JSON.stringify(headers);

  const fetch = useCallback(async () => {
    try {
      const res = await apiRequest<{ data: Alert[] }>('/live/alerts', {
        noCache: true,
        scopeHeaders: JSON.parse(headersKey)
      });
      if (res?.data) setAlerts(res.data);
    } catch {
      // silently ignore — alerts are non-critical
    }
  }, [headersKey]);

  // Optimistic mutators: update local state immediately so the panel feels
  // instant, fire the request in the background, and roll back on failure.
  // Callers await the returned promise only to know whether to show an error
  // toast — the UI has already updated by the time they get it.
  const markRead = useCallback(async (ids?: number[]) => {
    let previous: Alert[] = [];
    setAlerts((prev) => {
      previous = prev;
      return ids
        ? prev.map((a) => (ids.includes(a.pk_alert_id) ? { ...a, is_read: true } : a))
        : prev.map((a) => ({ ...a, is_read: true }));
    });
    try {
      await apiRequest('/live/alerts/mark-read', {
        method: 'POST',
        scopeHeaders: JSON.parse(headersKey),
        body: JSON.stringify(ids ? { ids } : {}),
      });
    } catch (err) {
      setAlerts(previous);
      throw err;
    }
  }, [headersKey]);

  const dismiss = useCallback(async (id: number) => {
    let previous: Alert[] = [];
    setAlerts((prev) => {
      previous = prev;
      return prev.filter((a) => a.pk_alert_id !== id);
    });
    try {
      await apiRequest(`/live/alerts/${id}`, {
        method: 'DELETE',
        scopeHeaders: JSON.parse(headersKey),
      });
    } catch (err) {
      setAlerts(previous);
      throw err;
    }
  }, [headersKey]);

  const dismissAll = useCallback(async () => {
    let previous: Alert[] = [];
    setAlerts((prev) => {
      previous = prev;
      return [];
    });
    try {
      await apiRequest('/live/alerts', {
        method: 'DELETE',
        scopeHeaders: JSON.parse(headersKey),
      });
    } catch (err) {
      setAlerts(previous);
      throw err;
    }
  }, [headersKey]);

  useEffect(() => {
    fetch();
    timerRef.current = setInterval(fetch, pollMs);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetch, pollMs]);

  // Refresh on RTE device alert, employee entry, or system alerts so badge stays current
  useEffect(() => {
    const unsub1 = realtimeEngine.subscribe(RteEventType.DEVICE_ALERT,  () => fetch());
    const unsub2 = realtimeEngine.subscribe(RteEventType.EMPLOYEE_ENTRY, () => fetch());
    const unsub3 = realtimeEngine.subscribe(RteEventType.SYSTEM_ALERT, () => fetch());
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [fetch]);

  const unreadCount = alerts.filter(a => !a.is_read).length;

  return { alerts, unreadCount, refresh: fetch, markRead, dismiss, dismissAll };
}
