import React, { useState, useEffect } from "react";
import { X, MessageSquare, CheckCircle, XCircle, Loader2, Clock, User, Tag } from "lucide-react";
import { apiRequest, ApiError } from "../../../../services/http/apiClient";
import { toast } from "sonner";

interface TimelineEntry {
  pk_timeline_id: number;
  action: string;
  old_value: string | null;
  new_value: string | null;
  comment: string | null;
  user_name: string | null;
  created_at: string;
}

interface IncidentDetail {
  pk_incident_id: number;
  incident_number: string;
  title: string;
  description: string | null;
  incident_type: string;
  severity: string;
  status: string;
  reporter_name: string | null;
  assigned_to_name: string | null;
  tags: string[];
  created_at: string;
  resolved_at: string | null;
  timeline: TimelineEntry[];
}

interface Props {
  incidentId: number;
  onClose: () => void;
  onUpdated: () => void;
}

const STATUS_COLOR: Record<string, string> = {
  open:           "text-blue-600",
  investigating:  "text-orange-600",
  resolved:       "text-green-600",
  closed:         "text-gray-500",
};

const ACTION_ICONS: Record<string, React.ReactNode> = {
  created:        <CheckCircle className="w-3.5 h-3.5 text-green-500" />,
  status_changed: <XCircle className="w-3.5 h-3.5 text-orange-500" />,
  comment:        <MessageSquare className="w-3.5 h-3.5 text-blue-500" />,
  assigned:       <User className="w-3.5 h-3.5 text-purple-500" />,
};

function fmt(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function IncidentDetailDrawer({ incidentId, onClose, onUpdated }: Props) {
  const [incident, setIncident] = useState<IncidentDetail | null>(null);
  const [loading, setLoading]   = useState(true);
  const [comment, setComment]   = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    try {
      const data = await apiRequest<IncidentDetail>(`/api/incidents/${incidentId}`);
      setIncident(data);
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [incidentId]);

  async function changeStatus(status: string) {
    if (!incident) return;
    await apiRequest(`/api/incidents/${incidentId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    onUpdated();
    void load();
  }

  async function addComment(e: React.FormEvent) {
    e.preventDefault();
    if (!comment.trim()) return;
    setSubmitting(true);
    try {
      await apiRequest(`/api/incidents/${incidentId}/comments`, {
        method: "POST",
        body: JSON.stringify({ comment }),
      });
      setComment("");
      void load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to add comment");
    } finally { setSubmitting(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/30" onClick={onClose} />
      <div className="w-full max-w-xl bg-card border-l border-border flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-border">
          <div>
            {loading ? (
              <div className="h-5 w-48 bg-muted rounded animate-pulse" />
            ) : incident ? (
              <>
                <p className="text-xs font-mono text-muted-foreground mb-1">{incident.incident_number}</p>
                <h2 className="font-semibold text-lg leading-tight">{incident.title}</h2>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`text-sm font-medium capitalize ${STATUS_COLOR[incident.status]}`}>{incident.status}</span>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="text-sm text-muted-foreground capitalize">{incident.severity}</span>
                </div>
              </>
            ) : null}
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground mt-0.5"><X className="w-5 h-5" /></button>
        </div>

        {loading ? (
          <div className="flex-1 p-5 space-y-3">
            {Array.from({length: 4}).map((_, i) => <div key={i} className="h-12 bg-muted rounded animate-pulse" />)}
          </div>
        ) : incident ? (
          <div className="flex-1 overflow-y-auto">
            {/* Meta */}
            <div className="p-5 space-y-3 border-b border-border">
              {incident.description && <p className="text-sm text-muted-foreground">{incident.description}</p>}
              <div className="grid grid-cols-2 gap-2 text-sm">
                {incident.reporter_name && (
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <User className="w-3.5 h-3.5" /> Reporter: <span className="text-foreground">{incident.reporter_name}</span>
                  </div>
                )}
                {incident.assigned_to_name && (
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <User className="w-3.5 h-3.5" /> Assigned: <span className="text-foreground">{incident.assigned_to_name}</span>
                  </div>
                )}
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Clock className="w-3.5 h-3.5" /> Created: <span className="text-foreground">{fmt(incident.created_at)}</span>
                </div>
              </div>
              {incident.tags.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Tag className="w-3.5 h-3.5 text-muted-foreground" />
                  {incident.tags.map(t => (
                    <span key={t} className="text-xs px-2 py-0.5 bg-muted rounded-full text-muted-foreground">{t}</span>
                  ))}
                </div>
              )}
            </div>

            {/* Status actions */}
            {!["resolved","closed"].includes(incident.status) && (
              <div className="p-5 border-b border-border">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Update Status</p>
                <div className="flex gap-2 flex-wrap">
                  {incident.status === "open" && (
                    <button onClick={() => changeStatus("investigating")}
                      className="px-3 py-1.5 text-sm rounded-lg bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 font-medium">
                      Start Investigating
                    </button>
                  )}
                  <button onClick={() => changeStatus("resolved")}
                    className="px-3 py-1.5 text-sm rounded-lg bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 font-medium">
                    Mark Resolved
                  </button>
                  <button onClick={() => changeStatus("closed")}
                    className="px-3 py-1.5 text-sm rounded-lg bg-muted text-muted-foreground font-medium">
                    Close
                  </button>
                </div>
              </div>
            )}

            {/* Timeline */}
            <div className="p-5 space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Timeline</p>
              <div className="space-y-3">
                {incident.timeline.map(entry => (
                  <div key={entry.pk_timeline_id} className="flex gap-2.5">
                    <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                      {ACTION_ICONS[entry.action] ?? <Clock className="w-3.5 h-3.5 text-muted-foreground" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">
                          {entry.user_name ?? "System"}
                        </span>
                        <span className="text-xs text-muted-foreground shrink-0">{fmt(entry.created_at)}</span>
                      </div>
                      {entry.comment && <p className="text-sm text-muted-foreground mt-0.5">{entry.comment}</p>}
                      {entry.new_value && !entry.comment && (
                        <p className="text-sm text-muted-foreground mt-0.5">{entry.new_value}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {/* Add comment */}
        <div className="p-4 border-t border-border">
          <form onSubmit={addComment} className="flex gap-2">
            <input
              value={comment} onChange={e => setComment(e.target.value)}
              placeholder="Add a comment…"
              className="flex-1 border border-border rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <button type="submit" disabled={!comment.trim() || submitting}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 flex items-center gap-1.5">
              {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Post
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
