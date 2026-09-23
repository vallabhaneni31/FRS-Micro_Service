import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Building2, Plus, Loader2, RefreshCw, Pencil, Route as RouteIcon, Bus as BusIcon, ChevronDown, ChevronRight, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';
import { apiRequest, ApiError } from '../../../services/http/apiClient';
import { Card, CardContent } from '../../ui/card';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Badge } from '../../ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../ui/dialog';

const TRANSPORT_BASE = '/transport';

interface DepotRow { id: string; depotName: string; address: string | null; }
interface RouteRow { id: string; routeName: string; depotId: string | null; }
interface BusRow { id: string; busCode: string; depotId: string | null; routeId: string | null; }
interface ScopeRow { id: string; keycloakSubject: string; depotId: string | null; busId: string | null; }
interface PlatformUser { pk_user_id?: number; id?: string; username: string; email: string; keycloak_sub: string | null; }

interface DepotForm { depotName: string; address: string; }
const emptyForm: DepotForm = { depotName: '', address: '' };

/**
 * Transport Admin's complete operational picture: Depot -> Route Manager ->
 * Routes -> Buses (with each route's Operations Manager, via the bus
 * they're assigned to). Every relationship here is derived from data the
 * Route Manager themselves created (routes/buses/user-scope assignments) —
 * this page only adds/edits the depot record itself; the hierarchy beneath
 * it is view-only, matching the "Admin monitors, Route Manager manages"
 * split used throughout this vertical.
 */
export const Depots: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();

  const [depots, setDepots] = useState<DepotRow[]>([]);
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [buses, setBuses] = useState<BusRow[]>([]);
  const [scopes, setScopes] = useState<ScopeRow[]>([]);
  const [platformUsers, setPlatformUsers] = useState<PlatformUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<DepotForm>(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    if (!accessToken) return;
    setLoading(true);
    Promise.all([
      apiRequest<DepotRow[]>(`${TRANSPORT_BASE}/depots`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<RouteRow[]>(`${TRANSPORT_BASE}/routes`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<BusRow[]>(`${TRANSPORT_BASE}/buses`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<ScopeRow[]>(`${TRANSPORT_BASE}/user-scopes`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<{ data: PlatformUser[] }>('/users', { method: 'GET', accessToken, scopeHeaders }),
    ])
      .then(([d, r, b, s, usersRes]) => {
        setDepots(d ?? []);
        setRoutes(r ?? []);
        setBuses(b ?? []);
        setScopes(s ?? []);
        setPlatformUsers(usersRes?.data ?? []);
      })
      .catch(() => toast.error('Failed to load depots'))
      .finally(() => setLoading(false));
  }, [accessToken]);

  useEffect(() => { load(); }, [load]);

  const userBySub = useMemo(() => new Map(platformUsers.filter(u => u.keycloak_sub).map(u => [u.keycloak_sub as string, u])), [platformUsers]);
  const routeManagerByDepot = useMemo(() => {
    const m = new Map<string, PlatformUser | null>();
    scopes.filter(s => s.depotId).forEach(s => m.set(s.depotId as string, userBySub.get(s.keycloakSubject) ?? null));
    return m;
  }, [scopes, userBySub]);
  const omByBusId = useMemo(() => {
    const m = new Map<string, PlatformUser | null>();
    scopes.filter(s => s.busId).forEach(s => m.set(s.busId as string, userBySub.get(s.keycloakSubject) ?? null));
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
  const busCountByDepot = useMemo(() => {
    const m = new Map<string, number>();
    buses.forEach(b => { if (b.depotId) m.set(b.depotId, (m.get(b.depotId) ?? 0) + 1); });
    return m;
  }, [buses]);

  const toggleExpand = (id: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const openCreate = () => { setEditingId(null); setForm(emptyForm); setDialogOpen(true); };
  const openEdit = (d: DepotRow) => { setEditingId(d.id); setForm({ depotName: d.depotName, address: d.address ?? '' }); setDialogOpen(true); };

  const save = async () => {
    if (!form.depotName.trim()) { toast.error('Depot name is required'); return; }
    setSaving(true);
    try {
      const body = JSON.stringify({ depotName: form.depotName.trim(), address: form.address.trim() || null });
      if (editingId) {
        await apiRequest(`${TRANSPORT_BASE}/depots/${editingId}`, { method: 'PATCH', accessToken, scopeHeaders, body });
        toast.success('Depot updated');
      } else {
        await apiRequest(`${TRANSPORT_BASE}/depots`, { method: 'POST', accessToken, scopeHeaders, body });
        toast.success('Depot created');
      }
      setDialogOpen(false);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Failed to save depot');
    } finally {
      setSaving(false);
    }
  };

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
          <h1 className="text-xl font-bold text-slate-800 dark:text-white">Depots</h1>
          <p className="text-sm text-muted-foreground">Depot → Route Manager → Routes → Buses, end to end</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load}><RefreshCw className="w-4 h-4" /></Button>
          <Button size="sm" onClick={openCreate}><Plus className="w-4 h-4 mr-1" /> Add Depot</Button>
        </div>
      </div>

      {depots.length === 0 ? (
        <Card className="border shadow-sm rounded-2xl">
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            <Building2 className="w-8 h-8 mx-auto mb-2 opacity-40" />
            No depots yet — add your first one to start organizing Route Managers, routes, and buses.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {depots.map(d => {
            const isOpen = expanded.has(d.id);
            const rm = routeManagerByDepot.get(d.id);
            const depotRoutes = routesByDepot.get(d.id) ?? [];
            return (
              <Card key={d.id} className="border shadow-sm rounded-2xl overflow-hidden">
                <CardContent className="p-0">
                  <button
                    onClick={() => toggleExpand(d.id)}
                    className="w-full flex items-center justify-between gap-4 p-4 text-left hover:bg-slate-50/60 dark:hover:bg-slate-800/20 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {isOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-800 dark:text-white truncate">{d.depotName}</p>
                        {d.address && <p className="text-xs text-muted-foreground truncate">{d.address}</p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline" className="gap-1"><UserRound className="w-3 h-3" /> {rm?.username ?? 'Unassigned'}</Badge>
                      <Badge variant="outline" className="gap-1"><RouteIcon className="w-3 h-3" /> {depotRoutes.length}</Badge>
                      <Badge variant="outline" className="gap-1"><BusIcon className="w-3 h-3" /> {busCountByDepot.get(d.id) ?? 0}</Badge>
                      <Button variant="ghost" size="sm" onClick={e => { e.stopPropagation(); openEdit(d); }} title="Edit depot">
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </button>

                  {isOpen && (
                    <div className="border-t border-border">
                      {depotRoutes.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-6 text-center">No routes set up in this depot yet.</p>
                      ) : (
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                              <th className="py-2.5 px-4 text-left">Route</th>
                              <th className="py-2.5 px-4 text-left">Bus</th>
                              <th className="py-2.5 px-4 text-left">Operations Manager</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {depotRoutes.map(r => {
                              const routeBuses = busesByRoute.get(r.id) ?? [];
                              if (routeBuses.length === 0) {
                                return (
                                  <tr key={r.id}>
                                    <td className="py-2.5 px-4 font-medium text-slate-700 dark:text-slate-200">{r.routeName}</td>
                                    <td className="py-2.5 px-4 text-muted-foreground">No bus assigned</td>
                                    <td className="py-2.5 px-4 text-muted-foreground">—</td>
                                  </tr>
                                );
                              }
                              return routeBuses.map((b, i) => {
                                const om = omByBusId.get(b.id);
                                return (
                                  <tr key={b.id}>
                                    {i === 0 && (
                                      <td className="py-2.5 px-4 font-medium text-slate-700 dark:text-slate-200" rowSpan={routeBuses.length}>{r.routeName}</td>
                                    )}
                                    <td className="py-2.5 px-4"><Badge variant="outline">{b.busCode}</Badge></td>
                                    <td className="py-2.5 px-4 text-slate-500">{om?.username ?? 'Unassigned'}</td>
                                  </tr>
                                );
                              });
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit Depot' : 'Add Depot'}</DialogTitle>
            <DialogDescription>Depots group Route Managers, routes, and buses by physical location.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Depot Name <span className="text-rose-500">*</span></Label>
              <Input placeholder="e.g. North Yard" value={form.depotName}
                onChange={e => setForm(f => ({ ...f, depotName: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Address</Label>
              <Input placeholder="Optional" value={form.address}
                onChange={e => setForm(f => ({ ...f, address: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving}>{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : (editingId ? 'Save' : 'Create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Depots;
