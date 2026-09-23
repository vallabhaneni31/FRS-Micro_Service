import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, Search, X, Download, CalendarCheck, Users, MapPin, TrendingUp } from 'lucide-react';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select';
import { cn } from '../../../ui/utils';
import { apiRequest } from '../../../../services/http/apiClient';
import { formatYmdInSiteTz } from '../../../../utils/timezone';
import { useQueryParam } from '../../../../hooks/useQueryParam';
import { DwellTimeline } from './DwellTimeline';
import { DeviceDayHeatmap } from './DeviceDayHeatmap';

const fmtMins = (m?: number | null) => {
    if (!m || m <= 0) return '0m';
    const hh = Math.floor(m / 60), mm = m % 60;
    return hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
};
const ZONE_TONE: Record<string, string> = {
    work: 'text-emerald-600', break: 'text-amber-600', other: 'text-sky-600', unassigned: 'text-slate-500',
};

type Cell = 'P' | 'L' | 'A' | 'W' | 'H' | 'R' | 'V' | '';

const CELL_STYLE: Record<Exclude<Cell, ''>, { soft: string; dot: string; label: string }> = {
    P: { soft: 'bg-emerald-500/15 text-emerald-700 ring-1 ring-inset ring-emerald-500/25 dark:text-emerald-300', dot: 'bg-emerald-500', label: 'Present' },
    L: { soft: 'bg-amber-500/15 text-amber-700 ring-1 ring-inset ring-amber-500/25 dark:text-amber-300',         dot: 'bg-amber-500',   label: 'Late' },
    A: { soft: 'bg-rose-500/15 text-rose-700 ring-1 ring-inset ring-rose-500/25 dark:text-rose-300',             dot: 'bg-rose-500',    label: 'Absent' },
    R: { soft: 'bg-sky-500/15 text-sky-700 ring-1 ring-inset ring-sky-500/25 dark:text-sky-300',                 dot: 'bg-sky-500',     label: 'WFH (R)' },
    V: { soft: 'bg-indigo-500/15 text-indigo-700 ring-1 ring-inset ring-indigo-500/25 dark:text-indigo-300',     dot: 'bg-indigo-500',  label: 'On leave (V)' },
    H: { soft: 'bg-violet-500/15 text-violet-700 ring-1 ring-inset ring-violet-500/25 dark:text-violet-300',     dot: 'bg-violet-500',  label: 'Holiday (H)' },
    W: { soft: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground/30', label: 'Weekly off' },
};

const initials = (name?: string) =>
    (name ?? '').trim().split(/\s+/).filter(Boolean).map(n => n[0]).join('').slice(0, 2).toUpperCase() || '—';

const DEPT_PALETTE = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#ef4444', '#6366f1', '#14b8a6', '#f97316'];
const deptColor = (name?: string) => {
    const n = (name ?? '').trim();
    if (!n || n === '—') return '#94a3b8';
    let h = 0;
    for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
    return DEPT_PALETTE[h % DEPT_PALETTE.length];
};
const cleanDept = (d?: string | null) => ((d ?? '').trim() || '—');

const pad = (n: number) => String(n).padStart(2, '0');
const monthLabel = (ym: string) => {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
};
const pctTone = (pct: number) =>
    pct >= 90 ? 'bg-emerald-500/10 text-emerald-600' : pct >= 75 ? 'bg-amber-500/10 text-amber-600' : 'bg-rose-500/10 text-rose-600';

interface Row { id: string; name: string; dept: string; cells: Cell[]; p: number; l: number; a: number; pct: number; }

interface Props {
    employees: any[];
    accessToken: string | null;
    scopeHeaders: Record<string, string>;
    siteToday: string;               // YYYY-MM-DD
    onPickEmployee?: (id: string, name: string) => void;
    onOpenDate?: (date: string) => void;   // jump to Daily view for a clicked day
}

export const MonthlyAttendanceGrid: React.FC<Props> = ({ employees, accessToken, scopeHeaders, siteToday, onPickEmployee, onOpenDate }) => {
    // Deep-linked monthly view state (m-prefixed so it never collides with the daily params).
    const [month, setMonth] = useQueryParam('m', siteToday.slice(0, 7)); // YYYY-MM
    const [search, setSearch] = useQueryParam('mq');
    const [deptFilter, setDeptFilter] = useQueryParam('mdept', 'all');
    const [sort, setSort] = useQueryParam('msort', 'name');
    const [quick, setQuick] = useQueryParam('mquick', 'all');
    const [groupParam, setGroupParam] = useQueryParam('mgroup');
    const groupByDept = groupParam === '1';

    const [records, setRecords] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    // Per-employee monthly device/dwell rollup: empId → { deviceCount, topLocation, totalsByZone, locations, totalMinutes, productivityPct }.
    const [summary, setSummary] = useState<Record<string, any>>({});
    // Department-level dwell rollup for the month.
    const [deptSummary, setDeptSummary] = useState<any[]>([]);
    // Per-employee-day details modal (shows dwell-time / per-device durations).
    const [detail, setDetail] = useState<{ empId: string; empName: string; date: string; label: string } | null>(null);

    const [year, mon] = month.split('-').map(Number);
    const daysInMonth = new Date(year, mon, 0).getDate();
    const todayDay = siteToday.slice(0, 7) === month ? Number(siteToday.slice(8, 10)) : Infinity;
    const monthFrom = `${month}-01`;
    const monthTo = `${month}-${pad(daysInMonth)}`;

    useEffect(() => {
        setLoading(true);
        apiRequest<{ data: any[] }>(`/live/attendance?fromDate=${monthFrom}&toDate=${monthTo}&limit=10000`, { accessToken, scopeHeaders })
            .then(res => setRecords(res?.data ?? []))
            .catch(() => setRecords([]))
            .finally(() => setLoading(false));
        // Monthly device/dwell rollup (non-blocking — grid renders without it).
        apiRequest<{ employees: Record<string, any>; departments: any[] }>(`/attendance/dwell-summary?fromDate=${monthFrom}&toDate=${monthTo}`, { accessToken, scopeHeaders, noCache: true })
            .then(res => { setSummary(res?.employees ?? {}); setDeptSummary(res?.departments ?? []); })
            .catch(() => { setSummary({}); setDeptSummary([]); });
    }, [month, accessToken]);

    // empId → day → cell, plus the set of holiday days (so holidays render for everyone).
    const { byEmployee, holidayDays } = useMemo(() => {
        const map = new Map<string, Record<number, Cell>>();
        const holidays = new Set<number>();
        records.forEach(r => {
            const dateStr: string = formatYmdInSiteTz(r.attendance_date);
            if (!dateStr || dateStr.slice(0, 7) !== month) return;
            const day = Number(dateStr.slice(8, 10));
            const id = String(r.fk_employee_id);
            const isLate = (r.is_late_computed ?? r.is_late) === true;
            const s = r.status;
            const cell: Cell =
                  s === 'holiday' ? 'H'
                : s === 'wfh' || s === 'work-from-home' ? 'R'
                : s === 'leave' || s === 'on-leave' ? 'V'
                : s === 'absent' ? 'A'
                : s === 'weekend' ? 'W'
                : isLate ? 'L' : 'P';
            if (cell === 'H') holidays.add(day);
            if (!map.has(id)) map.set(id, {});
            map.get(id)![day] = cell;
        });
        return { byEmployee: map, holidayDays: holidays };
    }, [records, month]);

    const days = useMemo(() => Array.from({ length: daysInMonth }, (_, i) => i + 1), [daysInMonth]);
    const WD = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const dayMeta = useMemo(() => days.map(d => {
        const dow = new Date(year, mon - 1, d).getDay();
        return { d, dow, weekend: dow === 0 || dow === 6, today: d === todayDay, wd: WD[dow] };
    }), [days, year, mon, todayDay]);
    const colShade = (m: { weekend: boolean; today: boolean }) =>
        m.today ? 'bg-primary/10' : m.weekend ? 'bg-muted/50' : '';

    // Build a row per active employee with cells + counts (computed once).
    const rows = useMemo<Row[]>(() => {
        const cellFor = (id: string, day: number): Cell => {
            const rec = byEmployee.get(id)?.[day];
            if (rec) return rec;
            if (day > todayDay) return '';
            if (holidayDays.has(day)) return 'H';
            const dow = new Date(year, mon - 1, day).getDay();
            if (dow === 0 || dow === 6) return 'W';
            return 'A';
        };
        return employees
            .filter(e => e.status === 'active')
            .map(e => {
                const id = String(e.pk_employee_id);
                let p = 0, l = 0, a = 0;
                const cells = days.map(d => {
                    const c = cellFor(id, d);
                    // WFH counts as present; Holiday / Leave / Weekend are neutral.
                    if (c === 'P' || c === 'R') p++; else if (c === 'L') l++; else if (c === 'A') a++;
                    return c;
                });
                const denom = p + l + a;
                return { id, name: e.full_name, dept: cleanDept(e.department_name), cells, p, l, a, pct: denom ? Math.round(((p + l) / denom) * 100) : 0 };
            });
    }, [employees, byEmployee, holidayDays, days, year, mon, todayDay]);

    const departments = useMemo(() => {
        const s = new Set<string>();
        rows.forEach(r => r.dept && r.dept !== '—' && s.add(r.dept));
        return ['all', ...[...s].sort()];
    }, [rows]);

    const viewRows = useMemo(() => {
        let r = rows;
        if (deptFilter !== 'all') r = r.filter(x => x.dept === deptFilter);
        if (search.trim()) { const q = search.toLowerCase(); r = r.filter(x => x.name.toLowerCase().includes(q)); }
        if (quick === 'absences') r = r.filter(x => x.a > 0);
        else if (quick === 'late') r = r.filter(x => x.l >= 3);
        else if (quick === 'low') r = r.filter(x => (x.p + x.l + x.a) > 0 && x.pct < 75);
        const within = (a: Row, b: Row) =>
            sort === 'worst' ? (a.pct - b.pct || a.name.localeCompare(b.name))
            : sort === 'best' ? (b.pct - a.pct || a.name.localeCompare(b.name))
            : a.name.localeCompare(b.name);
        const sorted = [...r];
        sorted.sort((a, b) => (groupByDept && a.dept !== b.dept ? a.dept.localeCompare(b.dept) : within(a, b)));
        return sorted;
    }, [rows, deptFilter, search, quick, sort, groupByDept]);

    // Per-department roll-up (used for the group header rows).
    const deptStats = useMemo(() => {
        const m = new Map<string, { count: number; sum: number }>();
        viewRows.forEach(r => {
            const s = m.get(r.dept) ?? { count: 0, sum: 0 };
            s.count++; s.sum += r.pct; m.set(r.dept, s);
        });
        return m;
    }, [viewRows]);

    // Clean, accurate per-department time-by-zone rollup.
    const displayDeptSummary = useMemo(() => {
        const deptEmpCounts = new Map<string, number>();
        rows.forEach(r => {
            const d = cleanDept(r.dept);
            deptEmpCounts.set(d, (deptEmpCounts.get(d) || 0) + 1);
        });

        if (deptSummary && deptSummary.length > 0) {
            const map = new Map<string, any>();
            deptSummary.forEach((d: any) => {
                if (d && d.department) {
                    const deptName = cleanDept(d.department);
                    const existing = map.get(deptName);
                    if (!existing) {
                        map.set(deptName, { ...d, department: deptName, totalsByZone: { ...d.totalsByZone } });
                    } else {
                        existing.totalMinutes = (existing.totalMinutes || 0) + (d.totalMinutes || 0);
                        (['work', 'break', 'other', 'unassigned'] as const).forEach(z => {
                            existing.totalsByZone[z] = (existing.totalsByZone[z] || 0) + (d.totalsByZone?.[z] || 0);
                        });
                    }
                }
            });

            const list = Array.from(map.values()).map(d => {
                const deptName = d.department;
                const actualCount = deptEmpCounts.get(deptName) ?? d.employees ?? 0;
                const tot = d.totalMinutes || 0;
                const workMins = d.totalsByZone?.work || 0;
                const avgProd = tot > 0 ? Math.round((workMins / tot) * 100) : (d.avgProductivityPct ?? null);
                return {
                    ...d,
                    employees: actualCount,
                    avgProductivityPct: avgProd,
                };
            });

            return list.sort((a, b) => (b.totalMinutes || 0) - (a.totalMinutes || 0));
        }

        const fallbackMap = new Map<string, { department: string; employees: number; totalMinutes: number; totalsByZone: Record<string, number> }>();
        rows.forEach(r => {
            const d = cleanDept(r.dept);
            if (!fallbackMap.has(d)) {
                fallbackMap.set(d, {
                    department: d,
                    employees: 0,
                    totalMinutes: 0,
                    totalsByZone: { work: 0, break: 0, other: 0, unassigned: 0 },
                });
            }
            const item = fallbackMap.get(d)!;
            item.employees += 1;
            const empSum = summary[r.id];
            if (empSum) {
                item.totalMinutes += empSum.totalMinutes || 0;
                if (empSum.totalsByZone) {
                    (['work', 'break', 'other', 'unassigned'] as const).forEach(z => {
                        item.totalsByZone[z] += empSum.totalsByZone[z] || 0;
                    });
                }
            }
        });

        return Array.from(fallbackMap.values()).map(d => {
            const tot = d.totalMinutes;
            const avgProd = tot > 0 ? Math.round((d.totalsByZone.work / tot) * 100) : null;
            return { ...d, avgProductivityPct: avgProd };
        }).sort((a, b) => b.totalMinutes - a.totalMinutes);
    }, [deptSummary, rows, summary]);

    // Month KPIs (over the filtered set).
    const kpis = useMemo(() => {
        const n = viewRows.length;
        const sum = viewRows.reduce((acc, r) => ({ p: acc.p + r.p, l: acc.l + r.l, a: acc.a + r.a, pct: acc.pct + r.pct }), { p: 0, l: 0, a: 0, pct: 0 });
        const perfect = viewRows.filter(r => r.pct === 100 && (r.p + r.l + r.a) > 0).length;
        return { avg: n ? Math.round(sum.pct / n) : 0, present: sum.p, late: sum.l, absent: sum.a, perfect };
    }, [viewRows]);

    // Per-day totals (present+late) across the filtered set, for the footer.
    const dayTotals = useMemo(() => days.map((_, i) => {
        let here = 0, elig = 0;
        viewRows.forEach(r => {
            const c = r.cells[i];
            if (c === 'P' || c === 'L' || c === 'R') { here++; elig++; }
            else if (c === 'A') elig++;
        });
        return { here, elig, pct: elig ? Math.round((here / elig) * 100) : null };
    }), [viewRows, days]);

    const maxMonth = siteToday.slice(0, 7);          // can't view beyond the current month
    const isCurrentMonth = month >= maxMonth;
    const shiftMonth = (delta: number) => {
        const d = new Date(year, mon - 1 + delta, 1);
        const target = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
        if (target > maxMonth) return;               // block future months
        setMonth(target);
    };
    // Snap back if a future month arrives via a deep-link URL (?m=…).
    useEffect(() => { if (month > maxMonth) setMonth(maxMonth); }, [month, maxMonth]);

    const exportCsv = () => {
        const head = ['Employee', 'Department', ...days.map(String), 'Present', 'Late', 'Absent', 'Attendance %'];
        const lines = [head.join(',')];
        viewRows.forEach(r => {
            const cells = r.cells.map(c => c || '-');
            lines.push([`"${r.name.replace(/"/g, '""')}"`, `"${r.dept}"`, ...cells, r.p, r.l, r.a, `${r.pct}%`].join(','));
        });
        const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `attendance-${month}.csv`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const QUICK_FILTERS: { key: typeof quick; label: string }[] = [
        { key: 'all', label: 'All' },
        { key: 'absences', label: 'Has absences' },
        { key: 'late', label: 'Frequent late (3+)' },
        { key: 'low', label: 'Below 75%' },
    ];

    return (
        <div className="space-y-3">
            {/* Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => shiftMonth(-1)} className="h-8 w-8 rounded-lg p-0"><ChevronLeft className="h-4 w-4" /></Button>
                    <span className="min-w-[140px] text-center text-sm font-bold text-foreground">{monthLabel(month)}</span>
                    <Button variant="outline" size="sm" onClick={() => shiftMonth(1)} disabled={isCurrentMonth} className="h-8 w-8 rounded-lg p-0"><ChevronRight className="h-4 w-4" /></Button>
                    
                    {!isCurrentMonth && (
                        <Button variant="ghost" size="sm" onClick={() => setMonth(siteToday.slice(0, 7))} className="h-8 gap-1 rounded-lg text-xs">
                            <CalendarCheck className="h-3.5 w-3.5" /> This month
                        </Button>
                    )}
                    
                    <div className="ml-3 flex items-center gap-2 rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-3 py-1.5 text-indigo-700 dark:text-indigo-300 shadow-[0_2px_10px_-3px_rgba(99,102,241,0.2)]">
                        <TrendingUp className="h-4 w-4 shrink-0" />
                        <div className="flex flex-col leading-none">
                            <span className="text-[9px] font-extrabold uppercase tracking-widest opacity-80">Avg attendance</span>
                            <span className="text-sm font-black tabular-nums">{kpis.avg}%</span>
                        </div>
                    </div>
                    
                    {loading && <Loader2 className="ml-1 h-4 w-4 animate-spin text-muted-foreground" />}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search employee…" className="h-8 w-44 pl-8 pr-7 text-sm" />
                        {search && <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>}
                    </div>
                    <Select value={deptFilter} onValueChange={setDeptFilter}>
                        <SelectTrigger className="h-8 w-40 rounded-lg text-sm"><SelectValue placeholder="All departments" /></SelectTrigger>
                        <SelectContent>{departments.map(d => <SelectItem key={d} value={d}>{d === 'all' ? 'All departments' : d}</SelectItem>)}</SelectContent>
                    </Select>
                    <Select value={sort} onValueChange={setSort}>
                        <SelectTrigger className="h-8 w-36 rounded-lg text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="name">Name (A–Z)</SelectItem>
                            <SelectItem value="worst">Lowest %</SelectItem>
                            <SelectItem value="best">Highest %</SelectItem>
                        </SelectContent>
                    </Select>
                    <Button
                        variant={groupByDept ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setGroupParam(groupByDept ? '' : '1')}
                        className="h-8 gap-1.5 rounded-lg text-sm"
                    >
                        <Users className="h-3.5 w-3.5" /> Group
                    </Button>
                    <Button variant="outline" size="sm" onClick={exportCsv} className="h-8 gap-1.5 rounded-lg text-sm">
                        <Download className="h-3.5 w-3.5" /> CSV
                    </Button>
                </div>
            </div>

            {/* Quick filters */}
            <div className="flex flex-wrap items-center gap-2">
                {QUICK_FILTERS.map(f => (
                    <button
                        key={f.key}
                        onClick={() => setQuick(f.key)}
                        className={cn(
                            'rounded-full border px-3 py-1 text-xs font-semibold transition-colors',
                            quick === f.key ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-foreground/30',
                        )}
                    >
                        {f.label}
                    </button>
                ))}
            </div>



            {/* Legend */}
            <div className="flex flex-wrap items-center gap-3 px-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{viewRows.length} of {rows.length} employees</span>
                <span className="text-muted-foreground/40">·</span>
                {(['P', 'L', 'A', 'R', 'V', 'H', 'W'] as const).map(k => (
                    <span key={k} className="flex items-center gap-1.5">
                        <span className={cn('h-2.5 w-2.5 rounded-full', CELL_STYLE[k].dot)} />{CELL_STYLE[k].label}
                    </span>
                ))}
            </div>

            {/* Grid */}
            <div className="max-h-[64vh] overflow-auto rounded-xl border border-border">
                <table className="w-full border-separate border-spacing-0 text-xs">
                    <thead>
                        <tr>
                            <th className="sticky left-0 top-0 z-30 min-w-[200px] border-b border-border bg-muted px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground shadow-[6px_0_8px_-6px_rgba(0,0,0,0.12)]">Employee</th>
                            {dayMeta.map(m => (
                                <th key={m.d} className={cn('sticky top-0 z-20 min-w-[30px] border-b border-border bg-muted px-0 py-1.5 text-center font-bold', m.dow === 1 && 'border-l border-border', colShade(m))}>
                                    <span className={cn('block text-[9px] font-semibold leading-tight', m.weekend ? 'text-rose-400' : 'text-muted-foreground/60')}>{m.wd}</span>
                                    {m.today ? (
                                        <span className="mx-auto mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">{m.d}</span>
                                    ) : (
                                        <span className={cn('block text-[11px] leading-tight', m.weekend ? 'text-rose-400' : 'text-foreground')}>{m.d}</span>
                                    )}
                                </th>
                            ))}
                            <th className="sticky right-0 top-0 z-20 border-b border-l border-border bg-muted px-3 py-2 text-center text-[10px] font-bold uppercase text-muted-foreground shadow-[-6px_0_8px_-6px_rgba(0,0,0,0.12)]">P / L / A</th>
                        </tr>
                    </thead>
                    <tbody>
                        {viewRows.map((r, idx) => {
                          const showGroup = groupByDept && (idx === 0 || viewRows[idx - 1].dept !== r.dept);
                          const gs = showGroup ? deptStats.get(r.dept) : null;
                          return (
                          <React.Fragment key={r.id}>
                            {showGroup && gs && (
                                <tr>
                                    <td colSpan={dayMeta.length + 2} className="sticky left-0 z-10 border-y border-border bg-muted/70 px-3 py-1.5">
                                        <div className="flex items-center gap-2">
                                            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: deptColor(r.dept) }} />
                                            <span className="text-xs font-bold text-foreground">{r.dept}</span>
                                            <span className="text-[11px] text-muted-foreground">{gs.count} {gs.count === 1 ? 'person' : 'people'}</span>
                                            <span className={cn('ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold', pctTone(Math.round(gs.sum / gs.count)))}>
                                                avg {Math.round(gs.sum / gs.count)}%
                                            </span>
                                        </div>
                                    </td>
                                </tr>
                            )}
                            <tr className="group">
                                <td className="sticky left-0 z-10 border-b border-border/60 bg-card px-3 py-3 shadow-[6px_0_8px_-6px_rgba(0,0,0,0.12)] group-hover:bg-accent/40">
                                    <button onClick={() => onPickEmployee?.(r.id, r.name)} className="flex items-center gap-2 text-left">
                                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[9px] font-black"
                                            style={{ backgroundColor: deptColor(r.dept) + '1A', color: deptColor(r.dept) }}>
                                            {initials(r.name)}
                                        </span>
                                        <span className="max-w-[150px] truncate text-xs font-medium text-foreground group-hover:underline">{r.name}</span>
                                    </button>
                                </td>
                                {r.cells.map((c, i) => {
                                    // Any real status cell (not weekly-off/empty) opens the day details modal.
                                    const clickable = !!c && c !== 'W';
                                    return (
                                        <td
                                            key={i}
                                            onClick={clickable ? () => setDetail({ empId: r.id, empName: r.name, date: `${month}-${pad(dayMeta[i].d)}`, label: CELL_STYLE[c as Exclude<Cell, ''>].label }) : undefined}
                                            className={cn('border-b border-border/60 px-0.5 py-2.5 text-center group-hover:bg-accent/30', dayMeta[i].dow === 1 && 'border-l border-border/70', colShade(dayMeta[i]), clickable && 'cursor-pointer')}
                                        >
                                            {!c ? (
                                                <span className="mx-auto block h-1 w-1 rounded-full bg-muted-foreground/20" />
                                            ) : c === 'W' ? (
                                                <span className="mx-auto block text-[11px] leading-6 text-muted-foreground/30">–</span>
                                            ) : (
                                                <span title={`${monthLabel(month).split(' ')[0]} ${dayMeta[i].d}: ${CELL_STYLE[c].label}${clickable ? ' — view details' : ''}`}
                                                    className={cn('mx-auto flex h-6 w-6 items-center justify-center rounded-lg text-[11px] font-extrabold transition-transform hover:scale-110', CELL_STYLE[c].soft)}>
                                                    {c}
                                                </span>
                                            )}
                                        </td>
                                    );
                                })}
                                <td className="sticky right-0 z-10 border-b border-l border-border/60 bg-card px-3 py-3 shadow-[-6px_0_8px_-6px_rgba(0,0,0,0.12)] group-hover:bg-accent/40">
                                    <div className="flex flex-col items-end gap-1">
                                        <div className="flex items-center justify-end gap-2">
                                            <span className="font-mono text-[11px] font-semibold">
                                                <span className="text-emerald-600">{r.p}</span>
                                                <span className="text-muted-foreground/40">/</span>
                                                <span className="text-amber-600">{r.l}</span>
                                                <span className="text-muted-foreground/40">/</span>
                                                <span className="text-rose-600">{r.a}</span>
                                            </span>
                                            <span className={cn('w-9 rounded-full px-1.5 py-0.5 text-center text-[10px] font-bold', pctTone(r.pct))}>{r.pct}%</span>
                                        </div>
                                        {(() => {
                                            const s = summary[r.id];
                                            if (!s || !s.deviceCount) return null;
                                            return (
                                                <span className="flex items-center gap-1 whitespace-nowrap text-[10px] text-muted-foreground" title={`${s.deviceCount} locations · ${fmtMins(s.totalMinutes)} tracked${s.productivityPct != null ? ` · ${s.productivityPct}% in work zones` : ''} this month`}>
                                                    <MapPin className="h-3 w-3 opacity-60" />
                                                    <span className="font-semibold text-foreground">{s.deviceCount}</span>
                                                    {s.topLocation && <span className="max-w-[72px] truncate">· {s.topLocation}</span>}
                                                    {s.productivityPct != null && (
                                                        <span className={cn('ml-0.5 rounded px-1 font-bold',
                                                            s.productivityPct >= 70 ? 'text-emerald-600' : s.productivityPct >= 40 ? 'text-amber-600' : 'text-rose-600')}>
                                                            {s.productivityPct}%
                                                        </span>
                                                    )}
                                                </span>
                                            );
                                        })()}
                                    </div>
                                </td>
                            </tr>
                          </React.Fragment>
                          );
                        })}
                    </tbody>
                    {viewRows.length > 0 && (
                        <tfoot>
                            <tr>
                                <td className="sticky bottom-0 left-0 z-20 border-t border-border bg-muted px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground shadow-[6px_0_8px_-6px_rgba(0,0,0,0.12)]">Present / day</td>
                                {dayMeta.map((m, i) => {
                                    const t = dayTotals[i];
                                    return (
                                        <td key={m.d} className={cn('sticky bottom-0 z-10 border-t border-border bg-muted px-0 py-1.5 text-center', m.dow === 1 && 'border-l border-border/70', colShade(m))}>
                                            {m.weekend ? <span className="text-[9px] text-muted-foreground/40">–</span>
                                                : t.pct == null ? <span className="text-[9px] text-muted-foreground/30">·</span>
                                                : <span className={cn('text-[10px] font-bold tabular-nums', t.pct >= 75 ? 'text-emerald-600' : t.pct >= 50 ? 'text-amber-600' : 'text-rose-600')}>{t.here}</span>}
                                        </td>
                                    );
                                })}
                                <td className="sticky bottom-0 right-0 z-20 border-t border-l border-border bg-muted px-3 py-1.5 text-center text-[10px] font-bold text-muted-foreground shadow-[-6px_0_8px_-6px_rgba(0,0,0,0.12)]">{kpis.avg}%</td>
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>
            {!loading && viewRows.length === 0 && (
                <p className="py-8 text-center text-sm text-muted-foreground">No employees match the filters.</p>
            )}

            {/* Department time-by-zone rollup for the month */}
            {displayDeptSummary.length > 0 && (
                <div className="mt-5 rounded-2xl border border-border bg-card p-4">
                    <p className="mb-3 text-xs font-bold uppercase tracking-wide text-muted-foreground">Department · time by zone</p>
                    <div className="space-y-2.5">
                        {displayDeptSummary.map((d: any) => {
                            const tot = d.totalMinutes || 1;
                            const seg = (z: string, cls: string) => (d.totalsByZone?.[z] ?? 0) > 0 && (
                                <div key={z} className={cls} style={{ width: `${((d.totalsByZone[z] || 0) / tot) * 100}%` }} title={`${z}: ${fmtMins(d.totalsByZone[z])}`} />
                            );
                            return (
                                <div key={d.department} className="flex items-center gap-3">
                                    <div className="w-40 shrink-0 truncate text-xs font-semibold text-foreground" title={d.department}>
                                        {d.department}
                                        <span className="ml-1 font-normal text-muted-foreground">({d.employees})</span>
                                    </div>
                                    <div className="flex h-2.5 flex-1 gap-px overflow-hidden rounded-full bg-muted">
                                        {seg('work', 'h-full bg-emerald-500 first:rounded-l-full')}
                                        {seg('break', 'h-full bg-amber-500')}
                                        {seg('other', 'h-full bg-sky-500')}
                                        {seg('unassigned', 'h-full bg-slate-400 last:rounded-r-full')}
                                    </div>
                                    <span className={cn('w-10 shrink-0 text-right text-xs font-bold tabular-nums',
                                        d.avgProductivityPct == null ? 'text-muted-foreground'
                                        : d.avgProductivityPct >= 70 ? 'text-emerald-600' : d.avgProductivityPct >= 40 ? 'text-amber-600' : 'text-rose-600')}
                                        title="Average productivity (time in work zones)">
                                        {d.avgProductivityPct != null ? `${d.avgProductivityPct}%` : '—'}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-3 text-[10px] text-muted-foreground">
                        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> Work</span>
                        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500" /> Break</span>
                        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-sky-500" /> Other</span>
                        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-slate-400" /> Unassigned</span>
                        <span className="ml-auto">% = avg productivity</span>
                    </div>
                </div>
            )}

            {/* Device activity for the month (device × day) */}
            <div className="mt-5">
                <DeviceDayHeatmap fromDate={monthFrom} toDate={monthTo} />
            </div>

            {/* Per-employee-day details modal */}
            {detail && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setDetail(null)}>
                    <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
                        <div className="mb-3 flex items-start justify-between gap-3 border-b border-border/60 pb-3">
                            <div className="min-w-0">
                                <p className="truncate text-sm font-bold text-foreground">{detail.empName}</p>
                                <p className="text-xs text-muted-foreground">
                                    {new Date(detail.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}
                                    <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">{detail.label}</span>
                                </p>
                            </div>
                            <button onClick={() => setDetail(null)} className="shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                        <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground/70">Time by location · this day</p>
                        <DwellTimeline employeeId={detail.empId} date={detail.date} accessToken={accessToken} scopeHeaders={scopeHeaders} />

                        {/* Monthly rollup for this employee */}
                        {(() => {
                            const s = summary[detail.empId];
                            if (!s || !s.deviceCount) return null;
                            return (
                                <div className="mt-4 border-t border-border/60 pt-3">
                                    <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-muted-foreground/70">
                                        This month · {s.deviceCount} location{s.deviceCount === 1 ? '' : 's'} · {fmtMins(s.totalMinutes)} tracked
                                    </p>
                                    <div className="space-y-1.5">
                                        {s.locations.slice(0, 6).map((l: any) => (
                                            <div key={l.location} className="flex items-center justify-between gap-2 text-xs">
                                                <span className="flex min-w-0 items-center gap-1.5">
                                                    <span className={cn('h-2 w-2 shrink-0 rounded-full',
                                                        l.zoneType === 'work' ? 'bg-emerald-500' : l.zoneType === 'break' ? 'bg-amber-500' : l.zoneType === 'other' ? 'bg-sky-500' : 'bg-slate-400')} />
                                                    <span className="truncate text-foreground">{l.location}</span>
                                                </span>
                                                <span className={cn('shrink-0 font-bold tabular-nums', ZONE_TONE[l.zoneType] ?? ZONE_TONE.unassigned)}>{fmtMins(l.minutes)}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            );
                        })()}

                        <div className="mt-4 flex justify-end gap-2">
                            {onOpenDate && (
                                <Button variant="outline" size="sm" className="rounded-lg text-xs"
                                    onClick={() => { const d = detail.date; setDetail(null); onOpenDate(d); }}>
                                    Open daily view
                                </Button>
                            )}
                            <Button size="sm" className="rounded-lg text-xs" onClick={() => setDetail(null)}>Close</Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
