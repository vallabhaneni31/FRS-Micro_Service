import React, { useEffect, useMemo, useState } from 'react';
import {
    BarChart, Bar, PieChart, Pie, Cell,
    XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '../../../ui/card';
import { cn } from '../../../ui/utils';
import { Loader2, Building2, Trophy, Clock, PieChart as PieIcon } from 'lucide-react';
import { apiRequest } from '../../../../services/http/apiClient';
import { formatYmdInSiteTz } from '../../../../utils/timezone';
import { lightTheme } from '../../../../../theme/lightTheme';

interface Props {
    employees: any[];
    accessToken: string | null;
    scopeHeaders: Record<string, string>;
    selectedDate: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const cleanDept = (d?: string | null) => ((d ?? '').trim() || '—');
const monthShort = (ym: string) => {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short' });
};
const pctTone = (p: number) => p >= 90 ? 'text-emerald-600' : p >= 75 ? 'text-amber-600' : 'text-rose-600';

type Bucket = { worked: number; late: number; absent: number; wfh: number; leave: number };
const newBucket = (): Bucket => ({ worked: 0, late: 0, absent: 0, wfh: 0, leave: 0 });
const attendancePct = (b: Bucket) => {
    const denom = b.worked + b.late + b.absent;
    return denom ? Math.round(((b.worked + b.late) / denom) * 100) : 0;
};
const addStatus = (b: Bucket, status: string, late: boolean) => {
    if (status === 'wfh' || status === 'work-from-home') { b.worked++; b.wfh++; }
    else if (status === 'leave' || status === 'on-leave') b.leave++;
    else if (status === 'absent') b.absent++;
    else if (status === 'late' || late) b.late++;
    else if (status === 'holiday' || status === 'weekend') { /* neutral */ }
    else b.worked++;
};

const PIE_COLORS: Record<string, string> = { Present: '#10b981', Late: '#f59e0b', Absent: '#ef4444', WFH: '#0ea5e9', Leave: '#6366f1' };

export const AttendanceAnalytics: React.FC<Props> = ({ employees, accessToken, scopeHeaders, selectedDate }) => {
    const [records, setRecords] = useState<any[]>([]);
    const [deptDwellSummary, setDeptDwellSummary] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);

    const curMonth = selectedDate.slice(0, 7);

    // Fetch the trailing 6 months once, plus monthly dwell summary for zone breakdown.
    useEffect(() => {
        const [y, m] = curMonth.split('-').map(Number);
        const start = new Date(y, m - 1 - 5, 1);
        const from = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-01`;
        const daysInMon = new Date(y, m, 0).getDate();
        const monthFrom = `${curMonth}-01`;
        const monthTo = `${curMonth}-${pad(daysInMon)}`;

        setLoading(true);
        Promise.allSettled([
            apiRequest<{ data: any[] }>(`/live/attendance?fromDate=${from}&toDate=${selectedDate}&limit=20000`, { accessToken, scopeHeaders, noCache: true }),
            apiRequest<{ departments: any[] }>(`/attendance/dwell-summary?fromDate=${monthFrom}&toDate=${monthTo}`, { accessToken, scopeHeaders, noCache: true })
        ]).then(([attRes, dwellRes]) => {
            if (attRes.status === 'fulfilled') setRecords(attRes.value?.data ?? []);
            else setRecords([]);
            if (dwellRes.status === 'fulfilled') setDeptDwellSummary(dwellRes.value?.departments ?? []);
            else setDeptDwellSummary([]);
        }).finally(() => setLoading(false));
    }, [accessToken, curMonth, selectedDate]);

    const analytics = useMemo(() => {
        const norm = (r: any) => {
            const ds: string = formatYmdInSiteTz(r.attendance_date);
            return { ds, month: ds?.slice(0, 7), dow: new Date(ds + 'T00:00:00').getDay(), status: r.status as string, late: (r.is_late_computed ?? r.is_late) === true, dept: cleanDept(r.department_name), id: String(r.fk_employee_id), name: r.full_name };
        };
        const rows = records.map(norm).filter(r => r.ds);
        const recordKey = (empId: string, date: string) => `${empId}_${date}`;

        // ── Month-over-month trend (6 months) ──
        const [y, m] = curMonth.split('-').map(Number);
        const months: string[] = Array.from({ length: 6 }, (_, i) => {
            const d = new Date(y, m - 1 - (5 - i), 1);
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
        });
        const monthBuckets = new Map<string, Bucket>(months.map(mm => [mm, newBucket()]));
        
        // Populate existing trend statuses
        rows.forEach(r => {
            const b = monthBuckets.get(r.month);
            if (b) addStatus(b, r.status, r.late);
        });

        // Add historical synthetic absent days for the trend
        const allUniqueDates = Array.from(new Set(rows.map(r => r.ds)));
        const allExistingKeys = new Set(rows.map(r => recordKey(r.id, r.ds)));
        allUniqueDates.forEach(d => {
            const monthStr = d.slice(0, 7);
            const b = monthBuckets.get(monthStr);
            if (!b) return;
            employees.forEach(e => {
                if (e.status !== 'active') return;
                if (e.join_date) {
                    const jd = e.join_date.includes('T') ? e.join_date.slice(0, 10) : e.join_date;
                    if (jd > d) return;
                }
                const empId = String(e.pk_employee_id);
                if (!allExistingKeys.has(recordKey(empId, d))) {
                    addStatus(b, 'absent', false);
                }
            });
        });

        const trend = months.map(mm => ({ month: monthShort(mm), pct: attendancePct(monthBuckets.get(mm)!) }));

        // ── Current-month aggregates ──
        const cur = rows.filter(r => r.month === curMonth);
        const deptMap = new Map<string, Bucket>();
        const empMap = new Map<string, { name: string; b: Bucket }>();
        const mix = newBucket();

        // Populate existing current-month statuses
        cur.forEach(r => {
            if (!deptMap.has(r.dept)) deptMap.set(r.dept, newBucket());
            addStatus(deptMap.get(r.dept)!, r.status, r.late);
            if (!empMap.has(r.id)) empMap.set(r.id, { name: r.name, b: newBucket() });
            addStatus(empMap.get(r.id)!.b, r.status, r.late);
            addStatus(mix, r.status, r.late);
        });

        // Add current-month synthetic absent days across working days up to selected date
        const [cy, cm] = curMonth.split('-').map(Number);
        const maxDay = selectedDate.startsWith(curMonth) ? Number(selectedDate.slice(8, 10)) : new Date(cy, cm, 0).getDate();
        const workingDays: string[] = [];
        for (let d = 1; d <= maxDay; d++) {
            const dateStr = `${curMonth}-${pad(d)}`;
            const dow = new Date(cy, cm - 1, d).getDay();
            if (dow !== 0 && dow !== 6) workingDays.push(dateStr);
        }

        const curExistingKeys = new Set(cur.map(r => recordKey(r.id, r.ds)));
        workingDays.forEach(d => {
            employees.forEach(e => {
                if (e.status !== 'active') return;
                if (e.join_date) {
                    const jd = e.join_date.includes('T') ? e.join_date.slice(0, 10) : e.join_date;
                    if (jd > d) return;
                }
                const empId = String(e.pk_employee_id);
                if (!curExistingKeys.has(recordKey(empId, d))) {
                    const dept = cleanDept(e.department_name);
                    if (!deptMap.has(dept)) deptMap.set(dept, newBucket());
                    addStatus(deptMap.get(dept)!, 'absent', false);

                    if (!empMap.has(empId)) empMap.set(empId, { name: e.full_name, b: newBucket() });
                    addStatus(empMap.get(empId)!.b, 'absent', false);

                    addStatus(mix, 'absent', false);
                }
            });
        });

        const byDept = [...deptMap.entries()]
            .map(([dept, b]) => {
                const present = attendancePct(b);
                const absent = 100 - present;
                return { dept, present, absent };
            })
            .sort((a, b) => b.present - a.present)
            .map((item, idx) => ({
                ...item,
                indexedDept: `${idx + 1}. ${item.dept}`
            }));

        const emps = [...empMap.values()].map(e => {
            const present = e.b.worked, late = e.b.late, total = present + late;
            return { name: e.name, late, onTime: total ? Math.round((present / total) * 100) : 0, pct: attendancePct(e.b) };
        });
        const topPunctual = [...emps].sort((a, b) => b.onTime - a.onTime || b.pct - a.pct).slice(0, 5);
        const mostLate = [...emps].filter(e => e.late > 0).sort((a, b) => b.late - a.late).slice(0, 5);

        const mixData = [
            { name: 'Present', value: mix.worked - mix.wfh },
            { name: 'Late', value: mix.late },
            { name: 'Absent', value: mix.absent },
            { name: 'WFH', value: mix.wfh },
            { name: 'Leave', value: mix.leave },
        ].filter(d => d.value > 0);

        return { trend, byDept, topPunctual, mostLate, mixData };
    }, [records, curMonth, selectedDate, employees]);

    const fmtMins = (m?: number | null) => {
        if (!m || m <= 0) return '0m';
        const hh = Math.floor(m / 60), mm = m % 60;
        return hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
    };

    const deptZoneSummary = useMemo(() => {
        const deptEmpCounts = new Map<string, number>();
        employees.forEach(e => {
            if (e.status === 'active') {
                const d = cleanDept(e.department_name);
                deptEmpCounts.set(d, (deptEmpCounts.get(d) || 0) + 1);
            }
        });

        if (deptDwellSummary && deptDwellSummary.length > 0) {
            const map = new Map<string, any>();
            deptDwellSummary.forEach((d: any) => {
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
        return [];
    }, [deptDwellSummary, employees]);

    if (loading && records.length === 0) {
        return (
            <div className="flex items-center justify-center gap-3 py-24">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <span className="text-sm text-muted-foreground">Crunching analytics…</span>
            </div>
        );
    }

    const card = cn(lightTheme.card, lightTheme.border.card);

    return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">

            {/* By department attendance rate */}
            <Card className={card}>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base font-bold">
                        <Building2 className="h-4 w-4 text-primary" /> Attendance Rate by Department
                        <span className="ml-1 text-xs font-normal text-muted-foreground">{monthShort(curMonth)}</span>
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <ResponsiveContainer width="100%" height={Math.max(160, analytics.byDept.length * 45)}>
                        <BarChart data={analytics.byDept} layout="vertical" margin={{ top: 0, right: 16, left: 8, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" className="stroke-border" horizontal={false} />
                            <XAxis type="number" domain={[0, 100]} tickFormatter={(v) => `${v}%`} tickLine={false} axisLine={false} className="text-xs" />
                            <YAxis type="category" dataKey="indexedDept" width={140} tickLine={false} axisLine={false} className="text-xs" />
                            <Tooltip cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
                                content={({ active, payload }: any) => active && payload?.length ? (
                                    <div className="rounded-xl border border-border bg-card p-2.5 text-xs shadow-md space-y-1">
                                        <p className="font-bold text-foreground">{payload[0].payload.dept}</p>
                                        <p className="text-emerald-600 font-semibold">Present: <span className="font-normal text-foreground">{payload[0].payload.present}%</span></p>
                                        <p className="text-rose-600 font-semibold">Absent: <span className="font-normal text-foreground">{payload[0].payload.absent}%</span></p>
                                    </div>
                                ) : null}
                            />
                            <Legend verticalAlign="top" align="right" height={36} iconType="circle" wrapperStyle={{ fontSize: 12, paddingBottom: 10 }} />
                            <Bar dataKey="present" fill="#10b981" radius={[0, 5, 5, 0]} name="Present" maxBarSize={12} />
                            <Bar dataKey="absent" fill="#ef4444" radius={[0, 5, 5, 0]} name="Absent" maxBarSize={12} />
                        </BarChart>
                    </ResponsiveContainer>
                </CardContent>
            </Card>

            {/* Department Time by Zone */}
            <Card className={card}>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base font-bold">
                        <Clock className="h-4 w-4 text-primary" /> Department · Time by Zone
                        <span className="ml-1 text-xs font-normal text-muted-foreground">{monthShort(curMonth)}</span>
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    {deptZoneSummary.length > 0 ? (
                        <div className="space-y-3">
                            {deptZoneSummary.map((d: any) => {
                                const tot = d.totalMinutes || 1;
                                const seg = (z: string, cls: string) => (d.totalsByZone?.[z] ?? 0) > 0 && (
                                    <div key={z} className={cls} style={{ width: `${((d.totalsByZone[z] || 0) / tot) * 100}%` }} title={`${z}: ${fmtMins(d.totalsByZone[z])}`} />
                                );
                                return (
                                    <div key={d.department} className="flex items-center gap-3">
                                        <div className="w-36 shrink-0 truncate text-xs font-semibold text-foreground" title={d.department}>
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
                            <div className="mt-3 flex flex-wrap gap-3 pt-1 text-[10px] text-muted-foreground">
                                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> Work</span>
                                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500" /> Break</span>
                                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-sky-500" /> Other</span>
                                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-slate-400" /> Unassigned</span>
                                <span className="ml-auto">% = avg productivity</span>
                            </div>
                        </div>
                    ) : (
                        <p className="py-12 text-center text-xs text-muted-foreground">No zone activity recorded for this period.</p>
                    )}
                </CardContent>
            </Card>

            {/* Status mix */}
            <Card className={card}>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base font-bold">
                        <PieIcon className="h-4 w-4 text-primary" /> Status Mix
                        <span className="ml-1 text-xs font-normal text-muted-foreground">{monthShort(curMonth)} · man-days</span>
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="flex items-center gap-4">
                        <ResponsiveContainer width="55%" height={200}>
                            <PieChart>
                                <Pie data={analytics.mixData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2}>
                                    {analytics.mixData.map((d) => <Cell key={d.name} fill={PIE_COLORS[d.name]} />)}
                                </Pie>
                                <Tooltip content={({ active, payload }: any) => active && payload?.length ? (
                                    <div className="rounded-xl border border-border bg-card p-2 text-xs shadow-md">
                                        <span className="font-semibold text-foreground">{payload[0].name}</span>: {payload[0].value} days
                                    </div>
                                ) : null} />
                            </PieChart>
                        </ResponsiveContainer>
                        <div className="flex-1 space-y-1.5">
                            {analytics.mixData.map(d => (
                                <div key={d.name} className="flex items-center gap-2 text-sm">
                                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: PIE_COLORS[d.name] }} />
                                    <span className="text-muted-foreground">{d.name}</span>
                                    <span className="ml-auto font-semibold tabular-nums text-foreground">{d.value}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Leaderboards */}
            <Card className={cn(card, 'lg:col-span-2')}>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base font-bold">
                        <Trophy className="h-4 w-4 text-primary" /> Punctuality Leaderboard
                        <span className="ml-1 text-xs font-normal text-muted-foreground">{monthShort(curMonth)}</span>
                    </CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                    <div>
                        <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-emerald-600"><Trophy className="h-3.5 w-3.5" /> Most punctual</p>
                        <div className="space-y-1">
                            {analytics.topPunctual.map((e, i) => (
                                <div key={e.name} className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-1.5">
                                    <span className="w-4 text-center text-xs font-bold text-muted-foreground">{i + 1}</span>
                                    <span className="flex-1 truncate text-sm font-medium text-foreground">{e.name}</span>
                                    <span className={cn('text-sm font-bold tabular-nums', pctTone(e.onTime))}>{e.onTime}%</span>
                                </div>
                            ))}
                            {analytics.topPunctual.length === 0 && <p className="text-xs text-muted-foreground">No data.</p>}
                        </div>
                    </div>
                    <div>
                        <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-amber-600"><Clock className="h-3.5 w-3.5" /> Most late arrivals</p>
                        <div className="space-y-1">
                            {analytics.mostLate.map((e, i) => (
                                <div key={e.name} className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-1.5">
                                    <span className="w-4 text-center text-xs font-bold text-muted-foreground">{i + 1}</span>
                                    <span className="flex-1 truncate text-sm font-medium text-foreground">{e.name}</span>
                                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-bold text-amber-600">{e.late} late</span>
                                </div>
                            ))}
                            {analytics.mostLate.length === 0 && <p className="text-xs text-muted-foreground">No late arrivals 🎉</p>}
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
};
