import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { apiRequest } from '../../../../services/http/apiClient';
import { cn } from '../../../ui/utils';
import {
  Search, Download, RefreshCw, X, ChevronDown, ChevronRight,
  User, Camera, Shield, Settings, Users, Calendar, Building2,
  Cpu, FileText, LogIn, Eye, UserPlus, UserMinus, Trash2,
  ScanFace, Clock, Globe, Monitor, Zap, AlertTriangle
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────
interface AuditEntry {
  pk_audit_id: string;
  action: string;
  details: string;
  ip_address: string | null;
  created_at: string;
  user_name: string | null;
  user_role: string | null;
  user_agent: string | null;
  method: string | null;
  entity_type: string | null;
  entity_id: string | null;
  entity_name: string | null;
  before_data: any;
  after_data: any;
  source: string | null;
  tenant_id: string;
}

// ── Action config ──────────────────────────────────────────────
const ACTION_CONFIG: Record<string, { label: string; icon: any; color: string; bg: string; category: string }> = {
  'attendance.mark':      { label: 'Attendance Marked',    icon: Camera,    color: 'text-emerald-600', bg: 'bg-emerald-100 dark:bg-emerald-900/20', category: 'Attendance' },
  'face.enroll':          { label: 'Face Enrolled',        icon: ScanFace,  color: 'text-violet-600',  bg: 'bg-violet-100 dark:bg-violet-900/20',   category: 'Enrollment' },
  'face.enroll.delete':   { label: 'Face Removed',         icon: ScanFace,  color: 'text-rose-600',    bg: 'bg-rose-100 dark:bg-rose-900/20',       category: 'Enrollment' },
  'employee.view':        { label: 'Profile Viewed',       icon: Eye,       color: 'text-blue-600',    bg: 'bg-blue-100 dark:bg-blue-900/20',       category: 'Employee' },
  'employee.create':      { label: 'Employee Created',     icon: UserPlus,  color: 'text-emerald-600', bg: 'bg-emerald-100 dark:bg-emerald-900/20', category: 'Employee' },
  'employee.update':      { label: 'Employee Updated',     icon: User,      color: 'text-amber-600',   bg: 'bg-amber-100 dark:bg-amber-900/20',     category: 'Employee' },
  'employee.activate':    { label: 'Employee Activated',   icon: UserPlus,  color: 'text-emerald-600', bg: 'bg-emerald-100 dark:bg-emerald-900/20', category: 'Employee' },
  'employee.deactivate':  { label: 'Employee Deactivated', icon: UserMinus, color: 'text-rose-600',    bg: 'bg-rose-100 dark:bg-rose-900/20',       category: 'Employee' },
  'user.create':          { label: 'User Created',         icon: UserPlus,  color: 'text-blue-600',    bg: 'bg-blue-100 dark:bg-blue-900/20',       category: 'User' },
  'user.delete':          { label: 'User Deleted',         icon: Trash2,    color: 'text-rose-600',    bg: 'bg-rose-100 dark:bg-rose-900/20',       category: 'User' },
  'user.login':           { label: 'User Login',           icon: LogIn,     color: 'text-blue-600',    bg: 'bg-blue-100 dark:bg-blue-900/20',       category: 'Auth' },
  'dept.create':          { label: 'Dept Created',         icon: Building2, color: 'text-indigo-600',  bg: 'bg-indigo-100 dark:bg-indigo-900/20',   category: 'HR' },
  'dept.delete':          { label: 'Dept Deleted',         icon: Trash2,    color: 'text-rose-600',    bg: 'bg-rose-100 dark:bg-rose-900/20',       category: 'HR' },
  'dept.assign':          { label: 'Dept Assigned',        icon: Users,     color: 'text-indigo-600',  bg: 'bg-indigo-100 dark:bg-indigo-900/20',   category: 'HR' },
  'shift.assign':         { label: 'Shift Assigned',       icon: Clock,     color: 'text-amber-600',   bg: 'bg-amber-100 dark:bg-amber-900/20',     category: 'HR' },
  'roster.create':        { label: 'Roster Updated',       icon: Calendar,  color: 'text-teal-600',    bg: 'bg-teal-100 dark:bg-teal-900/20',       category: 'Roster' },
  'roster.delete':        { label: 'Roster Deleted',       icon: Trash2,    color: 'text-rose-600',    bg: 'bg-rose-100 dark:bg-rose-900/20',       category: 'Roster' },
  'nug.create':           { label: 'NUG Box Added',        icon: Cpu,       color: 'text-blue-600',    bg: 'bg-blue-100 dark:bg-blue-900/20',       category: 'Device' },
  'camera.create':        { label: 'Camera Added',         icon: Camera,    color: 'text-emerald-600', bg: 'bg-emerald-100 dark:bg-emerald-900/20', category: 'Device' },
  'building.create':      { label: 'Building Added',       icon: Building2, color: 'text-slate-600',   bg: 'bg-slate-100 dark:bg-slate-900/20',     category: 'Device' },
  'settings.update':      { label: 'Settings Changed',     icon: Settings,  color: 'text-orange-600',  bg: 'bg-orange-100 dark:bg-orange-900/20',   category: 'Settings' },
};

const getActionConfig = (action: string) => ACTION_CONFIG[action] || {
  label: action.split('.').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
  icon: FileText, color: 'text-slate-600', bg: 'bg-slate-100 dark:bg-slate-800', category: 'Other'
};

const CATEGORIES = ['All', 'Attendance', 'Enrollment', 'Employee', 'User', 'Auth', 'HR', 'Roster', 'Device', 'Settings'];

const sourceIcon = (s: string|null) => {
  if (s === 'device') return { icon: Camera, label: 'Device', color: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20' };
  if (s === 'api') return { icon: Zap, label: 'API', color: 'text-violet-600 bg-violet-50 dark:bg-violet-900/20' };
  return { icon: Monitor, label: 'UI', color: 'text-blue-600 bg-blue-50 dark:bg-blue-900/20' };
};

const cleanIp = (ip: string|null) => ip?.replace('::ffff:', '') || '—';
const fmtTime = (t: string) => new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDate = (t: string) => new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const fmtFull = (t: string) => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtBrowser = (ua: string|null) => {
  if (!ua) return '—';
  if (ua.includes('Chrome')) return 'Chrome';
  if (ua.includes('Firefox')) return 'Firefox';
  if (ua.includes('Safari')) return 'Safari';
  if (ua.includes('frs-runner')) return 'FRS Runner';
  return ua.slice(0, 30);
};

const displayUser = (entry: AuditEntry) => {
  if (entry.source === 'device') {
    try {
      const data = typeof entry.after_data === 'string' ? JSON.parse(entry.after_data) : entry.after_data;
      return `Device: ${data?.deviceId || 'jetson-orin-01'}`;
    } catch {
      return 'Device';
    }
  }
  return entry.user_name || 'System';
};

// ── Detail Modal ────────────────────────────────────────────────
function AuditDetailModal({ entry, onClose }: { entry: AuditEntry; onClose: () => void }) {
  const cfg = getActionConfig(entry.action);
  const Icon = cfg.icon;
  const src = sourceIcon(entry.source);
  const SrcIcon = src.icon;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="glass-card rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-lg overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className={cn("px-5 py-4 flex items-center gap-3", cfg.bg)}>
          <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center bg-white/50 dark:bg-black/20")}>
            <Icon className={cn("w-5 h-5", cfg.color)} />
          </div>
          <div className="flex-1">
            <p className={cn("font-bold", cfg.color)}>{cfg.label}</p>
            <p className="text-xs text-slate-500 mt-0.5">{fmtFull(entry.created_at)}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/10 transition-colors">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Details */}
          <div className="bg-slate-50 dark:bg-slate-800 rounded-xl p-3">
            <p className="text-sm text-slate-700 dark:text-slate-300">{entry.details}</p>
          </div>

          {/* Who */}
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Who</p>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-blue-100 dark:bg-blue-900/20 flex items-center justify-center">
                <User className="w-4 h-4 text-blue-600" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">{displayUser(entry)}</p>
                <p className="text-xs text-slate-400">{entry.user_role || '—'}</p>
              </div>
            </div>
          </div>

          {/* What entity */}
          {entry.entity_name && (
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Affected</p>
              <div className="flex items-center gap-2 text-sm">
                <span className="px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-mono text-xs">{entry.entity_type}</span>
                <span className="font-semibold text-slate-800 dark:text-slate-200">{entry.entity_name}</span>
                {entry.entity_id && <span className="text-xs text-slate-400">#{entry.entity_id}</span>}
              </div>
            </div>
          )}

          {/* From where */}
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">From Where</p>
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-2.5 text-center">
                <Globe className="w-4 h-4 mx-auto mb-1 text-slate-400" />
                <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">{cleanIp(entry.ip_address)}</p>
                <p className="text-[10px] text-slate-400">IP Address</p>
              </div>
              <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-2.5 text-center">
                <Monitor className="w-4 h-4 mx-auto mb-1 text-slate-400" />
                <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">{fmtBrowser(entry.user_agent)}</p>
                <p className="text-[10px] text-slate-400">Browser</p>
              </div>
              <div className={cn("rounded-lg p-2.5 text-center", src.color.split(' ').slice(1).join(' ') || 'bg-slate-50 dark:bg-slate-800')}>
                <SrcIcon className={cn("w-4 h-4 mx-auto mb-1", src.color.split(' ')[0])} />
                <p className={cn("text-xs font-semibold", src.color.split(' ')[0])}>{src.label}</p>
                <p className="text-[10px] text-slate-400">Source</p>
              </div>
            </div>
          </div>

          {/* Before/After */}
          {(entry.before_data || entry.after_data) && (
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Changes</p>
              <div className="grid grid-cols-2 gap-2">
                {entry.before_data && (
                  <div className="bg-rose-50 dark:bg-rose-900/10 border border-rose-200 dark:border-rose-800 rounded-lg p-2.5">
                    <p className="text-[10px] font-bold text-rose-500 mb-1.5">BEFORE</p>
                    <pre className="text-[10px] text-rose-700 dark:text-rose-300 overflow-auto max-h-32 whitespace-pre-wrap">
                      {JSON.stringify(typeof entry.before_data === 'string' ? JSON.parse(entry.before_data) : entry.before_data, null, 2)}
                    </pre>
                  </div>
                )}
                {entry.after_data && (
                  <div className="bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-200 dark:border-emerald-800 rounded-lg p-2.5">
                    <p className="text-[10px] font-bold text-emerald-500 mb-1.5">AFTER</p>
                    <pre className="text-[10px] text-emerald-700 dark:text-emerald-300 overflow-auto max-h-32 whitespace-pre-wrap">
                      {JSON.stringify(typeof entry.after_data === 'string' ? JSON.parse(entry.after_data) : entry.after_data, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Proof Photo */}
          {cfg.label === 'Attendance Marked' && (
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Proof Photo</p>
              {(() => {
                try {
                  const data = typeof entry.after_data === 'string' ? JSON.parse(entry.after_data) : entry.after_data;
                  const empId = data?.employeeId;
                  if (!empId) return <p className="text-xs text-slate-400 italic">No employee ID in data</p>;
                  const photoDate = entry.created_at.slice(0,10);
                  const photoUrl = `/api/attendance/photos/${empId}_${photoDate}.jpg?w=640`;
                  return <img key={photoUrl} src={photoUrl} alt="Attendance proof" className="w-full max-h-64 object-cover rounded-xl border shadow-sm bg-slate-50 dark:bg-slate-800 flex items-center justify-center" onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }} />;
                } catch {
                  return <p className="text-xs text-slate-400 italic">Invalid data format</p>;
                }
              })()}
            </div>
          )}

          {/* Audit ID */}
          <p className="text-[10px] text-slate-300 dark:text-slate-600 text-right font-mono">Audit #{entry.pk_audit_id}</p>
        </div>
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────
export function LiveAuditLog() {
  const { accessToken , isAuthenticated } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [selectedEntry, setSelectedEntry] = useState<AuditEntry | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [dedupe, setDedupe] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [page, setPage] = useState(1);
  const [categoryCounts, setCategoryCounts] = useState<Record<string,number>>({});
  const [todayCounts, setTodayCounts] = useState<Record<string,number>>({});
  const [dateRange, setDateRange] = useState<'all' | 'today' | '7d' | '30d'>('all');
  const intervalRef = useRef<NodeJS.Timeout>();
  const PAGE_SIZE = 50;

  const getDateRangeParams = useCallback(() => {
    const now = new Date();
    const to = now.toISOString().slice(0,10);
    let from: string;
    switch(dateRange) {
      case 'today':
        from = to;
        break;
      case '7d':
        const d7 = new Date(now.getTime() - 7*24*60*60*1000);
        from = d7.toISOString().slice(0,10);
        break;
      case '30d':
        const d30 = new Date(now.getTime() - 30*24*60*60*1000);
        from = d30.toISOString().slice(0,10);
        break;
      case 'all':
      default:
        return {};
    }
    return {from, to};
  }, [dateRange]);

  const fetchCounts = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const params = new URLSearchParams(getDateRangeParams());
      const res = await apiRequest<{ data: {category:string;count:number}[] }>(`/live/audit/summary?${params}`, { accessToken, scopeHeaders });
      const map: Record<string,number> = {};
      res.data.forEach(r => { map[r.category] = r.count; });
      setCategoryCounts(map);
    } catch {}
  }, [accessToken]);

  const fetchTodayCounts = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const params = new URLSearchParams({ from: today, to: today });
      const res = await apiRequest<{ data: {category:string;count:number}[] }>(`/live/audit/summary?${params}`, { accessToken, scopeHeaders });
      const map: Record<string,number> = {};
      (res.data || []).forEach(r => {
        const catKey = ['Attendance', 'Enrollment', 'Employee', 'User', 'Device', 'System'].includes(r.category)
          ? r.category
          : 'System';
        map[catKey] = (map[catKey] || 0) + r.count;
      });
      setTodayCounts(map);
    } catch {}
  }, [accessToken, isAuthenticated, scopeHeaders]);

  const fetchLogs = useCallback(async (reset = false) => {
    if (!isAuthenticated) return;
    if (reset) setPage(1);
    setLoading(true);
    try {
      const paramsObj = {
        limit: String(PAGE_SIZE),
        offset: String(reset ? 0 : (page - 1) * PAGE_SIZE),
        ...(search && { q: search }),
        ...(category !== 'All' && { category }),
        ...getDateRangeParams(),
      };
      const params = new URLSearchParams(paramsObj);
      const validParams = Array.from(params.entries()).filter(([k,v]) => v !== '').reduce((acc, [k,v]) => { acc[k] = v; return acc; }, {} as Record<string,string>);
      const query = new URLSearchParams(validParams).toString();
      const url = `/live/audit${query ? '?' + query : ''}`;
      const res = await apiRequest<{ data: AuditEntry[]; total: number }>(
        url, { accessToken, scopeHeaders }
      );
      setEntries(res.data || []);
      setTotal(res.total || 0);
      setLastUpdated(new Date());
    } catch {}
    setLoading(false);
  }, [accessToken, search, category, page]);

  useEffect(() => { fetchLogs(true); fetchCounts(); fetchTodayCounts(); }, [search, category, dateRange]);
  useEffect(() => { fetchLogs(); }, [page]);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(() => fetchLogs(true), 15000);
    }
    return () => clearInterval(intervalRef.current);
  }, [autoRefresh, fetchLogs]);

  /** Wraps value in double quotes and escapes internal quotes for CSV safety */
  const csvSafe = (val: string | null | undefined): string => {
    const s = String(val ?? '');
    return `"${s.replace(/"/g, '""')}"`;
  };

  const exportCSV = () => {
    const headers = ['Time', 'Action', 'Details', 'User', 'Role', 'Entity', 'IP', 'Source'];
    const rows = entries.map(e => [
      csvSafe(fmtFull(e.created_at)),
      csvSafe(e.action),
      csvSafe(e.details),
      csvSafe(e.user_name),
      csvSafe(e.user_role),
      csvSafe(e.entity_name),
      csvSafe(cleanIp(e.ip_address)),
      csvSafe(sourceIcon(e.source).label),
    ]);
    const csv = [headers.map(h => csvSafe(h)), ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const dateStr = dateRange === 'all' ? '' : `-${getDateRangeParams().from || ''}-to-${getDateRangeParams().to || ''}`;
    a.download = `audit-log${dateStr}-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const toggleExpand = (id: string) => {
    setExpandedRows(prev => {
      const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s;
    });
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const TODAY_CATEGORIES = [
    { key: 'Attendance', color: 'text-emerald-600', bg: 'bg-emerald-50 dark:bg-emerald-900/20', border: 'border-emerald-200 dark:border-emerald-800' },
    { key: 'Enrollment', color: 'text-violet-600',  bg: 'bg-violet-50 dark:bg-violet-900/20',   border: 'border-violet-200 dark:border-violet-800'  },
    { key: 'Employee',   color: 'text-amber-600',   bg: 'bg-amber-50 dark:bg-amber-900/20',     border: 'border-amber-200 dark:border-amber-800'    },
    { key: 'User',       color: 'text-blue-600',    bg: 'bg-blue-50 dark:bg-blue-900/20',       border: 'border-blue-200 dark:border-blue-800'      },
    { key: 'Device',     color: 'text-slate-600',   bg: 'bg-slate-50 dark:bg-slate-800/40',     border: 'border-slate-200 dark:border-slate-700'    },
    { key: 'System',     color: 'text-rose-600',    bg: 'bg-rose-50 dark:bg-rose-900/20',       border: 'border-rose-200 dark:border-rose-800'      },
  ];
  const todayTotal = (Object.values(todayCounts) as number[]).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-4">
      {/* Today's summary strip */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        {TODAY_CATEGORIES.map(({ key, color, bg, border }) => (
          <div key={key} className={cn('rounded-xl border px-3 py-2.5 flex flex-col gap-0.5', bg, border)}>
            <span className={cn('text-lg font-black leading-none', color)}>
              {todayCounts[key] ?? 0}
            </span>
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">{key}</span>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-slate-400 -mt-1">
        <span className="font-bold text-slate-600 dark:text-slate-300">{todayTotal}</span> events logged today
      </p>

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold text-slate-900 dark:text-white">Live Activity Log</h2>
            <span className={cn("flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full", autoRefresh ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20" : "bg-slate-100 text-slate-500")}>
              <span className={cn("w-1.5 h-1.5 rounded-full", autoRefresh ? "bg-emerald-500 animate-pulse" : "bg-slate-400")} />
              {autoRefresh ? 'Live' : 'Paused'}
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            {total.toLocaleString()} total events ({dateRange === 'all' ? 'All Time' : dateRange === 'today' ? 'Today' : `${dateRange.toUpperCase()} Days`})
            {autoRefresh && ' · Auto-refresh 10s'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setAutoRefresh(a => !a)} className={cn("px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors", autoRefresh ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800" : "text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 border-slate-200 dark:border-slate-700")}>
            {autoRefresh ? '⏸ Pause' : '▶ Resume'}
          </button>
          <button onClick={() => setDedupe(d => !d)} className={cn("px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors", dedupe ? "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800" : "text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 border-slate-200 dark:border-slate-700")}>
            {dedupe ? '🗜️ Dedupe ON' : '📊 Show All'}
          </button>
          <button onClick={() => fetchLogs(true)} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg">
            <RefreshCw className={cn("w-4 h-4 text-slate-500", loading && "animate-spin")} />
          </button>
          <button onClick={exportCSV} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg">
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
        </div>
      </div>

      {/* Search + Category filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by action, user, employee, IP..."
            className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 glass-card text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {search && <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2"><X className="w-3.5 h-3.5 text-slate-400" /></button>}
        </div>
      </div>

      {/* Category tabs */}
      <div className="flex gap-1 flex-wrap">
        {CATEGORIES.map(cat => {
          const count = cat === 'All' ? (Object.values(categoryCounts) as number[]).reduce((a,b)=>a+b,0) : categoryCounts[cat];
          return (
            <button key={cat} onClick={() => setCategory(cat)} className={cn("flex items-center gap-1 px-3 py-1 text-xs font-semibold rounded-lg transition-all border", category === cat ? "bg-blue-600 text-white border-blue-600" : "text-slate-500 border-slate-200 dark:border-slate-700 hover:text-slate-700 dark:hover:text-slate-300 hover:border-slate-300")}>
              {cat}
              {count ? <span className={cn("text-[10px] font-bold px-1 rounded-full", category===cat?"bg-white/20 text-white":"bg-slate-100 dark:bg-slate-800 text-slate-500")}>{count > 999 ? `${(count/1000).toFixed(1)}k` : count}</span> : null}
            </button>
          );
        })}
      </div>

      {/* Date Range tabs */}
      <div className="flex gap-1 flex-wrap mt-2">
        {(['all', 'today', '7d', '30d'] as const).map(range => (
          <button key={range} onClick={() => setDateRange(range)} className={cn("px-3 py-1 text-xs font-semibold rounded-lg transition-all border flex items-center gap-1", dateRange === range ? "bg-indigo-600 text-white border-indigo-600" : "text-slate-500 border-slate-200 dark:border-slate-700 hover:text-slate-700 hover:border-slate-300")}>
            {range === 'all' ? 'All Time' : range === 'today' ? 'Today' : `${range.toUpperCase()} Days`}
          </button>
        ))}
      </div>

      {/* Audit entries */}
      <div className="glass-card border border-slate-200 dark:border-slate-700 rounded-2xl overflow-hidden shadow-sm">
        {entries.length === 0 && !loading ? (
          <div className="text-center py-16 text-slate-400">
            <FileText className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No audit events found</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-50 dark:divide-slate-800/50">
            {entries.map(entry => {
              const cfg = getActionConfig(entry.action);
              const Icon = cfg.icon;
              const src = sourceIcon(entry.source);
              const SrcIcon = src.icon;
              const expanded = expandedRows.has(entry.pk_audit_id);
              const hasDetail = entry.before_data || entry.after_data || entry.entity_name;

              return (
                <div key={entry.pk_audit_id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/20 transition-colors">
                  <div className="flex items-start gap-3 px-4 py-3 cursor-pointer" onClick={() => setSelectedEntry(entry)}>
                    {/* Icon */}
                    <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5", cfg.bg)}>
                      <Icon className={cn("w-4 h-4", cfg.color)} />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-bold text-slate-900 dark:text-white">{cfg.label}</span>
                        <span className="text-[10px] font-mono text-slate-400 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">{entry.action}</span>
                        {entry.entity_name && (
                          <span className="text-xs text-slate-500">→ <span className="font-semibold text-slate-700 dark:text-slate-300">{entry.entity_name}</span></span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 mt-0.5 truncate">{entry.details}</p>
                      <div className="flex items-center gap-3 mt-1 flex-wrap">
                        <span className="flex items-center gap-1 text-[10px] text-slate-400">
                          <User className="w-3 h-3" />
                          {displayUser(entry)}
                          {entry.user_role && <span className="ml-1 px-1 bg-slate-100 dark:bg-slate-800 rounded text-[9px]">{entry.user_role}</span>}
                        </span>
                        <span className="flex items-center gap-1 text-[10px] text-slate-400">
                          <Globe className="w-3 h-3" />{cleanIp(entry.ip_address)}
                        </span>
                        <span className={cn("flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full", src.color)}>
                          <SrcIcon className="w-2.5 h-2.5" />{src.label}
                        </span>
                      </div>
                    </div>

                    {/* Time + expand */}
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      <span className="text-xs font-semibold text-slate-600 dark:text-slate-400">{fmtTime(entry.created_at)}</span>
                      <span className="text-[10px] text-slate-400">{fmtDate(entry.created_at)}</span>
                      {hasDetail && (
                        <button onClick={e => { e.stopPropagation(); toggleExpand(entry.pk_audit_id); }} className="p-0.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded">
                          {expanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Inline expanded detail */}
                  {expanded && (
                    <div className="px-4 pb-3 ml-11 space-y-2">
                      {entry.after_data && (
                        <div className="bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-800/50 rounded-lg p-2.5">
                          <p className="text-[10px] font-bold text-emerald-600 mb-1">DATA</p>
                          <pre className="text-[10px] text-emerald-700 dark:text-emerald-300 whitespace-pre-wrap overflow-auto max-h-24">
                            {JSON.stringify(typeof entry.after_data === 'string' ? JSON.parse(entry.after_data) : entry.after_data, null, 2)}
                          </pre>
                        </div>
                      )}
                      <button onClick={() => setSelectedEntry(entry)} className="text-[10px] text-blue-600 hover:underline">View full details →</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 dark:border-slate-800">
            <p className="text-xs text-slate-400">
              Showing {((page-1)*PAGE_SIZE)+1}–{Math.min(page*PAGE_SIZE, total)} of {total.toLocaleString()}
            </p>
            <div className="flex items-center gap-1">
              <button disabled={page===1} onClick={() => setPage(p => p-1)} className="px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed border border-slate-200 dark:border-slate-700">← Prev</button>
              <span className="px-3 py-1 text-xs font-bold text-slate-700 dark:text-slate-300">{page} / {totalPages}</span>
              <button disabled={page===totalPages} onClick={() => setPage(p => p+1)} className="px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed border border-slate-200 dark:border-slate-700">Next →</button>
            </div>
          </div>
        )}
      </div>

      {/* Detail Modal */}
      {selectedEntry && <AuditDetailModal entry={selectedEntry} onClose={() => setSelectedEntry(null)} />}
    </div>
  );
}
