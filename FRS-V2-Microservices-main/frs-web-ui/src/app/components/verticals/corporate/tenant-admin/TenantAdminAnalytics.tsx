import React, { useEffect, useState, useMemo } from 'react';
import { Card, CardContent } from '../../../ui/card';
import { Button } from '../../../ui/button';
import { Loader2, BarChart3, Globe, Users } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import { getSiteTimezone } from '../../../../utils/timezone';
import { useAuth } from '../../../../contexts/AuthContext';
import { apiRequest } from '../../../../services/http/apiClient';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { toast } from 'sonner';
import { AttendanceHeatmap } from '../../../shared/AttendanceHeatmap';
import { PageHeader } from '../../../shared/PageHeader';
import { cn } from '../../../ui/utils';
import { lightTheme } from '../../../../../theme/lightTheme';

import { useLiveData } from '../../../../hooks/useLiveData';
import { AttendanceTable } from '../hr/AttendanceTable';

interface AttendancePoint { date: string; present: number; checked_out?: number; }
interface SiteActivity { site: string; employee_count: number; device_count: number; }

interface Analytics {
  attendanceLast30: AttendancePoint[];
  siteActivity: SiteActivity[];
}

const CustomXAxisTick = (props: any) => {
  const { x, y, payload } = props;
  try {
    const [datePart, weekday] = String(payload.value).split('|');
    return (
      <g transform={`translate(${x},${y})`}>
        <text
          x={0}
          y={0}
          dy={12}
          textAnchor="middle"
          fill="currentColor"
          className="text-[9px] font-bold opacity-60 text-slate-500 dark:text-slate-400"
        >
          <tspan x={0} dy="0">{datePart}</tspan>
          <tspan x={0} dy="10">({weekday})</tspan>
        </text>
      </g>
    );
  } catch (err) {
    return null;
  }
};

export const TenantAdminAnalytics: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const { employees, attendance } = useLiveData();
  const [isLargeScreen, setIsLargeScreen] = useState(true);

  useEffect(() => {
    const handleResize = () => {
      setIsLargeScreen(window.innerWidth >= 1024);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const [page, setPage] = useState(1);
  const PER_PAGE = 5;

  useEffect(() => {
    setPage(1);
  }, [data]);

  const last30Days = useMemo(() => {
    const tz = getSiteTimezone() || 'UTC';
    const dates = [];
    const today = new Date();
    
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(today.getDate() - i);
      
      const year = new Intl.DateTimeFormat('en', { timeZone: tz, year: 'numeric' }).format(d);
      const month = new Intl.DateTimeFormat('en', { timeZone: tz, month: '2-digit' }).format(d);
      const day = new Intl.DateTimeFormat('en', { timeZone: tz, day: '2-digit' }).format(d);
      const dateStr = `${year}-${month}-${day}`;
      
      const weekdayLong = new Intl.DateTimeFormat('en', { timeZone: tz, weekday: 'long' }).format(d);
      const weekdayShort = new Intl.DateTimeFormat('en', { timeZone: tz, weekday: 'short' }).format(d);
      
      dates.push({
        dateStr,
        weekdayLong,
        weekdayShort,
      });
    }
    return dates;
  }, []);

  const chartData = useMemo(() => {
    if (!data?.attendanceLast30) return [];
    const valMap = new Map<string, { present: number; checked_out: number }>();
    data.attendanceLast30.forEach((r: any) => {
      const key = String(r.date).trim();
      valMap.set(key, {
        present: Number(r.present) || 0,
        checked_out: Number(r.checked_out) || 0,
      });
    });

    return last30Days.map(({ dateStr, weekdayLong, weekdayShort }) => {
      const d = new Date(dateStr + 'T00:00:00');
      const day = d.getDate();
      const month = d.toLocaleDateString('en', { month: 'short' });
      const record = valMap.get(dateStr);
      return {
        date: dateStr,
        formattedTick: `${day} ${month}|${weekdayShort}`,
        dayName: weekdayLong,
        dayNameShort: weekdayShort,
        present: record?.present ?? 0,
        checked_out: record?.checked_out ?? 0,
      };
    });
  }, [data?.attendanceLast30, last30Days]);

  const maxPresent = useMemo(() => {
    if (chartData.length === 0) return 1;
    return Math.max(...chartData.map(d => d.present), 1);
  }, [chartData]);

  useEffect(() => {
    apiRequest<Analytics>('/tenant-admin/analytics', { accessToken, scopeHeaders })
      .then(setData)
      .catch(() => toast.error('Failed to load analytics'))
      .finally(() => setLoading(false));
  }, [accessToken]);

  if (loading) {
    return <div className="flex justify-center h-48 items-center"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  }



  const siteActivity = data?.siteActivity ?? [];
  const total = siteActivity.length;
  const totalPages = Math.ceil(total / PER_PAGE);
  const pagedList = siteActivity.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        icon={BarChart3}
        subtitle="Last 30 days of activity"
      />

      {/* Interactive Attendance Heatmap */}
      {chartData.length > 0 && (
        <div className="glass-card rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm p-4">
          <AttendanceHeatmap 
            data={chartData}
            title="Attendance Punch Density (Last 30 Days)"
            maxEmployees={maxPresent}
          />
        </div>
      )}

      {/* Site activity table */}
      <Card className={cn('border shadow-sm', lightTheme.border.default)}>
        <CardContent className="p-6">
          <div className="flex items-center gap-2 mb-4">
            <Globe className="w-4 h-4 text-emerald-500" />
            <h2 className={cn('font-semibold', lightTheme.text.primary)}>Site Activity</h2>
          </div>
          {siteActivity.length ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className={cn('border-b', lightTheme.table.border)}>
                      <th className={cn('text-left py-2 font-medium', lightTheme.text.secondary)}>Site</th>
                      <th className={cn('text-center py-2 font-medium', lightTheme.text.secondary)}>Employees</th>
                      <th className={cn('text-center py-2 font-medium', lightTheme.text.secondary)}>Devices</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedList.map(s => (
                      <tr key={s.site} className={cn('border-b', lightTheme.table.border, lightTheme.table.rowHover)}>
                        <td className={cn('py-2.5 font-medium', lightTheme.text.primary)}>{s.site}</td>
                        <td className={cn('py-2.5 text-center', lightTheme.text.secondary)}>{s.employee_count}</td>
                        <td className={cn('py-2.5 text-center', lightTheme.text.secondary)}>{s.device_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {total > PER_PAGE && (
                <div className="flex items-center justify-between p-3 border-t border-slate-200/10 bg-slate-50 dark:bg-slate-800 rounded-b-lg mt-4">
                  <p className="text-xs text-slate-500 font-medium">
                    Showing {Math.min((page - 1) * PER_PAGE + 1, total)}–{Math.min(page * PER_PAGE, total)} of {total} entries
                  </p>
                  <div className="flex gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                      disabled={page === 1}
                      className="h-8 text-xs rounded-lg font-bold"
                    >
                      Prev
                    </Button>
                    {Array.from({ length: totalPages }).map((_, idx: number) => (
                      <Button
                        key={idx + 1}
                        variant={page === idx + 1 ? "default" : "outline"}
                        size="sm"
                        onClick={() => setPage(idx + 1)}
                        className="h-8 text-xs font-bold rounded-lg"
                      >
                        {idx + 1}
                      </Button>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                      disabled={page >= totalPages}
                      className="h-8 text-xs rounded-lg font-bold"
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className={cn('text-sm text-center py-8', lightTheme.text.muted)}>No site data available</p>
          )}
        </CardContent>
      </Card>

      {/* Today's Attendance Table */}
      <Card className={cn('border shadow-sm', lightTheme.border.default)}>
        <CardContent className="p-0">
          <AttendanceTable employees={employees} attendanceRecords={attendance} />
        </CardContent>
      </Card>
    </div>
  );
};
