import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, AlertTriangle, Loader2 } from "lucide-react";
import { apiRequest, ApiError } from "../../../../services/http/apiClient";

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

const TYPES = [
  { value: "security_breach",    label: "Security Breach" },
  { value: "attendance_anomaly", label: "Attendance Anomaly" },
  { value: "device_failure",     label: "Device Failure" },
  { value: "unauthorized_access",label: "Unauthorized Access" },
  { value: "tailgating",         label: "Tailgating" },
  { value: "other",              label: "Other" },
];

export default function CreateIncidentModal({ onClose, onCreated }: Props) {
  const [title, setTitle]           = useState("");
  const [type, setType]             = useState("other");
  const [severity, setSeverity]     = useState("medium");
  const [description, setDesc]      = useState("");
  const [tags, setTags]             = useState("");
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) { setError("Title is required"); return; }
    setLoading(true); setError("");
    try {
      await apiRequest("/api/incidents", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          incidentType: type,
          severity,
          description: description.trim() || undefined,
          tags: tags.split(",").map(t => t.trim()).filter(Boolean),
        }),
      });
      onCreated();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to create incident");
    } finally { setLoading(false); }
  }

  return (
    <Dialog.Root open onOpenChange={v => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50 backdrop-blur-sm" />
        <Dialog.Content className="fixed inset-0 flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-lg p-6">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-orange-500" />
                <Dialog.Title className="text-lg font-semibold">New Incident</Dialog.Title>
              </div>
              <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
            </div>

            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Title *</label>
                <input
                  value={title} onChange={e => setTitle(e.target.value)}
                  placeholder="Brief description of the incident"
                  className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium mb-1">Type</label>
                  <select value={type} onChange={e => setType(e.target.value)}
                    className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm">
                    {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Severity</label>
                  <select value={severity} onChange={e => setSeverity(e.target.value)}
                    className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm">
                    {["critical","high","medium","low"].map(s => (
                      <option key={s} value={s} className="capitalize">{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Description</label>
                <textarea
                  value={description} onChange={e => setDesc(e.target.value)}
                  rows={3} placeholder="Detailed description..."
                  className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Tags <span className="text-muted-foreground text-xs">(comma-separated)</span></label>
                <input
                  value={tags} onChange={e => setTags(e.target.value)}
                  placeholder="cctv, zone-a, shift-2"
                  className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={onClose}
                  className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted">
                  Cancel
                </button>
                <button type="submit" disabled={loading}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50">
                  {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                  Create Incident
                </button>
              </div>
            </form>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
