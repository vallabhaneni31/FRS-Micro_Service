import React from 'react';
import { TrendingUp, TrendingDown, Minus, UserCheck, UserX, Clock, Users, AlertTriangle } from 'lucide-react';
import { cn } from '../../../ui/utils';

interface Props {
    presentCount:   number;
    lateCount:      number;
    absentCount:    number;
    totalActive:    number;
    /** Pre-computed rate from API (0–100). Derived from counts if omitted. */
    attendanceRate?: number;
    /** Rate from yesterday for trend arrow. */
    previousRate?:  number;
    error?:          string | null;
    className?:     string;
}

interface KpiTileProps {
    label: string;
    value: React.ReactNode;
    icon: React.FC<{ className?: string }>;
    colorClass: string;
}

const KpiTile: React.FC<KpiTileProps> = ({ label, value, icon: Icon, colorClass }) => (
    <div className="flex items-center gap-3 px-4 py-3 flex-1 min-w-0">
        <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0', colorClass)}>
            <Icon className="w-4.5 h-4.5" />
        </div>
        <div className="min-w-0">
            <div className="text-xl font-bold text-slate-800 dark:text-white leading-none">{value}</div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">{label}</p>
        </div>
    </div>
);

export const AttendanceKpiBar: React.FC<Props> = ({
    presentCount,
    lateCount,
    absentCount,
    totalActive,
    attendanceRate: apiRate,
    previousRate,
    error,
    className,
}) => {
    const calculatedRate = totalActive > 0 ? Math.round(((presentCount + lateCount) / totalActive) * 100) : 0;
    const rate = Math.min(100, apiRate ?? calculatedRate);
    const delta = previousRate != null ? rate - previousRate : null;

    const TrendIcon = delta == null ? null : delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
    const trendColor = delta == null ? '' : delta > 0 ? 'text-emerald-600' : delta < 0 ? 'text-rose-500' : 'text-slate-400';

    const barColor = rate >= 90 ? 'bg-emerald-500'
                   : rate >= 75 ? 'bg-amber-400'
                   : 'bg-rose-400';

    return (
        <div className={cn(
            'glass-card rounded-2xl border border-slate-100 dark:border-white/10 shadow-sm overflow-hidden',
            className
        )}>
            {error && (
                <div className="bg-rose-500/10 border-b border-rose-500/20 text-rose-600 dark:text-rose-400 px-4 py-2 flex items-center gap-2 text-xs font-semibold">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-rose-500" />
                    <span>{error}</span>
                </div>
            )}
            {/* Attendance rate strip */}
            <div className="px-4 pt-3 pb-1 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">Attendance Rate</span>
                    {error ? (
                        <span className="text-xs font-bold text-rose-500 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> N/A</span>
                    ) : (
                        <span className="text-2xl font-black text-slate-800 dark:text-white">{rate}%</span>
                    )}
                    {!error && TrendIcon && (
                        <span className={cn('flex items-center gap-0.5 text-xs font-medium', trendColor)}>
                            <TrendIcon className="w-3.5 h-3.5" />
                            {Math.abs(delta!)}%
                        </span>
                    )}
                </div>
                <span className="text-xs text-slate-400 dark:text-slate-500">{totalActive} active employees</span>
            </div>

            {/* Progress bar */}
            <div className="mx-4 mb-3 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                <div
                    className={cn('h-full rounded-full transition-all duration-700', error ? 'bg-rose-400 opacity-40' : barColor)}
                    style={{ width: `${error ? 100 : rate}%` }}
                />
            </div>

            {/* Divider */}
            <div className="border-t border-slate-100 dark:border-white/10 flex divide-x divide-slate-100 dark:divide-white/10">
                <KpiTile label="Present"       value={error ? <span className="text-xs text-rose-500 font-bold">N/A</span> : presentCount} icon={UserCheck} colorClass="bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400" />
                <KpiTile label="Late Arrivals" value={error ? <span className="text-xs text-rose-500 font-bold">N/A</span> : lateCount}    icon={Clock}     colorClass="bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400"    />
                <KpiTile label="Not In Yet"    value={error ? <span className="text-xs text-rose-500 font-bold">N/A</span> : absentCount}  icon={UserX}     colorClass="bg-rose-50 dark:bg-rose-950/30 text-rose-500 dark:text-rose-400"      />
                <KpiTile label="Total Active"  value={totalActive}  icon={Users}     colorClass="bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400"      />
            </div>
        </div>
    );
};
