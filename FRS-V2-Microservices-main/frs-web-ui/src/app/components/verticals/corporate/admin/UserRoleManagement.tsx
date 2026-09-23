import React, { useState, useEffect, useMemo } from 'react';
import { 
  Card, 
  CardContent, 
  CardHeader, 
  CardTitle 
} from '../../../ui/card';
import { Button } from '../../../ui/button';
import { Badge } from '../../../ui/badge';
import { Input } from '../../../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select';
import { Checkbox } from '../../../ui/checkbox';
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle, 
  DialogDescription,
  DialogFooter
} from '../../../ui/dialog';
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from '../../../ui/table';
import { Label } from '../../../ui/label';
import { RadioGroup, RadioGroupItem } from '../../../ui/radio-group';
import { 
  Shield, 
  Search, 
  X, 
  Plus, 
  Building2, 
  Users2, 
  ShieldCheck, 
  ChevronDown, 
  ChevronUp,
  Briefcase,
  ExternalLink,
  Info
} from 'lucide-react';
import { apiRequest } from '../../../../services/http/apiClient';
import { useAuth } from '../../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { toast } from 'sonner';
import { cn } from '../../../ui/utils';
import { lightTheme } from '../../../../../theme/lightTheme';
import { PageHeader } from '../../../shared/PageHeader';
import {
  RbacUser,
  RbacRoleDefinition, 
  RbacSiteOption, 
  RbacRoleAssignment,
  RbacRoleName,
  Permission
} from '../../../../types';

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: RoleBadge
// ─────────────────────────────────────────────────────────────────────────────

interface RoleBadgeProps {
  roleName: RbacRoleName;
  displayName: string;
  siteName?: string | null;
  onRevoke?: () => void;
  canManage?: boolean;
}

const RoleBadge: React.FC<RoleBadgeProps> = ({ roleName, displayName, siteName, onRevoke, canManage }) => {
  const getColors = () => {
    switch (roleName) {
      case 'super_admin':
        return 'bg-purple-100 text-purple-700 border-purple-200 hover:bg-purple-200';
      case 'site_admin':
        return 'bg-blue-100 text-blue-700 border-blue-200 hover:bg-blue-200';
      case 'hr_manager':
        return 'bg-green-100 text-green-700 border-green-200 hover:bg-green-200';
      default:
        return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  const label = roleName === 'hr_manager' && !siteName 
    ? `${displayName} (All Sites)` 
    : siteName 
      ? `${displayName} · ${siteName}` 
      : displayName;

  return (
    <Badge 
      variant="outline" 
      className={cn(
        "px-2.5 py-1 rounded-lg text-xs font-bold transition-colors gap-1.5 flex-shrink-0 border",
        getColors()
      )}
    >
      <Shield className="w-3 h-3 opacity-70" />
      <span>{label}</span>
      {onRevoke && canManage && (
        <button 
          onClick={(e) => {
            e.stopPropagation();
            onRevoke();
          }}
          className="ml-1 hover:bg-black/10 rounded-full p-0.5 transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </Badge>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: AssignRoleModal
// ─────────────────────────────────────────────────────────────────────────────

interface AssignRoleModalProps {
  userId: number | null;
  userName: string | null;
  isOpen: boolean;
  onClose: () => void;
  onAssigned: () => void;
  roles: RbacRoleDefinition[];
  sites: RbacSiteOption[];
}

const AssignRoleModal: React.FC<AssignRoleModalProps> = ({ 
  userId, 
  userName, 
  isOpen, 
  onClose, 
  onAssigned, 
  roles, 
  sites 
}) => {
  const { accessToken , isAuthenticated } = useAuth();
  const scopeHeaders = useScopeHeaders();
  
  const [selectedRoleName, setSelectedRoleName] = useState<RbacRoleName | ''>('');
  const [selectedSiteIds, setSelectedSiteIds] = useState<number[]>([]);
  const [scopeChoice, setScopeChoice] = useState<'global' | 'site'>('global');
  const [isAssigning, setIsAssigning] = useState(false);
  const [showPermissions, setShowPermissions] = useState(false);

  const selectedRole = roles.find(r => r.roleName === selectedRoleName);

  // Reset state on open/close
  useEffect(() => {
    if (isOpen) {
      setSelectedRoleName('');
      setSelectedSiteIds([]);
      setScopeChoice('global');
      setShowPermissions(false);
    }
  }, [isOpen]);

  const handleAssign = async () => {
    if (!userId || !selectedRoleName) return;

    setIsAssigning(true);
    try {
      const isSiteScope = selectedRoleName === 'site_admin' || (selectedRoleName === 'hr_manager' && scopeChoice === 'site');
      
      const payload: any = {
        roleName: selectedRoleName,
      };

      if (isSiteScope) {
        payload.siteIds = selectedSiteIds;
      } else {
        payload.siteId = null;
      }

      await apiRequest(`/admin/rbac/users/${userId}/roles`, {
        method: 'POST',
        accessToken,
        scopeHeaders,
        body: JSON.stringify(payload)
      });

      toast.success(`Role assigned to ${userName}`);
      onAssigned();
      onClose();
    } catch (error: any) {
      toast.error(error.message || 'Failed to assign role');
    } finally {
      setIsAssigning(false);
    }
  };

  const isFormValid = () => {
    if (!selectedRoleName) return false;
    const isSiteScope = selectedRoleName === 'site_admin' || (selectedRoleName === 'hr_manager' && scopeChoice === 'site');
    if (isSiteScope) return selectedSiteIds.length > 0;
    return true;
  };

  const groupedPermissions = useMemo(() => {
    if (!selectedRole || !selectedRole.permissions) return {};
    const groups: Record<string, string[]> = {};
    selectedRole.permissions.forEach(p => {
      const parts = p.split('.');
      const category = parts.length > 1 ? parts[0] : 'Other';
      if (!groups[category]) groups[category] = [];
      groups[category].push(p);
    });
    return groups;
  }, [selectedRole]);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-xl p-0 overflow-hidden rounded-2xl border-none">
        <DialogHeader className="p-6 bg-slate-50 dark:bg-slate-950 border-b border-slate-100 dark:border-slate-800">
          <DialogTitle className="text-xl font-black text-slate-800 dark:text-white">Assign Role to {userName}</DialogTitle>
          <DialogDescription className="text-slate-500 dark:text-slate-400 font-medium">Select a role and define its operational scope.</DialogDescription>
        </DialogHeader>

        <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
          {/* Role Selection */}
          <div className="space-y-3">
            <Label className="text-[10px] font-bold uppercase text-slate-400 tracking-widest">Select Role</Label>
            <RadioGroup
              value={selectedRoleName}
              onValueChange={(value: RbacRoleName) => {
                setSelectedRoleName(value);
                if (value === 'site_admin') {
                  setScopeChoice('site');
                } else {
                  setScopeChoice('global');
                }
              }}
              className="grid grid-cols-1 gap-3"
            >
              {roles.map(role => {
                const isSelected = selectedRoleName === role.roleName;
                const radioId = `assign-role-${role.roleName}`;

                return (
                  <Label
                    key={role.roleName}
                    htmlFor={radioId}
                    className={cn(
                      "flex items-start gap-4 p-4 rounded-xl border-2 transition-all cursor-pointer group",
                      isSelected
                        ? "bg-blue-50/50 dark:bg-blue-950/20 border-blue-500 shadow-md ring-1 ring-blue-500/20"
                        : "bg-white dark:bg-slate-900 border-slate-100 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 hover:shadow-sm"
                    )}
                  >
                    <RadioGroupItem
                      id={radioId}
                      value={role.roleName}
                      className="mt-1"
                    />
                    <div className={cn(
                      "w-10 h-10 rounded-lg flex items-center justify-center transition-colors",
                      isSelected ? "bg-blue-600 text-white" : "bg-slate-100 dark:bg-slate-850 text-slate-400 dark:text-slate-500 group-hover:bg-slate-200 dark:group-hover:bg-slate-800"
                    )}>
                      {role.roleName === 'super_admin' && <ShieldCheck className="w-6 h-6" />}
                      {role.roleName === 'site_admin' && <Building2 className="w-6 h-6" />}
                      {role.roleName === 'hr_manager' && <Users2 className="w-6 h-6" />}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-bold text-slate-900 dark:text-white">{role.displayName}</span>
                        {isSelected && (
                          <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center">
                            <div className="w-2 h-2 rounded-full bg-white" />
                          </div>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">{role.description}</p>
                    </div>
                  </Label>
                );
              })}
            </RadioGroup>
          </div>

          {/* Conditional Site/Scope Selector */}
          {selectedRoleName && selectedRoleName !== 'super_admin' && (
            <div className="space-y-4 p-5 rounded-2xl bg-slate-50 dark:bg-slate-900 border border-slate-100 dark:border-slate-800 animate-in fade-in slide-in-from-top-2 duration-300">
              {selectedRoleName === 'site_admin' && (
                <div className="space-y-3">
                  <Label className="text-[10px] font-bold uppercase text-slate-400 tracking-widest flex items-center gap-2">
                    <Building2 className="w-3 h-3" /> Target Sites
                  </Label>
                  <div className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 p-4 max-h-48 overflow-y-auto space-y-2.5 shadow-sm">
                    {sites.map(site => {
                      const isChecked = selectedSiteIds.includes(site.id);
                      return (
                        <div key={site.id} className="flex items-center space-x-3 hover:bg-slate-50 dark:hover:bg-slate-800/50 p-1.5 rounded-lg transition-colors">
                          <Checkbox 
                            id={`site-${site.id}`} 
                            checked={isChecked} 
                            onCheckedChange={(checked) => {
                              if (checked) {
                                setSelectedSiteIds([...selectedSiteIds, site.id]);
                              } else {
                                setSelectedSiteIds(selectedSiteIds.filter(id => id !== site.id));
                              }
                            }}
                          />
                          <Label htmlFor={`site-${site.id}`} className="text-sm font-medium text-slate-700 dark:text-slate-300 cursor-pointer flex-1 select-none">
                            {site.name}
                          </Label>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[10px] text-slate-500 italic">Select one or more sites to restrict Site Admin access.</p>
                </div>
              )}

              {selectedRoleName === 'hr_manager' && (
                <div className="space-y-4">
                  <div className="space-y-3">
                    <Label className="text-[10px] font-bold uppercase text-slate-400 tracking-widest flex-center gap-2">
                       Scope Choice
                    </Label>
                    <RadioGroup 
                      value={scopeChoice} 
                      onValueChange={(v: 'global' | 'site') => setScopeChoice(v)}
                      className="flex gap-4"
                    >
                      <div className="flex items-center space-x-2 bg-white dark:bg-slate-950 px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-850 shadow-sm flex-1 cursor-pointer">
                        <RadioGroupItem value="global" id="scope-global" />
                        <Label htmlFor="scope-global" className="font-bold text-sm cursor-pointer">Company-wide</Label>
                      </div>
                      <div className="flex items-center space-x-2 bg-white dark:bg-slate-950 px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-850 shadow-sm flex-1 cursor-pointer">
                        <RadioGroupItem value="site" id="scope-site" />
                        <Label htmlFor="scope-site" className="font-bold text-sm cursor-pointer">Specific Site(s)</Label>
                      </div>
                    </RadioGroup>
                  </div>

                  {scopeChoice === 'site' && (
                    <div className="space-y-3 animate-in fade-in slide-in-from-left-2 duration-200">
                      <Label className="text-[10px] font-bold uppercase text-slate-400 tracking-widest flex items-center gap-2">
                        Target Sites
                      </Label>
                      <div className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 p-4 max-h-48 overflow-y-auto space-y-2.5 shadow-sm">
                        {sites.map(site => {
                          const isChecked = selectedSiteIds.includes(site.id);
                          return (
                            <div key={site.id} className="flex items-center space-x-3 hover:bg-slate-50 dark:hover:bg-slate-800/50 p-1.5 rounded-lg transition-colors">
                              <Checkbox 
                                id={`site-${site.id}`} 
                                checked={isChecked} 
                                onCheckedChange={(checked) => {
                                  if (checked) {
                                    setSelectedSiteIds([...selectedSiteIds, site.id]);
                                  } else {
                                    setSelectedSiteIds(selectedSiteIds.filter(id => id !== site.id));
                                  }
                                }}
                              />
                              <Label htmlFor={`site-${site.id}`} className="text-sm font-medium text-slate-700 dark:text-slate-300 cursor-pointer flex-1 select-none">
                                {site.name}
                              </Label>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Permission Preview */}
          {selectedRole && (
            <div className="border border-slate-100 rounded-xl overflow-hidden">
              <button 
                onClick={() => setShowPermissions(!showPermissions)}
                className="w-full flex items-center justify-between p-4 bg-slate-50/50 dark:bg-slate-900/50 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-blue-600" />
                  <span className="text-sm font-bold text-slate-700 dark:text-slate-300">View Permissions ({selectedRole.permissions?.length || 0})</span>
                </div>
                {showPermissions ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
              </button>
              
              {showPermissions && (
                <div className="p-4 bg-white dark:bg-slate-900 border-t border-slate-50 dark:border-slate-800 grid grid-cols-2 gap-x-6 gap-y-4 animate-in fade-in duration-200">
                  {Object.entries(groupedPermissions).map(([category, perms]: [string, string[]]) => (
                    <div key={category} className="space-y-1.5">
                      <h4 className="text-[10px] font-black uppercase text-slate-400 tracking-tighter">{category}</h4>
                      <div className="flex flex-wrap gap-1.5">
                        {perms.map(p => (
                          <span key={p} className="text-[10px] font-medium px-2 py-0.5 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded">
                            {p.includes('.') ? p.split('.').slice(1).join('.') : p}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="p-6 bg-slate-50 dark:bg-slate-950 border-t border-slate-100 dark:border-slate-800 gap-2">
          <Button variant="ghost" onClick={onClose} className="rounded-xl font-bold">Cancel</Button>
          <Button
            onClick={handleAssign}
            disabled={!isFormValid() || isAssigning}
            className="px-8 rounded-xl font-bold shadow-lg shadow-blue-500/20"
          >
            {isAssigning ? 'Assigning...' : 'Assign Role'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Component: UserRoleManagement
// ─────────────────────────────────────────────────────────────────────────────

export const UserRoleManagement: React.FC = () => {
  const { accessToken, can, isAuthenticated, user: currentUser, memberships } = useAuth();
  const scopeHeaders = useScopeHeaders();

  const isCallerTenantOrSuperAdmin = 
    currentUser?.role === 'tenant_admin' || 
    currentUser?.role === 'super_admin' || 
    currentUser?.role === 'admin' ||
    memberships?.some(m => m.role === 'tenant_admin' || m.role === 'super_admin' || m.role === 'admin');
  
  const [users, setUsers] = useState<RbacUser[]>([]);
  const [roles, setRoles] = useState<RbacRoleDefinition[]>([]);
  const [sites, setSites] = useState<RbacSiteOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Modal State
  const [assignmentModal, setAssignmentModal] = useState<{
    userId: number | null;
    userName: string | null;
    isOpen: boolean;
  }>({
    userId: null,
    userName: null,
    isOpen: false
  });

  const normalizeRoleDefinition = (role: any): RbacRoleDefinition => ({
    id: role.id ?? role.pk_role_id,
    roleName: role.roleName ?? role.role_name,
    displayName: role.displayName ?? role.display_name,
    description: role.description,
    scopeType: role.scopeType ?? role.scope_type,
    permissions: role.permissions ?? [],
  });

  const fetchData = async () => {
    if (!isAuthenticated) return;
    setIsLoading(true);
    try {
      const [uRes, rRes, sRes] = await Promise.all([
        apiRequest<RbacUser[]>('/admin/rbac/users', { accessToken, scopeHeaders }),
        apiRequest<RbacRoleDefinition[]>('/admin/rbac/roles', { accessToken, scopeHeaders }),
        apiRequest<RbacSiteOption[]>('/admin/rbac/sites', { accessToken, scopeHeaders })
      ]);
      setUsers(uRes || []);
      setRoles((rRes || []).map(normalizeRoleDefinition));
      setSites(sRes || []);
    } catch (error) {
      toast.error('Failed to load access control data');
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [accessToken, scopeHeaders]);

  const handleRevoke = async (userRoleId: number, userName: string) => {
    if (!isAuthenticated) return;
    
    try {
      await apiRequest(`/admin/rbac/user-roles/${userRoleId}`, {
        method: 'DELETE',
        accessToken,
        scopeHeaders
      });
      toast.success(`Role revoked from ${userName}`);
      fetchData(); // Refresh list
    } catch (error: any) {
      toast.error(error.message || 'Failed to revoke role');
    }
  };

  const filteredUsers = users.filter(u => 
    (u.name?.toLowerCase() || '').includes(searchQuery.toLowerCase()) || 
    (u.email?.toLowerCase() || '').includes(searchQuery.toLowerCase())
  );

  const canManage = can('users.roles.manage');

  if (isLoading && users.length === 0) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-20 bg-slate-100 rounded-3xl" />
        <div className="h-[400px] bg-slate-50 rounded-3xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Access Control"
        icon={Shield}
        subtitle="Manage user roles and permissions"
        actions={
          <div className="relative">
            <Search className={cn('absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4', lightTheme.text.muted)} />
            <Input
              placeholder="Search by name or email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={cn('pl-10 pr-4 h-11 rounded-2xl w-full md:w-[320px] bg-white dark:bg-slate-900 shadow-sm ring-blue-500/10 focus:ring-4 transition-all', lightTheme.border.default)}
            />
          </div>
        }
      />

      <Card className="border-none shadow-xl shadow-slate-200/50 dark:shadow-none bg-white dark:bg-card overflow-hidden rounded-[2rem]">
        <Table>
          <TableHeader>
            <TableRow className={cn('border-b', lightTheme.table.border, lightTheme.table.header)}>
              <TableHead className={cn('pl-8 py-5 text-[10px] font-black uppercase tracking-[0.2em]', lightTheme.text.muted)}>User Profile</TableHead>
              <TableHead className={cn('text-[10px] font-black uppercase tracking-[0.2em]', lightTheme.text.muted)}>Active Roles</TableHead>
              <TableHead className={cn('text-right pr-8 py-5 text-[10px] font-black uppercase tracking-[0.2em]', lightTheme.text.muted)}>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredUsers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="h-64 text-center">
                  <div className={cn('flex flex-col items-center justify-center gap-3', lightTheme.text.muted)}>
                    <div className={cn('w-16 h-16 rounded-full flex items-center justify-center', lightTheme.background.secondary)}>
                      <Search className="w-8 h-8 opacity-20" />
                    </div>
                    <div>
                      <p className={cn('font-bold', lightTheme.text.secondary)}>No users found</p>
                      <p className="text-xs">Try adjusting your search query</p>
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filteredUsers.map(user => {
                const isTargetTenantOrSuperAdmin = 
                  user.legacyRole === 'tenant_admin' || 
                  user.legacyRole === 'super_admin' || 
                  user.legacyRole === 'admin' ||
                  user.assignments?.some(a => a.roleName === 'tenant_admin' || a.roleName === 'super_admin' || a.roleName === 'admin');

                // Site Admins cannot edit/delete Tenant Admins or Super Admins
                const cannotManageThisUser = !isCallerTenantOrSuperAdmin && isTargetTenantOrSuperAdmin;

                return (
                  <TableRow key={user.id} className={cn('group transition-colors border-b last:border-0', lightTheme.table.rowHover, lightTheme.table.border)}>
                    <TableCell className="pl-8 py-6">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center shadow-lg shadow-blue-500/20 text-white">
                          <span className="font-black text-sm tracking-tighter">
                            {(user.name || 'U').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                          </span>
                        </div>
                        <div>
                          <div className={cn('font-black tracking-tight leading-none mb-1', lightTheme.text.primary)}>{user.name || 'Unknown User'}</div>
                          <div className={cn('text-xs font-semibold lowercase', lightTheme.text.muted)}>{user.email || 'no-email@provided.com'}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        {!user.assignments || user.assignments.length === 0 ? (
                          isTargetTenantOrSuperAdmin ? (
                            <Badge variant="outline" className="px-2.5 py-1 rounded-lg text-xs font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20 gap-1.5 flex-shrink-0 border">
                              <Shield className="w-3 h-3 opacity-70" />
                              <span>{user.legacyRole === 'super_admin' ? 'Super Admin' : 'Tenant Admin'}</span>
                            </Badge>
                          ) : (
                            <div className={cn('flex items-center gap-2', lightTheme.text.muted)}>
                              <Info className="w-3.5 h-3.5" />
                              <span className="text-[10px] font-bold uppercase tracking-wider">No roles assigned</span>
                            </div>
                          )
                        ) : (
                          user.assignments.map(assignment => (
                            <RoleBadge 
                              key={assignment.id}
                              roleName={assignment.roleName}
                              displayName={assignment.displayName}
                              siteName={assignment.siteName}
                              onRevoke={() => handleRevoke(assignment.id, user.name || 'User')}
                              canManage={canManage && !cannotManageThisUser}
                            />
                          ))
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right pr-8">
                      {canManage && (
                        cannotManageThisUser ? (
                          <Button 
                            size="sm"
                            variant="ghost"
                            disabled
                            title="Site Admins cannot modify Tenant Admin or Super Admin roles"
                            className="h-10 px-4 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 opacity-60 cursor-not-allowed font-black text-[10px] uppercase tracking-widest gap-2 border border-slate-200 dark:border-slate-800"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            Assign Role
                          </Button>
                        ) : (
                          <Button 
                            size="sm"
                            variant="ghost"
                            onClick={() => setAssignmentModal({ userId: user.id, userName: user.name || 'User', isOpen: true })}
                            className="h-10 px-4 rounded-xl bg-slate-50 dark:bg-slate-900 hover:bg-blue-600 dark:hover:bg-blue-600 hover:text-white transition-all font-black text-[10px] uppercase tracking-widest text-slate-500 dark:text-slate-400 gap-2 border border-slate-100 dark:border-slate-800"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            Assign Role
                          </Button>
                        )
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      <AssignRoleModal 
        userId={assignmentModal.userId}
        userName={assignmentModal.userName}
        isOpen={assignmentModal.isOpen}
        onClose={() => setAssignmentModal({ ...assignmentModal, isOpen: false })}
        onAssigned={fetchData}
        roles={roles}
        sites={sites}
      />
    </div>
  );
};
