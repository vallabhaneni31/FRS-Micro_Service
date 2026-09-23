import { useState, useEffect, useCallback, useRef } from 'react';
import { apiRequest } from '../services/http/apiClient';
import { useAuth } from '../contexts/AuthContext';
import { useScopeHeaders } from './useScopeHeaders';

export interface Department {
  pk_department_id: string;
  name: string;
  code: string;
  color: string;
  description: string | null;
  head_employee_id: string | null;
  head_employee_name: string | null;
  employee_count: number;
}

export interface Shift {
  pk_shift_id: string;
  name: string;
  shift_type: 'morning' | 'afternoon' | 'evening' | 'night' | 'flexible' | 'fixed' | 'rotational' | 'custom';
  start_time: string | null;
  end_time: string | null;
  grace_period_minutes: number;
  is_flexible: boolean;
  break_duration_minutes: number;
  work_days: string[];
}

interface HookState {
  departments: Department[];
  shifts: Shift[];
  isLoading: boolean;
  error: string | null;
  lastFetched: number | null;
}

const CACHE_DURATION_MS = 5 * 60 * 1000;

export function useDepartmentsAndShifts() {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [state, setState] = useState<HookState>({
    departments: [],
    shifts: [],
    isLoading: false,
    error: null,
    lastFetched: null,
  });

  const isFetching = useRef(false);

  const fetchData = useCallback(async (force = false) => {
    if (!force && state.lastFetched && Date.now() - state.lastFetched < CACHE_DURATION_MS) {
      return;
    }

    if (isFetching.current) return;
    isFetching.current = true;

    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      const [deptRes, shiftRes] = await Promise.all([
        apiRequest<{ data: Department[] }>('/live/departments', {
          method: 'GET',
          accessToken,
          scopeHeaders,
        }),
        apiRequest<{ data: Shift[] }>('/live/shifts', {
          method: 'GET',
          accessToken,
          scopeHeaders,
        }),
      ]);

      setState({
        departments: deptRes.data || [],
        shifts: shiftRes.data || [],
        isLoading: false,
        error: null,
        lastFetched: Date.now(),
      });
    } catch (err: any) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: err.message || 'Failed to sync organization data',
      }));
    } finally {
      isFetching.current = false;
    }
  }, [accessToken, state.lastFetched]);

  useEffect(() => {
    if (accessToken) {
      fetchData();
    }
  }, [accessToken, fetchData]);

  return {
    departments: state.departments,
    shifts: state.shifts,
    isLoading: state.isLoading,
    error: state.error,
    refresh: () => fetchData(true),
  };
}
