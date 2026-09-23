import React, { useState, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Settings, Loader2, Save } from "lucide-react";
import { apiRequest, ApiError } from "../../../../services/http/apiClient";

interface Threshold {
  auto_accept_above: number;
  auto_reject_below: number;
  alert_on_low: boolean;
}

interface Props {
  onClose: () => void;
  onSaved: () => void;
}

export default function ConfidenceThresholdSettings({ onClose, onSaved }: Props) {
  const [autoAccept, setAutoAccept]   = useState(95);
  const [autoReject, setAutoReject]   = useState(50);
  const [alertOnLow, setAlertOnLow]   = useState(true);
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState("");

  useEffect(() => {
    apiRequest<Threshold>("/api/confidence-reviews/threshold")
      .then(t => {
        setAutoAccept(Math.round(t.auto_accept_above * 100));
        setAutoReject(Math.round(t.auto_reject_below * 100));
        setAlertOnLow(t.alert_on_low);
      })
      .catch(() => {/* keep defaults */})
      .finally(() => setLoading(false));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (autoAccept <= autoReject) {
      setError("Auto-accept threshold must be above auto-reject threshold");
      return;
    }
    setSaving(true); setError("");
    try {
      await apiRequest("/api/confidence-reviews/threshold", {
        method: "PUT",
        body: JSON.stringify({
          autoAcceptAbove: autoAccept / 100,
          autoRejectBelow: autoReject / 100,
          alertOnLow,
        }),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to save settings");
    } finally { setSaving(false); }
  }

  return (
    <Dialog.Root open onOpenChange={v => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50 backdrop-blur-sm" />
        <Dialog.Content className="fixed inset-0 flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <Settings className="w-5 h-5 text-indigo-500" />
                <Dialog.Title className="text-lg font-semibold">Confidence Thresholds</Dialog.Title>
              </div>
              <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
            </div>

            {loading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-10 bg-muted rounded animate-pulse" />)}
              </div>
            ) : (
              <form onSubmit={save} className="space-y-5">
                {/* Visual band indicator */}
                <div className="relative h-8 rounded-lg overflow-hidden flex">
                  <div className="h-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center text-xs text-red-600 font-medium"
                    style={{ width: `${autoReject}%` }}>
                    {autoReject < 15 ? "" : "Auto Reject"}
                  </div>
                  <div className="h-full bg-yellow-100 dark:bg-yellow-900/30 flex items-center justify-center text-xs text-yellow-700 font-medium"
                    style={{ width: `${autoAccept - autoReject}%` }}>
                    {autoAccept - autoReject < 10 ? "" : "Review"}
                  </div>
                  <div className="h-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center text-xs text-green-700 font-medium"
                    style={{ width: `${100 - autoAccept}%` }}>
                    {100 - autoAccept < 10 ? "" : "Auto Accept"}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">
                    Auto-Accept Above: <span className="text-green-600 font-semibold">{autoAccept}%</span>
                  </label>
                  <input
                    type="range" min={51} max={99} value={autoAccept}
                    onChange={e => setAutoAccept(Number(e.target.value))}
                    className="w-full accent-green-500"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Matches ≥ {autoAccept}% confidence are automatically accepted — no human review needed
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">
                    Auto-Reject Below: <span className="text-red-600 font-semibold">{autoReject}%</span>
                  </label>
                  <input
                    type="range" min={10} max={autoAccept - 1} value={autoReject}
                    onChange={e => setAutoReject(Number(e.target.value))}
                    className="w-full accent-red-500"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Matches &lt; {autoReject}% are automatically rejected
                  </p>
                </div>

                <p className="text-xs text-muted-foreground bg-muted rounded-lg p-3">
                  Matches between <strong>{autoReject}%</strong> and <strong>{autoAccept}%</strong> are queued for human review
                </p>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox" checked={alertOnLow}
                    onChange={e => setAlertOnLow(e.target.checked)}
                    className="w-4 h-4 rounded"
                  />
                  <span className="text-sm font-medium">Trigger alert for low-confidence matches</span>
                </label>

                {error && <p className="text-sm text-destructive">{error}</p>}

                <div className="flex justify-end gap-2 pt-2">
                  <button type="button" onClick={onClose}
                    className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted">
                    Cancel
                  </button>
                  <button type="submit" disabled={saving}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50">
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    Save Thresholds
                  </button>
                </div>
              </form>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
