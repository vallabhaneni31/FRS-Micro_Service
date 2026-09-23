import React, { useState, useEffect, useCallback } from 'react';
import { DeviceManagement } from '../verticals/corporate/admin/DeviceManagement';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  ArrowLeft, Users, Globe, BarChart3, Shield, Server,
  Loader2, Building2, Clock, Tag, Camera,
  UserCheck, UserX, Timer, Wifi, WifiOff, AlertCircle,
  Calendar, TrendingUp, Trash2, Mail,
} from 'lucide-react';
import { cn } from '../ui/utils';
import { lightTheme } from '../../../theme/lightTheme';
import { PageHeader } from '../shared/PageHeader';
import { useAuth } from '../../contexts/AuthContext';
import { apiRequest } from '../../services/http/apiClient';
import { toast } from 'sonner';

interface Props {
  tenantId: string;
  tenantName: string;
  tenantTypeName: string | null;
  onBack: () => void;
}

// ── Tab definitions ────────────────────────────────────────────────────────────
const TABS = [
  { key: 'overview',  label: 'Overview',        icon: BarChart3 },
  { key: 'admins',    label: 'Tenant Admins',   icon: Shield    },
  { key: 'sites',     label: 'Sites',           icon: Globe     },
  { key: 'users',     label: 'Users',           icon: Users     },
  { key: 'devices',   label: 'Edge Devices',    icon: Server    },
  // { key: 'analytics', label: 'Analytics',       icon: BarChart3 },
];

// ── Shared scoped fetch ────────────────────────────────────────────────────────
function useTenantRequest<T>(
  path: string,
  tenantId: string,
  accessToken: string | null
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiRequest<T>(path, {
        accessToken,
        scopeHeaders: { 'x-tenant-id': tenantId },
      });
      setData(result);
    } catch {
      toast.error(`Failed to load ${path}`);
    } finally {
      setLoading(false);
    }
  }, [path, tenantId, accessToken]);

  useEffect(() => { load(); }, [load]);
  return { data, loading, reload: load };
}

// ── Shared UI primitives ───────────────────────────────────────────────────────
const Spinner = () => (
  <div className="flex justify-center h-40 items-center">
    <Loader2 className="w-6 h-6 animate-spin text-primary" />
  </div>
);

const Empty: React.FC<{ text: string }> = ({ text }) => (
  <div className={cn('flex flex-col items-center justify-center h-40 gap-2', lightTheme.text.muted)}>
    <Building2 className="w-8 h-8 opacity-30" />
    <p className="text-sm">{text}</p>
  </div>
);

// ── Overview tab (tier-aware) ──────────────────────────────────────────────────
interface OverviewData {
  sites: number; customers: number; users: number;
  features: string[]; tenantTypeName: string | null;
  attendance: { totalEmployees: number; presentToday: number; absentToday: number; lateToday: number; attendanceRate: number };
  faceRecognition: { totalEmployees: number; enrolled: number; enrollmentRate: number };
  devices: { total: number; online: number; offline: number; error: number };
}

const MiniStat: React.FC<{ label: string; value: number | string; icon: React.ElementType; color: string; bg: string; sub?: string }> =
  ({ label, value, icon: Icon, color, bg, sub }) => (
    <Card className={cn('border shadow-sm', lightTheme.border.default)}>
      <CardContent className="p-4 flex items-center gap-3">
        <div className={cn('p-2.5 rounded-xl shrink-0', bg)}>
          <Icon className={cn('w-4 h-4', color)} />
        </div>
        <div className="min-w-0">
          <p className={cn('text-xl font-bold leading-none', lightTheme.text.primary)}>{value}</p>
          <p className={cn('text-xs mt-0.5', lightTheme.text.secondary)}>{label}</p>
          {sub && <p className={cn('text-xs', lightTheme.text.muted)}>{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );

const OverviewTab: React.FC<{ tenantId: string; accessToken: string | null }> = ({ tenantId, accessToken }) => {
  const { data, loading } = useTenantRequest<OverviewData>('/tenant-admin/overview', tenantId, accessToken);
  if (loading) return <Spinner />;
  if (!data) return <Empty text="No overview data" />;

  const has = (f: string) => (data.features ?? []).includes(f);

  return (
    <div className="space-y-6">

      {/* Core */}
      <div>
        <p className={cn('text-xs font-semibold uppercase tracking-wider mb-2', lightTheme.text.muted)}>Workspace</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <MiniStat label="Active Sites"  value={data.sites}     icon={Globe}     color="text-emerald-600" bg="bg-emerald-50" />
          <MiniStat label="Customers"     value={data.customers} icon={Building2} color="text-blue-600"    bg="bg-blue-50"   />
          <MiniStat label="Users"         value={data.users}     icon={Users}     color="text-violet-600"  bg="bg-violet-50" />
        </div>
      </div>



      {/* Face Recognition */}
      {has('face_recognition') && (
        <div>
          <p className={cn('text-xs font-semibold uppercase tracking-wider mb-2', lightTheme.text.muted)}>Face Recognition</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <MiniStat label="Total"       value={data.faceRecognition.totalEmployees} icon={Users}        color="text-slate-600"   bg="bg-slate-100"  />
            <MiniStat label="Enrolled"    value={data.faceRecognition.enrolled}       icon={Camera}       color="text-indigo-600"  bg="bg-indigo-50"  sub={`${data.faceRecognition.enrollmentRate}%`} />
            <MiniStat label="Pending"     value={Math.max(0, data.faceRecognition.totalEmployees - data.faceRecognition.enrolled)} icon={AlertCircle} color="text-rose-500" bg="bg-rose-50" />
          </div>
          {data.faceRecognition.totalEmployees > 0 && (
            <div className={cn('mt-2 border rounded-xl p-3 flex items-center gap-3', lightTheme.background.card, lightTheme.border.default)}>
              <Camera className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
              <div className="flex-1">
                <div className={cn('flex justify-between text-xs mb-1', lightTheme.text.muted)}>
                  <span>Enrollment coverage</span>
                  <span className={cn('font-semibold', lightTheme.text.secondary)}>{data.faceRecognition.enrollmentRate}%</span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-indigo-100">
                  <div className="h-1.5 rounded-full bg-indigo-500 transition-all" style={{ width: `${data.faceRecognition.enrollmentRate}%` }} />
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Devices */}
      {has('devices') && (
        <div>
          <p className={cn('text-xs font-semibold uppercase tracking-wider mb-2', lightTheme.text.muted)}>Devices</p>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MiniStat label="Total"   value={data.devices.total}   icon={Server}      color="text-slate-600"   bg="bg-slate-100"  />
            <MiniStat label="Online"  value={data.devices.online}  icon={Wifi}        color="text-emerald-600" bg="bg-emerald-50" />
            <MiniStat label="Offline" value={data.devices.offline} icon={WifiOff}     color="text-slate-500"   bg="bg-slate-100"  />
            <MiniStat label="Error"   value={data.devices.error}   icon={AlertCircle} color="text-rose-600"    bg="bg-rose-50"    />
          </div>
        </div>
      )}



      {/* No features */}
      {(data.features ?? []).length === 0 && (
        <Empty text="No features configured for this tenant" />
      )}
    </div>
  );
};

// ── Admins tab ─────────────────────────────────────────────────────────────────
const AdminsTab: React.FC<{ tenantId: string; accessToken: string | null }> = ({ tenantId, accessToken }) => {
  const { data, loading, reload: reloadAdmins } = useTenantRequest<{ users: any[] }>(
    '/tenant-admin/users', tenantId, accessToken
  );
  const [isOpen, setIsOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const handleAssign = async () => {
    if (!email.trim()) return;
    setSaving(true);
    try {
      await apiRequest(`/app-admin/tenants/${tenantId}/admins`, {
        method: 'POST',
        accessToken,
        body: JSON.stringify({ email: email.trim(), username: name.trim() || undefined })
      });
      toast.success('Tenant Admin assigned successfully');
      setIsOpen(false);
      setEmail('');
      setName('');
      reloadAdmins();
    } catch (e: any) {
      toast.error(e.message || 'Failed to assign Tenant Admin');
    } finally {
      setSaving(false);
    }
  };

  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const openDeleteAdmin = (u: any) => {
    setDeleteTarget(u);
    setIsDeleteOpen(true);
  };

  const handleDeleteAdmin = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiRequest(`/app-admin/tenants/${tenantId}/admins/${deleteTarget.id}`, {
        method: 'DELETE',
        accessToken,
      });
      toast.success('Tenant Admin deleted successfully. Confirmation email sent.');
      setIsDeleteOpen(false);
      setDeleteTarget(null);
      reloadAdmins();
    } catch (e: any) {
      toast.error(e.message || 'Failed to delete Tenant Admin');
    } finally {
      setDeleting(false);
    }
  };

  if (loading) return <Spinner />;
  const admins = (data?.users ?? []).filter(u =>
    u.rbac_roles?.some((r: any) => r.roleName === 'tenant_admin')
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className={cn('font-semibold', lightTheme.text.secondary)}>Administrators</h3>
        <Button size="sm" className="font-bold rounded-xl" onClick={() => setIsOpen(true)}>
          Assign Tenant Admin
        </Button>
      </div>

      <UserTable users={admins} emptyText="No tenant admins found" onDeleteUser={openDeleteAdmin} />

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-md rounded-2xl border-none">
          <DialogHeader>
            <DialogTitle className="font-black text-xl">Assign Tenant Admin</DialogTitle>
            <DialogDescription className={cn('text-sm', lightTheme.text.secondary)}>
              Assign an existing user or create a new user with the Tenant Admin role for this tenant.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-3">
            <div className="space-y-1.5">
              <Label htmlFor="admin-email">Email Address <span className="text-rose-500">*</span></Label>
              <Input
                id="admin-email"
                placeholder="admin@tenant.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-name">Full Name (optional)</Label>
              <Input
                id="admin-name"
                placeholder="John Doe"
                value={name}
                onChange={e => setName(e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" className="rounded-xl" onClick={() => setIsOpen(false)}>Cancel</Button>
            <Button
              className="font-bold rounded-xl"
              onClick={handleAssign}
              disabled={!email.trim() || saving}
            >
              {saving ? 'Assigning...' : 'Assign Admin'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Tenant Admin Confirmation Dialog */}
      <Dialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <DialogContent className="max-w-md rounded-2xl border-none">
          <DialogHeader>
            <DialogTitle className="font-black text-xl text-rose-600 flex items-center gap-2">
              <Trash2 className="w-5 h-5" /> Delete Tenant Admin
            </DialogTitle>
            <DialogDescription className={cn('text-sm pt-2', lightTheme.text.secondary)}>
              Are you sure you want to permanently delete tenant administrator <strong>{deleteTarget?.name ?? deleteTarget?.email}</strong> ({deleteTarget?.email})?
            </DialogDescription>
          </DialogHeader>
          <div className="p-3 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/50 rounded-xl text-xs text-rose-700 dark:text-rose-300 space-y-1 my-2">
            <p className="font-bold flex items-center gap-1">
              <Mail className="w-3.5 h-3.5" /> Deletion Confirmation Email
            </p>
            <p>A confirmation email notifying them of account deletion and access revocation will be sent to <strong>{deleteTarget?.email}</strong> automatically.</p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" className="rounded-xl" onClick={() => setIsDeleteOpen(false)} disabled={deleting}>Cancel</Button>
            <Button
              className="font-bold rounded-xl bg-rose-600 hover:bg-rose-700 text-white"
              onClick={handleDeleteAdmin}
              disabled={deleting}
            >
              {deleting ? 'Deleting...' : 'Delete Permanently'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

// ── Sites tab ──────────────────────────────────────────────────────────────────
const SitesTab: React.FC<{ tenantId: string; accessToken: string | null }> = ({ tenantId, accessToken }) => {
  const { data, loading } = useTenantRequest<{ sites: any[] }>(
    '/tenant-admin/sites', tenantId, accessToken
  );
  const [page, setPage] = useState(1);
  const PER_PAGE = 5;

  useEffect(() => {
    setPage(1);
  }, [data]);

  if (loading) return <Spinner />;
  const sites = data?.sites ?? [];
  if (sites.length === 0) return <Empty text="No sites" />;

  const total = sites.length;
  const totalPages = Math.ceil(total / PER_PAGE);
  const pagedList = sites.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  return (
    <Card className={cn('border shadow-sm', lightTheme.border.default)}>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className={cn('border-b', lightTheme.table.border, lightTheme.table.header)}>
                <th className="text-left px-6 py-3 font-medium">Site</th>
                <th className="text-left px-4 py-3 font-medium">Customer</th>
                <th className="text-left px-4 py-3 font-medium">City</th>
                <th className="text-center px-4 py-3 font-medium">Status</th>
                <th className="text-center px-4 py-3 font-medium">Devices</th>
              </tr>
            </thead>
            <tbody>
              {pagedList.map((s: any) => (
                <tr key={s.id} className={cn('border-b', lightTheme.table.border, lightTheme.table.rowHover)}>
                  <td className={cn('px-6 py-3 font-medium', lightTheme.text.primary)}>{s.name}</td>
                  <td className={cn('px-4 py-3', lightTheme.text.secondary)}>{s.customerName ?? '—'}</td>
                  <td className={cn('px-4 py-3', lightTheme.text.secondary)}>{s.city ?? '—'}</td>
                  <td className="px-4 py-3 text-center">
                    <Badge variant="outline"
                      className={s.status === 'active'
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-slate-100 text-slate-600'}>
                      {s.status}
                    </Badge>
                  </td>
                  <td className={cn('px-4 py-3 text-center', lightTheme.text.secondary)}>{s.device_count ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {total > PER_PAGE && (
          <div className="flex items-center justify-between p-3 border-t border-slate-200/10 bg-slate-50 dark:bg-slate-800 rounded-b-xl">
            <p className="text-xs text-slate-500 font-medium">
              Showing {Math.min((page - 1) * PER_PAGE + 1, total)}–{Math.min(page * PER_PAGE, total)} of {total} entries
            </p>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="h-8 text-xs rounded-lg font-bold"
              >
                Prev
              </Button>
              {Array.from({ length: totalPages }).map((_, idx: number) => (
                <Button
                  key={idx + 1}
                  variant={page === idx + 1 ? "default" : "outline"}
                  size="sm"
                  onClick={() => setPage(idx + 1)}
                  className="h-8 text-xs font-bold rounded-lg"
                >
                  {idx + 1}
                </Button>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="h-8 text-xs rounded-lg font-bold"
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

// ── Users tab ──────────────────────────────────────────────────────────────────
const UsersTab: React.FC<{ tenantId: string; accessToken: string | null }> = ({ tenantId, accessToken }) => {
  const { data, loading } = useTenantRequest<{ users: any[] }>(
    '/tenant-admin/users', tenantId, accessToken
  );
  if (loading) return <Spinner />;
  return <UserTable users={data?.users ?? []} emptyText="No users found" />;
};

// ── Analytics tab ──────────────────────────────────────────────────────────────
const AnalyticsTab: React.FC<{ tenantId: string; accessToken: string | null }> = ({ tenantId, accessToken }) => {
  const { data, loading } = useTenantRequest<{ attendanceLast30: any[]; siteActivity: any[] }>(
    '/tenant-admin/analytics', tenantId, accessToken
  );
  const [page, setPage] = useState(1);
  const PER_PAGE = 5;

  useEffect(() => {
    setPage(1);
  }, [data]);

  if (loading) return <Spinner />;
  const siteActivity = data?.siteActivity ?? [];
  const total = siteActivity.length;
  const totalPages = Math.ceil(total / PER_PAGE);
  const pagedList = siteActivity.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  return (
    <div className="space-y-6">

      {siteActivity.length > 0 && (
        <Card className={cn('border shadow-sm', lightTheme.border.default)}>
          <CardContent className="p-6">
            <h3 className={cn('font-semibold mb-4', lightTheme.text.secondary)}>Site Activity</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={cn('border-b', lightTheme.table.border, lightTheme.table.header)}>
                    <th className="text-left py-2 font-medium">Site</th>
                    <th className="text-center py-2 font-medium">Employees</th>
                    <th className="text-center py-2 font-medium">Devices</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedList.map((s: any) => (
                    <tr key={s.site} className={cn('border-b', lightTheme.table.border, lightTheme.table.rowHover)}>
                      <td className={cn('py-2.5 font-medium', lightTheme.text.primary)}>{s.site}</td>
                      <td className={cn('py-2.5 text-center', lightTheme.text.secondary)}>{s.employee_count}</td>
                      <td className={cn('py-2.5 text-center', lightTheme.text.secondary)}>{s.device_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {total > PER_PAGE && (
              <div className="flex items-center justify-between p-3 border-t border-slate-200/10 bg-slate-50 dark:bg-slate-800 rounded-b-xl mt-4">
                <p className="text-xs text-slate-500 font-medium">
                  Showing {Math.min((page - 1) * PER_PAGE + 1, total)}–{Math.min(page * PER_PAGE, total)} of {total} entries
                </p>
                <div className="flex gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="h-8 text-xs rounded-lg font-bold"
                  >
                    Prev
                  </Button>
                  {Array.from({ length: totalPages }).map((_, idx: number) => (
                    <Button
                      key={idx + 1}
                      variant={page === idx + 1 ? "default" : "outline"}
                      size="sm"
                      onClick={() => setPage(idx + 1)}
                      className="h-8 text-xs font-bold rounded-lg"
                    >
                      {idx + 1}
                    </Button>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    className="h-8 text-xs rounded-lg font-bold"
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
};

// ── Shared sub-components ──────────────────────────────────────────────────────
const ROLE_COLORS: Record<string, string> = {
  site_admin:   'bg-blue-100 text-blue-700 border-blue-200',
  hr_manager:   'bg-emerald-100 text-emerald-700 border-emerald-200',
  tenant_admin: 'bg-violet-100 text-violet-700 border-violet-200',
};

const UserTable: React.FC<{ users: any[]; emptyText: string; onDeleteUser?: (user: any) => void }> = ({ users, emptyText, onDeleteUser }) => {
  const [page, setPage] = useState(1);
  const PER_PAGE = 5;

  useEffect(() => {
    setPage(1);
  }, [users]);

  if (users.length === 0) return <Empty text={emptyText} />;

  const total = users.length;
  const totalPages = Math.ceil(total / PER_PAGE);
  const pagedList = users.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  return (
    <Card className={cn('border shadow-sm', lightTheme.border.default)}>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className={cn('border-b', lightTheme.table.border, lightTheme.table.header)}>
                <th className="text-left px-6 py-3 font-medium">User</th>
                <th className="text-left px-4 py-3 font-medium">Department</th>
                <th className="text-left px-4 py-3 font-medium">Roles</th>
                {onDeleteUser && <th className="text-right px-6 py-3 font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {pagedList.map((u: any) => (
                <tr key={u.id} className={cn('border-b', lightTheme.table.border, lightTheme.table.rowHover)}>
                  <td className="px-6 py-3">
                    <div className={cn('font-medium', lightTheme.text.primary)}>{u.name ?? u.email}</div>
                    <div className={cn('text-xs', lightTheme.text.secondary)}>{u.email}</div>
                  </td>
                  <td className={cn('px-4 py-3', lightTheme.text.secondary)}>{u.department ?? '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {/* A user can hold the same role scoped to several different
                          sites (one user_role row per site) — dedupe by role name
                          here since this column shows what access levels a user
                          has, not a site-by-site breakdown; otherwise a role like
                          hr_manager assigned across 4 sites renders as 4 identical,
                          indistinguishable badges that look like a duplication bug. */}
                      {Array.from(new Map((u.rbac_roles ?? []).map((r: any) => [r.roleName, r])).values()).map((r: any) => (
                        <Badge key={r.roleName} variant="outline"
                          className={`text-xs ${ROLE_COLORS[r.roleName] ?? 'bg-slate-100 text-slate-600'}`}>
                          <Shield className="w-2.5 h-2.5 mr-1" />{r.roleName}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  {onDeleteUser && (
                    <td className="px-6 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 rounded-lg text-slate-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 hover:text-rose-600 dark:hover:text-rose-400"
                        title="Delete Tenant Admin"
                        onClick={() => onDeleteUser(u)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {total > PER_PAGE && (
          <div className="flex items-center justify-between p-3 border-t border-slate-200/10 bg-slate-50 dark:bg-slate-800 rounded-b-xl">
            <p className="text-xs text-slate-500 font-medium">
              Showing {Math.min((page - 1) * PER_PAGE + 1, total)}–{Math.min(page * PER_PAGE, total)} of {total} entries
            </p>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="h-8 text-xs rounded-lg font-bold"
              >
                Prev
              </Button>
              {Array.from({ length: totalPages }).map((_, idx: number) => (
                <Button
                  key={idx + 1}
                  variant={page === idx + 1 ? "default" : "outline"}
                  size="sm"
                  onClick={() => setPage(idx + 1)}
                  className="h-8 text-xs font-bold rounded-lg"
                >
                  {idx + 1}
                </Button>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="h-8 text-xs rounded-lg font-bold"
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

// ── Main component ─────────────────────────────────────────────────────────────
export const TenantDrillDown: React.FC<Props> = ({ tenantId, tenantName, tenantTypeName, onBack }) => {
  const { accessToken } = useAuth();
  const [activeTab, setActiveTab] = useState('overview');

  const renderTab = () => {
    switch (activeTab) {
      case 'overview':  return <OverviewTab  tenantId={tenantId} accessToken={accessToken} />;
      case 'admins':    return <AdminsTab    tenantId={tenantId} accessToken={accessToken} />;
      case 'sites':     return <SitesTab     tenantId={tenantId} accessToken={accessToken} />;
      case 'users':     return <UsersTab     tenantId={tenantId} accessToken={accessToken} />;
      case 'devices':   return <DeviceManagement tenantId={tenantId} />;
      // case 'analytics': return <AnalyticsTab tenantId={tenantId} accessToken={accessToken} />;
      default:          return null;
    }
  };

  return (
    <div className="space-y-6 pb-16">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={onBack}
          className={cn('gap-2 -ml-2', lightTheme.text.secondary, 'hover:text-foreground')}>
          <ArrowLeft className="w-4 h-4" /> Back to Tenants
        </Button>
      </div>

      <PageHeader
        title={tenantName}
        icon={Building2}
        subtitle={tenantTypeName ? (
          <span className={cn('inline-flex items-center gap-1', lightTheme.status.info)}>
            <Tag className="w-3 h-3" />{tenantTypeName}
          </span>
        ) : undefined}
      />

      {/* Tabs */}
      <div className={cn('flex gap-1 border-b', lightTheme.border.default)}>
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div>{renderTab()}</div>
    </div>
  );
};
