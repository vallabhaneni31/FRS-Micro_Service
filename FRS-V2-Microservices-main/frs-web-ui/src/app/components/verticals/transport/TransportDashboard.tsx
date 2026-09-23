import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Bus, Users, ArrowDownToLine, ArrowUpFromLine, Loader2, RefreshCw, Camera, Building2, Route as RouteIcon, Cpu } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { useManifest } from '../../../contexts/ManifestContext';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';
import { apiRequest } from '../../../services/http/apiClient';
import { Card, CardContent } from '../../ui/card';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { cn } from '../../ui/utils';

const TRANSPORT_BASE = '/transport';

interface OccupancyRow {
  busId: string;
  occupancyCount: number;
  updatedAt: string;
}

interface BoardingEventRow {
  id: string;
  busId: string;
  eventType: 'BOARDING' | 'DEBOARDING';
  eventTime: string;
  personRef: string | null;
  confidence: number | null;
  photoKey: string | null;
}

interface BusRow {
  id: string;
  busCode: string;
  capacity: number | null;
  status: 'active' | 'maintenance' | 'retired';
  routeId: string | null;
  depotId: string | null;
}

interface RouteRow {
  id: string;
  routeName: string;
  depotId: string | null;
}

interface DeviceRow {
  id: string;
  busId: string;
  status: 'active' | 'maintenance' | 'offline';
}

interface DepotRow {
  id: string;
  depotName: string;
}

const StatCard: React.FC<{ label: string; value: string | number; sub?: string; icon: React.FC<any>; accentClass: string }> = ({ label, value, sub, icon: Icon, accentClass }) => (
  <Card className="border shadow-sm rounded-2xl">
    <CardContent className="p-5 flex items-center justify-between">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground mb-2">{label}</p>
        <p className={cn('text-[28px] font-bold leading-none', accentClass)}>{value}</p>
        {sub && <p className="text-[11px] text-muted-foreground mt-1.5">{sub}</p>}
      </div>
      <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
        <Icon className="w-5 h-5 text-primary" />
      </div>
    </CardContent>
  </Card>
);

const OverviewRow: React.FC<{ icon: React.FC<any>; label: string; active: number; total: number; otherLabel: string }> = ({ icon: Icon, label, active, total, otherLabel }) => {
  const pct = total > 0 ? Math.round((active / total) * 100) : 0;
  const other = total - active;
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-2">
          <Icon className="w-4 h-4 text-muted-foreground" /> {label}
        </span>
        <span className="text-sm text-muted-foreground">{total} Total</span>
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> {active} active</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-rose-500 inline-block" /> {other} {otherLabel}</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
};

/**
 * Overview page: aggregate occupancy across the fleet (or the caller's
 * depot/bus, per the backend's own scope enforcement — this component
 * never filters by depot itself, matching the "no depot picker" rule the
 * Bus List page follows too) + a recent boarding/deboarding activity feed.
 * Shared across tenant_admin (fleet-wide) and site_admin (own depot only,
 * enforced server-side) — the banner/depot badge below just reflects
 * whichever scope the backend already narrowed the data to.
 */
export const TransportDashboard: React.FC = () => {
  const { accessToken, translateRole } = useAuth();
  const { manifest } = useManifest();
  const scopeHeaders = useScopeHeaders();
  const [occupancy, setOccupancy] = useState<OccupancyRow[]>([]);
  const [recentEvents, setRecentEvents] = useState<BoardingEventRow[]>([]);
  const [buses, setBuses] = useState<BusRow[]>([]);
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [depots, setDepots] = useState<DepotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback((isManual = false) => {
    if (!accessToken) return;
    if (isManual) setRefreshing(true);
    Promise.all([
      apiRequest<OccupancyRow[]>(`${TRANSPORT_BASE}/occupancy`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<{ content: BoardingEventRow[] }>(`${TRANSPORT_BASE}/events?size=10`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<BusRow[]>(`${TRANSPORT_BASE}/buses`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<RouteRow[]>(`${TRANSPORT_BASE}/routes`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<DeviceRow[]>(`${TRANSPORT_BASE}/devices`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<DepotRow[]>(`${TRANSPORT_BASE}/depots`, { method: 'GET', accessToken, scopeHeaders }),
    ])
      .then(([occ, events, busList, routeList, deviceList, depotList]) => {
        setOccupancy(occ ?? []);
        setRecentEvents(events?.content ?? []);
        setBuses(busList ?? []);
        setRoutes(routeList ?? []);
        setDevices(deviceList ?? []);
        setDepots(depotList ?? []);
      })
      .catch(() => { /* surfaced via empty states below, not a blocking error */ })
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, [accessToken, scopeHeaders]);

  useEffect(() => {
    refresh();
    const id = setInterval(() => refresh(), 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  const busById = useMemo(() => new Map(buses.map(b => [b.id, b])), [buses]);
  const busLabel = (busId: string) => busById.get(busId)?.busCode ?? busId.slice(0, 8);

  const role = manifest?.role ?? '';
  const isTenantWide = role === 'tenant_admin' || role === 'viewer';
  const roleLabel = translateRole(role || 'tenant_admin');
  const myDepot = depots[0];

  const totalOnboard = occupancy.reduce((sum, o) => sum + o.occupancyCount, 0);

  const activeBuses = buses.filter(b => b.status === 'active').length;
  const assignedRouteIds = useMemo(() => new Set(buses.map(b => b.routeId).filter(Boolean) as string[]), [buses]);
  const unassignedRoutes = routes.filter(r => !assignedRouteIds.has(r.id)).length;
  const activeDevices = devices.filter(d => d.status === 'active').length;
  const offlineDevices = devices.filter(d => d.status === 'offline').length;

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="relative isolate overflow-hidden rounded-3xl bg-gradient-to-r from-[#4F46E5] to-[#6366F1] text-white shadow-lg p-8 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div className="space-y-2 max-w-3xl">
          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight">Hello, {roleLabel}</h1>
          <p className="text-indigo-100 text-sm md:text-base font-medium">
            {isTenantWide
              ? 'Monitor depots, routes, buses, and edge devices across your entire fleet.'
              : `Monitor routes, buses, and edge devices for ${myDepot?.depotName ?? 'your depot'}.`}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => refresh(true)}
          disabled={refreshing}
          className="mt-6 md:mt-0 bg-white/10 hover:bg-white/20 border border-white/20 text-white gap-2 text-sm font-semibold px-5 py-2.5 h-auto rounded-xl shrink-0 shadow-sm transition-all duration-300 backdrop-blur-md active:scale-95 disabled:opacity-50"
        >
          <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {isTenantWide && (
          <StatCard label="Depots" value={depots.length} icon={Building2} accentClass="text-slate-800 dark:text-white" />
        )}
        <StatCard label="Buses" value={buses.length} sub={`${activeBuses} active`} icon={Bus} accentClass="text-slate-800 dark:text-white" />
        <StatCard label="Routes" value={routes.length} sub={`${unassignedRoutes} unassigned`} icon={RouteIcon} accentClass="text-slate-800 dark:text-white" />
        <StatCard label="Devices" value={devices.length} sub={`${offlineDevices} offline`} icon={Cpu} accentClass="text-slate-800 dark:text-white" />
        {!isTenantWide && (
          <StatCard label="Onboard Now" value={totalOnboard} icon={Users} accentClass="text-indigo-600" />
        )}
      </div>

      <Card className="border shadow-sm rounded-2xl">
        <CardContent className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-6">
          <OverviewRow icon={Bus} label="Bus Fleet" active={activeBuses} total={buses.length} otherLabel="inactive" />
          <OverviewRow icon={Cpu} label="Edge Devices" active={activeDevices} total={devices.length} otherLabel="offline" />
        </CardContent>
      </Card>

      <Card className="border shadow-sm rounded-2xl">
        <CardContent className="p-5">
          <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-4">Live Occupancy by Bus</h3>
          {occupancy.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No occupancy data yet — buses show up here once a boarding/deboarding event has been processed.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {occupancy.map(o => {
                const bus = busById.get(o.busId);
                const capacity = bus?.capacity;
                const overCapacity = capacity != null && o.occupancyCount > capacity;
                return (
                  <div key={o.busId} className="rounded-xl border border-border p-3">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 truncate">{busLabel(o.busId)}</p>
                      {bus?.status && bus.status !== 'active' && (
                        <Badge variant="outline" className="text-[9px] capitalize border-amber-200 text-amber-700 bg-amber-50">{bus.status}</Badge>
                      )}
                    </div>
                    <p className={cn('text-2xl font-bold', overCapacity ? 'text-rose-600' : 'text-slate-800 dark:text-white')}>
                      {o.occupancyCount}
                      {capacity != null && <span className="text-sm font-medium text-muted-foreground"> / {capacity}</span>}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border shadow-sm rounded-2xl">
        <CardContent className="p-5">
          <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-4">Recent Activity</h3>
          {recentEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No boarding/deboarding events yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {recentEvents.map(e => (
                <div key={e.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div className="flex items-center gap-2 min-w-0">
                    {e.eventType === 'BOARDING'
                      ? <ArrowUpFromLine className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                      : <ArrowDownToLine className="w-3.5 h-3.5 text-amber-600 shrink-0" />}
                    <span className="font-medium text-slate-700 dark:text-slate-200">{e.eventType === 'BOARDING' ? 'Boarding' : 'Deboarding'}</span>
                    <Badge variant="outline" className="text-[10px] shrink-0">{busLabel(e.busId)}</Badge>
                    <span className="text-muted-foreground truncate">{e.personRef ?? 'Unrecognized'}</span>
                    {e.confidence != null && (
                      <span className="text-[10px] text-muted-foreground shrink-0">{Math.round(e.confidence * 100)}%</span>
                    )}
                    {e.photoKey && (
                      <Camera className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-label="Photo captured" />
                    )}
                  </div>
                  <span className="text-muted-foreground text-xs shrink-0">{new Date(e.eventTime).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default TransportDashboard;
