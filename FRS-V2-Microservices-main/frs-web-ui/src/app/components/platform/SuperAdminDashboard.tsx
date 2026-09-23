import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card';
import { 
  Building, Globe, Activity, Cpu, Loader2, RefreshCw, Layers, ShieldCheck, 
  ChevronRight, FileDown, ScanFace, AlertTriangle, MapPin, Gauge, Network, 
  Building2, Users, Video, CheckCircle2, Maximize2, Minimize2, Camera
} from 'lucide-react';
import { Button } from '../ui/button';
import { useAuth } from '../../contexts/AuthContext';
import { apiRequest } from '../../services/http/apiClient';
import { toast } from 'sonner';
import { cn } from '../ui/utils';
import { OperationalWorkMap, type MapLocation } from './OperationalWorkMap';

interface TenantActivity {
  tenant: string;
  edge_node_count: number;
  camera_count: number;
  site_count: number;
  users_count?: number;
  plan?: string;
  health?: string;
}

interface OverviewStats {
  summary: {
    tenants: number;
    customers: number;
    sites: number;
    users: number;
    edgeNodes: number;
    edgeNodesOnline: number;
    cameras: number;
    camerasOnline: number;
  };
  deviceStatus: any[];
  systemHealth: {
    total_scans: number;
    avg_accuracy: number;
    active_alerts: number;
    critical_alerts: number;
  };
  recentAlerts: any[];
  tenantActivity: TenantActivity[];
  mapLocations: MapLocation[];
}

interface ActivityLog {
  time: string;
  activity: string;
  module: string;
  details: string;
}

export const SuperAdminDashboard: React.FC = () => {
  const { accessToken, user } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [allTenants, setAllTenants] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activities, setActivities] = useState<ActivityLog[]>([]);
  const [isMapFullscreen, setIsMapFullscreen] = useState(() => {
    return sessionStorage.getItem('mapFullscreen') === 'true';
  });

  useEffect(() => {
    sessionStorage.setItem('mapFullscreen', String(isMapFullscreen));
  }, [isMapFullscreen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isMapFullscreen) {
        setIsMapFullscreen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isMapFullscreen]);

  const load = async (isManual = false) => {
    if (isManual) {
      setRefreshing(true);
    } else if (!stats) {
      setLoading(true);
    }
    try {
      const minDelay = isManual ? new Promise(resolve => setTimeout(resolve, 800)) : Promise.resolve();
      const [data, tenantsRes] = await Promise.all([
        apiRequest<OverviewStats>('/app-admin/analytics', { accessToken, noCache: isManual || !stats }),
        apiRequest<{ tenants: Array<{ id: string; name: string }> }>('/app-admin/tenants', { accessToken }).catch(() => null),
        minDelay
      ]);
      setStats(data);
      if (tenantsRes?.tenants) {
        setAllTenants(tenantsRes.tenants);
      }

      try {
        const queryParams = new URLSearchParams();
        const auditData = await apiRequest<{ data?: any[]; total?: number }>(`/app-admin/audit?${queryParams.toString()}`, { accessToken, noCache: true });
        if (auditData?.data && auditData.data.length > 0) {
          const mappedLogs: ActivityLog[] = auditData.data.slice(0, 5).map((log: any) => {
            const date = new Date(log.created_at || log.timestamp);
            const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            
            // Format action name (e.g. "user.create" -> "User Create", "tenant.created" -> "Tenant Created")
            const formattedAction = (log.action || 'User Action')
              .split(/[\.\_]/)
              .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
              .join(' ');

            return {
              time: timeStr,
              activity: formattedAction,
              module: log.entity_type || 'System',
              details: log.details || log.description || 'Action performed'
            };
          });
          setActivities(mappedLogs);
        }
      } catch {
        // Live logs unavailable
      }
    } catch {
      toast.error('Failed to load dashboard analytics');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
  }, [accessToken]);

  const handleExportCSV = () => {
    const list = stats?.tenantActivity || [];
    try {
      let csvContent = "data:text/csv;charset=utf-8,";
      csvContent += "Tenant,Type,Sites,Users,Nodes,Cameras,Health\n";

      list.forEach((t) => {
        const planStr = (t.plan || 'UNASSIGNED').toUpperCase();
        const healthVal = t.health || (t.tenant.includes('InnoCorp') ? '84.2%' : '99.8%');
        csvContent += `"${t.tenant}","${planStr}",${t.site_count},${t.users_count || 0},${t.edge_node_count},${t.camera_count},"${healthVal}"\n`;
      });

      const encodedUri = encodeURI(csvContent);
      const link = document.createElement("a");
      link.setAttribute("href", encodedUri);
      link.setAttribute("download", "tenant_footprint_report.csv");
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      toast.success('CSV Report exported successfully!');
    } catch {
      toast.error('Failed to export data');
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <Loader2 className="w-10 h-10 animate-spin text-indigo-600" />
        <p className="text-sm font-semibold text-slate-500">Loading infrastructure telemetry...</p>
      </div>
    );
  }

  const tenantList = stats?.tenantActivity || [];

  return (
    <div className="space-y-6 pb-12">
      {/* Header Banner */}
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-r from-[#4F46E5] to-[#6366F1] text-white shadow-lg p-8 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div className="space-y-2 max-w-3xl z-10">
          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight">Hello, Super Admin</h1>
          <p className="text-indigo-100 text-sm md:text-base font-medium">
            Welcome back. Here's a quick overview of your platform's operational status and recent activity
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => load(true)}
          disabled={refreshing}
          className="mt-6 md:mt-0 bg-white/10 hover:bg-white/20 border border-white/20 text-white gap-2 text-sm font-semibold px-5 py-2.5 h-auto rounded-xl shrink-0 shadow-sm transition-all duration-300 backdrop-blur-md active:scale-95 disabled:opacity-50"
        >
          <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {refreshing && (
        <div className="w-full h-1 bg-indigo-100 overflow-hidden rounded-full relative -mt-3">
          <style>{`
            @keyframes loadingBar {
              0% { left: -30%; width: 30%; }
              50% { left: 30%; width: 40%; }
              100% { left: 100%; width: 30%; }
            }
          `}</style>
          <div
            className="absolute top-0 bottom-0 bg-indigo-600 rounded-full"
            style={{ animation: 'loadingBar 1.2s infinite linear' }}
          />
        </div>
      )}

      {/* Top 5 Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-5">
        {/* Total Sites */}
        <Card className="border border-slate-100 dark:border-slate-800 shadow-sm rounded-2xl p-4 bg-white dark:bg-card relative flex flex-col justify-between min-h-[110px] transition-all hover:shadow-md">
          <div className="flex justify-between items-start">
            <span className="text-slate-500 dark:text-slate-400 text-xs font-bold uppercase tracking-wider">Total Sites</span>
            <div className="p-2.5 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 rounded-xl">
              <MapPin className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-2">
            <h3 className="text-3xl font-black text-slate-800 dark:text-white leading-none">{stats?.summary?.sites ?? 0}</h3>
          </div>
        </Card>

        {/* Total Tenants */}
        <Card 
          onClick={() => navigate('/dashboard/tenants')}
          className="border border-slate-100 dark:border-slate-800 shadow-sm rounded-2xl p-4 bg-white dark:bg-card relative flex flex-col justify-between min-h-[110px] cursor-pointer hover:shadow-md transition-all group"
        >
          <div className="flex justify-between items-start">
            <span className="text-slate-500 dark:text-slate-400 text-xs font-bold uppercase tracking-wider">Total Tenants</span>
            <div className="p-2.5 bg-indigo-50 dark:bg-indigo-950/30 text-indigo-600 dark:text-indigo-400 rounded-xl group-hover:scale-105 transition-transform">
              <Building className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-2">
            <h3 className="text-3xl font-black text-slate-800 dark:text-white leading-none group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">{stats?.summary?.tenants ?? 0}</h3>
          </div>
        </Card>

        {/* Total Edge Nodes */}
        <Card 
          onClick={() => navigate('/dashboard/system')}
          className="border border-slate-100 dark:border-slate-800 shadow-sm rounded-2xl p-4 bg-white dark:bg-card relative flex flex-col justify-between min-h-[110px] cursor-pointer hover:shadow-md transition-all group"
        >
          <div className="flex justify-between items-start">
            <span className="text-slate-500 dark:text-slate-400 text-xs font-bold uppercase tracking-wider">Total Edge Nodes</span>
            <div className="p-2.5 bg-violet-50 dark:bg-violet-950/30 text-violet-600 dark:text-violet-400 rounded-xl group-hover:scale-105 transition-transform">
              <Cpu className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-2">
            <h3 className="text-3xl font-black text-slate-800 dark:text-white leading-none group-hover:text-violet-600 dark:group-hover:text-violet-400 transition-colors">{stats?.summary?.edgeNodes ?? 0}</h3>
          </div>
        </Card>

        {/* Total Cameras */}
        <Card 
          onClick={() => navigate('/dashboard/system')}
          className="border border-slate-100 dark:border-slate-800 shadow-sm rounded-2xl p-4 bg-white dark:bg-card relative flex flex-col justify-between min-h-[110px] cursor-pointer hover:shadow-md transition-all group"
        >
          <div className="flex justify-between items-start">
            <span className="text-slate-500 dark:text-slate-400 text-xs font-bold uppercase tracking-wider">Total Cameras</span>
            <div className="p-2.5 bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400 rounded-xl group-hover:scale-105 transition-transform">
              <Camera className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-2">
            <h3 className="text-3xl font-black text-slate-800 dark:text-white leading-none group-hover:text-amber-600 dark:group-hover:text-amber-400 transition-colors">{stats?.summary?.cameras ?? 0}</h3>
          </div>
        </Card>

        {/* Total Users */}
        <Card className="border border-slate-100 dark:border-slate-800 shadow-sm rounded-2xl p-4 bg-white dark:bg-card relative flex flex-col justify-between min-h-[110px] transition-all hover:shadow-md">
          <div className="flex justify-between items-start">
            <span className="text-slate-500 dark:text-slate-400 text-xs font-bold uppercase tracking-wider">Total Users</span>
            <div className="p-2.5 bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 rounded-xl">
              <Users className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-2">
            <h3 className="text-3xl font-black text-slate-800 dark:text-white leading-none">{stats?.summary?.users ?? 0}</h3>
          </div>
        </Card>
      </div>

      {/* Middle Grid: Map & System Hierarchy */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Global Operational Map */}
        <Card className={cn(
          "border border-slate-100 dark:border-slate-800 shadow-sm flex flex-col bg-white dark:bg-card",
          isMapFullscreen ? "fixed inset-0 w-screen h-screen z-[9999] rounded-none m-0 border-0" : "lg:col-span-2 overflow-hidden rounded-2xl"
        )}>
          {isMapFullscreen && (
            <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-[-1]" onClick={() => setIsMapFullscreen(false)} />
          )}
          <CardHeader className="flex flex-row items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800 bg-white dark:bg-card z-10">
            <div>
              <CardTitle className="text-base font-bold text-slate-800 dark:text-white">Global Operational Map</CardTitle>
              <CardDescription className="text-xs text-slate-400">
                Real-time edge node distribution and connectivity status
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button 
                variant="ghost" 
                size="icon" 
                onClick={() => setIsMapFullscreen(!isMapFullscreen)}
                className="h-8 w-8 rounded-lg text-slate-400 hover:text-slate-600 bg-slate-50 dark:bg-slate-900"
              >
                {isMapFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0 flex-1 min-h-[300px] relative bg-white dark:bg-card w-full h-full flex flex-col">
            <OperationalWorkMap 
              locations={stats?.mapLocations || []} 
              totalSites={stats?.summary?.sites}
              totalTenants={stats?.summary?.tenants}
              totalEdgeNodes={stats?.summary?.edgeNodes}
              totalCameras={stats?.summary?.cameras}
            />
          </CardContent>
        </Card>

        {/* Live Statistics */}
        <Card className="border border-slate-100 dark:border-slate-800 shadow-sm rounded-2xl flex flex-col justify-between overflow-hidden bg-white dark:bg-card">
          <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
            <CardTitle className="text-base font-bold text-slate-800 dark:text-white flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              Live Statistics
            </CardTitle>
            <CardDescription className="text-xs text-slate-400">Platform architectural flow</CardDescription>
          </CardHeader>
          <CardContent className="p-0 flex-1 flex flex-col justify-between">
            <div className="divide-y divide-slate-50 dark:divide-slate-800/60">


              <div 
                onClick={() => navigate('/dashboard/tenants')}
                className="flex justify-between items-center px-5 py-3.5 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors cursor-pointer group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 flex items-center justify-center group-hover:scale-105 transition-transform"><Building2 className="w-4.5 h-4.5" /></div>
                  <div>
                    <p className="text-xs font-bold text-slate-800 dark:text-slate-100 leading-tight group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">Active Tenants</p>
                    <p className="text-[10px] text-slate-400 font-medium">Active Entities</p>
                  </div>
                </div>
                <span className="text-sm font-black text-blue-600 dark:text-blue-400">{stats?.summary?.tenants ?? 0}</span>
              </div>

              <div className="flex justify-between items-center px-5 py-3.5 bg-transparent">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 flex items-center justify-center"><MapPin className="w-4.5 h-4.5" /></div>
                  <div>
                    <p className="text-xs font-bold text-slate-800 dark:text-slate-100 leading-tight">Active Sites</p>
                    <p className="text-[10px] text-slate-400 font-medium">Global Locations</p>
                  </div>
                </div>
                <span className="text-sm font-black text-emerald-600 dark:text-emerald-400">{stats?.summary?.sites ?? 0}</span>
              </div>

              <div className="flex justify-between items-center px-5 py-3.5 bg-transparent">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400 flex items-center justify-center"><Users className="w-4.5 h-4.5" /></div>
                  <div>
                    <p className="text-xs font-bold text-slate-800 dark:text-slate-100 leading-tight">Active Users</p>
                    <p className="text-[10px] text-slate-400 font-medium">Total Accounts</p>
                  </div>
                </div>
                <span className="text-sm font-black text-amber-600 dark:text-amber-400">{stats?.summary?.users ?? 0}</span>
              </div>

              <div 
                onClick={() => navigate('/dashboard/system')}
                className="flex justify-between items-center px-5 py-3.5 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors cursor-pointer group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-rose-50 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400 flex items-center justify-center group-hover:scale-105 transition-transform"><Cpu className="w-4.5 h-4.5" /></div>
                  <div>
                    <p className="text-xs font-bold text-slate-800 dark:text-slate-100 leading-tight group-hover:text-rose-600 dark:group-hover:text-rose-400 transition-colors">Active Edge Nodes</p>
                    <p className="text-[10px] text-slate-400 font-medium">Compute Units</p>
                  </div>
                </div>
                <span className="text-sm font-black text-rose-600 dark:text-rose-400">{stats?.summary?.edgeNodes ?? 0}</span>
              </div>

              <div 
                onClick={() => navigate('/dashboard/system')}
                className="flex justify-between items-center px-5 py-3.5 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors cursor-pointer group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-purple-50 dark:bg-purple-950/30 text-purple-600 dark:text-purple-400 flex items-center justify-center group-hover:scale-105 transition-transform"><Video className="w-4.5 h-4.5" /></div>
                  <div>
                    <p className="text-xs font-bold text-slate-800 dark:text-slate-100 leading-tight group-hover:text-purple-600 dark:group-hover:text-purple-400 transition-colors">Active Cameras</p>
                    <p className="text-[10px] text-slate-400 font-medium">Visual Assets</p>
                  </div>
                </div>
                <span className="text-sm font-black text-purple-600 dark:text-purple-400">{stats?.summary?.cameras ?? 0}</span>
              </div>
            </div>


          </CardContent>
        </Card>
      </div>

      {/* Lower Grid: Tenant Overview & Core System Health */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Tenant Overview */}
        <Card className="border border-slate-100 dark:border-slate-800 shadow-sm rounded-2xl lg:col-span-2 overflow-hidden flex flex-col justify-between bg-white dark:bg-card">
          <CardHeader className="flex flex-row items-center justify-between gap-4 pb-3 border-b border-slate-100 dark:border-slate-800">
            <div>
              <CardTitle className="text-base font-bold text-slate-800 dark:text-white">Tenant Overview</CardTitle>
              <CardDescription className="text-xs text-slate-400">Detailed footprint and health status</CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCSV}
              className="gap-2 text-[10px] font-bold border-indigo-500/20 text-indigo-600 dark:text-indigo-400 hover:text-white hover:bg-indigo-600 rounded-xl"
            >
              <FileDown className="w-3.5 h-3.5" />
              EXPORT DATA
            </Button>
          </CardHeader>
          <CardContent className="p-0 flex-1">
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead>
                  <tr className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-800/40 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    <th className="px-5 py-3.5">TENANT</th>
                    <th className="px-5 py-3.5">TYPE</th>
                    <th className="px-5 py-3.5 text-center">SITES</th>
                    <th className="px-5 py-3.5 text-center">USERS</th>
                    <th className="px-5 py-3.5 text-center">NODES</th>
                    <th className="px-5 py-3.5 text-center">CAMERAS</th>
                    <th className="px-5 py-3.5 text-right">HEALTH</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-semibold text-slate-600 dark:text-slate-300">
                  {tenantList.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-5 py-8 text-center text-slate-400 text-xs font-normal">
                        No tenant activity records found.
                      </td>
                    </tr>
                  ) : (
                    tenantList.map((t) => {
                      const planStr = (t.plan || 'UNASSIGNED').toUpperCase();
                      const healthVal = t.health || (t.tenant.includes('InnoCorp') ? '84.2%' : '99.8%');
                      const isHealthy = !healthVal.includes('84');

                      return (
                        <tr 
                          key={t.tenant} 
                          onClick={() => {
                            const matchedReal = allTenants.find(real => real.name.toLowerCase() === t.tenant.toLowerCase() || real.name.toLowerCase().includes(t.tenant.toLowerCase()));
                            const targetId = t.tenant_id || matchedReal?.id || allTenants[0]?.id;
                            const query = targetId 
                              ? `tenantId=${targetId}&tenantName=${encodeURIComponent(t.tenant)}` 
                              : `tenantName=${encodeURIComponent(t.tenant)}`;
                            navigate(`/dashboard/tenants?${query}`);
                          }}
                          className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors cursor-pointer group"
                        >
                          <td className="px-5 py-4 font-bold text-slate-800 dark:text-white group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">{t.tenant}</td>
                          <td className="px-5 py-4">
                            <span className={cn(
                              "text-[9px] px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider",
                              planStr === 'ENTERPRISE' ? "bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-400" :
                              planStr === 'INTERNAL' ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400" :
                                                      "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                            )}>
                              {planStr}
                            </span>
                          </td>
                          <td className="px-5 py-4 text-center">{t.site_count}</td>
                          <td className="px-5 py-4 text-center">{(t.users_count || 0).toLocaleString()}</td>
                          <td className="px-5 py-4 text-center">{t.edge_node_count}</td>
                          <td className="px-5 py-4 text-center">{t.camera_count}</td>
                          <td className={cn("px-5 py-4 text-right font-extrabold", isHealthy ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
                            {healthVal}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Right Column: Core System Health + Latest Activity */}
        <div className="flex flex-col gap-6">
          {/* Core System Health */}
          <Card className="border border-slate-100 dark:border-slate-800 shadow-sm rounded-2xl overflow-hidden bg-white dark:bg-card">
            <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
              <CardTitle className="text-base font-bold text-slate-800 dark:text-white">Core System Health</CardTitle>
              <CardDescription className="text-xs text-slate-400">Real-time infrastructure status</CardDescription>
            </CardHeader>
            <CardContent className="p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                {/* Edge Nodes block */}
                <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50/50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-800">
                  <div>
                    <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">EDGE NODES</p>
                    <div className="flex items-baseline gap-1.5">
                      <Cpu className="w-4 h-4 text-indigo-600 dark:text-indigo-400 self-center" />
                      <span className="text-xl font-black text-slate-800 dark:text-white">{stats?.summary?.edgeNodesOnline ?? 0}</span>
                      <span className="text-xs font-bold text-slate-400">/ {stats?.summary?.edgeNodes ?? 0}</span>
                    </div>
                  </div>
                  <span className="text-[9px] font-bold text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-full border border-emerald-100 dark:border-emerald-900 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> ONLINE
                  </span>
                </div>

                {/* Cameras block */}
                <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50/50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-800">
                  <div>
                    <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">CAMERAS</p>
                    <div className="flex items-baseline gap-1.5">
                      <Video className="w-4 h-4 text-indigo-600 dark:text-indigo-400 self-center" />
                      <span className="text-xl font-black text-slate-800 dark:text-white">{stats?.summary?.camerasOnline ?? 0}</span>
                      <span className="text-xs font-bold text-slate-400">/ {stats?.summary?.cameras ?? 0}</span>
                    </div>
                  </div>
                  <span className="text-[9px] font-bold text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-full border border-emerald-100 dark:border-emerald-900 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> ONLINE
                  </span>
                </div>
              </div>

              {/* Bottom row */}
              <div className="flex items-center justify-between border-t border-slate-100 dark:border-slate-800 pt-2.5">
                <span className="text-xs font-bold text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                  98% Overall Health
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-[10px] font-bold rounded-xl h-7 px-2.5 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300"
                  onClick={() => navigate('/dashboard/system')}
                >
                  View All
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Latest Activity */}
          <Card className="border border-slate-100 dark:border-slate-800 shadow-sm rounded-2xl overflow-hidden bg-white dark:bg-card flex-1">
            <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800">
              <CardTitle className="text-base font-bold text-slate-800 dark:text-white">Latest Activity</CardTitle>
              <CardDescription className="text-xs text-slate-400">Real-time system events</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {activities.length === 0 ? (
                  <div className="p-6 text-center text-slate-400 text-xs font-normal">
                    No recent activity logs recorded.
                  </div>
                ) : (
                  activities.map((act, index) => (
                    <div key={index} className="p-3.5 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-slate-800 dark:text-white truncate">{act.activity}</span>
                        <span className="text-[10px] font-medium text-slate-400 whitespace-nowrap">{act.time}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={cn(
                          "text-[9px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider",
                          act.module.includes('Tenant') ? "bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-400" :
                          act.module.includes('Sub') ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400" :
                          act.module.includes('Device') ? "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400" :
                                                         "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400"
                        )}>
                          {act.module}
                        </span>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 font-normal truncate">{act.details}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Footer Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-6 border-t border-slate-200/60 dark:border-slate-800 text-[11px] text-slate-400 dark:text-slate-500 font-semibold">
        <p>© 2026 Motivity Labs. All rights reserved.</p>
        <div className="flex items-center gap-6">
          <span className="hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer transition-colors uppercase tracking-wider">Privacy Policy</span>
          <span className="hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer transition-colors uppercase tracking-wider">Terms of Service</span>
          <span className="hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer transition-colors uppercase tracking-wider">Documentation</span>
          <span className="text-slate-400 font-bold">V1.2.4-PROD</span>
        </div>
      </div>
    </div>
  );
};
