import React, { useEffect, useMemo, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '../../../ui/sheet';
import { Button } from '../../../ui/button';
import { cn } from '../../../ui/utils';
import { Loader2, Clock, LogIn, LogOut, CalendarCheck, EyeOff, ChevronLeft, ChevronRight } from 'lucide-react';
import { apiRequest } from '../../../../services/http/apiClient';
import { formatTimeInSiteTz, formatYmdInSiteTz } from '../../../../utils/timezone';
import { useAuthedPhotoUrl } from '../../../../services/http/authedPhoto';
import { DwellTimeline } from './DwellTimeline';

interface Props {
    open: boolean;
    onClose: () => void;
    employeeId: string | null;
    employeeName: string | null;
    siteToday: string;
    initialMonth?: string;          // YYYY-MM — the month the grid is showing
    accessToken: string | null;
    scopeHeaders: Record<string, string>;
}

type Kind = 'present' | 'late' | 'absent' | 'wfh' | 'leave' | 'holiday' | 'weekend';

const KIND_META: Record<Kind, { label: string; cls: string; dot: string }> = {
    present: { label: 'Present', cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20', dot: 'bg-emerald-500' },
    late:    { label: 'Late',    cls: 'bg-amber-500/10 text-amber-600 border-amber-500/20',       dot: 'bg-amber-500' },
    absent:  { label: 'Absent',  cls: 'bg-rose-500/10 text-rose-600 border-rose-500/20',          dot: 'bg-rose-500' },
    wfh:     { label: 'WFH',     cls: 'bg-sky-500/10 text-sky-600 border-sky-500/20',             dot: 'bg-sky-500' },
    leave:   { label: 'Leave', cls: 'bg-indigo-500/10 text-indigo-600 border-indigo-500/20',  dot: 'bg-indigo-500' },
    holiday: { label: 'Holiday', cls: 'bg-violet-500/10 text-violet-600 border-violet-500/20',    dot: 'bg-violet-500' },
    weekend: { label: 'Off', cls: 'bg-muted text-muted-foreground border-border', dot: 'bg-muted-foreground/30' },
};

const initials = (name?: string) =>
    (name ?? '').trim().split(/\s+/).filter(Boolean).map(n => n[0]).join('').slice(0, 2).toUpperCase() || '—';
const DEPT_PALETTE = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#ef4444', '#6366f1', '#14b8a6', '#f97316'];
const deptColor = (name?: string) => {
    const n = (name ?? '').trim();
    if (!n) return '#94a3b8';
    let h = 0; for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
    return DEPT_PALETTE[h % DEPT_PALETTE.length];
};

const pad = (n: number) => String(n).padStart(2, '0');
const monthLabel = (ym: string) => {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
};
const fmtMins = (m?: number | null) => {
    if (!m || m <= 0) return '—';
    const h = Math.floor(m / 60), mm = m % 60;
    return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
};
// /uploads requires a Bearer token, so a plain <img src> would 401 — fetch it
// authenticated and render the resulting blob URL instead.
const PunchPhotoThumb: React.FC<{ photo: string | null | undefined; ring: string }> = ({ photo, ring }) => {
    const { url } = useAuthedPhotoUrl(photo);
    if (!photo || !url) return null;
    return <img src={url} className={cn('h-8 w-10 rounded object-cover ring-1', ring)} />;
};

interface Day { day: number; dow: number; weekday: string; kind: Kind; checkIn?: string; checkOut?: string; mins?: number | null; inPhoto?: string | null; outPhoto?: string | null; }

export const EmployeeTimesheetDrawer: React.FC<Props> = ({ open, onClose, employeeId, employeeName, siteToday, initialMonth, accessToken, scopeHeaders }) => {
    // Local month state — kept off the URL so navigating months doesn't trigger a
    // route change (which was dismissing the drawer).
    const [month, setMonth] = useState(initialMonth || siteToday.slice(0, 7));
    const [records, setRecords] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [hideOff, setHideOff] = useState(false);
    const [expandedDay, setExpandedDay] = useState<number | null>(null);

    // Sync to the grid's month each time the drawer opens.
    useEffect(() => { if (open) { setMonth(initialMonth || siteToday.slice(0, 7)); setExpandedDay(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

    const [year, mon] = month.split('-').map(Number);
    const daysInMonth = new Date(year, mon, 0).getDate();
    const todayDay = siteToday.slice(0, 7) === month ? Number(siteToday.slice(8, 10)) : Infinity;
    const maxMonth = siteToday.slice(0, 7);
    const isCurrentMonth = month >= maxMonth;
    const shiftMonth = (delta: number) => {
        const d = new Date(year, mon - 1 + delta, 1);
        const t = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
        if (t > maxMonth) return;
        setMonth(t);
    };

    useEffect(() => {
        if (!open || !employeeId) return;
        const from = `${month}-01`, to = `${month}-${pad(daysInMonth)}`;
        setLoading(true);
        apiRequest<{ data: any[] }>(`/live/attendance?fromDate=${from}&toDate=${to}&limit=10000`, { accessToken, scopeHeaders })
            .then(res => setRecords((res?.data ?? []).filter((r: any) => String(r.fk_employee_id) === employeeId)))
            .catch(() => setRecords([]))
            .finally(() => setLoading(false));
    }, [open, employeeId, month, accessToken]);

    const { days, summary } = useMemo(() => {
        const byDay = new Map<number, any>();
        const holidays = new Set<number>();
        records.forEach(r => {
            const ds: string = formatYmdInSiteTz(r.attendance_date);
            if (!ds || ds.slice(0, 7) !== month) return;
            const d = Number(ds.slice(8, 10));
            byDay.set(d, r);
            if (r.status === 'holiday') holidays.add(d);
        });
        const out: Day[] = [];
        const sum = { present: 0, late: 0, absent: 0, wfh: 0, leave: 0, holiday: 0, mins: 0 };
        for (let d = 1; d <= daysInMonth; d++) {
            if (d > todayDay) continue;
            const dt = new Date(year, mon - 1, d);
            const dow = dt.getDay();
            const r = byDay.get(d);
            let kind: Kind;
            if (r) {
                const isLate = (r.is_late_computed ?? r.is_late) === true;
                kind = r.status === 'holiday' ? 'holiday'
                    : r.status === 'wfh' || r.status === 'work-from-home' ? 'wfh'
                    : r.status === 'leave' || r.status === 'on-leave' ? 'leave'
                    : r.status === 'absent' ? 'absent'
                    : r.status === 'weekend' ? 'weekend'
                    : isLate ? 'late' : 'present';
            } else if (holidays.has(d)) kind = 'holiday';
            else if (dow === 0 || dow === 6) kind = 'weekend';
            else kind = 'absent';

            if (kind === 'present') sum.present++;
            else if (kind === 'late') sum.late++;
            else if (kind === 'absent') sum.absent++;
            else if (kind === 'wfh') sum.wfh++;
            else if (kind === 'leave') sum.leave++;
            else if (kind === 'holiday') sum.holiday++;
            if (typeof r?.duration_minutes === 'number') sum.mins += r.duration_minutes;

            out.push({
                day: d, dow, weekday: dt.toLocaleDateString(undefined, { weekday: 'short' }), kind,
                checkIn: r?.check_in ? formatTimeInSiteTz(r.check_in) : undefined,
                checkOut: r?.check_out ? formatTimeInSiteTz(r.check_out) : undefined,
                mins: r?.duration_minutes,
                inPhoto: r?.checkin_photo_url, outPhoto: r?.checkout_photo_url,
            });
        }
        const worked = sum.present + sum.late + sum.wfh;
        const denom = worked + sum.absent;
        return { days: out.reverse(), summary: { ...sum, pct: denom ? Math.round((worked / denom) * 100) : 0 } };
    }, [records, month, daysInMonth, year, mon, todayDay]);

    const dept = records.find(r => r.department_name)?.department_name?.trim();
    const visibleDays = hideOff ? days.filter(d => d.kind !== 'weekend') : days;
    const firstDow = new Date(year, mon - 1, 1).getDay();
    const weekOf = (day: number) => Math.ceil((day + firstDow) / 7);
    const weekLabel = (day: number, dow: number) => {
        const monday = Math.max(1, day - ((dow + 6) % 7));
        return `Week of ${new Date(year, mon - 1, monday).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    };

    return (
        <Sheet open={open} onOpenChange={o => { if (!o) onClose(); }}>
            <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
                <SheetHeader className="shrink-0 border-b border-border p-4">
                    <div className="flex items-center gap-3 pr-8">
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-sm font-black shadow-sm"
                            style={{ backgroundColor: deptColor(dept) + '1A', color: deptColor(dept) }}>
                            {initials(employeeName)}
                        </div>
                        <div className="min-w-0">
                            <SheetTitle className="truncate text-lg font-bold leading-tight">{employeeName ?? 'Timesheet'}</SheetTitle>
                            <SheetDescription className="truncate">
                                {dept ?? 'Monthly timesheet'}
                            </SheetDescription>
                        </div>
                    </div>
                </SheetHeader>

                <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
                {/* Month navigation */}
                <div className="flex items-center gap-1 rounded-xl border border-border bg-card p-1">
                    <Button variant="ghost" size="sm" onClick={() => shiftMonth(-1)} className="h-7 w-7 rounded-lg p-0"><ChevronLeft className="h-4 w-4" /></Button>
                    <span className="flex-1 text-center text-sm font-bold text-foreground">{monthLabel(month)}</span>
                    {!isCurrentMonth && (
                        <Button variant="ghost" size="sm" onClick={() => setMonth(maxMonth)} className="h-7 rounded-lg px-2 text-xs">This month</Button>
                    )}
                    <Button variant="ghost" size="sm" disabled={isCurrentMonth} onClick={() => shiftMonth(1)} className="h-7 w-7 rounded-lg p-0"><ChevronRight className="h-4 w-4" /></Button>
                </div>
                {/* Summary */}
                <div className="rounded-2xl border border-border bg-muted/30 p-4">
                    <div className="flex items-end justify-between gap-3">
                        <div>
                            <p className={cn('text-4xl font-black leading-none tabular-nums',
                                summary.pct >= 90 ? 'text-emerald-600' : summary.pct >= 75 ? 'text-amber-600' : 'text-rose-600')}>
                                {summary.pct}%
                            </p>
                            <p className="mt-1 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Attendance</p>
                        </div>
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Clock className="h-3.5 w-3.5" /><span className="font-semibold text-foreground">{fmtMins(summary.mins)}</span> worked
                        </p>
                    </div>
                    <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div className={cn('h-full rounded-full transition-all',
                            summary.pct >= 90 ? 'bg-emerald-500' : summary.pct >= 75 ? 'bg-amber-500' : 'bg-rose-500')}
                            style={{ width: `${summary.pct}%` }} />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        {([
                            ['Present', summary.present, 'bg-emerald-500'],
                            ['Late', summary.late, 'bg-amber-500'],
                            ['Absent', summary.absent, 'bg-rose-500'],
                            ['WFH', summary.wfh, 'bg-sky-500'],
                            ['Leave', summary.leave, 'bg-indigo-500'],
                        ] as const).map(([label, val, dot]) => (
                            <span key={label} className={cn('flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-1 text-[11px] font-semibold', val === 0 && 'opacity-50')}>
                                <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
                                <span className="tabular-nums text-foreground">{val}</span>
                                <span className="text-muted-foreground">{label}</span>
                            </span>
                        ))}
                    </div>
                </div>

                {/* Daily list */}
                <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Daily log</p>
                    <button
                        onClick={() => setHideOff(v => !v)}
                        className={cn('flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors',
                            hideOff ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground')}
                    >
                        <EyeOff className="h-3 w-3" /> Hide week-offs
                    </button>
                </div>
                <div className="space-y-1.5">
                    {loading ? (
                        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" /> Loading timesheet…
                        </div>
                    ) : visibleDays.length === 0 ? (
                        <p className="py-10 text-center text-sm text-muted-foreground">No records this month.</p>
                    ) : visibleDays.map((d, idx) => {
                        const meta = KIND_META[d.kind];
                        const isToday = d.day === todayDay;
                        const worked = d.kind === 'present' || d.kind === 'late' || d.kind === 'wfh';
                        const muted = d.kind === 'weekend' || d.kind === 'holiday';
                        const showWeek = idx === 0 || weekOf(visibleDays[idx - 1].day) !== weekOf(d.day);
                        return (
                          <React.Fragment key={d.day}>
                            {showWeek && (
                                <p className="px-1 pb-0.5 pt-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
                                    {weekLabel(d.day, d.dow)}
                                </p>
                            )}
                            <div
                                onClick={worked ? () => setExpandedDay(p => p === d.day ? null : d.day) : undefined}
                                className={cn('flex items-center gap-3 rounded-xl border px-3 py-2 transition-colors',
                                worked && 'cursor-pointer',
                                isToday ? 'border-primary/40 bg-primary/5'
                                : muted ? 'border-transparent bg-muted/30'
                                : 'border-border/60 hover:bg-accent/30',
                                expandedDay === d.day && 'border-primary/40 bg-primary/5')}>
                                <div className="w-10 shrink-0">
                                    <p className={cn('text-sm font-bold leading-none', muted ? 'text-muted-foreground' : 'text-foreground')}>{pad(d.day)}</p>
                                    <p className={cn('mt-0.5 text-[10px] font-medium', d.dow === 0 || d.dow === 6 ? 'text-rose-400' : 'text-muted-foreground')}>{d.weekday}</p>
                                </div>
                                <span className={cn('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-semibold', meta.cls)}>
                                    <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} />{meta.label}
                                </span>
                                {worked ? (
                                    <div className="flex flex-1 items-center justify-end gap-3 font-mono text-xs text-muted-foreground">
                                        <span className="flex items-center gap-1"><LogIn className="h-3 w-3 text-emerald-500" />{d.checkIn ?? '—'}</span>
                                        <span className="flex items-center gap-1"><LogOut className="h-3 w-3 text-blue-500" />{d.checkOut ?? '—'}</span>
                                        <span className="w-16 text-right font-sans font-bold text-foreground">{fmtMins(d.mins)}</span>
                                        <div className="flex w-[88px] shrink-0 justify-end gap-1">
                                            <PunchPhotoThumb photo={d.inPhoto} ring="ring-emerald-500/40" />
                                            <PunchPhotoThumb photo={d.outPhoto} ring="ring-blue-500/40" />
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex-1" />
                                )}
                            </div>
                            {worked && expandedDay === d.day && employeeId && (
                                <div className="ml-1 rounded-xl border border-border/60 bg-muted/20 px-3 py-2">
                                    <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">Time by location</p>
                                    <DwellTimeline
                                        employeeId={employeeId}
                                        date={`${month}-${pad(d.day)}`}
                                        accessToken={accessToken}
                                        scopeHeaders={scopeHeaders}
                                    />
                                </div>
                            )}
                          </React.Fragment>
                        );
                    })}
                </div>
                {!loading && (
                    <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
                        <CalendarCheck className="h-3 w-3" /> {monthLabel(month)} · most recent first
                    </p>
                )}
                </div>
            </SheetContent>
        </Sheet>
    );
};
