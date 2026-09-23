import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Building2, Route as RouteIcon, Bus as BusIcon, UserRound, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../../contexts/AuthContext';
import { useManifest } from '../../../contexts/ManifestContext';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';
import { apiRequest } from '../../../services/http/apiClient';
import { Card, CardContent } from '../../ui/card';
import { Button } from '../../ui/button';
import { cn } from '../../ui/utils';

const TRANSPORT_BASE = '/transport';
const DAYS = 30;

interface DepotRow { id: string; depotName: string; }
interface RouteRow { id: string; routeName: string; depotId: string | null; }
interface BusRow { id: string; busCode: string; depotId: string | null; routeId: string | null; }
interface ScopeRow { id: string; keycloakSubject: string; depotId: string | null; busId: string | null; }
interface PlatformUser { pk_user_id?: number; id?: string; username: string; keycloak_sub: string | null; }
interface BoardingEventRow { id: string; eventTime: string; }

const StatCard: React.FC<{ label: string; value: number; icon: React.FC<any> }> = ({ label, value, icon: Icon }) => (
  <Card className="border shadow-sm rounded-2xl">
    <CardContent className="p-5 flex items-center justify-between">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground mb-2">{label}</p>
        <p className="text-[28px] font-bold leading-none text-slate-800 dark:text-white">{value}</p>
      </div>
      <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
        <Icon className="w-5 h-5 text-primary" />
      </div>
    </CardContent>
  </Card>
);

/**
 * Transport Admin's org-wide picture: a compact hierarchy tree (Depot ->
 * Route Manager -> Routes -> Buses) plus a 30-day boarding density heatmap.
 * Every number here is derived from real Depot/Route/Bus/user-scope data —
 * the heatmap counts real boarding events from GET /transport/events, day
 * by day. At current data volumes a single bounded page (200 events) covers
 * the full 30-day window; a tenant with heavier real traffic would need a
 * dedicated backend aggregation endpoint instead of client-side counting.
 */
export const Analytics: React.FC = () => {
  const { accessToken, user } = useAuth();
  const { manifest } = useManifest();
  const scopeHeaders = useScopeHeaders();
  // Route Manager (site_admin) only ever sees their own depot, and the
  // user-scopes list endpoint deliberately never returns depot-level
  // (Route Manager) rows to a DEPOT-scoped caller — it's not that they
  // haven't been assigned, the endpoint just isn't the right source for
  // "who am I" here. Substitute their own identity directly instead of
  // showing a misleading "Unassigned" for their own depot.
  // manifest.role is the canonical RBAC role (matches nav); useAuth().user.role
  // can carry the legacy frs_user.role value instead and silently mismatch.
  const isRouteManager = manifest?.role === 'site_admin';

  const [depots, setDepots] = useState<DepotRow[]>([]);
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [buses, setBuses] = useState<BusRow[]>([]);
  const [scopes, setScopes] = useState<ScopeRow[]>([]);
  const [platformUsers, setPlatformUsers] = useState<PlatformUser[]>([]);
  const [events, setEvents] = useState<BoardingEventRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    if (!accessToken) return;
    setLoading(true);
    const from = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString();
    Promise.all([
      apiRequest<DepotRow[]>(`${TRANSPORT_BASE}/depots`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<RouteRow[]>(`${TRANSPORT_BASE}/routes`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<BusRow[]>(`${TRANSPORT_BASE}/buses`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<ScopeRow[]>(`${TRANSPORT_BASE}/user-scopes`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<{ data: PlatformUser[] }>('/users', { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<{ content: BoardingEventRow[] }>(`${TRANSPORT_BASE}/events?from=${encodeURIComponent(from)}&size=200`, { method: 'GET', accessToken, scopeHeaders }),
    ])
      .then(([d, r, b, s, usersRes, ev]) => {
        setDepots(d ?? []);
        setRoutes(r ?? []);
        setBuses(b ?? []);
        setScopes(s ?? []);
        setPlatformUsers(usersRes?.data ?? []);
        setEvents(ev?.content ?? []);
      })
      .catch(() => toast.error('Failed to load analytics'))
      .finally(() => setLoading(false));
  }, [accessToken]);

  useEffect(() => { load(); }, [load]);

  const userBySub = useMemo(() => new Map(platformUsers.filter(u => u.keycloak_sub).map(u => [u.keycloak_sub as string, u])), [platformUsers]);
  const routeManagerByDepot = useMemo(() => {
    const m = new Map<string, PlatformUser | null>();
    scopes.filter(s => s.depotId).forEach(s => m.set(s.depotId as string, userBySub.get(s.keycloakSubject) ?? null));
    return m;
  }, [scopes, userBySub]);
  const routesByDepot = useMemo(() => {
    const m = new Map<string, RouteRow[]>();
    routes.forEach(r => { if (r.depotId) m.set(r.depotId, [...(m.get(r.depotId) ?? []), r]); });
    return m;
  }, [routes]);
  const busesByRoute = useMemo(() => {
    const m = new Map<string, BusRow[]>();
    buses.forEach(b => { if (b.routeId) m.set(b.routeId, [...(m.get(b.routeId) ?? []), b]); });
    return m;
  }, [buses]);

  const routeManagerCount = useMemo(() => scopes.filter(s => s.depotId != null).length, [scopes]);
  const operationsManagerCount = useMemo(() => scopes.filter(s => s.busId != null).length, [scopes]);
  const routeManagerLabel = (depotId: string): string => {
    if (isRouteManager) return user?.name ?? 'You';
    return routeManagerByDepot.get(depotId)?.username ?? 'Unassigned Route Manager';
  };

  // Day -> event count for the last 30 days, oldest first.
  const heatmapDays = useMemo(() => {
    const counts = new Map<string, number>();
    events.forEach(e => {
      const day = e.eventTime.slice(0, 10);
      counts.set(day, (counts.get(day) ?? 0) + 1);
    });
    const days: { date: string; label: string; count: number }[] = [];
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      days.push({ date: iso, label: String(d.getDate()), count: counts.get(iso) ?? 0 });
    }
    return days;
  }, [events]);

  const maxCount = Math.max(1, ...heatmapDays.map(d => d.count));
  const heatClass = (count: number) => {
    if (count === 0) return 'bg-muted text-muted-foreground';
    const ratio = count / maxCount;
    if (ratio > 0.75) return 'bg-indigo-600 text-white';
    if (ratio > 0.5) return 'bg-indigo-400 text-white';
    if (ratio > 0.25) return 'bg-indigo-200 text-indigo-800';
    return 'bg-indigo-100 text-indigo-700';
  };
  const activeDays = heatmapDays.filter(d => d.count > 0).length;

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800 dark:text-white">Analytics</h1>
          <p className="text-sm text-muted-foreground">Organization hierarchy and boarding activity, last {DAYS} days</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}><RefreshCw className="w-4 h-4" /></Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {isRouteManager ? (
          <StatCard label="Operations Managers" value={operationsManagerCount} icon={UserRound} />
        ) : (
          <>
            <StatCard label="Depots" value={depots.length} icon={Building2} />
            <StatCard label="Route Managers" value={routeManagerCount} icon={UserRound} />
          </>
        )}
        <StatCard label="Routes" value={routes.length} icon={RouteIcon} />
        <StatCard label="Buses" value={buses.length} icon={BusIcon} />
      </div>

      <Card className="border shadow-sm rounded-2xl">
        <CardContent className="p-5">
          <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-4">{isRouteManager ? 'Your Depot' : 'Organization Hierarchy'}</h3>
          {depots.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No depots yet — the hierarchy fills in as depots, Route Managers, routes, and buses are added.</p>
          ) : (
            <ul className="space-y-4">
              {depots.map(d => {
                const depotRoutes = routesByDepot.get(d.id) ?? [];
                return (
                  <li key={d.id}>
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-white">
                      <Building2 className="w-4 h-4 text-indigo-500" /> {d.depotName}
                      <span className="text-xs font-normal text-muted-foreground flex items-center gap-1 ml-2">
                        <UserRound className="w-3 h-3" /> {routeManagerLabel(d.id)}
                      </span>
                    </div>
                    {depotRoutes.length > 0 && (
                      <ul className="mt-2 ml-6 space-y-1.5 border-l border-border pl-4">
                        {depotRoutes.map(r => {
                          const routeBuses = busesByRoute.get(r.id) ?? [];
                          return (
                            <li key={r.id} className="text-xs text-slate-600 dark:text-slate-300 flex items-center gap-2 flex-wrap">
                              <RouteIcon className="w-3 h-3 text-muted-foreground shrink-0" /> {r.routeName}
                              {routeBuses.map(b => (
                                <span key={b.id} className="inline-flex items-center gap-1 text-muted-foreground">
                                  <BusIcon className="w-3 h-3" /> {b.busCode}
                                </span>
                              ))}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="border shadow-sm rounded-2xl">
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200">Boarding Punch Density (Last {DAYS} Days)</h3>
            <span className="text-xs text-muted-foreground">{activeDays} of {DAYS} active days</span>
          </div>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No boarding/deboarding events in this window yet.</p>
          ) : (
            <div className="grid grid-cols-10 sm:grid-cols-15 gap-1.5">
              {heatmapDays.map(d => (
                <div
                  key={d.date}
                  title={`${d.date}: ${d.count} event${d.count === 1 ? '' : 's'}`}
                  className={cn('aspect-square rounded-md flex items-center justify-center text-[10px] font-semibold', heatClass(d.count))}
                >
                  {d.label}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default Analytics;
