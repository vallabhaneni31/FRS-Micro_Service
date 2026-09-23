import React, { useEffect, useState, useCallback } from 'react';
import { UserPlus, Loader2, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';
import { apiRequest, ApiError } from '../../../services/http/apiClient';
import { Card, CardContent } from '../../ui/card';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Badge } from '../../ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../ui/dialog';
import { PassengerProfilePanel } from './PassengerProfilePanel';

const TRANSPORT_BASE = '/transport';

interface PassengerRow {
  id: string; busId: string; passengerCode: string; fullName: string; phone: string | null;
  email: string | null; boardingStop: string | null; deboardingStop: string | null; status: string;
}
interface BusRow { id: string; busCode: string; }
interface CreateForm { passengerCode: string; fullName: string; phone: string; email: string; boardingStop: string; deboardingStop: string; }
const emptyForm: CreateForm = { passengerCode: '', fullName: '', phone: '', email: '', boardingStop: '', deboardingStop: '' };

export const OperationsEnrollment: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [bus, setBus] = useState<BusRow | null>(null);
  const [passengers, setPassengers] = useState<PassengerRow[]>([]);
  const [enrolledIds, setEnrolledIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!accessToken) return;
    setLoading(true);
    apiRequest<BusRow[]>(`${TRANSPORT_BASE}/buses`, { method: 'GET', accessToken, scopeHeaders })
      .then(async buses => {
        const myBus = buses?.[0] ?? null;
        setBus(myBus);
        const list = await apiRequest<PassengerRow[]>(`${TRANSPORT_BASE}/passengers`, { method: 'GET', accessToken, scopeHeaders });
        setPassengers(list ?? []);
        const statuses = await Promise.all((list ?? []).map(p =>
          apiRequest<{ id: string }[]>(`${TRANSPORT_BASE}/passengers/${p.id}/photos`, { method: 'GET', accessToken, scopeHeaders, noCache: true })
            .then(rows => [p.id, (rows?.length ?? 0) > 0] as const)
            .catch(() => [p.id, false] as const)
        ));
        setEnrolledIds(new Set(statuses.filter(([, enrolled]) => enrolled).map(([id]) => id)));
      })
      .catch(() => toast.error('Failed to load passengers'))
      .finally(() => setLoading(false));
  }, [accessToken]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!bus) { toast.error('No bus assigned to your account yet'); return; }
    if (!form.passengerCode.trim()) { toast.error('Passenger code is required'); return; }
    if (!form.fullName.trim()) { toast.error('Full name is required'); return; }
    setSaving(true);
    try {
      await apiRequest(`${TRANSPORT_BASE}/passengers`, {
        method: 'POST', accessToken, scopeHeaders,
        body: JSON.stringify({
          busId: bus.id, passengerCode: form.passengerCode, fullName: form.fullName,
          phone: form.phone || undefined, email: form.email || undefined,
          boardingStop: form.boardingStop || undefined, deboardingStop: form.deboardingStop || undefined,
        }),
      });
      toast.success('Passenger enrolled');
      setCreateOpen(false);
      setForm(emptyForm);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Failed to create passenger');
    } finally {
      setSaving(false);
    }
  };

  const filtered = passengers.filter(p =>
    !search.trim() ||
    p.fullName.toLowerCase().includes(search.toLowerCase()) ||
    p.passengerCode.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800 dark:text-white">Enrollment</h1>
          <p className="text-sm text-muted-foreground">
            {passengers.length} passenger{passengers.length === 1 ? '' : 's'} · {enrolledIds.size} enrolled
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load}><RefreshCw className="w-4 h-4" /></Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}><UserPlus className="w-4 h-4 mr-1" /> Add Passenger</Button>
        </div>
      </div>

      <div className="relative max-w-sm">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Search by name or code..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <Card className="border shadow-sm rounded-2xl">
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              {passengers.length === 0 ? 'No passengers enrolled for your bus yet.' : 'No passengers match your search.'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                  <th className="py-3 px-4">Code</th>
                  <th className="py-3 px-4">Name</th>
                  <th className="py-3 px-4">Boarding Stop</th>
                  <th className="py-3 px-4">Deboarding Stop</th>
                  <th className="py-3 px-4">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(p => (
                  <tr
                    key={p.id}
                    className="border-b last:border-0 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40"
                    onClick={() => setActiveProfileId(p.id)}
                  >
                    <td className="py-3.5 px-4 font-mono text-xs text-muted-foreground">{p.passengerCode}</td>
                    <td className="py-3.5 px-4 font-semibold text-slate-800 dark:text-slate-100">{p.fullName}</td>
                    <td className="py-3.5 px-4 text-muted-foreground">{p.boardingStop ?? '—'}</td>
                    <td className="py-3.5 px-4 text-muted-foreground">{p.deboardingStop ?? '—'}</td>
                    <td className="py-3.5 px-4">
                      {enrolledIds.has(p.id)
                        ? <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">Enrolled</Badge>
                        : <Badge variant="outline">Not Enrolled</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Passenger</DialogTitle>
            <DialogDescription>Creates a passenger record for {bus?.busCode ?? 'your bus'}.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Passenger Code <span className="text-rose-500">*</span></Label>
              <Input value={form.passengerCode} onChange={e => setForm(f => ({ ...f, passengerCode: e.target.value }))} placeholder="e.g. PSG-1001" />
            </div>
            <div>
              <Label>Full Name <span className="text-rose-500">*</span></Label>
              <Input value={form.fullName} onChange={e => setForm(f => ({ ...f, fullName: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Phone</Label>
                <Input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
              </div>
              <div>
                <Label>Email</Label>
                <Input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Boarding Stop</Label>
                <Input value={form.boardingStop} onChange={e => setForm(f => ({ ...f, boardingStop: e.target.value }))} />
              </div>
              <div>
                <Label>Deboarding Stop</Label>
                <Input value={form.deboardingStop} onChange={e => setForm(f => ({ ...f, deboardingStop: e.target.value }))} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={saving}>{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Enroll Passenger'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {activeProfileId && bus && (
        <PassengerProfilePanel
          passengerId={activeProfileId}
          busId={bus.id}
          open={!!activeProfileId}
          onClose={() => setActiveProfileId(null)}
          onEnrollmentChanged={load}
        />
      )}
    </div>
  );
};

export default OperationsEnrollment;
