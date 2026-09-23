import React, { useEffect, useState, useCallback } from 'react';
import { Cpu, Plus, Loader2, RefreshCw, KeyRound, PowerOff, Copy, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../../contexts/AuthContext';
import { useManifest } from '../../../contexts/ManifestContext';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';
import { apiRequest, ApiError } from '../../../services/http/apiClient';
import { Card, CardContent } from '../../ui/card';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Badge } from '../../ui/badge';
import { ConfirmModal } from '../../ui/confirm-modal';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';

const TRANSPORT_BASE = '/transport';

interface DeviceRow {
  id: string;
  busId: string;
  deviceCode: string;
  cameraPosition: 'boarding' | 'deboarding';
  status: 'active' | 'maintenance' | 'offline';
  lastHeartbeat: string | null;
  decommissionedAt: string | null;
}

interface BusOption { id: string; busCode: string; routeId: string | null; }
interface RouteOption { id: string; routeName: string; }

interface CreateForm {
  routeId: string;
  busId: string;
  deviceCode: string;
  cameraPosition: 'boarding' | 'deboarding';
}

const emptyForm: CreateForm = { routeId: '', busId: '', deviceCode: '', cameraPosition: 'boarding' };

const STATUS_BADGE: Record<string, string> = {
  active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  maintenance: 'bg-amber-50 text-amber-700 border-amber-200',
  offline: 'bg-slate-100 text-slate-500 border-slate-200',
};

/** Shown exactly once, right after create/rotate — the backend never returns the secret again after this. */
const SecretRevealDialog: React.FC<{ secret: string | null; onClose: () => void }> = ({ secret, onClose }) => (
  <Dialog open={!!secret} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><ShieldAlert className="w-4 h-4 text-amber-500" /> Device Secret</DialogTitle>
        <DialogDescription>
          Copy this now and store it on the device — it will not be shown again. Rotating the secret invalidates this one immediately.
        </DialogDescription>
      </DialogHeader>
      <div className="flex items-center gap-2 py-2">
        <code className="flex-1 text-xs bg-slate-100 dark:bg-slate-800 rounded-lg px-3 py-2 break-all">{secret}</code>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { if (secret) { navigator.clipboard.writeText(secret); toast.success('Copied'); } }}
        >
          <Copy className="w-3.5 h-3.5" />
        </Button>
      </div>
      <DialogFooter>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export const DeviceManagement: React.FC = () => {
  const { accessToken } = useAuth();
  const { manifest } = useManifest();
  const scopeHeaders = useScopeHeaders();
  // Transport Admin views/monitors devices tenant-wide; provisioning a
  // device to a route/bus is the Route Manager's action — Admin sees
  // exactly what Route Managers have set up, but doesn't create it here.
  // manifest.role is the canonical RBAC role (matches nav); useAuth().user.role
  // can carry the legacy frs_user.role value instead and silently mismatch.
  const canManage = manifest?.role !== 'tenant_admin';
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [buses, setBuses] = useState<BusOption[]>([]);
  const [routes, setRoutes] = useState<RouteOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [decommissionTarget, setDecommissionTarget] = useState<DeviceRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!accessToken) return;
    setLoading(true);
    Promise.all([
      apiRequest<DeviceRow[]>(`${TRANSPORT_BASE}/devices`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<BusOption[]>(`${TRANSPORT_BASE}/buses`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<RouteOption[]>(`${TRANSPORT_BASE}/routes`, { method: 'GET', accessToken, scopeHeaders }),
    ])
      .then(([d, b, r]) => { setDevices(d); setBuses(b); setRoutes(r ?? []); })
      .catch(() => toast.error('Failed to load devices'))
      .finally(() => setLoading(false));
  }, [accessToken]);

  useEffect(() => { load(); }, [load]);

  const busById = new Map<string, BusOption>(buses.map(b => [b.id, b]));
  const routeById = new Map<string, RouteOption>(routes.map(r => [r.id, r]));
  const busCode = (id: string) => busById.get(id)?.busCode ?? id.slice(0, 8);
  const busRouteName = (id: string) => {
    const routeId = busById.get(id)?.routeId;
    return routeId ? (routeById.get(routeId)?.routeName ?? null) : null;
  };
  const busesOnRoute = buses.filter(b => b.routeId === form.routeId);

  const openCreate = () => { setForm(emptyForm); setDialogOpen(true); };

  const save = async () => {
    if (!form.routeId) { toast.error('Select a route'); return; }
    if (!form.busId) { toast.error('Select a bus on that route'); return; }
    if (!form.deviceCode.trim()) { toast.error('Device code is required'); return; }
    setSaving(true);
    try {
      // routeId only drives the bus dropdown above — the backend's device
      // record is keyed by busId alone, matching TransportDeviceRequest.
      const result = await apiRequest<{ device: DeviceRow; deviceSecret: string }>(`${TRANSPORT_BASE}/devices`, {
        method: 'POST', accessToken, scopeHeaders,
        body: JSON.stringify({ busId: form.busId, deviceCode: form.deviceCode, cameraPosition: form.cameraPosition }),
      });
      setDialogOpen(false);
      setRevealedSecret(result.deviceSecret);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Failed to register device');
    } finally {
      setSaving(false);
    }
  };

  const rotateSecret = async (device: DeviceRow) => {
    setBusyId(device.id);
    try {
      const result = await apiRequest<{ device: DeviceRow; deviceSecret: string }>(`${TRANSPORT_BASE}/devices/${device.id}/rotate-secret`, {
        method: 'POST', accessToken, scopeHeaders,
      });
      setRevealedSecret(result.deviceSecret);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Failed to rotate secret');
    } finally {
      setBusyId(null);
    }
  };

  const confirmDecommission = async () => {
    if (!decommissionTarget) return;
    setBusyId(decommissionTarget.id);
    try {
      await apiRequest(`${TRANSPORT_BASE}/devices/${decommissionTarget.id}/decommission`, { method: 'POST', accessToken, scopeHeaders });
      toast.success('Device decommissioned');
      setDecommissionTarget(null);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Failed to decommission device');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800 dark:text-white">Devices</h1>
          <p className="text-sm text-muted-foreground">
            {canManage ? 'Jetson boxes reporting boarding/deboarding events' : 'Fleet-wide visibility into devices provisioned by Route Managers'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load}><RefreshCw className="w-4 h-4" /></Button>
          {canManage && (
            <Button size="sm" onClick={openCreate}><Plus className="w-4 h-4 mr-1" /> Provision Device</Button>
          )}
        </div>
      </div>

      <Card className="border shadow-sm rounded-2xl overflow-hidden">
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
          ) : devices.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              <Cpu className="w-8 h-8 mx-auto mb-2 opacity-40" />
              No devices registered yet.
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                  <th className="py-3 px-4 text-left">Device Code</th>
                  <th className="py-3 px-4 text-left">Route</th>
                  <th className="py-3 px-4 text-left">Bus</th>
                  <th className="py-3 px-4 text-left">Position</th>
                  <th className="py-3 px-4 text-left">Status</th>
                  <th className="py-3 px-4 text-left">Last Heartbeat</th>
                  {canManage && <th className="py-3 px-4 text-center w-32">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {devices.map(d => (
                  <tr key={d.id} className="hover:bg-slate-50/40 dark:hover:bg-slate-800/10 transition-colors">
                    <td className="py-3.5 px-4 font-semibold text-slate-800 dark:text-slate-100">{d.deviceCode}</td>
                    <td className="py-3.5 px-4 text-slate-500">{busRouteName(d.busId) ?? '—'}</td>
                    <td className="py-3.5 px-4 text-slate-500">{busCode(d.busId)}</td>
                    <td className="py-3.5 px-4 text-slate-500 capitalize">{d.cameraPosition}</td>
                    <td className="py-3.5 px-4">
                      <Badge variant="outline" className={STATUS_BADGE[d.status]}>{d.status}</Badge>
                    </td>
                    <td className="py-3.5 px-4 text-slate-500">{d.lastHeartbeat ? new Date(d.lastHeartbeat).toLocaleString() : 'Never'}</td>
                    {canManage && (
                      <td className="py-3.5 px-4">
                        <div className="flex items-center justify-center gap-1">
                          <Button variant="ghost" size="sm" disabled={busyId === d.id} onClick={() => rotateSecret(d)} title="Rotate secret">
                            <KeyRound className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            variant="ghost" size="sm" disabled={busyId === d.id || !!d.decommissionedAt}
                            onClick={() => setDecommissionTarget(d)} title="Decommission"
                          >
                            <PowerOff className="w-3.5 h-3.5 text-rose-500" />
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Provision Device</DialogTitle>
            <DialogDescription>Assign this device to a route, then the bus on that route it's mounted in. A signing secret is generated once you save — you'll get one chance to copy it.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Route <span className="text-rose-500">*</span></Label>
              <Select value={form.routeId} onValueChange={v => setForm(f => ({ ...f, routeId: v, busId: '' }))}>
                <SelectTrigger><SelectValue placeholder="Select a route" /></SelectTrigger>
                <SelectContent>
                  {routes.map(r => <SelectItem key={r.id} value={r.id}>{r.routeName}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Bus <span className="text-rose-500">*</span></Label>
              <Select value={form.busId} onValueChange={v => setForm(f => ({ ...f, busId: v }))} disabled={!form.routeId || busesOnRoute.length === 0}>
                <SelectTrigger><SelectValue placeholder={!form.routeId ? 'Select a route first' : busesOnRoute.length === 0 ? 'No buses on this route' : 'Select a bus on this route'} /></SelectTrigger>
                <SelectContent>
                  {busesOnRoute.map(b => <SelectItem key={b.id} value={b.id}>{b.busCode}</SelectItem>)}
                </SelectContent>
              </Select>
              {form.routeId && busesOnRoute.length === 0 && (
                <p className="text-[11px] text-muted-foreground">No buses assigned to this route yet — assign one on the Fleet page first.</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Device Code <span className="text-rose-500">*</span></Label>
              <Input placeholder="e.g. JETSON-042-FRONT" value={form.deviceCode}
                onChange={e => setForm(f => ({ ...f, deviceCode: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Camera Position <span className="text-rose-500">*</span></Label>
              <Select value={form.cameraPosition} onValueChange={v => setForm(f => ({ ...f, cameraPosition: v as CreateForm['cameraPosition'] }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="boarding">Boarding</SelectItem>
                  <SelectItem value="deboarding">Deboarding</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving}>{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Provision'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SecretRevealDialog secret={revealedSecret} onClose={() => setRevealedSecret(null)} />

      <ConfirmModal
        isOpen={!!decommissionTarget}
        onClose={() => setDecommissionTarget(null)}
        onConfirm={confirmDecommission}
        title="Decommission this device?"
        description={`"${decommissionTarget?.deviceCode}" will stop being able to submit events. This cannot be undone from here.`}
        confirmText="Decommission"
        variant="destructive"
        isLoading={!!busyId}
      />
    </div>
  );
};

export default DeviceManagement;
