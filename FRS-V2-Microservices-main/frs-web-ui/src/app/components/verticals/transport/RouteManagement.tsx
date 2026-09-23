import React, { useEffect, useState, useCallback } from 'react';
import { Route, Plus, Loader2, Pencil, RefreshCw, X, MapPin } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';
import { apiRequest, ApiError } from '../../../services/http/apiClient';
import { Card, CardContent } from '../../ui/card';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../ui/dialog';

const TRANSPORT_BASE = '/transport';

interface StopEntry {
  name: string;
  lat: number | null;
  lng: number | null;
}

interface RouteRow {
  id: string;
  routeName: string;
  stops: StopEntry[] | null;
  createdAt: string;
}

/** Editable form shape — lat/lng kept as text while editing so a partially-typed
 * coordinate doesn't get silently coerced to 0; parsed to numbers on save. */
interface StopFormEntry { name: string; lat: string; lng: string; }
interface RouteForm { routeName: string; stops: StopFormEntry[]; }

const emptyForm: RouteForm = { routeName: '', stops: [] };
const emptyStop: StopFormEntry = { name: '', lat: '', lng: '' };

function stopsToForm(stops: RouteRow['stops']): StopFormEntry[] {
  if (!stops || stops.length === 0) return [];
  return stops.map(s => ({ name: s.name ?? '', lat: s.lat != null ? String(s.lat) : '', lng: s.lng != null ? String(s.lng) : '' }));
}

function formToStops(entries: StopFormEntry[]): StopEntry[] {
  return entries
    .filter(s => s.name.trim())
    .map(s => {
      const lat = s.lat.trim() ? Number(s.lat) : null;
      const lng = s.lng.trim() ? Number(s.lng) : null;
      return { name: s.name.trim(), lat: lat != null && !isNaN(lat) ? lat : null, lng: lng != null && !isNaN(lng) ? lng : null };
    });
}

function stopsSummary(stops: RouteRow['stops']): string {
  if (!stops || stops.length === 0) return '';
  return stops.map(s => s.name).join(', ');
}

export const RouteManagement: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<RouteForm>(emptyForm);

  const load = useCallback(() => {
    if (!accessToken) return;
    setLoading(true);
    apiRequest<RouteRow[]>(`${TRANSPORT_BASE}/routes`, { method: 'GET', accessToken, scopeHeaders })
      .then(setRoutes)
      .catch(() => toast.error('Failed to load routes'))
      .finally(() => setLoading(false));
  }, [accessToken]);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setEditingId(null); setForm(emptyForm); setDialogOpen(true); };
  const openEdit = (r: RouteRow) => {
    setEditingId(r.id);
    setForm({ routeName: r.routeName, stops: stopsToForm(r.stops) });
    setDialogOpen(true);
  };

  const addStopRow = () => setForm(f => ({ ...f, stops: [...f.stops, { ...emptyStop }] }));
  const removeStopRow = (idx: number) => setForm(f => ({ ...f, stops: f.stops.filter((_, i) => i !== idx) }));
  const updateStopRow = (idx: number, patch: Partial<StopFormEntry>) =>
    setForm(f => ({ ...f, stops: f.stops.map((s, i) => (i === idx ? { ...s, ...patch } : s)) }));

  const save = async () => {
    if (!form.routeName.trim()) { toast.error('Route name is required'); return; }
    setSaving(true);
    try {
      const body = { routeName: form.routeName, stops: formToStops(form.stops) };
      if (editingId) {
        await apiRequest(`${TRANSPORT_BASE}/routes/${editingId}`, { method: 'PATCH', accessToken, scopeHeaders, body: JSON.stringify(body) });
        toast.success('Route updated');
      } else {
        await apiRequest(`${TRANSPORT_BASE}/routes`, { method: 'POST', accessToken, scopeHeaders, body: JSON.stringify(body) });
        toast.success('Route created');
      }
      setDialogOpen(false);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Failed to save route');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800 dark:text-white">Routes</h1>
          <p className="text-sm text-muted-foreground">Bus routes and their stops</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load}><RefreshCw className="w-4 h-4" /></Button>
          <Button size="sm" onClick={openCreate}><Plus className="w-4 h-4 mr-1" /> New Route</Button>
        </div>
      </div>

      <Card className="border shadow-sm rounded-2xl overflow-hidden">
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
          ) : routes.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              <Route className="w-8 h-8 mx-auto mb-2 opacity-40" />
              No routes yet — create one to start assigning buses.
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                  <th className="py-3 px-4 text-left">Route Name</th>
                  <th className="py-3 px-4 text-left">Stops</th>
                  <th className="py-3 px-4 text-center w-24">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {routes.map(r => (
                  <tr key={r.id} className="hover:bg-slate-50/40 dark:hover:bg-slate-800/10 transition-colors">
                    <td className="py-3.5 px-4 font-semibold text-slate-800 dark:text-slate-100">{r.routeName}</td>
                    <td className="py-3.5 px-4 text-slate-500 truncate max-w-[320px]">{stopsSummary(r.stops) || '—'}</td>
                    <td className="py-3.5 px-4 text-center">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(r)}><Pencil className="w-3.5 h-3.5" /></Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit Route' : 'New Route'}</DialogTitle>
            <DialogDescription>Routes group stops that buses can be assigned to. Add coordinates per stop to have this route show up on Route Map.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Route Name <span className="text-rose-500">*</span></Label>
              <Input placeholder="e.g. North Campus Loop" value={form.routeName}
                onChange={e => setForm(f => ({ ...f, routeName: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Stops</Label>
                <Button type="button" variant="outline" size="sm" onClick={addStopRow}><Plus className="w-3.5 h-3.5 mr-1" /> Add Stop</Button>
              </div>
              {form.stops.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">No stops yet — add one above.</p>
              ) : (
                <div className="space-y-2">
                  {form.stops.map((stop, idx) => (
                    <div key={idx} className="flex items-start gap-2">
                      <Input
                        placeholder="Stop name"
                        value={stop.name}
                        onChange={e => updateStopRow(idx, { name: e.target.value })}
                        className="flex-[2]"
                      />
                      <Input
                        placeholder="Lat"
                        inputMode="decimal"
                        value={stop.lat}
                        onChange={e => updateStopRow(idx, { lat: e.target.value })}
                        className="flex-1"
                      />
                      <Input
                        placeholder="Lng"
                        inputMode="decimal"
                        value={stop.lng}
                        onChange={e => updateStopRow(idx, { lng: e.target.value })}
                        className="flex-1"
                      />
                      <Button type="button" variant="ghost" size="sm" onClick={() => removeStopRow(idx)} title="Remove stop">
                        <X className="w-3.5 h-3.5 text-muted-foreground" />
                      </Button>
                    </div>
                  ))}
                  <p className="text-[11px] text-muted-foreground flex items-center gap-1"><MapPin className="w-3 h-3" /> Lat/Lng are optional but required for the stop to appear on Route Map.</p>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving}>{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default RouteManagement;
