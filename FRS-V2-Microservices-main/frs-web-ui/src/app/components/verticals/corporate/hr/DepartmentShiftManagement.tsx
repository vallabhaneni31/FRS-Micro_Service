import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '../../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { apiRequest } from '../../../../services/http/apiClient';
import { toast } from 'sonner';
import { ConfirmModal } from '../../../ui/confirm-modal';
import { cn } from '../../../ui/utils';
import { lightTheme } from '../../../../../theme/lightTheme';
import { PageHeader } from '../../../shared/PageHeader';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../ui/alert-dialog';
import { MetricCard } from '../../../shared/MetricCard';
import { RosterTab } from './RosterTab';
import {
  ChevronDown, ChevronRight, Users, Clock, UserCheck, UserX,
  AlertTriangle, Plus, RefreshCw, Building2, Calendar, Edit2,
  Trash2, X, UserPlus, Save, Palette, Loader2
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────
interface Dept { id: string; name: string; code: string; color: string; description: string | null; head_employee_id: string | null; head_employee_name: string | null; employee_count: number; }
interface Shift { id: string; name: string; shift_type: string; start_time: string | null; end_time: string | null; grace_period_minutes: number; is_flexible: boolean; break_duration_minutes: number; work_days: string[]; employee_count: number; }
interface Employee { pk_employee_id: string; full_name: string; employee_code: string; fk_department_id: string | null; fk_shift_id: string | null; department_name: string; shift_name?: string; }
interface AnalyticsRow { dept_id: string; department: string; code: string; color: string; shift_id: string; shift_name: string; shift_type: string; start_time: string | null; end_time: string | null; grace_period_minutes: number; pk_employee_id: string; full_name: string; employee_code: string; check_in_local: string | null; check_out_local: string | null; is_late: boolean | null; duration_minutes: number | null; today_status: 'present' | 'absent'; }

const DEPT_COLORS = ['#3B82F6','#EC4899','#8B5CF6','#10B981','#F59E0B','#EF4444','#06B6D4','#84CC16','#F97316','#6366F1'];
const SHIFT_TYPES = ['morning','afternoon','evening','night','flexible','fixed','rotational','custom'];
const WORK_DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

const fmt12 = (t: string | null) => {
  if (!t) return '—';
  const [h, m] = t.split(':').map(Number);
  return `${h%12||12}:${String(m).padStart(2,'0')} ${h>=12?'PM':'AM'}`;
};
const shiftColor = (type: string) => {
  const map: Record<string,string> = {
    morning:'text-amber-600 bg-amber-50 border-amber-200',
    afternoon:'text-orange-600 bg-orange-50 border-orange-200',
    evening:'text-blue-600 bg-blue-50 border-blue-200',
    night:'text-indigo-600 bg-indigo-50 border-indigo-200',
    flexible:'text-slate-600 bg-slate-50 border-slate-200',
    fixed:'text-violet-600 bg-violet-50 border-violet-200',
    rotational:'text-teal-600 bg-teal-50 border-teal-200',
    custom:'text-pink-600 bg-pink-50 border-pink-200',
  };
  return map[type] || map.flexible;
};
const statusDot = (status: string, isLate: boolean | null) => status === 'present' ? (isLate ? 'bg-amber-400' : 'bg-emerald-400') : 'bg-slate-200 dark:bg-slate-600';

// ─── Modal ───────────────────────────────────────────────────────────────────
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="glass-card rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-md mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <h3 className="font-bold text-slate-900 dark:text-white">{title}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"><X className="w-4 h-4 text-slate-500" /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

// ─── Assign Modal ─────────────────────────────────────────────────────────────
// ─── Assign Modal ─────────────────────────────────────────────────────────────
function AssignModal({ title, employees, currentIds, onAssign, onClose }: { title: string; employees: Employee[]; currentIds: string[]; onAssign: (ids: string[]) => void; onClose: () => void; }) {
  const [selected, setSelected] = useState<Set<string>>(new Set(currentIds));
  const [searchTerm, setSearchTerm] = useState('');
  const toggle = (id: string) => setSelected(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  const filteredEmployees = useMemo(() => {
    if (!searchTerm.trim()) return employees;
    const q = searchTerm.toLowerCase();
    return employees.filter(e =>
      e.full_name.toLowerCase().includes(q) ||
      e.employee_code.toLowerCase().includes(q) ||
      (e.department_name && e.department_name.toLowerCase().includes(q))
    );
  }, [employees, searchTerm]);

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3">
        {/* Search */}
        <div className="relative">
          <input
            type="text"
            placeholder="Search employee..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="w-full px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 glass-card text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="flex items-center justify-between text-xs text-slate-500 px-1">
          <span>{selected.size} of {employees.length} selected</span>
        </div>

        {/* Employee List */}
        <div className="space-y-1 max-h-64 overflow-y-auto border border-slate-200 dark:border-slate-700 rounded-xl p-2">
          {filteredEmployees.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-4">No matching employees found</p>
          ) : (
            filteredEmployees.map(e => {
              const idStr = String(e.pk_employee_id);
              const isChecked = selected.has(idStr);
              return (
                <label key={idStr} className={cn("flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors", isChecked ? "bg-blue-50/70 dark:bg-blue-900/20" : "hover:bg-slate-50 dark:hover:bg-slate-800")}>
                  <input type="checkbox" checked={isChecked} onChange={() => toggle(idStr)} className="rounded text-blue-600 focus:ring-blue-500" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-900 dark:text-white truncate">{e.full_name}</p>
                    <p className="text-xs text-slate-400 truncate">{e.employee_code} · {e.department_name || 'No Dept'}</p>
                  </div>
                </label>
              );
            })
          )}
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 pt-2">
          <button
            onClick={() => onAssign(Array.from(selected))}
            disabled={selected.size === 0}
            className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            Save Assignment ({selected.size} employee{selected.size !== 1 ? 's' : ''})
          </button>
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors">Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Unassign Modal ───────────────────────────────────────────────────────────
function UnassignModal({ title, assignedEmployees, onUnassign, onClose }: { title: string; assignedEmployees: Employee[]; onUnassign: (empIdsToUnassign: string[]) => void; onClose: () => void; }) {
  const [selected, setSelected] = useState<Set<string>>(new Set(assignedEmployees.map(e => String(e.pk_employee_id))));
  const [searchTerm, setSearchTerm] = useState('');
  const toggle = (id: string) => setSelected(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  const filtered = useMemo(() => {
    if (!searchTerm.trim()) return assignedEmployees;
    const q = searchTerm.toLowerCase();
    return assignedEmployees.filter(e =>
      e.full_name.toLowerCase().includes(q) ||
      e.employee_code.toLowerCase().includes(q)
    );
  }, [assignedEmployees, searchTerm]);

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3">
        {assignedEmployees.length === 0 ? (
          <p className="text-xs text-slate-500 py-6 text-center">No employees are currently assigned.</p>
        ) : (
          <>
            <div className="relative">
              <input
                type="text"
                placeholder="Search assigned employees..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="w-full px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 glass-card text-xs focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
            </div>
            <div className="flex items-center justify-between text-xs text-slate-500 px-1">
              <span>{selected.size} of {assignedEmployees.length} selected to unassign</span>
            </div>

            <div className="space-y-1 max-h-64 overflow-y-auto border border-slate-200 dark:border-slate-700 rounded-xl p-2">
              {filtered.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-4">No matching employees found</p>
              ) : (
                filtered.map(e => {
                  const idStr = String(e.pk_employee_id);
                  const isChecked = selected.has(idStr);
                  return (
                    <label key={idStr} className={cn("flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors", isChecked ? "bg-amber-50/70 dark:bg-amber-900/20" : "hover:bg-slate-50 dark:hover:bg-slate-800")}>
                      <input type="checkbox" checked={isChecked} onChange={() => toggle(idStr)} className="rounded text-amber-600 focus:ring-amber-500" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-900 dark:text-white truncate">{e.full_name}</p>
                        <p className="text-xs text-slate-400 truncate">{e.employee_code} · {e.department_name || 'No Dept'}</p>
                      </div>
                    </label>
                  );
                })
              )}
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={() => onUnassign(Array.from(selected))}
                disabled={selected.size === 0}
                className="flex-1 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-sm font-semibold py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                <UserX className="w-4 h-4" />
                Unassign {selected.size} Employee{selected.size !== 1 ? 's' : ''}
              </button>
              <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors">Cancel</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// ─── Assign Unassigned Shift Modal ───────────────────────────────────────────
function AssignUnassignedShiftModal({
  shifts,
  empIdsToAssign,
  employees,
  onAssign,
  onClose
}: {
  shifts: Shift[];
  empIdsToAssign: string[];
  employees: Employee[];
  onAssign: (targetShiftId: string, empIds: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [targetShiftId, setTargetShiftId] = useState<string>(shifts[0]?.id || '');
  const [selected, setSelected] = useState<Set<string>>(new Set(empIdsToAssign));
  const [submitting, setSubmitting] = useState(false);

  const toggle = (id: string) => setSelected(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  const targetEmps = employees.filter(e => empIdsToAssign.includes(String(e.pk_employee_id)));

  const handleAssign = async () => {
    if (!targetShiftId) {
      toast.error('Please select a shift to assign.');
      return;
    }
    if (selected.size === 0) {
      toast.error('Please select at least one employee.');
      return;
    }
    setSubmitting(true);
    await onAssign(targetShiftId, Array.from(selected));
    setSubmitting(false);
  };

  return (
    <Modal title="Assign Shift to Employees" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wide">Target Shift *</label>
          <select value={targetShiftId} onChange={e => setTargetShiftId(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 glass-card text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            {shifts.map(s => <option key={s.id} value={s.id}>{s.name} ({fmt12(s.start_time)} – {fmt12(s.end_time)})</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wide">Select Employees ({selected.size} selected)</label>
          <div className="space-y-1.5 max-h-56 overflow-y-auto mt-1 border border-slate-200 dark:border-slate-700 rounded-lg p-2">
            {targetEmps.map(e => (
              <label key={e.pk_employee_id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer">
                <input type="checkbox" checked={selected.has(String(e.pk_employee_id))} onChange={() => toggle(String(e.pk_employee_id))} className="rounded" />
                <div>
                  <p className="text-sm font-medium text-slate-900 dark:text-white">{e.full_name}</p>
                  <p className="text-xs text-slate-400">{e.employee_code} · {e.department_name || 'No Dept'}</p>
                </div>
              </label>
            ))}
          </div>
        </div>
        <div className="flex gap-2 pt-2">
          <button onClick={handleAssign} disabled={submitting || !shifts.length} className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm font-semibold py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2">
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
            {submitting ? 'Assigning...' : `Assign to Selected Shift`}
          </button>
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors">Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export function DepartmentShiftManagement() {
  const { accessToken , isAuthenticated } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [activeTab, setActiveTab] = useState<'departments'|'shifts'|'roster'>('departments');
  const [depts, setDepts] = useState<Dept[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [expandedDepts, setExpandedDepts] = useState<Set<string>>(new Set());
  const [expandedShifts, setExpandedShifts] = useState<Set<string>>(new Set());

  // Modals
  const [deptModal, setDeptModal] = useState<{ mode: 'add'|'edit'; data?: Dept } | null>(null);
  const [shiftModal, setShiftModal] = useState<{ mode: 'add'|'edit'; data?: Shift } | null>(null);
  const [assignDeptModal, setAssignDeptModal] = useState<Dept | null>(null);
  const [unassignDeptModal, setUnassignDeptModal] = useState<Dept | null>(null);
  const [assignShiftModal, setAssignShiftModal] = useState<Shift | null>(null);
  const [unassignShiftModal, setUnassignShiftModal] = useState<Shift | null>(null);
  const [assignUnassignedModal, setAssignUnassignedModal] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    isDestructive?: boolean;
    confirmText?: string;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {}
  });

  const confirmAction = (title: string, message: string, onConfirm: () => void, isDestructive = true, confirmText = 'Confirm') => {
    setConfirmDialog({
      isOpen: true,
      title,
      message,
      onConfirm: () => {
        setConfirmDialog(prev => ({ ...prev, isOpen: false }));
        onConfirm();
      },
      isDestructive,
      confirmText
    });
  };

  // Forms
  const emptyDept = { name:'', code:'', color: DEPT_COLORS[0], description: '' };
  const emptyShift = { name:'', shift_type:'morning', start_time:'09:00', end_time:'18:00', grace_period_minutes:10, is_flexible:false, break_duration_minutes:0, work_days:['Mon','Tue','Wed','Thu','Fri'] };
  const [deptForm, setDeptForm] = useState(emptyDept);
  const [shiftForm, setShiftForm] = useState(emptyShift);
  const [graceError, setGraceError] = useState(false);
  const [breakError, setBreakError] = useState(false);

  const opts = useCallback(() => ({ accessToken, scopeHeaders }), [accessToken]);

  const fetchAll = useCallback(async () => {
    if (!isAuthenticated) return;
    setLoading(true);
    try {
      const [deptsRes, shiftsRes, empsRes, analyticsRes] = await Promise.allSettled([
        apiRequest<{ data: Dept[] }>('/hr/departments', opts()),
        apiRequest<{ data: Shift[] }>('/hr/shifts', opts()),
        apiRequest<{ data: Employee[] }>('/live/employees', opts()),
        apiRequest<{ data: AnalyticsRow[] }>('/live/dept-shift-analytics', opts()),
      ]);
      if (deptsRes.status === 'fulfilled') setDepts(deptsRes.value.data);
      if (shiftsRes.status === 'fulfilled') setShifts(shiftsRes.value.data);
      if (empsRes.status === 'fulfilled') setEmployees(empsRes.value.data as any);
      if (analyticsRes.status === 'fulfilled') setAnalytics(analyticsRes.value.data);
      setLastRefreshed(new Date());
    } catch {}
    setLoading(false);
  }, [accessToken]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── Dept CRUD ──────────────────────────────────────────────────────────────
  const saveDept = async () => {
    let formattedName = deptForm.name;
    
    if (!formattedName.trim()) {
      setFormError('Department Name is required.');
      return;
    }
    if (formattedName.startsWith(' ')) {
      setFormError('Department Name cannot start with a space.');
      return;
    }
    if (/\s{2,}/.test(formattedName)) {
      setFormError('Consecutive spaces are not allowed.');
      return;
    }
    if (/-{2,}/.test(formattedName)) {
      setFormError('Consecutive hyphens (--) are not allowed.');
      return;
    }
    if (/[^a-zA-Z0-9\s-]/.test(formattedName)) {
      setFormError('Only letters, numbers, spaces, and hyphens are allowed.');
      return;
    }
    if (formattedName.length < 2 || formattedName.length > 30) {
      setFormError('Department Name must be between 2 and 30 characters.');
      return;
    }
    if (/^\d+$/.test(formattedName)) {
      setFormError('Department Name cannot be purely numeric.');
      return;
    }

    formattedName = formattedName.trim().split(' ').map(word => word ? word.charAt(0).toUpperCase() + word.slice(1) : '').join(' ');

    const code = deptForm.code;
    if (!code) {
      setFormError('Department Code is required.');
      return;
    }
    if (code.startsWith(' ')) {
      setFormError('Department Code cannot start with a space.');
      return;
    }
    if (/\s/.test(code)) {
      setFormError('Spaces are not allowed in Department Code.');
      return;
    }
    if (/-{2,}/.test(code)) {
      setFormError('Consecutive hyphens (--) are not allowed.');
      return;
    }
    if (/[^A-Z0-9-]/.test(code)) {
      setFormError('Only letters, numbers, and hyphens are allowed in Code.');
      return;
    }
    if (code.length < 2 || code.length > 10) {
      setFormError('Code must be between 2 and 10 characters long.');
      return;
    }
    const payload = { ...deptForm, name: formattedName, code: code };

    setSaving(true); setFormError(null);
    try {
      const method = deptModal?.mode === 'edit' ? 'PUT' : 'POST';
      const path = deptModal?.mode === 'edit' ? `/hr/departments/${deptModal.data!.id}` : '/hr/departments';
      await apiRequest(path, { ...opts(), method, body: JSON.stringify(payload) });
      toast.success(deptModal?.mode === 'edit' ? 'Department updated successfully.' : 'Department added successfully.');
      setDeptModal(null); setDeptForm(emptyDept); fetchAll();
    } catch (err: any) {
      setFormError(err?.message || 'Failed to save department');
    } finally { setSaving(false); }
  };
  const [confirmConfig, setConfirmConfig] = useState<{
    title: string;
    description?: string;
    confirmText?: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  const deleteDept = async (id: string, force = false) => {
    if (!id || id === 'null' || !/^\d+$/.test(String(id))) {
      toast.error('Cannot delete unassigned department group.');
      return;
    }

    if (force) {
      try {
        await apiRequest(`/hr/departments/${id}?force=true`, { ...opts(), method: 'DELETE' });
        toast.success('Department force-deleted successfully.');
        fetchAll();
      } catch (err: any) {
        toast.error(err?.message || 'Failed to force-delete department');
      }
      return;
    }

    setConfirmConfig({
      title: 'Delete this department?',
      description: 'This will remove the department definition.',
      confirmText: 'Delete Department',
      onConfirm: async () => {
        try {
          await apiRequest(`/hr/departments/${id}`, { ...opts(), method: 'DELETE' });
          toast.success('Department deleted successfully.');
          fetchAll();
        } catch (err: any) {
          if (err?.status === 409 || err?.message?.includes('active employee')) {
            const msg = err?.message || 'This department has active employees assigned.';
            setTimeout(() => {
              setConfirmConfig({
                title: msg,
                description: 'Force-delete and unassign active employees?',
                confirmText: 'Force Delete',
                onConfirm: () => deleteDept(id, true),
              });
            }, 100);
          } else {
            toast.error(err?.message || 'Failed to delete department');
          }
        }
      },
    });
  };
  const assignDept = async (newEmpIds: string[]) => {
    if (!assignDeptModal) return;
    const existingIds = (employees as any[])
      .filter((e: any) => String(e.fk_department_id) === assignDeptModal.id)
      .map((e: any) => String(e.pk_employee_id));
    const combinedIds = Array.from(new Set([...existingIds, ...newEmpIds])).map(Number);
    try {
      await apiRequest(`/hr/departments/${assignDeptModal.id}/assign`, { ...opts(), method: 'POST', body: JSON.stringify({ employee_ids: combinedIds }) });
      toast.success('Employees assigned successfully');
      setAssignDeptModal(null); fetchAll();
    } catch (err: any) { toast.error(err?.message || 'Failed to assign employees'); }
  };
  const unassignDept = async (empIdsToUnassign: string[]) => {
    if (!unassignDeptModal) return;
    const currentDeptEmpIds = (employees as any[])
      .filter((e: any) => String(e.fk_department_id) === unassignDeptModal.id)
      .map((e: any) => String(e.pk_employee_id));
    const remainingEmpIds = currentDeptEmpIds.filter(id => !empIdsToUnassign.includes(id));
    try {
      await apiRequest(`/hr/departments/${unassignDeptModal.id}/assign`, { ...opts(), method: 'POST', body: JSON.stringify({ employee_ids: remainingEmpIds.map(Number) }) });
      toast.success('Employees unassigned successfully');
      setUnassignDeptModal(null); fetchAll();
    } catch (err: any) { toast.error(err?.message || 'Failed to unassign employees'); }
  };
  const unassignEmployeeDept = async (deptId: string, empId: string, empName: string, deptName: string) => {
    confirmAction(
      `Unassign ${empName}?`,
      `Are you sure you want to unassign ${empName} from ${deptName}?`,
      async () => {
        try {
          await apiRequest(`/employees/${empId}`, {
            ...opts(),
            method: 'PUT',
            body: JSON.stringify({ fk_department_id: null })
          });
          toast.success(`${empName} unassigned from ${deptName}.`);
          fetchAll();
        } catch (err: any) {
          toast.error(err?.message || 'Failed to unassign employee.');
        }
      },
      false,
      'Unassign'
    );
  };

  // ── Shift CRUD ─────────────────────────────────────────────────────────────
  const saveShift = async () => {
    if (!shiftForm.name || !shiftForm.name.trim()) {
      setFormError('Shift Name is required.');
      return;
    }
    if (/(^\s|\s$|\s{2,})/.test(shiftForm.name)) {
      setFormError('Shift Name cannot contain leading, trailing, or consecutive spaces.');
      return;
    }
    if (!/[a-zA-Z]/.test(shiftForm.name)) {
      setFormError('Shift Name cannot be purely numeric. It must contain at least one letter.');
      return;
    }
    const formattedShiftName = shiftForm.name.trim().replace(/\s+/g, ' ').split(' ').map(word => word ? word.charAt(0).toUpperCase() + word.slice(1) : '').join(' ');
    if (formattedShiftName.length > 25) {
      setFormError('Shift Name must be 25 characters or less.');
      return;
    }
    if (!shiftForm.is_flexible) {
      if (!shiftForm.start_time || !shiftForm.end_time) {
        setFormError('Start time and End time are required for fixed shifts.');
        return;
      }
      if (shiftForm.start_time === shiftForm.end_time) {
        setFormError('Start time and End time cannot be the same.');
        return;
      }
    }
    if (shiftForm.work_days.length === 0) {
      setFormError('Please select at least one work day.');
      return;
    }
    if (shiftForm.grace_period_minutes > 60 || shiftForm.break_duration_minutes > 120) {
      setFormError('Please fix the validation errors before saving.');
      return;
    }
    const payload = { ...shiftForm, name: formattedShiftName };

    setSaving(true); setFormError(null);
    try {
      const method = shiftModal?.mode === 'edit' ? 'PUT' : 'POST';
      const path = shiftModal?.mode === 'edit' ? `/hr/shifts/${shiftModal.data!.id}` : '/hr/shifts';
      await apiRequest(path, { ...opts(), method, body: JSON.stringify(payload) });
      toast.success(shiftModal?.mode === 'edit' ? 'Shift updated successfully.' : 'Shift added successfully.');
      setShiftModal(null); setShiftForm(emptyShift as any); fetchAll();
    } catch (err: any) {
      setFormError(err?.message || 'Failed to save shift');
    } finally { setSaving(false); }
  };
  const deleteShift = async (id: string) => {
    if (!id || id === 'null' || !/^\d+$/.test(String(id))) {
      toast.error('Cannot delete unassigned shift group.');
      return;
    }
    setConfirmConfig({
      title: 'Delete this shift?',
      description: 'Employees will be unassigned from this shift.',
      confirmText: 'Delete Shift',
      onConfirm: async () => {
        try {
          await apiRequest(`/hr/shifts/${id}`, { ...opts(), method: 'DELETE' });
          toast.success('Shift deleted successfully.');
          fetchAll();
        } catch (err: any) { toast.error(err?.message || 'Failed to delete shift'); }
      },
    });
  };
  const assignShift = async (newEmpIds: string[]) => {
    if (!assignShiftModal) return;
    const existingIds = (employees as any[])
      .filter((e: any) => String(e.fk_shift_id) === assignShiftModal.id)
      .map((e: any) => String(e.pk_employee_id));
    const combinedIds = Array.from(new Set([...existingIds, ...newEmpIds])).map(Number);
    try {
      await apiRequest(`/hr/shifts/${assignShiftModal.id}/assign`, { ...opts(), method: 'POST', body: JSON.stringify({ employee_ids: combinedIds }) });
      toast.success('Employees assigned to shift');
      setAssignShiftModal(null); fetchAll();
    } catch (err: any) { toast.error(err?.message || 'Failed to assign employees'); }
  };
  const unassignShift = async (empIdsToUnassign: string[]) => {
    if (!unassignShiftModal) return;
    const currentShiftEmpIds = (employees as any[])
      .filter((e: any) => String(e.fk_shift_id) === unassignShiftModal.id)
      .map((e: any) => String(e.pk_employee_id));
    const remainingEmpIds = currentShiftEmpIds.filter(id => !empIdsToUnassign.includes(id));
    try {
      await apiRequest(`/hr/shifts/${unassignShiftModal.id}/assign`, { ...opts(), method: 'POST', body: JSON.stringify({ employee_ids: remainingEmpIds.map(Number) }) });
      toast.success('Employees unassigned from shift successfully');
      setUnassignShiftModal(null); fetchAll();
    } catch (err: any) { toast.error(err?.message || 'Failed to unassign employees'); }
  };
  const unassignEmployeeShift = async (shiftId: string, empId: string, empName: string, shiftName: string) => {
    confirmAction(
      `Unassign ${empName}?`,
      `Are you sure you want to unassign ${empName} from ${shiftName}?`,
      async () => {
        try {
          await apiRequest(`/employees/${empId}`, {
            ...opts(),
            method: 'PUT',
            body: JSON.stringify({ fk_shift_id: null })
          });
          toast.success(`${empName} unassigned from ${shiftName}.`);
          fetchAll();
        } catch (err: any) {
          toast.error(err?.message || 'Failed to unassign employee.');
        }
      },
      false,
      'Unassign'
    );
  };
  const assignUnassignedShifts = async (targetShiftId: string, empIds: string[]) => {
    try {
      await apiRequest(`/hr/shifts/${targetShiftId}/assign`, { ...opts(), method: 'POST', body: JSON.stringify({ employee_ids: empIds.map(Number) }) });
      toast.success('Employees assigned to shift successfully.');
      setAssignUnassignedModal(null); fetchAll();
    } catch (err: any) { toast.error(err?.message || 'Failed to assign employees'); }
  };

  // ── Analytics grouping ─────────────────────────────────────────────────────
  const deptGroups = useMemo(() => {
    const map: Record<string, { dept: Dept; rows: AnalyticsRow[]; present: number; late: number; absent: number; }> = {};
    analytics.forEach(r => {
      const deptIdKey = r.dept_id || "null";
      if (!map[deptIdKey]) {
        const d = depts.find(d => d.id === r.dept_id);
        map[deptIdKey] = {
          dept: d || {
            id: deptIdKey,
            name: r.department || "Unassigned Employees",
            code: r.code || "N/A",
            color: r.color || "#94A3B8",
            description: null,
            head_employee_id: null,
            head_employee_name: null,
            employee_count: 0
          },
          rows: [],
          present: 0,
          late: 0,
          absent: 0
        };
      }
      map[deptIdKey].rows.push(r);
      if (r.today_status === 'present' || (r.today_status as string) === 'late') {
        map[deptIdKey].present++;
        if (r.is_late || (r.today_status as string) === 'late') map[deptIdKey].late++;
      } else {
        map[deptIdKey].absent++;
      }
    });
    return Object.values(map);
  }, [analytics, depts]);

  // ── Unassigned employees ───────────────────────────────────────────────────
  const unassigned = useMemo(() =>
    (employees as Employee[]).filter(e =>
      (e as any).status === 'active' && (!e.fk_department_id || !e.fk_shift_id)
    ),
  [employees]);

  const shiftGroups = useMemo(() => {
    const map: Record<string, { shift: Shift; rows: AnalyticsRow[]; present: number; late: number; absent: number; }> = {};
    analytics.forEach(r => {
      const shiftIdKey = r.shift_id ? String(r.shift_id) : 'null';
      if (!map[shiftIdKey]) {
        const s = shifts.find(s => String(s.id) === shiftIdKey);
        map[shiftIdKey] = {
          shift: s || {
            id: shiftIdKey,
            name: r.shift_name || "Unassigned Shift",
            shift_type: r.shift_type || "flexible",
            start_time: r.start_time,
            end_time: r.end_time,
            grace_period_minutes: r.grace_period_minutes || 0,
            is_flexible: false,
            break_duration_minutes: 0,
            work_days: ['Mon','Tue','Wed','Thu','Fri'],
            employee_count: 0
          },
          rows: [],
          present: 0,
          late: 0,
          absent: 0
        };
      }
      map[shiftIdKey].rows.push(r);
      if (r.today_status === 'present' || (r.today_status as string) === 'late') { map[shiftIdKey].present++; if (r.is_late || (r.today_status as string) === 'late') map[shiftIdKey].late++; }
      else map[shiftIdKey].absent++;
    });
    return Object.values(map).sort((a,b) => (a.shift.start_time||'').localeCompare(b.shift.start_time||''));
  }, [analytics, shifts]);

  const totalPresent = analytics.filter(r => r.today_status === 'present' || (r.today_status as string) === 'late').length;
  const totalLate = analytics.filter(r => r.is_late || (r.today_status as string) === 'late').length;
  const totalAbsent = analytics.filter(r => r.today_status === 'absent').length;
  const totalEmp = new Set(analytics.map(r => r.pk_employee_id)).size;


  const toggle = (_cur: Set<string>, id: string, setter: React.Dispatch<React.SetStateAction<Set<string>>>) => {
    setter(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <PageHeader
        title="Departments & Shifts"
        icon={Building2}
        actions={
          <button onClick={fetchAll} className={cn("flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg transition-colors", lightTheme.text.secondary, lightTheme.background.hover)}>
            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} /> Refresh
          </button>
        }
      />

      {loading && (
        <div className="w-full h-1 bg-primary/10 overflow-hidden rounded-full relative">
          <style>{`
            @keyframes loadingBar {
              0% { left: -30%; width: 30%; }
              50% { left: 30%; width: 40%; }
              100% { left: 100%; width: 30%; }
            }
          `}</style>
          <div 
            className="absolute top-0 bottom-0 bg-primary rounded-full"
            style={{ animation: 'loadingBar 1.5s infinite linear' }}
          />
        </div>
      )}

      <div className={cn("transition-opacity duration-300 space-y-5", loading && "opacity-60 pointer-events-none")}>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard title="Total Employees" value={totalEmp} icon={Users} description="Active workforce" />
        <MetricCard title="Present Today" value={totalPresent} icon={UserCheck} description="Checked in" colorClass="text-emerald-500" />
        <MetricCard title="Late Arrivals" value={totalLate} icon={AlertTriangle} description="Past grace period" colorClass="text-amber-500" />
        <MetricCard title="Absent Today" value={totalAbsent} icon={UserX} description="Not checked in" colorClass="text-rose-500" />
      </div>

      {/* Unassigned employees alert */}
      {unassigned.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-900/10 dark:border-amber-800 px-4 py-3">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wide mb-2">
                {unassigned.length} Active Employee{unassigned.length > 1 ? 's' : ''} Need Configuration
              </p>
              <div className="flex flex-wrap gap-2">
                {unassigned.slice(0, 8).map(e => (
                  <span key={e.pk_employee_id} className="inline-flex items-center gap-1 text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-700 rounded-full px-2.5 py-0.5 font-medium">
                    {e.full_name}
                    {!e.fk_department_id && <span className="text-amber-500 font-bold">· no dept</span>}
                    {!e.fk_shift_id      && <span className="text-amber-500 font-bold">· no shift</span>}
                  </span>
                ))}
                {unassigned.length > 8 && (
                  <span className="text-xs text-amber-500 self-center">+{unassigned.length - 8} more</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl w-fit">
        {(['departments','shifts'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} className={cn("px-4 py-1.5 text-sm font-semibold rounded-lg capitalize transition-all", activeTab === tab ? "glass-card shadow-sm text-slate-900 dark:text-white" : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300")}>
            {tab === 'departments' ? <><Building2 className="w-3.5 h-3.5 inline mr-1.5" />Departments ({depts.length})</>
             : <><Clock className="w-3.5 h-3.5 inline mr-1.5" />Shifts ({shifts.length})</>}
          </button>
        ))}
      </div>

      {/* ── DEPARTMENTS TAB ── */}
      {activeTab === 'departments' && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button onClick={() => { setDeptForm(emptyDept); setFormError(null); setDeptModal({ mode: 'add' }); }} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition-colors">
              <Plus className="w-4 h-4" /> Add Department
            </button>
          </div>
          {deptGroups.map(({ dept, rows, present, late, absent }) => {
            const expanded = expandedDepts.has(dept.id);
            const rate = rows.length > 0 ? Math.round((present / rows.length) * 100) : 0;
            const byShift: Record<string, AnalyticsRow[]> = rows.reduce((acc: Record<string, AnalyticsRow[]>, r: AnalyticsRow) => { if (!acc[r.shift_id]) acc[r.shift_id] = []; acc[r.shift_id].push(r); return acc; }, {});
            return (
              <div key={dept.id} className="glass-card border border-slate-200 dark:border-slate-700 rounded-2xl overflow-hidden shadow-sm">
                <div className="flex items-center gap-3 p-4">
                  <button onClick={() => toggle(expandedDepts, dept.id, setExpandedDepts)} className="flex items-center gap-3 flex-1 text-left">
                    <div className="w-3 h-10 rounded-full flex-shrink-0" style={{ backgroundColor: dept.color }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-900 dark:text-white truncate" title={dept.name}>{dept.name}</span>
                        <span className="text-xs flex-shrink-0 text-slate-400 font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">{dept.code}</span>
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 text-xs">
                        <span className="text-slate-500">{rows.length} employees</span>
                        <span className="text-emerald-600 font-medium">{present} present</span>
                        {late > 0 && <span className="text-amber-600 font-medium">{late} late</span>}
                        {absent > 0 && <span className="text-rose-500 font-medium">{absent} absent</span>}
                      </div>
                    </div>
                    <div className="w-20 hidden sm:block mr-2">
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-slate-400">Rate</span>
                        <span className="font-bold text-slate-700 dark:text-slate-300">{rate}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                        <div className={cn("h-full rounded-full", rate>=80?"bg-emerald-500":rate>=50?"bg-amber-500":"bg-rose-500")} style={{width:`${rate}%`}} />
                      </div>
                    </div>
                    {expanded ? <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />}
                  </button>
                  {/* Actions */}
                  {dept.id !== 'null' && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button onClick={() => setAssignDeptModal(dept)} className="p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors" title="Assign employees">
                        <UserPlus className="w-4 h-4" />
                      </button>
                      <button onClick={() => setUnassignDeptModal(dept)} className="p-1.5 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 rounded-lg transition-colors" title="Unassign employees">
                        <UserX className="w-4 h-4" />
                      </button>
                      <button onClick={() => { setDeptForm({ name: dept.name, code: dept.code, color: dept.color, description: dept.description || '' }); setDeptModal({ mode: 'edit', data: dept }); }} className="p-1.5 text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors">
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button onClick={() => deleteDept(dept.id)} className="p-1.5 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-lg transition-colors">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>
                {expanded && (
                  <div className="border-t border-slate-100 dark:border-slate-800">
                    {Object.entries(byShift).map(([sid, emps]) => (
                      <div key={sid}>
                        <div className={cn("px-4 py-2 flex items-center gap-2 text-xs font-semibold border-b border-slate-50 dark:border-slate-800/50", shiftColor(emps[0].shift_type))}>
                          <span>{emps[0].shift_name}</span>
                          <span className="ml-auto opacity-60">{fmt12(emps[0].start_time)} – {fmt12(emps[0].end_time)}</span>
                        </div>
                        {emps.map(emp => (
                          <div key={emp.pk_employee_id} className="flex items-center gap-3 px-6 py-2.5 border-b border-slate-50 dark:border-slate-800/30 last:border-0 hover:bg-slate-50/50 dark:hover:bg-slate-800/20 group">
                            <div className={cn("w-2 h-2 rounded-full flex-shrink-0", statusDot(emp.today_status, emp.is_late))} />
                            <span className="text-sm font-medium text-slate-800 dark:text-slate-200 flex-1">{emp.full_name}</span>
                            <span className="text-xs text-slate-400">{emp.employee_code}</span>
                            {emp.today_status === 'present' ? (
                              <div className="flex items-center gap-2 text-xs">
                                {emp.check_in_local && <span className="text-emerald-600">In: {new Date(emp.check_in_local).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>}
                                {emp.is_late && <span className="text-amber-500 font-semibold">Late</span>}
                              </div>
                            ) : <span className="text-xs text-rose-400 font-medium">Absent</span>}
                            {dept.id !== 'null' && (
                              <button
                                onClick={(e) => { e.stopPropagation(); unassignEmployeeDept(dept.id, String(emp.pk_employee_id), emp.full_name, dept.name); }}
                                className="opacity-0 group-hover:opacity-100 p-1 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 rounded-md transition-all text-xs flex items-center gap-1 ml-2"
                                title={`Unassign ${emp.full_name} from ${dept.name}`}
                              >
                                <UserX className="w-3.5 h-3.5" />
                                <span className="hidden sm:inline">Unassign</span>
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {/* Unassigned depts (no analytics) */}
          {depts.filter(d => !deptGroups.find(g => g.dept.id === d.id)).map(dept => (
            <div key={dept.id} className="glass-card border border-slate-200 dark:border-slate-700 rounded-2xl p-4 flex items-center gap-3 shadow-sm">
              <div className="w-3 h-10 rounded-full" style={{ backgroundColor: dept.color }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-slate-900 dark:text-white truncate" title={dept.name}>{dept.name}</span>
                  <span className="text-xs flex-shrink-0 text-slate-400 font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">{dept.code}</span>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">{dept.employee_count} active employees</p>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => setAssignDeptModal(dept)} className="p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors" title="Assign employees"><UserPlus className="w-4 h-4" /></button>
                <button onClick={() => setUnassignDeptModal(dept)} className="p-1.5 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 rounded-lg transition-colors" title="Unassign employees"><UserX className="w-4 h-4" /></button>
                <button onClick={() => { setDeptForm({ name: dept.name, code: dept.code, color: dept.color, description: dept.description || '' }); setDeptModal({ mode: 'edit', data: dept }); }} className="p-1.5 text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"><Edit2 className="w-4 h-4" /></button>
                <button onClick={() => deleteDept(dept.id)} className="p-1.5 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-lg transition-colors"><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── SHIFTS TAB ── */}
      {activeTab === 'shifts' && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button onClick={() => { setShiftForm(emptyShift as any); setFormError(null); setShiftModal({ mode: 'add' }); }} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition-colors">
              <Plus className="w-4 h-4" /> Add Shift
            </button>
          </div>
          {shiftGroups.map(({ shift, rows, present, late, absent }) => {
            const expanded = expandedShifts.has(shift.id);
            const rate = rows.length > 0 ? Math.round((present / rows.length) * 100) : 0;
            const lowCoverage = rate < 50 && rows.length > 0;
            return (
              <div key={shift.id} className={cn("glass-card border rounded-2xl overflow-hidden shadow-sm", lowCoverage ? "border-rose-200 dark:border-rose-800" : "border-slate-200 dark:border-slate-700")}>
                <div className="flex items-center gap-3 p-4">
                  <button onClick={() => toggle(expandedShifts, shift.id, setExpandedShifts)} className="flex items-center gap-3 flex-1 text-left">
                    <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 border text-xs font-bold", shiftColor(shift.shift_type))}>
                      <Clock className="w-5 h-5" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-slate-900 dark:text-white">{shift.name}</span>
                        {lowCoverage && <span className="text-[10px] font-bold text-rose-600 bg-rose-50 dark:bg-rose-900/20 px-1.5 py-0.5 rounded-full border border-rose-200">⚠ Low Coverage</span>}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 text-xs text-slate-500">
                        <span>{fmt12(shift.start_time)} – {fmt12(shift.end_time)}</span>
                        {shift.grace_period_minutes > 0 && <span className="text-slate-400">+{shift.grace_period_minutes}m grace</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-4 flex-shrink-0 hidden sm:flex">
                      <div className="text-center"><p className="text-lg font-bold text-emerald-600">{present}</p><p className="text-[10px] text-slate-400">Present</p></div>
                      <div className="text-center"><p className="text-lg font-bold text-amber-500">{late}</p><p className="text-[10px] text-slate-400">Late</p></div>
                      <div className="text-center"><p className="text-lg font-bold text-rose-500">{absent}</p><p className="text-[10px] text-slate-400">Absent</p></div>
                      <div className="w-16">
                        <div className="text-xs font-bold text-right mb-1 text-slate-600 dark:text-slate-300">{rate}%</div>
                        <div className="w-full h-2 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                          <div className={cn("h-full rounded-full", rate>=80?"bg-emerald-500":rate>=50?"bg-amber-500":"bg-rose-500")} style={{width:`${rate}%`}} />
                        </div>
                      </div>
                    </div>
                    {expanded ? <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />}
                  </button>
                  {shift.id !== 'null' ? (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button onClick={() => setAssignShiftModal(shift)} className="p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors" title="Assign employees"><UserPlus className="w-4 h-4" /></button>
                      <button onClick={() => setUnassignShiftModal(shift)} className="p-1.5 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 rounded-lg transition-colors" title="Unassign employees"><UserX className="w-4 h-4" /></button>
                      <button onClick={() => { setShiftForm({ name: shift.name, shift_type: shift.shift_type, start_time: shift.start_time || '09:00', end_time: shift.end_time || '18:00', grace_period_minutes: shift.grace_period_minutes, is_flexible: shift.is_flexible, break_duration_minutes: shift.break_duration_minutes ?? 0, work_days: shift.work_days?.length ? shift.work_days : ['Mon','Tue','Wed','Thu','Fri'] }); setShiftModal({ mode: 'edit', data: shift }); }} className="p-1.5 text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors" title="Edit shift"><Edit2 className="w-4 h-4" /></button>
                      <button onClick={() => deleteShift(shift.id)} className="p-1.5 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-lg transition-colors" title="Delete shift"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button onClick={() => setAssignUnassignedModal(rows.map(r => r.pk_employee_id))} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-600 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/40 rounded-lg transition-colors" title="Assign shift to these employees">
                        <UserPlus className="w-3.5 h-3.5" /> Assign Shift
                      </button>
                    </div>
                  )}
                </div>
                {expanded && (
                  <div className="border-t border-slate-100 dark:border-slate-800">
                    {rows.map(emp => (
                      <div key={emp.pk_employee_id} className="flex items-center gap-3 px-5 py-2.5 border-b border-slate-50 dark:border-slate-800/30 last:border-0 hover:bg-slate-50/50 dark:hover:bg-slate-800/20 group">
                        <div className={cn("w-2 h-2 rounded-full flex-shrink-0", statusDot(emp.today_status, emp.is_late))} />
                        <span className="text-sm font-medium text-slate-800 dark:text-slate-200 flex-1">{emp.full_name}</span>
                        <span className="text-xs text-slate-400">{emp.employee_code} · {emp.department}</span>
                        {emp.today_status === 'present' ? (
                          <div className="flex items-center gap-2 text-xs">
                            {emp.check_in_local && <span className="text-emerald-600">In: {new Date(emp.check_in_local).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>}
                            {emp.is_late && <span className="text-amber-500 font-semibold">Late</span>}
                          </div>
                        ) : <span className="text-xs text-rose-400 font-medium">Absent</span>}
                        {shift.id !== 'null' && (
                          <button
                            onClick={(e) => { e.stopPropagation(); unassignEmployeeShift(shift.id, String(emp.pk_employee_id), emp.full_name, shift.name); }}
                            className="opacity-0 group-hover:opacity-100 p-1 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 rounded-md transition-all text-xs flex items-center gap-1 ml-2"
                            title={`Unassign ${emp.full_name} from ${shift.name}`}
                          >
                            <UserX className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">Unassign</span>
                          </button>
                        )}
                      </div>
                    ))}
                    {/* Employees assigned to this shift but not in analytics */}
                    {shifts.find(s=>s.id===shift.id) && (employees as any[]).filter((e:any) => String(e.fk_shift_id) === shift.id && !rows.find(r => r.pk_employee_id === String(e.pk_employee_id))).map((e:any) => (
                      <div key={e.pk_employee_id} className="flex items-center gap-3 px-5 py-2.5 border-b border-slate-50 dark:border-slate-800/30 last:border-0 opacity-50">
                        <div className="w-2 h-2 rounded-full bg-slate-200 dark:bg-slate-600 flex-shrink-0" />
                        <span className="text-sm text-slate-600 dark:text-slate-400 flex-1">{e.full_name}</span>
                        <span className="text-xs text-slate-400">{e.employee_code}</span>
                        <span className="text-xs text-slate-400">No data</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {/* Shifts with no analytics */}
          {shifts.filter(s => !shiftGroups.find(g => g.shift.id === s.id)).map(shift => (
            <div key={shift.id} className="glass-card border border-slate-200 dark:border-slate-700 rounded-2xl p-4 flex items-center gap-3 shadow-sm">
              <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 border", shiftColor(shift.shift_type))}><Clock className="w-5 h-5" /></div>
              <div className="flex-1">
                <span className="font-bold text-slate-900 dark:text-white">{shift.name}</span>
                <p className="text-xs text-slate-500 mt-0.5">{fmt12(shift.start_time)} – {fmt12(shift.end_time)} · {shift.employee_count} employees</p>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => setAssignShiftModal(shift)} className="p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors" title="Assign employees"><UserPlus className="w-4 h-4" /></button>
                <button onClick={() => setUnassignShiftModal(shift)} className="p-1.5 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 rounded-lg transition-colors" title="Unassign employees"><UserX className="w-4 h-4" /></button>
                <button onClick={() => { setShiftForm({ name: shift.name, shift_type: shift.shift_type, start_time: shift.start_time||'09:00', end_time: shift.end_time||'18:00', grace_period_minutes: shift.grace_period_minutes, is_flexible: shift.is_flexible, break_duration_minutes: shift.break_duration_minutes ?? 0, work_days: shift.work_days?.length ? shift.work_days : ['Mon','Tue','Wed','Thu','Fri'] }); setShiftModal({ mode: 'edit', data: shift }); }} className="p-1.5 text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors" title="Edit shift"><Edit2 className="w-4 h-4" /></button>
                <button onClick={() => deleteShift(shift.id)} className="p-1.5 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-lg transition-colors" title="Delete shift"><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── ROSTER TAB ── */}

      {/* ── ROSTER TAB ── */}
      {activeTab === 'roster' && (
        <RosterTab
          employees={employees as any}
          shifts={shifts.map(s => ({ ...s, id: String((s as any).pk_shift_id || s.id) }))}
        />
      )}

      {/* ── DEPT MODAL ── */}
      {deptModal && (
        <Modal title={deptModal.mode === 'add' ? 'Add Department' : 'Edit Department'} onClose={() => setDeptModal(null)}>
          <div className="space-y-4">
            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wide">Department Name *</label>
                <span className="text-xs text-slate-400">{deptForm.name.length}/30</span>
              </div>
              <input value={deptForm.name} onChange={e => {
                const val = e.target.value;
                
                if (val.startsWith(' ')) {
                  setFormError('Department Name cannot start with a space.');
                  return;
                }
                if (/\s{2,}/.test(val)) {
                  setFormError('Consecutive spaces are not allowed.');
                  return;
                }
                if (/-{2,}/.test(val)) {
                  setFormError('Consecutive hyphens (--) are not allowed.');
                  return;
                }
                if (/[^a-zA-Z0-9\s-]/.test(val)) {
                  setFormError('Only letters, numbers, spaces, and hyphens are allowed.');
                  return;
                }

                setDeptForm(f => ({...f, name: val}));
                
                if (val.length > 0) {
                  if (val.length === 30) {
                    setFormError('Maximum limit of 30 characters reached.');
                  } else if (val.trim().length > 0 && val.trim().length < 2) {
                    setFormError('Department Name must be between 2 and 30 characters.');
                  } else if (val.trim().length > 0 && /^\d+$/.test(val.trim())) {
                    setFormError('Department Name cannot be purely numeric.');
                  } else {
                    setFormError(null);
                  }
                } else {
                  setFormError(null);
                }
              }} placeholder="e.g. Engineering" maxLength={30} className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 glass-card text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wide">Code *</label>
                <span className="text-xs text-slate-400">{deptForm.code.length}/10</span>
              </div>
              <input value={deptForm.code} onChange={e => {
                const val = e.target.value.toUpperCase();
                
                if (val.startsWith(' ')) {
                  setFormError('Department Code cannot start with a space.');
                  return;
                }
                if (/\s/.test(val)) {
                  setFormError('Spaces are not allowed in Department Code.');
                  return;
                }
                if (/-{2,}/.test(val)) {
                  setFormError('Consecutive hyphens (--) are not allowed.');
                  return;
                }
                if (/[^A-Z0-9-]/.test(val)) {
                  setFormError('Only letters, numbers, and hyphens are allowed in Code.');
                  return;
                }

                setDeptForm(f => ({...f, code: val}));
                
                if (val.length > 0) {
                  if (val.length === 10) {
                    setFormError('Maximum limit of 10 characters reached.');
                  } else if (val.length < 2) {
                    setFormError('Code must be between 2 and 10 characters long.');
                  } else {
                    setFormError(null);
                  }
                } else {
                  setFormError(null);
                }
              }} placeholder="e.g. ENG" maxLength={10} className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 glass-card text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wide">Description</label>
              <textarea value={deptForm.description} onChange={e => setDeptForm(f => ({...f, description: e.target.value}))} placeholder="Optional description..." rows={2} className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 glass-card text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wide flex items-center gap-1"><Palette className="w-3 h-3" /> Color</label>
              <div className="flex gap-2 mt-2 flex-wrap">
                {DEPT_COLORS.map(c => (
                  <button key={c} onClick={() => setDeptForm(f => ({...f, color: c}))} className={cn("w-8 h-8 rounded-full border-2 transition-transform hover:scale-110", deptForm.color === c ? "border-slate-900 dark:border-white scale-110" : "border-transparent")} style={{ backgroundColor: c }} />
                ))}
              </div>
            </div>
            {formError && (
              <p className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{formError}</p>
            )}
            <div className="flex gap-2 pt-2">
              <button onClick={saveDept} disabled={saving} className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm font-semibold py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => { setDeptModal(null); setFormError(null); }} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors">Cancel</button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── SHIFT MODAL ── */}
      {shiftModal && (
        <Modal title={shiftModal.mode === 'add' ? 'Add Shift' : 'Edit Shift'} onClose={() => setShiftModal(null)}>
          <div className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wide">Shift Name *</label>
              <input value={shiftForm.name} onChange={e => setShiftForm(f => ({...f, name: e.target.value}))} placeholder="e.g. Morning Shift" maxLength={25} className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 glass-card text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wide">Type *</label>
              <select value={shiftForm.shift_type} onChange={e => setShiftForm(f => ({...f, shift_type: e.target.value}))} className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 glass-card text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                {SHIFT_TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}
              </select>
            </div>
            {!shiftForm.is_flexible && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wide">Start Time</label>
                  <input type="time" value={shiftForm.start_time || ''} onChange={e => setShiftForm(f => ({...f, start_time: e.target.value}))} className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 glass-card text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wide">End Time</label>
                  <input type="time" value={shiftForm.end_time || ''} onChange={e => setShiftForm(f => ({...f, end_time: e.target.value}))} className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 glass-card text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wide">Grace Period (min)</label>
                <input type="number" value={String(shiftForm.grace_period_minutes)} min={0} onChange={e => {
                  let val = Number(e.target.value);
                  if (val < 0) { val = 0; e.target.value = '0'; }
                  if (val > 60) {
                    val = 60;
                    e.target.value = '60';
                    setGraceError(true);
                  } else {
                    setGraceError(false);
                  }
                  setShiftForm(f => ({...f, grace_period_minutes: val}));
                }} className={cn("mt-1 w-full px-3 py-2 rounded-lg border glass-card text-sm focus:outline-none focus:ring-2 focus:ring-blue-500", graceError ? "border-rose-500 focus:ring-rose-500" : "border-slate-300 dark:border-slate-600")} />
                {graceError && <p className="text-xs text-rose-500 mt-1">Grace Period cannot exceed 60 minutes.</p>}
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wide">Break (min)</label>
                <input type="number" value={String(shiftForm.break_duration_minutes)} min={0} onChange={e => {
                  let val = Number(e.target.value);
                  if (val < 0) { val = 0; e.target.value = '0'; }
                  if (val > 120) {
                    val = 120;
                    e.target.value = '120';
                    setBreakError(true);
                  } else {
                    setBreakError(false);
                  }
                  setShiftForm(f => ({...f, break_duration_minutes: val}));
                }} className={cn("mt-1 w-full px-3 py-2 rounded-lg border glass-card text-sm focus:outline-none focus:ring-2 focus:ring-blue-500", breakError ? "border-rose-500 focus:ring-rose-500" : "border-slate-300 dark:border-slate-600")} />
                {breakError && <p className="text-xs text-rose-500 mt-1">Break duration cannot exceed 120 minutes.</p>}
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wide">Work Days</label>
              <div className="flex gap-1.5 mt-2 flex-wrap">
                {WORK_DAYS.map(day => {
                  const active = shiftForm.work_days.includes(day);
                  return (
                    <button key={day} type="button" onClick={() => setShiftForm(f => ({ ...f, work_days: active ? f.work_days.filter(d => d !== day) : [...f.work_days, day] }))}
                      className={cn("px-2.5 py-1 text-xs font-semibold rounded-lg border transition-colors", active ? "bg-blue-600 text-white border-blue-600" : "glass-card text-slate-500 border-slate-300 dark:border-slate-600 hover:border-blue-400")}>
                      {day}
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={shiftForm.is_flexible} onChange={e => setShiftForm(f => ({...f, is_flexible: e.target.checked}))} className="rounded" />
              <span className="text-sm text-slate-700 dark:text-slate-300">Flexible hours (no fixed start/end time)</span>
            </label>
            {formError && (
              <p className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{formError}</p>
            )}
            <div className="flex gap-2 pt-2">
              <button onClick={saveShift} disabled={saving} className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm font-semibold py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => { setShiftModal(null); setFormError(null); setGraceError(false); setBreakError(false); }} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors">Cancel</button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── ASSIGN DEPT MODAL ── */}
      {assignDeptModal && (
        <AssignModal
          title={`Assign to ${assignDeptModal.name}`}
          employees={employees as any}
          currentIds={[]}
          onAssign={assignDept}
          onClose={() => setAssignDeptModal(null)}
        />
      )}

      {/* ── ASSIGN SHIFT MODAL ── */}
      {assignShiftModal && (
        <AssignModal
          title={`Assign to ${assignShiftModal.name}`}
          employees={employees as any}
          currentIds={[]}
          onAssign={assignShift}
          onClose={() => setAssignShiftModal(null)}
        />
      )}

      {/* ── UNASSIGN DEPT MODAL ── */}
      {unassignDeptModal && (
        <UnassignModal
          title={`Unassign from ${unassignDeptModal.name}`}
          assignedEmployees={(employees as any[]).filter((e:any) => String(e.fk_department_id) === unassignDeptModal.id)}
          onUnassign={unassignDept}
          onClose={() => setUnassignDeptModal(null)}
        />
      )}

      {/* ── UNASSIGN SHIFT MODAL ── */}
      {unassignShiftModal && (
        <UnassignModal
          title={`Unassign from ${unassignShiftModal.name}`}
          assignedEmployees={(employees as any[]).filter((e:any) => String(e.fk_shift_id) === unassignShiftModal.id)}
          onUnassign={unassignShift}
          onClose={() => setUnassignShiftModal(null)}
        />
      )}

      {/* ── ASSIGN UNASSIGNED SHIFT MODAL ── */}
      {assignUnassignedModal && (
        <AssignUnassignedShiftModal
          shifts={shifts}
          empIdsToAssign={assignUnassignedModal}
          employees={employees as any}
          onAssign={assignUnassignedShifts}
          onClose={() => setAssignUnassignedModal(null)}
        />
      )}
      {/* Centered Popup Modal */}
      {confirmConfig && (
        <ConfirmModal
          isOpen={true}
          onClose={() => setConfirmConfig(null)}
          title={confirmConfig.title}
          description={confirmConfig.description}
          confirmText={confirmConfig.confirmText || 'Confirm'}
          onConfirm={confirmConfig.onConfirm}
        />
      )}
      </div>

      <AlertDialog open={confirmDialog.isOpen} onOpenChange={(open) => setConfirmDialog(prev => ({ ...prev, isOpen: open }))}>
        <AlertDialogContent className="rounded-2xl max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-xl font-black text-slate-800 dark:text-white">
              {confirmDialog.title}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm font-medium text-slate-500 whitespace-pre-wrap">
              {confirmDialog.message}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-6 gap-2">
            <AlertDialogCancel className="rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 font-bold flex-1 opacity-100 cursor-pointer">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDialog.onConfirm}
              className={cn("rounded-xl font-bold text-white flex-1", confirmDialog.isDestructive ? "bg-rose-600 hover:bg-rose-700" : "bg-blue-600 hover:bg-blue-700")}
            >
              {confirmDialog.confirmText}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
