import React, { useEffect, useState } from "react";
import { apiRequest } from "../../../../services/http/apiClient";

interface Stats {
  critical_open: number;
  high_open: number;
  medium_open: number;
  low_open: number;
  total_open: number;
}

/**
 * M-01: Compact severity-count chips for use in headers / dashboard.
 * e.g.  🔴 2 Critical  🟠 4 High  🟡 7 Medium  🔵 3 Low
 */
export default function AlertStatsBar() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    apiRequest<Stats>("/api/alerts/stats")
      .then(setStats)
      .catch(() => {}); // silent fail — bar is optional UI
  }, []);

  if (!stats || stats.total_open === 0) return null;

  const chips = [
    { label: "Critical", count: stats.critical_open, dot: "bg-red-600",    text: "text-red-600 dark:text-red-400"    },
    { label: "High",     count: stats.high_open,     dot: "bg-orange-500", text: "text-orange-600 dark:text-orange-400" },
    { label: "Medium",   count: stats.medium_open,   dot: "bg-yellow-500", text: "text-yellow-600 dark:text-yellow-400" },
    { label: "Low",      count: stats.low_open,      dot: "bg-blue-500",   text: "text-blue-600 dark:text-blue-400"  },
  ].filter(c => c.count > 0);

  return (
    <div className="flex items-center gap-3 text-sm">
      {chips.map(c => (
        <span key={c.label} className={`flex items-center gap-1.5 font-semibold ${c.text}`}>
          <span className={`w-2 h-2 rounded-full ${c.dot}`} />
          {c.count} {c.label}
        </span>
      ))}
    </div>
  );
}
