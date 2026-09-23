import React, { useEffect, useState, useCallback } from 'react';
import { User, Mail, Bus as BusIcon, Route as RouteIcon, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';
import { apiRequest } from '../../../services/http/apiClient';
import { Card, CardContent } from '../../ui/card';
import { Button } from '../../ui/button';

const TRANSPORT_BASE = '/transport';

interface BusRow { id: string; busCode: string; registrationNo: string | null; capacity: number | null; routeId: string | null; }
interface RouteRow { id: string; routeName: string; }

/**
 * Read-only — the reference mockup's password-change and weekend-schedule
 * sections have no backing data model (no "route operates on weekends"
 * concept exists, and password reset is a separate, already-existing flow
 * elsewhere), so this stays profile + assignment info only.
 */
export const OperationsSettings: React.FC = () => {
  const { user, accessToken } = useAuth();
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
      .catch(() => toast.error('Failed to load settings'))
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

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800 dark:text-white">Settings</h1>
          <p className="text-sm text-muted-foreground">Your profile and route assignment</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}><RefreshCw className="w-4 h-4" /></Button>
      </div>

      <Card className="border shadow-sm rounded-2xl">
        <CardContent className="p-5 space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">Profile</h3>
          <div className="flex items-center gap-2 text-sm"><User className="w-3.5 h-3.5 text-muted-foreground" /> {user?.name ?? '—'}</div>
          <div className="flex items-center gap-2 text-sm"><Mail className="w-3.5 h-3.5 text-muted-foreground" /> {user?.email ?? '—'}</div>
        </CardContent>
      </Card>

      <Card className="border shadow-sm rounded-2xl">
        <CardContent className="p-5 space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">Route Assignment</h3>
          {!bus ? (
            <p className="text-sm text-muted-foreground">No bus assigned to your account yet — ask your Route Manager.</p>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm"><BusIcon className="w-3.5 h-3.5 text-muted-foreground" /> Bus {bus.busCode}{bus.registrationNo ? ` · ${bus.registrationNo}` : ''}</div>
              <div className="flex items-center gap-2 text-sm"><RouteIcon className="w-3.5 h-3.5 text-muted-foreground" /> {route ? route.routeName : 'No route assigned yet'}</div>
              {bus.capacity != null && (
                <div className="text-sm text-muted-foreground pl-5">Capacity: {bus.capacity} seats</div>
              )}
              <p className="text-[11px] text-muted-foreground pt-2">This information is read-only — assignment changes are managed by your Route Manager.</p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default OperationsSettings;
