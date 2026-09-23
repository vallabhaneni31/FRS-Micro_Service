import React, { useEffect, useState, useCallback } from 'react';
import { MapPin, Loader2, RefreshCw, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';
import { apiRequest } from '../../../services/http/apiClient';
import { Card, CardContent } from '../../ui/card';
import { Button } from '../../ui/button';
import { Badge } from '../../ui/badge';

const TRANSPORT_BASE = '/transport';

interface StopEntry { name: string; lat: number | null; lng: number | null; }
interface RouteRow { id: string; routeName: string; stops: StopEntry[] | null; }
interface BusRow { id: string; busCode: string; routeId: string | null; }

/**
 * Read-only for Operations Manager — stop authoring is Route Manager's job
 * (RouteManagement.tsx). "Add Stop" stays disabled with a tooltip, matching
 * the reference mockup's own placeholder — there is no stop-authoring
 * capability for this persona, not a missing feature to silently fake.
 */
export const OperationsBusStops: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [bus, setBus] = useState<BusRow | null>(null);
  const [route, setRoute] = useState<RouteRow | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    if (!accessToken) return;
    setLoading(true);
    apiRequest<BusRow[]>(`${TRANSPORT_BASE}/buses`, { method: 'GET', accessToken, scopeHeaders })
      .then(async buses => {
        const myBus = buses?.[0] ?? null;
        setBus(myBus);
        if (myBus?.routeId) {
          const routes = await apiRequest<RouteRow[]>(`${TRANSPORT_BASE}/routes`, { method: 'GET', accessToken, scopeHeaders });
          setRoute(routes?.[0] ?? null);
        } else {
          setRoute(null);
        }
      })
      .catch(() => toast.error('Failed to load stops'))
      .finally(() => setLoading(false));
  }, [accessToken]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  const stops = route?.stops ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800 dark:text-white">Bus Stops</h1>
          <p className="text-sm text-muted-foreground">
            {route ? `${route.routeName} — ${stops.length} stop${stops.length === 1 ? '' : 's'}` : bus ? 'No route assigned to your bus yet' : 'No bus assigned yet'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load}><RefreshCw className="w-4 h-4" /></Button>
          <Button size="sm" disabled title="Adding stops is managed by your Route Manager">
            <Plus className="w-4 h-4 mr-1" /> Add Stop (Coming Soon)
          </Button>
        </div>
      </div>

      <Card className="border shadow-sm rounded-2xl">
        <CardContent className="p-0">
          {stops.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              <MapPin className="w-8 h-8 mx-auto mb-2 opacity-40" />
              {route ? 'This route has no stops recorded yet.' : 'Ask your Route Manager to assign a route to your bus.'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                  <th className="py-3 px-4">Order</th>
                  <th className="py-3 px-4">Stop Name</th>
                  <th className="py-3 px-4">Coordinates</th>
                  <th className="py-3 px-4">Type</th>
                </tr>
              </thead>
              <tbody>
                {stops.map((s, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-3.5 px-4 text-muted-foreground">{i + 1}</td>
                    <td className="py-3.5 px-4 font-semibold text-slate-800 dark:text-slate-100">{s.name}</td>
                    <td className="py-3.5 px-4 text-muted-foreground font-mono text-xs">
                      {s.lat != null && s.lng != null ? `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}` : 'Not geocoded'}
                    </td>
                    <td className="py-3.5 px-4">
                      {i === 0 && <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">Start</Badge>}
                      {i === stops.length - 1 && i !== 0 && <Badge className="bg-red-100 text-red-700 hover:bg-red-100">End</Badge>}
                      {i !== 0 && i !== stops.length - 1 && <Badge variant="outline">Intermediate</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default OperationsBusStops;
