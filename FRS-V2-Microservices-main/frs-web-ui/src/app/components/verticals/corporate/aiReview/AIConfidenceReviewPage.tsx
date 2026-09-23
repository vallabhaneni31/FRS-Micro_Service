import React, { useState, useEffect, useCallback } from "react";
import { RefreshCw, CheckCircle, XCircle, AlertTriangle, ArrowUpRight, Settings } from "lucide-react";
import { apiRequest, ApiError } from "../../../../services/http/apiClient";
import { toast } from "sonner";
import ConfidenceThresholdSettings from "./ConfidenceThresholdSettings";

interface Review {
  pk_review_id: number;
  ai_confidence: number;
  ai_match_name: string | null;
  face_snapshot_url: string | null;
  review_status: string;
  created_at: string;
  site_id: number | null;
  flagged_for_audit: boolean;
}

interface ReviewStats {
  pending_count: number;
  confirmed_count: number;
  rejected_count: number;
  escalated_count: number;
  avg_confidence: number;
  low_confidence_count: number;
  total: number;
}

const STATUS_FILTER_TABS = [
  { value: "pending",   label: "Pending",   color: "text-yellow-600" },
  { value: "confirmed", label: "Confirmed", color: "text-green-600" },
  { value: "rejected",  label: "Rejected",  color: "text-red-600" },
  { value: "escalated", label: "Escalated", color: "text-orange-600" },
];

function confidenceColor(c: number): string {
  if (c >= 0.9) return "text-green-600";
  if (c >= 0.7) return "text-yellow-600";
  return "text-red-600";
}

function confidenceBg(c: number): string {
  if (c >= 0.9) return "bg-green-100 dark:bg-green-900/30";
  if (c >= 0.7) return "bg-yellow-100 dark:bg-yellow-900/30";
  return "bg-red-100 dark:bg-red-900/30";
}

export default function AIConfidenceReviewPage() {
  const [reviews, setReviews]   = useState<Review[]>([]);
  const [stats, setStats]       = useState<ReviewStats | null>(null);
  const [loading, setLoading]   = useState(true);
  const [statusFilter, setStatusFilter] = useState("pending");
  const [showSettings, setShowSettings] = useState(false);
  const [reviewingId, setReviewingId]   = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [reviewData, statsData] = await Promise.all([
        apiRequest<{ reviews: Review[] }>(`/api/confidence-reviews?status=${statusFilter}&limit=100`),
        apiRequest<ReviewStats>("/api/confidence-reviews/stats"),
      ]);
      setReviews(reviewData.reviews);
      setStats(statsData);
    } finally { setLoading(false); }
  }, [statusFilter]);

  useEffect(() => { void load(); }, [load]);

  async function doReview(id: number, action: "confirmed" | "rejected" | "escalated") {
    setReviewingId(id);
    try {
      await apiRequest(`/api/confidence-reviews/${id}/review`, {
        method: "PATCH",
        body: JSON.stringify({ action }),
      });
      void load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Review failed");
    } finally { setReviewingId(null); }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ArrowUpRight className="w-6 h-6 text-indigo-500" /> AI Confidence Review
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">Review and validate low-confidence face recognition matches</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-2 text-muted-foreground hover:text-foreground rounded-lg">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted"
          >
            <Settings className="w-4 h-4" /> Thresholds
          </button>
        </div>
      </div>

      {/* Stats cards */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Pending Review",   value: stats.pending_count,    color: "text-yellow-600" },
            { label: "Low Confidence",   value: stats.low_confidence_count, color: "text-red-600" },
            { label: "Confirmed Today",  value: stats.confirmed_count,  color: "text-green-600" },
            { label: "Avg Confidence",   value: stats.avg_confidence ? `${(Number(stats.avg_confidence) * 100).toFixed(1)}%` : "—", color: "text-indigo-600" },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-card border border-border rounded-xl p-4">
              <p className="text-xs font-medium text-muted-foreground mb-1">{label}</p>
              <p className={`text-2xl font-bold ${color}`}>{value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Status filter tabs */}
      <div className="flex gap-2 flex-wrap border-b border-border pb-3">
        {STATUS_FILTER_TABS.map(tab => (
          <button key={tab.value} onClick={() => setStatusFilter(tab.value)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              statusFilter === tab.value
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}>
            {tab.label}
            {stats && tab.value === "pending" && Number(stats.pending_count) > 0 && (
              <span className="ml-1.5 bg-yellow-500 text-white text-xs rounded-full px-1.5 py-0.5">
                {stats.pending_count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Review cards */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-36 bg-muted rounded-xl animate-pulse" />
          ))}
        </div>
      ) : reviews.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <CheckCircle className="w-10 h-10 mx-auto mb-3 text-green-500" />
          <p className="font-medium">No {statusFilter} reviews</p>
          <p className="text-sm mt-1">
            {statusFilter === "pending" ? "All matches have been reviewed!" : `No ${statusFilter} reviews found.`}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {reviews.map(review => (
            <div key={review.pk_review_id}
              className={`border border-border rounded-xl overflow-hidden ${review.flagged_for_audit ? "ring-2 ring-orange-400" : ""}`}
            >
              <div className="flex gap-3 p-4">
                {/* Face snapshot */}
                <div className="w-16 h-16 rounded-lg overflow-hidden bg-muted shrink-0 flex items-center justify-center">
                  {review.face_snapshot_url
                    ? <img src={review.face_snapshot_url} alt="Face" className="w-full h-full object-cover" />
                    : <AlertTriangle className="w-6 h-6 text-muted-foreground" />}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <p className="text-sm font-medium truncate">
                      {review.ai_match_name ?? "Unknown Person"}
                    </p>
                    {review.flagged_for_audit && (
                      <span className="text-xs text-orange-600 font-medium shrink-0">Flagged</span>
                    )}
                  </div>
                  <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${confidenceBg(review.ai_confidence)} ${confidenceColor(review.ai_confidence)}`}>
                    {(review.ai_confidence * 100).toFixed(1)}% confidence
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {new Date(review.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
              </div>

              {/* Actions */}
              {statusFilter === "pending" && (
                <div className="flex gap-2 px-4 pb-4">
                  <button
                    onClick={() => doReview(review.pk_review_id, "confirmed")}
                    disabled={reviewingId === review.pk_review_id}
                    className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 text-sm font-medium disabled:opacity-50"
                  >
                    <CheckCircle className="w-3.5 h-3.5" /> Confirm
                  </button>
                  <button
                    onClick={() => doReview(review.pk_review_id, "rejected")}
                    disabled={reviewingId === review.pk_review_id}
                    className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 text-sm font-medium disabled:opacity-50"
                  >
                    <XCircle className="w-3.5 h-3.5" /> Reject
                  </button>
                  <button
                    onClick={() => doReview(review.pk_review_id, "escalated")}
                    disabled={reviewingId === review.pk_review_id}
                    className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 text-sm font-medium disabled:opacity-50"
                  >
                    <ArrowUpRight className="w-3.5 h-3.5" /> Escalate
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showSettings && (
        <ConfidenceThresholdSettings
          onClose={() => setShowSettings(false)}
          onSaved={() => { setShowSettings(false); void load(); }}
        />
      )}
    </div>
  );
}
