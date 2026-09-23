import React, { useEffect, useState } from 'react';
import { apiRequest } from '../../../../services/http/apiClient';
import { useAuth } from '../../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { Card, CardContent, CardHeader, CardTitle } from '../../../ui/card';
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { AnalyticsData } from '../../../../types';
import { cn } from '../../../ui/utils';
import { lightTheme } from '../../../../../theme/lightTheme';

interface AnalyticsChartsProps {
  analytics: AnalyticsData;
  detailed?: boolean;
}

export const AnalyticsCharts: React.FC<AnalyticsChartsProps> = ({
  analytics,
  detailed = false,
}) => {
  const { accessToken , isAuthenticated } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [liveData, setLiveData] = useState<any[]>([]);

  useEffect(() => {
    if (!isAuthenticated) return;
    apiRequest('/live/trends/monthly', { accessToken, scopeHeaders })
      .then((res: any) => { if (res?.data) setLiveData(res.data); })
      .catch(() => null);
  }, [accessToken]);

  const chartData = liveData.length > 0 ? liveData : (analytics?.attendanceTrends || []);

  return (
    <div className="space-y-6">
      {/* Attendance Trends */}
      <Card className={cn(lightTheme.background.card, lightTheme.border.default, "dark:bg-slate-900 dark:border-border")}>
        <CardHeader>
          <CardTitle className={cn(lightTheme.text.primary, "dark:text-white")}>Attendance Trends (Last 30 Days)</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={chartData} margin={{ top: 20, right: 10, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="colorRate" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8}/>
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#334155" />
              <XAxis
                dataKey="date"
                stroke="#94a3b8"
                fontSize={12}
                tickLine={false}
                axisLine={false}
                tickFormatter={(val) => {
                  if (!val) return '';
                  const d = new Date(val);
                  return isNaN(d.getTime()) ? val : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                }}
              />
              <YAxis
                domain={[0, 100]}
                stroke="#94a3b8"
                fontSize={12}
                tickLine={false}
                axisLine={false}
                tickFormatter={(val) => `${val}%`}
              />
              <Tooltip
                contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', color: '#f8fafc', borderRadius: '8px' }}
                labelFormatter={(val) => {
                  if (!val) return '';
                  const d = new Date(val);
                  return isNaN(d.getTime()) ? val : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                }}
                formatter={(value) => [`${value}%`, 'Attendance Rate']}
              />
              <Area type="monotone" dataKey="rate" stroke="#3b82f6" strokeWidth={3} fillOpacity={1} fill="url(#colorRate)" />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {detailed && (
        <>
          {/* Working Hours Trends */}
          <Card className={cn(lightTheme.background.card, lightTheme.border.default, "dark:bg-slate-900 dark:border-border")}>
            <CardHeader>
              <CardTitle className={cn(lightTheme.text.primary, "dark:text-white")}>Average Working Hours Trend</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={analytics.workingHoursTrends}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(value) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  />
                  <YAxis domain={[0, 100]} />
                  <Tooltip
                    labelFormatter={(value) => new Date(value).toLocaleDateString()}
                    formatter={(value: number) => [`${value?.toFixed(2) ?? '0.00'} hours`, 'Avg Working Hours']}
                  />
                  <Line type="monotone" dataKey="rate" stroke="#8b5cf6" strokeWidth={2} dot={{ fill: '#8b5cf6', r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Hourly Activity */}
          <Card className={cn(lightTheme.background.card, lightTheme.border.default, "dark:bg-slate-900 dark:border-border")}>
            <CardHeader>
              <CardTitle className={cn(lightTheme.text.primary, "dark:text-white")}>Hourly Check-In/Check-Out Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={analytics.hourlyActivity.filter(h => h.hour >= 6 && h.hour <= 20)}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="hour" tickFormatter={(value) => `${value}:00`} />
                  <YAxis domain={[0, 100]} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="rate" stroke="#10b981" strokeWidth={2} name="Check-Ins" />
                  <Line type="monotone" dataKey="rate" stroke="#ef4444" strokeWidth={2} name="Check-Outs" />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Top and Bottom Performers */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card className={cn(lightTheme.background.card, lightTheme.border.default, "dark:bg-slate-900 dark:border-border")}>
              <CardHeader>
                <CardTitle className={cn(lightTheme.text.primary, "dark:text-white")}>Top Performers</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {analytics.topPerformers?.map((performer, index) => (
                    <div key={performer.employeeId} className="flex items-center gap-4">
                      <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center text-blue-600 dark:text-blue-300 font-bold">
                        {index + 1}
                      </div>
                      <div className="flex-1">
                        <p className="font-medium">{performer.name}</p>
                        <p className={cn("text-sm", lightTheme.text.secondary, "dark:text-gray-400")}>{performer.department}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-green-600">{performer.score?.toFixed(0) ?? "0"}</p>
                        <p className={cn("text-xs", lightTheme.text.muted, "dark:text-gray-500")}>{performer.attendanceRate?.toFixed(1) ?? '0.0'}% Attendance</p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className={cn(lightTheme.background.card, lightTheme.border.default, "dark:bg-slate-900 dark:border-border")}>
              <CardHeader>
                <CardTitle className={cn(lightTheme.text.primary, "dark:text-white")}>Needs Attention</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {analytics.bottomPerformers?.map((performer, index) => (
                    <div key={performer.employeeId} className="flex items-center gap-4">
                      <div className="w-8 h-8 rounded-full bg-red-100 dark:bg-red-900 flex items-center justify-center text-red-600 dark:text-red-300 font-bold">
                        {index + 1}
                      </div>
                      <div className="flex-1">
                        <p className="font-medium">{performer.name}</p>
                        <p className={cn("text-sm", lightTheme.text.secondary, "dark:text-gray-400")}>{performer.department}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-red-600">{performer.score?.toFixed(0) ?? "0"}</p>
                        <p className={cn("text-xs", lightTheme.text.muted, "dark:text-gray-500")}>{performer.attendanceRate?.toFixed(1) ?? '0.0'}% Attendance</p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
};
