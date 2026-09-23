import { useState, useEffect, useCallback, useRef } from 'react';
import { apiRequest } from '../services/http/apiClient';
import { useAuth } from '../contexts/AuthContext';
import { useScopeHeaders } from './useScopeHeaders';
import { authConfig } from '../config/authConfig';
import { realtimeEngine, RteEventType } from '../engine/RealTimeEngine';

export interface LiveEmployee {
  pk_employee_id: number;
  employee_code: string;
  full_name: string;
  email: string;
  position_title: string;
  location_label: string;
  join_date: string;
  status: 'active' | 'inactive';
  department_name: string;
  shift_type: string;
  shift_name?: string;
  profile_photo_url?: string | null;
  face_enrolled?: boolean;
  fk_department_id?: number;
  fk_shift_id?: number;
}

export interface LiveAttendanceRecord {
  pk_attendance_id: number;
  fk_employee_id: number;
  employee_code: string;
  full_name: string;
  attendance_date: string;
  check_in: string | null;
  check_out: string | null;
  status: 'present' | 'late' | 'absent' | 'on-break';
  working_hours: number;
  overtime_hours: number;
  is_late: boolean;
  device_id: string | null;
  location_label: string | null;
  recognition_accuracy: number | null;
  // Device-events derived counts (from backend liveRepository)
  check_in_count: number;
  check_out_count: number;
  all_check_ins: Array<{ time: string; photo_url: string | null }> | null;
  all_check_outs: Array<{ time: string; photo_url: string | null }> | null;
}

export interface LiveDevice {
  pk_device_id: number;
  external_device_id: string;
  name: string;
  location_label: string;
  ip_address: string;
  status: 'online' | 'offline' | 'error';
  recognition_accuracy: number;
  total_scans: number;
  error_rate: number;
  model: string;
  last_active: string;
  temperature_c?: number;
  gpu_percent?: number;
}

export interface LiveAlert {
  pk_alert_id: number;
  alert_type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  message: string;
  is_read: boolean;
  created_at: string;
  employee_code?: string;
  external_device_id?: string;
}

export interface DashboardMetrics {
  totalEmployees: number;
  presentToday: number;
  lateToday: number;
  absentToday: number;
  onBreak: number;
  avgWorkingHours: number;
  totalOvertimeHours: number;
  attendanceRate: number;
  punctualityRate: number;
}

export interface ApiDataState {
  employees: LiveEmployee[];
  attendance: LiveAttendanceRecord[];
  devices: LiveDevice[];
  alerts: LiveAlert[];
  metrics: DashboardMetrics | null;
  isLoading: boolean;
  error: string | null;
  lastRefreshed: Date | null;
}

// Global cache to prevent duplicate parallel requests
const cache: Record<string, { data: ApiDataState | null; ts: number; inflight: Promise<ApiDataState> | null }> = {};
const CACHE_TTL = 15000; // 20s — don't re-fetch if data is fresh

export function useApiData(options: { autoRefreshMs?: number } = {}) {
  const [departments, setDepartments] = useState<any[]>([]);
  const [shifts, setShifts] = useState<any[]>([]);
  const { accessToken, can, isAuthLoading, permissions, activeScope } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const { autoRefreshMs = 60000 } = options;
  const isMountedRef = useRef(true);
  const fetchCountRef = useRef(0);

  const cacheKey = JSON.stringify(scopeHeaders);
  if (!cache[cacheKey]) {
    cache[cacheKey] = { data: null, ts: 0, inflight: null };
  }

  const [state, setState] = useState<ApiDataState>(
    cache[cacheKey].data ?? {
      employees: [], attendance: [], devices: [], alerts: [],
      metrics: null, isLoading: true, error: null, lastRefreshed: null,
    }
  );

  const fetchAll = useCallback(async () => {
    const fetchId = ++fetchCountRef.current;
    const ts = new Date().toISOString();

    // ── RUNTIME INSTRUMENTATION: capture every decision point ──────────────────
    const runtimeSnapshot = {
      fetchId,
      ts,
      isAuthLoading,
      hasAccessToken: !!accessToken,
      permissionsCount: permissions?.length ?? 0,
      canAttendanceRead: can('attendance.read'),
      canEmployeesRead: can('employees.read'),
      activeScope: activeScope ? JSON.parse(JSON.stringify(activeScope)) : null,
      scopeHeaders: { ...scopeHeaders },
      cacheKey,
      cacheState: {
        exists: !!cache[cacheKey],
        hasData: !!(cache[cacheKey]?.data),
        attendanceCount: cache[cacheKey]?.data?.attendance?.length ?? 'N/A',
        employeeCount: cache[cacheKey]?.data?.employees?.length ?? 'N/A',
        ageMs: cache[cacheKey]?.ts ? Date.now() - cache[cacheKey].ts : 'N/A',
        hasInflight: !!cache[cacheKey]?.inflight,
      },
      allCacheKeys: Object.keys(cache),
    };

    console.group(`%c[FRS-RCA] fetchAll #${fetchId} @ ${ts}`, 'color:#6366f1;font-weight:bold');
    console.log('Auth state:', {
      isAuthLoading,
      hasToken: !!accessToken,
      permissions: permissions?.length ?? 0,
      activeScope,
      scopeHeaders,
    });
    console.log('Cache state:', runtimeSnapshot.cacheState);
    console.log('All cache keys:', runtimeSnapshot.allCacheKeys);
    // ── END INSTRUMENTATION ────────────────────────────────────────────────────

    if (authConfig.mode === 'mock' || !accessToken || isAuthLoading) {
      console.log(`%c[FRS-RCA] #${fetchId} → EARLY RETURN (isAuthLoading=${isAuthLoading}, hasToken=${!!accessToken})`, 'color:orange');
      console.groupEnd();
      if (!isAuthLoading) {
        setState(prev => ({ ...prev, isLoading: false }));
      }
      return;
    }

    const scopeCache = cache[cacheKey] || { data: null, ts: 0, inflight: null };

    // Captured once per fetchAll call and reused everywhere below. Evaluating
    // can(...) separately at the guard, the request-dispatch ternaries, and
    // the post-response cache decision let `permissions` change mid-flight
    // (e.g. right after a scope switch re-derives them), so a fetch could be
    // *dispatched* with attendance.read=true but *cached* under a since-changed
    // employees-only read — silently caching an empty attendance array as if
    // it were a confirmed "nobody's checked in" for the full 15s TTL.
    const canEmployeesRead  = can('employees.read');
    const canAttendanceRead = can('attendance.read');
    const canDevicesRead    = can('devices.read');
    const canAlertsRead     = can('alerts.read');

    // Invalidate stale empty cache if permissions were loaded after initial mount
    if (
      scopeCache.data &&
      ((scopeCache.data.employees.length === 0 && canEmployeesRead) ||
       (scopeCache.data.attendance.length === 0 && canAttendanceRead))
    ) {
      console.log(`%c[FRS-RCA] #${fetchId} → Invalidating empty cache for key: ${cacheKey}`, 'color:orange');
      scopeCache.data = null;
      scopeCache.ts = 0;
    }

    // Return cached data if fresh and populated
    if (scopeCache.data && Date.now() - scopeCache.ts < CACHE_TTL) {
      console.log(`%c[FRS-RCA] #${fetchId} → CACHE HIT — attendance: ${scopeCache.data.attendance.length}, employees: ${scopeCache.data.employees.length}`, 'color:green;font-weight:bold');
      console.groupEnd();
      if (isMountedRef.current) setState(scopeCache.data);
      return;
    }

    console.log(`%c[FRS-RCA] #${fetchId} → CACHE MISS — firing API requests`, 'color:blue;font-weight:bold');
    console.log(`  canAttendance: ${canAttendanceRead}, canEmployees: ${canEmployeesRead}`);
    console.log(`  scopeHeaders being sent:`, scopeHeaders);
    console.log(`  NOTE: If scopeHeaders is {}, the API request carries NO tenant/site scope`);

    // Deduplicate: if a fetch is already in flight, wait for it
    if (!scopeCache.inflight) {
      const requestTs = Date.now();
      scopeCache.inflight = (async (): Promise<ApiDataState> => {
        const opts = { accessToken, scopeHeaders };
        const [empR, attR, devR, alrR, metR] = await Promise.allSettled([
          canEmployeesRead  ? apiRequest<{ data: LiveEmployee[] }>('/live/employees', opts) : Promise.resolve({ data: [] }),
          canAttendanceRead ? apiRequest<{ data: LiveAttendanceRecord[] }>('/live/attendance?limit=500', opts) : Promise.resolve({ data: [] }),
          canDevicesRead    ? apiRequest<{ data: LiveDevice[] }>('/live/devices', opts) : Promise.resolve({ data: [] }),
          canAlertsRead     ? apiRequest<{ data: LiveAlert[] }>('/live/alerts', opts) : Promise.resolve({ data: [] }),
          canAttendanceRead ? apiRequest<DashboardMetrics>('/live/metrics', opts) : Promise.resolve(null),
        ]);
        const get = <T>(r: PromiseSettledResult<any>, fallback: T): T =>
          r.status === 'fulfilled' ? r.value : fallback;

        let errorMsg: string | null = null;
        if (canAttendanceRead && attR.status === 'rejected') {
          const reason = (attR as PromiseRejectedResult).reason;
          errorMsg = reason?.message || 'Unable to load attendance data';
        } else if (canEmployeesRead && empR.status === 'rejected') {
          const reason = (empR as PromiseRejectedResult).reason;
          errorMsg = reason?.message || 'Unable to load employee data';
        }

        const newState: ApiDataState = {
          employees:  get(empR, { data: [] }).data ?? [],
          attendance: get(attR, { data: [] }).data ?? [],
          devices:    get(devR, { data: [] }).data ?? [],
          alerts:     get(alrR, { data: [] }).data ?? [],
          metrics:    get(metR, null),
          isLoading:  false,
          error:      errorMsg,
          lastRefreshed: new Date(),
        };

        const elapsed = Date.now() - requestTs;
        console.log(`%c[FRS-RCA] #${fetchId} → Response received (${elapsed}ms):`, 'color:blue');
        console.log(`  attendance: ${newState.attendance.length} records`);
        console.log(`  employees:  ${newState.employees.length} records`);
        console.log(`  canEmployeesRead: ${canEmployeesRead}, canAttendanceRead: ${canAttendanceRead}, cacheKey at response time: ${cacheKey}`);
        console.log(`  Storing in cache under key: "${cacheKey}"`);

        // Only store in global cache if we got real data or permissions were present
        if (newState.employees.length > 0 || newState.attendance.length > 0 || canEmployeesRead || canAttendanceRead) {
          // ── RUNTIME INSTRUMENTATION: flag zero-attendance cache store ──────────
          if (newState.attendance.length === 0 && canAttendanceRead) {
            console.warn(`%c[FRS-RCA] ⚠️ STORING EMPTY ATTENDANCE under cacheKey="${cacheKey}" — attendance.read was true and the API genuinely returned 0 rows (this is a legitimate zero, not the permission race)`, 'color:red;font-weight:bold;font-size:14px');
            console.warn(`  scopeHeaders were: ${JSON.stringify(scopeHeaders)}`);
            console.warn(`  activeScope was: ${JSON.stringify(activeScope)}`);
            console.trace('[FRS-RCA] Stack trace for empty cache store');
          }
          // ── END INSTRUMENTATION ────────────────────────────────────────────────
          scopeCache.data = newState;
          scopeCache.ts   = Date.now();
        }
        scopeCache.inflight = null;
        return newState;
      })().catch(err => {
        scopeCache.inflight = null;
        throw err;
      });
    } else {
      console.log(`%c[FRS-RCA] #${fetchId} → Joining existing in-flight request`, 'color:gray');
    }

    try {
      if (!scopeCache.data) {
        setState(prev => ({ ...prev, isLoading: true }));
      }
      const newState = await scopeCache.inflight!;
      console.log(`%c[FRS-RCA] #${fetchId} → Rendering state: attendance=${newState.attendance.length}, employees=${newState.employees.length}`, 'color:green');
      console.groupEnd();
      if (isMountedRef.current) setState(newState);
    } catch (err) {
      console.error(`[FRS-RCA] #${fetchId} → fetchAll error:`, err);
      console.groupEnd();
      if (isMountedRef.current) {
        setState(prev => ({
          ...prev, isLoading: false,
          error: err instanceof Error ? err.message : 'Failed to fetch',
        }));
      }
    }
  }, [accessToken, isAuthLoading, permissions, cacheKey, scopeHeaders, can, activeScope]);

  useEffect(() => {
    isMountedRef.current = true;
    fetchAll();
    return () => { isMountedRef.current = false; };
  }, [fetchAll]);

  useEffect(() => {
    const handleAttendanceEvent = (payload: any) => {
      if (!payload) return;
      const empId = payload.employeeId || payload.fk_employee_id;
      const empCode = payload.employeeCode || payload.employee_code || payload.employeeId;
      const direction = (payload.type || payload.direction || 'in').toLowerCase();
      const ts = payload.timestamp || new Date().toISOString();

      setState(prev => {
        let found = false;
        const nextAttendance = prev.attendance.map(rec => {
          if (
            (empId && (rec.fk_employee_id === Number(empId) || rec.employee_code === String(empId))) ||
            (empCode && rec.employee_code === empCode)
          ) {
            found = true;
            const updatedRec = { ...rec };
            if (direction === 'out' || direction === 'exit') {
              updatedRec.check_out = ts;
              updatedRec.check_out_count = (updatedRec.check_out_count || 0) + 1;
            } else {
              updatedRec.check_in = updatedRec.check_in || ts;
              updatedRec.status = rec.status === 'absent' ? 'present' : rec.status;
              updatedRec.check_in_count = (updatedRec.check_in_count || 0) + 1;
            }
            return updatedRec;
          }
          return rec;
        });

        if (!found && (empId || empCode)) {
          const newRecord: LiveAttendanceRecord = {
            pk_attendance_id: Date.now(),
            fk_employee_id: Number(empId) || 0,
            employee_code: String(empCode || ''),
            full_name: payload.employeeName || payload.fullName || 'Employee',
            attendance_date: ts.slice(0, 10),
            check_in: (direction === 'out' || direction === 'exit') ? null : ts,
            check_out: (direction === 'out' || direction === 'exit') ? ts : null,
            status: (direction === 'out' || direction === 'exit') ? 'absent' : 'present',
            working_hours: 0,
            overtime_hours: 0,
            is_late: false,
            device_id: payload.deviceId || payload.cameraId || null,
            location_label: payload.location || payload.cameraName || null,
            recognition_accuracy: payload.confidence || 0.95,
            check_in_count: (direction === 'out' || direction === 'exit') ? 0 : 1,
            check_out_count: (direction === 'out' || direction === 'exit') ? 1 : 0,
            all_check_ins: (direction === 'out' || direction === 'exit') ? [] : [{ time: ts, photo_url: payload.photoUrl || null }],
            all_check_outs: (direction === 'out' || direction === 'exit') ? [{ time: ts, photo_url: payload.photoUrl || null }] : [],
          };
          nextAttendance.unshift(newRecord);
        }

        const nextMetrics = prev.metrics ? { ...prev.metrics } : null;
        if (nextMetrics && !found && direction !== 'out' && direction !== 'exit') {
          nextMetrics.presentToday += 1;
          if (nextMetrics.absentToday > 0) nextMetrics.absentToday -= 1;
        }

        const nextDataState: ApiDataState = {
          ...prev,
          attendance: nextAttendance,
          metrics: nextMetrics,
          lastRefreshed: new Date(),
        };

        const scopeCache = cache[cacheKey];
        if (scopeCache) {
          scopeCache.data = nextDataState;
          scopeCache.ts = Date.now();
        }

        return nextDataState;
      });
    };

    const unsubEntry = realtimeEngine.subscribe(RteEventType.EMPLOYEE_ENTRY, handleAttendanceEvent);
    const unsubExit = realtimeEngine.subscribe(RteEventType.EMPLOYEE_EXIT, handleAttendanceEvent);

    const attachSocket = () => {
      const socket = (realtimeEngine as any).socket;
      if (socket) {
        socket.off('attendance.update', handleAttendanceEvent);
        socket.on('attendance.update', handleAttendanceEvent);
      }
    };

    attachSocket();
    const timer = setInterval(attachSocket, 2000);

    return () => {
      unsubEntry();
      unsubExit();
      clearInterval(timer);
      const socket = (realtimeEngine as any).socket;
      if (socket) {
        socket.off('attendance.update', handleAttendanceEvent);
      }
    };
  }, [cacheKey]);

  useEffect(() => {
    if (autoRefreshMs > 0) {
      const t = setInterval(fetchAll, autoRefreshMs);
      return () => clearInterval(t);
    }
  }, [fetchAll, autoRefreshMs]);

  return {
    departments,
    shifts,
    ...state,
    refresh: () => {
      if (cache[cacheKey]) {
        cache[cacheKey].ts = 0;
        cache[cacheKey].data = null;
      }
      fetchAll();
    },
  };
}
