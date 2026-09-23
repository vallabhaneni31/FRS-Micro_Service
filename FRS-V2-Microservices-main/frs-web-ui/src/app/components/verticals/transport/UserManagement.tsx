import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { UserPlus, Trash2, Loader2, RefreshCw } from 'lucide-react';
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

interface DepotOption { id: string; depotName: string; address: string | null; }
interface BusOption { id: string; busCode: string; depotId: string | null; }
interface ScopeRow { id: string; keycloakSubject: string; depotId: string | null; busId: string | null; createdAt: string; }
interface PlatformUser {
  pk_user_id?: number;
  id?: string;
  email: string;
  username: string;
  role: string;
  keycloak_sub: string | null;
}

type PersonRole = 'site_admin' | 'hr_manager';

interface AssignedRow {
  scope: ScopeRow;
  user: PlatformUser | null; // null if the profile hasn't loaded/matched yet — shown as "Loading…" rather than dropped
}

interface CreateForm {
  role: PersonRole;
  name: string;
  email: string;
  depotId: string;
  busId: string;
}

const emptyForm = (role: PersonRole): CreateForm => ({ role, name: '', email: '', depotId: '', busId: '' });

/**
 * Transport Admin manages Route Managers only here — they don't create or
 * edit Operations Managers directly (that's the Route Manager's own job,
 * scoped to their depot's buses). Instead, Admin gets a read-only
 * organizational overview rolled up from real data: for each Route Manager,
 * their depot's route count, bus count, and the Operations Managers
 * currently assigned to buses within that depot. Depot CRUD itself lives on
 * the separate Depots page, not here.
 *
 * Route Manager (site_admin) sees only the Operations Manager section, and
 * only their own depot's — enforced server-side (GET/POST/DELETE
 * /transport/user-scopes are already scope-aware), this component never
 * re-derives that filtering itself, matching the rest of this vertical's
 * "backend enforces, frontend just renders what it's given" pattern.
 *
 * User CREATION reuses the existing platform's POST /users as-is (confirmed
 * fully generic, no vertical checks) — this page never talks to Keycloak
 * directly. It only additionally assigns a depot/bus via
 * POST /transport/user-scopes once the platform user exists. The Keycloak
 * subject needed for that isn't in POST /users' own response, so a
 * follow-up GET /users locates it — see createAndAssign below.
 */
export const UserManagement: React.FC = () => {
  const { accessToken } = useAuth();
  const { manifest } = useManifest();
  const scopeHeaders = useScopeHeaders();
  // manifest.role is the canonical RBAC role (what nav is actually built
  // from) — NOT useAuth().user.role, which can carry the legacy
  // frs_user.role value (e.g. 'admin' instead of 'tenant_admin' for the
  // same account) and silently mismatches, as it did here.
  const isAdmin = manifest?.role === 'tenant_admin';

  const [depots, setDepots] = useState<DepotOption[]>([]);
  const [buses, setBuses] = useState<BusOption[]>([]);
  const [scopes, setScopes] = useState<ScopeRow[]>([]);
  const [platformUsers, setPlatformUsers] = useState<PlatformUser[]>([]);
  const [loading, setLoading] = useState(true);

  const [dialogRole, setDialogRole] = useState<PersonRole | null>(null);
  const [form, setForm] = useState<CreateForm>(emptyForm('hr_manager'));
  const [saving, setSaving] = useState(false);

  const [unassignTarget, setUnassignTarget] = useState<AssignedRow | null>(null);
  const [busyScopeId, setBusyScopeId] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!accessToken) return;
    setLoading(true);
    Promise.all([
      apiRequest<DepotOption[]>(`${TRANSPORT_BASE}/depots`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<BusOption[]>(`${TRANSPORT_BASE}/buses`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<ScopeRow[]>(`${TRANSPORT_BASE}/user-scopes`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<{ data: PlatformUser[] }>('/users', { method: 'GET', accessToken, scopeHeaders }),
    ])
      .then(([depotList, busList, scopeList, usersRes]) => {
        setDepots(depotList ?? []);
        setBuses(busList ?? []);
        setScopes(scopeList ?? []);
        setPlatformUsers(usersRes?.data ?? []);
      })
      .catch(() => toast.error('Failed to load user management data'))
      .finally(() => setLoading(false));
  }, [accessToken]);

  useEffect(() => { load(); }, [load]);

  const depotById = useMemo(() => new Map(depots.map(d => [d.id, d])), [depots]);
  const busById = useMemo(() => new Map(buses.map(b => [b.id, b])), [buses]);
  const userBySub = useMemo(() => new Map(platformUsers.filter(u => u.keycloak_sub).map(u => [u.keycloak_sub as string, u])), [platformUsers]);

  const routeManagerRows: AssignedRow[] = useMemo(
    () => scopes.filter(s => s.depotId != null).map(s => ({ scope: s, user: userBySub.get(s.keycloakSubject) ?? null })),
    [scopes, userBySub]
  );
  const operationsManagerRows: AssignedRow[] = useMemo(
    () => scopes.filter(s => s.busId != null).map(s => ({ scope: s, user: userBySub.get(s.keycloakSubject) ?? null })),
    [scopes, userBySub]
  );


  const openCreate = (role: PersonRole) => { setForm(emptyForm(role)); setDialogRole(role); };

  const createAndAssign = async () => {
    if (!form.name.trim()) { toast.error('Name is required'); return; }
    if (!form.email.trim()) { toast.error('Email is required'); return; }
    if (form.role === 'site_admin' && !form.depotId) { toast.error('Select a depot'); return; }
    if (form.role === 'hr_manager' && !form.busId) { toast.error('Select a bus'); return; }

    setSaving(true);
    try {
      // Step 1: create the platform user via the EXISTING, unmodified
      // corporate endpoint — password is a throwaway value; the backend
      // never reads it (users set their own via the invite email it sends).
      const created = await apiRequest<{ pk_user_id?: number; id?: string }>('/users', {
        method: 'POST', accessToken, scopeHeaders,
        body: JSON.stringify({
          email: form.email, username: form.name, password: crypto.randomUUID(),
          role: form.role, department: '', siteIds: [],
        }),
      });
      const newUserId = String(created.pk_user_id ?? created.id);

      // Step 2: POST /users doesn't return the Keycloak subject, so fetch
      // the fresh list and find it — the Keycloak sync is awaited
      // server-side before POST /users responds, so it's normally already
      // populated by this point.
      const usersRes = await apiRequest<{ data: PlatformUser[] }>('/users', { method: 'GET', accessToken, scopeHeaders });
      const createdUser = usersRes.data.find(u => String(u.pk_user_id ?? u.id) === newUserId);
      if (!createdUser?.keycloak_sub) {
        toast.error('User was created, but their Keycloak account is still syncing. Refresh in a moment and try assigning them again.');
        setPlatformUsers(usersRes.data);
        setDialogRole(null);
        return;
      }

      // Step 3: assign the depot/bus scope.
      await apiRequest(`${TRANSPORT_BASE}/user-scopes`, {
        method: 'POST', accessToken, scopeHeaders,
        body: JSON.stringify({
          keycloakSubject: createdUser.keycloak_sub,
          depotId: form.role === 'site_admin' ? form.depotId : undefined,
          busId: form.role === 'hr_manager' ? form.busId : undefined,
        }),
      });

      toast.success(form.role === 'site_admin' ? 'Route Manager created and assigned' : 'Operations Manager created and assigned');
      setDialogRole(null);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Failed to create user');
    } finally {
      setSaving(false);
    }
  };

  const confirmUnassign = async () => {
    if (!unassignTarget) return;
    setBusyScopeId(unassignTarget.scope.id);
    try {
      await apiRequest(`${TRANSPORT_BASE}/user-scopes/${unassignTarget.scope.id}`, { method: 'DELETE', accessToken, scopeHeaders });
      toast.success('Unassigned');
      setUnassignTarget(null);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Failed to unassign');
    } finally {
      setBusyScopeId(null);
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
          <h1 className="text-xl font-bold text-slate-800 dark:text-white">User Management</h1>
          <p className="text-sm text-muted-foreground">
            {isAdmin ? 'Create and manage Route Managers — the full Depot → Route Manager → Routes → Buses picture lives on the Depots page' : 'Assign Operations Managers to buses in your depot'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load}><RefreshCw className="w-4 h-4" /></Button>
      </div>

      {isAdmin ? (
        <PersonTable
          title="Route Managers"
          rows={routeManagerRows}
          targetLabel={row => depotById.get(row.scope.depotId ?? '')?.depotName ?? 'Unknown depot'}
          onAdd={() => openCreate('site_admin')}
          onUnassign={row => setUnassignTarget(row)}
          busyScopeId={busyScopeId}
        />
      ) : (
        <PersonTable
          title="Operations Managers"
          rows={operationsManagerRows}
          targetLabel={row => busById.get(row.scope.busId ?? '')?.busCode ?? 'Unknown bus'}
          onAdd={() => openCreate('hr_manager')}
          onUnassign={row => setUnassignTarget(row)}
          busyScopeId={busyScopeId}
        />
      )}

      {/* Create Route Manager / Operations Manager */}
      <Dialog open={dialogRole != null} onOpenChange={open => { if (!open) setDialogRole(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialogRole === 'site_admin' ? 'Add Route Manager' : 'Add Operations Manager'}</DialogTitle>
            <DialogDescription>
              Creates a platform account (an invite email is sent) and assigns them to {dialogRole === 'site_admin' ? 'a depot' : 'a bus'}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Name <span className="text-rose-500">*</span></Label>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Email <span className="text-rose-500">*</span></Label>
              <Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
            </div>
            {dialogRole === 'site_admin' ? (
              <div className="space-y-1.5">
                <Label>Depot <span className="text-rose-500">*</span></Label>
                <Select value={form.depotId} onValueChange={v => setForm(f => ({ ...f, depotId: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select a depot" /></SelectTrigger>
                  <SelectContent>
                    {depots.map(d => <SelectItem key={d.id} value={d.id}>{d.depotName}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>Bus <span className="text-rose-500">*</span></Label>
                <Select value={form.busId} onValueChange={v => setForm(f => ({ ...f, busId: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select a bus" /></SelectTrigger>
                  <SelectContent>
                    {buses.map(b => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.busCode}{isAdmin && b.depotId ? ` — ${depotById.get(b.depotId)?.depotName ?? ''}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogRole(null)} disabled={saving}>Cancel</Button>
            <Button onClick={createAndAssign} disabled={saving}>{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Create & Assign'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmModal
        isOpen={!!unassignTarget}
        onClose={() => setUnassignTarget(null)}
        onConfirm={confirmUnassign}
        title="Unassign this person?"
        description={`"${unassignTarget?.user?.username ?? unassignTarget?.user?.email ?? 'This person'}" will lose access to their assigned ${unassignTarget?.scope.depotId ? 'depot' : 'bus'}. Their account itself is not deleted.`}
        confirmText="Unassign"
        variant="destructive"
        isLoading={!!busyScopeId}
      />
    </div>
  );
};

const PersonTable: React.FC<{
  title: string;
  rows: AssignedRow[];
  targetLabel: (row: AssignedRow) => string;
  onAdd: () => void;
  onUnassign: (row: AssignedRow) => void;
  busyScopeId: string | null;
}> = ({ title, rows, targetLabel, onAdd, onUnassign, busyScopeId }) => (
  <Card className="border shadow-sm rounded-2xl overflow-hidden">
    <CardContent className="p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200">{title}</h3>
        <Button size="sm" onClick={onAdd}><UserPlus className="w-4 h-4 mr-1" /> Add</Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center">No {title.toLowerCase()} assigned yet.</p>
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-100 dark:border-slate-800 text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
              <th className="py-2 px-3 text-left">Name</th>
              <th className="py-2 px-3 text-left">Email</th>
              <th className="py-2 px-3 text-left">Assigned To</th>
              <th className="py-2 px-3 text-center w-16">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map(row => (
              <tr key={row.scope.id}>
                <td className="py-2.5 px-3 font-semibold text-slate-800 dark:text-slate-100">{row.user?.username ?? 'Loading…'}</td>
                <td className="py-2.5 px-3 text-slate-500">{row.user?.email ?? '—'}</td>
                <td className="py-2.5 px-3"><Badge variant="outline">{targetLabel(row)}</Badge></td>
                <td className="py-2.5 px-3 text-center">
                  <Button variant="ghost" size="sm" disabled={busyScopeId === row.scope.id} onClick={() => onUnassign(row)}>
                    <Trash2 className="w-3.5 h-3.5 text-rose-500" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </CardContent>
  </Card>
);

export default UserManagement;
