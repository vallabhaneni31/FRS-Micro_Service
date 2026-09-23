import React, { useState, useEffect, useCallback } from "react";
import { Plus, RefreshCw, ChevronRight, AlertTriangle, Clock, User } from "lucide-react";
import { apiRequest } from "../../../../services/http/apiClient";
import CreateIncidentModal from "./CreateIncidentModal";
import IncidentDetailDrawer from "./IncidentDetailDrawer";

interface Incident {
  pk_incident_id: number;
  incident_number: string;
  title: string;
  incident_type: string;
  severity: "critical" | "high" | "medium" | "low";
  status: "open" | "investigating" | "resolved" | "closed";
  reporter_name: string | null;
  assigned_to_name: string | null;
  created_at: string;
  tags: string[];
}

const SEVERITY_BADGE: Record<string, string> = {
  critical: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
  high:     "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400",
  medium:   "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400",
  low:      "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
};

const STATUS_BADGE: Record<string, string> = {
  open:          "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
  investigating: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400",
  resolved:      "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400",
  closed:        "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

function timeAgo(iso: string) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / 1440)}d ago`;
}

const TYPE_LABELS: Record<string, string> = {
  security_breach:    "Security Breach",
  attendance_anomaly: "Attendance Anomaly",
  device_failure:     "Device Failure",
  unauthorized_access:"Unauthorized Access",
  tailgating:         "Tailgating",
  other:              "Other",
};

export default function IncidentListPage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading]     = useState(true);
  const [status, setStatus]       = useState("");
  const [severity, setSeverity]   = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const [page, setPage]           = useState(1);
  const PER = 10;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (status)   params.set("status", status);
      if (severity) params.set("severity", severity);
      const data = await apiRequest<{ incidents: Incident[] }>(`/api/incidents?${params}`);
      setIncidents(data.incidents);
    } finally { setLoading(false); }
  }, [status, severity]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setPage(1); }, [status, severity]);

  const total = incidents.length;
  const pages = Math.ceil(total / PER);
  const pagedIncidents = incidents.slice((page - 1) * PER, page * PER);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <AlertTriangle className="w-6 h-6 text-orange-500" /> Incident Management
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">Track and resolve security incidents</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-2 text-muted-foreground hover:text-foreground rounded-lg">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold"
          >
            <Plus className="w-4 h-4" /> New Incident
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        {["", "open", "investigating", "resolved", "closed"].map(s => (
          <button key={s} onClick={() => setStatus(s)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              status === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
            }`}>
            {s || "All Status"}
          </button>
        ))}
        <div className="w-px bg-border mx-1" />
        {["", "critical", "high", "medium", "low"].map(s => (
          <button key={s} onClick={() => setSeverity(s)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              severity === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
            }`}>
            {s || "All Severity"}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              {["#", "Title", "Type", "Severity", "Status", "Assigned To", "Created", ""].map(h => (
                <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}><td colSpan={8} className="px-4 py-3"><div className="h-5 bg-muted rounded animate-pulse" /></td></tr>
              ))
            ) : pagedIncidents.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">No incidents found</td></tr>
            ) : pagedIncidents.map(inc => (
              <tr
                key={inc.pk_incident_id}
                className="hover:bg-muted/30 cursor-pointer transition-colors"
                onClick={() => setSelectedId(inc.pk_incident_id)}
              >
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{inc.incident_number || `INC-${inc.pk_incident_id}`}</td>
                <td className="px-4 py-3 font-medium max-w-xs truncate">{inc.title}</td>
                <td className="px-4 py-3 text-muted-foreground">{TYPE_LABELS[inc.incident_type] ?? inc.incident_type}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-semibold capitalize ${SEVERITY_BADGE[inc.severity]}`}>
                    {inc.severity}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-semibold capitalize ${STATUS_BADGE[inc.status]}`}>
                    {inc.status}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {inc.assigned_to_name
                    ? <span className="flex items-center gap-1 text-muted-foreground"><User className="w-3.5 h-3.5" />{inc.assigned_to_name}</span>
                    : <span className="text-muted-foreground/40">—</span>}
                </td>
                <td className="px-4 py-3">
                  <span className="flex items-center gap-1 text-muted-foreground text-xs"><Clock className="w-3.5 h-3.5" />{timeAgo(inc.created_at)}</span>
                </td>
                <td className="px-4 py-3"><ChevronRight className="w-4 h-4 text-muted-foreground/40" /></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      {/* Pagination Controls */}
      {total > PER && (
        <div className="flex items-center justify-between px-4 py-3 bg-muted/20 border border-border rounded-xl">
          <p className="text-xs text-muted-foreground">
            Showing {Math.min((page - 1) * PER + 1, total)}–{Math.min(page * PER, total)} of {total} incidents
          </p>
          <div className="flex gap-1">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1 rounded text-xs text-muted-foreground border border-border hover:bg-accent/40 disabled:opacity-40 transition-colors"
            >
              Prev
            </button>
            {Array.from({ length: pages }).map((_, i) => (
              <button
                key={i + 1}
                onClick={() => setPage(i + 1)}
                className={`px-3 py-1 rounded text-xs font-bold transition-colors ${
                  page === i + 1
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground border border-border hover:bg-accent/40"
                }`}
              >
                {i + 1}
              </button>
            ))}
            <button
              onClick={() => setPage(p => Math.min(pages, p + 1))}
              disabled={page >= pages}
              className="px-3 py-1 rounded text-xs text-muted-foreground border border-border hover:bg-accent/40 disabled:opacity-40 transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {showCreate && (
        <CreateIncidentModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); void load(); }}
        />
      )}
      {selectedId !== null && (
        <IncidentDetailDrawer
          incidentId={selectedId}
          onClose={() => setSelectedId(null)}
          onUpdated={() => void load()}
        />
      )}
    </div>
  );
}
