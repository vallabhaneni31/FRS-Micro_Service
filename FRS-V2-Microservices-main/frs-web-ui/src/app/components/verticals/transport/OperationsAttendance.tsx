import React, { useEffect, useState, useCallback } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';
import { apiRequest } from '../../../services/http/apiClient';
import { Card, CardContent } from '../../ui/card';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Badge } from '../../ui/badge';
import { PassengerProfilePanel } from './PassengerProfilePanel';

const TRANSPORT_BASE = '/transport';

interface AttendanceRow { passengerId: string; passengerCode: string; fullName: string; status: string; }
interface BusRow { id: string; busCode: string; }

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  boarded: { label: 'Completed', className: 'bg-primary/10 text-primary hover:bg-primary/10' },
  boarded_no_deboard: { label: 'Boarded', className: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' },
  not_boarded: { label: 'Absent', className: 'bg-slate-100 text-slate-500 hover:bg-slate-100' },
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export const OperationsAttendance: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [bus, setBus] = useState<BusRow | null>(null);
  const [date, setDate] = useState(todayIso());
  const [rows, setRows] = useState<AttendanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!accessToken) return;
    setLoading(true);
    apiRequest<BusRow[]>(`${TRANSPORT_BASE}/buses`, { method: 'GET', accessToken, scopeHeaders })
      .then(async buses => {
        const myBus = buses?.[0] ?? null;
        setBus(myBus);
        if (!myBus) { setRows([]); return; }
        const data = await apiRequest<AttendanceRow[]>(
          `${TRANSPORT_BASE}/attendance?date=${date}&busId=${myBus.id}`,
          { method: 'GET', accessToken, scopeHeaders, noCache: true }
        );
        setRows(data ?? []);
      })
      .catch(() => toast.error('Failed to load attendance'))
      .finally(() => setLoading(false));
  }, [accessToken, date]);

  useEffect(() => { load(); }, [load]);

  const present = rows.filter(r => r.status !== 'not_boarded').length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-800 dark:text-white">Attendance</h1>
          <p className="text-sm text-muted-foreground">{rows.length} passenger{rows.length === 1 ? '' : 's'} · {present} present</p>
        </div>
        <div className="flex items-end gap-2">
          <div>
            <Label className="text-xs">Date</Label>
            <Input type="date" value={date} max={todayIso()} onChange={e => setDate(e.target.value)} className="w-40" />
          </div>
          <Button variant="outline" size="sm" onClick={load}><RefreshCw className="w-4 h-4" /></Button>
        </div>
      </div>

      <Card className="border shadow-sm rounded-2xl">
        <CardContent className="p-0">
          {loading ? (
            <div className="flex justify-center items-center h-64">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              {bus ? 'No enrolled passengers for this bus yet.' : 'No bus assigned to your account yet.'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                  <th className="py-3 px-4">Code</th>
                  <th className="py-3 px-4">Passenger</th>
                  <th className="py-3 px-4">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const badge = STATUS_BADGE[r.status] ?? { label: r.status, className: '' };
                  return (
                    <tr
                      key={r.passengerId}
                      className="border-b last:border-0 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40"
                      onClick={() => setActiveProfileId(r.passengerId)}
                    >
                      <td className="py-3.5 px-4 font-mono text-xs text-muted-foreground">{r.passengerCode}</td>
                      <td className="py-3.5 px-4 font-semibold text-slate-800 dark:text-slate-100">{r.fullName}</td>
                      <td className="py-3.5 px-4"><Badge className={badge.className}>{badge.label}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {activeProfileId && bus && (
        <PassengerProfilePanel
          passengerId={activeProfileId}
          busId={bus.id}
          open={!!activeProfileId}
          onClose={() => setActiveProfileId(null)}
        />
      )}
    </div>
  );
};

export default OperationsAttendance;
