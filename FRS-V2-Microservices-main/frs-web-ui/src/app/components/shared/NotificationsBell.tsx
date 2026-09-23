import React from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  Bell, BellOff, Trash2, Check, CheckCheck, AlertOctagon, AlertTriangle, AlertCircle, Info,
  X, Calendar, Clock, IdCard,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '../ui/sheet';
import { cn } from '../ui/utils';
import { lightTheme } from '../../../theme/lightTheme';
import { getSiteTimezone } from '../../utils/timezone';
import { useAuthedPhotoUrl } from '../../services/http/authedPhoto';

// /uploads and /api/jetson/photos both require a Bearer token, so a plain
// <img src> would 401 — fetch authenticated and render the resulting blob URL.
const AlertPhotoThumb: React.FC<{ photoUrl: string }> = ({ photoUrl }) => {
  const { url, loading } = useAuthedPhotoUrl(photoUrl);
  if (loading) return <div className="w-11 h-11 rounded-lg bg-accent/60 animate-pulse shrink-0" />;
  if (!url) return null;
  return <img src={url} alt="" className="w-11 h-11 rounded-lg object-cover shrink-0 border border-border" />;
};

// Pulls "Name (CODE)" out of the generated message text (see the
// ATTENDANCE_UPDATE message built in DeviceEventService.js) since the alert
// row itself only carries the internal fk_employee_id, not the human-facing
// employee code.
function parseEmployeeFromMessage(message: string): { name: string | null; code: string | null } {
  const m = message.match(/^(.*?)\s*\(([^)]+)\)/);
  return m ? { name: m[1] || null, code: m[2] || null } : { name: null, code: null };
}

// Portalled to <body> — this renders inside the Sheet's own layer, and
// stacking a second "fixed inset-0" overlay inside it without a portal risks
// the same containing-block trap seen elsewhere in this codebase (see
// PhotoViewerModal.tsx) where a backdrop-filter ancestor keeps a nested
// "fixed" element from covering the full viewport.
const AlertDetailModal: React.FC<{ alert: LiveAlert; onClose: () => void }> = ({ alert, onClose }) => {
  const { url, loading } = useAuthedPhotoUrl(alert.photo_url ?? null);
  const { name, code } = parseEmployeeFromMessage(alert.message);
  const created = new Date(alert.created_at);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4 pointer-events-auto"
      onClick={onClose}
    >
      <div
        className="relative max-w-lg w-full bg-card rounded-2xl overflow-hidden shadow-2xl border border-border"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-10 bg-black/50 hover:bg-black/70 text-white rounded-full p-1.5 transition"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="bg-slate-100 dark:bg-slate-900 flex items-center justify-center" style={{ minHeight: '280px' }}>
          {loading ? (
            <div className="w-full h-72 animate-pulse bg-slate-200 dark:bg-slate-800" />
          ) : url ? (
            <img src={url} alt={alert.title} className="max-h-[60vh] w-full object-contain" />
          ) : (
            <div className="w-full h-72 flex items-center justify-center text-xs font-bold text-slate-400 uppercase tracking-wide">
              No photo available
            </div>
          )}
        </div>

        <div className="p-5 space-y-3">
          <h3 className="text-base font-bold text-foreground">{alert.title}</h3>
          <p className="text-sm text-muted-foreground">{alert.message}</p>

          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border">
            {name && (
              <div className="flex items-center gap-2 text-xs">
                <IdCard className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span className="font-semibold text-foreground truncate">{name}</span>
              </div>
            )}
            {code && (
              <div className="flex items-center gap-2 text-xs">
                <IdCard className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Employee ID: <span className="font-semibold text-foreground">{code}</span></span>
              </div>
            )}
            <div className="flex items-center gap-2 text-xs">
              <Calendar className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">{format(created, 'MMM d, yyyy')}</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <Clock className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">{format(created, 'h:mm:ss a')}</span>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export interface LiveAlert {
  pk_alert_id: number;
  title: string;
  message: string;
  severity: string;
  created_at: string;
  is_read: boolean;
  alert_type?: string;
  fk_employee_id?: number | null;
  fk_device_id?: number | null;
  photo_url?: string | null;
}

/**
 * Where clicking a notification should take the user, based on what it's
 * about. Kept alongside the component that renders the click so the mapping
 * is easy to find/extend when a new alert_type is introduced.
 */
function resolveAlertTarget(alert: LiveAlert): string | null {
  switch (alert.alert_type) {
    case 'ATTENDANCE_UPDATE': {
      if (!alert.fk_employee_id) return null;
      // AttendanceStatusDashboard reads ?employee=/?date= to deep-link straight
      // into that employee's history drawer, pre-opened on the event's day.
      const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: getSiteTimezone() })
        .format(new Date(alert.created_at));
      return `/dashboard/attendance?employee=${alert.fk_employee_id}&date=${dateStr}`;
    }
    case 'EMPLOYEE_ENROLLMENT_SUBMITTED':
    case 'EMPLOYEE_ENROLLMENT_AUTO_APPROVED':
    case 'EMPLOYEE_ENROLLMENT_APPROVED':
      // RemoteEnrollmentManager reads ?tab= to land directly on the
      // pending-approvals view instead of the default "select employees" tab.
      return `/dashboard/enrollment?tab=pending-approvals`;
    case 'DEVICE_OFFLINE':
      return `/dashboard/devices`;
    default:
      return null;
  }
}

interface NotificationsBellProps {
  unreadAlerts?: number;
  liveAlerts?: LiveAlert[];
  /** Optimistically mark one/some (or, with no ids, all) alerts read; rejects (after rolling back) on failure. */
  onMarkRead?: (ids?: number[]) => Promise<void>;
  /** Optimistically remove a single alert; rejects (after rolling back) on failure. */
  onDismiss?: (id: number) => Promise<void>;
  /** Optimistically clear the whole feed; rejects (after rolling back) on failure. */
  onDismissAll?: () => Promise<void>;
  /** Trigger style: compact icon button (header) or full-width row (drawer). */
  variant?: 'icon' | 'full';
}

type SeverityKey = 'critical' | 'high' | 'medium' | 'low';

const SEVERITY: Record<SeverityKey, {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  iconBg: string;
  iconFg: string;
  bar: string;
}> = {
  critical: { icon: AlertOctagon,  label: 'Critical', iconBg: 'bg-rose-500/15',  iconFg: 'text-rose-600 dark:text-rose-400',   bar: 'bg-rose-500' },
  high:     { icon: AlertTriangle, label: 'High',     iconBg: 'bg-rose-500/15',  iconFg: 'text-rose-600 dark:text-rose-400',   bar: 'bg-rose-500' },
  medium:   { icon: AlertCircle,   label: 'Medium',   iconBg: 'bg-amber-500/15', iconFg: 'text-amber-600 dark:text-amber-400', bar: 'bg-amber-500' },
  low:      { icon: Info,          label: 'Info',     iconBg: 'bg-sky-500/15',   iconFg: 'text-sky-600 dark:text-sky-400',     bar: 'bg-sky-500' },
};

const severityOf = (s: string): SeverityKey =>
  s === 'critical' ? 'critical' : s === 'high' ? 'high' : s === 'medium' ? 'medium' : 'low';

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

type TimeBucket = 'Today' | 'Yesterday' | 'Earlier';

const BUCKET_ORDER: TimeBucket[] = ['Today', 'Yesterday', 'Earlier'];

function bucketOf(iso: string): TimeBucket {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'Earlier';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= startOfToday) return 'Today';
  if (t >= startOfToday - 86_400_000) return 'Yesterday';
  return 'Earlier';
}

/**
 * Notifications bell + slide-over alert feed. Self-contained: owns its own
 * mark-read / clear / dismiss calls. Shared by the AppHeader and MobileNav so
 * the alert UI lives in exactly one place.
 *
 * Triage-first: All/Unread filter, per-severity icons, relative timestamps,
 * and explicit mark-read (opening the panel does NOT silently clear unread).
 */
export const NotificationsBell: React.FC<NotificationsBellProps> = ({
  unreadAlerts = 0,
  liveAlerts = [],
  onMarkRead,
  onDismiss,
  onDismissAll,
  variant = 'icon',
}) => {
  const navigate = useNavigate();
  const [filter, setFilter] = React.useState<'all' | 'unread'>('all');
  const [open, setOpen] = React.useState(false);
  const [expandedAlert, setExpandedAlert] = React.useState<LiveAlert | null>(null);

  const unreadCount = liveAlerts.filter((a) => !a.is_read).length || unreadAlerts;
  const visible = filter === 'unread' ? liveAlerts.filter((a) => !a.is_read) : liveAlerts;

  // The list update is applied synchronously by the parent's optimistic
  // mutator (see useAlerts.ts) before the network call even goes out, so the
  // UI reflects the change on this same click — the toast just confirms
  // (or, on rollback, reports) what the background request eventually did.
  const markRead = async (ids?: number[]) => {
    try {
      await onMarkRead?.(ids);
      toast.success(ids ? 'Notification marked as read' : 'All notifications marked as read');
    } catch (err: any) {
      console.error('Failed to mark alerts as read:', err);
      toast.error(err?.message || 'Failed to mark notifications as read');
    }
  };

  // Clicking the notification body itself (not the row action buttons):
  // silently mark it read, then either show the detail modal (when the
  // alert carries a photo — e.g. an attendance recognition event) or jump to
  // whatever it's about. Unrecognized alert_types / missing entity refs and
  // no photo just close the panel.
  const handleAlertClick = (alert: LiveAlert) => {
    const target = resolveAlertTarget(alert);
    if (!alert.is_read) {
      onMarkRead?.([alert.pk_alert_id]).catch(() => {});
    }
    if (alert.photo_url) {
      setExpandedAlert(alert);
      return;
    }
    if (target) {
      setOpen(false);
      navigate(target);
    }
  };

  const dismiss = async (id: number) => {
    try {
      await onDismiss?.(id);
      toast.success('Notification dismissed');
    } catch (_) {
      toast.error('Failed to dismiss notification');
    }
  };

  const dismissAll = async () => {
    try {
      await onDismissAll?.();
      toast.success('All notifications dismissed');
    } catch (_) {
      toast.error('Failed to dismiss all notifications');
    }
  };

  // Group the visible feed into Today / Yesterday / Earlier, preserving the
  // incoming (newest-first) order within each bucket.
  const grouped = React.useMemo(() => {
    const map = new Map<TimeBucket, LiveAlert[]>();
    for (const alert of visible) {
      const key = bucketOf(alert.created_at);
      (map.get(key) ?? map.set(key, []).get(key)!).push(alert);
    }
    return BUCKET_ORDER
      .filter((b) => map.has(b))
      .map((label) => ({ label, items: map.get(label)! }));
  }, [visible]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        {variant === 'icon' ? (
          <Button
            variant="ghost"
            size="icon"
            className={cn('relative rounded-lg', lightTheme.text.secondary)}
            aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
          >
            <Bell className="w-5 h-5" />
            {unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[16px] items-center justify-center">
                <span className="absolute inline-flex h-full w-full rounded-full bg-rose-500/60 animate-ping" />
                <Badge
                  variant="destructive"
                  className="relative h-4 min-w-[16px] flex items-center justify-center px-1 text-[10px] leading-none"
                >
                  {unreadCount > 9 ? '9+' : unreadCount}
                </Badge>
              </span>
            )}
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="w-full justify-start relative px-4">
            <Bell className="w-4 h-4 mr-2" />
            Notifications
            {unreadCount > 0 && (
              <Badge variant="destructive" className="ml-auto h-5 min-w-[20px] flex items-center justify-center px-1 text-xs">
                {unreadCount}
              </Badge>
            )}
          </Button>
        )}
      </SheetTrigger>

      <SheetContent
        side="right"
        className="w-[88vw] sm:w-[420px] p-0 flex flex-col gap-0"
        onInteractOutside={(e) => {
          if (expandedAlert) {
            e.preventDefault();
          }
        }}
      >
        {/* Header */}
        <SheetHeader className="px-5 pt-5 pb-3 border-b border-border space-y-3 bg-gradient-to-b from-primary/[0.05] to-transparent">
          <div className="flex items-center justify-between">
            <SheetTitle className="flex items-center gap-2">
              <span className={cn('w-8 h-8 rounded-xl flex items-center justify-center shrink-0', lightTheme.status.infoBg, lightTheme.status.info)}>
                <Bell className="w-4 h-4" />
              </span>
              Notifications
              {unreadCount > 0 && (
                <Badge className={cn('h-5 px-1.5 text-[11px] border-0', lightTheme.status.infoBg, lightTheme.status.info)}>
                  {unreadCount} new
                </Badge>
              )}
            </SheetTitle>
          </div>

          {/* Filter tabs + mark all read */}
          <div className="flex items-center justify-between gap-2">
            <div className={cn('inline-flex items-center gap-0.5 rounded-lg p-0.5', lightTheme.background.secondary)}>
              {(['all', 'unread'] as const).map((key) => (
                <button
                  type="button"
                  key={key}
                  onClick={() => setFilter(key)}
                  className={cn(
                    'px-2.5 py-1 rounded-md text-xs font-medium capitalize transition-colors',
                    filter === key
                      ? cn('bg-card shadow-sm', lightTheme.text.primary)
                      : lightTheme.text.secondary,
                  )}
                >
                  {key}
                  {key === 'unread' && unreadCount > 0 && (
                    <span className="ml-1 text-[10px] opacity-70">({unreadCount})</span>
                  )}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              {unreadCount > 0 && (
                <button
                  type="button"
                  className={cn('text-xs hover:underline flex items-center gap-1', lightTheme.status.info)}
                  onClick={() => markRead()}
                >
                  <CheckCheck className="w-3.5 h-3.5" />
                  Mark all read
                </button>
              )}
              {visible.length > 0 && (
                <button
                  type="button"
                  className={cn('text-xs hover:underline flex items-center gap-1 hover:text-rose-600', lightTheme.text.secondary)}
                  onClick={dismissAll}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Dismiss all
                </button>
              )}
            </div>
          </div>
        </SheetHeader>

        {/* Feed */}
        <div className="flex-1 overflow-y-auto px-3 py-3 [scrollbar-width:thin]">
          {visible.length > 0 ? (
            <div className="flex flex-col gap-4">
              {(() => {
                let row = 0; // running index across groups → smooth cascade
                return grouped.map(({ label, items }) => (
                  <section key={label} className="flex flex-col gap-2">
                    <div className="sticky top-0 z-10 -mx-3 px-3 py-1 bg-background/80 backdrop-blur-sm">
                      <h3 className={cn('text-[11px] font-semibold uppercase tracking-wide', lightTheme.text.muted)}>
                        {label}
                      </h3>
                    </div>
                    {items.map((alert) => {
                      const sev = SEVERITY[severityOf(alert.severity)];
                      const SevIcon = sev.icon;
                      const delay = `${Math.min(row++, 10) * 45}ms`;
                      const hasTarget = !!resolveAlertTarget(alert) || !!alert.photo_url;
                      return (
                        <div
                          key={alert.pk_alert_id}
                          style={{ animationDelay: delay }}
                          role={hasTarget ? 'button' : undefined}
                          tabIndex={hasTarget ? 0 : undefined}
                          onClick={hasTarget ? () => handleAlertClick(alert) : undefined}
                          onKeyDown={hasTarget ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleAlertClick(alert); } } : undefined}
                          className={cn(
                            'group relative flex gap-3 rounded-xl border p-3 pl-3.5 transition-all',
                            'animate-in fade-in slide-in-from-bottom-1 duration-300 fill-mode-both',
                            'hover:shadow-sm hover:border-border',
                            hasTarget && 'cursor-pointer',
                            lightTheme.border.card,
                            alert.is_read ? 'bg-transparent' : 'bg-accent/40',
                          )}
                        >
                          {/* Unread accent rail */}
                          {!alert.is_read && (
                            <span className={cn('absolute left-0 top-3 bottom-3 w-1 rounded-r-full', sev.bar)} />
                          )}

                          {/* Recognition photo when the alert has one (e.g. attendance
                              check-in/out), otherwise the generic severity icon. */}
                          {alert.photo_url ? (
                            <AlertPhotoThumb photoUrl={alert.photo_url} />
                          ) : (
                            <span
                              className={cn(
                                'w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-shadow',
                                sev.iconBg,
                                sev.iconFg,
                                !alert.is_read && 'shadow-sm',
                              )}
                            >
                              <SevIcon className="w-4 h-4" />
                            </span>
                          )}

                          {/* Body */}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-2">
                              <h4 className={cn('text-sm font-semibold truncate', lightTheme.text.primary)}>
                                {alert.title}
                              </h4>
                              <time className={cn('text-[11px] whitespace-nowrap shrink-0 mt-0.5', lightTheme.text.muted)}>
                                {relativeTime(alert.created_at)}
                              </time>
                            </div>
                            <p className={cn('text-xs leading-relaxed mt-0.5 line-clamp-2', lightTheme.text.secondary)}>
                              {alert.message}
                            </p>

                            {/* Actions */}
                            <div className="flex items-center gap-1 mt-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                              {!alert.is_read && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className={cn('h-7 px-2 text-[11px]', lightTheme.status.info)}
                                  onClick={(e) => { e.stopPropagation(); markRead([alert.pk_alert_id]); }}
                                >
                                  <Check className="w-3.5 h-3.5 mr-1" />
                                  Mark read
                                </Button>
                              )}
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className={cn('h-7 px-2 text-[11px]', lightTheme.text.secondary, 'hover:text-rose-600')}
                                onClick={(e) => { e.stopPropagation(); dismiss(alert.pk_alert_id); }}
                              >
                                <Trash2 className="w-3.5 h-3.5 mr-1" />
                                Dismiss
                              </Button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </section>
                ));
              })()}
            </div>
          ) : (
            <div className={cn('flex flex-col items-center justify-center h-full min-h-[280px] gap-3 text-center px-6', lightTheme.text.muted)}>
              <span className={cn('w-14 h-14 rounded-2xl flex items-center justify-center', lightTheme.background.secondary)}>
                <BellOff className="w-7 h-7 opacity-50" />
              </span>
              <div>
                <p className={cn('text-sm font-medium', lightTheme.text.secondary)}>
                  {filter === 'unread' ? "You're all caught up" : 'No notifications'}
                </p>
                <p className="text-xs mt-0.5">
                  {filter === 'unread' ? 'No unread notifications right now.' : 'New alerts will show up here.'}
                </p>
              </div>
            </div>
          )}
        </div>
      </SheetContent>

      {expandedAlert && (
        <AlertDetailModal alert={expandedAlert} onClose={() => setExpandedAlert(null)} />
      )}
    </Sheet>
  );
};
