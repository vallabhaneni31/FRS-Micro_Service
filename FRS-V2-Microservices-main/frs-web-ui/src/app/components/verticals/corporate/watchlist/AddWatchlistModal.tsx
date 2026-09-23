import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Shield, Loader2 } from "lucide-react";
import { apiRequest, ApiError } from "../../../../services/http/apiClient";

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

const CATEGORIES = [
  { value: "general",    label: "General" },
  { value: "vip",        label: "VIP" },
  { value: "threat",     label: "Threat" },
  { value: "restricted", label: "Restricted" },
  { value: "employee",   label: "Employee" },
  { value: "visitor",    label: "Visitor" },
];

export default function AddWatchlistModal({ onClose, onCreated }: Props) {
  const [name, setName]               = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory]       = useState("general");
  const [priority, setPriority]       = useState("medium");
  const [alertOnMatch, setAlertOnMatch] = useState(true);
  const [notifyEmails, setNotifyEmails] = useState("");
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError("Name is required"); return; }
    setLoading(true); setError("");
    try {
      await apiRequest("/api/watchlists", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          category,
          priority,
          alertOnMatch,
          notifyEmails: notifyEmails.split(",").map(e => e.trim()).filter(Boolean),
        }),
      });
      onCreated();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to create watchlist");
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
                <Shield className="w-5 h-5 text-purple-500" />
                <Dialog.Title className="text-lg font-semibold">New Watchlist</Dialog.Title>
              </div>
              <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
            </div>

            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Name *</label>
                <input
                  value={name} onChange={e => setName(e.target.value)}
                  placeholder="e.g. Restricted Zone - Block A"
                  className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Description</label>
                <textarea
                  value={description} onChange={e => setDescription(e.target.value)}
                  rows={2} placeholder="Optional description..."
                  className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium mb-1">Category</label>
                  <select value={category} onChange={e => setCategory(e.target.value)}
                    className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm">
                    {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Priority</label>
                  <select value={priority} onChange={e => setPriority(e.target.value)}
                    className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm">
                    {["critical", "high", "medium", "low"].map(p => (
                      <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  Notify Emails <span className="text-muted-foreground text-xs">(comma-separated)</span>
                </label>
                <input
                  value={notifyEmails} onChange={e => setNotifyEmails(e.target.value)}
                  placeholder="security@example.com, ops@example.com"
                  className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox" checked={alertOnMatch}
                  onChange={e => setAlertOnMatch(e.target.checked)}
                  className="w-4 h-4 rounded"
                />
                <span className="text-sm font-medium">Trigger alert on face match</span>
              </label>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={onClose}
                  className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted">
                  Cancel
                </button>
                <button type="submit" disabled={loading}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50">
                  {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                  Create Watchlist
                </button>
              </div>
            </form>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
