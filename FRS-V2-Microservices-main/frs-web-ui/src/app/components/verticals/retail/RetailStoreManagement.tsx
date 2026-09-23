import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '../../ui/button';
import { ConfirmModal } from '../../ui/confirm-modal';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';
import {
  Store as StoreIcon, Plus, Edit, Search, RefreshCw, MapPin, Loader2,
  ShieldAlert, Download, User, Building2, Radio, MapPinOff,
  Users, UserPlus, Mail, Clock, X, Copy, Check,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../../ui/utils';
import { useAuth } from '../../../contexts/AuthContext';
import { apiRequest } from '../../../services/http/apiClient';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';

const RETAIL_BASE = '/v1/retail';

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface RetailStore {
  id: string;
  name: string;
  address: string | null;
  timezone: string;
  max_capacity: number;
  warning_threshold: number;
  status: 'active' | 'inactive';
}

interface RetailUser {
  id: string;
  email: string;
  display_name: string;
  role: 'OWNER' | 'MANAGER';
  status: 'active' | 'inactive';
  store_id: string;
  store_name: string;
}

interface RetailInvitation {
  id: string;
  invitee_email: string;
  role: string;
  store_id: string;
  store_name: string;
  status: string;
  expires_at: string;
  sent_at: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TIMEZONES = [
  { value: 'Asia/Kolkata',        label: 'India Standard Time (Asia/Kolkata)' },
  { value: 'America/Toronto',     label: 'Eastern Time - Canada (America/Toronto)' },
  { value: 'America/Winnipeg',    label: 'Central Time - Canada (America/Winnipeg)' },
  { value: 'America/Edmonton',    label: 'Mountain Time - Canada (America/Edmonton)' },
  { value: 'America/Vancouver',   label: 'Pacific Time - Canada (America/Vancouver)' },
  { value: 'America/Halifax',     label: 'Atlantic Time - Canada (America/Halifax)' },
  { value: 'America/St_Johns',    label: 'Newfoundland Time - Canada (America/St_Johns)' },
  { value: 'America/New_York',    label: 'Eastern Time - US (America/New_York)' },
  { value: 'America/Chicago',     label: 'Central Time - US (America/Chicago)' },
  { value: 'America/Denver',      label: 'Mountain Time - US (America/Denver)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time - US (America/Los_Angeles)' },
  { value: 'Europe/London',       label: 'UK Time (Europe/London)' },
  { value: 'UTC',                 label: 'Coordinated Universal Time (UTC)' },
];

const emptyStoreForm = {
  name: '', address: '', timezone: '',
  max_capacity: 100, warning_threshold: 45,
  status: 'active' as 'active' | 'inactive',
  manager_email: '', manager_name: '',
};

// ─── Main Component ───────────────────────────────────────────────────────────

export const RetailStoreManagement: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();

  // Auth
  const [isOwner, setIsOwner] = useState<boolean | null>(null);

  // Tabs
  const [activeSection, setActiveSection] = useState<'stores' | 'users'>('stores');

  // Stores state
  const [stores, setStores] = useState<RetailStore[]>([]);
  const [isLoadingStores, setIsLoadingStores] = useState(false);
  const [refreshingStores, setRefreshingStores] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingStore, setEditingStore] = useState<RetailStore | null>(null);
  const [storeForm, setStoreForm] = useState(emptyStoreForm);
  const [isSavingStore, setIsSavingStore] = useState(false);

  // Users state
  const [users, setUsers] = useState<RetailUser[]>([]);
  const [invitations, setInvitations] = useState<RetailInvitation[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [refreshingUsers, setRefreshingUsers] = useState(false);

  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [inviteForm, setInviteForm] = useState({ invitee_email: '', store_id: '' });
  const [isInviting, setIsInviting] = useState(false);
  const [lastInviteLink, setLastInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Shared confirm
  const [confirmConfig, setConfirmConfig] = useState<{
    title: string; description?: string; confirmText?: string; onConfirm: () => void | Promise<void>;
  } | null>(null);

  // ─── Auth check ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!accessToken) return;
    apiRequest<{ user: { role: string } }>(`${RETAIL_BASE}/settings/profile`, { accessToken, scopeHeaders })
      .then(r => setIsOwner(r.user?.role === 'OWNER'))
      .catch(() => setIsOwner(false));
  }, [accessToken, scopeHeaders]);

  // ─── Fetch stores ─────────────────────────────────────────────────────────────

  const fetchStores = useCallback(async (isManual = false) => {
    if (!accessToken) return;
    isManual ? setRefreshingStores(true) : setIsLoadingStores(true);
    try {
      const minDelay = isManual ? new Promise(r => setTimeout(r, 400)) : Promise.resolve();
      const [res] = await Promise.all([
        apiRequest<{ stores: RetailStore[] }>(`${RETAIL_BASE}/stores`, { accessToken, scopeHeaders, noCache: isManual }),
        minDelay,
      ]);
      setStores(res.stores || []);
    } catch {
      toast.error('Failed to load stores');
    } finally {
      setIsLoadingStores(false);
      setRefreshingStores(false);
    }
  }, [accessToken, scopeHeaders]);

  useEffect(() => { fetchStores(); }, [fetchStores]);

  // ─── Fetch users & invitations ────────────────────────────────────────────────

  const fetchUsers = useCallback(async (isManual = false) => {
    if (!accessToken || isOwner !== true) return;
    isManual ? setRefreshingUsers(true) : setIsLoadingUsers(true);
    try {
      const minDelay = isManual ? new Promise(r => setTimeout(r, 400)) : Promise.resolve();
      const [usersRes, invitesRes] = await Promise.all([
        apiRequest<{ users: RetailUser[] }>(`${RETAIL_BASE}/settings/users`, { accessToken, scopeHeaders, noCache: isManual }),
        apiRequest<{ invitations: RetailInvitation[] }>(`${RETAIL_BASE}/settings/invitations`, { accessToken, scopeHeaders, noCache: isManual }),
        minDelay,
      ]);
      setUsers(usersRes.users || []);
      setInvitations((invitesRes.invitations || []).filter(i => i.status === 'pending'));
    } catch {
      toast.error('Failed to load users');
    } finally {
      setIsLoadingUsers(false);
      setRefreshingUsers(false);
    }
  }, [accessToken, scopeHeaders, isOwner]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  // ─── Store actions ─────────────────────────────────────────────────────────

  const openCreate = () => {
    setEditingStore(null);
    setStoreForm(emptyStoreForm);
    setIsCreateModalOpen(true);
  };

  const openEdit = (store: RetailStore) => {
    setEditingStore(store);
    setStoreForm({
      name: store.name,
      address: store.address || '',
      timezone: store.timezone,
      max_capacity: store.max_capacity,
      warning_threshold: store.warning_threshold,
      status: store.status,
      manager_email: '',
      manager_name: '',
    });
    setIsEditModalOpen(true);
  };

  const handleCreateStore = async () => {
    if (!storeForm.name.trim()) return toast.error('Store name is required');
    if (storeForm.max_capacity < 1) return toast.error('Max capacity must be at least 1');

    setIsSavingStore(true);
    try {
      const storeRes = await apiRequest<{ store: RetailStore }>(`${RETAIL_BASE}/stores`, {
        method: 'POST', accessToken, scopeHeaders,
        body: JSON.stringify({
          name: storeForm.name.trim(),
          address: storeForm.address.trim() || null,
          timezone: storeForm.timezone,
          max_capacity: storeForm.max_capacity,
          warning_threshold: storeForm.warning_threshold,
        }),
      });
      const newStoreId = storeRes.store?.id;
      if (newStoreId && storeForm.manager_email.trim()) {
        try {
          await apiRequest(`${RETAIL_BASE}/settings/invitations`, {
            method: 'POST', accessToken, scopeHeaders,
            body: JSON.stringify({ invitee_email: storeForm.manager_email.trim(), store_id: newStoreId, role: 'MANAGER' }),
          });
          toast.success(`Store created & invitation sent to ${storeForm.manager_email}`);
        } catch {
          toast.success('Store created! (Manager invite could not be sent)');
        }
      } else {
        toast.success('Store created successfully!');
      }
      setIsCreateModalOpen(false);
      fetchStores(true);
      fetchUsers(true);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create store');
    } finally {
      setIsSavingStore(false);
    }
  };

  const handleUpdateStore = async () => {
    if (!editingStore || !storeForm.name.trim()) return toast.error('Store name is required');
    setIsSavingStore(true);
    try {
      await apiRequest(`${RETAIL_BASE}/stores/${editingStore.id}`, {
        method: 'PATCH', accessToken, scopeHeaders,
        body: JSON.stringify({
          name: storeForm.name.trim(),
          address: storeForm.address.trim() || null,
          timezone: storeForm.timezone,
          max_capacity: storeForm.max_capacity,
          warning_threshold: storeForm.warning_threshold,
          status: storeForm.status,
        }),
      });
      toast.success('Store updated!');
      setIsEditModalOpen(false);
      fetchStores(true);
    } catch (err: any) {
      toast.error(err.message || 'Failed to update store');
    } finally {
      setIsSavingStore(false);
    }
  };

  const toggleStoreStatus = (store: RetailStore) => {
    const next = store.status === 'active' ? 'inactive' : 'active';
    setConfirmConfig({
      title: `${next === 'inactive' ? 'Deactivate' : 'Reactivate'} "${store.name}"?`,
      description: next === 'inactive'
        ? 'This store will stop appearing as an active location. All historical data is preserved.'
        : 'This store will be reactivated and enabled across the portal.',
      confirmText: next === 'inactive' ? 'Deactivate' : 'Reactivate',
      onConfirm: async () => {
        try {
          await apiRequest(`${RETAIL_BASE}/stores/${store.id}`, {
            method: 'PATCH', accessToken, scopeHeaders, body: JSON.stringify({ status: next }),
          });
          toast.success(`Store ${next === 'inactive' ? 'deactivated' : 'reactivated'}`);
          fetchStores(true);
        } catch (err: any) {
          toast.error(err.message || 'Failed to update store status');
        }
      },
    });
  };

  const exportCSV = () => {
    if (!stores.length) return toast.error('No store data to export');
    const headers = ['Store Name', 'Location ID', 'Address', 'Timezone', 'Max Capacity', 'Status'];
    const rows = stores.map(s => [
      `"${s.name.replace(/"/g, '""')}"`,
      `"${s.id.substring(0, 8).toUpperCase()}"`,
      `"${(s.address || '').replace(/"/g, '""')}"`,
      `"${s.timezone}"`,
      s.max_capacity,
      s.status,
    ]);
    const csv = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const link = document.createElement('a');
    link.setAttribute('href', encodeURI(csv));
    link.setAttribute('download', `retail_stores_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    toast.success('Exported to CSV!');
  };

  const getManagerForStore = (storeId: string) => {
    const mgr = users.find(u => u.store_id === storeId && (u.role === 'MANAGER' || u.role === 'OWNER'));
    if (mgr) return mgr.display_name || mgr.email;
    const inv = invitations.find(i => i.store_id === storeId && i.status === 'pending');
    if (inv) return `${inv.invitee_email} (Pending)`;
    return 'Unassigned';
  };

  // ─── User actions ─────────────────────────────────────────────────────────

  const openInvite = () => {
    setInviteForm({ invitee_email: '', store_id: stores[0]?.id || '' });
    setLastInviteLink(null);
    setIsInviteOpen(true);
  };

  const sendInvite = async () => {
    if (!inviteForm.invitee_email.trim() || !/^\S+@\S+\.\S+$/.test(inviteForm.invitee_email)) {
      return toast.error('Enter a valid email address');
    }
    if (!inviteForm.store_id) return toast.error('Select a store');
    setIsInviting(true);
    try {
      const res = await apiRequest<{ setup_link: string; email_sent: boolean }>(`${RETAIL_BASE}/settings/invitations`, {
        method: 'POST', accessToken, scopeHeaders, body: JSON.stringify({ ...inviteForm, role: 'MANAGER' }),
      });
      toast.success(res.email_sent ? 'Invitation email sent!' : 'Invitation created — copy the link below');
      setLastInviteLink(res.setup_link);
      fetchUsers(true);
    } catch (err: any) {
      toast.error(err.message || 'Failed to send invitation');
    } finally {
      setIsInviting(false);
    }
  };

  const copyLink = () => {
    if (!lastInviteLink) return;
    navigator.clipboard.writeText(lastInviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const revokeInvite = (inv: RetailInvitation) => {
    setConfirmConfig({
      title: `Revoke invitation for "${inv.invitee_email}"?`,
      description: 'This link will stop working immediately.',
      confirmText: 'Revoke',
      onConfirm: async () => {
        try {
          await apiRequest(`${RETAIL_BASE}/settings/invitations/${inv.id}`, { method: 'DELETE', accessToken, scopeHeaders });
          toast.success('Invitation revoked');
          setInvitations(prev => prev.filter(i => i.id !== inv.id));
        } catch (err: any) {
          toast.error(err.message || 'Failed to revoke invitation');
        }
      },
    });
  };

  const toggleUserStatus = (user: RetailUser) => {
    const next = user.status === 'active' ? 'inactive' : 'active';
    setConfirmConfig({
      title: `${next === 'inactive' ? 'Deactivate' : 'Reactivate'} ${user.display_name}?`,
      description: next === 'inactive' ? 'They will lose access to their store.' : 'They will regain access.',
      confirmText: next === 'inactive' ? 'Deactivate' : 'Reactivate',
      onConfirm: async () => {
        try {
          await apiRequest(`${RETAIL_BASE}/settings/users/${user.id}`, {
            method: 'PATCH', accessToken, scopeHeaders, body: JSON.stringify({ status: next }),
          });
          toast.success(`${user.display_name} ${next === 'inactive' ? 'deactivated' : 'reactivated'}`);
          setUsers(prev => prev.map(u => u.id === user.id ? { ...u, status: next } : u));
        } catch (err: any) {
          toast.error(err.message || 'Failed to update user');
        }
      },
    });
  };

  const reassignStore = async (user: RetailUser, storeId: string) => {
    try {
      await apiRequest(`${RETAIL_BASE}/settings/users/${user.id}`, {
        method: 'PATCH', accessToken, scopeHeaders, body: JSON.stringify({ store_id: storeId }),
      });
      const storeName = stores.find(s => s.id === storeId)?.name || '';
      toast.success(`${user.display_name} reassigned to ${storeName}`);
      setUsers(prev => prev.map(u => u.id === user.id ? { ...u, store_id: storeId, store_name: storeName } : u));
    } catch (err: any) {
      toast.error(err.message || 'Failed to reassign store');
    }
  };

  // ─── Derived ──────────────────────────────────────────────────────────────

  const filtered = stores.filter(s =>
    s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (s.address || '').toLowerCase().includes(searchTerm.toLowerCase())
  );
  const activeCount = stores.filter(s => s.status === 'active').length;
  const inactiveCount = stores.filter(s => s.status === 'inactive').length;

  // ─── Guard ────────────────────────────────────────────────────────────────

  if (isOwner === false) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
        <ShieldAlert className="w-8 h-8 text-rose-500" />
        <p className="text-sm font-semibold text-muted-foreground">Only the store Owner can administer branches.</p>
      </div>
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 pb-16">

      {/* Page header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-foreground">Manage Stores</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Overview and administration of all registered retail locations and their users.</p>
        </div>
        <div className="flex items-center gap-3">
          {activeSection === 'stores' && (
            <div className="relative flex-1 md:w-64">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search stores..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-3 py-1.5 text-xs rounded-xl border border-border bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              />
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => activeSection === 'stores' ? fetchStores(true) : fetchUsers(true)}
            disabled={isLoadingStores || refreshingStores || isLoadingUsers || refreshingUsers}
            className="gap-2 rounded-xl"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', (refreshingStores || refreshingUsers) && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-card border border-border rounded-2xl p-5 flex flex-col gap-2">
          <div className="flex justify-between items-start">
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Total Stores</p>
            <div className="p-2 rounded-xl bg-primary/10 text-primary"><Building2 className="w-4 h-4" /></div>
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <h3 className="text-3xl font-black font-mono text-foreground">{stores.length}</h3>
            <span className="text-[10px] font-bold text-emerald-600 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">Locations</span>
          </div>
        </div>
        <div className="bg-card border border-border rounded-2xl p-5 flex flex-col gap-2">
          <div className="flex justify-between items-start">
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Active</p>
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-500"><Radio className="w-4 h-4" /></div>
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <h3 className="text-3xl font-black font-mono text-foreground">{activeCount}</h3>
            <span className="text-[10px] font-bold text-emerald-600 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">Online</span>
          </div>
        </div>
        <div className="bg-card border border-border rounded-2xl p-5 flex flex-col gap-2">
          <div className="flex justify-between items-start">
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Inactive</p>
            <div className="p-2 rounded-xl bg-rose-500/10 text-rose-500"><MapPinOff className="w-4 h-4" /></div>
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <h3 className="text-3xl font-black font-mono text-foreground">{inactiveCount}</h3>
            {inactiveCount > 0 && <span className="text-[10px] font-bold text-rose-600 bg-rose-500/10 px-2 py-0.5 rounded-full border border-rose-500/20">Paused</span>}
          </div>
        </div>
        <div className="bg-card border border-border rounded-2xl p-5 flex flex-col gap-2">
          <div className="flex justify-between items-start">
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Users</p>
            <div className="p-2 rounded-xl bg-violet-500/10 text-violet-500"><Users className="w-4 h-4" /></div>
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <h3 className="text-3xl font-black font-mono text-foreground">{users.length}</h3>
            {invitations.length > 0 && <span className="text-[10px] font-bold text-amber-600 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20">{invitations.length} pending</span>}
          </div>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 bg-muted/40 border border-border rounded-2xl p-1 w-fit">
        <button
          onClick={() => setActiveSection('stores')}
          className={cn(
            'px-5 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2',
            activeSection === 'stores'
              ? 'bg-card text-foreground shadow-sm border border-border'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <StoreIcon className="w-3.5 h-3.5" /> Locations
        </button>
        <button
          onClick={() => setActiveSection('users')}
          className={cn(
            'px-5 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2',
            activeSection === 'users'
              ? 'bg-card text-foreground shadow-sm border border-border'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Users className="w-3.5 h-3.5" /> Users & Access
          {invitations.length > 0 && (
            <span className="text-[10px] font-black bg-amber-500 text-white px-1.5 py-0.5 rounded-full">
              {invitations.length}
            </span>
          )}
        </button>
      </div>

      {/* ── Stores tab ─────────────────────────────────────────────────── */}
      {activeSection === 'stores' && (
        <div className="bg-card border border-border rounded-2xl overflow-hidden flex flex-col">
          <div className="p-4 px-6 border-b border-border bg-muted/30 flex flex-wrap justify-between items-center gap-3">
            <h3 className="text-sm font-bold text-foreground">Registered Locations</h3>
            <div className="flex items-center gap-3 ml-auto">
              <button
                onClick={exportCSV}
                className="text-xs font-bold text-primary hover:underline flex items-center gap-1.5 px-3 py-1.5 rounded-xl hover:bg-primary/5 transition-colors cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" /> Export CSV
              </button>
              <button
                disabled
                title="Store creation is coming soon"
                className="bg-primary text-primary-foreground font-bold text-xs px-4 py-2 rounded-xl flex items-center gap-1.5 opacity-50 cursor-not-allowed"
              >
                <Plus className="w-4 h-4" /> Create New Store
              </button>
              <span className="text-[10px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full bg-amber-100 text-amber-700 border border-amber-200">
                Coming Soon
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-muted/40 border-b border-border text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  <th className="py-3 px-6">Store Name</th>
                  <th className="py-3 px-6">Location ID</th>
                  <th className="py-3 px-6">Manager</th>
                  <th className="py-3 px-6">Status</th>
                  <th className="py-3 px-6 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="text-xs font-medium divide-y divide-border/60">
                {isLoadingStores && !refreshingStores ? (
                  <tr>
                    <td colSpan={5} className="text-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin text-primary mx-auto mb-2" />
                      <span className="text-muted-foreground font-semibold">Loading stores...</span>
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center py-12 text-muted-foreground">No store locations found.</td>
                  </tr>
                ) : (
                  filtered.map(s => {
                    const isInactive = s.status === 'inactive';
                    return (
                      <tr key={s.id} className={cn('hover:bg-muted/30 transition-colors group', isInactive && 'bg-rose-500/5')}>
                        <td className="py-3.5 px-6">
                          <div className="flex items-center gap-3">
                            <div className={cn(
                              'w-8 h-8 rounded-xl flex items-center justify-center shrink-0 border',
                              isInactive ? 'bg-rose-500/10 border-rose-500/20 text-rose-500' : 'bg-primary/10 border-primary/20 text-primary'
                            )}>
                              <StoreIcon className="w-4 h-4" />
                            </div>
                            <div>
                              <p className="font-bold text-foreground">{s.name}</p>
                              {s.address && (
                                <p className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
                                  <MapPin className="w-3 h-3 shrink-0" />{s.address}
                                </p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="py-3.5 px-6 font-mono font-bold text-muted-foreground">{s.id.substring(0, 8).toUpperCase()}</td>
                        <td className="py-3.5 px-6 font-semibold text-foreground">
                          <div className="flex items-center gap-1.5">
                            <User className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                            {getManagerForStore(s.id)}
                          </div>
                        </td>
                        <td className="py-3.5 px-6">
                          {isInactive ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400 text-[10px] font-black uppercase tracking-wider border border-rose-500/20">
                              <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" /> Inactive
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-black uppercase tracking-wider border border-emerald-500/20">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Active
                            </span>
                          )}
                        </td>
                        <td className="py-3.5 px-6 text-right">
                          <div className="flex items-center justify-end gap-2 opacity-80 group-hover:opacity-100 transition-opacity">
                            <button onClick={() => openEdit(s)} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-primary transition-colors cursor-pointer" title="Edit">
                              <Edit className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => toggleStoreStatus(s)}
                              className={cn('p-1.5 rounded-lg hover:bg-muted transition-colors cursor-pointer', isInactive ? 'text-emerald-500' : 'text-rose-500')}
                              title={isInactive ? 'Reactivate' : 'Deactivate'}
                            >
                              <MapPinOff className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <div className="p-4 px-6 bg-muted/20 border-t border-border text-xs font-semibold text-muted-foreground">
            Showing {filtered.length} of {stores.length} store locations
          </div>
        </div>
      )}

      {/* ── Users tab ──────────────────────────────────────────────────── */}
      {activeSection === 'users' && (
        <div className="space-y-5">

          {/* Active users table */}
          <div className="bg-card border border-border rounded-2xl overflow-hidden">
            <div className="p-4 px-6 border-b border-border bg-muted/30 flex justify-between items-center">
              <h3 className="text-sm font-bold text-foreground">Active Users</h3>
              <button
                onClick={openInvite}
                className="bg-primary text-primary-foreground font-bold text-xs px-4 py-2 rounded-xl hover:opacity-90 active:scale-95 transition-all flex items-center gap-1.5 cursor-pointer"
              >
                <UserPlus className="w-4 h-4" /> Invite Manager
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-muted/40 border-b border-border text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    <th className="py-3 px-6">Name</th>
                    <th className="py-3 px-6">Email</th>
                    <th className="py-3 px-6">Role</th>
                    <th className="py-3 px-6">Assigned Store</th>
                    <th className="py-3 px-6">Status</th>
                    <th className="py-3 px-6 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="text-xs font-medium divide-y divide-border/60">
                  {isLoadingUsers && !refreshingUsers ? (
                    <tr><td colSpan={6} className="text-center py-12"><Loader2 className="w-6 h-6 animate-spin text-primary mx-auto mb-2" /></td></tr>
                  ) : users.length === 0 ? (
                    <tr><td colSpan={6} className="text-center py-10 text-muted-foreground">No users yet. Invite a branch manager to get started.</td></tr>
                  ) : (
                    users.map(u => (
                      <tr key={u.id} className="hover:bg-muted/30 transition-colors">
                        <td className="py-3.5 px-6">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-black text-xs border border-primary/20">
                              {(u.display_name || u.email)[0].toUpperCase()}
                            </div>
                            <span className="font-bold text-foreground">{u.display_name || '—'}</span>
                          </div>
                        </td>
                        <td className="py-3.5 px-6 text-muted-foreground">{u.email}</td>
                        <td className="py-3.5 px-6">
                          <span className={cn(
                            'inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider border',
                            u.role === 'OWNER'
                              ? 'bg-violet-500/10 text-violet-600 border-violet-500/20'
                              : 'bg-blue-500/10 text-blue-600 border-blue-500/20'
                          )}>
                            {u.role}
                          </span>
                        </td>
                        <td className="py-3.5 px-6">
                          {u.role === 'OWNER' ? (
                            <span className="text-muted-foreground">{u.store_name || '—'}</span>
                          ) : (
                            <Select value={u.store_id} onValueChange={v => reassignStore(u, v)}>
                              <SelectTrigger className="w-44 h-7 text-xs rounded-lg border-border"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {stores.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          )}
                        </td>
                        <td className="py-3.5 px-6">
                          {u.status === 'active' ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-600 text-[10px] font-black uppercase tracking-wider border border-emerald-500/20">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-500/10 text-slate-500 text-[10px] font-black uppercase tracking-wider border border-slate-500/20">
                              <span className="w-1.5 h-1.5 rounded-full bg-slate-400" /> Inactive
                            </span>
                          )}
                        </td>
                        <td className="py-3.5 px-6 text-right">
                          {u.role !== 'OWNER' && (
                            <button
                              onClick={() => toggleUserStatus(u)}
                              className={cn(
                                'text-xs font-bold px-3 py-1.5 rounded-lg border transition-colors cursor-pointer',
                                u.status === 'active'
                                  ? 'text-rose-600 border-rose-500/20 hover:bg-rose-500/10'
                                  : 'text-emerald-600 border-emerald-500/20 hover:bg-emerald-500/10'
                              )}
                            >
                              {u.status === 'active' ? 'Deactivate' : 'Reactivate'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pending invitations table */}
          <div className="bg-card border border-border rounded-2xl overflow-hidden">
            <div className="p-4 px-6 border-b border-border bg-muted/30 flex justify-between items-center">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-foreground">Pending Invitations</h3>
                {invitations.length > 0 && (
                  <span className="text-[10px] font-black bg-amber-500 text-white px-2 py-0.5 rounded-full">{invitations.length}</span>
                )}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-muted/40 border-b border-border text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    <th className="py-3 px-6">Email</th>
                    <th className="py-3 px-6">Assigned Store</th>
                    <th className="py-3 px-6">Sent</th>
                    <th className="py-3 px-6">Expires</th>
                    <th className="py-3 px-6 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="text-xs font-medium divide-y divide-border/60">
                  {invitations.length === 0 ? (
                    <tr><td colSpan={5} className="text-center py-10 text-muted-foreground">No pending invitations.</td></tr>
                  ) : (
                    invitations.map(inv => (
                      <tr key={inv.id} className="hover:bg-muted/30 transition-colors">
                        <td className="py-3.5 px-6 font-semibold text-foreground">
                          <div className="flex items-center gap-2">
                            <Mail className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                            {inv.invitee_email}
                          </div>
                        </td>
                        <td className="py-3.5 px-6 text-muted-foreground">{inv.store_name}</td>
                        <td className="py-3.5 px-6 text-muted-foreground">{new Date(inv.sent_at).toLocaleDateString()}</td>
                        <td className="py-3.5 px-6 text-muted-foreground">
                          <div className="flex items-center gap-1.5">
                            <Clock className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
                            {new Date(inv.expires_at).toLocaleDateString()}
                          </div>
                        </td>
                        <td className="py-3.5 px-6 text-right">
                          <button
                            onClick={() => revokeInvite(inv)}
                            className="text-xs font-bold px-3 py-1.5 rounded-lg border border-rose-500/20 text-rose-600 hover:bg-rose-500/10 transition-colors cursor-pointer flex items-center gap-1.5 ml-auto"
                          >
                            <X className="w-3.5 h-3.5" /> Revoke
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Create Store Modal ────────────────────────────────────────── */}
      <Dialog open={isCreateModalOpen} onOpenChange={setIsCreateModalOpen}>
        <DialogContent className="max-w-xl rounded-2xl p-6">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold">Provision New Store</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">Register a new branch and optionally invite a branch manager.</DialogDescription>
          </DialogHeader>
          <div className="space-y-5 mt-3">
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-foreground">
                <StoreIcon className="w-4 h-4 text-primary" /> Store Details
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div><Label className="text-xs font-semibold">Branch Name <span className="text-rose-500">*</span></Label>
                  <Input placeholder="e.g. Manhattan Flagship" value={storeForm.name} onChange={e => setStoreForm({ ...storeForm, name: e.target.value })} className="text-xs mt-1" /></div>
                <div><Label className="text-xs font-semibold">Address / City</Label>
                  <Input placeholder="New York, NY" value={storeForm.address} onChange={e => setStoreForm({ ...storeForm, address: e.target.value })} className="text-xs mt-1" /></div>
                <div><Label className="text-xs font-semibold">Max Capacity</Label>
                  <Input type="number" min={1} value={storeForm.max_capacity} onChange={e => setStoreForm({ ...storeForm, max_capacity: Number(e.target.value) })} className="text-xs mt-1" /></div>
                <div><Label className="text-xs font-semibold">Warning Threshold</Label>
                  <Input type="number" min={1} value={storeForm.warning_threshold} onChange={e => setStoreForm({ ...storeForm, warning_threshold: Number(e.target.value) })} className="text-xs mt-1" /></div>
                <div className="md:col-span-2"><Label className="text-xs font-semibold">Timezone</Label>
                  <Select value={storeForm.timezone} onValueChange={v => setStoreForm({ ...storeForm, timezone: v })}>
                    <SelectTrigger className="text-xs mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>{TIMEZONES.map(tz => <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>)}</SelectContent>
                  </Select></div>
              </div>
            </div>
            <hr className="border-border" />
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-foreground">
                <User className="w-4 h-4 text-primary" /> Manager Provisioning <span className="normal-case font-normal text-muted-foreground">(optional)</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div><Label className="text-xs font-semibold">Manager Email</Label>
                  <Input type="email" placeholder="manager@store.com" value={storeForm.manager_email} onChange={e => setStoreForm({ ...storeForm, manager_email: e.target.value })} className="text-xs mt-1" /></div>
                <div><Label className="text-xs font-semibold">Manager Name</Label>
                  <Input placeholder="John Doe" value={storeForm.manager_name} onChange={e => setStoreForm({ ...storeForm, manager_name: e.target.value })} className="text-xs mt-1" /></div>
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-3 border-t">
              <Button variant="outline" onClick={() => setIsCreateModalOpen(false)} className="rounded-xl">Cancel</Button>
              <Button onClick={handleCreateStore} disabled={isSavingStore} className="gap-2 rounded-xl">
                {isSavingStore ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Create Store
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Edit Store Modal ──────────────────────────────────────────── */}
      <Dialog open={isEditModalOpen} onOpenChange={setIsEditModalOpen}>
        <DialogContent className="max-w-md rounded-2xl p-6">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold">Edit Store</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">Update details for {editingStore?.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-3">
            <div><Label className="text-xs font-semibold">Branch Name <span className="text-rose-500">*</span></Label>
              <Input value={storeForm.name} onChange={e => setStoreForm({ ...storeForm, name: e.target.value })} className="text-xs mt-1" /></div>
            <div><Label className="text-xs font-semibold">Address / City</Label>
              <Input value={storeForm.address} onChange={e => setStoreForm({ ...storeForm, address: e.target.value })} className="text-xs mt-1" /></div>
            <div><Label className="text-xs font-semibold">Timezone</Label>
              <Select value={storeForm.timezone} onValueChange={v => setStoreForm({ ...storeForm, timezone: v })}>
                <SelectTrigger className="text-xs mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>{TIMEZONES.map(tz => <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>)}</SelectContent>
              </Select></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs font-semibold">Max Capacity</Label>
                <Input type="number" min={1} value={storeForm.max_capacity} onChange={e => setStoreForm({ ...storeForm, max_capacity: Number(e.target.value) })} className="text-xs mt-1" /></div>
              <div><Label className="text-xs font-semibold">Warning Threshold</Label>
                <Input type="number" min={1} value={storeForm.warning_threshold} onChange={e => setStoreForm({ ...storeForm, warning_threshold: Number(e.target.value) })} className="text-xs mt-1" /></div>
            </div>
            <div><Label className="text-xs font-semibold">Status</Label>
              <Select value={storeForm.status} onValueChange={(v: 'active' | 'inactive') => setStoreForm({ ...storeForm, status: v })}>
                <SelectTrigger className="text-xs mt-1"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="active">Active</SelectItem><SelectItem value="inactive">Inactive</SelectItem></SelectContent>
              </Select></div>
            <div className="flex justify-end gap-3 pt-3 border-t">
              <Button variant="outline" onClick={() => setIsEditModalOpen(false)} className="rounded-xl">Cancel</Button>
              <Button onClick={handleUpdateStore} disabled={isSavingStore} className="gap-2 rounded-xl">
                {isSavingStore ? <Loader2 className="w-4 h-4 animate-spin" /> : <Edit className="w-4 h-4" />}
                Update Store
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Invite Manager Modal ──────────────────────────────────────── */}
      <Dialog open={isInviteOpen} onOpenChange={setIsInviteOpen}>
        <DialogContent className="max-w-md rounded-2xl p-6">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold">Invite Branch Manager</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">They'll receive a link to set their password and log in.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-3">
            <div><Label className="text-xs font-semibold">Manager Email <span className="text-rose-500">*</span></Label>
              <Input type="email" placeholder="manager@example.com" value={inviteForm.invitee_email}
                onChange={e => setInviteForm({ ...inviteForm, invitee_email: e.target.value })} className="text-xs mt-1" /></div>
            <div><Label className="text-xs font-semibold">Assign to Store <span className="text-rose-500">*</span></Label>
              <Select value={inviteForm.store_id} onValueChange={v => setInviteForm({ ...inviteForm, store_id: v })}>
                <SelectTrigger className="text-xs mt-1"><SelectValue placeholder="Select a store" /></SelectTrigger>
                <SelectContent>{stores.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
              </Select></div>
            {lastInviteLink && (
              <div className="rounded-xl border border-border p-3 bg-muted/40 space-y-2">
                <p className="text-[10px] font-bold text-muted-foreground uppercase">Invite Link</p>
                <div className="flex items-center gap-2">
                  <Input readOnly value={lastInviteLink} className="text-xs" />
                  <Button size="sm" variant="outline" onClick={copyLink} className="shrink-0 gap-1">
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                  </Button>
                </div>
              </div>
            )}
            <div className="flex justify-end gap-3 pt-3 border-t">
              <Button variant="outline" onClick={() => setIsInviteOpen(false)} className="rounded-xl">Close</Button>
              <Button onClick={sendInvite} disabled={isInviting} className="gap-2 rounded-xl">
                {isInviting ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                {lastInviteLink ? 'Resend' : 'Send Invite'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Confirm modal ─────────────────────────────────────────────── */}
      {confirmConfig && (
        <ConfirmModal
          isOpen={true}
          onClose={() => setConfirmConfig(null)}
          title={confirmConfig.title}
          description={confirmConfig.description}
          confirmText={confirmConfig.confirmText || 'Confirm'}
          variant="default"
          onConfirm={confirmConfig.onConfirm}
        />
      )}
    </div>
  );
};

export default RetailStoreManagement;
