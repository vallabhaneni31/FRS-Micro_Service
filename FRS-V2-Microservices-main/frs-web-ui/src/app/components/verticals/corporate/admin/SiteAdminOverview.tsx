import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../ui/card';
import { Users, CheckCircle, Clock, Video, MapPin, Loader2, RefreshCw, Cpu, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router';
import { apiRequest } from '../../../../services/http/apiClient';
import { useAuth } from '../../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { useApiData } from '../../../../hooks/useApiData';
import { Button } from '../../../ui/button';
import { cn } from '../../../ui/utils';
import { lightTheme } from '../../../../../theme/lightTheme';
import { PageHeader } from '../../../shared/PageHeader';
import AttendanceCalendar from '../hr/AttendanceCalendar';
import { MonthlyAttendanceTrend } from '../hr/MonthlyAttendanceTrend';

export const SiteAdminOverview: React.FC = () => {
  const { accessToken , isAuthenticated } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const navigate = useNavigate();
  const { devices, isLoading: devicesLoading } = useApiData({ autoRefreshMs: 60000 });

  const [metrics, setMetrics] = useState({
    presentToday: 0, lateToday: 0, absentToday: 0,
    attendanceRate: 0, totalEmployees: 0,
  });
  const [metricsLoading, setMetricsLoading] = useState(true);

  const fetchMetrics = useCallback(async () => {
    if (!isAuthenticated) return;
    setMetricsLoading(true);
    try {
      const d: any = await apiRequest('/live/metrics', { accessToken, scopeHeaders });
      setMetrics({
        presentToday:    d.presentToday    ?? 0,
        lateToday:       d.lateToday       ?? 0,
        absentToday:     d.absentToday     ?? 0,
        attendanceRate:  d.attendanceRate  ?? 0,
        totalEmployees:  d.totalEmployees  ?? 0,
      });
    } catch {}
    finally { setMetricsLoading(false); }
  }, [accessToken]);

  useEffect(() => { fetchMetrics(); }, [fetchMetrics]);

  const [edgeHierarchy, setEdgeHierarchy] = useState<any[] | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;
    apiRequest<{ success: boolean; data: any[] }>('/devices/edge-devices', { accessToken, scopeHeaders })
      .then(res => {
        if (res?.data && Array.isArray(res.data)) {
          setEdgeHierarchy(res.data);
        }
      })
      .catch(() => null);
  }, [accessToken, isAuthenticated, scopeHeaders]);

  const { totalDevices, activeDevices, offlineDevices, deviceHealthPct, nodeCount, nodeOnline, camCount, camOnline } = useMemo(() => {
    if (edgeHierarchy && edgeHierarchy.length > 0) {
      const nTotal = edgeHierarchy.length;
      const nOnline = edgeHierarchy.filter((n: any) => n.status === 'online').length;
      const allCams = edgeHierarchy.flatMap((n: any) => n.cameras || []);
      const cTotal = allCams.length;
      const cOnline = allCams.filter((c: any) => c.status === 'online').length;

      const fTotal = nTotal + cTotal;
      const fOnline = nOnline + cOnline;
      const fOffline = fTotal - fOnline;
      const pct = fTotal > 0 ? Math.round((fOnline / fTotal) * 100) : 0;

      return {
        totalDevices: fTotal,
        activeDevices: fOnline,
        offlineDevices: fOffline,
        deviceHealthPct: pct,
        nodeCount: nTotal,
        nodeOnline: nOnline,
        camCount: cTotal,
        camOnline: cOnline,
      };
    }

    const t = devices.length;
    const a = devices.filter((d: any) => d.status === 'online').length;
    const o = t - a;
    const p = t > 0 ? Math.round((a / t) * 100) : 0;

    const nodes = devices.filter((d: any) => {
      const type = (d.device_type || d.device_category || d.model || '').toLowerCase();
      return type.includes('ai') || type.includes('node') || type.includes('jetson') || type.includes('lpu');
    });
    const cams = devices.filter((d: any) => !nodes.includes(d));

    return {
      totalDevices: t,
      activeDevices: a,
      offlineDevices: o,
      deviceHealthPct: p,
      nodeCount: nodes.length,
      nodeOnline: nodes.filter((d: any) => d.status === 'online').length,
      camCount: cams.length,
      camOnline: cams.filter((d: any) => d.status === 'online').length,
    };
  }, [edgeHierarchy, devices]);
  // Use totalEmployees as the common denominator so all three bars add up to 100%.
  // On-time present = presentToday - lateToday (presentToday includes late check-ins).
  const total       = metrics.totalEmployees || (metrics.presentToday + metrics.lateToday + metrics.absentToday);
  const onTimeCount = Math.max(0, metrics.presentToday - metrics.lateToday);
  const presentPct  = total > 0 ? Math.round((onTimeCount          / total) * 100) : 0;
  const latePct     = total > 0 ? Math.round((metrics.lateToday    / total) * 100) : 0;
  const absentPct   = total > 0 ? Math.round((metrics.absentToday  / total) * 100) : 0;

  const isLoading = metricsLoading || devicesLoading;
  const hasData = metrics.totalEmployees > 0 || devices.length > 0;
  const showInitialLoading = isLoading && !hasData;

  if (showInitialLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  const circumference = 219.91;
  const dashOffset = circumference - (circumference * deviceHealthPct) / 100;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
      {/* Header */}
      <PageHeader
        title="Site Operations Overview"
        icon={MapPin}
        subtitle="Real-time attendance metrics and device status for this site"
        actions={
          <Button variant="outline" size="sm" onClick={fetchMetrics} disabled={isLoading} className="gap-2">
            <RefreshCw className={cn("w-3.5 h-3.5", isLoading && "animate-spin")} /> Refresh
          </Button>
        }
      />

      {isLoading && (
        <div className="w-full h-1 bg-primary/10 overflow-hidden rounded-full relative">
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

      <div className={cn("transition-opacity duration-300 space-y-6", isLoading && "opacity-60 pointer-events-none")}>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-none shadow-sm bg-white/70 dark:bg-slate-900/60 backdrop-blur-md">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Total Checked-In</p>
              <h3 className="text-2xl font-black text-slate-800 dark:text-white mt-1">{metrics.presentToday}</h3>
              <p className="text-[10px] text-emerald-500 mt-1 font-bold">● Active presence logged</p>
            </div>
            <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-500 rounded-2xl">
              <Users className="w-5 h-5" />
            </div>
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm bg-white/70 dark:bg-slate-900/60 backdrop-blur-md">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">On-Time Rate</p>
              <h3 className="text-2xl font-black text-slate-800 dark:text-white mt-1">{metrics.attendanceRate}%</h3>
              <p className="text-[10px] text-blue-500 mt-1 font-bold">Within standard shift buffer</p>
            </div>
            <div className="p-3 bg-blue-50 dark:bg-blue-950/30 text-blue-500 rounded-2xl">
              <CheckCircle className="w-5 h-5" />
            </div>
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm bg-white/70 dark:bg-slate-900/60 backdrop-blur-md">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Late Arrivals</p>
              <h3 className="text-2xl font-black text-slate-800 dark:text-white mt-1">{metrics.lateToday}</h3>
              <p className="text-[10px] text-amber-500 mt-1 font-bold">Needs shift schedule review</p>
            </div>
            <div className="p-3 bg-amber-50 dark:bg-amber-950/30 text-amber-500 rounded-2xl">
              <Clock className="w-5 h-5" />
            </div>
          </CardContent>
        </Card>

        <Card 
          onClick={() => navigate('/dashboard/devices')}
          className="border-none shadow-sm bg-white/70 dark:bg-slate-900/60 backdrop-blur-md cursor-pointer hover:shadow-md transition-all group"
        >
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-1.5">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Edge Fleet Online</p>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400 group-hover:translate-x-0.5 transition-transform" />
              </div>
              <h3 className="text-2xl font-black text-slate-800 dark:text-white mt-1">
                {activeDevices}/{totalDevices}
              </h3>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[10px] font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/40 px-1.5 py-0.5 rounded">
                  ⚡ {nodeCount > 0 ? `${nodeOnline}/${nodeCount} Edge Boxes` : `${activeDevices} Active`}
                </span>
                <span className="text-[10px] font-bold text-sky-600 dark:text-sky-400 bg-sky-50 dark:bg-sky-950/40 px-1.5 py-0.5 rounded">
                  📹 {camCount > 0 ? `${camOnline}/${camCount} Cams` : `${activeDevices} Active`}
                </span>
              </div>
            </div>
            <div className={`p-3 rounded-2xl ${offlineDevices > 0 ? 'bg-rose-50 dark:bg-rose-950/30 text-rose-500' : 'bg-blue-50 dark:bg-blue-950/30 text-blue-500'}`}>
              <Cpu className="w-5 h-5" />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left Side: Device Status & Headcount Breakdown */}
        <div className="lg:col-span-5 flex flex-col justify-between h-full space-y-6">
          {/* Device health status */}
          <Card className="border-none shadow-sm bg-white/70 dark:bg-slate-900/60 backdrop-blur-md">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-xs uppercase font-bold text-slate-400 tracking-wider">Edge Device Status</CardTitle>
              <button
                onClick={() => navigate('/dashboard/devices')}
                className="text-[11px] font-bold text-sky-600 dark:text-sky-400 hover:underline flex items-center gap-1"
              >
                Edge Nodes <ChevronRight className="w-3 h-3" />
              </button>
            </CardHeader>
            <CardContent className="flex flex-col items-center justify-center p-4 text-center">
              <div className="relative flex items-center justify-center mb-2">
                <svg className="w-20 h-20 transform -rotate-90">
                  <circle cx="40" cy="40" r="35" stroke="currentColor"
                    className="text-slate-100 dark:text-slate-800" strokeWidth="5" fill="transparent" />
                  <circle cx="40" cy="40" r="35" stroke="currentColor"
                    className={deviceHealthPct >= 80 ? 'text-blue-500' : deviceHealthPct >= 50 ? 'text-amber-500' : 'text-rose-500'}
                    strokeWidth="5" fill="transparent"
                    strokeDasharray={circumference}
                    strokeDashoffset={dashOffset}
                    style={{ transition: 'stroke-dashoffset 0.5s ease' }}
                  />
                </svg>
                <div className="absolute text-center">
                  <span className="text-base font-black text-slate-800 dark:text-white">{deviceHealthPct}%</span>
                  <p className="text-[7.5px] uppercase tracking-wider text-slate-400 font-bold">
                    {deviceHealthPct >= 80 ? 'Operational' : deviceHealthPct >= 50 ? 'Degraded' : 'Attention'}
                  </p>
                </div>
              </div>
              
              {/* Edge AI Nodes & Cameras Status Pills */}
              <div className="w-full grid grid-cols-2 gap-2 my-1.5">
                <div className="bg-slate-50 dark:bg-slate-800/50 p-1.5 rounded-lg border border-slate-100 dark:border-slate-800 text-left">
                  <p className="text-[9px] font-bold text-slate-400 uppercase">Edge Boxes</p>
                  <p className="text-xs font-black text-slate-800 dark:text-slate-100">
                    {nodeCount > 0 ? `${nodeOnline}/${nodeCount} online` : `${activeDevices}/${totalDevices}`}
                  </p>
                </div>
                <div className="bg-slate-50 dark:bg-slate-800/50 p-1.5 rounded-lg border border-slate-100 dark:border-slate-800 text-left">
                  <p className="text-[9px] font-bold text-slate-400 uppercase">IP Cameras</p>
                  <p className="text-xs font-black text-slate-800 dark:text-slate-100">
                    {camCount > 0 ? `${camOnline}/${camCount} online` : `${activeDevices}/${totalDevices}`}
                  </p>
                </div>
              </div>

              <p className="text-[10px] text-slate-400 mt-0.5 max-w-[220px]">
                {offlineDevices === 0
                  ? 'Edge Jetson nodes and IP camera feeds operating within nominal parameters.'
                  : `${offlineDevices} device${offlineDevices > 1 ? 's' : ''} offline. Check Edge Nodes tab for diagnostics.`}
              </p>
            </CardContent>
          </Card>

          {/* Headcount Breakdown */}
          <Card className="border-none shadow-sm bg-white/70 dark:bg-slate-900/60 backdrop-blur-md">
            <CardHeader>
              <CardTitle className="text-xs uppercase font-bold text-slate-400 tracking-wider">Site Attendance Breakdown</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {[
                { label: 'Present', count: onTimeCount, pct: presentPct, color: 'bg-emerald-500' },
                { label: 'Late Arrivals', count: metrics.lateToday, pct: latePct, color: 'bg-amber-500' },
                { label: 'Not In Yet', count: metrics.absentToday, pct: absentPct, color: 'bg-rose-500' },
              ].map(({ label, count, pct, color }) => (
                <div key={label}>
                  <div className="flex justify-between text-xs font-bold text-slate-700 dark:text-slate-200 mb-1">
                    <span>{label} ({count})</span>
                    <span>{pct}%</span>
                  </div>
                  <div className="w-full bg-slate-100 dark:bg-slate-800 h-2 rounded-full overflow-hidden">
                    <div className={`${color} h-full rounded-full transition-all duration-500`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        {/* Right Side: Attendance Calendar */}
        <div className="lg:col-span-7 flex flex-col h-full">
          <AttendanceCalendar />
        </div>
      </div>

      {/* Monthly Attendance Trend Chart */}
      <MonthlyAttendanceTrend />
      </div>
    </div>
  );
};
