import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { MapContainer, TileLayer, CircleMarker, Polyline, Tooltip as LeafletTooltip, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { Route as RouteIcon, Loader2, RefreshCw, MapPin } from 'lucide-react';
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
const ROUTE_COLORS = ['#4F46E5', '#10B981', '#F59E0B', '#E11D48', '#0EA5E9', '#8B5CF6'];
const DEFAULT_CENTER: [number, number] = [20.5937, 78.9629]; // geographic center of India — a neutral fallback view, not route data

interface StopEntry { name: string; lat: number | null; lng: number | null; }
interface RouteRow { id: string; routeName: string; stops: StopEntry[] | null; }

const FitBounds: React.FC<{ points: [number, number][] }> = ({ points }) => {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) {
      map.setView(points[0], 13);
    } else {
      map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
    }
  }, [points, map]);
  return null;
};

/**
 * Route Manager's route map — kept as its own page, not folded into the
 * Dashboard. Draws real routes as polylines connecting their real, geocoded
 * stops (from the Routes page's per-stop lat/lng, added specifically to
 * make this page possible without fabricating any coordinates). A route
 * with fewer than 2 geocoded stops simply can't be drawn — it's listed with
 * a note instead of silently faking a path.
 */
export const RouteMap: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!accessToken) return;
    setLoading(true);
    apiRequest<RouteRow[]>(`${TRANSPORT_BASE}/routes`, { method: 'GET', accessToken, scopeHeaders })
      .then(r => setRoutes(r ?? []))
      .catch(() => toast.error('Failed to load routes'))
      .finally(() => setLoading(false));
  }, [accessToken]);

  useEffect(() => { load(); }, [load]);

  const mappable = useMemo(() => routes.map(r => ({
    ...r,
    points: (r.stops ?? [])
      .filter((s): s is StopEntry & { lat: number; lng: number } => s.lat != null && s.lng != null)
      .map(s => [s.lat, s.lng] as [number, number]),
  })), [routes]);

  const drawable = mappable.filter(r => r.points.length >= 2);
  const allPoints = useMemo(() => {
    const target = selectedId ? mappable.filter(r => r.id === selectedId) : drawable;
    return target.flatMap(r => r.points);
  }, [mappable, drawable, selectedId]);

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
          <h1 className="text-xl font-bold text-slate-800 dark:text-white">Route Map</h1>
          <p className="text-sm text-muted-foreground">Real stop coordinates from the Routes page, plotted geographically</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}><RefreshCw className="w-4 h-4" /></Button>
      </div>

      {routes.length === 0 ? (
        <Card className="border shadow-sm rounded-2xl">
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            <RouteIcon className="w-8 h-8 mx-auto mb-2 opacity-40" />
            No routes yet — create one on the Routes page.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
          <Card className="border shadow-sm rounded-2xl overflow-hidden h-fit">
            <CardContent className="p-2">
              {routes.map((r, idx) => {
                const points = mappable.find(m => m.id === r.id)?.points ?? [];
                const color = ROUTE_COLORS[idx % ROUTE_COLORS.length];
                const isSelected = selectedId === r.id;
                return (
                  <button
                    key={r.id}
                    onClick={() => setSelectedId(isSelected ? null : r.id)}
                    className={cn(
                      'w-full text-left px-3 py-2.5 rounded-xl flex items-center gap-2.5 transition-colors',
                      isSelected ? 'bg-primary/10' : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                    )}
                  >
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: points.length >= 2 ? color : '#CBD5E1' }} />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">{r.routeName}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {points.length >= 2 ? `${points.length} stops mapped` : `${(r.stops ?? []).length} stop(s), needs coordinates`}
                      </p>
                    </div>
                  </button>
                );
              })}
            </CardContent>
          </Card>

          <Card className="border shadow-sm rounded-2xl overflow-hidden">
            <CardContent className="p-0">
              {drawable.length === 0 ? (
                <div className="py-16 text-center text-sm text-muted-foreground">
                  <MapPin className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  No routes have enough geocoded stops to draw yet — add latitude/longitude to at least two stops on a route to see it here.
                </div>
              ) : (
                <div className="h-[520px] w-full" style={{ isolation: 'isolate' }}>
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
                    <FitBounds points={allPoints} />
                    {drawable.map((r, idx) => {
                      const color = ROUTE_COLORS[idx % ROUTE_COLORS.length];
                      const isDimmed = selectedId != null && selectedId !== r.id;
                      return (
                        <React.Fragment key={r.id}>
                          <Polyline positions={r.points} pathOptions={{ color, weight: isDimmed ? 2 : 5, opacity: isDimmed ? 0.25 : 0.9 }} />
                          {r.points.map((p, i) => (
                            <CircleMarker key={i} center={p} radius={isDimmed ? 3 : 6} pathOptions={{ color: '#fff', fillColor: color, fillOpacity: isDimmed ? 0.3 : 1, weight: 2 }}>
                              <LeafletTooltip direction="top" offset={[0, -5]}>
                                <span>{r.routeName} — {r.stops?.[i]?.name ?? `Stop ${i + 1}`}</span>
                              </LeafletTooltip>
                            </CircleMarker>
                          ))}
                        </React.Fragment>
                      );
                    })}
                  </MapContainer>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
};

export default RouteMap;
