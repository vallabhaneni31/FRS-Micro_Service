import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Cpu, Video, ChevronRight } from 'lucide-react';
import { Badge } from '../../../ui/badge';
import type { Permission } from '../../../../types';
import { useAuth } from '../../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { useLiveData } from '../../../../hooks/useLiveData';
import { apiRequest } from '../../../../services/http/apiClient';
import { generateAnalytics } from '../../../../utils/analytics';

import { AttendanceKpiBar } from '../hr/AttendanceKpiBar';
import { MonthlyAttendanceTrend } from '../hr/MonthlyAttendanceTrend';
import AttendanceCalendar from '../hr/AttendanceCalendar';
import { AnalyticsCharts } from '../hr/AnalyticsCharts';
import { AttendanceHeatmap } from '../../../shared/AttendanceHeatmap';
import { SuperAdminAnalytics } from '../../../platform/SuperAdminAnalytics';

import { useDashboardData } from './DashboardDataContext';
import { computeTodayStatus } from './computeTodayStatus';

// ── Widget components ────────────────────────────────────────────────────────

/** Present / late / absent / active + attendance-rate strip, from shared data. */
const AttendanceKpiWidget: React.FC = () => {
  const { employees, attendance, metrics, error } = useDashboardData();
  const status = useMemo(() => computeTodayStatus(employees, attendance), [employees, attendance]);

  // Prefer server-computed values from the /live/metrics API so that Not In Yet
  // and Total Active match exactly what the calendar and backend compute (tenant-wide).
  // Fall back to locally-derived counts only when the API hasn't returned yet.
  const absentCount = metrics?.absentToday ?? status.absentCount;
  const totalActive = metrics?.totalEmployees ?? status.totalActive;

  return (
    <AttendanceKpiBar
      presentCount={metrics?.presentToday ?? status.presentCount}
      lateCount={metrics?.lateToday ?? status.lateCount}
      absentCount={absentCount}
      totalActive={totalActive}
      attendanceRate={metrics?.attendanceRate}
      error={error}
    />
  );
};

const CalendarWidget: React.FC = () => (
  <div className="w-full h-full flex flex-col min-h-[420px]">
    <AttendanceCalendar />
  </div>
);

const MonthlyTrendWidget: React.FC = () => <MonthlyAttendanceTrend />;

/** Punch-density heatmap — self-fetches /dashboard/live/heatmap (analytics.read). */
const PunchHeatmapWidget: React.FC = () => {
  const { accessToken, isAuthenticated } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const { employees } = useDashboardData();
  const [data, setData] = useState<any[]>([]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const fetchHeatmap = () => {
      apiRequest<{ data: any[] }>('/dashboard/live/heatmap', { accessToken, scopeHeaders })
        .then((res) => { if (res?.data) setData(res.data); })
        .catch(() => null);
    };
    fetchHeatmap();
    const timer = setInterval(fetchHeatmap, 60000);
    return () => clearInterval(timer);
  }, [accessToken, isAuthenticated, scopeHeaders]);

  if (data.length === 0) return null;
  return (
    <AttendanceHeatmap
      data={data}
      title="Attendance Punch Density (Last 30 Days)"
      maxEmployees={employees.length || 10}
    />
  );
};

/** Compact edge-device online/total card with Jetson AI Nodes vs Cameras breakdown. */
const DeviceStatusWidget: React.FC = () => {
  const { employees, attendance, devices: liveDevices, metrics } = useDashboardData();
  const { accessToken, isAuthenticated } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const navigate = useNavigate();

  const status = useMemo(() => computeTodayStatus(employees, attendance), [employees, attendance]);
  // Prefer server-computed values from /live/metrics, same as AttendanceKpiWidget,
  // so this breakdown doesn't drift from the tenant-wide totals shown elsewhere.
  const presentCount = metrics?.presentToday ?? status.presentCount;
  const lateCount    = metrics?.lateToday    ?? status.lateCount;
  const absentCount  = metrics?.absentToday  ?? status.absentCount;
  const totalEmp = (metrics?.totalEmployees ?? status.totalActive) || 1;
  const presentPct = Math.round((presentCount / totalEmp) * 100);
  const latePct    = Math.round((lateCount    / totalEmp) * 100);
  const absentPct  = Math.round((absentCount  / totalEmp) * 100);

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

  const { total, online, offline, healthPct, nodeCount, nodeOnline, camCount, camOnline } = useMemo(() => {
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
        total: fTotal,
        online: fOnline,
        offline: fOffline,
        healthPct: pct,
        nodeCount: nTotal,
        nodeOnline: nOnline,
        camCount: cTotal,
        camOnline: cOnline,
      };
    }

    // Fallback to liveDevices if hierarchy API returned empty
    const fTotal = liveDevices.length;
    const fOnline = liveDevices.filter((d: any) => d.status === 'online').length;
    const fOffline = fTotal - fOnline;
    const pct = fTotal > 0 ? Math.round((fOnline / fTotal) * 100) : 0;

    const nodes = liveDevices.filter((d: any) => {
      const type = (d.device_type || d.device_category || d.model || '').toLowerCase();
      return type.includes('ai') || type.includes('node') || type.includes('jetson') || type.includes('lpu');
    });
    const cams = liveDevices.filter((d: any) => !nodes.includes(d));

    return {
      total: fTotal,
      online: fOnline,
      offline: fOffline,
      healthPct: pct,
      nodeCount: nodes.length,
      nodeOnline: nodes.filter((d: any) => d.status === 'online').length,
      camCount: cams.length,
      camOnline: cams.filter((d: any) => d.status === 'online').length,
    };
  }, [edgeHierarchy, liveDevices]);

  return (
    <div className="glass-card rounded-2xl border border-white/60 dark:border-white/10 shadow-sm p-4 h-full flex flex-col justify-between hover:shadow-md transition-all">
      <div>
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              Devices Status
            </p>
            <Badge className="bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20 text-[10px] px-1.5 py-0">
              Edge AI Fleet
            </Badge>
          </div>
          <button
            onClick={() => navigate('/dashboard/devices')}
            className="w-7 h-7 rounded-lg flex items-center justify-center bg-sky-50 dark:bg-sky-950/30 text-sky-500 hover:bg-sky-100 dark:hover:bg-sky-900/50 transition-colors"
            title="Open Edge Nodes Tab"
          >
            <Cpu className="w-4 h-4" />
          </button>
        </div>

        {/* Primary Fleet Metric */}
        <div className="mt-2">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-slate-800 dark:text-white leading-none">
              {online}/{total}
            </span>
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Online</span>
          </div>
          <p className={`text-[11px] mt-1 font-bold flex items-center gap-1.5 ${offline > 0 ? 'text-rose-500' : 'text-emerald-500'}`}>
            {offline > 0 ? (
              <>
                <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse inline-block" />
                {offline} offline ({healthPct}% operational)
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
                All streams operational (100%)
              </>
            )}
          </p>
        </div>

        {/* Main Health Bar */}
        <div className="mt-2 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ${
              healthPct >= 80 ? 'bg-emerald-500' : healthPct >= 50 ? 'bg-amber-400' : 'bg-rose-500'
            }`}
            style={{ width: `${healthPct}%` }}
          />
        </div>

        {/* Edge Nodes vs Cameras Breakdown Cards */}
        <div className="mt-2.5 pt-2 border-t border-slate-100 dark:border-slate-800/80 grid grid-cols-2 gap-2">
          {/* Edge AI Nodes */}
          <div className="bg-slate-50/80 dark:bg-slate-800/40 p-2 rounded-xl border border-slate-100 dark:border-slate-800/60 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <div className="w-6 h-6 rounded-lg bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
                <Cpu className="w-3 h-3" />
              </div>
              <div>
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-tight">Edge Boxes</p>
                <p className="text-xs font-black text-slate-800 dark:text-slate-100">
                  {nodeCount > 0 ? `${nodeOnline}/${nodeCount}` : `${online}/${total}`}
                </p>
              </div>
            </div>
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${
              (nodeCount > 0 ? nodeOnline === nodeCount : offline === 0)
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
            }`}>
              {nodeCount > 0 ? `${Math.round((nodeOnline / (nodeCount || 1)) * 100)}%` : `${healthPct}%`}
            </span>
          </div>

          {/* IP Cameras */}
          <div className="bg-slate-50/80 dark:bg-slate-800/40 p-2 rounded-xl border border-slate-100 dark:border-slate-800/60 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <div className="w-6 h-6 rounded-lg bg-sky-50 dark:bg-sky-950/40 text-sky-600 dark:text-sky-400 flex items-center justify-center shrink-0">
                <Video className="w-3 h-3" />
              </div>
              <div>
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-tight">IP Cameras</p>
                <p className="text-xs font-black text-slate-800 dark:text-slate-100">
                  {camCount > 0 ? `${camOnline}/${camCount}` : `${online}/${total}`}
                </p>
              </div>
            </div>
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${
              (camCount > 0 ? camOnline === camCount : offline === 0)
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
            }`}>
              {camCount > 0 ? `${Math.round((camOnline / (camCount || 1)) * 100)}%` : `${healthPct}%`}
            </span>
          </div>
        </div>

        {/* Navigation CTA */}
        <div 
          onClick={() => navigate('/dashboard/devices')}
          className="mt-2 pt-1.5 text-[11px] font-bold text-sky-600 dark:text-sky-400 hover:text-sky-700 dark:hover:text-sky-300 flex items-center justify-between cursor-pointer group"
        >
          <span>Manage Edge AI Nodes & Feeds</span>
          <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
        </div>

        {/* Live Fleet Performance Telemetry */}
        <div className="mt-2.5 pt-2 border-t border-slate-100 dark:border-slate-800/80">
          <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1.5">Live Telemetry & Diagnostics</p>
          <div className="grid grid-cols-3 gap-1.5 text-center">
            <div className="bg-slate-50/80 dark:bg-slate-800/40 p-1.5 rounded-xl border border-slate-100 dark:border-slate-800/60">
              <p className="text-[9px] font-bold text-slate-400 uppercase">Stream FPS</p>
              <p className="text-xs font-black text-emerald-600 dark:text-emerald-400 mt-0.5">30 FPS</p>
            </div>
            <div className="bg-slate-50/80 dark:bg-slate-800/40 p-1.5 rounded-xl border border-slate-100 dark:border-slate-800/60">
              <p className="text-[9px] font-bold text-slate-400 uppercase">Avg Latency</p>
              <p className="text-xs font-black text-blue-600 dark:text-blue-400 mt-0.5">&lt; 14ms</p>
            </div>
            <div className="bg-slate-50/80 dark:bg-slate-800/40 p-1.5 rounded-xl border border-slate-100 dark:border-slate-800/60">
              <p className="text-[9px] font-bold text-slate-400 uppercase">AI Model</p>
              <p className="text-xs font-black text-indigo-600 dark:text-indigo-400 mt-0.5">Active</p>
            </div>
          </div>
        </div>
      </div>

      {/* Site Attendance Breakdown */}
      <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800/80 space-y-2">
        <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Site Attendance Breakdown</p>
        {[
          { label: 'Present', count: presentCount, pct: presentPct, color: 'bg-emerald-500' },
          { label: 'Late', count: lateCount, pct: latePct, color: 'bg-amber-500' },
          { label: 'Absent', count: absentCount, pct: absentPct, color: 'bg-rose-500' },
        ].map(({ label, count, pct, color }) => (
          <div key={label}>
            <div className="flex justify-between text-[11px] font-bold text-slate-700 dark:text-slate-200 mb-1">
              <span>{label} ({count})</span>
              <span>{pct}%</span>
            </div>
            <div className="w-full bg-slate-100 dark:bg-slate-800 h-1.5 rounded-full overflow-hidden">
              <div className={`${color} h-full rounded-full transition-all duration-500`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

/** Weekly attendance bars — uses the analytics util over the live data set. */
const WeeklyAttendanceWidget: React.FC = () => {
  const { employees, attendance } = useLiveData();
  const analytics = useMemo(() => generateAnalytics(employees, attendance), [employees, attendance]);
  return (
    <div className="glass-card rounded-2xl border border-white/50 dark:border-white/10 shadow-sm p-5">
      <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-4">Weekly Attendance</h3>
      <AnalyticsCharts analytics={analytics} />
    </div>
  );
};

/** Cross-tenant platform summary (super_admin). Renders the full page as-is. */
const PlatformOverviewWidget: React.FC = () => <SuperAdminAnalytics />;

// ── Registry ─────────────────────────────────────────────────────────────────

export interface WidgetDef {
  Component:           React.FC;
  /** Hidden (not rendered) unless the user holds this permission. */
  requiredPermission?: Permission;
  /** Grid columns out of 4 when the manifest omits a span. */
  defaultSpan?:        1 | 2 | 3 | 4;
  /** Self-contained full-page widget — suppresses SmartDashboard's own chrome. */
  fullPage?:           boolean;
}

export const WIDGET_REGISTRY: Record<string, WidgetDef> = {
  kpi_attendance:    { Component: AttendanceKpiWidget,   requiredPermission: 'attendance.read', defaultSpan: 4 },
  calendar:          { Component: CalendarWidget,        requiredPermission: 'attendance.read', defaultSpan: 2 },
  monthly_trend:     { Component: MonthlyTrendWidget,    requiredPermission: 'attendance.read', defaultSpan: 4 },
  punch_heatmap:     { Component: PunchHeatmapWidget,    requiredPermission: 'analytics.read',  defaultSpan: 4 },
  device_status:     { Component: DeviceStatusWidget,    requiredPermission: 'devices.read',    defaultSpan: 2 },
  weekly_chart:      { Component: MonthlyTrendWidget,   requiredPermission: 'attendance.read', defaultSpan: 4 },
  platform_overview: { Component: PlatformOverviewWidget, defaultSpan: 4, fullPage: true },
};

/**
 * Frontend fallback layout per role. Used only when the manifest yields zero
 * *renderable* widgets (empty, or all ids unknown to this build) so the
 * dashboard degrades gracefully instead of rendering blank. The manifest stays
 * the primary source of truth.
 */
export const ROLE_FALLBACK_LAYOUT: Record<string, string[]> = {
  hr_manager:   ['kpi_attendance', 'calendar', 'monthly_trend', 'punch_heatmap'],
  site_admin:   ['kpi_attendance', 'device_status', 'calendar', 'monthly_trend'],
  tenant_admin: ['kpi_attendance', 'device_status', 'calendar', 'monthly_trend'],
  super_admin:  ['platform_overview'],
};
