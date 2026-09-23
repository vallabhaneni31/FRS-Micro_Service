import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '../../../ui/card';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';
import { Label } from '../../../ui/label';
import { Badge } from '../../../ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select';
import { Checkbox } from '../../../ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../../ui/dialog';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction
} from '../../../ui/alert-dialog';
import { Popover, PopoverContent, PopoverTrigger } from '../../../ui/popover';
import { Users, Plus, Search, RefreshCw, Loader2, Shield, Mail, Edit, Trash2, Check, ChevronsUpDown, X, CheckCircle2, AlertCircle, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../../../contexts/AuthContext';
import { useManifest } from '../../../../contexts/ManifestContext';
import { apiRequest } from '../../../../services/http/apiClient';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { PageHeader } from '../../../shared/PageHeader';
import { cn } from '../../../ui/utils';
import { lightTheme } from '../../../../../theme/lightTheme';
import { PaginationBar } from '../../../shared/PaginationBar';
import { validateDisplayName, validateEmailFormat, normalizeDisplayName, formatDisplayNameInput } from '../../../../utils/userValidation';
import { useDebounce } from '../../../../hooks/useDebounce';

interface TenantUser {
  id: number;
  email: string;
  name: string;
  role: string;
  department: string | null;
  rbac_roles: Array<{ roleId: number; roleName: string; siteId: number | null; siteName: string | null }>;
}

interface Site { id: number; name: string; status?: string; }

interface Department {
  id: number;
  name: string;
}

const ROLE_COLORS: Record<string, string> = {
  site_admin:  'bg-blue-100 text-blue-700 border-blue-200',
  hr_manager:  'bg-emerald-100 text-emerald-700 border-emerald-200',
  tenant_admin:'bg-violet-100 text-violet-700 border-violet-200',
  super_admin: 'bg-rose-100 text-rose-700 border-rose-200',
};

export const TenantAdminUsers: React.FC = () => {
  const { accessToken, translateRole, verticalLabel, user } = useAuth();
  const { manifest } = useManifest();
  const scopeHeaders = useScopeHeaders();
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Edit / Delete states
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<TenantUser | null>(null);
  const [deleteConfirmEmail, setDeleteConfirmEmail] = useState('');
  const [editForm, setEditForm] = useState({
    username: '', roleName: 'hr_manager', siteIds: [] as number[], department: ''
  });

  const [form, setForm] = useState({
    email: '', username: '', roleName: 'hr_manager', siteIds: [] as number[], department: ''
  });

  const [siteSearch, setSiteSearch] = useState('');
  const [editSiteSearch, setEditSiteSearch] = useState('');

  useEffect(() => {
    setPage(1);
  }, [search, pageSize]);


  const openEdit = (u: TenantUser) => {
    setSelectedUser(u);
    const primaryRole = u.rbac_roles?.[0];
    const userSiteIds = u.rbac_roles
      ?.map(r => r.siteId ? Number(r.siteId) : null)
      .filter((id): id is number => id !== null && !isNaN(id)) || [];
    setEditForm({
      username: u.name || '',
      roleName: u.role || primaryRole?.roleName || 'hr_manager',
      siteIds: userSiteIds,
      department: u.department || ''
    });
    setEditFormTouched({ username: false });
    setEditSiteSearch('');
    setEditOpen(true);
  };

  const [formTouched, setFormTouched] = useState({ username: false, email: false });
  const [editFormTouched, setEditFormTouched] = useState({ username: false });

  const isEditChanged = React.useMemo(() => {
    if (!selectedUser) return false;
    const originalSiteIds = selectedUser.rbac_roles
      ?.map(r => r.siteId ? Number(r.siteId) : null)
      .filter((id): id is number => id !== null && !isNaN(id)) || [];
    
    const originalRoleName = selectedUser.role || selectedUser.rbac_roles?.[0]?.roleName || 'hr_manager';
    const originalUsername = selectedUser.name || '';
    const originalDepartment = selectedUser.department || '';

    const siteIdsChanged = editForm.siteIds.length !== originalSiteIds.length || !editForm.siteIds.every(id => originalSiteIds.includes(id));
    
    return (
      editForm.username !== originalUsername ||
      editForm.roleName !== originalRoleName ||
      editForm.department !== originalDepartment ||
      siteIdsChanged
    );
  }, [selectedUser, editForm]);

  const handleEdit = async () => {
    if (!selectedUser) return;
    const editDisplayNameValidation = validateDisplayName(editForm.username);
    if (!editDisplayNameValidation.valid) return;
    if (['site_admin', 'hr_manager', 'hr'].includes(editForm.roleName) && editForm.siteIds.length === 0) return;

    setSaving(true);
    try {
      await apiRequest(`/users/${selectedUser.id}`, {
        method: 'PUT',
        accessToken,
        scopeHeaders,
        body: JSON.stringify({
          username: normalizeDisplayName(editForm.username),
          role: editForm.roleName,
          siteIds: ['site_admin', 'hr_manager', 'hr'].includes(editForm.roleName) ? editForm.siteIds : [],
          department: editForm.department || undefined,
        }),
      });
      if (selectedUser.roleName !== editForm.roleName) {
        toast.success('Role updated successfully. Please log out and log in again to apply the new permissions.', { duration: 6000 });
      } else {
        toast.success('User updated successfully');
      }
      setEditOpen(false);
      load(true);
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to update user');
    } finally {
      setSaving(false);
    }
  };

  const openDelete = (u: TenantUser) => {
    setSelectedUser(u);
    setDeleteConfirmEmail('');
    setDeleteOpen(true);
  };

  const handleDelete = async () => {
    if (!selectedUser) return;
    if (deleteConfirmEmail !== selectedUser.email) {
      toast.error('Email does not match');
      return;
    }
    setSaving(true);
    try {
      await apiRequest(`/users/${selectedUser.id}`, {
        method: 'DELETE',
        accessToken,
        scopeHeaders,
      });
      toast.success('User deleted successfully. Deletion confirmation email sent.');
      setDeleteOpen(false);
      load(true);
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to delete user');
    } finally {
      setSaving(false);
    }
  };

  const load = useCallback(async (isManual = false) => {
    if (isManual) {
      setRefreshing(true);
    } else if (users.length === 0) {
      setLoading(true);
    }
    try {
      const minDelay = isManual ? new Promise(resolve => setTimeout(resolve, 600)) : Promise.resolve();
      const [data] = await Promise.all([
        Promise.all([
          apiRequest<{ users: TenantUser[] }>('/tenant-admin/users', { accessToken, scopeHeaders, noCache: isManual || users.length === 0 }),
          apiRequest<{ sites: Site[] }>('/tenant-admin/sites', { accessToken, scopeHeaders, noCache: isManual || users.length === 0 }),
          apiRequest<{ data: Department[] }>('/hr/departments', { accessToken, scopeHeaders, noCache: isManual || users.length === 0 }),
        ]),
        minDelay
      ]);
      const [usersData, sitesData, deptsData] = data;
      setUsers(usersData.users);
      setSites(sitesData.sites);
      setDepartments(deptsData.data || []);
      setPage(1);
    } catch {
      toast.error('Failed to load users');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [accessToken, scopeHeaders, users.length]);

  useEffect(() => { load(); }, [load]);

  const filtered = users.filter(u =>
    u.email.toLowerCase().includes(search.toLowerCase()) ||
    (u.name ?? '').toLowerCase().includes(search.toLowerCase())
  );

  const totalPages = Math.ceil(filtered.length / pageSize);
  const paginated = filtered.slice((page - 1) * pageSize, page * pageSize);



  const [isShaking, setIsShaking] = useState(false);
  const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false);
  const isDirty = Boolean(form.username || form.email);
  const debouncedEmail = useDebounce(form.email, 300);
  const isDuplicateEmail = React.useMemo(() => {
    return Boolean(debouncedEmail && users.some(u => u.email.toLowerCase() === debouncedEmail.trim().toLowerCase()));
  }, [debouncedEmail, users]);

  const triggerShake = () => {
    setIsShaking(true);
    setTimeout(() => setIsShaking(false), 400);
  };

  const handleCreate = async () => {
    const emailVal = validateEmailFormat(form.email);
    const displayNameVal = validateDisplayName(form.username);
    if (!form.email || !emailVal.valid || isDuplicateEmail || !displayNameVal.valid || !form.roleName) {
      setFormTouched({ username: true, email: true });
      triggerShake();
      return;
    }

    if (['site_admin', 'hr_manager', 'hr'].includes(form.roleName) && form.siteIds.length === 0) {
      triggerShake();
      return;
    }
    setSaving(true);
    try {
      await apiRequest('/tenant-admin/users', {
        method: 'POST',
        accessToken,
        scopeHeaders,
        body: JSON.stringify({
          email: form.email.trim(),
          username: normalizeDisplayName(form.username),
          roleName: form.roleName,
          siteIds: ['site_admin', 'hr_manager', 'hr'].includes(form.roleName) ? form.siteIds : [],
          department: form.department || undefined,
        }),
      });
      toast.success('Invite sent — the user will receive an email to set their password');
      setCreateOpen(false);
      setForm({ email: '', username: '', roleName: 'hr_manager', siteIds: [], department: '' });
      setFormTouched({ username: false, email: false });
      load(true);
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to create user');
    } finally {
      setSaving(false);
    }
  };

  const emailValidation = validateEmailFormat(form.email);
  const isEmailValid = emailValidation.valid && !isDuplicateEmail;
  const showEmailError = formTouched.email && (!emailValidation.valid || isDuplicateEmail);
  const emailErrorMessage = isDuplicateEmail ? 'User with this email already exists.' : emailValidation.error;

  const displayNameValidation = validateDisplayName(form.username);
  const isDisplayNameValid = displayNameValidation.valid;
  const displayNameError = displayNameValidation.error;
  const showDisplayNameError = formTouched.username && !isDisplayNameValid;

  const editDisplayNameValidation = validateDisplayName(editForm.username);
  const editDisplayNameError = editDisplayNameValidation.error;
  const isEditDisplayNameValid = editDisplayNameValidation.valid;
  const showEditDisplayNameError = editFormTouched.username && !isEditDisplayNameValid;


  const selectedSiteNames = form.siteIds
    .map(id => sites.find(s => Number(s.id) === id)?.name)
    .filter(Boolean);
  const siteTriggerText = selectedSiteNames.length === 0
    ? "Select sites..."
    : selectedSiteNames.length <= 2
    ? selectedSiteNames.join(', ')
    : `${selectedSiteNames.length} sites selected`;

  const selectedEditSiteNames = editForm.siteIds
    .map(id => sites.find(s => Number(s.id) === id)?.name)
    .filter(Boolean);
  const editSiteTriggerText = selectedEditSiteNames.length === 0
    ? "Select sites..."
    : selectedEditSiteNames.length <= 2
    ? selectedEditSiteNames.join(', ')
    : `${selectedEditSiteNames.length} sites selected`;

  const manageableRoles = manifest?.canManageRoles ?? ['site_admin', 'hr_manager'];

  return (
    <div className="space-y-6">
      <PageHeader
        title="User Management"
        icon={Users}
        subtitle={`${users.length} users in this tenant`}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => load(true)}
              disabled={loading || refreshing}
            >
              <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setForm({ email: '', username: '', roleName: 'hr_manager', siteIds: [], department: '' });
                setFormTouched({ username: false, email: false });
                setSiteSearch('');
                setCreateOpen(true);
              }}
              className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              <Plus className="w-4 h-4" />Add User
            </Button>
          </>
        }
      />

      {refreshing && (
        <div className="w-full h-1 bg-primary/10 overflow-hidden rounded-full relative">
          <style>{`
            @keyframes loadingBar {
              0% { left: -30%; width: 30%; }
              50% { left: 30%; width: 40%; }
              100% { left: 100%; width: 30%; }
            }
          `}</style>
          <div 
            className="absolute top-0 bottom-0 bg-primary rounded-full"
            style={{ animation: 'loadingBar 1.5s infinite linear' }}
          />
        </div>
      )}

      <div className={cn("transition-opacity duration-300 space-y-6", refreshing && "opacity-60 pointer-events-none")}>

      <div className="relative max-w-sm">
        <Search className={cn('absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4', lightTheme.text.muted)} />
        <Input placeholder="Search users..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
      </div>

      <Card className={cn('border shadow-sm', lightTheme.border.default)}>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center h-48"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
          ) : paginated.length === 0 ? (
            <div className={cn('flex flex-col items-center justify-center h-48 gap-2', lightTheme.text.muted)}>
              <Users className="w-10 h-10 opacity-30" />
              <p className="text-sm">No users found</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className={cn('border-b', lightTheme.table.border, lightTheme.table.header)}>
                      <th className="text-left px-6 py-3 font-medium">User</th>
                      <th className="text-left px-4 py-3 font-medium">{verticalLabel('Department', 'Academics')}</th>
                      <th className="text-left px-4 py-3 font-medium">Roles</th>
                      <th className="text-right pr-6 py-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginated.map(u => (
                      <tr key={u.id} className={cn('border-b', lightTheme.table.border, lightTheme.table.rowHover)}>
                        <td className="px-6 py-4">
                          <div className={cn('font-medium', lightTheme.text.primary)}>{u.name ?? u.email}</div>
                          <div className={cn('text-xs', lightTheme.text.secondary)}>{u.email}</div>
                        </td>
                        <td className={cn('px-4 py-4', lightTheme.text.secondary)}>{u.department ?? '—'}</td>
                        <td className="px-4 py-4">
                          <div className="flex flex-wrap gap-1">
                            {u.rbac_roles?.length > 0 ? u.rbac_roles.map(r => (
                              <Badge key={r.roleId} variant="outline"
                                className={`text-xs ${ROLE_COLORS[r.roleName] ?? 'bg-slate-100 text-slate-600'}`}>
                                <Shield className="w-2.5 h-2.5 mr-1" />
                                {translateRole(r.roleName)}{r.siteName ? ` @ ${r.siteName}` : ''}
                              </Badge>
                            )) : <span className={cn('text-xs', lightTheme.text.muted)}>No RBAC role</span>}
                          </div>
                        </td>
                        <td className="px-4 py-4 text-right pr-6">
                          <div className="flex items-center gap-1 justify-end">
                            <Button variant="ghost" size="sm" className={cn('h-8 w-8 p-0 hover:bg-slate-100 rounded-lg', lightTheme.text.secondary, 'hover:text-slate-700')}
                              onClick={() => openEdit(u)} title="Edit user">
                              <Edit className="w-4 h-4" />
                            </Button>
                            <Button variant="ghost" size="sm" className={cn('h-8 w-8 p-0 hover:bg-red-50 rounded-lg hover:text-red-600', lightTheme.text.muted)}
                              onClick={() => openDelete(u)} title={u.email === user?.email ? "Cannot delete yourself" : "Delete user"} disabled={u.email === user?.email}>
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-6 border-t border-border">
                <PaginationBar
                  page={page}
                  pageSize={pageSize}
                  total={filtered.length}
                  totalPages={totalPages}
                  onPageChange={setPage}
                  onPageSizeChange={setPageSize}
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Create User Dialog */}
      <Dialog open={createOpen} onOpenChange={(open) => {
        if (!open && isDirty) {
          setShowUnsavedConfirm(true);
        } else {
          setCreateOpen(open);
          if (!open) {
            setForm({ email: '', username: '', roleName: 'hr_manager', siteIds: [], department: '' });
            setFormTouched({ username: false, email: false });
          }
        }
      }}>
        <DialogContent
          className="max-w-[calc(100vw-2rem)] sm:max-w-md max-h-[90vh] overflow-y-auto"
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
          <DialogHeader>
            <DialogTitle>Add User</DialogTitle>
            <DialogDescription>Create a new user — they'll receive an invite email to set their password.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <div className="flex justify-between items-center">
                <Label htmlFor="tenant-username-input">Display Name <span className="text-rose-500">*</span></Label>
                <span className="text-[10px] font-bold text-slate-400">{form.username.length} / 100</span>
              </div>
              <div className="relative flex items-center">
                <Input 
                  id="tenant-username-input"
                  autoFocus
                  maxLength={100}
                  placeholder="Full name" 
                  value={form.username} 
                  onChange={e => {
                    setForm(f => ({ ...f, username: formatDisplayNameInput(e.target.value) }));
                    setFormTouched(t => ({ ...t, username: true }));
                  }} 
                  onBlur={() => setFormTouched(t => ({ ...t, username: true }))}
                  aria-invalid={showDisplayNameError}
                  aria-describedby={showDisplayNameError ? "tenant-name-error" : undefined}
                  className={cn("pr-10", showDisplayNameError && "border-red-500 focus-visible:ring-red-500")} 
                />
                {form.username && (
                  <div className="absolute right-3 pointer-events-none flex items-center">
                    {isDisplayNameValid ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    ) : showDisplayNameError ? (
                      <AlertCircle className="w-4 h-4 text-red-500" />
                    ) : null}
                  </div>
                )}
              </div>
              {showDisplayNameError && (
                <p id="tenant-name-error" className="text-xs text-red-500 font-medium transition-all">{displayNameError}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tenant-email-input">Email <span className="text-rose-500">*</span></Label>
              <div className="relative flex items-center">
                <Input 
                  id="tenant-email-input"
                  type="email"
                  placeholder="user@company.com" 
                  value={form.email} 
                  onChange={e => {
                    setForm(f => ({ ...f, email: e.target.value }));
                    setFormTouched(t => ({ ...t, email: true }));
                  }}
                  onBlur={() => setFormTouched(t => ({ ...t, email: true }))}
                  aria-invalid={showEmailError}
                  aria-describedby={showEmailError ? "tenant-email-error" : undefined}
                  className={cn("pr-10", showEmailError && "border-red-500 focus-visible:ring-red-500")}
                />
                {form.email && (
                  <div className="absolute right-3 pointer-events-none flex items-center">
                    {isEmailValid ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    ) : showEmailError ? (
                      <AlertCircle className="w-4 h-4 text-red-500" />
                    ) : null}
                  </div>
                )}
              </div>
              {showEmailError && (
                <p id="tenant-email-error" className="text-xs text-red-500 font-medium transition-all">{emailErrorMessage}</p>
              )}
            </div>

            <div className="rounded-xl bg-slate-50 dark:bg-slate-900/50 border border-slate-200/60 dark:border-slate-800 p-3.5 flex items-start gap-3 transition-colors duration-200">
              <div className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 shrink-0">
                <Mail className="w-4 h-4" />
              </div>
              <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                An <strong>invite email</strong> with a password setup link will be sent to the user. They will choose their own password to access FRS.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Role <span className="text-rose-500">*</span></Label>
              <Select value={form.roleName} onValueChange={v => setForm(f => ({ ...f, roleName: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {manageableRoles.map(r => (
                    <SelectItem key={r} value={r}>{translateRole(r)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {['site_admin', 'hr_manager', 'hr'].includes(form.roleName) && (
              <div className="space-y-1.5 flex flex-col">
                <Label className="mb-1">{verticalLabel('Sites', 'Campuses')} <span className="text-rose-500">*</span></Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      className="w-full justify-between font-normal bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-700 dark:text-slate-300 shadow-sm"
                    >
                      <span className="truncate">{siteTriggerText}</span>
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[340px] p-2 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl z-50">
                    <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 pb-2 mb-2 px-1">
                      <Search className="w-4 h-4 text-slate-400 shrink-0" />
                      <input
                        type="text"
                        placeholder="Search sites..."
                        value={siteSearch}
                        onChange={e => setSiteSearch(e.target.value)}
                        className="w-full bg-transparent border-0 outline-none text-sm text-slate-700 dark:text-slate-300 placeholder-slate-400"
                      />
                      {siteSearch && (
                        <button type="button" onClick={() => setSiteSearch('')}>
                          <X className="w-3.5 h-3.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200" />
                        </button>
                      )}
                    </div>
                    <div className="max-h-48 overflow-y-auto space-y-1">
                      {sites
                        .filter(s => s.status !== 'inactive' && s.name.toLowerCase().includes(siteSearch.toLowerCase()))
                        .map(s => {
                          const isChecked = form.siteIds.includes(Number(s.id));
                          return (
                            <button
                              key={s.id}
                              type="button"
                              onClick={() => {
                                if (isChecked) {
                                  setForm(f => ({ ...f, siteIds: f.siteIds.filter(id => id !== Number(s.id)) }));
                                } else {
                                  setForm(f => ({ ...f, siteIds: [...f.siteIds, Number(s.id)] }));
                                }
                              }}
                              className="w-full flex items-center justify-between p-2 rounded-lg text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors text-left"
                            >
                              <span className="truncate pr-4">{s.name}</span>
                              <div className={cn(
                                "flex items-center justify-center w-4 h-4 rounded border transition-all",
                                isChecked 
                                  ? "bg-indigo-600 border-indigo-600 text-white" 
                                  : "border-slate-300 dark:border-slate-700"
                              )}>
                                {isChecked && <Check className="w-3 h-3 stroke-[3]" />}
                              </div>
                            </button>
                          );
                        })}
                      {sites.filter(s => s.status !== 'inactive' && s.name.toLowerCase().includes(siteSearch.toLowerCase())).length === 0 && (
                        <p className="text-xs text-slate-400 text-center py-2">No sites found</p>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => {
              if (isDirty) {
                setShowUnsavedConfirm(true);
              } else {
                setCreateOpen(false);
              }
            }}>Cancel</Button>
            <Button 
              onClick={handleCreate} 
              disabled={!form.username || !form.username.trim() || !form.email || !emailValidation.valid || !isDisplayNameValid || saving || (['site_admin', 'hr_manager', 'hr'].includes(form.roleName) && form.siteIds.length === 0)}
              className={cn(
                "w-full sm:w-auto font-semibold rounded-xl transition-all duration-200",
                isShaking && "animate-shake",
                (!form.username || !form.username.trim() || !form.email || !emailValidation.valid || !isDisplayNameValid || saving || (['site_admin', 'hr_manager', 'hr'].includes(form.roleName) && form.siteIds.length === 0))
                  ? "bg-slate-100 dark:bg-slate-800/80 text-slate-400 dark:text-slate-500 cursor-not-allowed border border-slate-200/50 dark:border-slate-800"
                  : "bg-indigo-600 hover:bg-indigo-700 text-white shadow-md hover:shadow-lg hover:shadow-indigo-500/10 active:scale-[0.98]"
              )}
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              Create User
            </Button>
          </div>
        </DialogContent>
      </Dialog>

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
                setCreateOpen(false);
                setForm({ email: '', username: '', roleName: 'hr_manager', siteIds: [], department: '' });
                setFormTouched({ username: false, email: false });
              }}
              className="rounded-xl font-bold bg-rose-600 hover:bg-rose-700 text-white shadow-md"
            >
              Discard Changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit User Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription>Modify user account details.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input value={selectedUser?.email || ''} disabled className="bg-slate-50 cursor-not-allowed" />
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between items-center">
                <Label>Display Name <span className="text-rose-500">*</span></Label>
                <span className="text-[10px] font-bold text-slate-400">{editForm.username.length} / 100</span>
              </div>
              <Input
                maxLength={100}
                placeholder="Full name"
                value={editForm.username}
                onChange={e => {
                  setEditForm(f => ({ ...f, username: formatDisplayNameInput(e.target.value) }));
                  setEditFormTouched(t => ({ ...t, username: true }));
                }}
                onBlur={() => setEditFormTouched(t => ({ ...t, username: true }))}
                className={cn(showEditDisplayNameError && "border-red-500 focus-visible:ring-red-500")}
              />
              {showEditDisplayNameError && (
                <p className="text-xs text-red-500 font-medium">{editDisplayNameError}</p>

              )}
            </div>
            <div className="space-y-1.5">
              <Label>Role <span className="text-rose-500">*</span></Label>
              <Select value={editForm.roleName} onValueChange={v => setEditForm(f => ({ ...f, roleName: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {manageableRoles.map(r => (
                    <SelectItem key={r} value={r}>{translateRole(r)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {['site_admin', 'hr_manager', 'hr'].includes(editForm.roleName) && (
              <div className="space-y-1.5 flex flex-col">
                <Label className="mb-1">{verticalLabel('Sites', 'Campuses')} <span className="text-rose-500">*</span></Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      className="w-full justify-between font-normal bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-700 dark:text-slate-300 shadow-sm"
                    >
                      <span className="truncate">{editSiteTriggerText}</span>
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[340px] p-2 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl z-50">
                    <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 pb-2 mb-2 px-1">
                      <Search className="w-4 h-4 text-slate-400 shrink-0" />
                      <input
                        type="text"
                        placeholder="Search sites..."
                        value={editSiteSearch}
                        onChange={e => setEditSiteSearch(e.target.value)}
                        className="w-full bg-transparent border-0 outline-none text-sm text-slate-700 dark:text-slate-300 placeholder-slate-400"
                      />
                      {editSiteSearch && (
                        <button type="button" onClick={() => setEditSiteSearch('')}>
                          <X className="w-3.5 h-3.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200" />
                        </button>
                      )}
                    </div>
                    <div className="max-h-48 overflow-y-auto space-y-1">
                      {sites
                        .filter(s => s.status !== 'inactive' && s.name.toLowerCase().includes(editSiteSearch.toLowerCase()))
                        .map(s => {
                          const isChecked = editForm.siteIds.includes(Number(s.id));
                          return (
                            <button
                              key={s.id}
                              type="button"
                              onClick={() => {
                                if (isChecked) {
                                  setEditForm(f => ({ ...f, siteIds: f.siteIds.filter(id => id !== Number(s.id)) }));
                                } else {
                                  setEditForm(f => ({ ...f, siteIds: [...f.siteIds, Number(s.id)] }));
                                }
                              }}
                              className="w-full flex items-center justify-between p-2 rounded-lg text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors text-left"
                            >
                              <span className="truncate pr-4">{s.name}</span>
                              <div className={cn(
                                "flex items-center justify-center w-4 h-4 rounded border transition-all",
                                isChecked 
                                  ? "bg-indigo-600 border-indigo-600 text-white" 
                                  : "border-slate-300 dark:border-slate-700"
                              )}>
                                {isChecked && <Check className="w-3 h-3 stroke-[3]" />}
                              </div>
                            </button>
                          );
                        })}
                      {sites.filter(s => s.status !== 'inactive' && s.name.toLowerCase().includes(editSiteSearch.toLowerCase())).length === 0 && (
                        <p className="text-xs text-slate-400 text-center py-2">No sites found</p>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>{verticalLabel('Department', 'Academics')}</Label>
              <Select value={editForm.department || "none"} onValueChange={v => setEditForm(f => ({ ...f, department: v === "none" ? "" : v }))}>
                <SelectTrigger className="rounded-xl h-11 border-slate-200 bg-white dark:bg-slate-900 text-left">
                  <SelectValue placeholder="Select department" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {departments.map(d => (
                    <SelectItem key={d.id} value={d.name}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button 
              onClick={handleEdit} 
              disabled={saving || !isEditDisplayNameValid || !isEditChanged || (['site_admin', 'hr_manager', 'hr'].includes(editForm.roleName) && editForm.siteIds.length === 0)}
              className={cn(
                "w-full sm:w-auto font-semibold rounded-xl transition-all duration-200",
                (saving || !isEditDisplayNameValid || !isEditChanged || (['site_admin', 'hr_manager', 'hr'].includes(editForm.roleName) && editForm.siteIds.length === 0))
                  ? "bg-slate-100 dark:bg-slate-800/80 text-slate-400 dark:text-slate-500 cursor-not-allowed border border-slate-200/50 dark:border-slate-800"
                  : "bg-indigo-600 hover:bg-indigo-700 text-white shadow-md hover:shadow-lg hover:shadow-indigo-500/10 active:scale-[0.98]"
              )}
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              Save Changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete User Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-red-600">Delete User</DialogTitle>
            <DialogDescription>
              This permanently removes <strong>{selectedUser?.name || selectedUser?.email}</strong> and revokes all platform access.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="p-3 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/50 rounded-xl text-xs text-rose-700 dark:text-rose-300 space-y-1">
              <p className="font-bold flex items-center gap-1">
                <Mail className="w-3.5 h-3.5" /> Deletion Confirmation Email
              </p>
              <p>A confirmation email notifying them of account deletion and access revocation will be sent to <strong>{selectedUser?.email}</strong> automatically.</p>
            </div>
            <p className="text-xs text-slate-500">
              To confirm, please type the email address of the user:
              <strong className="block mt-1 text-slate-800 select-none break-all">{selectedUser?.email}</strong>
            </p>
            <div className="space-y-1.5">
              <Label>Confirm Email <span className="text-rose-500">*</span></Label>
              <Input 
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
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button onClick={handleDelete} disabled={deleteConfirmEmail.trim().toLowerCase() !== (selectedUser?.email || '').trim().toLowerCase() || saving}
              className="bg-red-600 hover:bg-red-700 text-white font-semibold">
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              Delete Permanently
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
};
