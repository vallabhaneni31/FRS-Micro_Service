import React, { useState, useEffect } from "react";
import { X, Users, Plus, Trash2, Loader2, Shield, User } from "lucide-react";
import { apiRequest, ApiError } from "../../../../services/http/apiClient";
import { toast } from "sonner";

interface WatchlistPerson {
  pk_person_id: number;
  full_name: string;
  aliases: string[];
  notes: string | null;
  photo_url: string | null;
  expires_at: string | null;
  added_by_name: string | null;
  added_at: string;
  is_active: boolean;
}

interface WatchlistDetail {
  pk_watchlist_id: number;
  name: string;
  description: string | null;
  category: string;
  priority: string;
  is_active: boolean;
  alert_on_match: boolean;
  created_by_name: string | null;
  persons: WatchlistPerson[];
}

interface Props {
  watchlistId: number;
  onClose: () => void;
  onUpdated: () => void;
}

const PRIORITY_COLOR: Record<string, string> = {
  critical: "text-red-600",
  high:     "text-orange-600",
  medium:   "text-yellow-600",
  low:      "text-blue-600",
};

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function WatchlistDetailDrawer({ watchlistId, onClose, onUpdated }: Props) {
  const [watchlist, setWatchlist] = useState<WatchlistDetail | null>(null);
  const [loading, setLoading]     = useState(true);
  const [addName, setAddName]     = useState("");
  const [addNotes, setAddNotes]   = useState("");
  const [adding, setAdding]       = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  async function load() {
    try {
      const data = await apiRequest<WatchlistDetail>(`/api/watchlists/${watchlistId}`);
      setWatchlist(data);
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [watchlistId]);

  async function addPerson(e: React.FormEvent) {
    e.preventDefault();
    if (!addName.trim()) return;
    setAdding(true);
    try {
      await apiRequest(`/api/watchlists/${watchlistId}/persons`, {
        method: "POST",
        body: JSON.stringify({ fullName: addName.trim(), notes: addNotes.trim() || undefined }),
      });
      setAddName(""); setAddNotes(""); setShowAddForm(false);
      onUpdated();
      void load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to add person");
    } finally { setAdding(false); }
  }

  async function removePerson(personId: number) {
    toast("Remove this person from the watchlist?", {
      description: "They will no longer trigger watchlist alerts.",
      action: {
        label: "Remove",
        onClick: async () => {
          try {
            await apiRequest(`/api/watchlists/${watchlistId}/persons/${personId}`, { method: "DELETE" });
            toast.success("Person removed from watchlist");
            onUpdated();
            void load();
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : "Failed to remove person");
          }
        }
      }
    });
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
            ) : watchlist ? (
              <>
                <div className="flex items-center gap-2 mb-1">
                  <Shield className="w-4 h-4 text-purple-500" />
                  <span className="text-xs text-muted-foreground capitalize">{watchlist.category}</span>
                </div>
                <h2 className="font-semibold text-lg leading-tight">{watchlist.name}</h2>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`text-sm font-medium capitalize ${PRIORITY_COLOR[watchlist.priority]}`}>{watchlist.priority}</span>
                  {watchlist.alert_on_match && (
                    <>
                      <span className="text-muted-foreground/40">·</span>
                      <span className="text-xs text-green-600">Alert on match</span>
                    </>
                  )}
                </div>
              </>
            ) : null}
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground mt-0.5"><X className="w-5 h-5" /></button>
        </div>

        {loading ? (
          <div className="flex-1 p-5 space-y-3">
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-12 bg-muted rounded animate-pulse" />)}
          </div>
        ) : watchlist ? (
          <div className="flex-1 overflow-y-auto">
            {/* Description */}
            {watchlist.description && (
              <div className="p-5 border-b border-border">
                <p className="text-sm text-muted-foreground">{watchlist.description}</p>
              </div>
            )}

            {/* Persons list */}
            <div className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5" /> Persons ({watchlist.persons.length})
                </p>
                <button
                  onClick={() => setShowAddForm(v => !v)}
                  className="flex items-center gap-1 text-xs text-primary font-medium"
                >
                  <Plus className="w-3.5 h-3.5" /> Add Person
                </button>
              </div>

              {showAddForm && (
                <form onSubmit={addPerson} className="border border-border rounded-lg p-3 space-y-2 bg-muted/30">
                  <input
                    value={addName} onChange={e => setAddName(e.target.value)}
                    placeholder="Full name *"
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <input
                    value={addNotes} onChange={e => setAddNotes(e.target.value)}
                    placeholder="Notes (optional)"
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <div className="flex gap-2">
                    <button type="submit" disabled={!addName.trim() || adding}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
                      {adding && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      Add
                    </button>
                    <button type="button" onClick={() => { setShowAddForm(false); setAddName(""); setAddNotes(""); }}
                      className="px-3 py-1.5 rounded-lg border border-border text-sm">
                      Cancel
                    </button>
                  </div>
                </form>
              )}

              <div className="space-y-2">
                {watchlist.persons.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">No persons on this watchlist yet</p>
                ) : watchlist.persons.map(p => (
                  <div key={p.pk_person_id} className="flex items-start gap-3 p-3 rounded-lg bg-muted/30 border border-border">
                    <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                      {p.photo_url
                        ? <img src={p.photo_url} alt={p.full_name} className="w-8 h-8 rounded-full object-cover" />
                        : <User className="w-4 h-4 text-muted-foreground" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{p.full_name}</p>
                      {p.aliases.length > 0 && (
                        <p className="text-xs text-muted-foreground">Aliases: {p.aliases.join(", ")}</p>
                      )}
                      {p.notes && <p className="text-xs text-muted-foreground mt-0.5">{p.notes}</p>}
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Added {fmt(p.added_at)}{p.added_by_name ? ` by ${p.added_by_name}` : ""}
                        {p.expires_at ? ` · Expires ${fmt(p.expires_at)}` : ""}
                      </p>
                    </div>
                    <button
                      onClick={() => removePerson(p.pk_person_id)}
                      className="text-muted-foreground hover:text-destructive transition-colors p-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
