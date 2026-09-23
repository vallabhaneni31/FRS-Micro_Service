import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '../../ui/card';
import { Button } from '../../ui/button';
import { ConfirmModal } from '../../ui/confirm-modal';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Badge } from '../../ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../../ui/table';
import {
  Users, UserPlus, Loader2, RefreshCw, Mail, Clock, X, ShieldAlert, Copy, Check,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../../ui/utils';
import { useAuth } from '../../../contexts/AuthContext';
import { apiRequest } from '../../../services/http/apiClient';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';
import { PageHeader } from '../../shared/PageHeader';

const RETAIL_BASE = '/v1/retail';

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

interface RetailStore { id: string; name: string; }

const RoleBadge = ({ role }: { role: string }) => (
  <Badge className={cn('border px-2 py-1',
    role === 'OWNER' ? 'bg-violet-100 text-violet-700 border-violet-200' : 'bg-blue-100 text-blue-700 border-blue-200')}>
    {role}
  </Badge>
);

const StatusBadge = ({ status }: { status: string }) => {
  const colors: Record<string, string> = {
    active: 'bg-green-100 text-green-700 border-green-200',
    inactive: 'bg-slate-100 text-slate-600 border-slate-200',
    pending: 'bg-amber-100 text-amber-700 border-amber-200',
    accepted: 'bg-green-100 text-green-700 border-green-200',
    revoked: 'bg-slate-100 text-slate-600 border-slate-200',
    expired: 'bg-rose-100 text-rose-700 border-rose-200',
  };
  return (
    <Badge className={cn('border px-2 py-1', colors[status] || colors.inactive)}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  );
};

export const RetailUserManagement: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();

  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [users, setUsers] = useState<RetailUser[]>([]);
  const [invitations, setInvitations] = useState<RetailInvitation[]>([]);
  const [stores, setStores] = useState<RetailStore[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [inviteForm, setInviteForm] = useState({ invitee_email: '', store_id: '' });
  const [isInviting, setIsInviting] = useState(false);
  const [lastInviteLink, setLastInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [confirmConfig, setConfirmConfig] = useState<{
    title: string; description?: string; confirmText?: string; onConfirm: () => void | Promise<void>;
  } | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    apiRequest<{ user: { role: string } }>(`${RETAIL_BASE}/settings/profile`, { accessToken, scopeHeaders })
      .then(r => setIsOwner(r.user?.role === 'OWNER'))
      .catch(() => setIsOwner(false));
  }, [accessToken]);

  const fetchAll = useCallback(async (isManual = false) => {
    if (!accessToken || isOwner !== true) return;
    isManual ? setRefreshing(true) : setIsLoading(true);
    try {
      const minDelay = isManual ? new Promise(r => setTimeout(r, 500)) : Promise.resolve();
      const [usersRes, invitesRes, storesRes] = await Promise.all([
        apiRequest<{ users: RetailUser[] }>(`${RETAIL_BASE}/settings/users`, { accessToken, scopeHeaders, noCache: isManual }),
        apiRequest<{ invitations: RetailInvitation[] }>(`${RETAIL_BASE}/settings/invitations`, { accessToken, scopeHeaders, noCache: isManual }),
        apiRequest<{ stores: RetailStore[] }>(`${RETAIL_BASE}/stores`, { accessToken, scopeHeaders, noCache: isManual }),
        minDelay,
      ]);
      setUsers(usersRes.users || []);
      setInvitations((invitesRes.invitations || []).filter(i => i.status === 'pending'));
      setStores(storesRes.stores || []);
    } catch {
      toast.error('Failed to load users');
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  }, [accessToken, scopeHeaders, isOwner]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const openInvite = () => {
    setInviteForm({ invitee_email: '', store_id: stores[0]?.id || '' });
    setLastInviteLink(null);
    setIsInviteOpen(true);
  };

  const sendInvite = async () => {
    if (!inviteForm.invitee_email.trim() || !/^\S+@\S+\.\S+$/.test(inviteForm.invitee_email)) {
      return toast.error('Enter a valid email address');
    }
    if (!inviteForm.store_id) return toast.error('Select a store to assign this manager to');

    setIsInviting(true);
    try {
      const res = await apiRequest<{ setup_link: string; email_sent: boolean }>(`${RETAIL_BASE}/settings/invitations`, {
        method: 'POST', accessToken, scopeHeaders, body: JSON.stringify(inviteForm),
      });
      toast.success(res.email_sent ? 'Invitation email sent!' : 'Invitation created — share the link below (email delivery unavailable)');
      setLastInviteLink(res.setup_link);
      fetchAll();
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

  const revokeInvite = (invite: RetailInvitation) => {
    setConfirmConfig({
      title: `Revoke invitation for "${invite.invitee_email}"?`,
      description: 'This link will stop working immediately.',
      confirmText: 'Revoke',
      onConfirm: async () => {
        try {
          await apiRequest(`${RETAIL_BASE}/settings/invitations/${invite.id}`, { method: 'DELETE', accessToken, scopeHeaders });
          toast.success('Invitation revoked');
          setInvitations(prev => prev.filter(i => i.id !== invite.id));
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
      description: next === 'inactive'
        ? 'They will no longer be able to access this store\'s data.'
        : 'They will regain access to their assigned store.',
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

  if (isOwner === false) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
        <ShieldAlert className="w-8 h-8 text-muted-foreground/60" />
        <p className="text-sm font-semibold text-muted-foreground">Only the store Owner can manage users.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 pb-16">
      <PageHeader
        title="User Management"
        icon={Users}
        subtitle="Invite branch managers and manage who has access to your stores"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => fetchAll(true)} disabled={isLoading || refreshing} className="gap-2">
              <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} /> Refresh
            </Button>
            <Button onClick={openInvite} className="gap-2">
              <UserPlus className="w-4 h-4" /> Invite Manager
            </Button>
          </div>
        }
      />

      {isLoading && !refreshing ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : (
        <>
          <Card>
            <CardContent className="p-6">
              <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground/80 mb-4">Active Users</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Store</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No users yet</TableCell></TableRow>
                  ) : users.map(user => (
                    <TableRow key={user.id}>
                      <TableCell className="font-semibold">{user.display_name}</TableCell>
                      <TableCell className="text-muted-foreground">{user.email}</TableCell>
                      <TableCell><RoleBadge role={user.role} /></TableCell>
                      <TableCell>
                        {user.role === 'OWNER' ? (
                          <span className="text-muted-foreground">{user.store_name}</span>
                        ) : (
                          <Select value={user.store_id} onValueChange={v => reassignStore(user, v)}>
                            <SelectTrigger className="w-44 h-8 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {stores.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        )}
                      </TableCell>
                      <TableCell><StatusBadge status={user.status} /></TableCell>
                      <TableCell className="text-right">
                        {user.role !== 'OWNER' && (
                          <Button size="sm" variant="outline" onClick={() => toggleUserStatus(user)}>
                            {user.status === 'active' ? 'Deactivate' : 'Reactivate'}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground/80 mb-4">Pending Invitations</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Store</TableHead>
                    <TableHead>Sent</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invitations.length === 0 ? (
                    <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No pending invitations</TableCell></TableRow>
                  ) : invitations.map(inv => (
                    <TableRow key={inv.id}>
                      <TableCell className="font-semibold flex items-center gap-1.5">
                        <Mail className="w-3.5 h-3.5 text-muted-foreground" /> {inv.invitee_email}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{inv.store_name}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">{new Date(inv.sent_at).toLocaleDateString()}</TableCell>
                      <TableCell className="text-muted-foreground text-xs flex items-center gap-1">
                        <Clock className="w-3 h-3" /> {new Date(inv.expires_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" onClick={() => revokeInvite(inv)} className="gap-1">
                          <X className="w-3 h-3" /> Revoke
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      <Dialog open={isInviteOpen} onOpenChange={setIsInviteOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Invite Branch Manager</DialogTitle>
            <DialogDescription>They'll get an email with a link to set their password and log in.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <Label>Email <span className="text-rose-500">*</span></Label>
              <Input type="email" placeholder="manager@example.com" value={inviteForm.invitee_email}
                onChange={e => setInviteForm({ ...inviteForm, invitee_email: e.target.value })} />
            </div>
            <div>
              <Label>Assign to Store <span className="text-rose-500">*</span></Label>
              <Select value={inviteForm.store_id} onValueChange={v => setInviteForm({ ...inviteForm, store_id: v })}>
                <SelectTrigger><SelectValue placeholder="Select a store" /></SelectTrigger>
                <SelectContent>
                  {stores.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {lastInviteLink && (
              <div className="rounded-xl border p-3 bg-muted/40 space-y-2">
                <p className="text-[11px] font-bold text-muted-foreground uppercase">Invite Link</p>
                <div className="flex items-center gap-2">
                  <Input readOnly value={lastInviteLink} className="text-xs" />
                  <Button size="sm" variant="outline" onClick={copyLink} className="shrink-0 gap-1">
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  </Button>
                </div>
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <Button variant="outline" onClick={() => setIsInviteOpen(false)} className="flex-1">Close</Button>
              <Button onClick={sendInvite} disabled={isInviting} className="flex-1 gap-2">
                {isInviting ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                {lastInviteLink ? 'Resend' : 'Send Invite'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

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

export default RetailUserManagement;
