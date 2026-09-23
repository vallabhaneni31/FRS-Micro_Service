import React, { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Moon, Sun, User, LogOut, Lock, ChevronRight, ChevronDown, LayoutGrid, Clock, Eye, EyeOff, Building2 } from 'lucide-react';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { cn } from '../ui/utils';
import { lightTheme } from '../../../theme/lightTheme';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import { useScopeHeaders } from '../../hooks/useScopeHeaders';
import { useGlobalRetailStore } from '../../hooks/useGlobalRetailStore';
import { authConfig } from '../../config/authConfig';
import keycloakProxy from '../../services/auth/keycloakInstance';
import { apiRequest } from '../../services/http/apiClient';
import { NotificationsBell, LiveAlert } from './NotificationsBell';
import { getSiteTimezone } from '../../utils/timezone';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

interface AppHeaderProps {
  /** Title of the active page (current nav item label). */
  pageTitle: string;
  /** Whether the sidebar is collapsed — controls the header's left offset. */
  collapsed?: boolean;
  unreadAlerts?: number;
  liveAlerts?: LiveAlert[];
  onMarkRead?: (ids?: number[]) => Promise<void>;
  onDismiss?: (id: number) => Promise<void>;
  onDismissAll?: () => Promise<void>;
}

function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { accessToken, mt } = useAuth();
  const minLength = mt?.minPasswordLength ?? 8;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);

  const reset = () => {
    setCurrent(''); setNext(''); setConfirm('');
    setShowCurrent(false); setShowNext(false); setShowConfirm(false);
  };
  const handleClose = () => { reset(); onClose(); };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) { toast.error('New passwords do not match'); return; }
    if (next.length < minLength) { toast.error(`New password must be at least ${minLength} characters`); return; }
    setLoading(true);
    try {
      if (authConfig.mode === 'keycloak') {
        await apiRequest('/auth/change-password', {
          method: 'POST',
          body: JSON.stringify({ currentPassword: current, newPassword: next }),
          accessToken: accessToken ?? keycloakProxy.token ?? undefined,
        });
      } else {
        toast.info('Password management is handled by your identity provider.');
        handleClose();
        return;
      }
      toast.success('Password changed successfully');
      handleClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to change password';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const fields = [
    { label: 'Current password', value: current, set: setCurrent, show: showCurrent, toggle: () => setShowCurrent(v => !v), auto: 'current-password' },
    { label: 'New password',     value: next,    set: setNext,    show: showNext,    toggle: () => setShowNext(v => !v),    auto: 'new-password' },
    { label: 'Confirm new password', value: confirm, set: setConfirm, show: showConfirm, toggle: () => setShowConfirm(v => !v), auto: 'new-password' },
  ] as const;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="w-4 h-4" /> Change Password
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          {fields.map(({ label, value, set, show, toggle, auto }) => (
            <div key={label}>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">{label}</label>
              <div className="relative">
                <input
                  type={show ? 'text' : 'password'}
                  value={value}
                  onChange={e => set(e.target.value)}
                  required
                  autoComplete={auto}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 pr-9 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <button type="button" onClick={toggle} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          ))}
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={handleClose} disabled={loading}>Cancel</Button>
            <Button type="submit" disabled={loading || !current || !next || !confirm}>
              {loading ? 'Changing…' : 'Change password'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SiteClock() {
  const [now, setNow] = useState(new Date());
  const [tz, setTz] = useState(getSiteTimezone());

  useEffect(() => {
    // Tick every minute to keep the displayed time current
    const clockId = setInterval(() => setNow(new Date()), 60_000);

    // Instantly re-read timezone when the active site changes
    const onTzChange = (e: Event) => {
      setTz((e as CustomEvent<{ tz: string }>).detail.tz);
      setNow(new Date());
    };
    window.addEventListener('site-tz-change', onTzChange);

    // Also read current value immediately in case setSiteTimezone fired before mount
    setTz(getSiteTimezone());

    return () => {
      clearInterval(clockId);
      window.removeEventListener('site-tz-change', onTzChange);
    };
  }, []);

  const timeStr = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(now);

  const tzAbbr = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'short',
  }).formatToParts(now).find(p => p.type === 'timeZoneName')?.value ?? tz;

  // Friendly short label: last segment of IANA name e.g. "Asia/Kolkata" → "Kolkata"
  const tzCity = tz === 'UTC' ? 'UTC' : tz.split('/').pop()?.replace(/_/g, ' ') ?? tz;

  return (
    <div
      className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 select-none"
      title={tz}
    >
      <Clock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
      <div className="flex flex-col items-start leading-none">
        <span className="text-[13px] font-semibold tabular-nums text-slate-700 dark:text-slate-200">
          {timeStr}
        </span>
        <span className="text-[10px] font-medium text-slate-400 mt-0.5">
          {tzCity} · {tzAbbr}
        </span>
      </div>
    </div>
  );
}

const STORE_COLORS = [
  '#3b82f6', // Bright Blue
  '#10b981', // Emerald Green
  '#f59e0b', // Amber / Orange
  '#ec4899', // Pink / Rose
  '#8b5cf6', // Violet / Purple
  '#06b6d4', // Cyan
  '#f97316', // Deep Orange
  '#14b8a6', // Teal
];

function GlobalStoreSelector({ pageTitle }: { pageTitle: string }) {
  const { accessToken, sites, vertical, activeScope, setActiveScope } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const unitLabel = vertical === 'retail' ? 'Store' : vertical === 'education' ? 'Campus' : 'Site';
  const unitLabelPlural = vertical === 'retail' ? 'Stores' : vertical === 'education' ? 'Campuses' : 'Sites';
  const { selectedStoreId, setSelectedStoreId: setSelectedStoreIdRaw } = useGlobalRetailStore();

  // This pill drives `selectedStoreId` (a legacy, retail-only piece of state),
  // but every data-fetching hook in the app (useScopeHeaders -> activeScope)
  // reads siteId from AuthContext's activeScope instead. The two were never
  // kept in sync, so switching sites here visibly changed the pill but sent
  // the same x-site-id (or none) on every request — dashboards silently kept
  // showing all-sites data regardless of what was selected. Keep both in sync.
  const setSelectedStoreId = useCallback((id: string) => {
    setSelectedStoreIdRaw(id);
    if (activeScope) {
      setActiveScope({ ...activeScope, siteId: id === 'all' ? undefined : id });
    }
  }, [setSelectedStoreIdRaw, activeScope, setActiveScope]);
  const [stores, setStores] = useState<Array<{ id: string; name: string; status?: string }>>([]);
  const [loading, setLoading] = useState(true);

  const titleLower = (pageTitle || '').toLowerCase();
  const disableAllStores =
    titleLower.includes('insight') ||
    titleLower.includes('analytic') ||
    titleLower.includes('report') ||
    titleLower.includes('setting') ||
    titleLower.includes('device') ||
    titleLower.includes('user management') ||
    titleLower.includes('store management');

  const fetchStores = useCallback(async () => {
    if (!accessToken) return;
    if (vertical !== 'retail') {
      if (sites && sites.length > 0) {
        setStores(sites.map((s) => ({ id: s.id, name: s.name, status: s.status })));
      }
      setLoading(false);
      return;
    }
    try {
      const res = await apiRequest<{ stores: Array<any> }>('/v1/retail/stores', {
        method: 'GET',
        accessToken,
        scopeHeaders,
      });

      if (res.stores && res.stores.length > 0) {
        setStores(res.stores);
      } else if (sites && sites.length > 0) {
        setStores(sites.map((s) => ({ id: s.id, name: s.name, status: s.status })));
      }
    } catch {
      if (sites && sites.length > 0) {
        setStores(sites.map((s) => ({ id: s.id, name: s.name, status: s.status })));
      }
    } finally {
      setLoading(false);
    }
  }, [accessToken, scopeHeaders, sites, vertical]);

  useEffect(() => {
    fetchStores();
    const interval = setInterval(fetchStores, 10_000);
    return () => clearInterval(interval);
  }, [fetchStores]);

  // If "All Stores" is disabled on this page and currently selected, auto-select first store
  useEffect(() => {
    if (disableAllStores && selectedStoreId === 'all' && stores.length > 0) {
      setSelectedStoreId(stores[0].id);
    }
  }, [disableAllStores, selectedStoreId, stores, setSelectedStoreId]);

  // A single-store account (e.g. a MANAGER, always scoped to exactly one
  // store server-side) has nothing to switch between — an "All Stores"
  // picker over one store is meaningless and implies access they don't
  // have. Auto-pin to that store and show a plain label, not a dropdown,
  // matching the corporate site-selector's hide-if-single-option pattern.
  useEffect(() => {
    if (stores.length === 1 && selectedStoreId !== stores[0].id) {
      setSelectedStoreId(stores[0].id);
    }
  }, [stores, selectedStoreId, setSelectedStoreId]);

  if (!stores.length && !loading) return null;

  if (stores.length === 1) {
    const [only] = stores;
    const isInactive = only.status === 'inactive';
    return (
      <div className={cn(
        'flex items-center gap-2 h-9 px-3 rounded-xl text-xs font-bold shadow-2xs',
        isInactive
          ? 'bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-400'
          : 'bg-white/70 dark:bg-slate-900/70 border border-gray-200 dark:border-slate-800 text-foreground'
      )}>
        <span className="w-2.5 h-2.5 rounded-full shrink-0 shadow-2xs" style={{ backgroundColor: STORE_COLORS[0] }} />
        <span className="truncate">{only.name}</span>
        {isInactive && (
          <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-600 dark:text-rose-400 uppercase shrink-0">
            Inactive
          </span>
        )}
      </div>
    );
  }

  const activeStoreIdx = stores.findIndex((s) => s.id === selectedStoreId);
  const activeStoreObj = activeStoreIdx >= 0 ? stores[activeStoreIdx] : null;
  const activeStoreColor = activeStoreIdx >= 0 ? STORE_COLORS[activeStoreIdx % STORE_COLORS.length] : 'var(--primary)';
  const displayLabel = selectedStoreId === 'all' ? `All ${unitLabelPlural}` : activeStoreObj?.name || `Select ${unitLabel}`;
  const isSelectedInactive = activeStoreObj?.status === 'inactive';

  return (
    <div className="flex items-center gap-1.5">
      <Select value={selectedStoreId} onValueChange={setSelectedStoreId}>
        <SelectTrigger className={cn(
          "w-[220px] rounded-xl h-9 backdrop-blur-sm text-xs font-bold focus:ring-primary/20 shadow-2xs transition-colors",
          isSelectedInactive
            ? "bg-rose-500/10 border-rose-500/30 text-rose-600 dark:text-rose-400"
            : "bg-white/70 dark:bg-slate-900/70 border-gray-200 dark:border-slate-800 text-foreground"
        )}>
          <div className="flex items-center justify-between w-full min-w-0 pr-1 gap-2">
            <div className="flex items-center gap-2 truncate">
              {selectedStoreId === 'all' ? (
                <Building2 className="w-3.5 h-3.5 text-primary shrink-0" />
              ) : isSelectedInactive ? (
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 bg-rose-400" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-rose-500" />
                </span>
              ) : (
                <span className="w-2.5 h-2.5 rounded-full shrink-0 shadow-2xs" style={{ backgroundColor: activeStoreColor }} />
              )}
              <span className="truncate">{displayLabel}</span>
            </div>
            {isSelectedInactive && (
              <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-600 dark:text-rose-400 uppercase shrink-0">
                Inactive
              </span>
            )}
          </div>
        </SelectTrigger>
        <SelectContent className="rounded-xl border border-border min-w-[220px]">
          <SelectItem
            value="all"
            disabled={disableAllStores}
            className={disableAllStores ? 'opacity-40 cursor-not-allowed text-muted-foreground' : ''}
          >
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-primary shrink-0" />
              <span className="font-bold text-xs">
                All {unitLabelPlural} {disableAllStores ? `(Single ${unitLabel} Required)` : ''}
              </span>
            </div>
          </SelectItem>
          {stores.map((s, idx) => {
            const isInactive = s.status === 'inactive';
            const color = STORE_COLORS[idx % STORE_COLORS.length];
            return (
              <SelectItem key={s.id} value={s.id}>
                <div className="flex items-center justify-between gap-3 w-full truncate">
                  <div className="flex items-center gap-2 truncate">
                    <span className="relative flex h-2.5 w-2.5 shrink-0">
                      {isInactive ? (
                        <>
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 bg-rose-400" />
                          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-rose-500" />
                        </>
                      ) : (
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 shadow-2xs" style={{ backgroundColor: color }} />
                      )}
                    </span>
                    <span className="text-xs font-semibold">{s.name}</span>
                  </div>
                  {isInactive && (
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-500 border border-rose-500/20 uppercase shrink-0">
                      Inactive
                    </span>
                  )}
                </div>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Global top app-bar. The third layout region alongside the Sidebar and the
 * page content. Desktop-only (mobile uses MobileNav's own top bar); fixed to
 * the top, offset by the sidebar width. Owns the breadcrumb, notifications,
 * theme toggle, and user menu so individual pages never re-implement them.
 */
export const AppHeader: React.FC<AppHeaderProps> = ({
  pageTitle,
  collapsed = false,
  unreadAlerts = 0,
  liveAlerts = [],
  onMarkRead,
  onDismiss,
  onDismissAll,
}) => {
  const { user, logout, translateRole } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [pwDialogOpen, setPwDialogOpen] = useState(false);

  const portalLabel = `${translateRole(user?.role || '')} Portal`.trim();
  const initials = (user?.name || user?.email || '?')
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <header
      className={cn(
        'hidden md:flex fixed top-0 right-0 z-40 h-16 items-center justify-between gap-4 px-5 border-b transition-all duration-300',
        collapsed ? 'left-20' : 'left-64',
        'bg-white dark:bg-slate-950',
      )}
    >
      {/* Breadcrumb / page title */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-2.5 min-w-0">
        <span className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <LayoutGrid className="w-4 h-4" />
        </span>
        <span className={cn('text-sm font-medium truncate hidden sm:inline', lightTheme.text.secondary)}>
          {portalLabel}
        </span>
        <ChevronRight className={cn('w-4 h-4 shrink-0 hidden sm:inline', lightTheme.text.muted)} />
        <span className={cn('text-[15px] font-semibold truncate', lightTheme.text.primary)}>
          {pageTitle}
        </span>
      </nav>

      <div className="flex items-center gap-3">
        <GlobalStoreSelector pageTitle={pageTitle} />
        {user?.role !== 'tenant_admin' && user?.role !== 'admin' && <SiteClock />}

        <div className={cn('flex items-center gap-0.5 rounded-xl p-0.5', lightTheme.background.secondary)}>
          <NotificationsBell
            unreadAlerts={unreadAlerts}
            liveAlerts={liveAlerts}
            onMarkRead={onMarkRead}
            onDismiss={onDismiss}
            onDismissAll={onDismissAll}
          />

          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            className={cn('rounded-lg', lightTheme.text.secondary)}
            aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          >
            {theme === 'light' ? <Moon className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
          </Button>
        </div>

        <span className={cn('mx-1 h-7 w-px', 'bg-border')} aria-hidden="true" />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                'flex items-center gap-2 rounded-full pl-1 pr-1.5 py-1 transition-colors',
                lightTheme.background.hover,
              )}
              aria-label="User menu"
            >
              <span className="w-9 h-9 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-semibold shrink-0">
                {initials}
              </span>
              <span className="hidden lg:flex flex-col items-start min-w-0 leading-tight">
                <span className={cn('text-sm font-medium max-w-[140px] truncate', lightTheme.text.primary)}>
                  {user?.name}
                </span>
                <span className={cn('text-[11px] max-w-[140px] truncate', lightTheme.text.muted)}>
                  {portalLabel}
                </span>
              </span>
              <ChevronDown className={cn('w-4 h-4 shrink-0 hidden lg:block', lightTheme.text.muted)} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel className="flex items-center gap-3">
              <span className="w-9 h-9 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-semibold shrink-0">
                <User className="w-5 h-5" />
              </span>
              <span className="min-w-0">
                <span className={cn('block text-sm font-medium truncate', lightTheme.text.primary)}>{user?.name}</span>
                <span className={cn('block text-xs truncate', lightTheme.text.secondary)}>{user?.email}</span>
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setPwDialogOpen(true)}>
              <Lock className="w-4 h-4 mr-2" />
              Change Password
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={logout}
              className="text-rose-600 dark:text-rose-400 focus:text-rose-600 dark:focus:text-rose-400"
            >
              <LogOut className="w-4 h-4 mr-2" />
              Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ChangePasswordDialog open={pwDialogOpen} onClose={() => setPwDialogOpen(false)} />
    </header>
  );
};
