import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '../../../ui/card';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';
import { Label } from '../../../ui/label';
import { Badge } from '../../../ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../../ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select';
import { UsersRound, Plus, RefreshCw, Loader2, Shield, Trash2, UserPlus, ChevronDown, ChevronRight, Edit } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../../../contexts/AuthContext';
import { apiRequest } from '../../../../services/http/apiClient';
import { ConfirmModal } from '../../../ui/confirm-modal';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { PageHeader } from '../../../shared/PageHeader';
import { cn } from '../../../ui/utils';
import { lightTheme } from '../../../../../theme/lightTheme';
import { PaginationBar } from '../../../shared/PaginationBar';
import { validateGroupName } from '../../../../utils/userValidation';

interface Role { roleId: number; roleName: string; siteId: number | null; }
interface Group {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  isAdminGroup: boolean;
  isActive: boolean;
  createdAt: string;
  member_count: number;
  roles: Role[];
}
interface Member { id: number; email: string; name: string; addedAt: string; }
interface TenantUser { id: number; email: string; name: string; }
interface RbacRole { pk_role_id: number; role_name: string; }

const ROLE_COLORS: Record<string, string> = {
  site_admin:   'bg-blue-100 text-blue-700 border-blue-200',
  hr_manager:   'bg-emerald-100 text-emerald-700 border-emerald-200',
  tenant_admin: 'bg-violet-100 text-violet-700 border-violet-200',
};

export const TenantGroups: React.FC = () => {
  const { accessToken, translateRole, verticalLabel } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [groups, setGroups] = useState<Group[]>([]);
  const [allUsers, setAllUsers] = useState<TenantUser[]>([]);
  const [rbacRoles, setRbacRoles] = useState<RbacRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [membersMap, setMembersMap] = useState<Record<string, Member[]>>({});
  const [membersLoading, setMembersLoading] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [createOpen, setCreateOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', roleIds: [] as number[] });
  const [selectedUserId, setSelectedUserId] = useState('');

  // Edit states
  const [editOpen, setEditOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const [editForm, setEditForm] = useState({ name: '', description: '', roleIds: [] as number[] });
  const [createTouched, setCreateTouched] = useState(false);
  const [editTouched, setEditTouched] = useState(false);

  useEffect(() => {
    if (!createOpen) {
      setForm({ name: '', description: '', roleIds: [] });
      setCreateTouched(false);
    }
  }, [createOpen]);

  useEffect(() => {
    if (!editOpen) {
      setEditTouched(false);
    }
  }, [editOpen]);

  const openEdit = (g: Group) => {
    setSelectedGroup(g);
    setEditForm({
      name: g.name,
      description: g.description || '',
      roleIds: g.roles?.map(r => r.roleId) || []
    });
    setEditOpen(true);
  };

  const isEditChanged = React.useMemo(() => {
    if (!selectedGroup) return false;
    const originalRoleIds = selectedGroup.roles?.map(r => r.roleId) || [];
    const roleIdsChanged = editForm.roleIds.length !== originalRoleIds.length || !editForm.roleIds.every(id => originalRoleIds.includes(id));
    return (
      editForm.name !== selectedGroup.name ||
      editForm.description !== (selectedGroup.description || '') ||
      roleIdsChanged
    );
  }, [selectedGroup, editForm]);

  const handleEdit = async () => {
    if (!selectedGroup) return;
    const nameValidation = validateGroupName(editForm.name);
    if (!nameValidation.valid) {
      setEditTouched(true);
      return;
    }
    setSaving(true);
    try {
      await apiRequest(`/tenant-admin/groups/${selectedGroup.id}`, {
        method: 'PATCH',
        accessToken,
        scopeHeaders,
        body: JSON.stringify({
          name: editForm.name,
          description: editForm.description,
          roleIds: editForm.roleIds,
        }),
      });
      toast.success('Group updated successfully');
      setEditOpen(false);
      load();
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to update group');
    } finally {
      setSaving(false);
    }
  };

  const toggleEditRoleId = (id: number) =>
    setEditForm(f => ({
      ...f,
      roleIds: f.roleIds.includes(id) ? f.roleIds.filter(r => r !== id) : [...f.roleIds, id],
    }));

  const load = useCallback(async (isManual = false) => {
    if (isManual) {
      setRefreshing(true);
    } else if (groups.length === 0) {
      setLoading(true);
    }
    try {
      const minDelay = isManual ? new Promise(resolve => setTimeout(resolve, 600)) : Promise.resolve();
      const [data] = await Promise.all([
        Promise.all([
          apiRequest<{ groups: Group[] }>('/tenant-admin/groups', { accessToken, scopeHeaders, noCache: true }),
          apiRequest<{ users: TenantUser[] }>('/tenant-admin/users', { accessToken, scopeHeaders, noCache: true }),
        ]),
        minDelay
      ]);
      const [grpData, userData] = data;
      setGroups(grpData.groups);
      setAllUsers(userData.users);
      setPage(1);
    } catch {
      toast.error('Failed to load groups');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [accessToken, scopeHeaders, groups.length]);

  useEffect(() => { load(); }, [load]);

  // Fetch available RBAC roles once
  useEffect(() => {
    // /admin/rbac/roles returns a plain array with {id, role_name}
    apiRequest<any>('/admin/rbac/roles', { accessToken, scopeHeaders })
      .then(d => {
        const arr: any[] = Array.isArray(d) ? d : (d.roles ?? []);
        setRbacRoles(arr.map(r => ({ pk_role_id: r.pk_role_id ?? r.id, role_name: r.role_name })));
      })
      .catch(() => {
        setRbacRoles([
          { pk_role_id: 2, role_name: 'site_admin' },
          { pk_role_id: 3, role_name: 'hr_manager' },
          { pk_role_id: 7, role_name: 'tenant_admin' },
        ]);
      });
  }, [accessToken]);

  const loadMembers = async (groupId: string, force: boolean = false) => {
    if (!force && membersMap[groupId]) return;
    setMembersLoading(groupId);
    try {
      const data = await apiRequest<{ members: Member[] }>(
        `/tenant-admin/groups/${groupId}/members`,
        { accessToken, scopeHeaders, noCache: force }
      );
      setMembersMap(m => ({ ...m, [groupId]: data.members }));
    } catch {
      toast.error('Failed to load members');
    } finally {
      setMembersLoading(null);
    }
  };

  const toggleExpand = (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
    } else {
      setExpandedId(id);
      loadMembers(id);
    }
  };

  const handleCreate = async () => {
    const nameValidation = validateGroupName(form.name);
    if (!nameValidation.valid) {
      setCreateTouched(true);
      return;
    }
    setSaving(true);
    try {
      await apiRequest('/tenant-admin/groups', {
        method: 'POST',
        accessToken,
        scopeHeaders,
        body: JSON.stringify({ name: form.name, description: form.description, roleIds: form.roleIds }),
      });
      toast.success('Group created');
      setCreateOpen(false);
      setForm({ name: '', description: '', roleIds: [] });
      load();
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to create group');
    } finally {
      setSaving(false);
    }
  };

  const [confirmConfig, setConfirmConfig] = useState<{
    title: string;
    description?: string;
    confirmText?: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  const handleDelete = async (id: string, name: string) => {
    setConfirmConfig({
      title: `Delete group "${name}"?`,
      description: 'This will remove the group and its assigned permissions.',
      confirmText: 'Delete Group',
      onConfirm: async () => {
        try {
          await apiRequest(`/tenant-admin/groups/${id}`, { method: 'DELETE', accessToken, scopeHeaders });
          toast.success('Group deleted');
          load();
        } catch {
          toast.error('Failed to delete group');
        }
      },
    });
  };

  const handleAddMember = async () => {
    if (!selectedUserId || !addMemberOpen) return;
    const groupId = addMemberOpen;
    setSaving(true);
    try {
      await apiRequest(`/tenant-admin/groups/${groupId}/members`, {
        method: 'POST',
        accessToken,
        scopeHeaders,
        body: JSON.stringify({ userId: Number(selectedUserId) }),
      });
      toast.success('Member added');
      setAddMemberOpen(null);
      setSelectedUserId('');
      loadMembers(groupId, true);
      load();
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to add member');
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveMember = async (groupId: string, userId: number) => {
    try {
      await apiRequest(`/tenant-admin/groups/${groupId}/members/${userId}`, {
        method: 'DELETE', accessToken, scopeHeaders,
      });
      setMembersMap(m => ({ ...m, [groupId]: (m[groupId] ?? []).filter(u => u.id !== userId) }));
      load();
    } catch {
      toast.error('Failed to remove member');
    }
  };

  const toggleRoleId = (id: number) =>
    setForm(f => ({
      ...f,
      roleIds: f.roleIds.includes(id) ? f.roleIds.filter(r => r !== id) : [...f.roleIds, id],
    }));

  const totalPages = Math.ceil(groups.length / pageSize);
  const paginatedGroups = groups.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Groups"
        icon={UsersRound}
        subtitle={`${groups.length} group${groups.length !== 1 ? 's' : ''} in this tenant`}
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
            <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white">
              <Plus className="w-4 h-4" /> New Group
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

      {loading ? (
        <div className="flex justify-center h-48 items-center">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : groups.length === 0 ? (
        <div className={cn('flex flex-col items-center justify-center h-48 gap-2', lightTheme.text.muted)}>
          <UsersRound className="w-10 h-10 opacity-30" />
          <p className="text-sm">No groups yet</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-3">
            {paginatedGroups.map(g => (
              <Card key={g.id} className={cn('border shadow-sm', lightTheme.border.default)}>
                <CardContent className="p-0">
                  {/* Header row */}
                  <div
                    className={cn('flex items-center gap-4 p-4 cursor-pointer rounded-lg', lightTheme.table.rowHover)}
                    onClick={() => toggleExpand(g.id)}
                  >
                    {expandedId === g.id
                      ? <ChevronDown className={cn('w-4 h-4 shrink-0', lightTheme.text.muted)} />
                      : <ChevronRight className={cn('w-4 h-4 shrink-0', lightTheme.text.muted)} />
                    }
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={cn('font-semibold', lightTheme.text.primary)}>
                          {g.name === 'HR Team' ? verticalLabel('HR Team', 'Operators Team') :
                           g.name === 'Site Managers' ? verticalLabel('Site Managers', 'Principals') :
                           g.name === 'Tenant Admins' ? verticalLabel('Tenant Admins', 'Institution Admins') : g.name}
                        </span>
                        {g.isAdminGroup && <Badge variant="outline" className="text-xs bg-violet-50 text-violet-700 border-violet-200">Admin</Badge>}
                        {g.isDefault && <Badge variant="outline" className="text-xs bg-slate-100 text-slate-600">Default</Badge>}
                      </div>
                      {g.description && (
                        <p className={cn('text-xs mt-0.5 truncate', lightTheme.text.secondary)}>
                          {g.name === 'HR Team' ? verticalLabel('People and leave management', 'People and classroom management') : g.description}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <div className="flex gap-1 flex-wrap justify-end">
                        {g.roles.map(r => (
                          <Badge key={r.roleId} variant="outline"
                            className={`text-xs ${ROLE_COLORS[r.roleName] ?? 'bg-slate-100 text-slate-600'}`}>
                            <Shield className="w-2.5 h-2.5 mr-1" />{translateRole(r.roleName)}
                          </Badge>
                        ))}
                      </div>
                      <span className={cn('text-sm whitespace-nowrap', lightTheme.text.secondary)}>{g.member_count} member{g.member_count !== 1 ? 's' : ''}</span>
                      <Button
                        variant="ghost" size="sm"
                        onClick={e => { e.stopPropagation(); setAddMemberOpen(g.id); }}
                        className="text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50"
                        title="Add Member"
                      >
                        <UserPlus className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost" size="sm"
                        onClick={e => { e.stopPropagation(); openEdit(g); }}
                        className="text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                        title="Edit Group"
                      >
                        <Edit className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost" size="sm"
                        onClick={e => { e.stopPropagation(); handleDelete(g.id, g.name); }}
                        className="text-rose-500 hover:text-rose-600 hover:bg-rose-50"
                        title="Delete Group"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>

                  {/* Expanded members */}
                  {expandedId === g.id && (
                    <div className={cn('border-t px-6 py-3', lightTheme.table.border)}>
                      {membersLoading === g.id ? (
                        <div className="flex justify-center py-4">
                          <Loader2 className="w-4 h-4 animate-spin text-primary" />
                        </div>
                      ) : (membersMap[g.id] ?? []).length === 0 ? (
                        <p className={cn('text-sm py-2 text-center', lightTheme.text.muted)}>No members yet</p>
                      ) : (
                        <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <tbody>
                            {(membersMap[g.id] ?? []).map(m => (
                              <tr key={m.id} className={cn('border-b last:border-0', lightTheme.table.border)}>
                                <td className={cn('py-2 font-medium', lightTheme.text.primary)}>{m.name || m.email}</td>
                                <td className={cn('py-2 text-xs', lightTheme.text.secondary)}>{m.email}</td>
                                <td className="py-2 text-right">
                                  <Button
                                    variant="ghost" size="sm"
                                    onClick={() => handleRemoveMember(g.id, m.id)}
                                    className="text-rose-400 hover:text-rose-600 h-7 px-2"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </Button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="bg-card border border-border rounded-xl px-6">
            <PaginationBar
              page={page}
              pageSize={pageSize}
              total={groups.length}
              totalPages={totalPages}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
            />
          </div>
        </div>
      )}

      {/* Create Group Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Group</DialogTitle>
            <DialogDescription>Create a user group and assign roles to it.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label>Group Name <span className="text-rose-500">*</span></Label>
              <Input placeholder="e.g. Delhi HR Team" value={form.name} maxLength={50}
                onChange={e => {
                  setForm(f => ({ ...f, name: e.target.value }));
                  setCreateTouched(true);
                }}
                className={cn(createTouched && validateGroupName(form.name).error && "border-red-500 focus-visible:ring-red-500")}
              />
              {createTouched && validateGroupName(form.name).error && (
                <p className="text-xs text-red-500 font-medium">{validateGroupName(form.name).error}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Input placeholder="Optional description" value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Roles</Label>
              <div className="grid grid-cols-2 gap-2">
                {rbacRoles.filter(r => r.role_name !== 'super_admin').map(r => (
                  <label key={r.pk_role_id}
                    className="flex items-center gap-2 p-2.5 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
                    <input type="checkbox"
                      checked={form.roleIds.includes(r.pk_role_id)}
                      onChange={() => toggleRoleId(r.pk_role_id)}
                      className="w-3.5 h-3.5 accent-indigo-600" />
                    <span className="text-sm text-slate-700">{translateRole(r.role_name)}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!validateGroupName(form.name).valid || saving}
              className="bg-indigo-600 hover:bg-indigo-700 text-white">
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              Create Group
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Group Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Group</DialogTitle>
            <DialogDescription>Modify group details and role mapping.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label>Group Name <span className="text-rose-500">*</span></Label>
              <Input placeholder="e.g. Delhi HR Team" value={editForm.name} maxLength={50}
                onChange={e => {
                  setEditForm(f => ({ ...f, name: e.target.value }));
                  setEditTouched(true);
                }}
                className={cn(editTouched && validateGroupName(editForm.name).error && "border-red-500 focus-visible:ring-red-500")}
              />
              {editTouched && validateGroupName(editForm.name).error && (
                <p className="text-xs text-red-500 font-medium">{validateGroupName(editForm.name).error}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Input placeholder="Optional description" value={editForm.description}
                onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Roles</Label>
              <div className="grid grid-cols-2 gap-2">
                {rbacRoles.filter(r => r.role_name !== 'super_admin').map(r => (
                  <label key={r.pk_role_id}
                    className="flex items-center gap-2 p-2.5 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
                    <input type="checkbox"
                      checked={editForm.roleIds.includes(r.pk_role_id)}
                      onChange={() => toggleEditRoleId(r.pk_role_id)}
                      className="w-3.5 h-3.5 accent-indigo-600" />
                    <span className="text-sm text-slate-700">{translateRole(r.role_name)}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button onClick={handleEdit} disabled={!validateGroupName(editForm.name).valid || saving || !isEditChanged}
              className={cn(
                "transition-all duration-200 font-semibold",
                (!validateGroupName(editForm.name).valid || saving || !isEditChanged)
                  ? "bg-slate-100 dark:bg-slate-800/80 text-slate-400 dark:text-slate-500 cursor-not-allowed border border-slate-200/50 dark:border-slate-800"
                  : "bg-indigo-600 hover:bg-indigo-700 text-white shadow-md hover:shadow-lg hover:shadow-indigo-500/10 active:scale-[0.98]"
              )}>
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              Save Changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Member Dialog */}
      <Dialog open={!!addMemberOpen} onOpenChange={() => { setAddMemberOpen(null); setSelectedUserId(''); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Member</DialogTitle>
            <DialogDescription>Add a tenant user to this group.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label>Select User</Label>
            <Select value={selectedUserId} onValueChange={setSelectedUserId}>
              <SelectTrigger><SelectValue placeholder="Choose user..." /></SelectTrigger>
              <SelectContent>
                {allUsers.map(u => (
                  <SelectItem key={u.id} value={String(u.id)}>
                    {u.name || u.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => { setAddMemberOpen(null); setSelectedUserId(''); }}>Cancel</Button>
            <Button onClick={handleAddMember} disabled={!selectedUserId || saving}
              className="bg-indigo-600 hover:bg-indigo-700 text-white">
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              Add Member
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {/* Centered Popup Modal */}
      {confirmConfig && (
        <ConfirmModal
          isOpen={true}
          onClose={() => setConfirmConfig(null)}
          title={confirmConfig.title}
          description={confirmConfig.description}
          confirmText={confirmConfig.confirmText || 'Confirm'}
          onConfirm={confirmConfig.onConfirm}
        />
      )}
      </div>
    </div>
  );
};
