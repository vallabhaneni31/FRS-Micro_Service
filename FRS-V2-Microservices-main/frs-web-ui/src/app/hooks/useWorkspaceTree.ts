import { useState, useEffect, useCallback, useRef } from 'react';
import { apiRequest } from '../services/http/apiClient';
import { useAuth } from '../contexts/AuthContext';
import { useScopeHeaders } from './useScopeHeaders';
import type { WorkspaceTreeNode } from '../components/shared/WorkspaceTree';

interface EmployeeTreeResponse {
  organization: { employeeCount: number };
  managers: Array<{
    id: string;
    name: string;
    code: string;
    direct_report_count: number;
  }>;
  unassignedCount: number;
}

interface WorkspaceTreeState {
  rootLabel: string;
  rootCount: number;
  nodes: WorkspaceTreeNode[];
  isLoading: boolean;
  error: string | null;
}

/**
 * Corporate: Organization -> Manager -> Direct reports, driven by the real
 * fk_manager_id/is_manager hierarchy (GET /api/employees/tree) — not a
 * department-head proxy. "Unassigned" groups employees with no manager set
 * who aren't themselves flagged as a manager.
 */
export function useCorporateWorkspaceTree() {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [state, setState] = useState<WorkspaceTreeState>({
    rootLabel: 'Organization', rootCount: 0, nodes: [], isLoading: false, error: null,
  });
  const isFetching = useRef(false);

  const fetchData = useCallback(async () => {
    if (isFetching.current) return;
    isFetching.current = true;
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const res = await apiRequest<EmployeeTreeResponse>('/employees/tree', {
        method: 'GET', accessToken, scopeHeaders,
      });
      const nodes: WorkspaceTreeNode[] = (res.managers || []).map((m) => ({
        id: m.id,
        label: m.name,
        sublabel: m.code,
        count: m.direct_report_count,
      }));
      if (res.unassignedCount > 0) {
        nodes.push({
          id: 'unassigned',
          label: 'Unassigned',
          sublabel: 'No manager set',
          count: res.unassignedCount,
        });
      }
      setState({
        rootLabel: 'Organization',
        rootCount: res.organization?.employeeCount ?? 0,
        nodes,
        isLoading: false,
        error: null,
      });
    } catch (err: any) {
      setState((prev) => ({ ...prev, isLoading: false, error: err.message || 'Failed to load hierarchy' }));
    } finally {
      isFetching.current = false;
    }
  }, [accessToken, scopeHeaders]);

  useEffect(() => { if (accessToken) fetchData(); }, [accessToken, fetchData]);

  return { ...state, refresh: fetchData };
}

interface StudentWorkspaceTreeResponse {
  school: { studentCount: number };
  classes: Array<{ class_label: string | null; section: string | null; student_count: number }>;
}

/**
 * Education: School -> Class (class_label + section grouping).
 * Intentionally labeled "Class", not "Teacher" — no teacher entity exists in
 * the schema yet (see plan doc, phase-2 note).
 */
export function useEducationWorkspaceTree() {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [state, setState] = useState<WorkspaceTreeState>({
    rootLabel: 'School', rootCount: 0, nodes: [], isLoading: false, error: null,
  });
  const isFetching = useRef(false);

  const fetchData = useCallback(async () => {
    if (isFetching.current) return;
    isFetching.current = true;
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const res = await apiRequest<StudentWorkspaceTreeResponse>('/students/workspace-tree', {
        method: 'GET', accessToken, scopeHeaders,
      });
      const nodes: WorkspaceTreeNode[] = (res.classes || []).map((c) => {
        const label = c.class_label ? (c.section ? `${c.class_label} - ${c.section}` : c.class_label) : 'Unassigned';
        return {
          id: `${c.class_label ?? 'unassigned'}::${c.section ?? ''}`,
          label,
          sublabel: `${c.student_count} student${c.student_count === 1 ? '' : 's'}`,
          count: c.student_count,
        };
      });
      setState({
        rootLabel: 'School',
        rootCount: res.school?.studentCount ?? 0,
        nodes,
        isLoading: false,
        error: null,
      });
    } catch (err: any) {
      setState((prev) => ({ ...prev, isLoading: false, error: err.message || 'Failed to load hierarchy' }));
    } finally {
      isFetching.current = false;
    }
  }, [accessToken, scopeHeaders]);

  useEffect(() => { if (accessToken) fetchData(); }, [accessToken, fetchData]);

  return { ...state, refresh: fetchData };
}
