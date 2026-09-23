import React, { useState, useEffect, useCallback } from "react";
import {
  AlertTriangle, Bell, BellOff, CheckCircle, ChevronRight,
  RefreshCw, Shield, Wifi, Camera, Server, Eye
} from "lucide-react";
import { apiRequest } from "../../../../services/http/apiClient";
import { realtimeEngine } from "../../../../engine/RealTimeEngine";

/* ── types ── */
interface Alert {
  pk_alert_id: number;
  alert_type: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  description: string | null;
  entity_type: string | null;
  entity_id: string | null;
  snapshot_url: string | null;
  status: "open" | "acknowledged" | "resolved" | "dismissed";
  acknowledged_by_name: string | null;
  assigned_to_name: string | null;
  created_at: string;
}

interface AlertStats {
  critical_open: number;
  high_open: number;
  medium_open: number;
  low_open: number;
  total_open: number;
  total_acknowledged: number;
  total_resolved: number;
}

/* ── helpers ── */
const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400 border-red-200 dark:border-red-800",
  high:     "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400 border-orange-200 dark:border-orange-800",
  medium:   "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800",
  low:      "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400 border-blue-200 dark:border-blue-800",
};

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-red-600", high: "bg-orange-500", medium: "bg-yellow-500", low: "bg-blue-500",
};

const TYPE_ICON: Record<string, React.ReactNode> = {
  intrusion:       <Shield className="w-4 h-4" />,
  unknown_person:  <Eye className="w-4 h-4" />,
  offline_device:  <Wifi className="w-4 h-4" />,
  low_confidence:  <Camera className="w-4 h-4" />,
  system_error:    <Server className="w-4 h-4" />,
  watchlist_hit:   <AlertTriangle className="w-4 h-4" />,
};

function timeAgo(iso: string) {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

const TABS = ["all", "critical", "high", "open", "acknowledged", "resolved"] as const;
type Tab = typeof TABS[number];

/* ── component ── */
export default function AlertCenterPage() {
  const [alerts, setAlerts]   = useState<Alert[]>([]);
  const [stats, setStats]     = useState<AlertStats | null>(null);
  const [tab, setTab]         = useState<Tab>("all");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const fetchAlerts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (tab === "critical" || tab === "high") params.set("severity", tab);
      else if (tab === "open" || tab === "acknowledged" || tab === "resolved") params.set("status", tab);

      const [alertsData, statsData] = await Promise.all([
        apiRequest<{ alerts: Alert[] }>(`/api/alerts?${params}`),
        apiRequest<AlertStats>("/api/alerts/stats"),
      ]);
      setAlerts(alertsData.alerts);
      setStats(statsData);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { void fetchAlerts(); }, [fetchAlerts]);

  // Real-time new alerts
  useEffect(() => {
    const socket = realtimeEngine.getSocket?.();
    if (!socket) return;
    const handler = (alert: Alert) => {
      setAlerts(prev => [alert, ...prev]);
      setStats(prev => prev ? { ...prev, total_open: prev.total_open + 1 } : prev);
    };
    socket.on("alert:new", handler);
    return () => { socket.off("alert:new", handler); };
  }, []);

  async function doAction(id: number, action: "acknowledge" | "resolve" | "dismiss") {
    await apiRequest(`/api/alerts/${id}/${action}`, { method: "PATCH" });
    setAlerts(prev => prev.map(a =>
      a.pk_alert_id === id
        ? { ...a, status: action === "acknowledge" ? "acknowledged" : action === "resolve" ? "resolved" : "dismissed" }
        : a
    ));
  }

  async function bulkAcknowledge() {
    await Promise.all([...selected].map(id => doAction(id, "acknowledge")));
    setSelected(new Set());
  }

  const toggleSelect = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bell className="w-6 h-6 text-primary" /> Alert Center
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">Real-time security and system alerts</p>
        </div>
        <button onClick={fetchAlerts} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {/* Stats bar */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {(["critical","high","medium","low"] as const).map(s => (
            <div key={s} className={`rounded-xl p-3 border ${SEVERITY_STYLES[s]}`}>
              <div className="flex items-center gap-2">
                <span className={`w-2.5 h-2.5 rounded-full ${SEVERITY_DOT[s]}`} />
                <span className="text-xs font-semibold uppercase tracking-wide">{s}</span>
              </div>
              <p className="text-2xl font-bold mt-1">
                {s === "critical" ? stats.critical_open : s === "high" ? stats.high_open : s === "medium" ? stats.medium_open : stats.low_open}
              </p>
              <p className="text-xs opacity-70">open</p>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-sm font-medium capitalize border-b-2 transition-colors ${
              tab === t ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Bulk actions */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 bg-primary/10 border border-primary/20 rounded-lg px-4 py-2.5">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <button onClick={bulkAcknowledge} className="text-sm text-primary hover:underline flex items-center gap-1">
            <CheckCircle className="w-4 h-4" /> Acknowledge all
          </button>
          <button onClick={() => setSelected(new Set())} className="text-sm text-muted-foreground hover:text-foreground ml-auto">
            Clear selection
          </button>
        </div>
      )}

      {/* Alert list */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 rounded-xl bg-muted animate-pulse" />
          ))}
        </div>
      ) : alerts.length === 0 ? (
        <div className="text-center py-16">
          <BellOff className="w-12 h-12 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-muted-foreground font-medium">No alerts</p>
          <p className="text-sm text-muted-foreground/60 mt-1">System is operating normally</p>
        </div>
      ) : (
        <div className="space-y-2">
          {alerts.map(alert => (
            <div
              key={alert.pk_alert_id}
              className={`flex items-start gap-3 p-4 rounded-xl border transition-all ${
                alert.status === "open" ? "bg-card border-border" : "bg-muted/50 border-border/50 opacity-75"
              } ${selected.has(alert.pk_alert_id) ? "ring-2 ring-primary" : ""}`}
            >
              {/* Checkbox */}
              {alert.status === "open" && (
                <input
                  type="checkbox"
                  checked={selected.has(alert.pk_alert_id)}
                  onChange={() => toggleSelect(alert.pk_alert_id)}
                  className="mt-1 rounded"
                />
              )}

              {/* Severity dot */}
              <span className={`w-2.5 h-2.5 rounded-full mt-1.5 shrink-0 ${SEVERITY_DOT[alert.severity]}`} />

              {/* Type icon */}
              <span className="text-muted-foreground mt-0.5 shrink-0">
                {TYPE_ICON[alert.alert_type] ?? <Bell className="w-4 h-4" />}
              </span>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className={`inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full border mr-2 ${SEVERITY_STYLES[alert.severity]}`}>
                      {alert.severity}
                    </span>
                    <span className="font-medium text-sm">{alert.title}</span>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">{timeAgo(alert.created_at)}</span>
                </div>
                {alert.description && (
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{alert.description}</p>
                )}
                {alert.assigned_to_name && (
                  <p className="text-xs text-muted-foreground mt-0.5">Assigned: {alert.assigned_to_name}</p>
                )}
              </div>

              {/* Actions */}
              {alert.status === "open" && (
                <div className="flex gap-1.5 shrink-0">
                  <button
                    onClick={() => doAction(alert.pk_alert_id, "acknowledge")}
                    className="text-xs px-2.5 py-1 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                  >
                    Ack
                  </button>
                  <button
                    onClick={() => doAction(alert.pk_alert_id, "resolve")}
                    className="text-xs px-2.5 py-1 rounded-lg bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 transition-colors"
                  >
                    Resolve
                  </button>
                  <button
                    onClick={() => doAction(alert.pk_alert_id, "dismiss")}
                    className="text-xs px-2.5 py-1 rounded-lg bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Dismiss
                  </button>
                </div>
              )}
              {alert.status !== "open" && (
                <span className={`text-xs px-2.5 py-1 rounded-full font-medium shrink-0 ${
                  alert.status === "resolved" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" :
                  alert.status === "acknowledged" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" :
                  "bg-muted text-muted-foreground"
                }`}>
                  {alert.status}
                </span>
              )}
              <ChevronRight className="w-4 h-4 text-muted-foreground/40 shrink-0 mt-1" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
