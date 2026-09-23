import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../ui/card';
import { Badge } from '../../../ui/badge';
import {
  Zap, Cpu, Thermometer, MemoryStick, HardDrive,
  Activity, RefreshCw, Layers, ShieldCheck, AlertCircle,
  Network, RotateCcw, Loader2
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../../../ui/utils';
import { useAuth } from '../../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { apiRequest } from '../../../../services/http/apiClient';
import { ConfirmModal } from '../../../ui/confirm-modal';
import { realtimeEngine } from '../../../../engine/RealTimeEngine';
import { 
  AreaChart, Area, XAxis, YAxis, Tooltip as ChartTooltip, ResponsiveContainer,
  LineChart, Line, CartesianGrid, Brush
} from 'recharts';

// --- Types ---
interface NugBox {
  pk_nug_id: string; 
  name: string; 
  device_code: string; 
  ip_address: string;
  status: string; 
  location_label?: string;
  cpu_percent: number | null; 
  memory_used_mb: number | null; 
  memory_total_mb: number | null;
  gpu_percent: number | null; 
  temperature_c: number | null; 
  disk_used_gb: number | null; 
  uptime_seconds: number | null;
  model: string;
  last_heartbeat: string | null;
}

interface TelemetryPoint {
  time: string;
  cpu: number;
  gpu: number;
  ram: number;
  temp: number;
}

const fmtTemp = (t: number | null) => t != null && !isNaN(t) ? `${Number(t).toFixed(1)}°C` : '—';
const fmtMem = (used: number | null, total: number | null) => {
  if (used == null || total == null) return '—';
  return `${(Number(used)/1024).toFixed(1)} / ${(Number(total)/1024).toFixed(1)} GB`;
};
const fmtUptime = (s: number | null) => {
  if (!s) return '—';
  const n = Number(s);
  const d = Math.floor(n / 86400);
  const h = Math.floor((n % 86400) / 3600);
  const m = Math.floor((n % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
};

// --- Helper Functions ---
const createBlankHistory = (count: number): TelemetryPoint[] => {
  return Array.from({ length: count }, () => ({
    time: '',
    cpu: 0,
    gpu: 0,
    ram: 0,
    temp: 0
  }));
};

// --- Sub-component: Metric Ring ---
const MetricRing = ({ label, value, unit = '%', color = 'stroke-blue-500', size = 60 }: { label: string, value: number | null, unit?: string, color?: string, size?: number }) => {
  const radius = (size / 2) - 5;
  const circumference = 2 * Math.PI * radius;
  const val = value != null ? Math.min(100, Math.max(0, value)) : 0;
  const offset = circumference - (val / 100) * circumference;

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        <svg className="w-full h-full transform -rotate-90">
          <circle cx={size/2} cy={size/2} r={radius} className="stroke-slate-100 dark:stroke-slate-800" strokeWidth="4" fill="transparent" />
          <circle 
            cx={size/2} cy={size/2} r={radius} 
            className={cn("transition-all duration-1000 ease-out", color)} 
            strokeWidth="4" strokeDasharray={circumference} strokeDashoffset={offset} 
            strokeLinecap="round" fill="transparent" 
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-[10px] font-black text-slate-700 dark:text-slate-300">
            {value != null ? `${Math.round(value)}${unit}` : '—'}
          </span>
        </div>
      </div>
      <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400">{label}</span>
    </div>
  );
};

// --- Sub-component: Pulse Sparkline ---
const PulseSparkline = ({ id, data, dataKey, color }: { id: string, data: TelemetryPoint[], dataKey: 'cpu' | 'gpu' | 'ram', color: string }) => {
  const gradId = `grad-${id}-${dataKey}`;
  return (
    <div className="h-12 w-full mt-2 opacity-90 group-hover:opacity-100 transition-opacity">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.6}/>
              <stop offset="95%" stopColor={color} stopOpacity={0}/>
            </linearGradient>
          </defs>
          <Area 
            type="monotone" 
            dataKey={dataKey} 
            stroke={color} 
            strokeWidth={3}
            fillOpacity={1} 
            fill={`url(#${gradId})`} 
            isAnimationActive={false}
          />
          <YAxis hide domain={[0, 50]} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};

// --- Sub-component: Cluster Trend Chart ---
const ClusterTrendChart = ({ title, data, dataKey, color, type = 'area', domain = [0, 100], showBrush = false }: { title: string, data: any[], dataKey: string, color: string, type?: 'area' | 'line', domain?: [number, number], showBrush?: boolean }) => (
  <Card className="border-none shadow-sm glass-card overflow-hidden">
    <CardHeader className="pb-2">
      <div className="flex justify-between items-center">
        <CardTitle className="text-[10px] font-black uppercase tracking-widest text-slate-400">{title}</CardTitle>
        <div className="p-1 bg-slate-50 dark:bg-slate-800 rounded-lg">
          {type === 'area' ? <Activity className="w-3 h-3 text-blue-500" /> : <ShieldCheck className="w-3 h-3 text-purple-500" />}
        </div>
      </div>
    </CardHeader>
    <CardContent className="pt-0">
      <div className="h-[250px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          {type === 'area' ? (
            <AreaChart data={data} margin={{ bottom: 40 }}>
              <defs>
                <linearGradient id={`grad-cluster-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={color} stopOpacity={0.2}/>
                  <stop offset="95%" stopColor={color} stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" className="text-slate-100 dark:text-slate-800" />
              <XAxis dataKey="time" hide={!showBrush} fontSize={10} tick={{ fill: '#94a3b8' }} />
              <YAxis 
                domain={domain} 
                axisLine={false} 
                tickLine={false} 
                fontSize={10} 
                tick={{ fill: '#94a3b8' }} 
              />
              <ChartTooltip 
                contentStyle={{ borderRadius: '12px', border: 'none', backgroundColor: 'rgba(255,255,255,0.9)', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' }}
              />
              <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={3} fill={`url(#grad-cluster-${dataKey})`} isAnimationActive={false} />
              {showBrush && <Brush dataKey="time" height={30} stroke="#94a3b8" fill="#f8fafc" />}
            </AreaChart>
          ) : (
            <LineChart data={data} margin={{ bottom: 40 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" className="text-slate-100 dark:text-slate-800" />
              <XAxis dataKey="time" hide={!showBrush} fontSize={10} tick={{ fill: '#94a3b8' }} />
              <YAxis 
                domain={domain} 
                axisLine={false} 
                tickLine={false} 
                fontSize={10} 
                tick={{ fill: '#94a3b8' }} 
              />
              <ChartTooltip 
                contentStyle={{ borderRadius: '12px', border: 'none', backgroundColor: 'rgba(255,255,255,0.9)', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' }}
              />
              <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={3} dot={{ r: 4, fill: color, strokeWidth: 2, stroke: '#fff' }} isAnimationActive={false} />
              {showBrush && <Brush dataKey="time" height={30} stroke="#94a3b8" fill="#f8fafc" />}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </CardContent>
  </Card>
);

export const HardwareMetricsDashboard: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [nugs, setNugs] = useState<NugBox[]>([]);
  const [isLoading, setLoading] = useState(true);
  const [filterMode, setFilterMode] = useState<'All' | 'Last Hour' | 'Last 10m'>('All');
  const [visibleMetrics, setVisibleMetrics] = useState<string[]>(['cpu', 'gpu', 'ram', 'temp']);
  const [history, setHistory] = useState<Record<string, TelemetryPoint[]>>({});
  const [globalHistory, setGlobalHistory] = useState<TelemetryPoint[]>([]);
  const [rebootingId, setRebootingId] = useState<string | null>(null);

  const [confirmConfig, setConfirmConfig] = useState<{
    title: string;
    description?: string;
    confirmText?: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  const handleReboot = async (nug: NugBox) => {
    setConfirmConfig({
      title: `Reboot "${nug.name}"?`,
      description: 'This will cause a brief offline period for this edge node.',
      confirmText: 'Reboot Node',
      onConfirm: async () => {
        setRebootingId(nug.pk_nug_id);
        try {
          await apiRequest(`/devices/nug-boxes/${nug.pk_nug_id}/reboot`, { method: 'POST', accessToken, scopeHeaders });
          toast.success(`Reboot command sent to ${nug.name}`);
        } catch {
          toast.error('Reboot command failed');
        } finally { setRebootingId(null); }
      },
    });
  };

  // Initialize from LocalStorage
  useEffect(() => {
    try {
      const savedGlobal = localStorage.getItem('pulse_global_history');
      const savedNodes = localStorage.getItem('pulse_node_history');
      if (savedGlobal) setGlobalHistory(JSON.parse(savedGlobal));
      if (savedNodes) setHistory(JSON.parse(savedNodes));
    } catch (e) {
       console.error("Failed to load hardware history", e);
    }
  }, []);

  // Persist to LocalStorage
  useEffect(() => {
    if (globalHistory.length > 0) {
      localStorage.setItem('pulse_global_history', JSON.stringify(globalHistory));
    }
    if (Object.keys(history).length > 0) {
      localStorage.setItem('pulse_node_history', JSON.stringify(history));
    }
  }, [globalHistory, history]);

  // Helper for filtering by time
  const getFilteredData = (data: TelemetryPoint[]) => {
    if (filterMode === 'All') return data;
    const windowSize = filterMode === 'Last Hour' ? 240 : 40; // 40 points = 10 mins at 15s avg
    return data.slice(-windowSize);
  };

  const fetchHistory = useCallback(async () => {
    try {
      const opts = { accessToken, scopeHeaders };
      const res = await apiRequest<{ history: Record<string, TelemetryPoint[]> }>('/devices/telemetry/history', opts);
      if (res.history) {
        // Merge with existing logic or replace blank history
        setHistory(prev => {
          const next = { ...prev };
          Object.keys(res.history).forEach(id => {
            // Fill up to 30 points, padding with blanks if needed
            const backendPoints = res.history[id];
            if (backendPoints.length < 30) {
              next[id] = [...createBlankHistory(30 - backendPoints.length), ...backendPoints];
            } else {
              next[id] = backendPoints.slice(-30);
            }
          });
          return next;
        });

        // Compute aggregate global history from the fetched points
        const allIds = Object.keys(res.history);
        if (allIds.length > 0) {
          const maxLen = 40;
          const combined: TelemetryPoint[] = [];
          
          // Use the first device's points as a template for time slots
          const firstId = allIds[0];
          const firstDevicePoints = res.history[firstId];
          
          firstDevicePoints.forEach((p, idx) => {
            let sumCpu = 0;
            let sumGpu = 0;
            let sumRam = 0;
            let sumTemp = 0;
            allIds.forEach(id => {
               const pt = res.history[id][idx];
                if (pt) {
                  sumCpu += pt.cpu;
                  sumGpu += pt.gpu;
                  sumRam += pt.ram;
                  sumTemp += (pt as any).temp || 0;
                }
            });
            combined.push({
              time: p.time,
              cpu: sumCpu / allIds.length,
              gpu: sumGpu / allIds.length,
              ram: sumRam / allIds.length,
              temp: sumTemp / allIds.length
            });
          });

          setGlobalHistory(combined.slice(-maxLen));
        }
      }
    } catch (e) {
      console.error('Failed to fetch telemetry history:', e);
    }
  }, [accessToken, scopeHeaders]);

  const updateHistory = useCallback((newNugs: NugBox[]) => {
    setHistory(prev => {
      const next = { ...prev };
      const currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      
      let totalCpu = 0;
      let totalGpu = 0;
      let totalRam = 0;
      let totalTemp = 0;
      let onlineCount = 0;

      newNugs.forEach(n => {
        const id = n.pk_nug_id;
        // Initialize device history with 30 blank points if not exists
        const currentPoints = next[id] || createBlankHistory(30);
        const ramPct = n.memory_used_mb && n.memory_total_mb ? (n.memory_used_mb / n.memory_total_mb) * 100 : 0;
        
        const newPoint: TelemetryPoint = {
          time: currentTime,
          cpu: n.cpu_percent ?? 0,
          gpu: n.gpu_percent ?? 0,
          ram: ramPct,
          temp: n.temperature_c ?? 0
        };
        
        if (n.status === 'online') {
          totalCpu += newPoint.cpu;
          totalGpu += newPoint.gpu;
          totalRam += newPoint.ram;
          totalTemp += newPoint.temp;
          onlineCount++;
        }

        const updatedPoints = [...currentPoints, newPoint];
        next[id] = updatedPoints.slice(-5000); // Cap at 5000 points (~20 hours)
      });

      // Update Global History (No slice beyond safety cap)
      const globalPoint: TelemetryPoint = {
        time: currentTime,
        cpu: onlineCount > 0 ? totalCpu / onlineCount : 0,
        gpu: onlineCount > 0 ? totalGpu / onlineCount : 0,
        ram: onlineCount > 0 ? totalRam / onlineCount : 0,
        temp: onlineCount > 0 ? totalTemp / onlineCount : 0
      };
      setGlobalHistory(g => [...g, globalPoint].slice(-5000));

      return next;
    });
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const opts = { accessToken, scopeHeaders };
      const res = await apiRequest<{ nug_boxes: NugBox[] }>('/devices/hierarchy', opts);
      if (res.nug_boxes) {
        setNugs(res.nug_boxes);
        updateHistory(res.nug_boxes);
      }
    } catch (e) {
      console.error('Failed to fetch hardware metrics:', e);
    } finally {
      setLoading(false);
    }
  }, [accessToken, scopeHeaders, updateHistory]);

  useEffect(() => {
    fetchData();
    fetchHistory();
  }, [fetchData, fetchHistory]);

  // Real-time listener (Optimized Delta Updates)
  useEffect(() => {
    const socket = (realtimeEngine as any).socket;
    if (!socket) return;
    
    const onSync = () => fetchData();
    const onDelta = (delta: any) => {
      // Map facility_device fields to NugBox fields
      setNugs(prev => prev.map(n => {
        if (n.pk_nug_id === delta.pk_device_id || n.device_code === delta.external_device_id) {
          return {
            ...n,
            status: delta.status || n.status,
            last_heartbeat: delta.last_active || n.last_heartbeat
          };
        }
        return n;
      }));
    };

    socket.on('deviceStatusUpdate', onSync);
    socket.on('deviceUpdate', onDelta);
    
    return () => {
      socket.off('deviceStatusUpdate', onSync);
      socket.off('deviceUpdate', onDelta);
    };
  }, [fetchData]);

  if (isLoading && nugs.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 text-blue-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* HEADER STATS */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="border-none shadow-sm bg-gradient-to-br from-blue-600 to-indigo-700 text-white">
          <CardContent className="p-6 flex items-center gap-4">
            <div className="p-3 bg-white/10 rounded-2xl backdrop-blur-md">
              <Zap className="w-6 h-6 text-blue-100" />
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-blue-100 opacity-80">Total Clusters</p>
              <h3 className="text-2xl font-black">{nugs.length} Monitoring Nodes</h3>
            </div>
          </CardContent>
        </Card>
        
        <Card className="border-none shadow-sm glass-card overflow-hidden">
          <CardContent className="p-6 flex items-center gap-4">
            <div className="p-3 bg-emerald-50 dark:bg-emerald-500/10 rounded-2xl">
              <ShieldCheck className="w-6 h-6 text-emerald-500" />
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-slate-400">Online Rate</p>
              <h3 className="text-2xl font-black text-slate-800 dark:text-slate-100">
                {Math.round((nugs.filter(n => n.status === 'online').length / (nugs.length || 1)) * 100)}%
              </h3>
            </div>
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm glass-card overflow-hidden">
          <CardContent className="p-6 flex items-center gap-4">
            <div className="p-3 bg-blue-50 dark:bg-blue-500/10 rounded-2xl">
              <Activity className="w-6 h-6 text-blue-500" />
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-slate-400">Total Capacity</p>
              <h3 className="text-2xl font-black text-slate-800 dark:text-slate-100">
                {(nugs.reduce((s, n) => s + (n.memory_total_mb || 0), 0) / 1024).toFixed(1)} GB RAM
              </h3>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* CLUSTER ANALYTICS CONTROLS */}
      <div className="flex flex-col md:flex-row gap-4 items-center justify-between glass-card p-4 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-800">
         <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 pr-4 border-r border-slate-100 dark:border-slate-800">
               <Layers className="w-4 h-4 text-blue-500" />
               <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">View Window</span>
            </div>
            {(['All', 'Last Hour', 'Last 10m'] as const).map(mode => (
              <button 
                key={mode} 
                onClick={() => setFilterMode(mode)}
                className={cn(
                  "px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-tighter transition-all",
                  filterMode === mode ? "bg-blue-600 text-white shadow-md" : "bg-slate-50 dark:bg-slate-800 text-slate-500 hover:bg-slate-100"
                )}
              >
                {mode}
              </button>
            ))}
         </div>

         <div className="flex items-center gap-3">
            <button 
              onClick={() => {
                localStorage.clear();
                setHistory({});
                setGlobalHistory([]);
              }}
              className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-rose-50 dark:bg-rose-950/20 text-rose-600 text-[10px] font-black uppercase tracking-tighter hover:bg-rose-100"
            >
              <RefreshCw className="w-3 h-3" /> Clear Pulse
            </button>
         </div>
      </div>

      {/* CLUSTER DYNAMICS - ANALYTICS GRID */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <ClusterTrendChart 
          title="Cluster CPU Activity (%)" 
          data={getFilteredData(globalHistory)} 
          dataKey="cpu" 
          color="#3b82f6" 
          type="area"
          domain={[0, 100]}
          showBrush={filterMode === 'All'}
        />
        <ClusterTrendChart 
          title="Cluster Thermal Pulse (°C)" 
          data={getFilteredData(globalHistory)} 
          dataKey="temp" 
          color="#f97316" 
          type="area" 
          domain={[0, 100]}
          showBrush={filterMode === 'All'}
        />
        <ClusterTrendChart 
          title="System Memory Pulse (%)" 
          data={getFilteredData(globalHistory)} 
          dataKey="ram" 
          color="#9333ea" 
          type="line" 
          domain={[0, 100]}
          showBrush={filterMode === 'All'}
        />
      </div>

      {/* NODE GRID */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {nugs.map((nug) => {
          const isOnline = nug.status === 'online';
          const isWarning = (nug.temperature_c || 0) > 75 || (nug.cpu_percent || 0) > 90;

          return (
            <Card key={nug.pk_nug_id} className="border-none shadow-lg glass-card overflow-hidden group">
              <CardHeader className="bg-slate-50/50 dark:bg-slate-800/30 py-4 px-6 border-b border-slate-100 dark:border-slate-800 flex flex-row items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "p-2 rounded-xl flex items-center justify-center transition-colors",
                    isOnline ? "bg-blue-50 text-blue-600 dark:bg-blue-500/10" : "bg-slate-100 text-slate-500 dark:bg-slate-800"
                  )}>
                    <Cpu className="w-5 h-5" />
                  </div>
                  <div>
                    <CardTitle className="text-sm font-black text-slate-800 dark:text-slate-100">{nug.name}</CardTitle>
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{nug.location_label || 'Unassigned Zone'}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge className={cn(
                    "rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-widest border-none shadow-sm",
                    isOnline ? "bg-emerald-500 text-white" : "bg-slate-400 text-white"
                  )}>
                    {nug.status}
                  </Badge>
                  <button
                    title="Reboot device"
                    disabled={rebootingId === nug.pk_nug_id}
                    onClick={() => handleReboot(nug)}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors disabled:opacity-40"
                  >
                    {rebootingId === nug.pk_nug_id
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : <RotateCcw className="w-4 h-4" />}
                  </button>
                </div>
              </CardHeader>
              <CardContent className="p-6">
                {!isOnline ? (
                   <div className="flex flex-col items-center justify-center py-8 gap-3 opacity-40">
                      <AlertCircle className="w-10 h-10 text-slate-400" />
                      <p className="text-xs font-black uppercase tracking-widest text-slate-500">Node Connectivity Lost</p>
                   </div>
                ) : (
                  <div className="space-y-6">
                    {/* KEY RINGS */}
                    <div className="flex items-center justify-between px-2">
                        <MetricRing label="CPU" value={nug.cpu_percent} color="stroke-blue-500" size={70} />
                        <MetricRing label="GPU" value={nug.gpu_percent} color="stroke-indigo-500" size={70} />
                        <div className="flex flex-col items-center gap-1">
                          <div className="w-[70px] h-[70px] rounded-full border-4 border-slate-100 dark:border-slate-800 flex items-center justify-center">
                            <Thermometer className={cn("w-6 h-6", isWarning ? "text-rose-500 animate-pulse" : "text-amber-500")} />
                          </div>
                          <span className="text-[10px] font-black text-slate-700 dark:text-slate-300">{fmtTemp(nug.temperature_c)}</span>
                          <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400">Temp</span>
                        </div>
                        <MetricRing label={`RAM`} value={nug.memory_used_mb && nug.memory_total_mb ? (nug.memory_used_mb/nug.memory_total_mb)*100 : null} color="stroke-emerald-500" size={70} />
                    </div>

                    {/* LIVE TREND SPARKLINE */}
                    <div className="grid grid-cols-3 gap-2 px-2 py-1 bg-slate-50/50 dark:bg-slate-800/30 rounded-2xl border border-slate-100/50 dark:border-slate-800/50">
                       <div className="flex flex-col gap-1">
                          <PulseSparkline id={nug.pk_nug_id} data={history[nug.pk_nug_id] || []} dataKey="cpu" color="#3b82f6" />
                          <span className="text-[8px] font-black uppercase text-center text-blue-500 opacity-60">CPU Trend</span>
                       </div>
                       <div className="flex flex-col gap-1">
                          <PulseSparkline id={nug.pk_nug_id} data={history[nug.pk_nug_id] || []} dataKey="gpu" color="#6366f1" />
                          <span className="text-[8px] font-black uppercase text-center text-indigo-500 opacity-60">GPU Trend</span>
                       </div>
                       <div className="flex flex-col gap-1">
                          <PulseSparkline id={nug.pk_nug_id} data={history[nug.pk_nug_id] || []} dataKey="ram" color="#10b981" />
                          <span className="text-[8px] font-black uppercase text-center text-emerald-500 opacity-60">RAM Trend</span>
                       </div>
                    </div>

                    {/* DETAILED LEDGER */}
                    <div className="grid grid-cols-2 gap-x-8 gap-y-4 pt-4 border-t border-slate-50 dark:border-slate-800/50">
                      <div className="flex items-center gap-3">
                        <MemoryStick className="w-4 h-4 text-slate-400" />
                        <div className="min-w-0">
                          <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Memory Context</p>
                          <p className="text-xs font-bold text-slate-700 dark:text-slate-300 truncate">{fmtMem(nug.memory_used_mb, nug.memory_total_mb)}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <Activity className="w-4 h-4 text-slate-400" />
                        <div className="min-w-0">
                          <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Active Pulse</p>
                          <p className="text-xs font-bold text-slate-700 dark:text-slate-300 truncate">{fmtUptime(nug.uptime_seconds)} Uptime</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <HardDrive className="w-4 h-4 text-slate-400" />
                        <div className="min-w-0">
                          <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Storage Mass</p>
                          <p className="text-xs font-bold text-slate-700 dark:text-slate-300 truncate">{nug.disk_used_gb != null ? `${Number(nug.disk_used_gb).toFixed(1)} GB Used` : '—'}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <Network className="w-4 h-4 text-slate-400" />
                        <div className="min-w-0">
                          <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Node Path</p>
                          <p className="text-xs font-bold text-slate-700 dark:text-slate-300 truncate truncate">{nug.ip_address}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
              {isOnline && (
                <div className="h-1 w-full bg-slate-50 dark:bg-slate-800">
                   <div className={cn("h-full transition-all duration-1000", isWarning ? "bg-rose-500" : "bg-blue-500")} style={{width: `${nug.cpu_percent || 0}%`}} />
                </div>
              )}
            </Card>
          );
        })}
      </div>
      
      {nugs.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 glass-card rounded-3xl border-2 border-dashed border-slate-200 dark:border-slate-800">
           <Layers className="w-12 h-12 text-slate-300 mb-4" />
           <p className="text-sm font-black text-slate-400 uppercase tracking-widest">No hardware nodes detected in hierarchy</p>
        </div>
      )}
      {/* Centered Popup Modal */}
      {confirmConfig && (
        <ConfirmModal
          isOpen={true}
          onClose={() => setConfirmConfig(null)}
          title={confirmConfig.title}
          description={confirmConfig.description}
          confirmText={confirmConfig.confirmText || 'Confirm'}
          onConfirm={confirmConfig.onConfirm}
        />
      )}
    </div>
  );
};
