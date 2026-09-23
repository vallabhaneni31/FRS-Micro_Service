import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card';
import { Button } from '../ui/button';
import { Loader2, BarChart3, Building, Cpu, Globe, Users, TrendingUp, Activity, CheckCircle, AlertTriangle, RefreshCw } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { apiRequest } from '../../services/http/apiClient';
import { toast } from 'sonner';
import { PageHeader } from '../shared/PageHeader';
import { lightTheme } from '../../../theme/lightTheme';
import { cn } from '../ui/utils';

interface SummaryStats {
  tenants: number;
  customers: number;
  sites: number;
  users: number;
  edgeNodes: number;
  edgeNodesOnline: number;
  cameras: number;
  camerasOnline: number;
}

interface DeviceStatus {
  category: 'edge_node' | 'camera';
  status: string;
  count: number;
}

interface SystemHealth {
  total_scans: number;
  avg_accuracy: number;
  active_alerts: number;
  critical_alerts: number;
}

interface SystemAlert {
  id: number;
  created_at: string;
  confidence_score: string;
  device_name: string | null;
  site_name: string | null;
  employee_name: string;
}

interface TenantActivity {
  tenant: string;
  edge_node_count: number;
  camera_count: number;
  site_count: number;
}

interface AnalyticsData {
  summary: SummaryStats;
  deviceStatus: DeviceStatus[];
  systemHealth: SystemHealth;
  recentAlerts: SystemAlert[];
  tenantActivity: TenantActivity[];
}

export const SuperAdminAnalytics: React.FC = () => {
  const { accessToken , isAuthenticated } = useAuth();
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [page, setPage] = useState(1);
  const PER_PAGE = 5;

  useEffect(() => {
    setPage(1);
  }, [data]);

  const fetchAnalytics = async (isManual = false) => {
    if (!isAuthenticated) return;
    if (isManual) {
      setRefreshing(true);
    } else if (!data) {
      setLoading(true);
    }
    try {
      const minDelay = isManual ? new Promise(resolve => setTimeout(resolve, 600)) : Promise.resolve();
      const [res] = await Promise.all([
        apiRequest<AnalyticsData>('/app-admin/analytics', { accessToken, noCache: isManual || !data }),
        minDelay
      ]);
      setData(res);
    } catch (err) {
      toast.error('Failed to load global analytics data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchAnalytics();
  }, [accessToken]);

  if (loading) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-96 gap-3', lightTheme.text.muted)}>
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-sm font-medium tracking-wide">Synthesizing global intelligence...</p>
      </div>
    );
  }


  const edgeNodesOnlineCount = data?.summary?.edgeNodesOnline ?? 0;
  const totalEdgeNodesCount = data?.summary?.edgeNodes || 1;
  const edgeNodeUptimePct = Math.round((edgeNodesOnlineCount / totalEdgeNodesCount) * 100);

  const camerasOnlineCount = data?.summary?.camerasOnline ?? 0;
  const totalCamerasCount = data?.summary?.cameras || 1;
  const cameraUptimePct = Math.round((camerasOnlineCount / totalCamerasCount) * 100);

  const total = data?.tenantActivity?.length || 0;
  const totalPages = Math.ceil(total / PER_PAGE);
  const pagedList = (data?.tenantActivity || []).slice((page - 1) * PER_PAGE, page * PER_PAGE);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      {/* Header */}
      <PageHeader
        title="Global Platform Analytics"
        subtitle="Cross-tenant operational metrics and business intelligence"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchAnalytics(true)}
            disabled={loading || refreshing}
            className="gap-2"
          >
            <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
            Refresh
          </Button>
        }
      />

      {refreshing && (
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

      <div className={cn("transition-opacity duration-300 space-y-6", refreshing && "opacity-60 pointer-events-none")}>
        {/* KPI Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
        {/* Edge Node Status */}
        <Card className={cn('border shadow-sm bg-gradient-to-br from-white to-violet-50/20 dark:from-slate-900 dark:to-slate-800/40', lightTheme.border.default)}>
          <CardContent className="p-6 flex items-center gap-4">
            <div className="p-3 bg-violet-100 dark:bg-violet-900/30 rounded-xl">
              <Cpu className="w-6 h-6 text-violet-600 dark:text-violet-400" />
            </div>
            <div>
              <p className={cn('text-3xl font-black', lightTheme.text.primary)}>{edgeNodeUptimePct}%</p>
              <p className={cn('text-xs font-bold uppercase tracking-wider', lightTheme.text.muted)}>Edge Nodes Online</p>
            </div>
          </CardContent>
        </Card>

        {/* Camera Status */}
        <Card className={cn('border shadow-sm bg-gradient-to-br from-white to-blue-50/20 dark:from-slate-900 dark:to-slate-800/40', lightTheme.border.default)}>
          <CardContent className="p-6 flex items-center gap-4">
            <div className="p-3 bg-blue-100 dark:bg-blue-900/30 rounded-xl">
              <Globe className="w-6 h-6 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <p className={cn('text-3xl font-black', lightTheme.text.primary)}>{cameraUptimePct}%</p>
              <p className={cn('text-xs font-bold uppercase tracking-wider', lightTheme.text.muted)}>Cameras Online</p>
            </div>
          </CardContent>
        </Card>

        {/* Global Tenants */}
        <Card className={cn('border shadow-sm bg-gradient-to-br from-white to-violet-50/20 dark:from-slate-900 dark:to-slate-800/40', lightTheme.border.default)}>
          <CardContent className="p-6 flex items-center gap-4">
            <div className="p-3 bg-violet-100 dark:bg-violet-900/30 rounded-xl">
              <Building className="w-6 h-6 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <p className={cn('text-3xl font-black', lightTheme.text.primary)}>{data?.summary?.tenants ?? 0}</p>
              <p className={cn('text-xs font-bold uppercase tracking-wider', lightTheme.text.muted)}>Active Realms</p>
            </div>
          </CardContent>
        </Card>

        {/* Total Sites */}
        <Card className={cn('border shadow-sm bg-gradient-to-br from-white to-emerald-50/20 dark:from-slate-900 dark:to-slate-800/40', lightTheme.border.default)}>
          <CardContent className="p-6 flex items-center gap-4">
            <div className="p-3 bg-emerald-100 dark:bg-emerald-900/30 rounded-xl">
              <Globe className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <p className={cn('text-3xl font-black', lightTheme.text.primary)}>{data?.summary?.sites ?? 0}</p>
              <p className={cn('text-xs font-bold uppercase tracking-wider', lightTheme.text.muted)}>Monitored Facilities</p>
            </div>
          </CardContent>
        </Card>

        {/* Total Employees */}
        <Card className={cn('border shadow-sm bg-gradient-to-br from-white to-amber-50/20 dark:from-slate-900 dark:to-slate-800/40', lightTheme.border.default)}>
          <CardContent className="p-6 flex items-center gap-4">
            <div className="p-3 bg-amber-100 dark:bg-amber-900/30 rounded-xl">
              <Users className="w-6 h-6 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <p className={cn('text-3xl font-black', lightTheme.text.primary)}>{data?.summary?.users ?? 0}</p>
              <p className={cn('text-xs font-bold uppercase tracking-wider', lightTheme.text.muted)}>Federated Identities</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* System Health & Security Alerts */}
      <Card className={cn('border shadow-sm', lightTheme.border.default)}>
        <CardHeader className={cn('border-b dark:border-slate-800 dark:bg-slate-900/20', lightTheme.table.border, lightTheme.table.header)}>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-100 dark:bg-indigo-900/20 rounded-lg">
              <Activity className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <CardTitle className={cn('text-lg font-bold', lightTheme.text.primary)}>System Health & Active Alerts</CardTitle>
              <CardDescription>Real-time cross-tenant operational safety and edge device diagnostics</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-6">
          {/* System Diagnostics Metrics (Grid) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-4 border rounded-xl bg-slate-50/50 dark:bg-slate-900/50 flex flex-col justify-between">
              <span className={cn('text-xs font-bold uppercase tracking-wider', lightTheme.text.muted)}>Total Scans</span>
              <span className={cn('text-2xl font-black mt-2', lightTheme.text.primary)}>
                {data?.systemHealth?.total_scans?.toLocaleString() ?? 0}
              </span>
            </div>
            <div className="p-4 border rounded-xl bg-slate-50/50 dark:bg-slate-900/50 flex flex-col justify-between">
              <span className={cn('text-xs font-bold uppercase tracking-wider', lightTheme.text.muted)}>Avg Accuracy</span>
              <span className={cn('text-2xl font-black mt-2', lightTheme.text.primary)}>
                {data?.systemHealth?.avg_accuracy ? `${data.systemHealth.avg_accuracy.toFixed(1)}%` : '0.0%'}
              </span>
            </div>
            <div className="p-4 border rounded-xl bg-slate-50/50 dark:bg-slate-900/50 flex flex-col justify-between">
              <span className={cn('text-xs font-bold uppercase tracking-wider', lightTheme.text.muted)}>Active Alerts</span>
              <span className={cn('text-2xl font-black mt-2 text-amber-600 dark:text-amber-400')}>
                {data?.systemHealth?.active_alerts ?? 0}
              </span>
            </div>
            <div className="p-4 border rounded-xl bg-slate-50/50 dark:bg-slate-900/50 flex flex-col justify-between">
              <span className={cn('text-xs font-bold uppercase tracking-wider', lightTheme.text.muted)}>Critical Alerts</span>
              <span className={cn('text-2xl font-black mt-2 text-rose-600 dark:text-rose-400')}>
                {data?.systemHealth?.critical_alerts ?? 0}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Grid of breakdowns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Device Status Breakdown */}
        <Card className={cn('border shadow-sm', lightTheme.border.default)}>
          <CardHeader className={cn('border-b dark:border-slate-800 dark:bg-slate-900/20', lightTheme.table.border, lightTheme.table.header)}>
            <div className="flex items-center gap-3">
              <div className="p-2 bg-rose-100 dark:bg-rose-900/20 rounded-lg">
                <Activity className="w-5 h-5 text-rose-600 dark:text-rose-400" />
              </div>
              <div>
                <CardTitle className={cn('text-lg font-bold', lightTheme.text.primary)}>Device Status Distribution</CardTitle>
                <CardDescription>Edge-node fleets statuses across environments</CardDescription>
              </div>
            </div>
          </CardHeader>          <CardContent className="pt-6">
            {data?.deviceStatus?.length ? (
              <div className="space-y-6">
                {['edge_node', 'camera'].map(cat => {
                  const items = data.deviceStatus.filter(d => d.category === cat);
                  if (!items.length) return null;
                  const catTotal = cat === 'edge_node' ? data.summary.edgeNodes : data.summary.cameras;
                  const label = cat === 'edge_node' ? 'Edge Nodes' : 'Cameras';
                  return (
                    <div key={cat} className="space-y-3">
                      <h4 className={cn('text-xs font-bold uppercase tracking-wider', lightTheme.text.secondary)}>{label}</h4>
                      {items.map(dev => {
                        const pct = Math.round((dev.count / (catTotal || 1)) * 100);
                        const isOnline = dev.status === 'online';
                        const isOffline = dev.status === 'offline';
                        return (
                          <div key={dev.status} className="space-y-1.5 pl-3 border-l-2 border-slate-200 dark:border-slate-800">
                            <div className="flex justify-between items-center text-sm font-semibold">
                              <span className="flex items-center gap-2 capitalize">
                                <span className={cn(
                                  "w-2.5 h-2.5 rounded-full animate-pulse",
                                  isOnline ? "bg-green-500" : isOffline ? "bg-red-500" : "bg-amber-500"
                                )} />
                                {dev.status}
                              </span>
                              <span className={lightTheme.text.secondary}>
                                {dev.count} <span className={cn('text-xs font-bold ml-1', lightTheme.text.muted)}>({pct}%)</span>
                              </span>
                            </div>
                            <div className="h-2.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                              <div 
                                className={cn(
                                  "h-full rounded-full",
                                  isOnline ? "bg-green-500" : isOffline ? "bg-red-500" : "bg-amber-500"
                                )}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className={cn('text-sm text-center py-10', lightTheme.text.muted)}>No device metrics registered</p>
            )}
          </CardContent>
        </Card>
 
        {/* Tenant Activity and Footprint */}
        <Card className={cn('border shadow-sm', lightTheme.border.default)}>
          <CardHeader className={cn('border-b dark:border-slate-800 dark:bg-slate-900/20', lightTheme.table.border, lightTheme.table.header)}>
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 dark:bg-blue-900/20 rounded-lg">
                <Globe className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <CardTitle className={cn('text-lg font-bold', lightTheme.text.primary)}>Tenant Operational Footprint</CardTitle>
                <CardDescription>Edge node and monitored sites distribution by tenant</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {data?.tenantActivity?.length ? (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead>
                      <tr className={cn('border-b dark:border-slate-800', lightTheme.table.header, lightTheme.table.border)}>
                        <th className="px-6 py-3 font-semibold whitespace-nowrap">Tenant</th>
                        <th className="px-6 py-3 font-semibold text-center whitespace-nowrap">Active Sites</th>
                        <th className="px-6 py-3 font-semibold text-center whitespace-nowrap">Edge Nodes</th>
                        <th className="px-6 py-3 font-semibold text-center whitespace-nowrap">Cameras</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {pagedList.map(t => (
                        <tr key={t.tenant} className={cn('transition-colors', lightTheme.table.rowHover)}>
                          <td className={cn('px-6 py-4 font-bold', lightTheme.text.primary)}>{t.tenant}</td>
                          <td className={cn('px-6 py-4 text-center font-semibold', lightTheme.text.secondary)}>{t.site_count}</td>
                          <td className={cn('px-6 py-4 text-center font-semibold', lightTheme.text.secondary)}>{t.edge_node_count}</td>
                          <td className={cn('px-6 py-4 text-center font-semibold', lightTheme.text.secondary)}>{t.camera_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {total > PER_PAGE && (
                  <div className="flex items-center justify-between p-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
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
              <p className={cn('text-sm text-center py-10', lightTheme.text.muted)}>No tenant operational metrics</p>
            )}
          </CardContent>
        </Card>
      </div>
      </div>
    </div>
  );
};
