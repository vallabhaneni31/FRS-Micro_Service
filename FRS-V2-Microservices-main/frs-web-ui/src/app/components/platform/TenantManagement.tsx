import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Badge } from '../ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription
} from '../ui/dialog';
import {
  Building, Plus, Edit, Trash2, Search, RefreshCw, Loader2, Globe, Tag, ChevronRight
} from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { toast } from 'sonner';
import { useAuth } from '../../contexts/AuthContext';
import { apiRequest, invalidateApiCache } from '../../services/http/apiClient';
import { useScopeHeaders } from '../../hooks/useScopeHeaders';
import { TenantDrillDown } from './TenantDrillDown';
import { CreateTenantWizard } from './CreateTenantWizard';
import { PageHeader } from '../shared/PageHeader';
import { lightTheme } from '../../../theme/lightTheme';
import { cn } from '../ui/utils';

interface Tenant {
  id: string;
  name: string;
  tenantTypeId: string | null;
  tenantTypeName: string | null;
  customer_count: number;
  site_count: number;
  user_count: number;
  mustSetPassword?: boolean;
  adminEmail?: string;
}

interface TenantType { id: string; name: string; description: string | null; features: string[] | null; }

export const TenantManagement: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [searchParams, setSearchParams] = useSearchParams();
  const tenantIdParam = searchParams.get('tenantId') || searchParams.get('id');
  const tenantNameParam = searchParams.get('tenantName');

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantTypes, setTenantTypes] = useState<TenantType[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');

  const [page, setPage] = useState(1);
  const PER_PAGE = 10;

  useEffect(() => {
    setPage(1);
  }, [search]);

  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [editTenant, setEditTenant] = useState<Tenant | null>(null);
  const [deleteTenant, setDeleteTenant] = useState<Tenant | null>(null);
  const [formName, setFormName] = useState('');
  const [formTypeId, setFormTypeId] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (isManual = false) => {
    if (isManual) {
      setRefreshing(true);
    } else if (tenants.length === 0) {
      setLoading(true);
    }
    try {
      const minDelay = isManual ? new Promise(resolve => setTimeout(resolve, 600)) : Promise.resolve();
      const [data] = await Promise.all([
        Promise.all([
          apiRequest<{ tenants: Tenant[] }>('/app-admin/tenants', { accessToken, scopeHeaders, noCache: isManual || tenants.length === 0 }),
          apiRequest<{ tenantTypes: TenantType[] }>('/app-admin/tenant-types', { accessToken, scopeHeaders, noCache: isManual || tenants.length === 0 }),
        ]),
        minDelay
      ]);
      const [tenantsData, typesData] = data;
      setTenants(tenantsData.tenants);
      setTenantTypes(typesData.tenantTypes);
    } catch {
      toast.error('Failed to load tenants');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [accessToken, scopeHeaders, tenants.length]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (tenants.length > 0 && (tenantIdParam || tenantNameParam)) {
      const match = tenants.find(
        t => t.id === tenantIdParam || 
             t.name.toLowerCase() === (tenantNameParam || '').toLowerCase() ||
             t.name.toLowerCase().includes((tenantNameParam || '').toLowerCase())
      );
      if (match) {
        setSelectedTenant(match);
      } else {
        setSelectedTenant(tenants[0]);
      }
    }
  }, [tenants, tenantIdParam, tenantNameParam]);

  const filtered = tenants.filter(t =>
    t.name.toLowerCase().includes(search.toLowerCase())
  );

  const total = filtered.length;
  const totalPages = Math.ceil(total / PER_PAGE);
  const pagedList = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const openEdit = (t: Tenant) => { setFormName(t.name); setFormTypeId(t.tenantTypeId ?? ''); setEditTenant(t); };

  const handleEdit = async () => {
    if (!editTenant || !formName.trim()) return;
    setSaving(true);
    try {
      await apiRequest(`/app-admin/tenants/${editTenant.id}`, {
        method: 'PATCH',
        accessToken,
        scopeHeaders,
        body: JSON.stringify({ name: formName.trim(), tenantTypeId: formTypeId || undefined }),
      });
      toast.success('Tenant updated');
      setEditTenant(null);
      invalidateApiCache('/app-admin/tenants');
      load(true);
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to update tenant');
    } finally {
      setSaving(false);
    }
  };

  const [deleteConfirmName, setDeleteConfirmName] = useState('');

  const handleDelete = async () => {
    if (!deleteTenant) return;
    setDeleting(true);
    try {
      const forceFlag = deleteTenant.customer_count > 0 ? '?force=true' : '';
      await apiRequest(`/app-admin/tenants/${deleteTenant.id}${forceFlag}`, {
        method: 'DELETE',
        accessToken,
      });
      toast.success('Tenant deleted successfully');
      setDeleteTenant(null);
      setDeleteConfirmName('');
      invalidateApiCache('/app-admin/tenants');
      load(true);
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to delete tenant');
    } finally {
      setDeleting(false);
    }
  };

  if (selectedTenant) {
    return (
      <TenantDrillDown
        tenantId={selectedTenant.id}
        tenantName={selectedTenant.name}
        tenantTypeName={selectedTenant.tenantTypeName}
        onBack={() => {
          setSelectedTenant(null);
          setSearchParams({});
        }}
      />
    );
  }

  return (
    <div className="space-y-6 pb-16">
      {/* Header */}
      <PageHeader
        title="Tenant Management"
        icon={Building}
        subtitle={`${tenants.length} tenant${tenants.length !== 1 ? 's' : ''} registered`}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => load(true)}
              disabled={loading || refreshing}
              className="gap-2"
            >
              <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
            </Button>
            <Button size="sm" onClick={() => setWizardOpen(true)} className="gap-2">
              <Plus className="w-4 h-4" />
              Add Tenant
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

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className={cn('absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4', lightTheme.text.muted)} />
        <Input
          placeholder="Search tenants..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : filtered.length === 0 ? (
            <div className={cn('flex flex-col items-center justify-center h-48 gap-2', lightTheme.text.secondary)}>
              <Building className="w-10 h-10 opacity-30" />
              <p className="text-sm">{search ? 'No matching tenants' : 'No tenants yet'}</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className={cn('border-b', lightTheme.table.border, lightTheme.table.header)}>
                      <th className="text-left px-6 py-3 font-medium">Name</th>
                      <th className="text-left px-4 py-3 font-medium">Type</th>
                      <th className="text-center px-4 py-3 font-medium">Sites</th>
                      <th className="text-left px-4 py-3 font-medium">Admin Account Status</th>
                      <th className="text-center px-4 py-3 font-medium">Users</th>
                      <th className="text-right px-6 py-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedList.map(t => (
                      <tr
                        key={t.id}
                        className={cn('border-b transition-colors cursor-pointer', lightTheme.table.border, lightTheme.table.rowHover)}
                        onClick={() => setSelectedTenant(t)}
                      >
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', lightTheme.primary.selectedBg)}>
                              <Building className={cn('w-4 h-4', lightTheme.primary.selectedText)} />
                            </div>
                            <span className={cn('font-medium', lightTheme.text.primary)}>{t.name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          {t.tenantTypeName
                            ? <Badge variant="outline" className={cn('gap-1 capitalize', lightTheme.status.info, lightTheme.status.infoBg)}><Tag className="w-3 h-3" />{t.tenantTypeName}</Badge>
                            : <span className={cn('text-xs', lightTheme.text.muted)}>—</span>
                          }
                        </td>
                        <td className="px-4 py-4 text-center">
                          <Badge variant="outline" className={cn('gap-1', lightTheme.status.success, lightTheme.status.successBg)}>
                            <Globe className="w-3 h-3" />
                            {t.site_count}
                          </Badge>
                        </td>
                        <td className="px-4 py-4 text-left">
                          {t.adminEmail ? (
                            <div className="space-y-0.5">
                              <div className={cn('text-xs font-mono', lightTheme.text.secondary)}>{t.adminEmail}</div>
                              {t.mustSetPassword === true ? (
                                <Badge className={cn('text-[10px] font-bold border-0', lightTheme.status.warningBg, lightTheme.status.warning)}>
                                  Invite Sent (Password Pending)
                                </Badge>
                              ) : t.mustSetPassword === false ? (
                                <Badge className={cn('text-[10px] font-bold border-0', lightTheme.status.successBg, lightTheme.status.successFg)}>
                                  Password Set (Active)
                                </Badge>
                              ) : (
                                <span className={cn('text-xs', lightTheme.text.muted)}>—</span>
                              )}
                            </div>
                          ) : (
                            <span className={cn('text-xs', lightTheme.text.muted)}>No admin mapped</span>
                          )}
                        </td>
                        <td className="px-4 py-4 text-center">
                          <span className={lightTheme.text.secondary}>{t.user_count}</span>
                        </td>
                        <td className="px-6 py-4" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEdit(t)}
                              className={cn('h-8 w-8 p-0', lightTheme.text.secondary, 'hover:text-primary')}
                            >
                              <Edit className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setDeleteTenant(t)}
                              className={cn('h-8 w-8 p-0', lightTheme.text.secondary, 'hover:text-rose-600')}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setSelectedTenant(t)}
                              className={cn('h-8 w-8 p-0', lightTheme.text.secondary, 'hover:text-primary')}
                              title="View Tenant Details"
                            >
                              <ChevronRight className="w-4 h-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {total > PER_PAGE && (
                <div className="flex items-center justify-between p-4 border-t border-slate-200 bg-slate-50 rounded-b-lg">
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
            </>
          )}
        </CardContent>
      </Card>

      {/* Create Tenant Wizard */}
      <Dialog open={wizardOpen} onOpenChange={v => !saving && setWizardOpen(v)}>
        <DialogContent className="max-w-[1100px] w-[95vw] sm:w-[90vw] h-[92vh] max-h-[820px] p-0 gap-0 overflow-hidden flex flex-col rounded-2xl">
          <DialogHeader className="px-4 sm:px-6 pt-4 sm:pt-6 pb-3 shrink-0 border-b border-slate-100">
            <DialogTitle className="text-lg sm:text-xl font-bold">New Tenant</DialogTitle>
            <DialogDescription className="text-xs sm:text-sm text-slate-500">Set up a tenant and provision its dedicated realm.</DialogDescription>
          </DialogHeader>
          <CreateTenantWizard
            tenantTypes={tenantTypes}
            onSuccess={() => { setWizardOpen(false); load(); }}
            onCancel={() => setWizardOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editTenant} onOpenChange={v => !v && setEditTenant(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Tenant</DialogTitle>
            <DialogDescription>Update the tenant name.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-name">Tenant Name <span className="text-rose-500">*</span></Label>
              <Input
                id="edit-name"
                value={formName}
                onChange={e => setFormName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleEdit()}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label>Tenant Type</Label>
              <Select value={formTypeId} onValueChange={setFormTypeId}>
                <SelectTrigger><SelectValue placeholder="Select type..." /></SelectTrigger>
                <SelectContent>
                  {tenantTypes.map(tt => (
                    <SelectItem key={tt.id} value={tt.id} className="capitalize">{tt.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setEditTenant(null)}>Cancel</Button>
            <Button
              onClick={handleEdit}
              disabled={!formName.trim() || saving}
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Save Changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={!!deleteTenant} onOpenChange={v => { if (!v) { setDeleteTenant(null); setDeleteConfirmName(''); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className={deleteTenant && deleteTenant.customer_count > 0 ? lightTheme.status.error : ""}>
              Delete Tenant
            </DialogTitle>
            <DialogDescription>
              {deleteTenant && deleteTenant.customer_count > 0 ? (
                <span className={cn('font-medium', lightTheme.status.error)}>
                  WARNING: This tenant has {deleteTenant.customer_count} active customers and {deleteTenant.site_count} sites. 
                  Deleting it will permanently destroy all associated data, including users, devices, and records.
                  <br /><br />
                  To proceed with a force delete, type <strong>{deleteTenant.name}</strong> below.
                </span>
              ) : (
                <>Are you sure you want to delete <strong>{deleteTenant?.name}</strong>? This action cannot be undone.</>
              )}
            </DialogDescription>
          </DialogHeader>
          
          {deleteTenant && deleteTenant.customer_count > 0 && (
            <div className="py-2">
              <Input
                placeholder="Type tenant name to confirm"
                value={deleteConfirmName}
                onChange={e => setDeleteConfirmName(e.target.value)}
                className="border-rose-300 focus-visible:ring-rose-500"
              />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => { setDeleteTenant(null); setDeleteConfirmName(''); }}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting || !!(deleteTenant && deleteTenant.customer_count > 0 && deleteConfirmName !== deleteTenant.name)}
            >
              {deleting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              {deleteTenant && deleteTenant.customer_count > 0 ? 'Force Delete' : 'Delete Tenant'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
};
