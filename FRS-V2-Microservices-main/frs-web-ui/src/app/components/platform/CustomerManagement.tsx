import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Badge } from '../ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription
} from '../ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '../ui/select';
import {
  Users, Plus, Edit, Trash2, Search, RefreshCw, Loader2, Globe, Building
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../contexts/AuthContext';
import { apiRequest } from '../../services/http/apiClient';
import { cn } from '../ui/utils';

interface Customer {
  id: number;
  name: string;
  tenantId: number;
  tenantName: string;
  site_count: number;
}

interface TenantOption {
  id: number;
  name: string;
}

export const CustomerManagement: React.FC = () => {
  const { accessToken } = useAuth();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [filterTenant, setFilterTenant] = useState<string>('all');

  const [page, setPage] = useState(1);
  const PER_PAGE = 10;

  useEffect(() => {
    setPage(1);
  }, [search, filterTenant]);

  const [createOpen, setCreateOpen] = useState(false);
  const [editCustomer, setEditCustomer] = useState<Customer | null>(null);
  const [deleteCustomer, setDeleteCustomer] = useState<Customer | null>(null);
  const [formName, setFormName] = useState('');
  const [formTenantId, setFormTenantId] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadTenants = useCallback(async () => {
    try {
      const data = await apiRequest<{ tenants: TenantOption[] }>('/app-admin/tenants', { accessToken });
      setTenants(data.tenants);
    } catch {
      /* non-critical */
    }
  }, [accessToken]);

  const load = useCallback(async (isManual = false) => {
    if (isManual) {
      setRefreshing(true);
    } else if (customers.length === 0) {
      setLoading(true);
    }
    try {
      const minDelay = isManual ? new Promise(resolve => setTimeout(resolve, 600)) : Promise.resolve();
      const params = filterTenant !== 'all' ? `?tenantId=${filterTenant}` : '';
      const [data] = await Promise.all([
        apiRequest<{ customers: Customer[] }>(
          `/app-admin/customers${params}`,
          { accessToken, noCache: isManual || customers.length === 0 }
        ),
        minDelay
      ]);
      setCustomers(data.customers);
    } catch {
      toast.error('Failed to load customers');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [accessToken, filterTenant, customers.length]);

  useEffect(() => { loadTenants(); }, [loadTenants]);
  useEffect(() => { load(); }, [load]);

  const filtered = customers.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.tenantName.toLowerCase().includes(search.toLowerCase())
  );

  const total = filtered.length;
  const totalPages = Math.ceil(total / PER_PAGE);
  const pagedList = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const openCreate = () => {
    setFormName('');
    setFormTenantId(tenants[0]?.id?.toString() ?? '');
    setCreateOpen(true);
  };
  const openEdit = (c: Customer) => { setFormName(c.name); setEditCustomer(c); };

  const handleCreate = async () => {
    if (!formName.trim() || !formTenantId) return;
    setSaving(true);
    try {
      await apiRequest('/app-admin/customers', {
        method: 'POST',
        accessToken,
        body: JSON.stringify({ name: formName.trim(), tenantId: Number(formTenantId) }),
      });
      toast.success('Customer created');
      setCreateOpen(false);
      load();
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to create customer');
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = async () => {
    if (!editCustomer || !formName.trim()) return;
    setSaving(true);
    try {
      await apiRequest(`/app-admin/customers/${editCustomer.id}`, {
        method: 'PATCH',
        accessToken,
        body: JSON.stringify({ name: formName.trim() }),
      });
      toast.success('Customer updated');
      setEditCustomer(null);
      load();
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to update customer');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteCustomer) return;
    setDeleting(true);
    try {
      await apiRequest(`/app-admin/customers/${deleteCustomer.id}`, {
        method: 'DELETE',
        accessToken,
      });
      toast.success('Customer deleted');
      setDeleteCustomer(null);
      load();
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to delete customer');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Customer Management</h1>
          <p className="text-slate-500 text-sm mt-1">{customers.length} customer{customers.length !== 1 ? 's' : ''} registered</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => load(true)}
            disabled={loading || refreshing}
            className="gap-2"
          >
            <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
          </Button>
          <Button size="sm" onClick={openCreate} className="gap-2 bg-blue-600 hover:bg-blue-700 text-white">
            <Plus className="w-4 h-4" />
            Add Customer
          </Button>
        </div>
      </div>

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
        {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search customers..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={filterTenant} onValueChange={setFilterTenant}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="All Tenants" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Tenants</SelectItem>
            {tenants.map(t => (
              <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card className="border border-slate-200 shadow-sm">
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-slate-400 gap-2">
              <Users className="w-10 h-10 opacity-30" />
              <p className="text-sm">{search ? 'No matching customers' : 'No customers yet'}</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50">
                      <th className="text-left px-6 py-3 font-medium text-slate-600">Customer</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-600">Tenant</th>
                      <th className="text-center px-4 py-3 font-medium text-slate-600">Sites</th>
                      <th className="text-right px-6 py-3 font-medium text-slate-600">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedList.map(c => (
                      <tr key={c.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
                              <Users className="w-4 h-4 text-blue-600" />
                            </div>
                            <span className="font-medium text-slate-800">{c.name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <div className="flex items-center gap-1.5 text-slate-600">
                            <Building className="w-3.5 h-3.5 text-violet-400" />
                            <span>{c.tenantName}</span>
                          </div>
                        </td>
                        <td className="px-4 py-4 text-center">
                          <Badge variant="outline" className="gap-1 text-emerald-700 border-emerald-200 bg-emerald-50">
                            <Globe className="w-3 h-3" />
                            {c.site_count}
                          </Badge>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEdit(c)}
                              className="h-8 w-8 p-0 text-slate-500 hover:text-blue-600"
                            >
                              <Edit className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setDeleteCustomer(c)}
                              className="h-8 w-8 p-0 text-slate-500 hover:text-red-600"
                              disabled={c.site_count > 0}
                            >
                              <Trash2 className="w-4 h-4" />
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

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Customer</DialogTitle>
            <DialogDescription>Create a new customer under a tenant.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Tenant</Label>
              <Select value={formTenantId} onValueChange={setFormTenantId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select tenant..." />
                </SelectTrigger>
                <SelectContent>
                  {tenants.map(t => (
                    <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cust-name">Customer Name</Label>
              <Input
                id="cust-name"
                placeholder="e.g. Acme - Dubai Office"
                value={formName}
                onChange={e => setFormName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                autoFocus
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              onClick={handleCreate}
              disabled={!formName.trim() || !formTenantId || saving}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Create Customer
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editCustomer} onOpenChange={v => !v && setEditCustomer(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Customer</DialogTitle>
            <DialogDescription>
              Update customer name under <strong>{editCustomer?.tenantName}</strong>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-cust-name">Customer Name</Label>
              <Input
                id="edit-cust-name"
                value={formName}
                onChange={e => setFormName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleEdit()}
                autoFocus
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setEditCustomer(null)}>Cancel</Button>
            <Button
              onClick={handleEdit}
              disabled={!formName.trim() || saving}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Save Changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={!!deleteCustomer} onOpenChange={v => !v && setDeleteCustomer(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Customer</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{deleteCustomer?.name}</strong>? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setDeleteCustomer(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Delete Customer
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
};
