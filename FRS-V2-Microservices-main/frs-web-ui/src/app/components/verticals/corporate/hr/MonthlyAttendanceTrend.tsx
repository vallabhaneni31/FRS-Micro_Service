import { getSiteTimezone } from '../../../../utils/timezone';
import React, { useState, useEffect } from 'react';
import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { cn } from '../../../ui/utils';
import { useAuth } from '../../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { apiRequest } from '../../../../services/http/apiClient';

interface DayPoint {
    day:    string;   // "01", "02", …
    date:   string;   // YYYY-MM-DD
    rate:   number;   // 0–100
    present: number;
    total:  number;
}

interface Props {
    target?:    number;
    className?: string;
}

const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload as DayPoint;
    return (
        <div className="bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-xl shadow-lg px-3 py-2 text-xs">
            <p className="font-semibold text-slate-700 dark:text-slate-300 mb-1">Day {label}</p>
            <p className="text-indigo-600 dark:text-indigo-400 font-bold">{d.rate}% attendance</p>
            <p className="text-slate-500 dark:text-slate-400">{d.present} / {d.total} present</p>
        </div>
    );
};

export const MonthlyAttendanceTrend: React.FC<Props> = ({
    target = 90,
    className,
}) => {
    const { accessToken, isAuthenticated } = useAuth();
    const scopeHeaders = useScopeHeaders();
    const [data, setData] = useState<DayPoint[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!isAuthenticated) return;
        let isMounted = true;
        
        const fetchData = async () => {
            setLoading(true);
            try {
                const now = new Date();
                const year = now.getFullYear();
                const month = now.getMonth() + 1;
                const tz = getSiteTimezone();
                const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);

                const res = await apiRequest<{ data: any[] }>(
                    `/live/calendar?year=${year}&month=${month}`,
                    { accessToken, scopeHeaders }
                );
                
                if (isMounted && res?.data) {
                    const points: DayPoint[] = [];
                    for (const d of res.data) {
                        if (d.date_str > today) break; // don't project future
                        points.push({
                            day: d.date_str.slice(8, 10),
                            date: d.date_str,
                            rate: Number(d.rate) || 0,
                            present: Number(d.present) || 0,
                            total: Number(d.total) || 0,
                        });
                    }
                    setData(points);
                }
            } catch (err) {
                console.error("Failed to fetch monthly trend data", err);
            } finally {
                if (isMounted) setLoading(false);
            }
        };

        fetchData();
        const timer = setInterval(fetchData, 60000);
        return () => {
            isMounted = false;
            clearInterval(timer);
        };
    }, [accessToken, isAuthenticated, scopeHeaders]);

    const monthName = new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const avg = data.length ? Math.round(data.reduce((s, d) => s + d.rate, 0) / data.length) : 0;

    return (
        <div className={cn('glass-card rounded-2xl border border-white/50 dark:border-white/10 shadow-sm p-5', className)}>
            <div className="flex items-center justify-between mb-4">
                <div>
                    <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                        Monthly Trend — {monthName}
                    </h3>
                    <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                        Avg {avg}% · Target {target}%
                    </p>
                </div>
                <div className={cn(
                    'px-2.5 py-1 rounded-lg text-xs font-semibold',
                    avg >= target 
                        ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400' 
                        : 'bg-rose-50 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400'
                )}>
                    {avg >= target ? 'On track' : 'Below target'}
                </div>
            </div>

            {loading && data.length === 0 ? (
                <div className="flex items-center justify-center h-40 text-slate-400 text-sm">
                    Loading...
                </div>
            ) : data.length < 2 ? (
                <div className="flex items-center justify-center h-40 text-slate-400 text-sm">
                    Not enough data for this month yet
                </div>
            ) : (
                <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={data} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                        <XAxis
                            dataKey="day"
                            tick={{ fontSize: 11, fill: '#94a3b8' }}
                            tickLine={false}
                            axisLine={false}
                            interval="preserveStartEnd"
                        />
                        <YAxis
                            domain={[0, 100]}
                            tick={{ fontSize: 11, fill: '#94a3b8' }}
                            tickLine={false}
                            axisLine={false}
                            tickFormatter={v => `${v}%`}
                        />
                        <Tooltip content={<CustomTooltip />} />
                        <ReferenceLine
                            y={target}
                            stroke="#6366f1"
                            strokeDasharray="4 4"
                            strokeWidth={1.5}
                            label={{ value: `${target}%`, position: 'right', fontSize: 10, fill: '#6366f1' }}
                        />
                        <Line
                            type="monotone"
                            dataKey="rate"
                            stroke="#22c55e"
                            strokeWidth={2}
                            dot={false}
                            activeDot={{ r: 4, fill: '#22c55e' }}
                        />
                    </LineChart>
                </ResponsiveContainer>
            )}
        </div>
    );
};
