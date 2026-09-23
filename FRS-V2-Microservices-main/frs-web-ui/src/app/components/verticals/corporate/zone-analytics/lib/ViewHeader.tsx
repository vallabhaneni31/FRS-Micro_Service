import React from 'react';
import { MapPin, RefreshCw, Download, ChevronRight } from 'lucide-react';
import { cn } from '../../../../ui/utils';
import { PageHeader } from '../../../../shared/PageHeader';

/**
 * Shared page header for all four Zone Analytics views (Req 6.6, 6.7, 10.4):
 * breadcrumb "HR Manager > Zone Analytics > <view>", title, a "Live" indicator,
 * the last-updated time, Refresh and Export. There is no header search box
 * (search lives inside each view) and no solution pill/bell/profile chrome —
 * those belong to the FRS shell. Controls stack before they overflow (Req 10.4).
 */
export const ViewHeader: React.FC<{
  title: string;
  subtitle: string;
  breadcrumb: string;
  loading?: boolean;
  lastUpdatedAt: Date | null;
  onRefresh: () => void;
  onExport: () => void;
}> = ({ title, subtitle, breadcrumb, loading, lastUpdatedAt, onRefresh, onExport }) => (
  <div data-testid="zone-view-header" className="glass-card rounded-2xl border border-slate-200 p-4 space-y-3">
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-[11px] text-slate-400 font-semibold">
      <span>HR Manager</span>
      <ChevronRight className="w-3 h-3" />
      <span>Zone Analytics</span>
      <ChevronRight className="w-3 h-3" />
      <span className="text-slate-600">{breadcrumb}</span>
    </nav>

    <div className="flex flex-col sm:flex-row sm:flex-wrap items-start justify-between gap-3">
      <PageHeader title={title} subtitle={subtitle} icon={MapPin} />

      <div className="flex flex-wrap items-center gap-2 shrink-0">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-600 bg-emerald-50 rounded-full px-2.5 py-1">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          Live
        </span>
        <span data-testid="last-updated" className="text-[10px] text-slate-400 whitespace-nowrap">
          {lastUpdatedAt ? `Updated ${lastUpdatedAt.toLocaleTimeString()}` : 'Not yet updated'}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 transition-colors cursor-pointer"
          title="Refresh"
          aria-label="Refresh"
        >
          <RefreshCw className={cn('w-3.5 h-3.5 text-slate-500', loading && 'animate-spin')} />
        </button>
        <button
          type="button"
          onClick={onExport}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl bg-primary/10 text-primary hover:bg-primary/20 transition-colors cursor-pointer"
        >
          <Download className="w-3.5 h-3.5" /> Export
        </button>
      </div>
    </div>
  </div>
);

/** Inline per-widget states (Req 7.4): a failed widget shows an error, an empty one an empty state. */
export const WidgetState: React.FC<{ error?: string | null; empty?: boolean; emptyText?: string; loading?: boolean }> = ({ error, empty, emptyText, loading }) => {
  if (error) return <div role="alert" className="text-center text-xs text-rose-500 py-8">{error}</div>;
  if (loading && empty) {
    return (
      <div data-testid="widget-skeleton" role="status" aria-label="Loading" className="animate-pulse space-y-2 p-4">
        <div className="h-3 w-1/3 rounded bg-slate-200" />
        <div className="h-3 w-full rounded bg-slate-100" />
        <div className="h-3 w-5/6 rounded bg-slate-100" />
      </div>
    );
  }
  if (empty) return <div data-testid="widget-empty" className="text-center text-xs text-slate-400 py-8">{emptyText || 'No activity recorded for this selection.'}</div>;
  return null;
};
