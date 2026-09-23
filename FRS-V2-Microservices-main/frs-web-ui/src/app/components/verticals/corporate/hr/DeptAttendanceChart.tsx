import React, { useState, useEffect } from 'react';
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, Cell, Legend,
} from 'recharts';
import { Loader2 } from 'lucide-react';
import { cn } from '../../../ui/utils';
import { apiRequest } from '../../../../services/http/apiClient';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';

type Range = '7d' | '30d';

interface DeptStat {
    department: string;
    present:    number;
    late:       number;
    absent:     number;
    total:      number;
    rate:       number;
}

const COLORS = { present: '#22c55e', late: '#f59e0b', absent: '#ef4444' };

function buildFromAttendance(attendance: any[], employees: any[], days: number): DeptStat[] {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const recent = attendance.filter((a: any) => new Date(a.attendance_date) >= cutoff);

    const deptMap = new Map<string, { present: number; late: number; absent: number; total: number }>();
    employees.forEach((e: any) => {
        const d = e.department_name || 'Unassigned';
        if (!deptMap.has(d)) deptMap.set(d, { present: 0, late: 0, absent: 0, total: 0 });
    });

    recent.forEach((r: any) => {
        const emp = employees.find((e: any) => e.pk_employee_id === r.fk_employee_id);
        const d = emp?.department_name || 'Unassigned';
        const entry = deptMap.get(d) ?? { present: 0, late: 0, absent: 0, total: 0 };
        if (r.status === 'late') entry.late++;
        else entry.present++;
        entry.total++;
        deptMap.set(d, entry);
    });

    return Array.from(deptMap.entries())
        .map(([department, s]) => ({
            department,
            ...s,
            rate: s.total > 0 ? Math.round(((s.present + s.late) / s.total) * 100) : 0,
        }))
        .filter(d => d.total > 0)
        .sort((a, b) => b.total - a.total)
        .slice(0, 8);
}

interface Props {
    attendance: any[];
    employees:  any[];
    className?: string;
}

export const DeptAttendanceChart: React.FC<Props> = ({ attendance, employees, className }) => {
    const [range, setRange] = useState<Range>('7d');

    const data = buildFromAttendance(attendance, employees, range === '7d' ? 7 : 30);

    const CustomTooltip = ({ active, payload, label }: any) => {
        if (!active || !payload?.length) return null;
        return (
            <div className="bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-xl shadow-lg px-3 py-2 text-xs">
                <p className="font-semibold text-slate-700 dark:text-slate-300 mb-1">{label}</p>
                {payload.map((p: any) => (
                    <p key={p.name} style={{ color: p.fill }} className="capitalize">
                        {p.name}: {p.value}
                    </p>
                ))}
            </div>
        );
    };

    return (
        <div className={cn('glass-card rounded-2xl border border-white/50 dark:border-white/10 shadow-sm p-5', className)}>
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                    Department Attendance
                </h3>
                <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 rounded-lg p-0.5">
                    {(['7d', '30d'] as Range[]).map(r => (
                        <button
                            key={r}
                            onClick={() => setRange(r)}
                            className={cn(
                                'px-3 py-1 rounded-md text-xs font-medium transition-colors',
                                range === r
                                    ? 'bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 shadow-sm'
                                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                            )}
                        >
                            {r === '7d' ? '7 days' : '30 days'}
                        </button>
                    ))}
                </div>
            </div>

            {data.length === 0 ? (
                <div className="flex items-center justify-center h-48 text-slate-400 text-sm">
                    No attendance data for this period
                </div>
            ) : (
                <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={data} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-slate-100 dark:text-slate-800" vertical={false} />
                        <XAxis
                            dataKey="department"
                            tick={{ fontSize: 11, fill: '#94a3b8' }}
                            tickLine={false}
                            axisLine={false}
                        />
                        <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                        <Tooltip content={<CustomTooltip />} cursor={{ fill: '#f8fafc' }} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Bar dataKey="present" name="Present" fill={COLORS.present} radius={[3, 3, 0, 0]} stackId="a" />
                        <Bar dataKey="late"    name="Late"    fill={COLORS.late}    radius={[0, 0, 0, 0]} stackId="a" />
                        <Bar dataKey="absent"  name="Absent"  fill={COLORS.absent}  radius={[3, 3, 0, 0]} stackId="a" />
                    </BarChart>
                </ResponsiveContainer>
            )}
        </div>
    );
};
