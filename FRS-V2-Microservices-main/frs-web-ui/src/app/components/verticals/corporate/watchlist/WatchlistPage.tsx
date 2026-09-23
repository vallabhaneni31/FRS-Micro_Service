import React, { useState, useEffect, useCallback } from "react";
import { Plus, RefreshCw, ChevronRight, Shield, Users, AlertTriangle, Eye } from "lucide-react";
import { apiRequest } from "../../../../services/http/apiClient";
import AddWatchlistModal from "./AddWatchlistModal";
import WatchlistDetailDrawer from "./WatchlistDetailDrawer";
import { PaginationBar } from "../../../shared/PaginationBar";

interface Watchlist {
  pk_watchlist_id: number;
  name: string;
  description: string | null;
  category: string;
  priority: "critical" | "high" | "medium" | "low";
  is_active: boolean;
  alert_on_match: boolean;
  created_by_name: string | null;
  person_count: number;
  created_at: string;
}

interface WatchlistStats {
  active_lists: number;
  inactive_lists: number;
  critical_lists: number;
  total_lists: number;
  active_persons: number;
}

const PRIORITY_BADGE: Record<string, string> = {
  critical: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
  high:     "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400",
  medium:   "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400",
  low:      "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
};

const CATEGORY_LABELS: Record<string, string> = {
  general:    "General",
  vip:        "VIP",
  threat:     "Threat",
  restricted: "Restricted",
  employee:   "Employee",
  visitor:    "Visitor",
};

export default function WatchlistPage() {
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [stats, setStats]           = useState<WatchlistStats | null>(null);
  const [loading, setLoading]       = useState(true);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [page, setPage]             = useState(1);
  const [pageSize, setPageSize]     = useState(10);

  useEffect(() => { setPage(1); }, [pageSize]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100", active: "true" });
      if (categoryFilter) params.set("category", categoryFilter);
      const [listData, statsData] = await Promise.all([
        apiRequest<{ watchlists: Watchlist[] }>(`/api/watchlists?${params}`),
        apiRequest<WatchlistStats>("/api/watchlists/stats"),
      ]);
      setWatchlists(listData.watchlists);
      setStats(statsData);
      setPage(1);
    } finally { setLoading(false); }
  }, [categoryFilter]);

  useEffect(() => { void load(); }, [load]);

  const totalPages = Math.ceil(watchlists.length / pageSize);
  const paginatedWatchlists = watchlists.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Shield className="w-6 h-6 text-purple-500" /> Watchlist Management
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">Monitor persons of interest across sites</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-2 text-muted-foreground hover:text-foreground rounded-lg">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold"
          >
            <Plus className="w-4 h-4" /> New Watchlist
          </button>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Active Lists",     value: stats.active_lists,   icon: <Eye className="w-4 h-4 text-purple-500" /> },
            { label: "Critical Lists",   value: stats.critical_lists, icon: <AlertTriangle className="w-4 h-4 text-red-500" /> },
            { label: "Total Persons",    value: stats.active_persons, icon: <Users className="w-4 h-4 text-blue-500" /> },
            { label: "Total Lists",      value: stats.total_lists,    icon: <Shield className="w-4 h-4 text-muted-foreground" /> },
          ].map(({ label, value, icon }) => (
            <div key={label} className="bg-card border border-border rounded-xl p-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">{icon}<span className="text-xs font-medium">{label}</span></div>
              <p className="text-2xl font-bold">{value ?? 0}</p>
            </div>
          ))}
        </div>
      )}

      {/* Category filter */}
      <div className="flex gap-2 flex-wrap">
        {["", "general", "vip", "threat", "restricted", "employee", "visitor"].map(c => (
          <button key={c} onClick={() => setCategoryFilter(c)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              categoryFilter === c ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
            }`}>
            {c ? CATEGORY_LABELS[c] : "All Categories"}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="border border-border rounded-xl overflow-hidden bg-card">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              {["Name", "Category", "Priority", "Persons", "Alert on Match", "Created By", ""].map(h => (
                <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <tr key={i}><td colSpan={7} className="px-4 py-3"><div className="h-5 bg-muted rounded animate-pulse" /></td></tr>
              ))
            ) : paginatedWatchlists.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">No watchlists found</td></tr>
            ) : paginatedWatchlists.map(wl => (
              <tr
                key={wl.pk_watchlist_id}
                className="hover:bg-muted/30 cursor-pointer transition-colors"
                onClick={() => setSelectedId(wl.pk_watchlist_id)}
              >
                <td className="px-4 py-3 font-medium">{wl.name}</td>
                <td className="px-4 py-3 text-muted-foreground">{CATEGORY_LABELS[wl.category] ?? wl.category}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-semibold capitalize ${PRIORITY_BADGE[wl.priority]}`}>
                    {wl.priority}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className="flex items-center gap-1 text-muted-foreground"><Users className="w-3.5 h-3.5" />{wl.person_count}</span>
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs font-medium ${wl.alert_on_match ? "text-green-600" : "text-muted-foreground"}`}>
                    {wl.alert_on_match ? "Yes" : "No"}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground text-xs">{wl.created_by_name ?? "—"}</td>
                <td className="px-4 py-3"><ChevronRight className="w-4 h-4 text-muted-foreground/40" /></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {!loading && watchlists.length > 0 && (
          <div className="px-4 border-t border-border">
            <PaginationBar
              page={page}
              pageSize={pageSize}
              total={watchlists.length}
              totalPages={totalPages}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
            />
          </div>
        )}
      </div>

      {showCreate && (
        <AddWatchlistModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); void load(); }}
        />
      )}
      {selectedId !== null && (
        <WatchlistDetailDrawer
          watchlistId={selectedId}
          onClose={() => setSelectedId(null)}
          onUpdated={() => void load()}
        />
      )}
    </div>
  );
}
