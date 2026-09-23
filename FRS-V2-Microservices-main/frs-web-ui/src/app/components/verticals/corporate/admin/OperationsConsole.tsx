import React, { useState, useEffect, useRef } from 'react';
import { Badge } from '../../../ui/badge';
import { Activity, LayoutDashboard, Zap, Bell, AlertTriangle, Flame, Thermometer, Wifi, Grid3x3 } from 'lucide-react';
import { cn } from '../../../ui/utils';
import { lightTheme } from '../../../../../theme/lightTheme';
import { PageHeader } from '../../../shared/PageHeader';
import { FacilityIntelligenceDashboard } from './FacilityIntelligenceDashboard';
import { HardwareMetricsDashboard } from './HardwareMetricsDashboard';
import { DeviceActivityHeatmap } from '../hr/DeviceActivityHeatmap';
import { useApiData } from '../../../../hooks/useApiData';
import { realtimeEngine, RteEventType } from '../../../../engine/RealTimeEngine';

type AlertFeedItem = {
    id: string; deviceName: string; type: string;
    severity: string; message: string; timestamp: string;
};

const SEVERITY_STYLES: Record<string, string> = {
    Critical: 'bg-rose-100 text-rose-700 border-rose-200',
    High:     'bg-orange-100 text-orange-700 border-orange-200',
    Medium:   'bg-amber-100 text-amber-700 border-amber-200',
    Low:      'bg-blue-100 text-blue-700 border-blue-200',
};

const alertTypeIcon = (type: string) => {
    if (type === 'Overheating') return <Thermometer className="w-4 h-4 text-rose-500" />;
    if (type === 'Offline')     return <Wifi className="w-4 h-4 text-slate-400" />;
    return <AlertTriangle className="w-4 h-4 text-amber-500" />;
};

export const OperationsConsole: React.FC = () => {
    const [activeSubTab, setActiveSubTab] = useState('facility');
    const { devices } = useApiData({ autoRefreshMs: 30000 });
    const onlineCount = devices.filter(d => d.status === 'online').length;
    const isLive = onlineCount > 0;

    // ── Live device alert feed ────────────────────────────────────────────────
    const [alertFeed, setAlertFeed] = useState<AlertFeedItem[]>([]);
    const alertFeedRef = useRef<AlertFeedItem[]>([]);
    useEffect(() => {
        const unsub = realtimeEngine.subscribe(RteEventType.DEVICE_ALERT, (alert: any) => {
            alertFeedRef.current = [alert, ...alertFeedRef.current].slice(0, 50);
            setAlertFeed([...alertFeedRef.current]);
        });
        return () => unsub();
    }, []);

    const subTabs = [
        { id: 'facility', label: 'Intelligence', icon: LayoutDashboard, desc: 'Facility Insights' },
        { id: 'metrics',  label: 'Pulse',        icon: Zap,             desc: 'Hardware Health'  },
        { id: 'activity', label: 'Activity',     icon: Grid3x3,         desc: 'Device Punch Heatmap' },
        { id: 'alerts',   label: 'Alerts',       icon: Bell,            desc: 'Live Device Alerts', badge: alertFeed.length || undefined },
    ];

    const renderSubContent = () => {
        switch (activeSubTab) {
            case 'facility': return <FacilityIntelligenceDashboard />;
            case 'metrics':  return <HardwareMetricsDashboard />;
            case 'activity': return <DeviceActivityHeatmap />;
            case 'alerts':   return (
                <div className="space-y-3">
                    <div className="flex items-center gap-2">
                        <Flame className="w-4 h-4 text-rose-500 animate-pulse" />
                        <span className={cn("text-sm font-bold", lightTheme.text.primary)}>Live Device Alerts</span>
                        <span className={cn("text-xs", lightTheme.text.muted)}>— last 50 events, newest first</span>
                    </div>
                    {alertFeed.length === 0 ? (
                        <div className={cn("h-40 flex flex-col items-center justify-center gap-2 bg-white dark:bg-slate-900 rounded-2xl border dark:border-slate-800", lightTheme.text.muted, lightTheme.border.default)}>
                            <Bell className="w-8 h-8 opacity-30" />
                            <p className="text-sm">No device alerts yet — monitoring…</p>
                        </div>
                    ) : (
                        <div className="space-y-2 max-h-[560px] overflow-y-auto pr-1">
                            {alertFeed.map((a, i) => (
                                <div className={cn("flex items-start gap-3 p-3 bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-800 shadow-sm", lightTheme.border.default)} key={a.id ?? i}>
                                    <div className={cn("w-8 h-8 rounded-lg border flex items-center justify-center flex-shrink-0", lightTheme.table.header, lightTheme.border.default)}>
                                        {alertTypeIcon(a.type)}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className={cn("text-sm font-bold", lightTheme.text.primary)}>{a.deviceName}</span>
                                            <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full border', SEVERITY_STYLES[a.severity] ?? SEVERITY_STYLES.Low)}>
                                                {a.severity}
                                            </span>
                                            <span className={cn("text-[10px] font-mono px-1.5 py-0.5 rounded", lightTheme.text.muted, lightTheme.table.header)}>{a.type}</span>
                                        </div>
                                        <p className={cn("text-xs mt-0.5 truncate", lightTheme.text.secondary)}>{a.message}</p>
                                    </div>
                                    <span className={cn("text-[10px] flex-shrink-0 pt-0.5", lightTheme.text.muted)}>
                                        {new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            );
            default: return null;
        }
    };

    return (
        <div className="space-y-6">
            {/* PAGE HEADER */}
            <PageHeader
                title="Operations Control"
                icon={LayoutDashboard}
                subtitle="Facility Management & Edge Telemetry"
                actions={
                   <Badge className={cn(
                     "border-none font-black text-[9px] px-3 py-1 uppercase tracking-tighter",
                     isLive ? "bg-blue-50 text-blue-600" : "bg-slate-100 text-slate-400"
                   )}>
                     <Activity className={cn("w-3 h-3 mr-1.5", isLive && "animate-pulse")} />
                     {isLive ? `${onlineCount} Node${onlineCount !== 1 ? 's' : ''} Live` : 'No Nodes Online'}
                   </Badge>
                }
            />

            {/* FLOATING SUB-NAV */}
            <div className="flex flex-wrap items-center gap-3 p-1.5 bg-slate-100/50 backdrop-blur-sm rounded-2xl w-fit border border-slate-200/50">
                {subTabs.map((tab) => (
                    <button
                        key={tab.id}
                        onClick={() => setActiveSubTab(tab.id)}
                        className={cn(
                            "flex items-center gap-3 px-5 py-2.5 rounded-xl transition-all duration-300 group",
                            activeSubTab === tab.id
                                ? "bg-white dark:bg-slate-900 shadow-[0_10px_25px_-5px_rgba(59,130,246,0.2)] border border-blue-100 dark:border-blue-900"
                                : "hover:bg-white/50 dark:hover:bg-slate-800/30"
                        )}
                    >
                        <div className={cn(
                            "p-1.5 rounded-lg transition-colors",
                            activeSubTab === tab.id ? "bg-blue-600 text-white" : "bg-slate-200 dark:bg-slate-800 text-slate-500 group-hover:bg-slate-300"
                        )}>
                            <tab.icon className="w-4 h-4" />
                        </div>
                        <div className="flex flex-col items-start text-left">
                            <span className={cn("text-xs font-black tracking-tight flex items-center gap-1.5", activeSubTab === tab.id ? "text-slate-800 dark:text-slate-100" : "text-slate-500 dark:text-slate-400")}>
                                {tab.label}
                                {(tab as any).badge ? (
                                    <span className="text-[9px] font-black bg-rose-500 text-white px-1.5 py-0.5 rounded-full leading-none">
                                        {(tab as any).badge}
                                    </span>
                                ) : null}
                            </span>
                            <span className="text-[9px] font-bold text-slate-400 uppercase tracking-tighter leading-none">
                                {tab.desc}
                            </span>
                        </div>
                    </button>
                ))}
            </div>

            {/* CONTENT AREA */}
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
                {renderSubContent()}
            </div>
        </div>
    );
};
