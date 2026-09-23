import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../ui/card';
import { Button } from '../../../ui/button';
import { Badge } from '../../../ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../ui/table';
import { Users, Camera, Activity, RefreshCw, ScanFace, TrendingUp, AlertCircle, CheckCircle2 } from 'lucide-react';
import { cn } from '../../../ui/utils';
import { useApiData } from '../../../../hooks/useApiData';
import { MetricCard } from '../../../shared/MetricCard';

export const FacilityIntelligenceDashboard: React.FC = () => {
  const { devices, employees, attendance, alerts, isLoading, refresh } = useApiData({ autoRefreshMs: 30000 });

  const today = new Date().toISOString().slice(0, 10);
  const todayAttendance = attendance.filter(a => a.attendance_date?.slice(0, 10) === today);
  const presentToday = todayAttendance.filter(a => a.status === 'present' || a.status === 'late').length;
  const lateToday = todayAttendance.filter(a => a.is_late).length;
  const absentToday = Math.max(0, employees.length - presentToday);
  const onlineDevices = devices.filter(d => d.status === 'online').length;
  const totalScans = devices.reduce((s, d) => s + (d.total_scans || 0), 0);

  const avgAccuracy = totalScans > 0
    ? (devices.reduce((s, d) => s + Number(d.recognition_accuracy) * (d.total_scans || 0), 0) / totalScans).toFixed(1)
    : '0.0';

  const unreadAlerts = alerts.filter((a: any) => !a.is_read);

  const alertSeverityColor = (severity: string) => {
    if (severity === 'critical') return 'bg-rose-50 text-rose-600 border-rose-100';
    if (severity === 'warning') return 'bg-amber-50 text-amber-600 border-amber-100';
    return 'bg-blue-50 text-blue-600 border-blue-100';
  };

  return (
    <div className="space-y-6">
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
        {/* TOP KPI GRID */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <MetricCard title="Total Staff" value={employees.length} icon={Users} description={`${presentToday} present today`} colorClass="text-blue-600" />
        <MetricCard title="Asset Pool" value={devices.length} icon={Camera} description={`${onlineDevices} currently online`} colorClass="text-indigo-600" />
        <MetricCard title="System Load" value={onlineDevices} icon={Activity} description="Live network nodes" colorClass="text-emerald-600" />
        <MetricCard title="Lifetime AI" value={totalScans.toLocaleString()} icon={ScanFace} description="Total faces parsed" colorClass="text-violet-600" />
        <MetricCard title="Recognition Rate" value={`${avgAccuracy}%`} icon={TrendingUp} description="Global accuracy avg" colorClass="text-amber-600" />
      </div>

      {/* ATTENDANCE CAPSULES */}
      <Card className="border-none shadow-sm bg-white dark:bg-card overflow-hidden">
        <CardHeader className="border-b border-slate-50 dark:border-slate-800 py-4">
          <CardTitle className="text-sm font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">Daily Attendance Snapshot</CardTitle>
        </CardHeader>
        <CardContent className="p-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <MetricCard title="Present" value={presentToday} icon={CheckCircle2} colorClass="text-emerald-600" />
            <MetricCard title="Late Arrival" value={lateToday} icon={AlertCircle} colorClass="text-amber-600" />
            <MetricCard title="Absent" value={absentToday} icon={Users} colorClass="text-rose-600" />
            <MetricCard title="Not Marked" value={employees.length - todayAttendance.length} icon={Activity} colorClass="text-slate-600" />
          </div>
        </CardContent>
      </Card>

      {/* ALERTS FEED */}
      <Card className="border-none shadow-sm bg-white dark:bg-card overflow-hidden">
        <CardHeader className="bg-slate-50/50 dark:bg-slate-900/50 py-3 border-b border-slate-100 dark:border-slate-800 flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle className="text-xs font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">System Alerts</CardTitle>
            {unreadAlerts.length > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-rose-500 text-white text-[9px] font-black">{unreadAlerts.length}</span>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={() => refresh()} className="h-6 text-[10px] font-bold uppercase dark:text-slate-300">
            <RefreshCw className={cn("w-3 h-3 mr-1.5", isLoading && "animate-spin")} /> Refresh
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {alerts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 gap-2">
              <CheckCircle2 className="w-8 h-8 text-emerald-400" />
              <p className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">No active alerts</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-50 dark:divide-slate-800">
              {alerts.slice(0, 8).map((alert: any) => (
                <div key={alert.pk_alert_id || alert.id} className={cn("flex items-start gap-3 px-5 py-3 transition-colors", !alert.is_read && "bg-blue-50/30 dark:bg-blue-950/15")}>
                  <div className={cn("p-1.5 rounded-lg border mt-0.5 flex-shrink-0 border-slate-100 dark:border-slate-800", alertSeverityColor(alert.severity))}>
                    <AlertCircle className="w-3 h-3" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-slate-700 dark:text-slate-200 truncate">{alert.message || alert.title}</p>
                    <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
                      {alert.created_at ? new Date(alert.created_at).toLocaleString() : '—'}
                    </p>
                  </div>
                  {!alert.is_read && <div className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-1.5 flex-shrink-0" />}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* DEVICE SUMMARY TABLE */}
      <Card className="border-none shadow-sm bg-white dark:bg-card overflow-hidden">
        <CardHeader className="bg-slate-50/50 dark:bg-slate-900/50 py-3 border-b border-slate-100 dark:border-slate-800 flex flex-row items-center justify-between">
          <CardTitle className="text-xs font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">Node Performance Ledger</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => refresh()} className="h-6 text-[10px] font-bold uppercase dark:text-slate-300">
            <RefreshCw className={cn("w-3 h-3 mr-1.5", isLoading && "animate-spin")} /> Sync Telemetry
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-b dark:border-slate-800">
                {['Device Node', 'Zone', 'Status', 'AI Scans', 'Recognition Rate'].map(h => (
                  <TableHead key={h} className="text-[9px] font-black uppercase text-slate-400 dark:text-slate-500 tracking-widest">{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {devices.map(d => (
                <TableRow key={d.pk_device_id} className="hover:bg-slate-50/30 dark:hover:bg-slate-800/20 border-b dark:border-slate-800 last:border-0">
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-xl bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 flex items-center justify-center shadow-sm"><Camera className="w-4 h-4" /></div>
                      <span className="text-sm font-black text-slate-700 dark:text-slate-200">{d.name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase">{d.location_label || '—'}</TableCell>
                  <TableCell>
                    <Badge className={cn("rounded-lg border-none px-2 py-0.5 text-[9px] font-bold uppercase", d.status === 'online' ? "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400" : "bg-rose-50 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400")}>
                      {d.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs font-bold text-slate-400 dark:text-slate-500 font-mono">{(d.total_scans || 0).toLocaleString()}</TableCell>
                  <TableCell>
                    <span className={cn("text-xs font-bold", (d.recognition_accuracy || 0) >= 90 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400")}>
                      {d.recognition_accuracy ? `${Number(d.recognition_accuracy).toFixed(1)}% match` : '—'}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
              {devices.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-10 text-xs font-bold text-slate-300 dark:text-slate-600 uppercase tracking-widest h-32">
                    No devices registered
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      </div>
    </div>
  );
};
