import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { MapContainer, TileLayer, CircleMarker, Polyline, Tooltip as LeafletTooltip, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { Users, MapPin, Bus as BusIcon, Route as RouteIcon, Loader2, RefreshCw, ArrowRightToLine, ArrowLeftFromLine } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';
import { apiRequest } from '../../../services/http/apiClient';
import { Card, CardContent } from '../../ui/card';
import { Button } from '../../ui/button';
import { cn } from '../../ui/utils';

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const TRANSPORT_BASE = '/transport';
const DEFAULT_CENTER: [number, number] = [20.5937, 78.9629]; // geographic center of India — neutral fallback, not route data

interface StopEntry { name: string; lat: number | null; lng: number | null; }
interface RouteRow { id: string; routeName: string; stops: StopEntry[] | null; }
interface BusRow { id: string; busCode: string; routeId: string | null; capacity: number | null; }
interface PassengerRow { id: string; fullName: string; }
interface BoardingEventRow { id: string; eventType: string; passengerId: string | null; eventTime: string; }

const FitBounds: React.FC<{ points: [number, number][] }> = ({ points }) => {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) map.setView(points[0], 14);
    else map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
  }, [points, map]);
  return null;
};

const KpiCard: React.FC<{ label: string; value: React.ReactNode; icon: React.FC<any> }> = ({ label, value, icon: Icon }) => (
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
 * Operations Manager's dashboard — deliberately its own component (not a
 * third role-branch inside TransportDashboard.tsx), registered as
 * 'hr_manager/transport_dashboard' in DashboardRenderer's PAGE_REGISTRY.
 * Every number here comes from real Passenger/Bus/Route/BoardingEvent data
 * for this one bus — "Today's Trips" has no backing schedule model yet, so
 * it stays an honest "Coming Soon" rather than a fabricated count.
 */
export const OperationsDashboard: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [bus, setBus] = useState<BusRow | null>(null);
  const [route, setRoute] = useState<RouteRow | null>(null);
  const [passengers, setPassengers] = useState<PassengerRow[]>([]);
  const [events, setEvents] = useState<BoardingEventRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    if (!accessToken) return;
    setLoading(true);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    Promise.all([
      apiRequest<BusRow[]>(`${TRANSPORT_BASE}/buses`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<PassengerRow[]>(`${TRANSPORT_BASE}/passengers`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<{ content: BoardingEventRow[] }>(
        `${TRANSPORT_BASE}/events?from=${encodeURIComponent(startOfToday.toISOString())}&size=200`,
        { method: 'GET', accessToken, scopeHeaders }
      ),
    ])
      .then(async ([buses, passengerRows, eventsRes]) => {
        const myBus = buses?.[0] ?? null;
        setBus(myBus);
        setPassengers(passengerRows ?? []);
        setEvents(eventsRes?.content ?? []);
        if (myBus?.routeId) {
          const routes = await apiRequest<RouteRow[]>(`${TRANSPORT_BASE}/routes`, { method: 'GET', accessToken, scopeHeaders });
          setRoute(routes?.[0] ?? null);
        } else {
          setRoute(null);
        }
      })
      .catch(() => toast.error('Failed to load dashboard'))
      .finally(() => setLoading(false));
  }, [accessToken]);

  useEffect(() => { load(); }, [load]);

  const nameById = useMemo(() => new Map(passengers.map(p => [p.id, p.fullName])), [passengers]);

  const currentlyOnBus = useMemo(() => {
    const byPassenger = new Map<string, BoardingEventRow[]>();
    events.forEach(e => {
      if (!e.passengerId) return;
      byPassenger.set(e.passengerId, [...(byPassenger.get(e.passengerId) ?? []), e]);
    });
    let count = 0;
    byPassenger.forEach(list => {
      const sorted = [...list].sort((a, b) => a.eventTime.localeCompare(b.eventTime));
      if (sorted[sorted.length - 1]?.eventType === 'BOARDING') count++;
    });
    return count;
  }, [events]);

  const recentActivity = useMemo(
    () => [...events].sort((a, b) => b.eventTime.localeCompare(a.eventTime)).slice(0, 10),
    [events]
  );

  const points = useMemo(() => (route?.stops ?? [])
    .filter((s): s is StopEntry & { lat: number; lng: number } => s.lat != null && s.lng != null)
    .map(s => [s.lat, s.lng] as [number, number]), [route]);

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
          <h1 className="text-xl font-bold text-slate-800 dark:text-white">Dashboard</h1>
          <p className="text-sm text-muted-foreground">{bus ? `Bus ${bus.busCode}` : 'No bus assigned yet'}</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}><RefreshCw className="w-4 h-4" /></Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Total Passengers" value={passengers.length} icon={Users} />
        <KpiCard label="Currently On Bus" value={`${currentlyOnBus}/${passengers.length}`} icon={BusIcon} />
        <KpiCard label="Bus Stops" value={route?.stops?.length ?? '—'} icon={MapPin} />
        <KpiCard label="Today's Trips" value="Coming Soon" icon={RouteIcon} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4">
        <Card className="border shadow-sm rounded-2xl overflow-hidden">
          <CardContent className="p-0">
            {points.length < 2 ? (
              <div className="py-16 text-center text-sm text-muted-foreground">
                <MapPin className="w-8 h-8 mx-auto mb-2 opacity-40" />
                {route ? 'Route needs at least two geocoded stops to draw a map.' : 'No route assigned to your bus yet.'}
              </div>
            ) : (
              <div className="h-[400px] w-full" style={{ isolation: 'isolate' }}>
                <MapContainer center={DEFAULT_CENTER} zoom={5} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
                  <TileLayer
                    url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                    attribution='&copy; <a href="https://www.esri.com/">Esri</a>'
                    maxZoom={19}
                  />
                  <TileLayer
                    url="https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
                    attribution=''
                    maxZoom={19}
                  />
                  <FitBounds points={points} />
                  <Polyline positions={points} pathOptions={{ color: '#4F46E5', weight: 5, opacity: 0.9 }} />
                  {points.map((p, i) => (
                    <CircleMarker key={i} center={p} radius={6} pathOptions={{ color: '#fff', fillColor: '#4F46E5', fillOpacity: 1, weight: 2 }}>
                      <LeafletTooltip direction="top" offset={[0, -5]}>
                        <span>{route?.stops?.[i]?.name ?? `Stop ${i + 1}`}</span>
                      </LeafletTooltip>
                    </CircleMarker>
                  ))}
                </MapContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border shadow-sm rounded-2xl">
          <CardContent className="p-5">
            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-4">Recent Activity</h3>
            {recentActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No boarding activity yet today.</p>
            ) : (
              <ul className="space-y-3">
                {recentActivity.map(e => (
                  <li key={e.id} className="flex items-start gap-3">
                    <div className={cn(
                      'w-7 h-7 rounded-full flex items-center justify-center shrink-0',
                      e.eventType === 'BOARDING' ? 'bg-emerald-500/10 text-emerald-600' : 'bg-primary/10 text-primary'
                    )}>
                      {e.eventType === 'BOARDING' ? <ArrowRightToLine className="w-3.5 h-3.5" /> : <ArrowLeftFromLine className="w-3.5 h-3.5" />}
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                        {(e.passengerId && nameById.get(e.passengerId)) ?? 'Unmatched passenger'} {e.eventType === 'BOARDING' ? 'boarded' : 'deboarded'}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {new Date(e.eventTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default OperationsDashboard;
