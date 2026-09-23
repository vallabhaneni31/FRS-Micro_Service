import { useDepartmentsAndShifts } from '../../../../hooks/useDepartmentsAndShifts';
import { useQueryParam, useQueryParams } from '../../../../hooks/useQueryParam';
import { formatTimeInSiteTz } from '../../../../utils/timezone';
import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../ui/card';
import { Button } from '../../../ui/button';
import {
    UserCheck, UserX, Clock, Briefcase, AlertCircle, Users,
    CalendarDays, Download, Loader2, RefreshCw, Search, FilePen, History,
    Radio, LogIn, MapPin, AlertTriangle, ScanLine, Repeat,
    ChevronLeft, ChevronRight, X, Camera, ArrowRight,
    ArrowUp, ArrowDown, ChevronsUpDown, ClipboardCheck, Check, Inbox, Send, Bell,
} from 'lucide-react';
import { realtimeEngine, RteEventType } from '../../../../engine/RealTimeEngine';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../../ui/dialog';
import { Label } from '../../../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select';
import { toast } from 'sonner';
import { Input } from '../../../ui/input';
import { Checkbox } from '../../../ui/checkbox';
import { Calendar as CalendarPicker } from '../../../ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '../../../ui/popover';
import { cn } from '../../../ui/utils';
import { lightTheme } from '../../../../../theme/lightTheme';
import { useAuth } from '../../../../contexts/AuthContext';
import { useAuthedPhotoUrl } from '../../../../services/http/authedPhoto';
import { useApiData } from '../../../../hooks/useApiData';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { apiRequest, invalidateApiCache } from '../../../../services/http/apiClient';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { authConfig } from '../../../../config/authConfig';
import { EmployeeHistoryDrawer } from './EmployeeHistoryDrawer';
import { EmployeeTimesheetDrawer } from './EmployeeTimesheetDrawer';
import { DwellTimeline } from './DwellTimeline';
import { DeviceActivityHeatmap } from './DeviceActivityHeatmap';
import { CameraPresenceHeatmap } from './CameraPresenceHeatmap';
import { ZoneHeatmap } from './ZoneHeatmap';
import { MonthlyAttendanceGrid } from './MonthlyAttendanceGrid';
import { AttendanceAnalytics } from './AttendanceAnalytics';
import { regStore, useRegularizations, type RegRequest } from '../../../../services/regularizationStore';
import { useAttendanceAnomalies } from '../../../../hooks/useAttendanceAnomalies';
import AttendanceCalendar from './AttendanceCalendar';
import { calculateNetWorkingMins, calcBreakSegments, type BreakSegment } from '../../../../utils/attendanceUtils';
type AttendanceStatus = 'Present' | 'Absent' | 'Late' | 'On Break' | 'Weekend';

interface StatusEmployee {
    id: string;
    name: string;
    department: string;
    status: AttendanceStatus;
    checkInTime?: string;
    duration?: string;
    breakDuration?: string;
    location?: string;
    faceEnrolled?: boolean;
    inCount?: number;
    outCount?: number;
    punchInTimes?: string[];
    punchOutTimes?: string[];
    flags?: string[];
    checkInTs?: number | null;
    durationMins?: number | null;
    breakDurationMins?: number | null;
    shift?: string;
    allCheckInsRaw?: { time: string }[];
    allCheckOutsRaw?: { time: string }[];
    isCurrentlyIn?: boolean;
    isModifiedIn?: boolean;
    isModifiedOut?: boolean;
    rawFirstInTime?: string | null;
    rawLastOutTime?: string | null;
    employeeId?: string;
    attendance_date?: string;
}

function formatTime(iso: string | null) {
    if (!iso) return undefined;
    return formatTimeInSiteTz(iso);
}

function formatMins(mins: number | null | undefined) {
    if (!mins || mins <= 0) return undefined;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** API returns department names with stray trailing spaces ("Data Engineering "). */
const cleanDept = (d?: string | null) => ((d ?? '').trim() || '—');

/** Flatten an all_check_ins / all_check_outs array into site-tz time strings. */
function punchTimeList(arr: any): string[] {
    if (!Array.isArray(arr)) return [];
    return arr.map((x: any) => x?.time).filter(Boolean).map((t: string) => formatTimeInSiteTz(t));
}

/** Detect impossible / suspicious attendance rows for a warning badge. */
function detectFlags(r: any): string[] {
    const flags: string[] = [];
    const ci = r.check_in ? new Date(r.check_in).getTime() : null;
    const co = r.check_out ? new Date(r.check_out).getTime() : null;
    if (co != null && ci == null) flags.push('Check-out without a check-in');
    if (ci != null && co != null && co < ci) flags.push('Check-out is before check-in');
    const dur = r.duration_minutes;
    if (co != null && typeof dur === 'number' && dur > 0 && dur < 5) flags.push('Very short session (< 5 min)');
    const hasInPhoto = !!r.checkin_photo_url || (Array.isArray(r.all_check_ins) && r.all_check_ins.some((x: any) => !!x.photo_url));
    if (ci != null && !hasInPhoto) flags.push('Missing check-in photo');
    return flags;
}

// ── Display helpers ─────────────────────────────────────────────────────────
const DEPT_PALETTE = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#ef4444', '#6366f1', '#14b8a6', '#f97316'];
/** Stable per-department colour (API returns one flat colour, so we hash the name). */
const deptColor = (name?: string) => {
    const n = (name ?? '').trim();
    if (!n || n === '—') return '#94a3b8';
    let h = 0;
    for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
    return DEPT_PALETTE[h % DEPT_PALETTE.length];
};
const initials = (name?: string) =>
    (name ?? '').trim().split(/\s+/).filter(Boolean).map(n => n[0]).join('').slice(0, 2).toUpperCase() || '—';

const STATUS_DOT: Record<AttendanceStatus, string> = {
    'Present':  'bg-emerald-500',
    'Late':     'bg-amber-500',
    'On Break': 'bg-blue-500',
    'Absent':   'bg-rose-400',
    'Weekend':  'bg-slate-300',
};

const STATUS_FILTER_LABELS: Record<string, string> = {
    'all': 'All Statuses',
    'Present': 'On Time',
    'present': 'On Time',
    'on time': 'On Time',
    'on-time': 'On Time',
    'Late': 'Late',
    'late': 'Late',
    'Absent': 'Not In Yet',
    'absent': 'Not In Yet',
    'not in yet': 'Not In Yet',
    'not-in-yet': 'Not In Yet',
    'On Break': 'On Break',
    'on-break': 'On Break',
    'on break': 'On Break',
    'Weekend': 'Weekend',
    'weekend': 'Weekend',
};

function normalizeStatusFilter(filter: string): string {
    if (!filter) return 'all';
    const f = filter.toLowerCase().trim();
    if (f === 'all' || !f) return 'all';
    if (f === 'present' || f === 'on time' || f === 'on-time') return 'Present';
    if (f === 'late') return 'Late';
    if (f === 'absent' || f === 'not in yet' || f === 'not-in-yet') return 'Absent';
    if (f === 'on break' || f === 'on-break') return 'On Break';
    if (f === 'weekend') return 'Weekend';
    return filter;
}

function matchesStatusFilter(empStatus: AttendanceStatus, filter: string): boolean {
    const f = (filter || 'all').toLowerCase().trim();
    if (f === 'all' || !f) return true;
    const s = empStatus.toLowerCase().trim();
    if (f === 'present' || f === 'on time' || f === 'on-time') return s === 'present';
    if (f === 'late') return s === 'late';
    if (f === 'absent' || f === 'not in yet' || f === 'not-in-yet') return s === 'absent';
    if (f === 'on break' || f === 'on-break') return s === 'on break';
    if (f === 'weekend') return s === 'weekend';
    return s === f;
}

function isStatusTileActive(colKey: string, activeFilter: string): boolean {
    const a = (activeFilter || 'all').toLowerCase().trim();
    const k = colKey.toLowerCase().trim();
    if (a === 'all') return k === 'all';
    if (k === 'present' || k === 'on time' || k === 'on-time') return a === 'present' || a === 'on time' || a === 'on-time';
    if (k === 'late') return a === 'late';
    if (k === 'absent' || k === 'not in yet' || k === 'not-in-yet') return a === 'absent' || a === 'not in yet' || a === 'not-in-yet';
    return a === k;
}

// ── Sorting ───────────────────────────────────────────────────────────────────
type SortKey = 'name' | 'department' | 'location' | 'status' | 'checkin' | 'duration';
const STATUS_RANK: Record<AttendanceStatus, number> = {
    'Present': 0, 'Late': 1, 'On Break': 2, 'Absent': 3, 'Weekend': 4,
};
function compareEmp(a: StatusEmployee, b: StatusEmployee, key: SortKey): number {
    switch (key) {
        case 'department': return a.department.localeCompare(b.department) || a.name.localeCompare(b.name);
        case 'location':   return (a.location ?? '').localeCompare(b.location ?? '') || a.name.localeCompare(b.name);
        case 'status':     return (STATUS_RANK[a.status] - STATUS_RANK[b.status]) || a.name.localeCompare(b.name);
        case 'checkin':    return (a.checkInTs ?? Number.MAX_SAFE_INTEGER) - (b.checkInTs ?? Number.MAX_SAFE_INTEGER);
        case 'duration':   return (a.durationMins ?? -1) - (b.durationMins ?? -1);
        case 'name':
        default:           return a.name.localeCompare(b.name);
    }
}

/** "2026-07-21" → "July 21, 2026" (timezone-safe, parses the parts directly). */
const fmtDate = (iso: string, withYear = true) => {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US',
        withYear ? { month: 'long', day: 'numeric', year: 'numeric' } : { month: 'long', day: 'numeric' });
};


/** Full-screen zoomed view of a proof photo, with close button + Esc/backdrop close. */
const openPhotoLightbox = (src: string) => {
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 z-[9999] flex items-center justify-center bg-slate-900/90 backdrop-blur-sm cursor-zoom-out transition-opacity duration-300';

    const close = () => {
        if (document.body.contains(modal)) document.body.removeChild(modal);
        document.removeEventListener('keydown', onKey);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };

    modal.onclick = close;

    const img = document.createElement('img');
    img.src = src;
    img.className = 'w-[90vw] md:w-[60vw] max-w-[800px] h-auto max-h-[88vh] rounded-xl shadow-[0_0_50px_rgba(0,0,0,0.5)] border border-slate-700/50 object-contain cursor-default';
    img.onclick = (e) => e.stopPropagation();   // clicking the image keeps it open

    const closeBtn = document.createElement('button');
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.className = 'absolute top-4 right-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-3xl font-light leading-none text-white backdrop-blur transition-colors hover:bg-white/25';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = close;

    const hint = document.createElement('div');
    hint.className = 'absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-xs text-white/70 backdrop-blur';
    hint.textContent = 'Click outside or press Esc to close';

    modal.append(img, closeBtn, hint);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(modal);
};

/** Hover-zoom proof-photo thumbnail (check-in = emerald / check-out = blue). */
const PhotoThumb: React.FC<{ photo?: string | null; tone: 'in' | 'out'; label?: string }> = ({ photo, tone, label }) => {
    const ring     = tone === 'in' ? 'ring-emerald-500/40 hover:ring-emerald-400' : 'ring-blue-500/40 hover:ring-blue-400';
    const labelCls = tone === 'in' ? 'text-emerald-600' : 'text-blue-600';
    const origin   = tone === 'in' ? 'center left' : 'center right';
    // /uploads requires a Bearer token, so a plain <img src> would 401 — fetch
    // it authenticated and render the resulting blob URL instead.
    const { url, loading, error } = useAuthedPhotoUrl(photo);
    return (
        <div className="flex flex-col items-center gap-0.5 shrink-0">
            {photo && url ? (
                <img
                    src={url}
                    loading="lazy"
                    decoding="async"
                    onClick={() => openPhotoLightbox(url)}
                    className={cn(
                        'h-12 w-16 shrink-0 rounded-lg object-cover shadow-sm cursor-zoom-in ring-1 relative z-0',
                        'transition-transform duration-200 ease-out hover:z-50 hover:scale-[2.2] hover:shadow-2xl hover:ring-2',
                        ring,
                    )}
                    style={{ transformOrigin: origin }}
                />
            ) : (
                <div title={error ? 'Failed to load photo' : loading ? 'Loading photo…' : 'No photo'} className="flex h-12 w-16 shrink-0 items-center justify-center rounded-lg border border-dashed border-border bg-muted/40">
                    <Camera className="h-3.5 w-3.5 text-muted-foreground/40" />
                </div>
            )}
            {label && <span className={cn('text-[9px] font-bold uppercase tracking-wide', photo ? labelCls : 'text-muted-foreground/40')}>{label}</span>}
        </div>
    );
};

/** Click-to-open list of every punch time for a multi-punch employee. */
const PunchPopover: React.FC<{ count: number; times: string[]; tone: 'in' | 'out' }> = ({ count, times, tone }) => {
    const pill = tone === 'in' ? 'bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20' : 'bg-blue-500/10 text-blue-600 hover:bg-blue-500/20';
    const dot  = tone === 'in' ? 'bg-emerald-500' : 'bg-blue-500';
    return (
        <Popover>
            <PopoverTrigger asChild>
                <button className={cn('inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-sans text-[10px] font-bold not-italic transition-colors', pill)}>
                    <Repeat className="h-2.5 w-2.5" />{count}
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-56 p-0">
                <div className="border-b border-border px-3 py-2 text-xs font-bold text-foreground">
                    {tone === 'in' ? 'Check-ins' : 'Check-outs'} · {count}
                </div>
                <div className="max-h-56 overflow-y-auto p-1">
                    {times.length ? times.map((t, i) => (
                        <div key={i} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent/50">
                            <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
                            <span className="font-mono text-foreground">{t}</span>
                            <span className="ml-auto text-muted-foreground">#{i + 1}</span>
                        </div>
                    )) : <div className="px-2 py-3 text-center text-xs text-muted-foreground">No timestamps</div>}
                </div>
            </PopoverContent>
        </Popover>
    );
};

/** Windowed page numbers: 1 … 4 5 6 … 20 (never renders hundreds of buttons). */
function pageWindow(current: number, totalPages: number): (number | '…')[] {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const out: (number | '…')[] = [1];
    const start = Math.max(2, current - 1);
    const end = Math.min(totalPages - 1, current + 1);
    if (start > 2) out.push('…');
    for (let i = start; i <= end; i++) out.push(i);
    if (end < totalPages - 1) out.push('…');
    out.push(totalPages);
    return out;
}

export const AttendanceStatusDashboard: React.FC = () => {
    const { accessToken, isAuthenticated, sites, activeScope, setActiveScope } = useAuth();
    const siteToday = useMemo(() =>
        new Intl.DateTimeFormat('en-CA', { timeZone: (window as any).__siteTz || 'Asia/Kolkata' }).format(new Date()),
    []);



    // ── Deep-linked view state (URL query params) ─────────────────────────────
    const setQueryParams                  = useQueryParams();
    const [rawActiveFilter, setActiveFilter] = useQueryParam('status', 'all');
    const activeFilter                    = useMemo(() => normalizeStatusFilter(rawActiveFilter), [rawActiveFilter]);
    const [searchQuery, setSearchQuery]   = useQueryParam('q');
    const [selectedDate, setSelectedDate] = useQueryParam('date', siteToday);

    const [deptFilter, setDeptFilter]     = useQueryParam('dept', 'all');
    const [sortParam, setSortParam]       = useQueryParam('sort', 'status');
    const [view, setView]                 = useQueryParam('view', 'daily');
    const [monthParam]                    = useQueryParam('m', siteToday.slice(0, 7));
    const [historyParam, setHistoryParam] = useQueryParam('employee', '');
    const isDeepLinkedHistoryRef = useRef(!!historyParam);
    const [fromOpen, setFromOpen]         = useState(false);
    const tableRef = useRef<HTMLDivElement>(null);
    const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const skipNextPageScrollRef = useRef(false);

    const scrollToRoster = useCallback(() => {
        if (scrollTimeoutRef.current) {
            clearTimeout(scrollTimeoutRef.current);
        }
        scrollTimeoutRef.current = setTimeout(() => {
            requestAnimationFrame(() => {
                if (!tableRef.current) return;
                const HEADER_OFFSET = 96; // Offset for sticky navbar header + padding
                const elementPosition = tableRef.current.getBoundingClientRect().top + window.scrollY;
                const offsetPosition = elementPosition - HEADER_OFFSET;

                window.scrollTo({
                    top: Math.max(0, offsetPosition),
                    behavior: 'smooth'
                });
            });
            scrollTimeoutRef.current = null;
        }, 100);
    }, []);

    const handleStatusTileClick = useCallback((colKey: string) => {
        const current = normalizeStatusFilter(rawActiveFilter);
        const nextStatus = current === colKey ? null : colKey;
        skipNextPageScrollRef.current = true;
        setQueryParams({ status: nextStatus }); setPage(1);
        setSelectedIds(new Set());
        scrollToRoster();
    }, [rawActiveFilter, setQueryParams, scrollToRoster]);

    const [sortKey, sortDir] = useMemo(() => {
        const [k, d] = (sortParam || 'status').split(':');
        return [k as SortKey, d === 'desc' ? 'desc' : 'asc'] as const;
    }, [sortParam]);
    const toggleSort = (k: SortKey) =>
        setSortParam(sortKey === k ? (sortDir === 'asc' ? `${k}:desc` : k) : k);

    const [isExporting, setIsExporting] = useState(false);
    const [correctionTarget, setCorrectionTarget] = useState<StatusEmployee | null>(null);
    const [correctionForm, setCorrectionForm] = useState({ status: 'present', check_in: '', check_out: '', note: '' });
    const [correctionMode, setCorrectionMode] = useState<'apply' | 'request'>('apply');
    const [isCorrecting, setIsCorrecting] = useState(false);
    const [correctionCount, setCorrectionCount] = useState(0);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [bulkSavingAction, setBulkSavingAction] = useState<'present' | 'late' | 'absent' | null>(null);

    // ── Regularization / approval workflow ──────────────────────────────────────
    const regRequests = useRegularizations();
    const pendingRequests = useMemo(() => regRequests.filter(r => r.status === 'pending'), [regRequests]);
    const [showApprovals, setShowApprovals] = useState(false);
    const [approvalsTab, setApprovalsTab] = useState<'pending' | 'history'>('pending');
    const [approvingId, setApprovingId] = useState<string | null>(null);
    const setHistoryEmployee = (v: { id: string; name: string } | null) => setHistoryParam(v ? v.id : '');

    const { employees, attendance, isLoading, error, refresh, lastRefreshed } = useApiData({
        autoRefreshMs: 30000,
    });

    const scopeHeaders = useScopeHeaders();

    // Force fresh fetch on mount and whenever active scope headers update
    React.useEffect(() => { refresh(); }, [JSON.stringify(scopeHeaders)]);

    const [weeklyData, setWeeklyData] = useState<any[]>([]);
    React.useEffect(() => {
        if (!isAuthenticated) return;
        apiRequest('/live/trends/weekly', { accessToken, scopeHeaders })
            .then((res: any) => { if (res?.data) setWeeklyData(res.data); })
            .catch(() => null);
    }, [accessToken]);

    const [weeklyAttendance, setWeeklyAttendance] = useState<any[]>([]);
    React.useEffect(() => {
        if (!isAuthenticated) return;
        
        // Calculate the last 7 days range in the site's local timezone
        const tz = (window as any).__siteTz || 'Asia/Kolkata';
        const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
        const today = new Date(todayStr + 'T12:00:00');
        const start = new Date(today);
        start.setDate(start.getDate() - 6);
        const fromDate = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(start);
        
        apiRequest<{ data: any[] }>(
            `/live/attendance?fromDate=${fromDate}&toDate=${todayStr}&limit=5000`,
            { accessToken, scopeHeaders }
        )
            .then((res: any) => { if (res?.data) setWeeklyAttendance(res.data); })
            .catch(() => null);
    }, [accessToken, isAuthenticated, scopeHeaders]);

    // Historical attendance for non-today date selections
    const isToday = selectedDate === siteToday;
    const [historicalAtt, setHistoricalAtt] = useState<any[]>([]);
    const [histLoading, setHistLoading] = useState(false);
    useEffect(() => {
        if (isToday) { setHistoricalAtt([]); return; }
        setHistLoading(true);
        apiRequest<{ data: any[] }>(
            `/live/attendance?fromDate=${selectedDate}&toDate=${selectedDate}&limit=10000`,
            { accessToken, scopeHeaders, noCache: true }
        )
            .then((res: any) => setHistoricalAtt(res?.data ?? []))
            .catch(() => setHistoricalAtt([]))
            .finally(() => setHistLoading(false));
    }, [selectedDate, isToday, accessToken, scopeHeaders]);

    // Build status employee list from today's attendance + employee list
    const statusEmployees = useMemo<StatusEmployee[]>(() => {
        // For today: filter from the live LEFT-JOIN dataset (all employees, attendance_date = today)
        // For past dates: use the historical fetch (JOIN path, only records that exist)
        let todayRecords: any[];
        if (isToday) {
            todayRecords = attendance.filter(a => {
                if (!a.attendance_date) return false;
                const ds = a.attendance_date.includes('T')
                    ? new Intl.DateTimeFormat('en-CA', { timeZone: (window as any).__siteTz || 'Asia/Kolkata' }).format(new Date(a.attendance_date))
                    : a.attendance_date.slice(0, 10);
                return ds === selectedDate;
            });
        } else {
            todayRecords = historicalAtt;
        }
        const attendedIds = new Set(todayRecords.map((r: any) => String(r.fk_employee_id)));

        // Build map of employee_id → { dept, location, faceEnrolled }.
        // Attendance records carry null location_label, so we backfill from here.
        const empInfoMap = new Map<string, { dept: string; location: string; faceEnrolled: boolean; shift: string }>();
        employees.forEach(e => {
            const sn = (e as any).shift_name;
            const st = (e as any).start_time?.slice(0, 5);
            const et = (e as any).end_time?.slice(0, 5);
            empInfoMap.set(String(e.pk_employee_id), {
                dept:         cleanDept((e as any).department_name),
                location:     (e as any).location_label || '—',
                faceEnrolled: !!(e as any).face_enrolled,
                shift:        sn ? (st && et ? `${sn} · ${st}–${et}` : sn) : '—',
            });
        });

        const fromRecords: StatusEmployee[] = todayRecords.map(r => {
            const info = empInfoMap.get(String(r.fk_employee_id));
            // Stored status is "present" even for late arrivals — derive Late from the flag.
            const base: AttendanceStatus =
                  r.status === 'on-break' ? 'On Break'
                : r.status === 'weekend'  ? 'Weekend'
                : r.status === 'absent'   ? 'Absent'
                : r.status === 'late'     ? 'Late'
                : 'Present';
            const isLate = ((r as any).is_late_computed ?? (r as any).is_late) === true;
            const status: AttendanceStatus = base === 'Present' && isLate ? 'Late' : base;
            const recDept = cleanDept((r as any).department_name);

            const segmentBreakMins = calcBreakSegments((r as any).all_check_ins ?? [], (r as any).all_check_outs ?? []).reduce((sum, s) => sum + s.mins, 0);
            const dbBreakMins = (r as any).break_duration_minutes ? Math.min(Number((r as any).break_duration_minutes), 60) : 0;
            const breakMins = segmentBreakMins > 0 ? segmentBreakMins : dbBreakMins;

            const checkInMs = r.check_in ? new Date(r.check_in).getTime() : null;

            const netWorkingMins = calculateNetWorkingMins(r, isToday);

            const lastInTs = Array.isArray((r as any).all_check_ins) && (r as any).all_check_ins.length > 0
                ? Math.max(...(r as any).all_check_ins.map((x: any) => new Date(x.time).getTime()).filter((t: number) => !isNaN(t)))
                : (checkInMs ?? 0);

            const lastOutTs = Array.isArray((r as any).all_check_outs) && (r as any).all_check_outs.length > 0
                ? Math.max(...(r as any).all_check_outs.map((x: any) => new Date(x.time).getTime()).filter((t: number) => !isNaN(t)))
                : (r.check_out ? new Date(r.check_out).getTime() : 0);

            const isCurrentlyIn = Boolean(
                isToday &&
                checkInMs &&
                (status === 'Present' || status === 'Late') &&
                (!r.check_out || checkInMs > new Date(r.check_out).getTime() || lastInTs >= lastOutTs)
            );

            const punchInTimes = punchTimeList((r as any).all_check_ins);
            const punchOutTimes = punchTimeList((r as any).all_check_outs);
            const checkInTimeStr = formatTime(r.check_in);
            const checkOutTimeStr = r.check_out ? formatTimeInSiteTz(r.check_out) : null;
            const rawFirstInTime = punchInTimes.length > 0 ? punchInTimes[0] : null;
            const rawLastOutTime = punchOutTimes.length > 0 ? punchOutTimes[punchOutTimes.length - 1] : null;
            const isModifiedIn = Boolean(checkInTimeStr && rawFirstInTime && checkInTimeStr !== rawFirstInTime);
            const isModifiedOut = Boolean(checkOutTimeStr && rawLastOutTime && checkOutTimeStr !== rawLastOutTime);

            const recordDate = r.attendance_date ? r.attendance_date.slice(0, 10) : selectedDate;
            return {
                id:            String(r.fk_employee_id),
                employeeId:    String(r.fk_employee_id),
                code:          r.employee_code || (r as any).employeeCode || (info as any)?.code || '',
                name:          r.full_name,
                department:    recDept !== '—' ? recDept : (info?.dept ?? '—'),
                location:      info?.location || (r as any).location_label || '—',
                faceEnrolled:  info?.faceEnrolled ?? true,
                shift:         info?.shift ?? '—',
                status,
                checkInTime:   checkInTimeStr,
                duration:      formatMins(netWorkingMins),
                breakDuration: formatMins(breakMins),
                checkInTs:     checkInMs,
                durationMins:  netWorkingMins,
                breakDurationMins: breakMins,
                inCount:       Number((r as any).check_in_count) || 0,
                outCount:      Number((r as any).check_out_count) || 0,
                punchInTimes,
                punchOutTimes,
                flags:         detectFlags(r),
                checkin_photo:  (r as any).checkin_photo_url || (Array.isArray((r as any).all_check_ins) ? (r as any).all_check_ins.find((x: any) => !!x.photo_url)?.photo_url : null) || (r as any).checkin_frame_url || (r as any).frame_url || null,
                checkout_photo: (r as any).checkout_photo_url || (Array.isArray((r as any).all_check_outs) ? [...(r as any).all_check_outs].reverse().find((x: any) => !!x.photo_url)?.photo_url : null) || (r as any).checkout_frame_url || null,
                check_out_time: checkOutTimeStr,
                allCheckInsRaw:  Array.isArray((r as any).all_check_ins)  ? (r as any).all_check_ins  : [],
                allCheckOutsRaw: Array.isArray((r as any).all_check_outs) ? (r as any).all_check_outs : [],
                isCurrentlyIn,
                isModifiedIn,
                isModifiedOut,
                rawFirstInTime,
                rawLastOutTime,
                attendance_date: recordDate,
            } as any;
        });

        // Employees with no record today → Absent
        const absentEmployees: StatusEmployee[] = employees
            .filter(e => {
                if (e.status !== 'active') return false;
                if (e.join_date) {
                    const jd = e.join_date.includes('T') ? e.join_date.slice(0, 10) : e.join_date;
                    if (jd > selectedDate) return false;
                }
                return !attendedIds.has(String(e.pk_employee_id));
            })
            .map(e => {
                const info = empInfoMap.get(String(e.pk_employee_id));
                return {
                    id:           String(e.pk_employee_id),
                    code:         e.employee_code || '',
                    name:         e.full_name,
                    department:   info?.dept ?? cleanDept((e as any).department_name),
                    location:     info?.location ?? '—',
                    faceEnrolled: info?.faceEnrolled ?? true,
                    shift:        info?.shift ?? '—',
                    status:       'Absent' as AttendanceStatus,
                    checkInTs:    null,
                    durationMins: null,
                    breakDurationMins: null,
                };
            });

        return [...fromRecords, ...absentEmployees];
    }, [attendance, employees, selectedDate, isToday, historicalAtt]);

    const getCount = (s: AttendanceStatus) => statusEmployees.filter(e => e.status === s).length;

    // Deep-linked history drawer target, resolved from ?employee=<id>.
    const historyEmployee = useMemo(() => {
        if (!historyParam) return null;
        const found = statusEmployees.find(e => e.id === historyParam || (e as any).code === historyParam);
        return { id: historyParam, name: found?.name ?? historyParam };
    }, [historyParam, statusEmployees]);

    const anomalies = useAttendanceAnomalies(weeklyAttendance.length > 0 ? weeklyAttendance : attendance, employees);
    const anomalyMap = useMemo(() => {
        const m = new Map<string, typeof anomalies>();
        anomalies.forEach(a => {
            if (!m.has(a.employeeId)) m.set(a.employeeId, []);
            m.get(a.employeeId)!.push(a);
        });
        return m;
    }, [anomalies]);

    // ── Live entry counter (RTE) ──────────────────────────────────────────────
    const [liveEntryCount, setLiveEntryCount] = useState(0);
    const liveEntryRef = useRef(0);
    useEffect(() => {
        const unsub = realtimeEngine.subscribe(RteEventType.EMPLOYEE_ENTRY, () => {
            liveEntryRef.current += 1;
            setLiveEntryCount(liveEntryRef.current);
        });
        return () => unsub();
    }, []);

    const { departments: realDepartments } = useDepartmentsAndShifts();
    const departments = useMemo(() => {
        const names = new Set<string>();
        realDepartments.forEach(d => names.add(d.name));
        statusEmployees.forEach(e => {
            if (e.department && e.department !== '—') names.add(e.department);
        });
        return ['all', ...Array.from(names)];
    }, [realDepartments, statusEmployees]);

    const filtered = useMemo(() => {
        let result = statusEmployees.filter(e => matchesStatusFilter(e.status, activeFilter));
        if (deptFilter && deptFilter !== 'all') {
            const df = deptFilter.toLowerCase();
            result = result.filter(e => e.department && e.department.toLowerCase() === df);
        }
        if (searchQuery.trim()) {
            const q = searchQuery.trim().toLowerCase();
            result = result.filter(e => 
                (e.name && e.name.toLowerCase().includes(q)) ||
                (e.department && e.department.toLowerCase().includes(q)) ||
                (e.id && e.id.toLowerCase().includes(q)) ||
                ((e as any).code && String((e as any).code).toLowerCase().includes(q)) ||
                (e.location && e.location.toLowerCase().includes(q))
            );
        }
        return result;
    }, [statusEmployees, activeFilter, searchQuery, deptFilter]);

    const sorted = useMemo(() => {
        const arr = [...filtered];
        arr.sort((a, b) => {
            const c = compareEmp(a, b, sortKey);
            return sortDir === 'asc' ? c : -c;
        });
        return arr;
    }, [filtered, sortKey, sortDir]);

    const openCorrection = (emp: StatusEmployee) => {
        setCorrectionTarget(emp);
        setCorrectionMode('apply');
        setCorrectionForm({
            status: emp.status === 'Present' || emp.status === 'Late' ? 'absent' : 'present',
            check_in: (emp as any).checkInTime ?? '',
            check_out: (emp as any).check_out_time ?? '',
            note: '',
        });
    };

    const handleCorrection = async () => {
        if (!correctionTarget) return;
        setIsCorrecting(true);
        try {
            await apiRequest('/attendance/correction', {
                method: 'POST', accessToken, scopeHeaders,
                body: JSON.stringify({
                    employee_id: correctionTarget.employeeId || correctionTarget.id,
                    date: correctionTarget.attendance_date || selectedDate,
                    status: correctionForm.status,
                    check_in: correctionForm.check_in || undefined,
                    check_out: correctionForm.check_out || undefined,
                    note: correctionForm.note || undefined,
                }),
            });
            regStore.record({
                employeeId: correctionTarget.employeeId || correctionTarget.id, employeeName: correctionTarget.name, department: correctionTarget.department,
                date: correctionTarget.attendance_date || selectedDate, fromStatus: correctionTarget.status, toStatus: correctionForm.status,
                checkIn: correctionForm.check_in || undefined, checkOut: correctionForm.check_out || undefined,
                reason: correctionForm.note || '—', requestedBy: 'HR (direct override)',
            }, 'approved', 'Direct override');
            toast.success(`Attendance corrected for ${correctionTarget.name}`);
            setCorrectionTarget(null);
            setCorrectionCount(c => c + 1);
            invalidateApiCache('/live');
            refresh();
        } catch (err: any) {
            // apiRequest throws ApiError with `.message` populated from the backend's
            // `error`/`message` response field (see apiClient.ts) — surface that when
            // present, falling back to a generic message otherwise (e.g. network failure).
            toast.error(err?.message || 'Correction failed — check API connection');
        } finally { setIsCorrecting(false); }
    };

    // Submit the override as a pending request instead of applying it directly.
    const handleSubmitRequest = () => {
        if (!correctionTarget) return;
        regStore.add({
            employeeId:   correctionTarget.employeeId || correctionTarget.id,
            employeeName: correctionTarget.name,
            department:   correctionTarget.department,
            date:         correctionTarget.attendance_date || selectedDate,
            fromStatus:   correctionTarget.status,
            toStatus:     correctionForm.status,
            checkIn:      correctionForm.check_in || undefined,
            checkOut:     correctionForm.check_out || undefined,
            reason:       correctionForm.note || '—',
            requestedBy:  'HR Manager',
        });
        toast.success(`Regularization request submitted for ${correctionTarget.name}`);
        setCorrectionTarget(null);
    };

    const approveRequest = async (req: RegRequest) => {
        setApprovingId(req.id);
        try {
            await apiRequest('/attendance/correction', {
                method: 'POST', accessToken, scopeHeaders,
                body: JSON.stringify({
                    employee_id: req.employeeId, date: req.date, status: req.toStatus,
                    check_in: req.checkIn || undefined, check_out: req.checkOut || undefined,
                    note: `Regularization approved — ${req.reason}`,
                }),
            });
            regStore.decide(req.id, 'approved');
            setCorrectionCount(c => c + 1);
            toast.success(`Approved — ${req.employeeName} marked ${req.toStatus}`);
            invalidateApiCache('/live');
            refresh();
        } catch {
            toast.error('Failed to apply approval');
        } finally { setApprovingId(null); }
    };
    const rejectRequest = (req: RegRequest) => {
        regStore.decide(req.id, 'rejected');
        toast(`Request rejected for ${req.employeeName}`);
    };
    const approveAll = async () => {
        for (const req of pendingRequests) await approveRequest(req);
    };

    // ── Bulk regularisation ────────────────────────────────────────────────────
    const toggleSelect = (id: string) =>
        setSelectedIds(prev => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    const clearSelection = () => setSelectedIds(new Set());

    const bulkRegularize = async (status: 'present' | 'late' | 'absent') => {
        const ids = [...selectedIds];
        if (!ids.length) return;
        setBulkSavingAction(status);
        try {
            const empById = new Map<string, StatusEmployee>(statusEmployees.map(e => [e.id, e]));
            
            const validIds = ids.filter(id => {
                const e = empById.get(id);
                return e?.status?.toLowerCase() !== status;
            });
            const skippedCount = ids.length - validIds.length;

            if (validIds.length === 0) {
                toast.info(`Selected employee(s) are already marked as ${status}.`);
                clearSelection();
                return;
            }

            const results = await Promise.allSettled(validIds.map(id => {
                const e = empById.get(id);
                return apiRequest('/attendance/correction', {
                    method: 'POST', accessToken, scopeHeaders,
                    body: JSON.stringify({
                        employee_id: e?.employeeId || id,
                        date: e?.attendance_date || selectedDate,
                        status, note: `Bulk ${status} by HR`,
                    }),
                });
            }));
            validIds.forEach((id, i) => {
                if (results[i].status !== 'fulfilled') return;
                const e = empById.get(id);
                regStore.record({
                    employeeId: e?.employeeId || id, employeeName: e?.name ?? id, department: e?.department,
                    date: e?.attendance_date || selectedDate, fromStatus: e?.status ?? '—', toStatus: status,
                    reason: 'Bulk action', requestedBy: 'HR (bulk)',
                }, 'approved', 'Bulk override');
            });
            
            const ok = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.length - ok;
            
            if (ok > 0) {
                let msg = `Marked ${ok} employee${ok !== 1 ? 's' : ''} ${status}.`;
                if (skippedCount > 0) msg += ` ${skippedCount} employee${skippedCount !== 1 ? 's were' : ' was'} already marked ${status}.`;
                toast.success(msg);
            } else if (skippedCount > 0 && failed === 0) {
                toast.info(`${skippedCount} employee${skippedCount !== 1 ? 's' : ''} already marked as ${status}.`);
            }
            
            if (failed > 0) {
                const firstErr = (results.find(r => r.status === 'rejected') as PromiseRejectedResult)?.reason;
                const errMsg = firstErr?.message || firstErr?.toString() || 'failed';
                toast.error(failed === 1 ? `Update failed: ${errMsg}` : `${failed} updates failed (e.g. ${errMsg})`);
            }
            
            setCorrectionCount(c => c + ok);
            clearSelection();
            invalidateApiCache('/live');
            refresh();
        } finally { setBulkSavingAction(null); }
    };

  const handleExport = async (fmt: 'xlsx' | 'csv' = 'xlsx') => {
    setIsExporting(true);
    try {
      const params = new URLSearchParams({ fromDate: selectedDate });
      params.set('toDate', selectedDate);
      if (activeFilter !== 'all')          params.set('status',     activeFilter.toLowerCase().replace(' ', '-'));
      if (deptFilter   !== 'all')          params.set('department', deptFilter);
      if (searchQuery.trim())              params.set('search',     searchQuery.trim());

      // Filter out undefined values from scopeHeaders before passing to fetch
      const cleanHeaders: Record<string, string> = {};
      if (accessToken) cleanHeaders['Authorization'] = `Bearer ${accessToken}`;
      Object.entries(scopeHeaders).forEach(([k, v]) => { if (v !== undefined) cleanHeaders[k] = String(v); });

      const res = await fetch(
        `${authConfig.apiBaseUrl}/attendance/export/${fmt}?${params}`,
        { credentials: 'include', headers: cleanHeaders }
      );

      if (!res.ok) {
        let errMsg = `Server error ${res.status}`;
        try { const body = await res.json(); errMsg = body.message || errMsg; } catch {}
        throw new Error(errMsg);
      }

      const blob = await res.blob();
      if (blob.size === 0) throw new Error('Received empty file from server');

      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `attendance-${selectedDate}.${fmt}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err: any) {
      toast.error('Export failed', { description: err.message });
    } finally {
      setIsExporting(false);
    }
  };


    const statusBadge = (s: AttendanceStatus) => {
        const map: Record<AttendanceStatus, string> = {
            'Present':  'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
            'Late':     'bg-amber-500/10 text-amber-600 border-amber-500/20',
            'On Break': 'bg-blue-500/10 text-blue-600 border-blue-500/20',
            'Absent':   'bg-red-500/10 text-red-600 border-red-500/20',
            'Weekend':  'bg-slate-500/10 text-slate-600 border-slate-500/20',
        };
        return map[s] ?? 'bg-slate-500/10 text-slate-500';
    };

    const [page, setPage] = useState<number>(1);
    const [PER, setPER] = useState<number>(10);

    // ── Roster table options ────────────────────────────────────────────────────
    const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');
    const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set());
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const showCol = (k: string) => !hiddenCols.has(k);
    const toggleCol = (k: string) => setHiddenCols(prev => {
        const next = new Set(prev);
        next.has(k) ? next.delete(k) : next.add(k);
        return next;
    });
    const ROSTER_COLS: { key: string; label: string }[] = [
        { key: 'department', label: 'Department' }, { key: 'location', label: 'Location' },
        { key: 'shift', label: 'Shift' }, { key: 'status', label: 'Status' },
        { key: 'checkin', label: 'Check-in' }, { key: 'checkout', label: 'Check-out' },
        { key: 'duration', label: 'Duration' }, { key: 'break', label: 'Break' }, { key: 'proof', label: 'Proof' },
    ];
    const sortArrow = (k: SortKey) => sortKey === k
        ? (sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
        : <ChevronsUpDown className="h-3 w-3 opacity-30" />;
    const visibleColCount = 3 + ROSTER_COLS.filter(c => showCol(c.key)).length; // checkbox + employee + actions(=3) + toggleable

    const handlePageChange = (newPage: number) => {
        setPage(newPage);
        scrollToRoster();
    };

    // Filter resets are handled directly in filter change callbacks

    // Smoothly scroll to attendance records section when user navigates pages
    const isFirstPageMount = useRef(true);
    useEffect(() => {
        if (isFirstPageMount.current) {
            isFirstPageMount.current = false;
            return;
        }
        if (skipNextPageScrollRef.current) {
            skipNextPageScrollRef.current = false;
            return;
        }
        scrollToRoster();
    }, [page, scrollToRoster]);

    const total = sorted.length;
    const pages = Math.max(1, Math.ceil(total / PER));
    const effectivePage = Math.min(Math.max(1, page), pages);
    const pagedFiltered = useMemo(() => {
        return sorted.slice((effectivePage - 1) * PER, effectivePage * PER);
    }, [sorted, effectivePage, PER]);


    // ── KPIs ──────────────────────────────────────────────────────────────────
    const kpis = useMemo(() => {
        const present = statusEmployees.filter(e => e.status === 'Present').length;
        const late    = statusEmployees.filter(e => e.status === 'Late').length;
        const weekend = statusEmployees.filter(e => e.status === 'Weekend').length;
        const eligible = Math.max(0, statusEmployees.length - weekend);
        const durations = statusEmployees
            .map(e => e.durationMins)
            .filter((m): m is number => typeof m === 'number' && m > 0);
        const avgMins = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
        const liveCurrentlyIn = attendance.filter(a => {
            if (!a.check_in) return false;
            const checkInMs = new Date(a.check_in).getTime();
            const checkOutMs = a.check_out ? new Date(a.check_out).getTime() : null;
            return (a.status === 'present' || a.status === 'late' || a.status === 'Present' || a.status === 'Late') && (!checkOutMs || checkInMs > checkOutMs);
        }).length;
        const currentlyIn = isToday ? statusEmployees.filter(e => (e as any).isCurrentlyIn === true).length : liveCurrentlyIn;
        return {
            attendancePct: eligible ? Math.round(((present + late) / eligible) * 100) : 0,
            punctualityPct: (present + late) ? Math.round((present / (present + late)) * 100) : 0,
            avgHours: formatMins(avgMins) ?? '0m',
            currentlyIn,
        };
    }, [statusEmployees]);

    const [timesheetTarget, setTimesheetTarget] = useState<{ id: string; name: string } | null>(null);

    // ── Alerts (derived from today's data) ──────────────────────────────────────
    const [showAlerts, setShowAlerts] = useState(false);
    const alerts = useMemo(() => {
        const dataIssues = statusEmployees.filter(e => e.flags && e.flags.length > 0);
        const noCheckout = statusEmployees.filter(e =>
            (e.status === 'Present' || e.status === 'Late') && e.checkInTime && !(e as any).check_out_time);
        const lateToday = statusEmployees.filter(e => e.status === 'Late');
        return { anomalies, dataIssues, noCheckout, lateToday };
    }, [statusEmployees, anomalies]);
    const actionableAlerts = alerts.anomalies.length + alerts.dataIssues.length;

    return (
        <div className="space-y-6">
            {/* ── HERO HEADER ─────────────────────────────────────────────── */}
            <div className="relative overflow-hidden rounded-3xl border border-border bg-gradient-to-br from-primary/10 via-card to-card p-5 shadow-sm sm:p-6">
                <div className="absolute -right-8 -top-10 h-40 w-40 rounded-full bg-primary/10 blur-3xl" />
                <div className="absolute -bottom-12 left-24 h-36 w-36 rounded-full bg-emerald-500/5 blur-3xl" />
                <div className="relative flex flex-wrap items-start justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/15 text-primary shadow-sm">
                            <CalendarDays className="h-6 w-6" />
                        </div>
                        <div className="min-w-0">
                            <div className="flex items-center gap-2">
                                <h1 className="text-2xl font-bold tracking-tight text-foreground">Attendance Status</h1>
                                {view === 'daily' && statusEmployees.length > 0 && (
                                    <span className={cn('rounded-full px-2 py-0.5 text-xs font-bold',
                                        kpis.attendancePct >= 90 ? 'bg-emerald-500/10 text-emerald-600'
                                        : kpis.attendancePct >= 75 ? 'bg-amber-500/10 text-amber-600'
                                        : 'bg-rose-500/10 text-rose-600')}>
                                        {kpis.attendancePct}% present
                                    </span>
                                )}
                            </div>
                            <p className="mt-0.5 text-sm text-muted-foreground">
                                {view === 'monthly' ? (
                                    'Monthly attendance overview'
                                ) : (
                                    <>
                                        {isToday ? 'Today' : fmtDate(selectedDate)} · {(() => {
                                            const [y, m, d] = selectedDate.split('-').map(Number);
                                            return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long' });
                                        })()}
                                    </>
                                )}
                            </p>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {/* Daily / Monthly / Analytics toggle */}
                        <div className="inline-flex rounded-xl border border-border bg-muted/50 p-1">
                            {([['daily', 'Daily'], ['monthly', 'Monthly'], ['analytics', 'Analytics']] as const).map(([v, label]) => (
                                <button
                                    key={v}
                                    onClick={() => setView(v)}
                                    className={cn(
                                        'rounded-lg px-3.5 py-1 text-sm font-semibold transition-colors',
                                        view === v ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                                    )}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                        <div className="mx-1 hidden h-7 w-px bg-border sm:block" />
                        {view === 'daily' && liveEntryCount > 0 && (
                            <span className="flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300">
                                <Radio className="h-3 w-3 animate-pulse" /><LogIn className="h-3 w-3" />
                                <span className="font-black">{liveEntryCount}</span> live
                            </span>
                        )}
                        {view === 'daily' && correctionCount > 0 && (
                            <span className="flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300">
                                <FilePen className="h-3 w-3" /><span className="font-black">{correctionCount}</span> corrected
                            </span>
                        )}
                        {/* <Button variant="outline" size="sm" onClick={() => setShowAlerts(true)} className="relative gap-1.5 rounded-xl" title="Alerts">
                            <Bell className="h-3.5 w-3.5" />
                            {actionableAlerts > 0 && (
                                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-black text-white">
                                    {actionableAlerts}
                                </span>
                            )}
                        </Button> */}
                        <Button variant="outline" size="sm" onClick={() => setShowApprovals(true)} className="relative gap-1.5 rounded-xl">
                            <ClipboardCheck className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">Audit Trail</span>
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => refresh()} disabled={isLoading} className="gap-1.5 rounded-xl">
                            {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                            <span className="hidden sm:inline">Refresh</span>
                        </Button>
                        {view === 'daily' && (
                            <Popover>
                                <PopoverTrigger asChild>
                                    <Button size="sm" disabled={isExporting} className="gap-1.5 rounded-xl">
                                        {isExporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                                        Export
                                    </Button>
                                </PopoverTrigger>
                                <PopoverContent align="end" className="w-44 p-1">
                                    <button onClick={() => handleExport('xlsx')} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-accent">
                                        <Download className="h-3.5 w-3.5 text-emerald-600" /> Excel (.xlsx)
                                    </button>
                                    <button onClick={() => handleExport('csv')} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-accent">
                                        <Download className="h-3.5 w-3.5 text-blue-600" /> CSV (.csv)
                                    </button>
                                </PopoverContent>
                            </Popover>
                        )}
                    </div>
                </div>
            </div>

            {(isLoading || histLoading) && (
                <div className="w-full h-1 bg-primary/10 overflow-hidden rounded-full relative -mt-2">
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

            {view === 'monthly' && (
                <MonthlyAttendanceGrid
                    employees={employees}
                    accessToken={accessToken}
                    scopeHeaders={scopeHeaders}
                    siteToday={siteToday}
                    onPickEmployee={(id, name) => setTimesheetTarget({ id, name })}
                    onOpenDate={(d) => { setSelectedDate(d); setView('daily'); }}
                />
            )}

            {view === 'analytics' && (
                <div className="space-y-5">
                    <AttendanceAnalytics
                        employees={employees}
                        accessToken={accessToken}
                        scopeHeaders={scopeHeaders}
                        selectedDate={selectedDate}
                    />
                    <DeviceActivityHeatmap />
                    <ZoneHeatmap title="Zone Activity Heatmap" bizHoursOnly />
                </div>
            )}

            {view === 'daily' && (
                <div className={cn("transition-opacity duration-300", (isLoading || histLoading) && "opacity-60 pointer-events-none")}>
            {error && (
                <div className="mb-6 flex items-center justify-between rounded-2xl border border-rose-200 bg-rose-50/90 p-4 text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300 shadow-sm">
                    <div className="flex items-center gap-3">
                        <AlertCircle className="h-5 w-5 shrink-0 text-rose-600 dark:text-rose-400" />
                        <div>
                            <p className="text-sm font-bold">Unable to load attendance data</p>
                            <p className="text-xs text-rose-600/80 dark:text-rose-400/80">{error}</p>
                        </div>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => refresh()} className="gap-1.5 rounded-xl border-rose-300 bg-white text-xs font-semibold text-rose-700 hover:bg-rose-100 dark:border-rose-800 dark:bg-slate-900 dark:text-rose-300">
                        <RefreshCw className="h-3.5 w-3.5" /> Retry
                    </Button>
                </div>
            )}
            {/* ── TOP SECTION: KPI CARD & CALENDAR GRID ── */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mb-6 lg:items-stretch items-start">
                
                {/* Left Side: KPI Card (top) & KPI Strip Card (bottom) */}
                <div className="lg:col-span-5 flex flex-col justify-between h-full space-y-3">
                    
                    {/* Unified KPI Card */}
                    <Card className={cn(lightTheme.card, lightTheme.border.card, "w-full overflow-hidden p-3.5 flex flex-col items-center bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 shadow-md rounded-[1.5rem]")}>
                        
                        {/* Top Portion: Global Status */}
                        <button
                            onClick={() => {
                                skipNextPageScrollRef.current = true;
                                setQueryParams({ status: null, page: null });
                                setSelectedIds(new Set());
                                scrollToRoster();
                            }}
                            className={cn(
                                "flex flex-col items-center w-full focus:outline-none transition-all py-0.5 rounded-lg group cursor-pointer",
                                (!activeFilter || activeFilter === 'all') ? "bg-slate-50 dark:bg-slate-800/40" : "hover:bg-slate-50/50 dark:hover:bg-slate-800/20"
                            )}
                        >
                            <span className="text-[10px] font-black tracking-[0.18em] text-slate-400 dark:text-slate-500 uppercase">
                                GLOBAL STATUS
                            </span>
                            <span className="text-3xl font-black text-[#0f172a] dark:text-white mt-1.5 mb-0.5 tracking-tight tabular-nums">
                                {statusEmployees.length}
                            </span>
                            <span className="text-xs font-bold text-slate-500 dark:text-slate-400 group-hover:text-primary transition-colors">
                                Total Personnel
                            </span>
                        </button>

                        {/* Divider Line */}
                        <div className="w-full border-t border-slate-100 dark:border-slate-800/80 my-2" />

                        {/* Stats Columns Grid */}
                        <div className="grid grid-cols-3 gap-0 w-full divide-x divide-slate-100 dark:divide-slate-800/80">
                            {(() => {
                                const counts = {
                                    Present: getCount('Present'),
                                    Late: getCount('Late'),
                                    Absent: getCount('Absent'),
                                };
                                const total = statusEmployees.length || 1;
                                
                                return ([
                                    { key: 'Present' as const, label: 'On Time',     count: counts.Present, color: 'bg-[#10b981]', barColor: 'bg-[#10b981]', bgLight: 'bg-[#10b981]/10', activeBg: 'bg-emerald-50 dark:bg-emerald-950/20' },
                                    { key: 'Late'    as const, label: 'Late',        count: counts.Late,    color: 'bg-[#f59e0b]', barColor: 'bg-[#f59e0b]', bgLight: 'bg-[#f59e0b]/10', activeBg: 'bg-amber-50 dark:bg-amber-950/20'   },
                                    { key: 'Absent'  as const, label: isToday ? 'Not In Yet' : 'Absent',  count: counts.Absent,  color: 'bg-[#ef4444]', barColor: 'bg-[#ef4444]', bgLight: 'bg-[#ef4444]/10', activeBg: 'bg-rose-50 dark:bg-rose-950/20'    },
                                ]).map(col => {
                                    const active = isStatusTileActive(col.key, activeFilter);
                                    const pct = Math.round((col.count / total) * 100);
                                    
                                    return (
                                        <button
                                            key={col.key}
                                            onClick={() => handleStatusTileClick(col.key)}
                                            className={cn(
                                                "flex flex-col items-center px-1 py-1.5 cursor-pointer transition-all duration-200 focus:outline-none",
                                                active ? col.activeBg : "hover:bg-slate-50/50 dark:hover:bg-slate-800/10"
                                            )}
                                        >
                                            {/* Indicator Dot & Label */}
                                            <div className="flex items-center gap-1">
                                                <span className={cn("h-2 w-2 rounded-full shrink-0", col.color)} />
                                                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400">
                                                    {col.label}
                                                </span>
                                            </div>

                                            {/* Value */}
                                            <span className="text-xl font-black text-[#0f172a] dark:text-white mt-1.5 tabular-nums">
                                                {error ? '—' : col.count}
                                            </span>

                                            {/* Progress bar */}
                                            <div className="w-[85%] h-1 rounded-full bg-slate-100 dark:bg-slate-800 mt-2 overflow-hidden relative">
                                                <div 
                                                    className={cn("h-full rounded-full transition-all duration-500", col.barColor)} 
                                                    style={{ width: `${pct}%` }} 
                                                />
                                            </div>
                                        </button>
                                    );
                                });
                            })()}
                        </div>
                    </Card>

                    {/* Vertical KPI Strip Card */}
                    <Card className={cn(lightTheme.card, lightTheme.border.card, "w-full overflow-hidden bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 shadow-md rounded-[2rem] p-4")}>
                        <div className="flex flex-col divide-y divide-slate-100 dark:divide-slate-800/80">
                            {[
                                { label: 'Attendance', value: error ? '—' : `${kpis.attendancePct}%` },
                                { label: 'Punctuality', value: error ? '—' : `${kpis.punctualityPct}%` },
                                { label: 'Avg hours', value: error ? '—' : kpis.avgHours },
                                { label: 'Currently in', value: error ? '—' : kpis.currentlyIn, live: !error && kpis.currentlyIn > 0 },
                            ].map((k, idx) => (
                                <div key={k.label} className={cn("flex items-center justify-between py-2.5", idx === 0 && "pt-0", idx === 3 && "pb-0")}>
                                    <span className="text-[11px] font-black tracking-widest text-slate-500 dark:text-slate-400 uppercase">
                                        {k.label}
                                    </span>
                                    <span className="text-lg font-bold text-slate-800 dark:text-white tabular-nums flex items-center gap-1.5">
                                        {k.label.toLowerCase().includes('currently') && (
                                            <span className="h-2 w-2 rounded-full bg-[#10b981] animate-pulse" />
                                        )}
                                        {k.value}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </Card>

                </div>

                {/* Right Side: Calendar */}
                <div className="lg:col-span-7 flex flex-col h-full">
                    <AttendanceCalendar 
                        onDayClick={(dateStr) => {
                            setSelectedDate(dateStr);
                        }}
                    />
                </div>

            </div>

            {/* ── TOOLBAR ─────────────────────────────────────────────────── */}
            <Card className={cn(lightTheme.card, lightTheme.border.card)}>
                <CardContent className="flex flex-col gap-3 p-3 lg:flex-row lg:items-center">
                    <div className="relative flex-1 min-w-[200px]">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            placeholder="Search by name or department…"
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            className="pl-9 pr-9"
                        />
                        {searchQuery && (
                            <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                                <X className="h-4 w-4" />
                            </button>
                        )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {/* Date Stepper & Picker Dialog */}
                        <div className="flex items-center gap-1 rounded-xl border border-border bg-card p-1 shadow-xs">
                            <button
                                type="button"
                                title="Previous Day"
                                onClick={() => {
                                    const [y, m, d] = selectedDate.split('-').map(Number);
                                    const prev = new Date(y, m - 1, d - 1);
                                    const py = prev.getFullYear();
                                    const pm = String(prev.getMonth() + 1).padStart(2, '0');
                                    const pd = String(prev.getDate()).padStart(2, '0');
                                    setSelectedDate(`${py}-${pm}-${pd}`);
                                    setPage(1);
                                }}
                                className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                            >
                                <ChevronLeft className="h-4 w-4" />
                            </button>

                            <button
                                type="button"
                                onClick={() => setFromOpen(true)}
                                className="flex items-center gap-2 rounded-lg px-2.5 py-1 text-xs font-semibold hover:bg-accent transition-colors"
                            >
                                <CalendarDays className="h-4 w-4 text-primary" />
                                <span>{fmtDate(selectedDate)}</span>
                            </button>

                            <button
                                type="button"
                                title="Next Day"
                                disabled={selectedDate >= siteToday}
                                onClick={() => {
                                    if (selectedDate >= siteToday) return;
                                    const [y, m, d] = selectedDate.split('-').map(Number);
                                    const next = new Date(y, m - 1, d + 1);
                                    const ny = next.getFullYear();
                                    const nm = String(next.getMonth() + 1).padStart(2, '0');
                                    const nd = String(next.getDate()).padStart(2, '0');
                                    const nextStr = `${ny}-${nm}-${nd}`;
                                    if (nextStr <= siteToday) {
                                        setSelectedDate(nextStr);
                                        setPage(1);
                                        if (nextStr === siteToday) refresh();
                                    }
                                }}
                                className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:pointer-events-none transition-colors"
                            >
                                <ChevronRight className="h-4 w-4" />
                            </button>

                            {!isToday && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setSelectedDate(siteToday);
                                        setPage(1);
                                        refresh();
                                    }}
                                    className="ml-1 rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary hover:bg-primary/20 transition-colors"
                                >
                                    Today
                                </button>
                            )}
                        </div>

                        {/* Centered Date Picker Dialog */}
                        <Dialog open={fromOpen} onOpenChange={setFromOpen}>
                            <DialogContent className="sm:max-w-md p-5 rounded-2xl shadow-2xl border border-border bg-card">
                                <DialogHeader className="flex flex-row items-center justify-between border-b border-border/60 pb-3">
                                    <DialogTitle className="text-sm font-bold flex items-center gap-2 text-foreground">
                                        <CalendarDays className="h-4 w-4 text-primary" /> Select Attendance Date
                                    </DialogTitle>
                                </DialogHeader>
                                <div className="flex justify-center py-2">
                                    <CalendarPicker
                                        mode="single"
                                        selected={(() => { const [y,m,d] = selectedDate.split('-').map(Number); return new Date(y, m-1, d); })()}
                                        disabled={d => {
                                            const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0');
                                            return `${y}-${m}-${day}` > siteToday;
                                        }}
                                        onSelect={d => {
                                            if (d) {
                                                const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0');
                                                const selStr=`${y}-${m}-${day}`;
                                                if (selStr <= siteToday) {
                                                    setSelectedDate(selStr);
                                                    setPage(1);
                                                    if (selStr === siteToday) refresh();
                                                }
                                            }
                                            setFromOpen(false);
                                        }}
                                        initialFocus
                                    />
                                </div>
                                <div className="flex items-center justify-between border-t border-border/60 pt-3 text-xs">
                                    <span className="text-muted-foreground font-medium">Selected: {fmtDate(selectedDate)}</span>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="rounded-lg text-xs"
                                        onClick={() => {
                                            setSelectedDate(siteToday);
                                            setPage(1);
                                            refresh();
                                            setFromOpen(false);
                                        }}
                                    >
                                        Jump to Today
                                    </Button>
                                </div>
                            </DialogContent>
                        </Dialog>
                        <Select value={activeFilter} onValueChange={(val) => {
                            skipNextPageScrollRef.current = true;
                            setQueryParams({ status: val === 'all' ? null : val, page: null });
                            setSelectedIds(new Set());
                        }}>
                            <SelectTrigger className="w-40 rounded-xl text-sm"><SelectValue placeholder="All Statuses" /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All Statuses</SelectItem>
                                <SelectItem value="Present">On Time</SelectItem>
                                <SelectItem value="Late">Late</SelectItem>
                                <SelectItem value="Absent">Not In Yet</SelectItem>
                            </SelectContent>
                        </Select>
                        <Select value={deptFilter} onValueChange={setDeptFilter}>
                            <SelectTrigger className="w-44 rounded-xl text-sm"><SelectValue placeholder="All departments" /></SelectTrigger>
                            <SelectContent>
                                {departments.map(d => <SelectItem key={d} value={d}>{d === 'all' ? 'All Departments' : d}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>
                </CardContent>
            </Card>

            {/* Active-filter chips */}
            {(activeFilter !== 'all' || deptFilter !== 'all' || !!searchQuery.trim()) && (
                <div className="flex flex-wrap items-center gap-2 py-1">
                    <span className="text-xs font-medium text-muted-foreground">Filters:</span>
                    {activeFilter !== 'all' && (
                        <button onClick={() => {
                            skipNextPageScrollRef.current = true;
                            setQueryParams({ status: null, page: null });
                            setSelectedIds(new Set());
                            scrollToRoster();
                        }} className="flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-semibold hover:bg-muted">
                            {STATUS_FILTER_LABELS[activeFilter] || activeFilter}<X className="h-3 w-3" />
                        </button>
                    )}
                    {deptFilter !== 'all' && (
                        <button onClick={() => setDeptFilter('all')} className="flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-semibold hover:bg-muted">
                            {deptFilter}<X className="h-3 w-3" />
                        </button>
                    )}
                    {!!searchQuery.trim() && (
                        <button onClick={() => setSearchQuery('')} className="flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-semibold hover:bg-muted">
                            “{searchQuery.trim()}”<X className="h-3 w-3" />
                        </button>
                    )}
                </div>
            )}

            {/* ── ROSTER ──────────────────────────────────────────────────── */}
            <div ref={tableRef} className="scroll-mt-24">
            <Card className={cn(lightTheme.card, lightTheme.border.card, 'gap-0')}>
                <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
                    <div className="flex items-center gap-2">
                        <Users className="h-4 w-4 text-muted-foreground" />
                        <h2 className="text-sm font-bold text-foreground">Roster</h2>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground tabular-nums">{total}</span>
                    </div>
                    <div className="flex items-center gap-2">
                        {histLoading && (
                            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading {fmtDate(selectedDate, true)}…
                            </span>
                        )}
                        {/* Density toggle */}
                        <div className="hidden rounded-lg border border-border bg-muted/50 p-0.5 sm:inline-flex">
                            {(['comfortable', 'compact'] as const).map(d => (
                                <button key={d} onClick={() => setDensity(d)}
                                    className={cn('rounded-md px-2 py-0.5 text-[11px] font-semibold capitalize transition-colors',
                                        density === d ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                                    {d}
                                </button>
                            ))}
                        </div>
                        {/* Column chooser */}
                        <Popover>
                            <PopoverTrigger asChild>
                                <Button variant="outline" size="sm" className="h-8 gap-1.5 rounded-lg text-xs">
                                    <ChevronsUpDown className="h-3.5 w-3.5" /> Columns
                                </Button>
                            </PopoverTrigger>
                            <PopoverContent align="end" className="w-44 p-1.5">
                                <p className="px-1.5 pb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Show columns</p>
                                {ROSTER_COLS.map(c => (
                                    <button key={c.key} onClick={() => toggleCol(c.key)}
                                        className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                                        <span className={showCol(c.key) ? 'text-foreground' : 'text-muted-foreground'}>{c.label}</span>
                                        {showCol(c.key) ? <Check className="h-4 w-4 text-primary" /> : <span className="h-4 w-4" />}
                                    </button>
                                ))}
                            </PopoverContent>
                        </Popover>
                    </div>
                </div>

                {/* Bulk action bar */}
                {selectedIds.size > 0 && (
                    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-primary/5 px-4 py-3">
                        <span className="text-sm font-semibold text-foreground">{selectedIds.size} selected</span>
                        <div className="ml-auto flex items-center gap-2">
                            <Button size="sm" variant="outline" disabled={bulkSavingAction !== null} onClick={() => bulkRegularize('present')} className="gap-1.5 rounded-lg">
                                {bulkSavingAction === 'present' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserCheck className="h-3.5 w-3.5 text-emerald-600" />}
                                Mark present
                            </Button>
                            <Button size="sm" variant="outline" disabled={bulkSavingAction !== null} onClick={() => bulkRegularize('late')} className="gap-1.5 rounded-lg">
                                {bulkSavingAction === 'late' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5 text-amber-500" />}
                                Mark late
                            </Button>
                            <Button size="sm" variant="outline" disabled={bulkSavingAction !== null} onClick={() => bulkRegularize('absent')} className="gap-1.5 rounded-lg">
                                {bulkSavingAction === 'absent' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserX className="h-3.5 w-3.5 text-rose-600" />}
                                Mark absent
                            </Button>
                            <Button size="sm" variant="ghost" onClick={clearSelection} className="gap-1 rounded-lg text-xs text-muted-foreground">
                                <X className="h-3.5 w-3.5" /> Clear
                            </Button>
                        </div>
                    </div>
                )}
                <CardContent className="p-0">
                    {isLoading && statusEmployees.length === 0 ? (
                        <div className="divide-y divide-border/50">
                            {Array.from({ length: 8 }).map((_, i) => (
                                <div key={i} className="flex items-center gap-3 px-4 py-3">
                                    <div className="h-9 w-9 shrink-0 animate-pulse rounded-xl bg-muted" />
                                    <div className="h-3 w-36 animate-pulse rounded bg-muted" />
                                    <div className="ml-6 hidden h-3 w-24 animate-pulse rounded bg-muted sm:block" />
                                    <div className="ml-auto h-5 w-16 animate-pulse rounded-full bg-muted" />
                                    <div className="h-9 w-12 animate-pulse rounded-lg bg-muted" />
                                </div>
                            ))}
                        </div>
                    ) : error ? (
                        <div className="flex items-center justify-center gap-3 py-20">
                            <AlertCircle className="h-6 w-6 text-rose-400" />
                            <span className="text-sm text-muted-foreground">{error}</span>
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
                            <Users className="h-9 w-9 text-muted-foreground/40" />
                            <p className="text-sm font-medium text-foreground">No employees match this filter</p>
                            <p className="text-xs text-muted-foreground">Try clearing the filters above.</p>
                            {(activeFilter !== 'all' || deptFilter !== 'all' || !!searchQuery.trim()) && (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => {
                                        setActiveFilter('all');
                                        setDeptFilter('all');
                                        setSearchQuery('');
                                    }}
                                    className="mt-2 gap-1.5 rounded-lg text-xs"
                                >
                                    <X className="h-3.5 w-3.5" /> Clear all filters
                                </Button>
                            )}
                        </div>
                    ) : (
                        <div className="scroll-mt-24">
                            {/* Desktop table */}
                            <div className="hidden overflow-x-auto md:block">
                                <table className={cn('w-full text-sm', density === 'compact' && '[&_td]:py-1.5 [&_th]:py-2')}>
                                    <thead>
                                        <tr className="sticky top-0 z-10 border-b border-border bg-muted text-muted-foreground">
                                            <th className="sticky left-0 z-30 w-10 bg-muted px-4 py-3">
                                                <Checkbox
                                                    aria-label="Select all"
                                                    checked={sorted.length > 0 && sorted.every(e => selectedIds.has(e.id)) ? true : selectedIds.size > 0 ? 'indeterminate' : false}
                                                    onCheckedChange={(c) => setSelectedIds(c ? new Set(sorted.map(e => e.id)) : new Set())}
                                                />
                                            </th>
                                            <th className="sticky left-10 z-20 w-[260px] min-w-[200px] bg-muted px-4 py-3 text-left whitespace-nowrap text-[11px] font-bold uppercase tracking-wide shadow-[6px_0_8px_-6px_rgba(0,0,0,0.1)]">
                                                <button onClick={() => toggleSort('name')} className="inline-flex items-center gap-1 transition-colors hover:text-foreground">Employee {sortArrow('name')}</button>
                                            </th>
                                            {showCol('department') && <th className="px-4 py-3 text-left whitespace-nowrap text-[11px] font-bold uppercase tracking-wide">Department</th>}
                                            {showCol('location') && <th className="px-4 py-3 text-left whitespace-nowrap text-[11px] font-bold uppercase tracking-wide">Location</th>}
                                            {showCol('shift') && <th className="px-4 py-3 text-left whitespace-nowrap text-[11px] font-bold uppercase tracking-wide">Shift</th>}
                                            {showCol('status') && <th className="px-4 py-3 text-left whitespace-nowrap text-[11px] font-bold uppercase tracking-wide"><button onClick={() => toggleSort('status')} className="inline-flex items-center gap-1 hover:text-foreground">Status {sortArrow('status')}</button></th>}
                                            {showCol('checkin') && <th className="px-4 py-3 text-left whitespace-nowrap text-[11px] font-bold uppercase tracking-wide"><button onClick={() => toggleSort('checkin')} className="inline-flex items-center gap-1 hover:text-foreground">Check-in {sortArrow('checkin')}</button></th>}
                                            {showCol('checkout') && <th className="px-4 py-3 text-left whitespace-nowrap text-[11px] font-bold uppercase tracking-wide">Check-out</th>}
                                            {showCol('duration') && <th className="px-4 py-3 text-left whitespace-nowrap text-[11px] font-bold uppercase tracking-wide"><button onClick={() => toggleSort('duration')} className="inline-flex items-center gap-1 hover:text-foreground">Duration {sortArrow('duration')}</button></th>}
                                            {showCol('break') && <th className="px-4 py-3 text-left whitespace-nowrap text-[11px] font-bold uppercase tracking-wide">Break</th>}
                                            {showCol('proof') && <th className="px-4 py-3 text-center whitespace-nowrap text-[11px] font-bold uppercase tracking-wide"><span className="inline-flex items-center gap-1"><Camera className="h-3.5 w-3.5" /> Proof</span></th>}
                                            <th className="px-4 py-3 text-right whitespace-nowrap text-[11px] font-bold uppercase tracking-wide">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {pagedFiltered.map((emp) => {
                                          const expanded = expandedId === emp.id;
                                          const selBg = selectedIds.has(emp.id) && 'bg-primary/5';
                                          return (
                                          <React.Fragment key={emp.id}>
                                            <tr className={cn('group border-b border-border/50 transition-colors hover:bg-accent/40', selBg)}>
                                                <td className={cn('sticky left-0 z-10 w-10 bg-card px-4 py-3 group-hover:bg-accent/40', selBg)}>
                                                    <Checkbox aria-label={`Select ${emp.name}`} checked={selectedIds.has(emp.id)} onCheckedChange={() => toggleSelect(emp.id)} />
                                                </td>
                                                {/* Employee */}
                                                <td className={cn('sticky left-10 z-10 w-[260px] max-w-[260px] bg-card px-4 py-3 shadow-[6px_0_8px_-6px_rgba(0,0,0,0.1)] group-hover:bg-accent/40', selBg)}>
                                                    <div className="flex min-w-0 items-center gap-2.5">
                                                        <button onClick={() => setExpandedId(expanded ? null : emp.id)} title={expanded ? 'Collapse' : 'Expand details'}
                                                            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                                                            <ChevronRight className={cn('h-4 w-4 transition-transform', expanded && 'rotate-90')} />
                                                        </button>
                                                        <div className="relative shrink-0">
                                                            <div className="flex h-9 w-9 items-center justify-center rounded-xl text-[11px] font-black shadow-sm"
                                                                style={{ backgroundColor: deptColor(emp.department) + '1A', color: deptColor(emp.department) }}>
                                                                {initials(emp.name)}
                                                            </div>
                                                            <span title={emp.status} className={cn('absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card', STATUS_DOT[emp.status])} />
                                                        </div>
                                                        <button onClick={() => setTimesheetTarget({ id: emp.employeeId || emp.id, name: emp.name })} title={`${emp.name} — open timesheet`}
                                                            className="truncate text-left font-semibold text-foreground hover:text-primary hover:underline">
                                                            {emp.name}
                                                        </button>
                                                        {emp.faceEnrolled === false && <span title="Face not enrolled" className="shrink-0 leading-none"><ScanLine className="h-3.5 w-3.5 text-muted-foreground" /></span>}
                                                        {!!emp.flags?.length && <span title={emp.flags.join(' · ')} className="shrink-0 leading-none"><AlertTriangle className="h-3.5 w-3.5 text-rose-500" /></span>}
                                                        {anomalyMap.has(emp.employeeId || emp.id) && <span title={anomalyMap.get(emp.employeeId || emp.id)!.map(a => a.detail).join(' · ')} className="h-2 w-2 shrink-0 rounded-full bg-amber-400" />}
                                                    </div>
                                                </td>
                                                {/* Department */}
                                                {showCol('department') && (
                                                    <td className="px-4 py-3 text-xs">
                                                        <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-semibold"
                                                            style={{ backgroundColor: deptColor(emp.department) + '14', color: deptColor(emp.department) }}>
                                                            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: deptColor(emp.department) }} />
                                                            {emp.department}
                                                        </span>
                                                    </td>
                                                )}
                                                {/* Location */}
                                                {showCol('location') && (
                                                    <td className="px-4 py-3 text-xs">
                                                        {emp.location && emp.location !== '—'
                                                            ? <span className="inline-flex items-center gap-1 text-muted-foreground"><MapPin className="h-3 w-3 shrink-0 opacity-70" />{emp.location}</span>
                                                            : <span className="text-muted-foreground/50">—</span>}
                                                    </td>
                                                )}
                                                {/* Shift */}
                                                {showCol('shift') && (
                                                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{emp.shift && emp.shift !== '—' ? emp.shift : <span className="text-muted-foreground/50">—</span>}</td>
                                                )}
                                                {/* Status */}
                                                {showCol('status') && (
                                                    <td className="px-4 py-3">
                                                        <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold', statusBadge(emp.status))}>
                                                            <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[emp.status])} />{STATUS_FILTER_LABELS[emp.status] || emp.status}
                                                        </span>
                                                    </td>
                                                )}
                                                {/* Check-in */}
                                                {showCol('checkin') && (
                                                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                                                        <div className="flex flex-col gap-0.5">
                                                            <div className="flex items-center gap-1.5">
                                                                <span className={cn(emp.isModifiedIn && "text-orange-500 font-bold")}>{emp.checkInTime ?? '—'}</span>
                                                                {(emp.inCount ?? 0) > 1 && <PunchPopover count={emp.inCount!} times={emp.punchInTimes ?? []} tone="in" />}
                                                            </div>
                                                            {emp.isModifiedIn && emp.rawFirstInTime && (
                                                                <span className="text-[10px] text-muted-foreground/70" title="Original Hardware Time">Raw: {emp.rawFirstInTime}</span>
                                                            )}
                                                        </div>
                                                    </td>
                                                )}
                                                {/* Check-out */}
                                                {showCol('checkout') && (
                                                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                                                        <div className="flex flex-col gap-0.5">
                                                            <div className="flex items-center gap-1.5">
                                                                {(emp as any).check_out_time ? <span className={cn(emp.isModifiedOut && "text-orange-500 font-bold")}>{(emp as any).check_out_time}</span>
                                                                    : emp.checkInTime && (emp.status === 'Present' || emp.status === 'Late') ? (
                                                                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 font-sans text-[10px] font-bold not-italic text-emerald-600">
                                                                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />Active
                                                                        </span>
                                                                    ) : <span>—</span>}
                                                                {(emp.outCount ?? 0) > 1 && <PunchPopover count={emp.outCount!} times={emp.punchOutTimes ?? []} tone="out" />}
                                                            </div>
                                                            {emp.isModifiedOut && emp.rawLastOutTime && (
                                                                <span className="text-[10px] text-muted-foreground/70" title="Original Hardware Time">Raw: {emp.rawLastOutTime}</span>
                                                            )}
                                                        </div>
                                                    </td>
                                                )}
                                                {/* Duration */}
                                                {showCol('duration') && (
                                                    <td className="px-4 py-3 font-mono text-xs">
                                                        {emp.duration ? <span className="font-semibold text-foreground">{emp.duration}</span> : <span className="text-muted-foreground/50">—</span>}
                                                    </td>
                                                )}
                                                {/* Break */}
                                                {showCol('break') && (
                                                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                                                        {(emp.isModifiedIn || emp.isModifiedOut) ? <span className="text-orange-500 font-bold uppercase tracking-wide text-[10px]">Modified</span> : emp.breakDuration ? <span className="text-foreground">{emp.breakDuration}</span> : <span className="text-muted-foreground/50">—</span>}
                                                    </td>
                                                )}
                                                {/* Proof */}
                                                {showCol('proof') && (
                                                    <td className="px-4 py-3">
                                                        <div className="flex items-center justify-center gap-2.5 min-w-max">
                                                            <PhotoThumb photo={(emp as any).checkin_photo} tone="in" label="In" />
                                                            <PhotoThumb photo={(emp as any).checkout_photo} tone="out" label="Out" />
                                                        </div>
                                                    </td>
                                                )}
                                                {/* Actions */}
                                                <td className="px-4 py-3">
                                                    <div className="flex items-center justify-end gap-1.5">
                                                        <button title="View 30-day history" onClick={() => setHistoryEmployee({ id: emp.employeeId || emp.id, name: emp.name })}
                                                            className="rounded-lg p-1.5 text-blue-500 transition-colors hover:bg-blue-500/10">
                                                            <History className="h-4 w-4" />
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                            {expanded && (
                                                <tr className="border-b border-border/50 bg-muted/30">
                                                    <td colSpan={visibleColCount} className="p-0">
                                                      <div className="sticky left-0 w-[88vw] max-w-[1400px] space-y-4 px-6 py-4">
                                                        <div className="flex flex-wrap items-start gap-x-8 gap-y-3 text-xs">
                                                            <div>
                                                                <p className="font-bold uppercase tracking-wide text-muted-foreground/70">Shift</p>
                                                                <p className="mt-0.5 text-foreground">{emp.shift && emp.shift !== '—' ? emp.shift : '—'}</p>
                                                            </div>
                                                            <div>
                                                                <p className="font-bold uppercase tracking-wide text-muted-foreground/70">Location</p>
                                                                <p className="mt-0.5 text-foreground">{emp.location ?? '—'}</p>
                                                            </div>
                                                            <div>
                                                                <p className="font-bold uppercase tracking-wide text-muted-foreground/70">Check-ins ({emp.inCount ?? 0})</p>
                                                                <p className="mt-0.5 font-mono text-foreground">{emp.punchInTimes?.length ? emp.punchInTimes.join(', ') : (emp.checkInTime ?? '—')}</p>
                                                            </div>
                                                            <div>
                                                                <p className="font-bold uppercase tracking-wide text-muted-foreground/70">Check-outs ({emp.outCount ?? 0})</p>
                                                                <p className="mt-0.5 font-mono text-foreground">{emp.punchOutTimes?.length ? emp.punchOutTimes.join(', ') : ((emp as any).check_out_time ?? '—')}</p>
                                                            </div>
                                                            <div>
                                                                <p className="font-bold uppercase tracking-wide text-muted-foreground/70">Break Time</p>
                                                                {(() => {
                                                                    const segs = calcBreakSegments(
                                                                        (emp as any).allCheckInsRaw ?? [],
                                                                        (emp as any).allCheckOutsRaw ?? [],
                                                                    );
                                                                    return (
                                                                        <div className="mt-0.5">
                                                                            <p className="font-mono font-semibold text-foreground">
                                                                                {emp.breakDuration ?? '—'}
                                                                            </p>
                                                                            {segs.length > 0 && (
                                                                                <ul className="mt-1.5 space-y-1">
                                                                                    {segs.map((s, i) => (
                                                                                        <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
                                                                                            <span className={cn('h-2 w-2 rounded-full shrink-0',
                                                                                                s.inferred ? 'bg-amber-400' : 'bg-emerald-400')} />
                                                                                            <span className="font-mono text-muted-foreground">
                                                                                                {formatTimeInSiteTz(s.from.toISOString())}
                                                                                                {' → '}
                                                                                                {formatTimeInSiteTz(s.to.toISOString())}
                                                                                            </span>
                                                                                            <span className="font-bold text-foreground">{formatMins(s.mins)}</span>
                                                                                            {s.inferred
                                                                                                ? <span className="rounded-full bg-amber-50 px-1.5 py-0.5 font-bold text-amber-600 dark:bg-amber-950/30">~est · camera gap</span>
                                                                                                : <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 font-bold text-emerald-600 dark:bg-emerald-950/30">confirmed</span>}
                                                                                        </li>
                                                                                    ))}
                                                                                </ul>
                                                                            )}
                                                                        </div>
                                                                    );
                                                                })()}
                                                            </div>
                                                            {!!emp.flags?.length && (
                                                                <div className="text-rose-600">
                                                                    <p className="font-bold uppercase tracking-wide">Issues</p>
                                                                    <p className="mt-0.5">{emp.flags.join(' · ')}</p>
                                                                </div>
                                                            )}
                                                            {anomalyMap.has(emp.employeeId || emp.id) && (
                                                                <div className="text-amber-600">
                                                                    <p className="font-bold uppercase tracking-wide">Anomalies</p>
                                                                    <p className="mt-0.5">{anomalyMap.get(emp.employeeId || emp.id)!.map(a => a.detail).join(' · ')}</p>
                                                                </div>
                                                            )}
                                                            <div className="ml-auto flex items-end gap-2">
                                                                <PhotoThumb photo={(emp as any).checkin_photo} tone="in" label="In" />
                                                                <PhotoThumb photo={(emp as any).checkout_photo} tone="out" label="Out" />
                                                            </div>
                                                        </div>
                                                        {/* Per-device dwell: devices visited + duration of each (lazy-loaded) */}
                                                        <div className="rounded-xl border border-border/60 bg-background/40 p-3">
                                                            <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-muted-foreground/70">Time by location</p>
                                                            <DwellTimeline
                                                                employeeId={emp.employeeId || emp.id}
                                                                date={emp.attendance_date || selectedDate}
                                                                accessToken={accessToken}
                                                                scopeHeaders={scopeHeaders}
                                                            />
                                                        </div>
                                                        {/* Device activity heatmap, pinned to this day */}
                                                        <DeviceActivityHeatmap fixedFrom={emp.attendance_date || selectedDate} fixedTo={emp.attendance_date || selectedDate} title="Device activity · this day" />
                                                        {/* Per-employee camera presence heatmap */}
                                                        <CameraPresenceHeatmap
                                                            employeeId={Number(emp.employeeId || emp.id)}
                                                            employeeName={emp.name}
                                                            date={emp.attendance_date || selectedDate}
                                                        />
                                                      </div>
                                                    </td>
                                                </tr>
                                            )}
                                          </React.Fragment>
                                          );
                                        })}
                                    </tbody>
                                </table>
                            </div>

                            {/* Mobile cards */}
                            <div className="divide-y divide-border/50 md:hidden">
                                {pagedFiltered.map((emp) => (
                                    <div key={emp.id} className={cn('flex gap-3 p-3', selectedIds.has(emp.id) && 'bg-primary/5')}>
                                        <div className="pt-1">
                                            <Checkbox aria-label={`Select ${emp.name}`} checked={selectedIds.has(emp.id)} onCheckedChange={() => toggleSelect(emp.id)} />
                                        </div>
                                        <div className="relative shrink-0">
                                            <div className="flex h-10 w-10 items-center justify-center rounded-xl text-xs font-black shadow-sm"
                                                style={{ backgroundColor: deptColor(emp.department) + '1A', color: deptColor(emp.department) }}>
                                                {initials(emp.name)}
                                            </div>
                                            <span title={emp.status} className={cn('absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card', STATUS_DOT[emp.status])} />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-1.5">
                                                <button onClick={() => setTimesheetTarget({ id: emp.employeeId || emp.id, name: emp.name })} title={`${emp.name} — open timesheet`} className="truncate text-left font-semibold text-foreground hover:text-primary hover:underline">{emp.name}</button>
                                                {emp.faceEnrolled === false && <span title="Face not enrolled"><ScanLine className="h-3.5 w-3.5 text-muted-foreground" /></span>}
                                                {!!emp.flags?.length && <span title={emp.flags.join(' · ')}><AlertTriangle className="h-3.5 w-3.5 text-rose-500" /></span>}
                                                <span className={cn('ml-auto inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold', statusBadge(emp.status))}>
                                                    <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[emp.status])} />{STATUS_FILTER_LABELS[emp.status] || emp.status}
                                                </span>
                                            </div>
                                            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                                                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: deptColor(emp.department) }} />
                                                <span className="truncate">{emp.department}</span>
                                                {emp.location && emp.location !== '—' && <><span>·</span><MapPin className="h-3 w-3 shrink-0 opacity-70" /><span className="truncate">{emp.location}</span></>}
                                            </p>
                                            <div className="mt-2 flex flex-col gap-1 font-mono text-xs text-muted-foreground">
                                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                                                    <span className="flex items-center gap-1">
                                                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                                        <span className={cn(emp.isModifiedIn && "text-orange-500 font-bold")}>{emp.checkInTime ?? '—'}</span>
                                                        {(emp.inCount ?? 0) > 1 && <PunchPopover count={emp.inCount!} times={emp.punchInTimes ?? []} tone="in" />}
                                                    </span>
                                                    <span className="flex items-center gap-1">
                                                        <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                                                        <span className={cn(emp.isModifiedOut && "text-orange-500 font-bold")}>
                                                            {(emp as any).check_out_time ?? (emp.checkInTime && (emp.status === 'Present' || emp.status === 'Late') ? 'Active' : '—')}
                                                        </span>
                                                        {(emp.outCount ?? 0) > 1 && <PunchPopover count={emp.outCount!} times={emp.punchOutTimes ?? []} tone="out" />}
                                                    </span>
                                                    {emp.duration && <span className="font-semibold text-foreground">{emp.duration}</span>}
                                                </div>
                                                {(emp.isModifiedIn || emp.isModifiedOut) && (
                                                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px]">
                                                        {emp.isModifiedIn && emp.rawFirstInTime && <span className="text-muted-foreground/70" title="Original Hardware Time">Raw In: {emp.rawFirstInTime}</span>}
                                                        {emp.isModifiedOut && emp.rawLastOutTime && <span className="text-muted-foreground/70" title="Original Hardware Time">Raw Out: {emp.rawLastOutTime}</span>}
                                                    </div>
                                                )}
                                            </div>
                                            {((emp as any).checkin_photo || (emp as any).checkout_photo) && (
                                                <div className="mt-2 flex items-center gap-2">
                                                    <PhotoThumb photo={(emp as any).checkin_photo} tone="in" />
                                                    <PhotoThumb photo={(emp as any).checkout_photo} tone="out" />
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <button title="History" onClick={() => setHistoryEmployee({ id: emp.employeeId || emp.id, name: emp.name })} className="rounded p-1.5 text-blue-500 hover:bg-blue-500/10"><History className="h-4 w-4" /></button>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* Pagination */}
                            {total > 0 && (
                                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/40 px-4 py-3">
                                    <div className="flex items-center gap-3">
                                        <p className="text-xs text-muted-foreground">
                                            Showing {total > 0 ? (effectivePage - 1) * PER + 1 : 0}–{Math.min(effectivePage * PER, total)} of {total}
                                        </p>
                                        <div className="flex items-center gap-1.5">
                                            <span className="text-xs text-muted-foreground">Rows</span>
                                            <Select value={String(PER)} onValueChange={(v) => { setPER(Number(v)); setPage(1); }}>
                                                <SelectTrigger className="h-7 w-[64px] rounded-lg text-xs"><SelectValue /></SelectTrigger>
                                                <SelectContent>
                                                    {[10, 25, 50, 100].map(n => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>
                                    {pages > 1 && (
                                        <div className="flex items-center gap-1">
                                            <Button variant="outline" size="sm" onClick={() => handlePageChange(Math.max(1, effectivePage - 1))} disabled={effectivePage === 1} className="h-8 w-8 rounded-lg p-0">
                                                <ChevronLeft className="h-4 w-4" />
                                            </Button>
                                            {pageWindow(effectivePage, pages).map((p, idx) => p === '…' ? (
                                                <span key={"gap-" + idx} className="px-1.5 text-xs text-muted-foreground">…</span>
                                            ) : (
                                                <Button key={p} variant={effectivePage === p ? 'default' : 'outline'} size="sm" onClick={() => handlePageChange(Number(p))} className="h-8 min-w-8 rounded-lg px-2 text-xs font-bold">
                                                    {p}
                                                </Button>
                                            ))}
                                            <Button variant="outline" size="sm" onClick={() => handlePageChange(Math.min(pages, effectivePage + 1))} disabled={effectivePage >= pages} className="h-8 w-8 rounded-lg p-0">
                                                <ChevronRight className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>
            </div>
            </div>)}

            {/* ATTENDANCE CORRECTION DIALOG */}
            <Dialog open={!!correctionTarget} onOpenChange={open => { if (!open) setCorrectionTarget(null); }}>
                <DialogContent className="max-w-md rounded-2xl">
                    <DialogHeader>
                        <DialogTitle className="font-bold">Override Attendance</DialogTitle>
                        <DialogDescription>{correctionTarget?.name} · {selectedDate}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 mt-2">
                        <div>
                            <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Status</Label>
                            <Select value={correctionForm.status} onValueChange={v => setCorrectionForm(f => ({ ...f, status: v }))}>
                                <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="present">Present</SelectItem>
                                    <SelectItem value="late">Late</SelectItem>
                                    <SelectItem value="absent">Absent</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Check-in Time</Label>
                                <Input type="time" value={correctionForm.check_in} onChange={e => setCorrectionForm(f => ({ ...f, check_in: e.target.value }))} className="rounded-xl" />
                            </div>
                            <div>
                                <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Check-out Time</Label>
                                <Input type="time" value={correctionForm.check_out} onChange={e => setCorrectionForm(f => ({ ...f, check_out: e.target.value }))} className="rounded-xl" />
                            </div>
                        </div>
                        <div>
                            <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Note / Reason</Label>
                            <Input value={correctionForm.note} onChange={e => setCorrectionForm(f => ({ ...f, note: e.target.value }))} placeholder="e.g. Manual correction by HR…" className="rounded-xl" />
                        </div>
                        <div className="flex gap-3">
                            <Button variant="outline" className="flex-1 rounded-xl" onClick={() => setCorrectionTarget(null)}>Cancel</Button>
                            <Button onClick={handleCorrection} disabled={isCorrecting} className="flex-1 bg-amber-500 hover:bg-amber-600 text-white rounded-xl gap-1.5">
                                {isCorrecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <FilePen className="w-4 h-4" />}
                                Save Override
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* APPROVALS / REGULARIZATION INBOX */}
            <Dialog open={showApprovals} onOpenChange={setShowApprovals}>
                <DialogContent className="max-w-2xl rounded-2xl">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 font-bold">
                            <ClipboardCheck className="h-5 w-5 text-primary" /> Audit Trail
                        </DialogTitle>
                        <DialogDescription>Review past attendance overrides and changes.</DialogDescription>
                    </DialogHeader>

                    <div className="mt-1 max-h-[58vh] space-y-2 overflow-y-auto pr-1">
                        {regRequests.filter(r => r.status !== 'pending').map(req => {
                            const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
                            return (
                                <div key={req.id} className="rounded-xl border border-border p-3">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="font-semibold text-foreground">{req.employeeName}</span>
                                                {req.department && <span className="text-xs text-muted-foreground">· {req.department}</span>}
                                            </div>
                                            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                                                <span>{fmtDate(req.date)}</span><span>·</span>
                                                <span className="font-medium text-foreground/70">{req.fromStatus}</span>
                                                <ArrowRight className="h-3 w-3" />
                                                <span className={cn('rounded-full px-1.5 py-0.5 font-semibold', statusBadge(cap(req.toStatus) as AttendanceStatus))}>{cap(req.toStatus)}</span>
                                                {(req.checkIn || req.checkOut) && (
                                                    <span className="ml-2 flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-amber-600">
                                                        <Clock className="h-3 w-3" />
                                                        {req.checkIn || '—'}
                                                        {' → '}
                                                        {req.checkOut || '—'}
                                                    </span>
                                                )}
                                            </div>
                                            <p className="mt-1.5 text-xs text-muted-foreground"><span className="font-medium text-foreground/70">Reason:</span> {req.reason}</p>
                                            <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                                                by {req.requestedBy}
                                                {req.status !== 'pending' && req.decidedAt && ` · ${req.status} ${new Date(req.decidedAt).toLocaleDateString()}`}
                                            </p>
                                        </div>
                                        <span className={cn('shrink-0 rounded-full px-2.5 py-1 text-xs font-bold',
                                            req.status === 'approved' ? 'bg-emerald-500/10 text-emerald-600' : 'bg-rose-500/10 text-rose-600')}>
                                            {cap(req.status)}
                                        </span>
                                    </div>
                                </div>
                            );
                        })}
                        {regRequests.filter(r => r.status !== 'pending').length === 0 && (
                            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                                <Inbox className="h-9 w-9 text-muted-foreground/40" />
                                <p className="text-sm font-medium text-foreground">No decisions yet</p>
                                <p className="text-xs text-muted-foreground">
                                    Approved and rejected requests will appear here.
                                </p>
                            </div>
                        )}
                    </div>
                </DialogContent>
            </Dialog>

            {/* ALERTS PANEL */}
            <Dialog open={showAlerts} onOpenChange={setShowAlerts}>
                <DialogContent className="max-w-lg rounded-2xl">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 font-bold">
                            <Bell className="h-5 w-5 text-amber-500" /> Alerts
                        </DialogTitle>
                        <DialogDescription>Attention items for {isToday ? 'today' : fmtDate(selectedDate)}.</DialogDescription>
                    </DialogHeader>
                    <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
                        {[
                            { key: 'anomalies', title: 'Behavioural anomalies', icon: AlertCircle, tone: 'text-amber-600',
                              items: alerts.anomalies.map(a => ({ id: a.employeeId, name: a.employeeName, detail: a.detail })) },
                            { key: 'issues', title: 'Data issues', icon: AlertTriangle, tone: 'text-rose-600',
                              items: alerts.dataIssues.map(e => ({ id: e.id, name: e.name, detail: e.flags!.join(' · ') })) },
                            { key: 'nocheckout', title: 'Not checked out', icon: LogIn, tone: 'text-blue-600',
                              items: alerts.noCheckout.map(e => ({ id: e.id, name: e.name, detail: `In since ${e.checkInTime}` })) },
                            { key: 'late', title: 'Late today', icon: Clock, tone: 'text-amber-600',
                              items: alerts.lateToday.map(e => ({ id: e.id, name: e.name, detail: e.checkInTime ?? '' })) },
                        ].filter(s => s.items.length > 0).map(section => (
                            <div key={section.key}>
                                <div className="mb-1.5 flex items-center gap-2">
                                    <section.icon className={cn('h-4 w-4', section.tone)} />
                                    <span className="text-sm font-bold text-foreground">{section.title}</span>
                                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">{section.items.length}</span>
                                </div>
                                <div className="space-y-1">
                                    {section.items.map(it => (
                                        <button key={it.id + section.key}
                                            onClick={() => { setHistoryEmployee({ id: it.id, name: it.name }); setShowAlerts(false); }}
                                            className="flex w-full items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-2 text-left hover:bg-accent/50">
                                            <span className="truncate text-sm font-medium text-foreground">{it.name}</span>
                                            <span className="shrink-0 text-xs text-muted-foreground">{it.detail}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ))}
                        {actionableAlerts === 0 && alerts.noCheckout.length === 0 && alerts.lateToday.length === 0 && (
                            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                                <Check className="h-9 w-9 text-emerald-500" />
                                <p className="text-sm font-medium text-foreground">All clear</p>
                                <p className="text-xs text-muted-foreground">No anomalies, data issues, or pending check-outs.</p>
                            </div>
                        )}
                    </div>
                </DialogContent>
            </Dialog>

            {/* Employee History Drawer */}
            <EmployeeHistoryDrawer
                open={!!historyEmployee}
                onClose={() => setHistoryEmployee(null)}
                employeeId={historyEmployee?.id ?? null}
                employeeName={historyEmployee?.name ?? null}
                attendance={attendance}
                initialDate={historyEmployee && isDeepLinkedHistoryRef.current ? selectedDate : null}
            />

            {/* Employee Monthly Timesheet Drawer (opened from the Monthly grid) */}
            <EmployeeTimesheetDrawer
                open={!!timesheetTarget}
                onClose={() => setTimesheetTarget(null)}
                employeeId={timesheetTarget?.id ?? null}
                employeeName={timesheetTarget?.name ?? null}
                siteToday={siteToday}
                initialMonth={monthParam}
                accessToken={accessToken}
                scopeHeaders={scopeHeaders}
            />

            {/* Weekly Attendance Pattern */}
            {/* {view !== 'analytics' && (
            <Card className={cn(lightTheme.card, lightTheme.border.card)}>
                <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
                    <div>
                        <CardTitle className="text-base font-bold text-foreground">Weekly Attendance Pattern</CardTitle>
                        <p className="mt-0.5 text-xs text-muted-foreground">Present · Late · Absent share by weekday</p>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                        {([['Present', '#10b981'], ['Late', '#f59e0b'], ['Absent', '#ef4444']] as const).map(([l, c]) => (
                            <span key={l} className="flex items-center gap-1.5 text-muted-foreground">
                                <span className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />{l}
                            </span>
                        ))}
                    </div>
                </CardHeader>
                <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
                        <BarChart data={weeklyData} barCategoryGap="30%" margin={{ top: 10, right: 8, left: -12, bottom: 0 }}>
                            <defs>
                                {([['gPresent', '#10b981'], ['gLate', '#f59e0b'], ['gAbsent', '#ef4444']] as const).map(([id, c]) => (
                                    <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="0%" stopColor={c} stopOpacity={0.95} />
                                        <stop offset="100%" stopColor={c} stopOpacity={0.65} />
                                    </linearGradient>
                                ))}
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                            <XAxis dataKey="day" tickLine={false} axisLine={false} dy={4} className="text-xs" />
                            <YAxis domain={[0, 100]} tickLine={false} axisLine={false} width={40} tickFormatter={(v) => `${v}%`} className="text-xs" />
                            <Tooltip
                                cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
                                content={({ active, payload, label }: any) => active && payload?.length ? (
                                    <div className="rounded-xl border border-border bg-card p-2.5 shadow-md">
                                        <p className="mb-1.5 text-xs font-bold text-foreground">{label}</p>
                                        {payload.map((p: any) => {
                                            const c = p.name === 'Present' ? '#10b981' : p.name === 'Late' ? '#f59e0b' : '#ef4444';
                                            return (
                                                <p key={p.name} className="flex items-center gap-2 text-xs">
                                                    <span className="h-2 w-2 rounded-full" style={{ background: c }} />
                                                    <span className="text-muted-foreground">{p.name}</span>
                                                    <span className="ml-auto pl-3 font-semibold tabular-nums text-foreground">{p.value}%</span>
                                                </p>
                                            );
                                        })}
                                    </div>
                                ) : null}
                            />
                            <Bar dataKey="present" stackId="a" fill="url(#gPresent)" name="Present" maxBarSize={46} />
                            <Bar dataKey="late" stackId="a" fill="url(#gLate)" name="Late" maxBarSize={46} />
                            <Bar dataKey="absent" stackId="a" fill="url(#gAbsent)" name="Absent" radius={[6, 6, 0, 0]} maxBarSize={46} />
                        </BarChart>
                    </ResponsiveContainer>
                </CardContent>
            </Card>
            )} */}
        </div>
    );
};
