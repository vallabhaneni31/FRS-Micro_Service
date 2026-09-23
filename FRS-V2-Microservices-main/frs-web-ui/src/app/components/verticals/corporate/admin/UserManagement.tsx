import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'react-router';
import { Card, CardContent, CardHeader, CardTitle } from '../../../ui/card';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';
import { Label } from '../../../ui/label';
import { Badge } from '../../../ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../ui/table';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '../../../ui/dialog';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction
} from '../../../ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select';
import { Checkbox } from '../../../ui/checkbox';
import { toast } from 'sonner';
import { cn } from '../../../ui/utils';
import { lightTheme } from '../../../../../theme/lightTheme';
import { useAuth } from '../../../../contexts/AuthContext';
import { useManifest } from '../../../../contexts/ManifestContext';
import { apiRequest } from '../../../../services/http/apiClient';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { MetricCard } from '../../../shared/MetricCard';
import { User, Employee, UserRole } from '../../../../types';
import {
  UserCheck, Clock, UserCog, Search, Edit, Shield,
  UserPlus, KeyRound, UserX, UserCheck2, Mail, RefreshCw, Trash2,
  CheckCircle2, AlertCircle, AlertTriangle,
} from 'lucide-react';
import { validateDisplayName, validateEmailFormat, normalizeDisplayName, formatDisplayNameInput } from '../../../../utils/userValidation';
import { PasswordInput } from '../../../ui/PasswordInput';
import { useDebounce } from '../../../../hooks/useDebounce';

interface ExtendedUser extends User {
  last_login?: string;
  is_active: boolean;
  tenant_name?: string;
  site_id?: number | null;
  site_name?: string | null;
  site_ids?: number[] | null;
}

type PasswordStrength = 'weak' | 'medium' | 'strong';

function calcStrength(pwd: string): PasswordStrength {
  if (pwd.length < 6) return 'weak';
  if (pwd.length < 12 || !/[A-Z]/.test(pwd) || !/[0-9]/.test(pwd)) return 'medium';
  return 'strong';
}

function StrengthBar({ strength }: { strength: PasswordStrength }) {
  return (
    <div className="mt-2 space-y-1">
      <div className="flex gap-1 h-1">
        {(['weak', 'medium', 'strong'] as const).map((level, i) => {
          const filled = strength === 'strong' || (strength === 'medium' && i < 2) || (strength === 'weak' && i < 1);
          return (
            <div key={level} className={cn('flex-1 h-full rounded-full transition-all',
              filled
                ? strength === 'strong' ? 'bg-emerald-500' : strength === 'medium' ? 'bg-amber-500' : 'bg-rose-500'
                : 'bg-slate-200'
            )} />
          );
        })}
      </div>
      <span className={cn('text-[10px] font-bold uppercase tracking-wider block', {
        'text-emerald-600': strength === 'strong',
        'text-amber-600':   strength === 'medium',
        'text-rose-600':    strength === 'weak',
      })}>{strength}</span>
    </div>
  );
}

const ROLE_LABELS: Record<string, string> = {
  admin: 'Tenant Admin', hr: 'HR Personnel',
  hr_manager: 'HR Manager', viewer: 'Viewer', device_operator: 'Device Operator',
};

const ROLE_COLORS: Record<string, string> = {
  admin:           'bg-blue-100 text-blue-800',
  tenant_admin:    'bg-blue-100 text-blue-800',
  hr:              'bg-emerald-100 text-emerald-800',
  hr_manager:      'bg-teal-100 text-teal-800',
  site_admin:      'bg-indigo-100 text-indigo-800',
  viewer:          'bg-slate-100 text-slate-700',
  device_operator: 'bg-purple-100 text-purple-800',
};

export const UserManagement: React.FC = () => {
  const { page } = useParams<{ page?: string }>();
  const isTenantAdminsOnly = page === 'tenant_admins';
  const [searchQuery, setSearchQuery]           = useState('');
  const [isCreateOpen, setIsCreateOpen]         = useState(false);
  const [isEditOpen, setIsEditOpen]             = useState(false);
  const [isResetOpen, setIsResetOpen]           = useState(false);
  const [isToggleOpen, setIsToggleOpen]         = useState(false);
  const [editTarget, setEditTarget]             = useState<ExtendedUser | null>(null);
  const [resetTarget, setResetTarget]           = useState<ExtendedUser | null>(null);
  const [toggleTarget, setToggleTarget]         = useState<ExtendedUser | null>(null);
  const [deleteTarget, setDeleteTarget]         = useState<ExtendedUser | null>(null);
  const [isDeleteOpen, setIsDeleteOpen]         = useState(false);
  const [deleteConfirmEmail, setDeleteConfirmEmail] = useState('');
  const [isDeleting, setIsDeleting]             = useState(false);
  const [editForm, setEditForm]                 = useState({ name: '', role: 'hr' as string, department: '', siteIds: [] as number[] });
  const [newUser, setNewUser]                   = useState({ email: '', password: '', name: '', role: 'hr', department: '', siteIds: [] as number[] });
  const [users, setUsers]                       = useState<ExtendedUser[]>([]);
  const [employees, setEmployees]               = useState<Employee[]>([]);

  const [newUserTouched, setNewUserTouched]     = useState({ name: false, email: false });
  const [editFormTouched, setEditFormTouched]   = useState({ name: false });

  const [sites, setSites]                       = useState<{ pk_site_id: number; site_name: string }[]>([]);
  const [isSaving, setIsSaving]                 = useState(false);
  const [isSyncing, setIsSyncing]               = useState(false);
  const [loading, setLoading]                   = useState(true);
  const { accessToken, verticalLabel, translateRole, user } = useAuth();
  const { manifest } = useManifest();
  const isSuperAdmin = user?.role === 'super_admin' || manifest?.role === 'super_admin';
  const scopeHeaders = useScopeHeaders();
 
  useEffect(() => {
    if (isTenantAdminsOnly) {
      setNewUser(u => ({ ...u, role: 'tenant_admin', siteIds: [] }));
    } else {
      setNewUser(u => ({ ...u, role: 'hr', siteIds: [] }));
    }
  }, [isTenantAdminsOnly]);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ data: any[] }>('/users', { scopeHeaders });
      setUsers((res?.data ?? []).map((u: any) => ({
        id: String(u.pk_user_id || u.id),
        name: u.username || u.name || u.email,
        email: u.email,
        role: u.role as UserRole,
        department: u.department || '',
        createdAt: new Date(u.created_at || Date.now()),
        last_login: u.last_login ?? undefined,
        is_active: u.is_active !== false,
        tenant_name: u.tenant_name || '',
        password: '',
        site_id: u.site_id ?? null,
        site_name: u.site_name ?? null,
        site_ids: u.site_ids ?? [],
      } as ExtendedUser)));
    } catch { toast.error('Failed to load users'); }
    finally { setLoading(false); }
  }, [scopeHeaders]);

  const handleSyncKeycloak = async () => {
    setIsSyncing(true);
    try {
      const res = await apiRequest<{ success: boolean; prunedCount: number }>('/users/sync-keycloak', {
        method: 'POST',
        scopeHeaders,
      });
      if (res.success) {
        toast.success(`Sync complete! Pruned ${res.prunedCount} stale accounts no longer present in Keycloak.`);
        loadUsers();
      }
    } catch {
      toast.error('Identity provider sync failed');
    } finally {
      setIsSyncing(false);
    }
  };

  useEffect(() => { loadUsers(); }, [loadUsers]);

  useEffect(() => {
    apiRequest<{ data: Employee[] }>('/live/employees', { scopeHeaders })
      .then(res => setEmployees(res.data || []))
      .catch(() => setEmployees([]));

    apiRequest<{ success: boolean; sites: { pk_site_id: number; site_name: string }[] }>('/site-management/sites', { scopeHeaders })
      .then(res => {
        if (res?.success) {
          setSites(res.sites || []);
        }
      })
      .catch(() => setSites([]));
  }, [scopeHeaders]);

  const activeEmps = useMemo(() => {
    return employees.filter((e: any) => e.is_active !== false && e.status !== 'inactive' && e.status !== 'terminated');
  }, [employees]);

  const enrolledCount = activeEmps.filter((e: any) => e.face_enrolled === true).length;
  const pendingCount  = Math.max(0, activeEmps.length - enrolledCount);
  const currentUsers  = isTenantAdminsOnly
    ? users.filter(u => (u.role as string) === 'tenant_admin')
    : users;
  const activeCount   = currentUsers.filter(u => u.is_active).length;
  const terminatedCount = currentUsers.filter(u => !u.is_active).length;

  const debouncedEmail = useDebounce(newUser.email, 300);
  const isDuplicateEmail = useMemo(() => {
    return Boolean(debouncedEmail && users.some(u => u.email.toLowerCase() === debouncedEmail.trim().toLowerCase()));
  }, [debouncedEmail, users]);

  const displayNameValidation = validateDisplayName(newUser.name);
  const isDisplayNameValid = displayNameValidation.valid;
  const showDisplayNameError = newUserTouched.name && !isDisplayNameValid;

  const emailValidation = validateEmailFormat(newUser.email);
  const isEmailValid = emailValidation.valid && !isDuplicateEmail;
  const showEmailError = newUserTouched.email && (!emailValidation.valid || isDuplicateEmail);
  const emailErrorMessage = isDuplicateEmail ? 'User with this email already exists in the system.' : emailValidation.error;

  const editDisplayNameValidation = validateDisplayName(editForm.name);
  const isEditDisplayNameValid = editDisplayNameValidation.valid;
  const showEditDisplayNameError = editFormTouched.name && !isEditDisplayNameValid;

  const [isShaking, setIsShaking] = useState(false);
  const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false);
  const isDirty = Boolean(newUser.name || newUser.email || newUser.password);

  const triggerShake = () => {
    setIsShaking(true);
    setTimeout(() => setIsShaking(false), 400);
  };

  // ── Create ────────────────────────────────────────────────
  const handleCreate = async () => {
    if (!displayNameValidation.valid || !emailValidation.valid || isDuplicateEmail || !newUser.password) {
      setNewUserTouched({ name: true, email: true });
      triggerShake();
      return;
    }
    setIsSaving(true);
    try {
      const isSiteScoped = ['site_admin', 'hr_manager', 'viewer', 'device_operator'].includes(newUser.role);
      const postSiteIds = isSiteScoped ? newUser.siteIds : [];

      const res = await apiRequest<any>('/users', {
        method: 'POST', scopeHeaders,
        body: JSON.stringify({
          email: newUser.email.trim(),
          username: normalizeDisplayName(newUser.name),
          password: newUser.password,
          role: newUser.role,
          department: newUser.department,
          siteIds: postSiteIds,
        }),
      });
      const assignedSites = sites.filter(s => postSiteIds.includes(s.pk_site_id));
      const siteNames = assignedSites.map(s => s.site_name).join(', ');

      setUsers(prev => [{
        id: String(res.pk_user_id || res.id),
        name: res.username || normalizeDisplayName(newUser.name),
        email: res.email,
        role: res.role as UserRole,
        department: res.department || '',
        is_active: true,
        createdAt: new Date(),
        last_login: undefined,
        password: '',
        site_id: postSiteIds.length > 0 ? postSiteIds[0] : null,
        site_ids: postSiteIds,
        site_name: siteNames || null,
      } as ExtendedUser, ...prev]);
      toast.success('User created — welcome email sent', {
        description: `Credentials sent to ${newUser.email}`,
        icon: <Mail className="w-4 h-4" />,
      });
      setIsCreateOpen(false);
      setNewUser({ email: '', password: '', name: '', role: 'hr', department: '', siteIds: [] });
      setNewUserTouched({ name: false, email: false });
    } catch (e: any) {
      toast.error(e?.message || 'Failed to create user');
    } finally { setIsSaving(false); }
  };

  // ── Edit ──────────────────────────────────────────────────
  const openEdit = (u: ExtendedUser) => {
    if (!u.is_active) {
      toast.error('Activate the user first to edit the profile');
      return;
    }
    setEditTarget(u);
    setEditForm({
      name: u.name,
      role: u.role as string,
      department: u.department || '',
      siteIds: u.site_ids || (u.site_id ? [u.site_id] : []),
    });
    setEditFormTouched({ name: false });
    setIsEditOpen(true);
  };
  const handleEdit = async () => {
    if (!editTarget) return;
    if (!editDisplayNameValidation.valid) return;
    setIsSaving(true);
    try {
      const isSiteScoped = ['site_admin', 'hr_manager', 'viewer', 'device_operator'].includes(editForm.role);
      const postSiteIds = isSiteScoped ? editForm.siteIds : [];

      await apiRequest(`/users/${editTarget.id}`, {
        method: 'PUT', scopeHeaders,
        body: JSON.stringify({ username: normalizeDisplayName(editForm.name), department: editForm.department, siteIds: postSiteIds }),
      });
      const assignedSites = sites.filter(s => postSiteIds.includes(s.pk_site_id));
      const siteNames = assignedSites.map(s => s.site_name).join(', ');

      setUsers(prev => prev.map(u => u.id === editTarget.id
        ? {
            ...u,
            name: normalizeDisplayName(editForm.name),
            department: editForm.department,
            site_id: postSiteIds.length > 0 ? postSiteIds[0] : null,
            site_ids: postSiteIds,
            site_name: siteNames || null,
          }
        : u
      ));
      toast.success('User updated');
      setIsEditOpen(false);
    } catch { toast.error('Failed to update user'); }
    finally { setIsSaving(false); }
  };

  // ── Reset password (AB#3270: sends a self-service reset link) ──────────
  const openReset = (u: ExtendedUser) => {
    if (!u.is_active) {
      toast.error('Activate the user first to change the password');
      return;
    }
    setResetTarget(u); setIsResetOpen(true);
  };
  const handleReset = async () => {
    if (!resetTarget) return;
    setIsSaving(true);
    try {
      await apiRequest<{ success: boolean }>(`/users/${resetTarget.id}/password`, {
        method: 'PUT', scopeHeaders,
      });
      toast.success(`Password reset link sent to ${resetTarget.email}`);
      setIsResetOpen(false);
    } catch (err: any) { toast.error(err.message || 'Failed to send password reset link'); }
    finally { setIsSaving(false); }
  };

  // ── Deactivate / Activate ─────────────────────────────────
  const confirmToggleActive = (u: ExtendedUser) => {
    setToggleTarget(u);
    setIsToggleOpen(true);
  };
  const handleToggleActive = async () => {
    if (!toggleTarget) return;
    const action = toggleTarget.is_active ? 'deactivate' : 'activate';
    try {
      await apiRequest(`/users/${toggleTarget.id}/${action}`, { method: 'PUT', scopeHeaders });
      setUsers(prev => prev.map(x => x.id === toggleTarget.id ? { ...x, is_active: !toggleTarget.is_active } : x));
      toast.success(`${toggleTarget.name} ${toggleTarget.is_active ? 'deactivated' : 'activated'}`);
      setIsToggleOpen(false);
      setToggleTarget(null);
    } catch { toast.error(`Failed to ${action} user`); }
  };

  // ── Delete User / Tenant Admin ──────────────────────────────
  const openDelete = (u: ExtendedUser) => {
    setDeleteTarget(u);
    setDeleteConfirmEmail('');
    setIsDeleteOpen(true);
  };
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await apiRequest(`/users/${deleteTarget.id}`, { method: 'DELETE', scopeHeaders });
      toast.success(`User ${deleteTarget.name || deleteTarget.email} deleted successfully. Deletion confirmation email sent.`);
      setIsDeleteOpen(false);
      setDeleteTarget(null);
      loadUsers();
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete user');
    } finally {
      setIsDeleting(false);
    }
  };

  const filtered = users.filter(u => {
    const matchesSearch = u.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          u.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          (u.tenant_name && u.tenant_name.toLowerCase().includes(searchQuery.toLowerCase()));
    if (isTenantAdminsOnly) {
      return matchesSearch && (u.role as string) === 'tenant_admin';
    }
    return matchesSearch;
  });

  return (
    <div className="space-y-6 pb-16">
      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <MetricCard title={isTenantAdminsOnly ? "ADMINS" : "USERS"} value={currentUsers.length} icon={UserCog}
          description={`${activeCount} Active • ${terminatedCount} Terminated`} colorClass="text-blue-500" />
        <MetricCard title={verticalLabel("Enrolled Employees", "Enrolled Students")} value={enrolledCount} icon={UserCheck}
          description="Biometrics enrolled" colorClass="text-emerald-500" />
        <MetricCard title="Unenrolled Users" value={pendingCount} icon={Clock}
          description={verticalLabel("Active users without face data", "Active students without face data")} colorClass="text-amber-500" />
      </div>

      {/* Users Table */}
      <Card className="border-none shadow-sm bg-white dark:bg-card overflow-hidden">
        <CardHeader className={cn('flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b py-4 pb-6', lightTheme.border.default)}>
          <div>
            <CardTitle className={cn('text-lg font-black tracking-tight', lightTheme.text.primary)}>
              {isTenantAdminsOnly ? 'Tenant Administrators' : 'All Users'}
            </CardTitle>
            <p className={cn('text-[10px] font-bold uppercase tracking-widest mt-1', lightTheme.text.muted)}>
              {isTenantAdminsOnly ? 'Manage tenant-level administrator accounts' : 'Manage access, roles, and account status'}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative w-full sm:w-auto">
              <Search className={cn('absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4', lightTheme.text.muted)} />
              <Input type="search" autoComplete="off" placeholder="Search users…" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                className={cn('pl-10 pr-4 h-10 rounded-xl w-full sm:w-[240px]', lightTheme.border.default, lightTheme.background.secondary)} />
            </div>

            {isSuperAdmin && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleSyncKeycloak}
                disabled={isSyncing}
                className="h-10 rounded-xl border-slate-200 hover:bg-indigo-50 hover:text-indigo-600 font-bold gap-2"
              >
                <RefreshCw className={cn("w-4 h-4", isSyncing && "animate-spin")} />
                {isSyncing ? "Syncing IDP…" : "Sync with Keycloak"}
              </Button>
            )}

            {/* ── Create User Dialog ──
                Hidden on the super-admin "All Users" view: from the Super Admin
                portal this page only displays and manages existing users, while
                user creation is handled through the tenant-level admin flow.
                Tenant-admin provisioning on the "Tenant Administrators" view and
                creation from non-super-admin contexts are unaffected. */}
            {!(isSuperAdmin && !isTenantAdminsOnly) && (
            <Dialog open={isCreateOpen} onOpenChange={(open) => {
              if (!open && isDirty) {
                setShowUnsavedConfirm(true);
              } else {
                setIsCreateOpen(open);
                if (!open) {
                  setNewUser({ name: '', email: '', password: '', role: 'hr', department: '', siteIds: [] });
                  setNewUserTouched({ name: false, email: false });
                }
              }
            }}>
              <DialogTrigger asChild>
                <Button size="sm" className="font-bold px-4 rounded-xl h-10">
                  <UserPlus className="w-4 h-4 mr-2" /> {isTenantAdminsOnly ? 'Create Admin' : 'Create User'}
                </Button>
              </DialogTrigger>
              <DialogContent
                className="rounded-2xl border-none max-w-[calc(100vw-2rem)] sm:max-w-md max-h-[90vh] overflow-y-auto p-0"
                onInteractOutside={(e) => {
                  if (isDirty) {
                    e.preventDefault();
                    setShowUnsavedConfirm(true);
                  }
                }}
                onEscapeKeyDown={(e) => {
                  if (isDirty) {
                    e.preventDefault();
                    setShowUnsavedConfirm(true);
                  }
                }}
              >
                <DialogHeader className="p-6 border-b">
                  <DialogTitle className="font-black text-xl">Create User Account</DialogTitle>
                  <DialogDescription className="text-sm text-slate-500 mt-1">
                    A welcome email with login credentials will be sent automatically.
                  </DialogDescription>
                </DialogHeader>
                <div className="p-6 space-y-4">
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <Label htmlFor="display-name-input" className="text-[10px] font-bold uppercase text-slate-400 tracking-wider">Display Name <span className="text-rose-500">*</span></Label>
                      <span className="text-[10px] font-bold text-slate-400 tracking-wider">{newUser.name.length} / 100</span>
                    </div>
                    <div className="relative flex items-center">
                      <Input
                        id="display-name-input"
                        autoFocus
                        maxLength={100}
                        value={newUser.name} 
                        onChange={e => { setNewUser({ ...newUser, name: formatDisplayNameInput(e.target.value) }); setNewUserTouched(t => ({ ...t, name: true })); }}
                        onBlur={() => setNewUserTouched(t => ({ ...t, name: true }))}
                        aria-invalid={showDisplayNameError}
                        aria-describedby={showDisplayNameError ? "display-name-error" : undefined}
                        className={cn("rounded-xl h-11 border-slate-200 pr-10", showDisplayNameError && "border-red-500 focus-visible:ring-red-500")}
                        placeholder="Jane Doe"
                      />
                      {newUser.name && (
                        <div className="absolute right-3 pointer-events-none flex items-center">
                          {isDisplayNameValid ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                          ) : showDisplayNameError ? (
                            <AlertCircle className="w-4 h-4 text-red-500" />
                          ) : null}
                        </div>
                      )}
                    </div>
                    {showDisplayNameError && <p id="display-name-error" className="text-xs text-red-500 font-medium transition-all">{displayNameValidation.error}</p>}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="user-email-input" className="text-[10px] font-bold uppercase text-slate-400 tracking-wider">Email Address <span className="text-rose-500">*</span></Label>
                    <div className="relative flex items-center">
                      <Input
                        id="user-email-input"
                        type="email"
                        value={newUser.email}
                        onChange={e => { setNewUser({ ...newUser, email: e.target.value }); setNewUserTouched(t => ({ ...t, email: true })); }}
                        onBlur={() => setNewUserTouched(t => ({ ...t, email: true }))}
                        aria-invalid={showEmailError}
                        aria-describedby={showEmailError ? "user-email-error" : undefined}
                        className={cn("rounded-xl h-11 border-slate-200 pr-10", showEmailError && "border-red-500 focus-visible:ring-red-500")}
                        placeholder={verticalLabel("jane@company.com", "principal@university.edu")}
                      />
                      {newUser.email && (
                        <div className="absolute right-3 pointer-events-none flex items-center">
                          {isEmailValid ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                          ) : showEmailError ? (
                            <AlertCircle className="w-4 h-4 text-red-500" />
                          ) : null}
                        </div>
                      )}
                    </div>
                    {showEmailError && <p id="user-email-error" className="text-xs text-red-500 font-medium transition-all">{emailErrorMessage}</p>}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="temp-password-input" className="text-[10px] font-bold uppercase text-slate-400 tracking-wider">Temporary Password <span className="text-rose-500">*</span></Label>
                    <PasswordInput
                      id="temp-password-input"
                      value={newUser.password}
                      onChange={e => setNewUser({ ...newUser, password: e.target.value })}
                      className="rounded-xl h-11 border-slate-200"
                      placeholder="Min 8 chars, uppercase + number"
                    />
                    {newUser.password && <StrengthBar strength={calcStrength(newUser.password)} />}
                  </div>
                  <div className="space-y-2">
                    <Label className="text-[10px] font-bold uppercase text-slate-400 tracking-wider">System Role <span className="text-rose-500">*</span></Label>
                    <Select value={newUser.role} onValueChange={v => setNewUser({ ...newUser, role: v })}>
                      <SelectTrigger className="rounded-xl h-11 border-slate-200"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {isSuperAdmin ? (
                          <>
                            <SelectItem value="super_admin">{translateRole('super_admin')}</SelectItem>
                            <SelectItem value="tenant_admin">{translateRole('tenant_admin')}</SelectItem>
                          </>
                        ) : (
                          <>
                            <SelectItem value="hr">{translateRole('hr')}</SelectItem>
                            <SelectItem value="hr_manager">{translateRole('hr_manager')}</SelectItem>
                            <SelectItem value="site_admin">{translateRole('site_admin')}</SelectItem>
                            <SelectItem value="admin">{translateRole('admin')}</SelectItem>
                            <SelectItem value="viewer">{translateRole('viewer')}</SelectItem>
                          </>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  {!isSuperAdmin && ['site_admin', 'hr', 'hr_manager', 'viewer', 'device_operator'].includes(newUser.role) && (
                    <div className="space-y-2">
                      <Label className="text-[10px] font-bold uppercase text-slate-400 tracking-wider">Assign Site / Branch <span className="text-rose-500">*</span></Label>
                      <div className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 p-4 max-h-40 overflow-y-auto space-y-2.5 shadow-sm">
                        {sites.map(s => {
                          const isChecked = newUser.siteIds.includes(s.pk_site_id);
                          return (
                            <div key={s.pk_site_id} className="flex items-center space-x-3 hover:bg-slate-50 dark:hover:bg-slate-800/50 p-1.5 rounded-lg transition-colors">
                              <Checkbox 
                                id={`new-site-${s.pk_site_id}`} 
                                checked={isChecked} 
                                onCheckedChange={(checked) => {
                                  if (checked) {
                                    setNewUser({ ...newUser, siteIds: [...newUser.siteIds, s.pk_site_id] });
                                  } else {
                                    setNewUser({ ...newUser, siteIds: newUser.siteIds.filter(id => id !== s.pk_site_id) });
                                  }
                                }}
                              />
                              <Label htmlFor={`new-site-${s.pk_site_id}`} className="text-sm font-medium text-slate-700 dark:text-slate-300 cursor-pointer flex-1 select-none">
                                {s.site_name}
                              </Label>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <div className="flex items-start gap-2 p-3 bg-blue-50 rounded-xl text-xs text-blue-700">
                    <Mail className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <span>Login credentials will be emailed to the user automatically on creation.</span>
                  </div>
                  <Button onClick={handleCreate} className={cn("w-full rounded-xl h-11 font-bold transition-all", isShaking && "animate-shake")} disabled={isSaving || !isDisplayNameValid || !isEmailValid || !newUser.password}>
                    {isSaving ? 'Creating…' : 'Create & Send Credentials'}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
            )}

            {/* Unsaved Changes Confirmation Alert Dialog */}
            <AlertDialog open={showUnsavedConfirm} onOpenChange={setShowUnsavedConfirm}>
              <AlertDialogContent className="rounded-2xl border-none max-w-md bg-white dark:bg-slate-900 p-6 shadow-2xl">
                <AlertDialogHeader>
                  <AlertDialogTitle className="font-extrabold text-lg flex items-center gap-2.5 text-slate-900 dark:text-white">
                    <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
                    Discard unsaved changes?
                  </AlertDialogTitle>
                  <AlertDialogDescription className="text-sm text-slate-600 dark:text-slate-400 mt-2">
                    You have unsaved changes in this form. Are you sure you want to discard them?
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter className="mt-6 flex flex-col-reverse sm:flex-row gap-2">
                  <AlertDialogCancel onClick={() => setShowUnsavedConfirm(false)} className="rounded-xl font-semibold border-slate-200">
                    Continue Editing
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      setShowUnsavedConfirm(false);
                      setIsCreateOpen(false);
                      setNewUser({ name: '', email: '', password: '', role: 'hr', department: '', siteIds: [] });
                      setNewUserTouched({ name: false, email: false });
                    }}
                    className="rounded-xl font-bold bg-rose-600 hover:bg-rose-700 text-white shadow-md"
                  >
                    Discard Changes
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {loading ? (
            <div className={cn('text-center py-12 text-sm', lightTheme.text.muted)}>Loading users…</div>
          ) : filtered.length === 0 ? (
            <div className={cn('text-center py-12 text-sm', lightTheme.text.muted)}>No users found</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className={cn('border-b', lightTheme.table.border)}>
                  <TableHead className={cn('pl-6 py-3 text-left text-xs font-bold uppercase tracking-wide', lightTheme.text.secondary)}>User</TableHead>
                  <TableHead className={cn('text-left text-xs font-bold uppercase tracking-wide', lightTheme.text.secondary)}>Role</TableHead>
                  {isSuperAdmin && (
                    <TableHead className={cn('text-left text-xs font-bold uppercase tracking-wide', lightTheme.text.secondary)}>Tenant</TableHead>
                  )}
                  <TableHead className={cn('text-left text-xs font-bold uppercase tracking-wide', lightTheme.text.secondary)}>Department</TableHead>
                  <TableHead className={cn('text-left text-xs font-bold uppercase tracking-wide', lightTheme.text.secondary)}>Status</TableHead>
                  <TableHead className={cn('text-left text-xs font-bold uppercase tracking-wide', lightTheme.text.secondary)}>Last Login</TableHead>
                  <TableHead className={cn('text-left text-xs font-bold uppercase tracking-wide', lightTheme.text.secondary)}>Joined</TableHead>
                  <TableHead className={cn('text-right pr-6 text-xs font-bold uppercase tracking-wide', lightTheme.text.secondary)}>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(u => (
                  <TableRow key={u.id}
                    className={cn('border-b transition-colors', lightTheme.table.border,
                      u.is_active ? lightTheme.table.rowHover : 'bg-slate-50/60 opacity-70'
                    )}>
                    <TableCell className="pl-6 py-4 text-left">
                      <div className="flex items-center gap-3">
                        <div className={cn('w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold text-white shadow-sm',
                          u.is_active ? 'bg-gradient-to-br from-indigo-500 to-blue-600' : 'bg-slate-400'
                        )}>
                          {u.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || 'U'}
                        </div>
                        <div>
                          <div className={cn('font-semibold text-sm', lightTheme.text.primary)}>{u.name}</div>
                          <div className={cn('text-xs', lightTheme.text.secondary)}>{u.email}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-left">
                      <div className="flex flex-col gap-1 items-start">
                        <Badge variant="secondary"
                          className={cn('px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wide border-none',
                            ROLE_COLORS[u.role] ?? 'bg-slate-100 text-slate-700'
                          )}>
                          <Shield className="w-3 h-3 mr-1 inline opacity-60" />
                          {translateRole(u.role)}
                        </Badge>
                        {u.site_name && (
                          <span className="text-[10px] text-indigo-600 bg-indigo-50 font-bold px-1.5 py-0.5 rounded border border-indigo-100">
                            {u.site_name}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    {isSuperAdmin && (
                      <TableCell className="text-left">
                        <span className="text-xs font-bold text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20 dark:text-indigo-400 px-2.5 py-1 rounded-lg border border-indigo-100 dark:border-indigo-800/50">
                          {u.tenant_name || 'System / Global'}
                        </span>
                      </TableCell>
                    )}
                    <TableCell className="text-left">
                      <span className={cn('text-xs font-medium', lightTheme.text.secondary)}>{u.department || '—'}</span>
                    </TableCell>
                    <TableCell className="text-left">
                      <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold',
                        u.is_active
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-slate-100 text-slate-500'
                      )}>
                        <span className={cn('w-1.5 h-1.5 rounded-full', u.is_active ? 'bg-emerald-500' : 'bg-slate-400')} />
                        {u.is_active ? 'Active' : 'Terminated'}
                      </span>
                    </TableCell>
                    <TableCell className="text-left">
                      <span className={cn('text-xs font-mono', lightTheme.text.secondary)}>
                        {u.last_login ? new Date(u.last_login).toLocaleString() : 'Never'}
                      </span>
                    </TableCell>
                    <TableCell className="text-left">
                      <span className={cn('text-xs font-mono', lightTheme.text.muted)}>
                        {new Date(u.createdAt).toLocaleDateString()}
                      </span>
                    </TableCell>
                    <TableCell className="text-right pr-6 py-4">
                      <div className="flex items-center gap-1 justify-end">
                        {/* Reset Password */}
                        <Button variant="ghost" size="sm"
                          className={cn('h-8 w-8 p-0 rounded-lg transition-colors', lightTheme.text.muted,
                            u.is_active 
                              ? 'hover:bg-amber-50 dark:hover:bg-amber-950/30 hover:text-amber-600 dark:hover:text-amber-400' 
                              : 'opacity-50 cursor-pointer'
                          )}
                          title="Reset password" onClick={() => openReset(u)}>
                          <KeyRound className="h-4 w-4" />
                        </Button>
                        {/* Edit */}
                        <Button variant="ghost" size="sm"
                          className={cn('h-8 w-8 p-0 rounded-lg transition-colors', lightTheme.text.muted,
                            u.is_active 
                              ? 'hover:bg-blue-50 dark:hover:bg-blue-950/30 hover:text-blue-600 dark:hover:text-blue-400' 
                              : 'opacity-50 cursor-pointer'
                          )}
                          title="Edit user" onClick={() => openEdit(u)}>
                          <Edit className="h-4 w-4" />
                        </Button>
                        {/* Deactivate / Activate */}
                        <Button variant="ghost" size="sm"
                          disabled={user?.email === u.email}
                          className={cn('h-8 w-8 p-0 rounded-lg transition-colors', lightTheme.text.muted,
                            u.is_active
                              ? 'hover:bg-orange-50 dark:hover:bg-orange-950/30 hover:text-orange-600 dark:hover:text-orange-400'
                              : 'hover:bg-emerald-50 dark:hover:bg-emerald-950/30 hover:text-emerald-600 dark:hover:text-emerald-400',
                            user?.email === u.email ? 'opacity-30 cursor-not-allowed' : ''
                          )}
                          title={user?.email === u.email ? 'Cannot modify own account' : (u.is_active ? 'Deactivate' : 'Activate')}
                          onClick={() => confirmToggleActive(u)}>
                          {u.is_active ? <UserX className="h-4 w-4" /> : <UserCheck2 className="h-4 w-4" />}
                        </Button>
                        {/* Delete */}
                        <Button variant="ghost" size="sm"
                          disabled={user?.email === u.email}
                          className={cn('h-8 w-8 p-0 rounded-lg transition-colors', lightTheme.text.muted,
                            'hover:bg-rose-50 dark:hover:bg-rose-950/30 hover:text-rose-600 dark:hover:text-rose-400',
                            user?.email === u.email ? 'opacity-30 cursor-not-allowed' : ''
                          )}
                          title={user?.email === u.email ? 'Cannot delete own account' : 'Delete user'}
                          onClick={() => openDelete(u)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── Reset Password Dialog (AB#3270: sends a self-service reset link) ── */}
      <Dialog open={isResetOpen} onOpenChange={setIsResetOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset Password</DialogTitle>
            <DialogDescription>
              Send a password reset link to <strong>{resetTarget?.name}</strong> ({resetTarget?.email})?
              They'll receive an email with a link to set their own new password.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setIsResetOpen(false)} disabled={isSaving}>Cancel</Button>
            <Button
              onClick={handleReset}
              disabled={isSaving}
              className="bg-amber-500 hover:bg-amber-600 text-white"
            >
              {isSaving ? 'Sending…' : 'Send Reset Link'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Edit User Dialog ── */}
      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent className="rounded-2xl border-none max-w-md p-0">
          <DialogHeader className="p-6 border-b">
            <DialogTitle className="font-black text-xl">Edit User</DialogTitle>
            <DialogDescription className="text-sm text-slate-500 mt-1">{editTarget?.email}</DialogDescription>
          </DialogHeader>
          <div className="p-6 space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <Label className="text-[10px] font-bold uppercase text-slate-400 tracking-wider">Display Name <span className="text-rose-500">*</span></Label>
                <span className="text-[10px] font-bold text-slate-400 tracking-wider">{editForm.name.length} / 100</span>
              </div>
              <Input
                maxLength={100}
                value={editForm.name} 
                onChange={e => { setEditForm({ ...editForm, name: formatDisplayNameInput(e.target.value) }); setEditFormTouched({ name: true }); }}
                onBlur={() => setEditFormTouched({ name: true })}
                className={cn("rounded-xl h-11 border-slate-200", showEditDisplayNameError && "border-red-500 focus-visible:ring-red-500")} />
              {showEditDisplayNameError && <p className="text-xs text-red-500 font-medium">{editDisplayNameValidation.error}</p>}
            </div>

            {!isSuperAdmin && ['site_admin', 'hr', 'hr_manager', 'viewer', 'device_operator'].includes(editForm.role) && (
              <div className="space-y-2">
                <Label className="text-[10px] font-bold uppercase text-slate-400 tracking-wider">Assign Site / Branch (Optional)</Label>
                <div className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 p-4 max-h-40 overflow-y-auto space-y-2.5 shadow-sm">
                  {sites.map(s => {
                    const isChecked = editForm.siteIds.includes(s.pk_site_id);
                    return (
                      <div key={s.pk_site_id} className="flex items-center space-x-3 hover:bg-slate-50 dark:hover:bg-slate-800/50 p-1.5 rounded-lg transition-colors">
                        <Checkbox 
                          id={`edit-site-${s.pk_site_id}`} 
                          checked={isChecked} 
                          onCheckedChange={(checked) => {
                            if (checked) {
                              setEditForm({ ...editForm, siteIds: [...editForm.siteIds, s.pk_site_id] });
                            } else {
                              setEditForm({ ...editForm, siteIds: editForm.siteIds.filter(id => id !== s.pk_site_id) });
                            }
                          }}
                        />
                        <Label htmlFor={`edit-site-${s.pk_site_id}`} className="text-sm font-medium text-slate-700 dark:text-slate-300 cursor-pointer flex-1 select-none">
                          {s.site_name}
                        </Label>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <Button onClick={handleEdit} className="w-full rounded-xl h-11 font-bold" disabled={isSaving || !isEditDisplayNameValid}>
              {isSaving ? 'Saving…' : 'Save Changes'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {/* ── Toggle Active Dialog ── */}
      <Dialog open={isToggleOpen} onOpenChange={v => { if (!v) { setIsToggleOpen(false); setToggleTarget(null); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {toggleTarget?.is_active ? 'Deactivate User' : 'Activate User'}
            </DialogTitle>
            <DialogDescription>
              {toggleTarget?.is_active
                ? <>Are you sure you want to deactivate <strong>{toggleTarget?.name}</strong>? They will immediately lose access to the system.</>
                : <>Are you sure you want to reactivate <strong>{toggleTarget?.name}</strong>? They will regain access to the system.</>}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => { setIsToggleOpen(false); setToggleTarget(null); }}>Cancel</Button>
            <Button
              onClick={handleToggleActive}
              className={toggleTarget?.is_active ? "bg-rose-600 hover:bg-rose-700 text-white" : "bg-emerald-600 hover:bg-emerald-700 text-white"}
            >
              {toggleTarget?.is_active ? 'Deactivate' : 'Activate'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Delete User / Tenant Admin Dialog ── */}
      <Dialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-rose-600 font-bold flex items-center gap-2">
              <Trash2 className="w-5 h-5" />
              Delete {(deleteTarget?.role as string) === 'tenant_admin' ? 'Tenant Admin' : 'User'}
            </DialogTitle>
            <DialogDescription className="pt-2 text-slate-600 dark:text-slate-300">
              Are you sure you want to permanently delete <strong>{deleteTarget?.name}</strong> ({deleteTarget?.email})?
            </DialogDescription>
          </DialogHeader>
          <div className="p-3 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/50 rounded-xl text-xs text-rose-700 dark:text-rose-300 space-y-1 my-2">
            <p className="font-bold flex items-center gap-1">
              <Mail className="w-3.5 h-3.5" /> Deletion Confirmation Email
            </p>
            <p>A confirmation email notifying them of account deletion and access revocation will be sent to <strong>{deleteTarget?.email}</strong> automatically.</p>
          </div>
          <p className="text-xs text-slate-500 my-2">
            To confirm deletion, please type the email address of the user:
            <strong className="block mt-1 text-slate-800 dark:text-slate-200 select-none break-all">{deleteTarget?.email}</strong>
          </p>
          <div className="space-y-1.5 mb-2">
            <Label htmlFor="confirm-delete-email">Confirm Email <span className="text-rose-500">*</span></Label>
            <Input 
              id="confirm-delete-email"
              placeholder="user@company.com" 
              value={deleteConfirmEmail} 
              onChange={e => setDeleteConfirmEmail(e.target.value)}
              onPaste={e => {
                e.preventDefault();
                toast.error('Copying and pasting is disabled. Please type the email address manually.');
              }}
              onCopy={e => e.preventDefault()}
              onCut={e => e.preventDefault()}
              onDrop={e => e.preventDefault()}
              className="rounded-xl"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setIsDeleteOpen(false)} disabled={isDeleting}>Cancel</Button>
            <Button
              onClick={handleDelete}
              disabled={deleteConfirmEmail.trim().toLowerCase() !== (deleteTarget?.email || '').trim().toLowerCase() || isDeleting}
              className={cn(
                "font-bold rounded-xl transition-all",
                (deleteConfirmEmail.trim().toLowerCase() !== (deleteTarget?.email || '').trim().toLowerCase() || isDeleting)
                  ? "bg-slate-100 dark:bg-slate-800 text-slate-400 cursor-not-allowed"
                  : "bg-rose-600 hover:bg-rose-700 text-white shadow-md"
              )}
            >
              {isDeleting ? 'Deleting…' : 'Delete Permanently'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
