import React, { useEffect, useState, useCallback } from 'react';
import { Bus as BusIcon, Plus, Loader2, Pencil, Trash2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../../contexts/AuthContext';
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

interface BusRow {
  id: string;
  busCode: string;
  registrationNo: string | null;
  routeId: string | null;
  capacity: number | null;
  status: 'active' | 'maintenance' | 'retired';
}

interface RouteOption { id: string; routeName: string; }

interface BusForm {
  busCode: string;
  registrationNo: string;
  routeId: string; // '' = none
  capacity: string;
  status: 'active' | 'maintenance' | 'retired';
}

const emptyForm: BusForm = { busCode: '', registrationNo: '', routeId: '', capacity: '', status: 'active' };

const STATUS_BADGE: Record<string, string> = {
  active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  maintenance: 'bg-amber-50 text-amber-700 border-amber-200',
  retired: 'bg-slate-100 text-slate-500 border-slate-200',
};

export const FleetManagement: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [buses, setBuses] = useState<BusRow[]>([]);
  const [routes, setRoutes] = useState<RouteOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<BusForm>(emptyForm);
  const [deleteTarget, setDeleteTarget] = useState<BusRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    if (!accessToken) return;
    setLoading(true);
    Promise.all([
      apiRequest<BusRow[]>(`${TRANSPORT_BASE}/buses`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<RouteOption[]>(`${TRANSPORT_BASE}/routes`, { method: 'GET', accessToken, scopeHeaders }),
    ])
      .then(([b, r]) => { setBuses(b); setRoutes(r); })
      .catch(() => toast.error('Failed to load fleet'))
      .finally(() => setLoading(false));
  }, [accessToken]);

  useEffect(() => { load(); }, [load]);

  const routeName = (id: string | null) => routes.find(r => r.id === id)?.routeName ?? '—';

  const openCreate = () => { setEditingId(null); setForm(emptyForm); setDialogOpen(true); };
  const openEdit = (b: BusRow) => {
    setEditingId(b.id);
    setForm({
      busCode: b.busCode,
      registrationNo: b.registrationNo ?? '',
      routeId: b.routeId ?? '',
      capacity: b.capacity != null ? String(b.capacity) : '',
      status: b.status,
    });
    setDialogOpen(true);
  };

  const save = async () => {
    if (!form.busCode.trim()) { toast.error('Bus code is required'); return; }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        busCode: form.busCode,
        registrationNo: form.registrationNo || null,
        routeId: form.routeId || null,
        capacity: form.capacity ? Number(form.capacity) : null,
        status: form.status,
      };
      if (editingId) {
        await apiRequest(`${TRANSPORT_BASE}/buses/${editingId}`, { method: 'PATCH', accessToken, scopeHeaders, body: JSON.stringify(body) });
        toast.success('Bus updated');
      } else {
        await apiRequest(`${TRANSPORT_BASE}/buses`, { method: 'POST', accessToken, scopeHeaders, body: JSON.stringify(body) });
        toast.success('Bus added');
      }
      setDialogOpen(false);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Failed to save bus');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiRequest(`${TRANSPORT_BASE}/buses/${deleteTarget.id}`, { method: 'DELETE', accessToken, scopeHeaders });
      toast.success('Bus removed');
      setDeleteTarget(null);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Failed to remove bus');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800 dark:text-white">Fleet</h1>
          <p className="text-sm text-muted-foreground">Buses and their route assignments</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load}><RefreshCw className="w-4 h-4" /></Button>
          <Button size="sm" onClick={openCreate}><Plus className="w-4 h-4 mr-1" /> Add Bus</Button>
        </div>
      </div>

      <Card className="border shadow-sm rounded-2xl overflow-hidden">
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
          ) : buses.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              <BusIcon className="w-8 h-8 mx-auto mb-2 opacity-40" />
              No buses yet — add one to start tracking occupancy.
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                  <th className="py-3 px-4 text-left">Bus Code</th>
                  <th className="py-3 px-4 text-left">Registration</th>
                  <th className="py-3 px-4 text-left">Route</th>
                  <th className="py-3 px-4 text-center">Capacity</th>
                  <th className="py-3 px-4 text-left">Status</th>
                  <th className="py-3 px-4 text-center w-24">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {buses.map(b => (
                  <tr key={b.id} className="hover:bg-slate-50/40 dark:hover:bg-slate-800/10 transition-colors">
                    <td className="py-3.5 px-4 font-semibold text-slate-800 dark:text-slate-100">{b.busCode}</td>
                    <td className="py-3.5 px-4 text-slate-500">{b.registrationNo ?? '—'}</td>
                    <td className="py-3.5 px-4 text-slate-500">{routeName(b.routeId)}</td>
                    <td className="py-3.5 px-4 text-center text-slate-500">{b.capacity ?? '—'}</td>
                    <td className="py-3.5 px-4">
                      <Badge variant="outline" className={STATUS_BADGE[b.status]}>{b.status}</Badge>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex items-center justify-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(b)}><Pencil className="w-3.5 h-3.5" /></Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(b)}><Trash2 className="w-3.5 h-3.5 text-rose-500" /></Button>
                      </div>
                    </td>
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
            <DialogTitle>{editingId ? 'Edit Bus' : 'Add Bus'}</DialogTitle>
            <DialogDescription>Buses report occupancy once a device is assigned to them.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Bus Code <span className="text-rose-500">*</span></Label>
              <Input placeholder="e.g. BUS-042" value={form.busCode}
                onChange={e => setForm(f => ({ ...f, busCode: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Registration Number</Label>
              <Input placeholder="Optional" value={form.registrationNo}
                onChange={e => setForm(f => ({ ...f, registrationNo: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Route</Label>
              <Select value={form.routeId || 'none'} onValueChange={v => setForm(f => ({ ...f, routeId: v === 'none' ? '' : v }))}>
                <SelectTrigger><SelectValue placeholder="No route assigned" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No route assigned</SelectItem>
                  {routes.map(r => <SelectItem key={r.id} value={r.id}>{r.routeName}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Capacity</Label>
              <Input type="number" min={0} placeholder="Optional" value={form.capacity}
                onChange={e => setForm(f => ({ ...f, capacity: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={v => setForm(f => ({ ...f, status: v as BusForm['status'] }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="maintenance">Maintenance</SelectItem>
                  <SelectItem value="retired">Retired</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving}>{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmModal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title="Remove this bus?"
        description={`"${deleteTarget?.busCode}" will be removed. This does not delete its historical boarding/deboarding events.`}
        confirmText="Remove"
        variant="destructive"
        isLoading={deleting}
      />
    </div>
  );
};

export default FleetManagement;
