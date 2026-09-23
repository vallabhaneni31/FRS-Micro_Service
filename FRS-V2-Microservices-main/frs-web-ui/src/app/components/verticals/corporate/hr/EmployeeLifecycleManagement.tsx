import { useDepartmentsAndShifts } from '../../../../hooks/useDepartmentsAndShifts';
import { useQueryParam, useNumberQueryParam } from '../../../../hooks/useQueryParam';
import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { Card, CardContent } from '../../../ui/card';
import { Badge } from '../../../ui/badge';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';
import { Label } from '../../../ui/label';
import {
  UserPlus, UserMinus, Users, ScanFace, Search, Upload, Camera,
  Edit, Loader2, RefreshCw, AlertCircle, ShieldCheck, ShieldAlert,
  Download, Trash2, LayoutGrid, List, MapPin, Building2, ArrowUpDown, ArrowUp, ArrowDown, X,
  Mail, History, Network, Clock, Phone, Briefcase, User, Hash, CheckCircle2,
  SlidersHorizontal, ChevronDown,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../../../ui/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../../../ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../../../ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select';
import { Checkbox } from '../../../ui/checkbox';
import { useSearchParams } from 'react-router';
import { EmployeeProfileDashboard } from './EmployeeProfileDashboard';
import { BulkImportModal } from './BulkImportModal';
import { BulkFaceEnrollModal } from './BulkFaceEnrollModal';
import { useAuth } from '../../../../contexts/AuthContext';
import { apiRequest, invalidateApiCache } from '../../../../services/http/apiClient';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';

interface ApiEmployee {
  pk_employee_id: number;
  employee_code: string;
  full_name: string;
  email: string;
  position_title: string;
  location_label: string;
  join_date: string;
  status: 'active' | 'inactive';
  department_name: string;
  shift_name?: string;
  face_enrolled?: boolean;
  enrollment_quality?: number;
  embedding_count?: number;
  phone_number?: string;
  fk_department_id?: number;
  fk_shift_id?: number;
  fk_manager_id?: number;
  manager_name?: string;
  is_manager?: boolean;
  consent_given_at?: string | null;
  consent_withdrawn_at?: string | null;
  consent_method?: string | null;
  kiosk_enrollment_status?: string | null;
  site_ids?: number[];
  site_id?: number;
}

// ── Display helpers ─────────────────────────────────────────────────────────
/** Real data carries leading/trailing whitespace (" Akshitha Arra", "Karthik "). */
const clean = (s?: string | null) => (s ?? '').trim();

const initials = (name: string) =>
  clean(name).split(/\s+/).filter(Boolean).map(n => n[0]).join('').slice(0, 2).toUpperCase();

/** Distinct fallback palette — used when the API returns identical dept colours. */
const DEPT_PALETTE = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#ef4444', '#6366f1', '#14b8a6', '#f97316'];
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

type Consent = 'granted' | 'withdrawn' | 'pending';
const consentState = (e: ApiEmployee): Consent => {
  if (e.consent_withdrawn_at) return 'withdrawn';
  if (e.consent_given_at) return 'granted';
  return 'pending';
};
const CONSENT_UI: Record<Consent, { dot: string; text: string; bg: string; label: string; Icon: typeof ShieldCheck }> = {
  granted:   { dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-500/15', label: 'Consent',    Icon: ShieldCheck },
  withdrawn: { dot: 'bg-rose-500',    text: 'text-rose-600 dark:text-rose-400',    bg: 'bg-rose-50 dark:bg-rose-500/15',    label: 'Withdrawn',  Icon: ShieldAlert },
  pending:   { dot: 'bg-slate-300',   text: 'text-slate-400 dark:text-slate-500',  bg: 'bg-slate-50 dark:bg-slate-700/40',  label: 'No consent', Icon: ShieldAlert },
};

type SortKey = 'name' | 'code' | 'department' | 'status' | 'biometric' | 'consent' | 'recent';
type SortDir = 'asc' | 'desc';

const SORTS: { value: SortKey; label: string }[] = [
  { value: 'name',       label: 'Name' },
  { value: 'code',       label: 'Employee code' },
  { value: 'department', label: 'Department' },
  { value: 'status',     label: 'Status' },
  { value: 'biometric',  label: 'Enrollment' },
  { value: 'consent',    label: 'Consent' },
  { value: 'recent',     label: 'Recently joined' },
];
const SORT_KEYS = new Set<string>(SORTS.map(s => s.value));

// Sensible default direction applied the first time a key is chosen.
const SORT_DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: 'asc', code: 'asc', department: 'asc', status: 'asc',
  biometric: 'desc', consent: 'asc', recent: 'desc',
};

// Table column header label → the sort key it triggers when clicked.
const COLUMN_SORT: Record<string, SortKey> = {
  Employee:        'name',
  'Employee ID':   'code',
  Code:            'code',
  Department:      'department',
  Status:          'status',
  Biometrics:      'biometric',
  Consent:         'consent',
};

const CONSENT_RANK: Record<Consent, number> = { granted: 0, pending: 1, withdrawn: 2 };

/** Base (ascending) comparison for a given sort key. */
function compareEmployees(a: ApiEmployee, b: ApiEmployee, key: SortKey): number {
  switch (key) {
    case 'code':       return (a.employee_code ?? '').localeCompare(b.employee_code ?? '', undefined, { numeric: true });
    case 'department': return clean(a.department_name).localeCompare(clean(b.department_name));
    case 'status':     return a.status === b.status ? 0 : a.status === 'active' ? -1 : 1;
    case 'biometric':  return (a.embedding_count ?? 0) - (b.embedding_count ?? 0);
    case 'consent':    return CONSENT_RANK[consentState(a)] - CONSENT_RANK[consentState(b)];
    case 'recent':     return new Date(a.join_date).getTime() - new Date(b.join_date).getTime();
    default:           return clean(a.full_name).localeCompare(clean(b.full_name));
  }
}

// ── Data-health / lifecycle helpers ─────────────────────────────────────────
/** Healthy enrollment is 1–8 angles; <1 = none, >8 = anomaly (e.g. the 170 case). */
const isLowQuality = (e: ApiEmployee) =>
  !!e.face_enrolled && e.embedding_count != null && (e.embedding_count < 2 || e.embedding_count > 8);

/** Returns the list of things missing/wrong on a record (for the data-health badge). */
function missingFields(e: ApiEmployee): string[] {
  const out: string[] = [];
  if (!clean(e.email)) out.push('No email');
  if (!clean(e.phone_number)) out.push('No phone');
  if (!clean(e.department_name)) out.push('No department');
  if (!e.face_enrolled) out.push('No face enrolled');
  if (consentState(e) !== 'granted') out.push('Consent not granted');
  if (isLowQuality(e)) out.push(e.embedding_count! > 8 ? 'Abnormal embeddings' : 'Too few angles');
  return out;
}
const needsAttention = (e: ApiEmployee) => missingFields(e).length > 0;

const monthsAgoKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

const isNewThisMonth = (join_date?: string, now = new Date()) => {
  if (!join_date) return false;
  const d = new Date(join_date);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
};

/** Days until the next work anniversary (>=1y tenure only); null if not within window. */
function daysUntilAnniversary(join_date?: string, now = new Date(), windowDays = 30): number | null {
  if (!join_date) return null;
  const j = new Date(join_date);
  if (isNaN(j.getTime())) return null;
  let next = new Date(now.getFullYear(), j.getMonth(), j.getDate());
  if (next < new Date(now.getFullYear(), now.getMonth(), now.getDate())) next = new Date(now.getFullYear() + 1, j.getMonth(), j.getDate());
  const years = next.getFullYear() - j.getFullYear();
  if (years < 1) return null;
  const days = Math.round((next.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400000);
  return days <= windowDays ? days : null;
}

// Quick-filter segments — each is a predicate evaluated against an employee.
type QuickKey = 'unenrolled' | 'consent_pending' | 'inactive' | 'low_quality' | 'new_month';
const QUICK_FILTERS: { key: QuickKey; label: string; color: string; test: (e: ApiEmployee) => boolean }[] = [
  { key: 'unenrolled',      label: 'Unenrolled',      color: '#8b5cf6', test: e => !e.face_enrolled },
  { key: 'consent_pending', label: 'Consent pending', color: '#3b82f6', test: e => consentState(e) !== 'granted' },
  { key: 'inactive',        label: 'Inactive',        color: '#f43f5e', test: e => e.status === 'inactive' },
  { key: 'low_quality',     label: 'Low-quality',     color: '#f59e0b', test: isLowQuality },
  { key: 'new_month',       label: 'New this month',  color: '#10b981', test: e => isNewThisMonth(e.join_date) },
];

// ── Reusable pills ──────────────────────────────────────────────────────────
const StatusPill = ({ status }: { status: ApiEmployee['status'] }) => (
  <Badge className={cn('rounded-lg border-none px-2.5 py-0.5 text-[9px] font-black uppercase',
    status === 'active' ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400' : 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400'
  )}>{status}</Badge>
);

const BiometricPill = ({ emp }: { emp: ApiEmployee }) => (
  <div className="flex items-center gap-2">
    <div className={cn('w-2 h-2 rounded-full shadow-sm shrink-0', emp.face_enrolled ? 'bg-violet-500 animate-pulse' : 'bg-slate-200 dark:bg-slate-700')} />
    <span className={cn('text-[10px] font-black uppercase', emp.face_enrolled ? 'text-violet-600 dark:text-violet-400' : 'text-slate-300 dark:text-slate-600')}>
      {emp.face_enrolled ? 'Enrolled' : 'Pending'}
    </span>
    {emp.face_enrolled && emp.embedding_count != null && (
      <span
        title={emp.embedding_count > 8 ? 'Unusually high embedding count — expected ≤ 8' : `${emp.embedding_count} face angle(s) on file`}
        className={cn('text-[9px] font-black px-1.5 py-0.5 rounded-md inline-flex items-center gap-0.5',
          emp.embedding_count > 8 ? 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400' : 'bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400')}
      >
        {emp.embedding_count > 8 && <AlertCircle className="w-2.5 h-2.5" />}
        {emp.embedding_count} {emp.embedding_count === 1 ? 'angle' : 'angles'}
      </span>
    )}
  </div>
);

const ConsentPill = ({ emp }: { emp: ApiEmployee }) => {
  const ui = CONSENT_UI[consentState(emp)];
  return (
    <span
      title={emp.consent_method ? `via ${emp.consent_method}` : undefined}
      className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-black uppercase tracking-tight', ui.bg, ui.text)}
    >
      <ui.Icon className="w-2.5 h-2.5" />{ui.label}
    </span>
  );
};

// ── KPI stat card (header band) ──────────────────────────────────────────────
// Soft, bordered card with a tinted accent icon. Renders as a <button> when
// `onClick` is supplied (e.g. the "Needs attention" filter toggle).
const StatCard = ({
  icon: Icon, label, value, hint, accent, onClick, active,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string; value: React.ReactNode; hint?: string;
  accent: string; onClick?: () => void; active?: boolean;
}) => {
  const Tag: any = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      style={active ? { borderColor: accent, backgroundColor: accent + '0D', boxShadow: `0 6px 16px ${accent}22` } : undefined}
      className={cn(
        'rounded-2xl border bg-white dark:bg-slate-900 p-3.5 text-left transition-all',
        onClick && 'cursor-pointer hover:shadow-md hover:-translate-y-0.5',
        !active && 'border-slate-200/70 dark:border-slate-800',
      )}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: accent + '1A', color: accent }}>
          <Icon className="w-4 h-4" />
        </span>
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 leading-tight">{label}</p>
      </div>
      <p className="text-2xl font-black text-slate-800 dark:text-slate-100 leading-none">{value}</p>
      {hint && <p className="text-[10px] font-bold text-slate-400 mt-1">{hint}</p>}
    </Tag>
  );
};

// ── Org view (department → head → members) ──────────────────────────────────
type DeptLite = { name: string; code: string; color: string; head_employee_id: string | null; head_employee_name: string | null };
const OrgView: React.FC<{
  employees: ApiEmployee[];
  departments: DeptLite[];
  deptColor: (name: string, i?: number) => string;
  onOpen: (e: ApiEmployee) => void;
}> = ({ employees, departments, deptColor, onOpen }) => {
  const groups = useMemo(() => {
    const byDept = new Map<string, ApiEmployee[]>();
    employees.forEach(e => {
      const name = clean(e.department_name) || 'Unassigned';
      if (!byDept.has(name)) byDept.set(name, []);
      byDept.get(name)!.push(e);
    });
    return Array.from(byDept.entries()).map(([name, members]) => {
      const dept = departments.find(d => clean(d.name) === name);
      // Prefer a real is_manager-flagged member of this department — the
      // fk_manager_id/is_manager hierarchy is what's actually in use (see
      // Workspace tree). Fall back to the legacy hr_department.head_employee_id
      // field, which today is unset for every department but is kept as a
      // fallback in case it's ever populated via the department admin UI.
      const flaggedManager = members.find(m => m.is_manager) ?? null;
      const headId = dept?.head_employee_id ? String(dept.head_employee_id) : null;
      const legacyHead = !flaggedManager && headId ? members.find(m => String(m.pk_employee_id) === headId) ?? null : null;
      const head = flaggedManager ?? legacyHead;
      const rest = head ? members.filter(m => m !== head) : members;
      return { name, color: deptColor(name), headName: dept?.head_employee_name ?? null, head, rest, count: members.length };
    }).sort((a, b) => b.count - a.count);
  }, [employees, departments, deptColor]);

  if (!groups.length) {
    return <Card className="border-none shadow-sm"><CardContent className="py-20 text-center text-slate-400 text-xs font-bold uppercase tracking-widest">No reporting structure to show</CardContent></Card>;
  }

  const MemberChip: React.FC<{ e: ApiEmployee; isHead: boolean }> = ({ e, isHead }) => (
    <button onClick={() => onOpen(e)} className={cn('w-full flex items-center gap-2 px-2.5 py-2 rounded-xl border text-left transition-all hover:shadow-sm',
      isHead ? 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 shadow-sm' : 'bg-slate-50/60 dark:bg-slate-800/40 border-transparent hover:bg-white dark:hover:bg-slate-800')}>
      <span className="w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-black shrink-0" style={{ backgroundColor: deptColor(e.department_name) + '1A', color: deptColor(e.department_name) }}>{initials(e.full_name) || '—'}</span>
      <span className="min-w-0">
        <span className="block text-xs font-bold text-slate-700 dark:text-slate-200 truncate">{clean(e.full_name)}</span>
        <span className="block text-[9px] font-medium text-slate-400 truncate">{(!clean(e.position_title) || clean(e.position_title) === '—' || clean(e.position_title).toLowerCase() === 'engineer') ? 'Employee' : clean(e.position_title)}</span>
      </span>
      {isHead && <span className="ml-auto text-[8px] font-black uppercase text-amber-600 dark:text-amber-400 shrink-0">Manager</span>}
    </button>
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4">
      {groups.map(g => (
        <div key={g.name} className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100 dark:border-slate-800 border-t-2" style={{ borderTopColor: g.color }}>
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: g.color }} />
            <span className="text-sm font-black text-slate-800 dark:text-slate-100 truncate">{g.name}</span>
            <span className="ml-auto text-[10px] font-black text-slate-400">{g.count}</span>
          </div>
          <div className="p-3 space-y-2 max-h-[420px] overflow-y-auto">
            {g.head && <MemberChip e={g.head} isHead />}
            {g.head && g.rest.length > 0 && (
              <div className="pl-3 ml-3 border-l-2 border-slate-100 dark:border-slate-800 space-y-2">
                {g.rest.map(e => <MemberChip key={e.pk_employee_id} e={e} isHead={false} />)}
              </div>
            )}
            {!g.head && g.rest.map(e => <MemberChip key={e.pk_employee_id} e={e} isHead={false} />)}
            {!g.head && g.headName && <p className="text-[10px] text-slate-400 px-1 pt-1">Head: {g.headName} (outside current filter)</p>}
          </div>
        </div>
      ))}
    </div>
  );
};

// ── Per-employee activity timeline (enrollment / consent / biometric audit) ──
interface ActivityEntry { id?: number | string; action: string; details?: string; performedBy?: string; role?: string; source?: string; timestamp: string; }
const actionUi = (action: string): { Icon: typeof History; color: string } => {
  if (action.includes('consent')) return { Icon: ShieldCheck, color: '#3b82f6' };
  if (action.includes('enroll') || action.includes('face')) return { Icon: ScanFace, color: '#8b5cf6' };
  if (action.includes('delete') || action.includes('erase')) return { Icon: Trash2, color: '#ef4444' };
  return { Icon: History, color: '#64748b' };
};
const ActivityDrawer: React.FC<{ emp: ApiEmployee; accessToken?: string | null; scopeHeaders: any; onClose: () => void }> = ({ emp, accessToken, scopeHeaders, onClose }) => {
  const [items, setItems] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiRequest<{ history: ActivityEntry[] }>(`/employees/${emp.pk_employee_id}/enrollment-history`, { accessToken, scopeHeaders })
      .then(res => { if (!cancelled) setItems(res.history ?? []); })
      .catch(() => { if (!cancelled) setItems([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [emp.pk_employee_id]);

  return (
    <div className="fixed inset-0 z-[60] flex justify-end">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md h-full bg-white dark:bg-slate-900 shadow-2xl flex flex-col animate-in slide-in-from-right duration-300">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <div className="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 flex items-center justify-center"><History className="w-4 h-4" /></div>
          <div className="min-w-0">
            <p className="text-sm font-black text-slate-800 dark:text-slate-100 truncate">{clean(emp.full_name)}</p>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Activity timeline</p>
          </div>
          <button onClick={onClose} className="ml-auto p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-12 rounded-xl bg-slate-50 dark:bg-slate-800/50 animate-pulse" />)}</div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <Clock className="w-8 h-8 text-slate-300" />
              <p className="text-xs font-bold text-slate-500 dark:text-slate-300">No recorded activity yet</p>
              <p className="text-[10px] text-slate-400 max-w-[220px]">Enrollment, consent and biometric events will appear here.</p>
            </div>
          ) : (
            <ol className="relative border-l border-slate-200 dark:border-slate-700 ml-2 space-y-5">
              {items.map((it, i) => {
                const ui = actionUi(it.action);
                return (
                  <li key={it.id ?? i} className="ml-5">
                    <span className="absolute -left-[9px] flex items-center justify-center w-4 h-4 rounded-full" style={{ background: ui.color }}><ui.Icon className="w-2.5 h-2.5 text-white" /></span>
                    <p className="text-xs font-bold text-slate-700 dark:text-slate-200">{it.details || it.action}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">{it.performedBy || 'System'}{it.role ? ` · ${it.role}` : ''}{it.source ? ` · ${it.source}` : ''}</p>
                    <p className="text-[10px] font-medium text-slate-400">{new Date(it.timestamp).toLocaleString()}</p>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
};

export const EmployeeLifecycleManagement: React.FC = () => {
  const { departments = [], shifts = [] } = useDepartmentsAndShifts();
  const { accessToken, isAuthenticated, activeScope } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [, setSearchParams] = useSearchParams();
  const [employees, setEmployees] = useState<ApiEmployee[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Employees flagged is_manager — the source for the Reporting Manager
  // picker, kept separate from the paginated `employees` list above so the
  // picker always has the full set of managers regardless of the current
  // page/filter.
  const [managers, setManagers] = useState<{ pk_employee_id: number; full_name: string }[]>([]);
  const loadManagers = useCallback(() => {
    if (!isAuthenticated) return;
    apiRequest<{ data: { pk_employee_id: number; full_name: string }[] }>('/employees/managers', { accessToken, scopeHeaders, noCache: true })
      .then((res: any) => { if (res?.data) setManagers(res.data); })
      .catch(() => null);
  }, [accessToken, isAuthenticated, scopeHeaders]);

  useEffect(() => {
    loadManagers();
  }, [loadManagers]);
  // ── Deep-linked view state (URL query params) ─────────────────────────────
  const [searchTerm, setSearchTerm]   = useQueryParam('q');
  const [localSearchTerm, setLocalSearchTerm] = useState(searchTerm);

  useEffect(() => {
    setLocalSearchTerm(searchTerm);
  }, [searchTerm]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (localSearchTerm !== searchTerm) {
        setSearchTerm(localSearchTerm);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [localSearchTerm, searchTerm, setSearchTerm]);

  const [filterStatus, setFilterStatus] = useQueryParam('status', 'all');
  const [filterDept, setFilterDept]   = useQueryParam('dept', 'all');
  // Driven by the Workspace hierarchy tree's manager nodes — same URL-param
  // pattern as filterDept above. 'unassigned' (literal, lowercase to avoid
  // colliding with a real employee's fk_manager_id string) = no manager set.
  const [filterManager, setFilterManager] = useQueryParam('manager', 'all');
  const [filterConsent, setFilterConsent] = useQueryParam('consent', 'all');
  const [filterLocation, setFilterLocation] = useQueryParam('loc', 'all');
  const [quickFilter, setQuickFilter] = useQueryParam('quick', '');
  // Sort is one URL param encoding key + optional direction, e.g. `name` or `code:desc`.
  const [sortRaw, setSortRaw]         = useQueryParam('sort', 'name');
  const [sortKeyPart, sortDirPart]    = sortRaw.split(':');
  const sortKey: SortKey              = (SORT_KEYS.has(sortKeyPart) ? sortKeyPart : 'name') as SortKey;
  const sortDir: SortDir              = sortDirPart === 'asc' || sortDirPart === 'desc' ? sortDirPart : SORT_DEFAULT_DIR[sortKey];
  const setSort = (key: SortKey) => {
    if (key === sortKey) setSortRaw(`${key}:${sortDir === 'asc' ? 'desc' : 'asc'}`);
    else setSortRaw(key); // new column → its default direction (kept out of the URL)
  };
  const [viewMode, setViewMode]       = useQueryParam('view', 'table');
  const [employeeParam]               = useQueryParam('employee', '');
  const [profileAction]               = useQueryParam('action', '');
  const [page, setPage]               = useNumberQueryParam('page', 1);

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [createdEmployee, setCreatedEmployee] = useState<ApiEmployee | null>(null);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [showFaceEnroll, setShowFaceEnroll] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ApiEmployee | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<ApiEmployee | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ApiEmployee | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkSaving, setBulkSaving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bulkDept, setBulkDept] = useState('');
  const [bulkShift, setBulkShift] = useState('');
  const [bulkManager, setBulkManager] = useState('');
  const [activityTarget, setActivityTarget] = useState<ApiEmployee | null>(null);
  // Employee whose profile is open, resolved from ?employee=<id>. Falls back to a
  // direct fetch when the id isn't in the loaded list (shared link / outside page).
  const [fetchedEmployee, setFetchedEmployee] = useState<ApiEmployee | null>(null);
  const [sites, setSites] = useState<{ id: number; name: string; status?: string }[]>([]);
  // The facet rail is always visible on lg+; on mobile it collapses behind a
  // toggle so it doesn't push the directory far down the page.
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  const PER_PAGE = 10;

  // Reset to page 1 when filters change — but not on first render, so a
  // deep-linked ?page=N survives the initial mount.
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    setPage(1);
  }, [searchTerm, filterStatus, filterDept, filterConsent, filterLocation, quickFilter, sortRaw, viewMode]);

  const [form, setForm] = useState({
    employee_code: '', full_name: '', email: '', position_title: '',
    location_label: '', join_date: new Date().toISOString().slice(0, 10),
    phone_number: '', status: 'active', fk_department_id: '', fk_shift_id: '', fk_manager_id: '',
    is_manager: false,
    site_ids: [] as number[],
  });

  const [editForm, setEditForm] = useState({
    full_name: '', email: '', position_title: '', location_label: '',
    phone_number: '', status: 'active', fk_department_id: '', fk_shift_id: '', fk_manager_id: '',
    is_manager: false,
    site_ids: [] as number[],
  });

  const loadEmployees = async () => {
    if (!isAuthenticated) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiRequest<{ data: ApiEmployee[] }>('/employees', { accessToken, scopeHeaders, noCache: true });
      setEmployees(res.data ?? []);
    } catch (e: any) { setError(e.message); }
    finally { setIsLoading(false); }
  };

  useEffect(() => { loadEmployees(); }, [accessToken, scopeHeaders]);

  // Resolve the deep-linked employee profile from the URL.
  const selectedEmployee = useMemo<ApiEmployee | null>(() => {
    if (!employeeParam) return null;
    return employees.find(e => String(e.pk_employee_id) === String(employeeParam) || e.employee_code === employeeParam)
      ?? (fetchedEmployee && (String(fetchedEmployee.pk_employee_id) === String(employeeParam) || fetchedEmployee.employee_code === employeeParam) ? fetchedEmployee : null);
  }, [employeeParam, employees, fetchedEmployee]);
  // Opening a profile sets ?employee=<id> and always clears any ?action so the
  // enroll-intent (set only by the onboarding "Enroll face now" flow) never leaks
  // onto a different employee. Single setSearchParams call avoids the multi-write race.
  const setSelectedEmployee = (emp: ApiEmployee | null) => {
    setSearchParams(prev => {
      const p = new URLSearchParams(prev);
      p.delete('action');
      if (emp) p.set('employee', String(emp.pk_employee_id)); else p.delete('employee');
      return p;
    }, { replace: true });
  };

  useEffect(() => {
    setSelectedEmployee(null);
  }, [activeScope]);

  // When ?employee=<id> points at someone not in the loaded list, fetch them directly.
  useEffect(() => {
    if (!employeeParam) { setFetchedEmployee(null); return; }
    if (employees.some(e => String(e.pk_employee_id) === employeeParam)) return;
    let cancelled = false;
    apiRequest<ApiEmployee>(`/employees/${employeeParam}`, { accessToken, scopeHeaders })
      .then(res => { if (!cancelled) setFetchedEmployee(res as any); })
      .catch(() => { if (!cancelled) setFetchedEmployee(null); });
    return () => { cancelled = true; };
  }, [employeeParam, employees, accessToken]);

  useEffect(() => {
    apiRequest<{ success: boolean; sites: any[] }>('/site-management/sites', { accessToken, scopeHeaders })
      .then(res => {
        if (res?.success) {
          setSites((res.sites || []).map((s: any) => ({ id: s.pk_site_id, name: s.site_name, status: s.status })));
        }
      })
      .catch(() => setSites([]));
  }, [accessToken, scopeHeaders]);

  const stats = useMemo(() => ({
    total: employees.length,
    active: employees.filter(e => e.status === 'active').length,
    inactive: employees.filter(e => e.status === 'inactive').length,
    enrolled: employees.filter(e => e.face_enrolled).length,
    consented: employees.filter(e => consentState(e) === 'granted').length,
    attention: employees.filter(needsAttention).length,
  }), [employees]);

  // Counts behind each quick-filter chip.
  const quickCounts = useMemo(() => {
    const m = {} as Record<QuickKey, number>;
    QUICK_FILTERS.forEach(qf => { m[qf.key] = employees.filter(qf.test).length; });
    return m;
  }, [employees]);

  // Location rows for the rail (from location_label), sorted by headcount.
  const locationRows = useMemo(() => {
    const counts = new Map<string, number>();
    employees.forEach(e => {
      const loc = clean(e.location_label) || 'Unspecified';
      counts.set(loc, (counts.get(loc) ?? 0) + 1);
    });
    return Array.from(counts.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }, [employees]);

  // Headcount & tenure: cumulative headcount series (last 6 months), joiners this
  // month, and upcoming work anniversaries.
  const workforceTrend = useMemo(() => {
    const now = new Date();
    const months: { key: string; label: string }[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: monthsAgoKey(d), label: d.toLocaleDateString(undefined, { month: 'short' }) });
    }
    const series = months.map(m => ({
      label: m.label,
      count: employees.filter(e => e.join_date && monthsAgoKey(new Date(e.join_date)) <= m.key).length,
    }));
    const joinersThisMonth = employees.filter(e => isNewThisMonth(e.join_date, now)).length;
    const anniversaries = employees
      .map(e => ({ emp: e, days: daysUntilAnniversary(e.join_date, now) }))
      .filter(x => x.days != null)
      .sort((a, b) => (a.days! - b.days!));
    return { series, joinersThisMonth, anniversaries };
  }, [employees]);

  // name -> { code, color }. API returns one colour for all depts today, so when
  // there's no real variety we assign a distinct palette (sorted by name) to keep
  // dots/bars/rail distinguishable. Honours real colours the moment they differ.
  const deptMeta = useMemo(() => {
    const sorted = [...departments].sort((a, b) => clean(a.name).localeCompare(clean(b.name)));
    const useApiColors = new Set(departments.map(d => d.color)).size > 1;
    const m = new Map<string, { code: string; color: string }>();
    sorted.forEach((d, i) => m.set(clean(d.name), {
      code: d.code,
      color: useApiColors ? d.color : DEPT_PALETTE[i % DEPT_PALETTE.length],
    }));
    return m;
  }, [departments]);

  const deptColor = (name: string, i = 0) => deptMeta.get(clean(name))?.color || DEPT_PALETTE[i % DEPT_PALETTE.length];

  // Department rows for the rail: name + headcount, sorted by count desc.
  const deptRows = useMemo(() => {
    const counts = new Map<string, number>();
    employees.forEach(e => {
      const name = clean(e.department_name) || 'Unassigned';
      counts.set(name, (counts.get(name) ?? 0) + 1);
    });
    return Array.from(counts.entries())
      .map(([name, count], i) => ({ name, count, color: deptColor(name, i) }))
      .sort((a, b) => b.count - a.count);
  }, [employees, deptMeta]);

  const quickPredicate = quickFilter === 'attention'
    ? needsAttention
    : QUICK_FILTERS.find(qf => qf.key === quickFilter)?.test;

  const filtered = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    const list = employees.filter(e => {
      const matchSearch = !q ||
        clean(e.full_name).toLowerCase().includes(q) ||
        e.employee_code?.toLowerCase().includes(q) ||
        clean(e.email).toLowerCase().includes(q) ||
        clean(e.department_name).toLowerCase().includes(q) ||
        clean(e.position_title).toLowerCase().includes(q) ||
        clean(e.location_label).toLowerCase().includes(q);
      const matchStatus = filterStatus === 'all' || e.status === filterStatus;
      const matchDept   = filterDept === 'all' || clean(e.department_name) === filterDept || (filterDept === 'Unassigned' && !clean(e.department_name));
      const matchManager = filterManager === 'all' || String(e.fk_manager_id ?? '') === filterManager || (filterManager === 'unassigned' && !e.fk_manager_id);
      const matchConsent = filterConsent === 'all' || consentState(e) === filterConsent;
      const matchLoc    = filterLocation === 'all' || clean(e.location_label) === filterLocation || (filterLocation === 'Unspecified' && !clean(e.location_label));
      const matchQuick  = !quickPredicate || quickPredicate(e);
      return matchSearch && matchStatus && matchDept && matchManager && matchConsent && matchLoc && matchQuick;
    });
    return list.sort((a, b) => {
      const cmp = compareEmployees(a, b, sortKey);
      return sortDir === 'desc' ? -cmp : cmp;
    });
  }, [employees, searchTerm, filterStatus, filterDept, filterManager, filterConsent, filterLocation, quickFilter, sortKey, sortDir]);

  const total = filtered.length;
  const totalPages = Math.ceil(total / PER_PAGE);
  const pagedList = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const activeFilters = (filterStatus !== 'all' ? 1 : 0) + (filterDept !== 'all' ? 1 : 0) + (filterManager !== 'all' ? 1 : 0) + (filterConsent !== 'all' ? 1 : 0) + (filterLocation !== 'all' ? 1 : 0) + (quickFilter ? 1 : 0) + (searchTerm ? 1 : 0);
  // Clear every filter param in ONE setSearchParams call. Doing it via the
  // individual useQueryParam setters would fire several navigations in the same
  // tick — each starting from the original URL — so only the last would stick.
  const resetFilters = () => {
    setSearchParams(prev => {
      const p = new URLSearchParams(prev);
      ['q', 'status', 'dept', 'manager', 'consent', 'loc', 'quick', 'page'].forEach(k => p.delete(k));
      return p;
    }, { replace: true });
  };

  // Validation for the "Onboard New Talent" dialog.
  const addEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());
  const addReady = !!clean(form.full_name) && !!clean(form.employee_code) && addEmailValid && !!form.fk_department_id && !!form.fk_shift_id;
  const addPreviewDept = departments.find(d => String(d.pk_department_id) === form.fk_department_id)?.name;
  const addPreviewShift = shifts.find(s => String(s.pk_shift_id) === form.fk_shift_id)?.name;

  const exportCSV = (rows: ApiEmployee[], scopeLabel: string) => {
    if (!rows.length) { toast.error('Nothing to export'); return; }
    const headers = ['Employee Code', 'Full Name', 'Email', 'Phone', 'Department', 'Shift', 'Location', 'Status', 'Face Enrolled', 'Angles', 'Consent', 'Position'];
    const body = rows.map(e => [
      e.employee_code, clean(e.full_name), clean(e.email), clean(e.phone_number), clean(e.department_name),
      clean(e.shift_name), clean(e.location_label), e.status, e.face_enrolled ? 'Yes' : 'No', e.embedding_count ?? 0,
      consentState(e), clean(e.position_title) || '—',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const csv = [headers.join(','), ...body].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `employees-${scopeLabel}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast.success(`Exported ${rows.length} ${scopeLabel} record(s)`);
  };
  const exportEmployeesCSV = () => exportCSV(employees, 'all');

  const toggleSelect = (id: number) =>
    setSelectedIds(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  const toggleSelectAll = () =>
    setSelectedIds(prev => prev.size === filtered.length ? new Set() : new Set(filtered.map(e => e.pk_employee_id)));

  const handleBulkStatus = async (status: 'active' | 'inactive') => {
    if (!selectedIds.size) return;
    setBulkSaving(true);
    try {
      await Promise.all([...selectedIds].map(id =>
        apiRequest(`/employees/${id}`, { method: 'PUT', accessToken, scopeHeaders, body: JSON.stringify({ status }) })
      ));
      toast.success(`${selectedIds.size} employee(s) set to ${status}`);
      setSelectedIds(new Set());
      loadEmployees();
    } catch { toast.error('Bulk update failed'); }
    finally { setBulkSaving(false); }
  };

  const selectedEmployees = () => employees.filter(e => selectedIds.has(e.pk_employee_id));

  const handleBulkAssign = async (patch: { fk_department_id?: number; fk_shift_id?: number; fk_manager_id?: number }, label: string) => {
    if (!selectedIds.size) return;
    if (patch.fk_manager_id != null && selectedIds.has(patch.fk_manager_id)) {
      toast.error('An employee cannot be their own manager');
      return;
    }
    setBulkSaving(true);
    try {
      await Promise.all([...selectedIds].map(id =>
        apiRequest(`/employees/${id}`, { method: 'PUT', accessToken, scopeHeaders, body: JSON.stringify(patch) })
      ));
      toast.success(`${selectedIds.size} employee(s) assigned to ${label}`);
      setSelectedIds(new Set()); setBulkDept(''); setBulkShift(''); setBulkManager('');
      loadEmployees();
    } catch { toast.error('Bulk assignment failed'); }
    finally { setBulkSaving(false); }
  };

  // Sends self-enrollment invitations (which also capture biometric consent).
  const handleBulkInvite = async () => {
    if (!selectedIds.size) return;
    setBulkSaving(true);
    try {
      const res = await apiRequest<{ summary?: { sent: number; skipped: number; failed: number }; results?: { sent?: any[]; failed?: any[]; skipped?: any[] } }>('/enrollment/send-invitations', {
        method: 'POST', accessToken, scopeHeaders,
        body: JSON.stringify({ employeeIds: [...selectedIds] }),
      });
      const sent = res.summary?.sent ?? res.results?.sent?.length ?? 0;
      const skipped = res.summary?.skipped ?? res.results?.skipped?.length ?? 0;
      const failed = res.summary?.failed ?? res.results?.failed?.length ?? 0;
      toast.success(`${sent} invite(s) sent${skipped ? `, ${skipped} skipped` : ''}${failed ? `, ${failed} failed` : ''}`);
      setSelectedIds(new Set());
      loadEmployees();
    } catch (e: any) { toast.error(e.message ?? 'Failed to send invitations'); }
    finally { setBulkSaving(false); }
  };

  const openEdit = (emp: ApiEmployee) => {
    setEditTarget(emp);
    setEditForm({
      full_name: emp.full_name,
      email: emp.email,
      position_title: emp.position_title,
      location_label: emp.location_label ?? '',
      phone_number: emp.phone_number ?? '',
      status: emp.status,
      fk_department_id: emp.fk_department_id ? String(emp.fk_department_id) : '',
      fk_shift_id: emp.fk_shift_id ? String(emp.fk_shift_id) : '',
      fk_manager_id: emp.fk_manager_id ? String(emp.fk_manager_id) : '',
      is_manager: !!emp.is_manager,
      site_ids: emp.site_ids ?? (emp.site_id ? [emp.site_id] : []),
    });
    setIsEditOpen(true);
  };

  const handleEdit = async () => {
    if (!editTarget) return;
    setSaving(true);
    try {
      if (editForm.site_ids && editForm.site_ids.length > 0) {
        const inactiveSelected = sites.filter(s => editForm.site_ids.includes(s.id) && s.status === 'inactive');
        if (inactiveSelected.length > 0) {
          toast.error(`Cannot assign employee to an inactive site: ${inactiveSelected.map(s => s.name).join(', ')}. Please activate the site first.`);
          setSaving(false);
          return;
        }
      }
      await apiRequest(`/employees/${editTarget.pk_employee_id}`, {
        method: 'PUT', accessToken, scopeHeaders,
        body: JSON.stringify({
          ...editForm,
          fk_department_id: editForm.fk_department_id ? Number(editForm.fk_department_id) : null,
          fk_shift_id: editForm.fk_shift_id ? Number(editForm.fk_shift_id) : null,
          fk_manager_id: editForm.fk_manager_id ? Number(editForm.fk_manager_id) : null,
          site_ids: editForm.site_ids?.map(Number)
        }),
      });
      toast.success('Employee updated');
      setIsEditOpen(false);
      invalidateApiCache('/employees');
      invalidateApiCache('/live');
      setFetchedEmployee(null);
      await loadEmployees();
    } catch (e: any) { toast.error(e.message ?? 'Update failed'); }
    finally { setSaving(false); }
  };

  const handleDeactivate = async () => {
    if (!deactivateTarget) return;
    try {
      await apiRequest(`/employees/${deactivateTarget.pk_employee_id}`, {
        method: 'PUT', accessToken, scopeHeaders,
        body: JSON.stringify({ status: 'inactive' }),
      });
      toast.success(`${clean(deactivateTarget.full_name)} deactivated`);
      setDeactivateTarget(null);
      invalidateApiCache('/employees');
      invalidateApiCache('/live');
      setFetchedEmployee(null);
      await loadEmployees();
    } catch (e: any) { toast.error(e.message ?? 'Deactivation failed'); }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiRequest(`/employees/${deleteTarget.pk_employee_id}`, {
        method: 'DELETE', accessToken, scopeHeaders,
      });
      toast.success(`${clean(deleteTarget.full_name)} deleted`);
      setDeleteTarget(null);
      invalidateApiCache('/employees');
      invalidateApiCache('/live');
      setFetchedEmployee(null);
      await loadEmployees();
    } catch (e: any) { toast.error(e.message ?? 'Delete failed'); }
  };

  const blankForm = () => ({
    employee_code: '', full_name: '', email: '', position_title: '',
    location_label: '', join_date: new Date().toISOString().slice(0, 10),
    phone_number: '', status: 'active', fk_department_id: '', fk_shift_id: '', fk_manager_id: '',
    is_manager: false,
    site_ids: [] as number[],
  });

  const handleAdd = async () => {
    setSaving(true);
    try {
      if (form.site_ids && form.site_ids.length > 0) {
        const inactiveSelected = sites.filter(s => form.site_ids.includes(s.id) && s.status === 'inactive');
        if (inactiveSelected.length > 0) {
          toast.error(`Cannot onboard employee to an inactive site: ${inactiveSelected.map(s => s.name).join(', ')}. Please activate the site first.`);
          setSaving(false);
          return;
        }
      }
      const created = await apiRequest<ApiEmployee>('/employees', {
        method: 'POST', accessToken, scopeHeaders, timeoutMs: 60000,
        body: JSON.stringify({ 
          ...form,
          fk_department_id: form.fk_department_id ? Number(form.fk_department_id) : undefined,
          fk_shift_id: form.fk_shift_id ? Number(form.fk_shift_id) : undefined,
          fk_manager_id: form.fk_manager_id ? Number(form.fk_manager_id) : undefined,
          site_ids: form.site_ids?.map(Number)
        }),
      });
      toast.success('Employee onboarded');
      setCreatedEmployee({ ...created, full_name: created.full_name || form.full_name }); // show success step
      setForm(blankForm());
      invalidateApiCache('/employees');
      invalidateApiCache('/live');
      setFetchedEmployee(null);
      await loadEmployees();
      loadManagers();
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  useEffect(() => {
    if (isAddOpen) {
      loadManagers();
    } else {
      setForm(blankForm());
      setCreatedEmployee(null);
    }
  }, [isAddOpen, loadManagers]);

  const closeAddDialog = () => { 
    setIsAddOpen(false); 
  };
  // Jump to the new hire's profile with the enroll panel auto-opened (?action=enroll).
  const enrollNewHire = () => {
    const emp = createdEmployee;
    closeAddDialog();
    if (!emp) return;
    setSearchParams(prev => {
      const p = new URLSearchParams(prev);
      p.set('employee', String(emp.pk_employee_id));
      p.set('action', 'enroll');
      return p;
    }, { replace: true });
  };

  // ── Shared bits ───────────────────────────────────────────────────────────
  const RowActions = ({ emp }: { emp: ApiEmployee }) => (
    <>
      {!emp.face_enrolled && (
        <Button variant="ghost" size="sm" title="Enroll face" className="h-8 w-8 p-0 text-slate-400 hover:text-violet-600" onClick={() => setSelectedEmployee(emp)}>
          <ScanFace className="w-3.5 h-3.5" />
        </Button>
      )}
      <Button variant="ghost" size="sm" title="Activity" className="h-8 w-8 p-0 text-slate-400 hover:text-indigo-600" onClick={() => setActivityTarget(emp)}><History className="w-3.5 h-3.5" /></Button>
      <Button variant="ghost" size="sm" title="Edit" className="h-8 w-8 p-0 text-slate-400 hover:text-blue-600" onClick={() => openEdit(emp)}><Edit className="w-3.5 h-3.5" /></Button>
      <Button variant="ghost" size="sm" title="Deactivate" className="h-8 w-8 p-0 text-slate-400 hover:text-rose-600" disabled={emp.status === 'inactive'} onClick={() => setDeactivateTarget(emp)}><UserMinus className="w-3.5 h-3.5" /></Button>
      <Button variant="ghost" size="sm" title="Delete employee" className="h-8 w-8 p-0 text-slate-400 hover:text-red-700" onClick={() => setDeleteTarget(emp)}><Trash2 className="w-3.5 h-3.5" /></Button>
    </>
  );

  const Avatar = ({ emp, size = 'md' }: { emp: ApiEmployee; size?: 'md' | 'lg' }) => {
    const color = deptColor(emp.department_name);
    return (
      <div className="relative shrink-0">
        <div
          className={cn('rounded-2xl flex items-center justify-center font-black shadow-sm',
            size === 'lg' ? 'w-12 h-12 text-sm' : 'w-10 h-10 text-xs')}
          style={{ backgroundColor: color + '1A', color }}
        >
          {initials(emp.full_name) || '—'}
        </div>
        <span
          title={emp.status === 'active' ? 'Active' : 'Inactive'}
          className={cn('absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-white dark:border-slate-900',
            size === 'lg' ? 'w-3.5 h-3.5' : 'w-3 h-3',
            emp.status === 'active' ? 'bg-emerald-500' : 'bg-rose-400')}
        />
      </div>
    );
  };

  // ── Early screens ─────────────────────────────────────────────────────────
  if (selectedEmployee) return (
    <EmployeeProfileDashboard
      key={selectedEmployee.pk_employee_id || selectedEmployee.employee_code}
      canEnroll={true}
      autoEnroll={profileAction === 'enroll'}
      employee={selectedEmployee as any}
      onBack={() => setSelectedEmployee(null)}
    />
  );

  if (isLoading && employees.length === 0) {
    return (
      <div className="space-y-5 animate-in fade-in duration-300" aria-busy="true" aria-label="Loading employees">
        {/* hero */}
        <div className="h-36 rounded-3xl bg-gradient-to-br from-slate-100 to-slate-200/70 dark:from-slate-800 dark:to-slate-800/60 animate-pulse" />
        {/* widgets */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-24 rounded-2xl bg-slate-100 dark:bg-slate-800 animate-pulse" />)}
        </div>
        {/* quick-filter chips */}
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-8 w-28 rounded-full bg-slate-100 dark:bg-slate-800 animate-pulse" />)}
        </div>
        {/* rail + directory */}
        <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-5">
          <div className="hidden lg:block h-96 rounded-2xl bg-slate-100 dark:bg-slate-800 animate-pulse" />
          <div className="space-y-3">
            {Array.from({ length: 7 }).map((_, i) => <div key={i} className="h-16 rounded-xl bg-slate-50 dark:bg-slate-800/50 animate-pulse" />)}
          </div>
        </div>
      </div>
    );
  }

  if (error && employees.length === 0) {
    return (
      <Card className="border-none shadow-sm">
        <CardContent className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <AlertCircle className="w-8 h-8 text-rose-500" />
          <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Couldn't load employees</p>
          <p className="text-xs text-slate-400 max-w-sm">{error}</p>
          <Button size="sm" variant="outline" onClick={loadEmployees} className="rounded-xl font-bold mt-1">
            <RefreshCw className="w-3.5 h-3.5 mr-2" />Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  // ── Reusable left-rail filter section ─────────────────────────────────────
  const RailSection = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="space-y-2">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 px-1">{title}</p>
      {children}
    </div>
  );

  return (
    <div className="space-y-5">

      {/* ── HEADER CARD ─────────────────────────────────────────────────── */}
      <div className="rounded-3xl bg-white dark:bg-slate-900 border border-slate-200/70 dark:border-slate-800 shadow-sm p-5 sm:p-6">
        <div className="flex flex-col lg:flex-row lg:items-center gap-4 justify-between">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/25 shrink-0">
              <Users className="w-6 h-6 text-white" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-black uppercase tracking-widest text-slate-400">Workforce Directory</p>
              <h1 className="text-2xl font-black text-slate-800 dark:text-slate-100 tracking-tight leading-tight">Employee Management</h1>
              <p className="text-xs text-slate-400 font-medium mt-0.5">Full lifecycle, biometrics &amp; GDPR consent</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={exportEmployeesCSV} className="rounded-xl font-bold border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"><Download className="w-3.5 h-3.5 mr-2" />Export</Button>
            <Button variant="outline" size="sm" onClick={() => setShowBulkImport(true)} className="rounded-xl font-bold border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"><Upload className="w-3.5 h-3.5 mr-2" />Import</Button>
            <Button variant="outline" size="sm" onClick={() => setShowFaceEnroll(true)} className="rounded-xl font-bold border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"><Camera className="w-3.5 h-3.5 mr-2" />Face Enroll</Button>
          <Dialog open={isAddOpen} onOpenChange={o => {
            if (o) setIsAddOpen(true);
            else closeAddDialog();
          }}>
            <DialogTrigger asChild><Button size="sm" className="rounded-xl font-bold bg-gradient-to-br from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-md shadow-blue-500/20"><UserPlus className="w-3.5 h-3.5 mr-2" />Add Employee</Button></DialogTrigger>
            <DialogContent className="max-w-2xl rounded-2xl border-none p-0 overflow-hidden max-h-[92vh] flex flex-col gap-0">
              {/* Header band */}
              <DialogHeader className="space-y-0 p-6 pb-5 bg-gradient-to-br from-blue-600 via-indigo-600 to-violet-700 text-left">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-2xl bg-white/15 backdrop-blur-sm flex items-center justify-center shrink-0"><UserPlus className="w-5 h-5 text-white" /></div>
                  <div>
                    <DialogTitle className="font-black text-xl text-white">Onboard New Talent</DialogTitle>
                    <p className="text-xs font-medium text-white/70">{createdEmployee ? 'Step 2 of 2 — biometric enrollment' : 'Add a team member and set up their profile & placement'}</p>
                  </div>
                </div>
              </DialogHeader>

              {createdEmployee ? (
                <>
                  <div className="p-8 flex flex-col items-center text-center gap-4 overflow-y-auto">
                    <div className="w-16 h-16 rounded-full bg-emerald-50 dark:bg-emerald-500/15 flex items-center justify-center"><CheckCircle2 className="w-8 h-8 text-emerald-500" /></div>
                    <div>
                      <p className="text-lg font-black text-slate-800 dark:text-slate-100">{clean(createdEmployee.full_name)} onboarded 🎉</p>
                      <p className="text-xs font-medium text-slate-400 mt-1 max-w-xs">One step left — enroll their face so cameras can recognise them at check-in.</p>
                    </div>
                    <div className="inline-flex items-center gap-2 text-[11px] font-bold text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-500/15 rounded-xl px-3 py-2">
                      <ScanFace className="w-4 h-4" /> Face not enrolled yet
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-5 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                    <Button variant="ghost" onClick={() => setCreatedEmployee(null)} className="rounded-xl font-bold text-slate-500"><UserPlus className="w-4 h-4 mr-1.5" />Add another</Button>
                    <div className="flex gap-2 ml-auto">
                      <Button variant="outline" onClick={closeAddDialog} className="rounded-xl font-bold">Done</Button>
                      <Button onClick={enrollNewHire} className="bg-violet-600 hover:bg-violet-700 text-white rounded-xl font-bold px-6"><ScanFace className="w-4 h-4 mr-2" />Enroll face now</Button>
                    </div>
                  </div>
                </>
              ) : (
              <>
              <div className="p-6 space-y-6 overflow-y-auto">
                {/* Live preview */}
                <div className="flex items-center gap-3 p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800">
                  <div className="w-12 h-12 rounded-2xl flex items-center justify-center font-black text-sm shrink-0 shadow-sm"
                    style={{ backgroundColor: deptColor(addPreviewDept ?? '') + '1A', color: deptColor(addPreviewDept ?? '') }}>
                    {initials(form.full_name) || <User className="w-5 h-5 opacity-50" />}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-black text-slate-800 dark:text-slate-100 truncate">{clean(form.full_name) || 'New employee'}</p>
                    <p className="text-[11px] font-medium text-slate-400 truncate">
                      {clean(form.position_title) || 'No title'}{addPreviewDept ? ` · ${addPreviewDept}` : ''}{addPreviewShift ? ` · ${addPreviewShift}` : ''}
                    </p>
                  </div>
                  {form.employee_code && <span className="ml-auto text-[10px] font-mono font-bold text-slate-400 shrink-0">{form.employee_code}</span>}
                </div>

                {/* Identity */}
                <div className="space-y-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Identity</p>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-[10px] font-black uppercase text-slate-400">Full Name <span className="text-rose-500">*</span></Label>
                      <div className="relative"><User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" /><Input value={form.full_name} onChange={e => setForm({ ...form, full_name: e.target.value })} placeholder="e.g. Priya Sharma" className="pl-9 rounded-xl" /></div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] font-black uppercase text-slate-400">Employee ID <span className="text-rose-500">*</span></Label>
                      <div className="relative"><Hash className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" /><Input value={form.employee_code} onChange={e => setForm({ ...form, employee_code: e.target.value })} placeholder="e.g. MLII90" className="pl-9 rounded-xl font-mono" /></div>
                    </div>
                  </div>
                </div>

                {/* Contact */}
                <div className="space-y-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Contact</p>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-[10px] font-black uppercase text-slate-400">Email Address <span className="text-rose-500">*</span></Label>
                      <div className="relative"><Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" /><Input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="name@company.com" className={cn('pl-9 rounded-xl', form.email && !addEmailValid && 'border-rose-300 focus-visible:ring-rose-200')} /></div>
                      {form.email && !addEmailValid && <p className="text-[10px] font-bold text-rose-500">Enter a valid email address</p>}
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] font-black uppercase text-slate-400">Phone Number</Label>
                      <div className="relative"><Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" /><Input value={form.phone_number} onChange={e => setForm({ ...form, phone_number: e.target.value })} placeholder="Optional" className="pl-9 rounded-xl" /></div>
                    </div>
                  </div>
                </div>

                {/* Role & placement */}
                <div className="space-y-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Role &amp; placement</p>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-[10px] font-black uppercase text-slate-400">Title</Label>
                      <div className="relative"><Briefcase className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" /><Input value={form.position_title} onChange={e => setForm({ ...form, position_title: e.target.value })} placeholder="e.g. Employee" className="pl-9 rounded-xl" /></div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] font-black uppercase text-slate-400">Location</Label>
                      <div className="relative"><MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" /><Input value={form.location_label} onChange={e => setForm({ ...form, location_label: e.target.value })} placeholder="e.g. Madhapur" className="pl-9 rounded-xl" /></div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] font-black uppercase text-slate-400">Department <span className="text-rose-500">*</span></Label>
                      <Select value={form.fk_department_id} onValueChange={v => setForm({ ...form, fk_department_id: v })}>
                        <SelectTrigger className="rounded-xl"><SelectValue placeholder="Select department" /></SelectTrigger>
                        <SelectContent>{departments.map(d => <SelectItem key={d.pk_department_id} value={String(d.pk_department_id)}>{d.name}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] font-black uppercase text-slate-400">Shift <span className="text-rose-500">*</span></Label>
                      <Select value={form.fk_shift_id} onValueChange={v => setForm({ ...form, fk_shift_id: v })}>
                        <SelectTrigger className="rounded-xl"><SelectValue placeholder="Select shift" /></SelectTrigger>
                        <SelectContent>{shifts.map(s => <SelectItem key={s.pk_shift_id} value={String(s.pk_shift_id)}>{s.name}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] font-black uppercase text-slate-400">Reporting Manager</Label>
                      <Select value={form.fk_manager_id || '__none__'} onValueChange={v => setForm({ ...form, fk_manager_id: v === '__none__' ? '' : v })}>
                        <SelectTrigger className="rounded-xl"><SelectValue placeholder="Select manager (optional)" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">None (Optional)</SelectItem>
                          {managers.map(m => <SelectItem key={m.pk_employee_id} value={String(m.pk_employee_id)}>{m.full_name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1 flex items-end pb-1.5">
                      <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer text-slate-700">
                        <input
                          type="checkbox"
                          checked={form.is_manager}
                          onChange={e => setForm({ ...form, is_manager: e.target.checked })}
                          className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        />
                        Is a Manager
                      </label>
                    </div>
                  </div>
                </div>
                <div className="col-span-2 space-y-1.5">
                  <Label className="text-[10px] font-black uppercase text-slate-400">Assign Sites / Branches</Label>
                  <div className="grid grid-cols-2 gap-2 border rounded-xl p-3 bg-slate-50 max-h-32 overflow-y-auto">
                    {sites.map(s => {
                      const isChecked = form.site_ids?.includes(s.id);
                      return (
                        <label key={s.id} className="flex items-center gap-2 text-xs font-semibold cursor-pointer text-slate-700">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={e => {
                              const newIds = e.target.checked
                                ? [...(form.site_ids || []), s.id]
                                : (form.site_ids || []).filter(id => id !== s.id);
                              setForm({ ...form, site_ids: newIds });
                            }}
                            className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                          />
                          {s.name}
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div className="flex items-center gap-3 p-5 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                <p className="text-[10px] font-bold text-slate-400 hidden sm:block">
                  {addReady ? <span className="text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />Ready to onboard</span> : <span className="text-amber-600 dark:text-amber-400">Fill required fields (*)</span>}
                </p>
                <div className="flex gap-2 ml-auto">
                  <Button variant="outline" className="rounded-xl font-bold" onClick={closeAddDialog}>Cancel</Button>
                  <Button onClick={handleAdd} disabled={saving || !addReady} className="bg-blue-600 hover:bg-blue-700 font-bold rounded-xl px-6">
                    {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <UserPlus className="w-4 h-4 mr-2" />}Complete Onboarding
                  </Button>
                </div>
              </div>
              </>
              )}
            </DialogContent>
          </Dialog>
          </div>
        </div>

        {/* KPI STAT CARDS */}
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3 mt-5">
          <StatCard icon={Users} accent="#3b82f6" label="Headcount" value={stats.total} hint={`${stats.active} active`} />
          <StatCard icon={ScanFace} accent="#8b5cf6" label="Enrolled" value={`${pct(stats.enrolled, stats.total)}%`} hint={`${stats.enrolled} of ${stats.total}`} />
          <StatCard icon={ShieldCheck} accent="#10b981" label="Consent" value={`${pct(stats.consented, stats.total)}%`} hint={`${stats.consented} of ${stats.total}`} />
          <StatCard icon={Building2} accent="#6366f1" label="Departments" value={deptRows.length} hint={`${shifts.length} shift${shifts.length === 1 ? '' : 's'}`} />
          <StatCard icon={AlertCircle} accent="#f59e0b" label="Needs attention" value={stats.attention} hint="incomplete records" active={quickFilter === 'attention'} onClick={() => setQuickFilter(quickFilter === 'attention' ? '' : 'attention')} />
        </div>
      </div>

      {/* ── HEADCOUNT & TENURE WIDGETS ──────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 shadow-sm p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Headcount trend</p>
            <span className="text-[10px] font-black text-emerald-600 dark:text-emerald-400">+{workforceTrend.joinersThisMonth} this mo</span>
          </div>
          <div className="flex items-end gap-3">
            {(() => {
              const s = workforceTrend.series;
              const counts = s.map(p => p.count);
              const max = Math.max(1, ...counts), min = Math.min(...counts);
              const W = 200, H = 36;
              const pts = s.map((p, i) => {
                const x = s.length > 1 ? (i / (s.length - 1)) * W : 0;
                const y = H - ((p.count - min) / Math.max(1, max - min)) * (H - 4) - 2;
                return `${x.toFixed(1)},${y.toFixed(1)}`;
              }).join(' ');
              return (
                <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-9" preserveAspectRatio="none" aria-hidden="true">
                  <polyline points={pts} fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
                </svg>
              );
            })()}
            <span className="text-2xl font-black text-slate-800 dark:text-slate-100 leading-none shrink-0">{stats.total}</span>
          </div>
        </div>

        <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 shadow-sm p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">New joiners</p>
          <h2 className="text-3xl font-black text-slate-800 dark:text-slate-100 mt-1 leading-none">{workforceTrend.joinersThisMonth}</h2>
          <button onClick={() => setQuickFilter(quickFilter === 'new_month' ? '' : 'new_month')} className="text-[10px] font-bold text-blue-600 dark:text-blue-400 mt-2 hover:underline">this month →</button>
        </div>

        <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 shadow-sm p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Anniversaries · next 30d</p>
          {workforceTrend.anniversaries.length === 0 ? (
            <p className="text-xs font-medium text-slate-400">None coming up</p>
          ) : (
            <div className="space-y-1.5">
              {workforceTrend.anniversaries.slice(0, 3).map(({ emp, days }) => (
                <button key={emp.pk_employee_id} onClick={() => setSelectedEmployee(emp)} className="w-full flex items-center gap-2 text-left group">
                  <span className="text-sm">🎉</span>
                  <span className="text-xs font-bold text-slate-700 dark:text-slate-200 truncate group-hover:text-blue-600">{clean(emp.full_name)}</span>
                  <span className="ml-auto text-[10px] font-black text-slate-400 shrink-0">{days === 0 ? 'today' : `${days}d`}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── QUICK-FILTER CHIPS ───────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        {QUICK_FILTERS.map(qf => {
          const active = quickFilter === qf.key;
          const count = quickCounts[qf.key];
          const disabled = count === 0 && !active;
          return (
            <button
              key={qf.key}
              disabled={disabled}
              onClick={() => setQuickFilter(active ? '' : qf.key)}
              style={active ? { backgroundColor: qf.color, borderColor: qf.color } : { borderColor: qf.color + '55' }}
              className={cn('inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border transition-all',
                active ? 'text-white shadow-sm' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/60',
                disabled && 'opacity-40 cursor-not-allowed')}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: active ? '#fff' : qf.color }} />
              {qf.label}
              <span className={cn('text-[10px] font-black', active ? 'text-white/80' : 'text-slate-400')}>{count}</span>
            </button>
          );
        })}
        {quickFilter === 'attention' && (
          <button onClick={() => setQuickFilter('')} style={{ backgroundColor: '#f59e0b', borderColor: '#f59e0b' }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border text-white shadow-sm">
            <AlertCircle className="w-3 h-3" />Needs attention <span className="text-white/80 text-[10px] font-black">{stats.attention}</span>
          </button>
        )}
      </div>

      {/* ── BODY: filter rail + directory ───────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-5 items-start">

        {/* LEFT RAIL */}
        <aside className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/70 dark:border-slate-800 shadow-sm p-4 space-y-4 lg:sticky lg:top-24 h-fit">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input
              placeholder="Search people..."
              value={localSearchTerm}
              onChange={e => setLocalSearchTerm(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  setSearchTerm(localSearchTerm);
                }
              }}
              className="pl-9 pr-8 rounded-xl border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/60"
            />
            {localSearchTerm && (
              <button
                type="button"
                onClick={() => {
                  setLocalSearchTerm('');
                  setSearchTerm('');
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                title="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Mobile-only toggle for the facet list (always expanded on lg+). */}
          <button
            onClick={() => setMobileFiltersOpen(o => !o)}
            aria-expanded={mobileFiltersOpen}
            className="lg:hidden w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800/60 text-xs font-bold text-slate-600 dark:text-slate-300"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            Filters
            {activeFilters > 0 && (
              <span className="px-1.5 py-0.5 rounded-md bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300 text-[10px] font-black">{activeFilters}</span>
            )}
            <ChevronDown className={cn('w-4 h-4 ml-auto transition-transform', mobileFiltersOpen && 'rotate-180')} />
          </button>

          <div className={cn('space-y-5', mobileFiltersOpen ? 'block' : 'hidden', 'lg:block')}>
          <RailSection title="Status">
            <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-800">
              {(['all', 'active', 'inactive'] as const).map(s => (
                <button key={s} onClick={() => setFilterStatus(s)}
                  className={cn('flex-1 px-2 py-1.5 text-xs font-bold rounded-lg capitalize transition-all',
                    filterStatus === s ? 'bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 shadow-sm' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300')}>
                  {s === 'all' ? 'All' : s}
                </button>
              ))}
            </div>
          </RailSection>

          <RailSection title="Consent">
            <div className="space-y-1">
              {(['all', 'granted', 'pending', 'withdrawn'] as const).map(c => {
                const active = filterConsent === c;
                const count = c === 'all' ? stats.total : employees.filter(e => consentState(e) === c).length;
                return (
                  <button key={c} onClick={() => setFilterConsent(c)}
                    className={cn('w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-bold capitalize transition-all',
                      active ? 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/60')}>
                    {c !== 'all' && <span className={cn('w-2 h-2 rounded-full', CONSENT_UI[c].dot)} />}
                    {c === 'all' ? 'All consent' : c}
                    <span className={cn('ml-auto text-[10px] font-black', active ? 'text-blue-500' : 'text-slate-400')}>{count}</span>
                  </button>
                );
              })}
            </div>
          </RailSection>

          <RailSection title="Departments">
            <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
              <button onClick={() => setFilterDept('all')}
                className={cn('w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all',
                  filterDept === 'all' ? 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/60')}>
                <Building2 className="w-3.5 h-3.5" /> All departments
                <span className={cn('ml-auto text-[10px] font-black', filterDept === 'all' ? 'text-blue-500' : 'text-slate-400')}>{stats.total}</span>
              </button>
              {deptRows.map(d => {
                const active = filterDept === d.name;
                return (
                  <button key={d.name} onClick={() => setFilterDept(active ? 'all' : d.name)}
                    className={cn('w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all',
                      active ? 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/60')}>
                    <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: d.color }} />
                    <span className="truncate">{d.name}</span>
                    <span className={cn('ml-auto text-[10px] font-black', active ? 'text-blue-500' : 'text-slate-400')}>{d.count}</span>
                  </button>
                );
              })}
            </div>
          </RailSection>

          {locationRows.length > 1 && (
            <RailSection title="Location">
              <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
                <button onClick={() => setFilterLocation('all')}
                  className={cn('w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all',
                    filterLocation === 'all' ? 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/60')}>
                  <MapPin className="w-3.5 h-3.5" /> All locations
                  <span className={cn('ml-auto text-[10px] font-black', filterLocation === 'all' ? 'text-blue-500' : 'text-slate-400')}>{stats.total}</span>
                </button>
                {locationRows.map(l => {
                  const active = filterLocation === l.name;
                  return (
                    <button key={l.name} onClick={() => setFilterLocation(active ? 'all' : l.name)}
                      className={cn('w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all',
                        active ? 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/60')}>
                      <MapPin className="w-3 h-3 shrink-0 opacity-60" />
                      <span className="truncate">{l.name}</span>
                      <span className={cn('ml-auto text-[10px] font-black', active ? 'text-blue-500' : 'text-slate-400')}>{l.count}</span>
                    </button>
                  );
                })}
              </div>
            </RailSection>
          )}

          {activeFilters > 0 && (
            <Button variant="ghost" size="sm" onClick={resetFilters} className="w-full rounded-xl text-xs font-bold text-slate-500 hover:text-slate-700">
              <X className="w-3.5 h-3.5 mr-1.5" />Clear {activeFilters} filter{activeFilters === 1 ? '' : 's'}
            </Button>
          )}
          </div>
        </aside>

        {/* MAIN DIRECTORY */}
        <div className="space-y-4 min-w-0">

          {/* toolbar: count + sort + view toggle */}
          <div className="flex items-center gap-3 flex-wrap">
            <p className="text-sm font-bold text-slate-600 dark:text-slate-300">
              {total} <span className="text-slate-400 font-medium">{total === 1 ? 'person' : 'people'}{activeFilters > 0 ? ' matched' : ''}</span>
            </p>
            <div className="flex items-center gap-2 ml-auto">
              <Select value={sortKey} onValueChange={v => setSort(v as SortKey)}>
                <SelectTrigger className="h-9 w-[180px] rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm text-xs font-bold text-slate-600 dark:text-slate-300">
                  <ArrowUpDown className="w-3.5 h-3.5 mr-1.5 text-slate-400" /><SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-xl">
                  {SORTS.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-800">
                {([['table', List], ['grid', LayoutGrid], ['org', Network]] as const).map(([mode, Icon]) => (
                  <button key={mode} onClick={() => setViewMode(mode)} title={`${mode} view`}
                    className={cn('p-1.5 rounded-lg transition-all', viewMode === mode ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-sm' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300')}>
                    <Icon className="w-4 h-4" />
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* bulk action bar */}
          {selectedIds.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/30 rounded-xl">
              <span className="text-sm font-bold text-blue-700 dark:text-blue-300 mr-1">{selectedIds.size} selected</span>
              <Select value={bulkDept} onValueChange={v => handleBulkAssign({ fk_department_id: Number(v) }, departments.find(d => String(d.pk_department_id) === v)?.name ?? 'department')}>
                <SelectTrigger className="h-8 w-[132px] rounded-xl text-xs font-bold bg-white dark:bg-slate-900"><SelectValue placeholder="Assign dept" /></SelectTrigger>
                <SelectContent>{departments.map(d => <SelectItem key={d.pk_department_id} value={String(d.pk_department_id)}>{d.name}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={bulkShift} onValueChange={v => handleBulkAssign({ fk_shift_id: Number(v) }, shifts.find(s => String(s.pk_shift_id) === v)?.name ?? 'shift')}>
                <SelectTrigger className="h-8 w-[120px] rounded-xl text-xs font-bold bg-white dark:bg-slate-900"><SelectValue placeholder="Assign shift" /></SelectTrigger>
                <SelectContent>{shifts.map(s => <SelectItem key={s.pk_shift_id} value={String(s.pk_shift_id)}>{s.name}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={bulkManager} onValueChange={v => handleBulkAssign({ fk_manager_id: Number(v) }, managers.find(m => String(m.pk_employee_id) === v)?.full_name ?? 'manager')}>
                <SelectTrigger className="h-8 w-[140px] rounded-xl text-xs font-bold bg-white dark:bg-slate-900"><SelectValue placeholder="Assign manager" /></SelectTrigger>
                <SelectContent>{managers.map(m => <SelectItem key={m.pk_employee_id} value={String(m.pk_employee_id)}>{m.full_name}</SelectItem>)}</SelectContent>
              </Select>
              <Button size="sm" variant="outline" onClick={handleBulkInvite} disabled={bulkSaving} className="rounded-xl border-violet-300 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-500/10 font-bold text-xs">
                {bulkSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Mail className="w-3.5 h-3.5 mr-1" />}Invite &amp; consent
              </Button>
              <Button size="sm" variant="outline" onClick={() => exportCSV(selectedEmployees(), 'selected')} className="rounded-xl font-bold text-xs"><Download className="w-3.5 h-3.5 mr-1" />Export</Button>
              <div className="flex gap-2 ml-auto">
                <Button size="sm" variant="outline" onClick={() => handleBulkStatus('active')} disabled={bulkSaving} className="rounded-xl border-emerald-300 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 font-bold text-xs">Activate</Button>
                <Button size="sm" variant="outline" onClick={() => handleBulkStatus('inactive')} disabled={bulkSaving} className="rounded-xl border-rose-300 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-500/10 font-bold text-xs">Deactivate</Button>
                <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())} className="rounded-xl text-slate-500 text-xs">Clear</Button>
              </div>
            </div>
          )}

          {/* content */}
          {viewMode === 'org' ? (
            <OrgView
              employees={filtered}
              departments={departments}
              deptColor={deptColor}
              onOpen={emp => setSelectedEmployee(emp)}
            />
          ) : filtered.length === 0 ? (
            <Card className="border border-slate-200/70 dark:border-slate-800 shadow-sm rounded-2xl">
              <CardContent className="flex flex-col items-center gap-2 py-20 text-center">
                <Users className="w-8 h-8 text-slate-300" />
                <p className="text-slate-400 text-xs font-bold uppercase tracking-widest">No matching records</p>
                {activeFilters > 0 && <Button size="sm" variant="outline" onClick={resetFilters} className="rounded-xl font-bold mt-1 text-xs">Clear filters</Button>}
              </CardContent>
            </Card>
          ) : viewMode === 'table' ? (
            <Card className="border border-slate-200/70 dark:border-slate-800 shadow-sm bg-white dark:bg-slate-900 overflow-hidden rounded-2xl">
              <CardContent className="p-0 overflow-auto max-h-[640px]">
                <table className="w-full text-left min-w-[760px]">
                  <thead className="sticky top-0 z-10 bg-slate-50/90 dark:bg-slate-800/90 backdrop-blur-sm border-b border-slate-200/70 dark:border-slate-700">
                    <tr className="border-none">
                      <th className="pl-4 pr-2 py-4">
                        <Checkbox
                          aria-label="Select all"
                          checked={filtered.length > 0 && selectedIds.size === filtered.length ? true : selectedIds.size > 0 ? 'indeterminate' : false}
                          onCheckedChange={toggleSelectAll}
                        />
                      </th>
                      {['Employee', 'Employee ID', 'Department', 'Status', 'Biometrics', 'Consent', 'Actions'].map(h => {
                        const sk = COLUMN_SORT[h];
                        const active = !!sk && sortKey === sk;
                        const DirIcon = active ? (sortDir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
                        return (
                          <th key={h} className="px-6 py-4 text-[10px] font-black uppercase tracking-widest whitespace-nowrap">
                            {sk ? (
                              <button
                                onClick={() => setSort(sk)}
                                title={`Sort by ${h.toLowerCase()}`}
                                className={cn('inline-flex items-center gap-1 transition-colors',
                                  active ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300')}
                              >
                                {h}<DirIcon className={cn('w-3 h-3', active ? 'opacity-100' : 'opacity-40')} />
                              </button>
                            ) : (
                              <span className="text-slate-400">{h}</span>
                            )}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                    {pagedList.map((emp, idx) => {
                      const meta = deptMeta.get(clean(emp.department_name));
                      const selected = selectedIds.has(emp.pk_employee_id);
                      return (
                        <tr
                          key={emp.pk_employee_id}
                          onClick={() => setSelectedEmployee(emp)}
                          className={cn('cursor-pointer transition-colors group hover:bg-slate-50/70 dark:hover:bg-slate-800/40',
                            selected ? 'bg-blue-50/40 dark:bg-blue-500/10' : idx % 2 === 1 ? 'bg-slate-50/40 dark:bg-slate-800/20' : '')}
                        >
                          <td onClick={e => e.stopPropagation()} className={cn('pl-4 pr-2 py-4 border-l-2', selected ? 'border-blue-500' : 'border-transparent')}>
                            <Checkbox aria-label={`Select ${clean(emp.full_name)}`} checked={selected} onCheckedChange={() => toggleSelect(emp.pk_employee_id)} />
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-3">
                              <Avatar emp={emp} />
                              <div className="flex flex-col min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <button onClick={() => setSelectedEmployee(emp)} className="text-sm font-black text-slate-800 dark:text-slate-100 hover:text-blue-600 transition-colors text-left truncate">{clean(emp.full_name)}</button>{needsAttention(emp) && (<span title={missingFields(emp).join(' · ')} className="inline-flex items-center gap-0.5 rounded-md bg-amber-50 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400 px-1 py-0.5 text-[8px] font-black shrink-0"><AlertCircle className="w-2.5 h-2.5" />{missingFields(emp).length}</span>)}
                                  {emp.is_manager && (
                                    <Badge className="rounded-md border-none bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400 px-1.5 py-0 text-[8px] font-black uppercase shrink-0">Mgr</Badge>
                                  )}
                                </div>
                                <span className="text-[10px] font-medium text-slate-400 truncate max-w-[200px]">{clean(emp.email)}</span>
                                {clean(emp.location_label) && (
                                  <span className="flex items-center gap-1 text-[9px] font-bold text-slate-300 uppercase tracking-tight truncate max-w-[200px]">
                                    <MapPin className="w-2.5 h-2.5" />{clean(emp.location_label)}
                                  </span>
                                )}
                                {emp.site_ids && emp.site_ids.length > 0 && (
                                  <div className="flex flex-wrap gap-1 mt-1">
                                    {emp.site_ids.map(sid => {
                                      const siteObj = sites.find(s => s.id === sid);
                                      return siteObj ? (
                                        <span key={sid} className="text-[9px] font-bold text-indigo-600 bg-indigo-50 dark:bg-indigo-500/15 dark:text-indigo-400 px-1 py-0.5 rounded border border-indigo-100 dark:border-indigo-500/30">
                                          {siteObj.name}
                                        </span>
                                      ) : null;
                                    })}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-xs font-bold text-slate-500 font-mono tracking-tighter">{emp.employee_code}</td>
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: deptColor(emp.department_name) }} />
                              <span className="text-xs font-bold text-slate-500 uppercase truncate max-w-[140px]">{clean(emp.department_name) || 'General'}</span>
                              {meta?.code && <span className="text-[9px] font-black text-slate-300 tracking-wider">{meta.code}</span>}
                            </div>
                          </td>
                          <td className="px-6 py-4"><StatusPill status={emp.status} /></td>
                          <td className="px-6 py-4"><BiometricPill emp={emp} /></td>
                          <td className="px-6 py-4"><ConsentPill emp={emp} /></td>
                          <td className="px-6 py-4" onClick={e => e.stopPropagation()}>
                            <div className="flex items-center gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                              <RowActions emp={emp} />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3 gap-4">
              {pagedList.map(emp => (
                <div key={emp.pk_employee_id} className={cn('relative rounded-2xl bg-white dark:bg-slate-900 border shadow-sm p-4 transition-all hover:shadow-md group',
                  selectedIds.has(emp.pk_employee_id) ? 'border-blue-300 dark:border-blue-500/50 ring-1 ring-blue-200 dark:ring-blue-500/30' : 'border-slate-200/70 dark:border-slate-800')}>
                  <Checkbox
                    aria-label={`Select ${clean(emp.full_name)}`}
                    className="absolute top-3 right-3 z-10 bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm"
                    checked={selectedIds.has(emp.pk_employee_id)}
                    onClick={e => e.stopPropagation()}
                    onCheckedChange={() => toggleSelect(emp.pk_employee_id)}
                  />
                  <div className="flex items-start gap-3 pr-6">
                    <Avatar emp={emp} size="lg" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => setSelectedEmployee(emp)} className="text-sm font-black text-slate-800 dark:text-slate-100 hover:text-blue-600 transition-colors text-left truncate">{clean(emp.full_name)}</button>{needsAttention(emp) && (<span title={missingFields(emp).join(' · ')} className="inline-flex items-center gap-0.5 rounded-md bg-amber-50 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400 px-1 py-0.5 text-[8px] font-black shrink-0"><AlertCircle className="w-2.5 h-2.5" />{missingFields(emp).length}</span>)}
                        {emp.is_manager && (
                          <Badge className="rounded-md border-none bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400 px-1.5 py-0 text-[8px] font-black uppercase shrink-0">Mgr</Badge>
                        )}
                      </div>
                      <span className="text-[10px] font-mono font-bold text-slate-400">{emp.employee_code}</span>
                      <p className="text-[10px] font-medium text-slate-400 truncate">{clean(emp.email)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-3 text-xs">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: deptColor(emp.department_name) }} />
                    <span className="font-bold text-slate-500 uppercase truncate">{clean(emp.department_name) || 'General'}</span>
                    {clean(emp.location_label) && (
                      <span className="flex items-center gap-1 text-[10px] font-bold text-slate-300 uppercase ml-auto truncate">
                        <MapPin className="w-3 h-3" />{clean(emp.location_label)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-slate-50 dark:border-slate-800">
                    <div className="flex items-center gap-2">
                      <StatusPill status={emp.status} />
                      <ConsentPill emp={emp} />
                    </div>
                    <BiometricPill emp={emp} />
                  </div>
                  <div className="flex items-center justify-end gap-1 mt-2 -mb-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <RowActions emp={emp} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* pagination */}
          {viewMode !== 'org' && total > PER_PAGE && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-1">
              <p className="text-xs text-slate-500 font-medium">
                Showing {Math.min((page - 1) * PER_PAGE + 1, total)}–{Math.min(page * PER_PAGE, total)} of {total}
              </p>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="h-8 text-xs rounded-lg font-bold">Prev</Button>
                <span className="px-3 text-xs font-bold text-slate-600 dark:text-slate-300">Page {page} of {totalPages}</span>
                <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="h-8 text-xs rounded-lg font-bold">Next</Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── EDIT EMPLOYEE DIALOG ────────────────────────────────────────── */}
      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent className="max-w-2xl rounded-2xl border-none">
          <DialogHeader><DialogTitle className="font-black text-xl">Edit Employee</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-4 py-4">
            <div className="space-y-1"><Label className="text-[10px] font-black uppercase text-slate-400">Full Name</Label><Input value={editForm.full_name} onChange={e => setEditForm({ ...editForm, full_name: e.target.value })} className="rounded-xl" /></div>
            <div className="space-y-1"><Label className="text-[10px] font-black uppercase text-slate-400">Email Address</Label><Input value={editForm.email} onChange={e => setEditForm({ ...editForm, email: e.target.value })} className="rounded-xl" /></div>
            <div className="space-y-1"><Label className="text-[10px] font-black uppercase text-slate-400">Title / Position</Label><Input value={editForm.position_title} onChange={e => setEditForm({ ...editForm, position_title: e.target.value })} className="rounded-xl" /></div>
            <div className="space-y-1"><Label className="text-[10px] font-black uppercase text-slate-400">Location</Label><Input value={editForm.location_label} onChange={e => setEditForm({ ...editForm, location_label: e.target.value })} className="rounded-xl" /></div>
            <div className="space-y-1"><Label className="text-[10px] font-black uppercase text-slate-400">Phone</Label><Input value={editForm.phone_number} onChange={e => setEditForm({ ...editForm, phone_number: e.target.value })} className="rounded-xl" /></div>
            <div className="space-y-1"><Label className="text-[10px] font-black uppercase text-slate-400">Status</Label>
              <Select value={editForm.status} onValueChange={v => setEditForm({ ...editForm, status: v })}>
                <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1"><Label className="text-[10px] font-black uppercase text-slate-400">Department</Label>
              <Select value={editForm.fk_department_id} onValueChange={v => setEditForm({ ...editForm, fk_department_id: v })}>
                <SelectTrigger className="rounded-xl"><SelectValue placeholder="Select department" /></SelectTrigger>
                <SelectContent>{departments.map(d => <SelectItem key={d.pk_department_id} value={String(d.pk_department_id)}>{d.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1"><Label className="text-[10px] font-black uppercase text-slate-400">Shift</Label>
              <Select value={editForm.fk_shift_id} onValueChange={v => setEditForm({ ...editForm, fk_shift_id: v })}>
                <SelectTrigger className="rounded-xl"><SelectValue placeholder="Select shift" /></SelectTrigger>
                <SelectContent>{shifts.map(s => <SelectItem key={s.pk_shift_id} value={String(s.pk_shift_id)}>{s.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1"><Label className="text-[10px] font-black uppercase text-slate-400">Reporting Manager</Label>
              <Select value={editForm.fk_manager_id || '__none__'} onValueChange={v => setEditForm({ ...editForm, fk_manager_id: v === '__none__' ? '' : v })}>
                <SelectTrigger className="rounded-xl"><SelectValue placeholder="Select manager (optional)" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {managers.filter(m => m.pk_employee_id !== editTarget?.pk_employee_id).map(m => <SelectItem key={m.pk_employee_id} value={String(m.pk_employee_id)}>{m.full_name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 flex items-end pb-1.5">
              <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer text-slate-700">
                <input
                  type="checkbox"
                  checked={editForm.is_manager}
                  onChange={e => setEditForm({ ...editForm, is_manager: e.target.checked })}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                Is a Manager
              </label>
            </div>
            <div className="col-span-2 space-y-1.5">
               <Label className="text-[10px] font-black uppercase text-slate-400">Assign Sites / Branches</Label>
               <div className="grid grid-cols-2 gap-2 border rounded-xl p-3 bg-slate-50 max-h-32 overflow-y-auto">
                 {sites.map(s => {
                   const isChecked = editForm.site_ids?.includes(s.id);
                   return (
                     <label key={s.id} className="flex items-center gap-2 text-xs font-semibold cursor-pointer text-slate-700">
                       <input
                         type="checkbox"
                         checked={isChecked}
                         onChange={e => {
                           const newIds = e.target.checked
                             ? [...(editForm.site_ids || []), s.id]
                             : (editForm.site_ids || []).filter(id => id !== s.id);
                           setEditForm({ ...editForm, site_ids: newIds });
                         }}
                         className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                       />
                       {s.name}
                     </label>
                   );
                 })}
               </div>
             </div>
          </div>
          <Button onClick={handleEdit} className="w-full bg-blue-600 font-bold rounded-xl py-6" disabled={saving}>
            {saving ? <Loader2 className="animate-spin mr-2" /> : null}Save Changes
          </Button>
        </DialogContent>
      </Dialog>

      {/* ── DEACTIVATE CONFIRMATION ─────────────────────────────────────── */}
      <AlertDialog open={!!deactivateTarget} onOpenChange={open => { if (!open) setDeactivateTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate Employee</AlertDialogTitle>
            <AlertDialogDescription>
              This will revoke system access for <strong>{clean(deactivateTarget?.full_name)}</strong> and mark them as inactive. You can re-activate them later by editing their status.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-rose-600 hover:bg-rose-700" onClick={handleDeactivate}>Deactivate</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── DELETE CONFIRMATION ─────────────────────────────────────────── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Employee</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <strong>{clean(deleteTarget?.full_name)}</strong> and all associated records including face enrollments and attendance data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-red-700 hover:bg-red-800" onClick={handleDelete}>Delete Permanently</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── ACTIVITY DRAWER ─────────────────────────────────────────────── */}
      {activityTarget && (
        <ActivityDrawer emp={activityTarget} accessToken={accessToken} scopeHeaders={scopeHeaders} onClose={() => setActivityTarget(null)} />
      )}

      {/* ── BULK MODALS ─────────────────────────────────────────────────── */}
      {showFaceEnroll && <BulkFaceEnrollModal onClose={() => setShowFaceEnroll(false)} onSuccess={() => { setShowFaceEnroll(false); loadEmployees(); }} />}
      {showBulkImport && <BulkImportModal onClose={() => setShowBulkImport(false)} onSuccess={() => { setShowBulkImport(false); loadEmployees(); }} />}
    </div>
  );
};
