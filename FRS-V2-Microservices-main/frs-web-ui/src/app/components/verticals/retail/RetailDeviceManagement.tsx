import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '../../ui/card';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Badge } from '../../ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';
import {
  Cpu, Plus, RefreshCw, Loader2, Copy, Check, AlertTriangle, ShieldAlert, Radio,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../../ui/utils';
import { useAuth } from '../../../contexts/AuthContext';
import { apiRequest } from '../../../services/http/apiClient';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';
import { useGlobalRetailStore } from '../../../hooks/useGlobalRetailStore';
import { PageHeader } from '../../shared/PageHeader';

const RETAIL_BASE = '/v1/retail';
const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes, matches corporate DeviceManagement.tsx default

interface RetailDevice {
  id: string;
  external_id: string;
  status: string;
  last_heartbeat: string | null;
  created_at: string;
}

interface RetailStore { id: string; name: string; }

function effectiveStatus(status: string, lastHeartbeat: string | null) {
  if (status === 'error') return 'error';
  if (!lastHeartbeat) return status === 'online' ? 'online' : 'offline';
  const staleSince = Date.now() - new Date(lastHeartbeat).getTime();
  if (staleSince > OFFLINE_THRESHOLD_MS) return 'offline';
  return status === 'online' ? 'online' : 'offline';
}

const DeviceStatusBadge = ({ status, lastHeartbeat }: { status: string; lastHeartbeat: string | null }) => {
  const resolved = effectiveStatus(status, lastHeartbeat);
  const colors: Record<string, string> = {
    online: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
    offline: 'bg-slate-500/10 text-slate-600 border-slate-500/20',
    error: 'bg-rose-500/10 text-rose-600 border-rose-500/20',
  };
  return <Badge className={cn('font-bold px-2 py-0.5 border', colors[resolved])}>{resolved.toUpperCase()}</Badge>;
};

export const RetailDeviceManagement: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const { selectedStoreId: globalStoreId, setSelectedStoreId: setGlobalStoreId } = useGlobalRetailStore();

  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [stores, setStores] = useState<RetailStore[]>([]);
  const [storeId, setStoreId] = useState<string>('');
  const [devices, setDevices] = useState<RetailDevice[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [isRegisterOpen, setIsRegisterOpen] = useState(false);
  const [externalId, setExternalId] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!accessToken) return;
    apiRequest<{ user: { role: string } }>(`${RETAIL_BASE}/settings/profile`, { accessToken, scopeHeaders })
      .then(r => setIsOwner(r.user?.role === 'OWNER'))
      .catch(() => setIsOwner(false));
    apiRequest<{ stores: RetailStore[] }>(`${RETAIL_BASE}/stores`, { accessToken, scopeHeaders })
      .then(r => {
        setStores(r.stores || []);
        if (globalStoreId && globalStoreId !== 'all') {
          setStoreId(globalStoreId);
        } else if (r.stores?.length) {
          setStoreId(r.stores[0].id);
        }
      })
      .catch(() => {});
  }, [accessToken, scopeHeaders, globalStoreId]);

  const fetchDevices = useCallback(async (isManual = false) => {
    if (!accessToken || !storeId) return;
    isManual ? setRefreshing(true) : setIsLoading(true);
    try {
      const res = await apiRequest<{ devices: RetailDevice[] }>(
        `${RETAIL_BASE}/devices?store_id=${storeId}`, { accessToken, scopeHeaders, noCache: true }
      );
      setDevices(res.devices || []);
    } catch {
      toast.error('Failed to load devices');
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  }, [accessToken, scopeHeaders, storeId]);

  useEffect(() => {
    fetchDevices();
    const interval = setInterval(() => fetchDevices(), 30_000);
    return () => clearInterval(interval);
  }, [fetchDevices]);

  const openRegister = () => { setExternalId(''); setIssuedToken(null); setIsRegisterOpen(true); };

  const registerDevice = async () => {
    if (!externalId.trim()) return toast.error('Device ID is required');
    if (!storeId) return toast.error('Select a store first');

    setIsRegistering(true);
    try {
      const res = await apiRequest<{ token: string }>(`${RETAIL_BASE}/devices/register`, {
        method: 'POST', accessToken, scopeHeaders, body: JSON.stringify({ store_id: storeId, external_id: externalId.trim() }),
      });
      setIssuedToken(res.token);
      toast.success('Device registered');
      fetchDevices();
    } catch (err: any) {
      toast.error(err.message || 'Failed to register device');
    } finally {
      setIsRegistering(false);
    }
  };

  const copyToken = () => {
    if (!issuedToken) return;
    navigator.clipboard.writeText(issuedToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isOwner === false) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
        <ShieldAlert className="w-8 h-8 text-muted-foreground/60" />
        <p className="text-sm font-semibold text-muted-foreground">Only the store Owner can register devices.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-16">
      <PageHeader
        title="Device Management"
        icon={Cpu}
        subtitle="Monitor the edge devices (cameras/Jetsons) attached to your stores"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => fetchDevices(true)} disabled={isLoading || refreshing} className="gap-2">
              <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} /> Refresh
            </Button>
            <Button disabled className="gap-2 opacity-60 cursor-not-allowed">
              <Plus className="w-4 h-4" /> Register Device
            </Button>
            <Badge className="bg-amber-100 text-amber-700 border-amber-200 font-bold">Coming Soon</Badge>
          </div>
        }
      />

      {stores.length > 1 && (
        <div className="max-w-xs">
          <Label>Store</Label>
          <Select value={storeId} onValueChange={v => { setStoreId(v); setGlobalStoreId(v); }}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {stores.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}

      {isLoading && !refreshing ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : (
        <div className={cn('grid gap-4 md:grid-cols-2 lg:grid-cols-3 transition-opacity duration-300', refreshing && 'opacity-60 pointer-events-none')}>
          {devices.map(device => (
            <Card key={device.id}>
              <CardContent className="p-6">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <Radio className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-bold text-foreground">{device.external_id}</h3>
                      <p className="text-xs text-muted-foreground font-mono">{device.id.slice(0, 8)}…</p>
                    </div>
                  </div>
                  <DeviceStatusBadge status={device.status} lastHeartbeat={device.last_heartbeat} />
                </div>
                <p className="text-xs text-muted-foreground">
                  Last heartbeat: {device.last_heartbeat ? new Date(device.last_heartbeat).toLocaleString() : 'Never'}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {devices.length === 0 && !isLoading && !refreshing && (
        <div className="text-center py-12">
          <p className="text-muted-foreground">No devices registered for this store yet</p>
        </div>
      )}

      <Dialog open={isRegisterOpen} onOpenChange={setIsRegisterOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Register Device</DialogTitle>
            <DialogDescription>Add a new edge device (camera/Jetson) to this store.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            {!issuedToken ? (
              <>
                <div>
                  <Label>Store</Label>
                  <Select value={storeId} onValueChange={v => { setStoreId(v); setGlobalStoreId(v); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {stores.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Device ID <span className="text-rose-500">*</span></Label>
                  <Input placeholder="e.g. jetson-store-01" value={externalId} onChange={e => setExternalId(e.target.value)} />
                </div>
                <div className="flex gap-2 pt-2">
                  <Button variant="outline" onClick={() => setIsRegisterOpen(false)} className="flex-1">Cancel</Button>
                  <Button onClick={registerDevice} disabled={isRegistering} className="flex-1 gap-2">
                    {isRegistering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                    Register
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800 p-3 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-800 dark:text-amber-300 font-semibold">
                    Copy this token now — it won't be shown again. Configure it on the physical device.
                  </p>
                </div>
                <div>
                  <Label>Device Token</Label>
                  <div className="flex items-center gap-2">
                    <Input readOnly value={issuedToken} className="text-xs font-mono" />
                    <Button size="sm" variant="outline" onClick={copyToken} className="shrink-0 gap-1">
                      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    </Button>
                  </div>
                </div>
                <Button onClick={() => setIsRegisterOpen(false)} className="w-full">Done</Button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default RetailDeviceManagement;
