import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Loader2, RefreshCw, ArrowRightFromLine, Clock3 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';
import { apiRequest } from '../../../services/http/apiClient';
import { Card, CardContent } from '../../ui/card';
import { Button } from '../../ui/button';

const TRANSPORT_BASE = '/transport';
const WINDOW_DAYS = 30;
const LONG_DURATION_MINUTES = 90;

interface BusRow { id: string; busCode: string; }
interface PassengerRow { id: string; fullName: string; }
interface BoardingEventRow { id: string; eventType: string; passengerId: string | null; eventTime: string; }
interface Anomaly { passengerId: string; passengerName: string; type: 'no_exit' | 'long_duration'; detail: string; }

/**
 * Operations Manager's Analytics & Insights — registered as
 * 'hr_manager/transport_analytics' (role-scoped override; tenant_admin/
 * site_admin keep their own bare 'transport_analytics' -> hierarchy+heatmap
 * page, untouched). Volume/peak/anomalies are all derived client-side from
 * the same bounded events page Analytics.tsx already uses for its heatmap —
 * no new backend aggregation endpoint for this first version.
 */
export const OperationsAnalytics: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [passengers, setPassengers] = useState<PassengerRow[]>([]);
  const [events, setEvents] = useState<BoardingEventRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    if (!accessToken) return;
    setLoading(true);
    const from = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    Promise.all([
      apiRequest<BusRow[]>(`${TRANSPORT_BASE}/buses`, { method: 'GET', accessToken, scopeHeaders }),
      apiRequest<PassengerRow[]>(`${TRANSPORT_BASE}/passengers`, { method: 'GET', accessToken, scopeHeaders }),
    ])
      .then(async ([buses, passengerRows]) => {
        setPassengers(passengerRows ?? []);
        const myBus = buses?.[0];
        if (!myBus) { setEvents([]); return; }
        const ev = await apiRequest<{ content: BoardingEventRow[] }>(
          `${TRANSPORT_BASE}/events?busId=${myBus.id}&from=${encodeURIComponent(from)}&size=200`,
          { method: 'GET', accessToken, scopeHeaders, noCache: true }
        );
        setEvents(ev?.content ?? []);
      })
      .catch(() => toast.error('Failed to load analytics'))
      .finally(() => setLoading(false));
  }, [accessToken]);

  useEffect(() => { load(); }, [load]);

  const nameById = useMemo(() => new Map(passengers.map(p => [p.id, p.fullName])), [passengers]);

  const volumeByDay = useMemo(() => {
    const counts = new Map<string, number>();
    events.filter(e => e.eventType === 'BOARDING').forEach(e => {
      const day = e.eventTime.slice(0, 10);
      counts.set(day, (counts.get(day) ?? 0) + 1);
    });
    const days: { date: string; count: number }[] = [];
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      days.push({ date: iso.slice(5), count: counts.get(iso) ?? 0 });
    }
    return days;
  }, [events]);

  const peakHours = useMemo(() => {
    const counts = new Array(24).fill(0);
    events.filter(e => e.eventType === 'BOARDING').forEach(e => {
      counts[new Date(e.eventTime).getHours()]++;
    });
    return counts.map((count, hour) => ({ hour: `${hour}:00`, count }));
  }, [events]);

  const anomalies = useMemo(() => {
    const byPassengerDay = new Map<string, BoardingEventRow[]>();
    events.forEach(e => {
      if (!e.passengerId) return;
      const key = `${e.passengerId}|${e.eventTime.slice(0, 10)}`;
      byPassengerDay.set(key, [...(byPassengerDay.get(key) ?? []), e]);
    });
    const result: Anomaly[] = [];
    byPassengerDay.forEach((dayEvents, key) => {
      const [passengerId] = key.split('|');
      const name = nameById.get(passengerId) ?? 'Unknown passenger';
      const sorted = [...dayEvents].sort((a, b) => a.eventTime.localeCompare(b.eventTime));
      const boarding = sorted.find(e => e.eventType === 'BOARDING');
      const deboarding = sorted.find(e => e.eventType === 'DEBOARDING');
      if (boarding && !deboarding) {
        result.push({ passengerId, passengerName: name, type: 'no_exit', detail: `Boarded at ${new Date(boarding.eventTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, no exit recorded` });
      } else if (boarding && deboarding) {
        const minutes = (new Date(deboarding.eventTime).getTime() - new Date(boarding.eventTime).getTime()) / 60000;
        if (minutes > LONG_DURATION_MINUTES) {
          result.push({ passengerId, passengerName: name, type: 'long_duration', detail: `Trip took ${Math.round(minutes)} minutes` });
        }
      }
    });
    return result.slice(0, 20);
  }, [events, nameById]);

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
          <h1 className="text-xl font-bold text-slate-800 dark:text-white">Analytics & Insights</h1>
          <p className="text-sm text-muted-foreground">Boarding trends and exceptions, last {WINDOW_DAYS} days</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}><RefreshCw className="w-4 h-4" /></Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="border shadow-sm rounded-2xl">
          <CardContent className="p-5">
            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-4">Boarding Volume</h3>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground py-16 text-center">No boarding activity in this window yet.</p>
            ) : (
              <div className="h-[240px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={volumeByDay}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} interval={Math.ceil(WINDOW_DAYS / 10)} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Bar dataKey="count" fill="#4F46E5" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border shadow-sm rounded-2xl">
          <CardContent className="p-5">
            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-4">Peak Boarding Hours</h3>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground py-16 text-center">No boarding activity in this window yet.</p>
            ) : (
              <div className="h-[240px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={peakHours}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="hour" tick={{ fontSize: 10 }} interval={2} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Line type="monotone" dataKey="count" stroke="#4F46E5" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="border shadow-sm rounded-2xl">
        <CardContent className="p-5">
          <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-4">Exceptions</h3>
          {anomalies.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No exceptions in this window.</p>
          ) : (
            <ul className="divide-y">
              {anomalies.map((a, i) => (
                <li key={i} className="py-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className={a.type === 'no_exit' ? 'w-8 h-8 rounded-full bg-red-100 text-red-600 flex items-center justify-center' : 'w-8 h-8 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center'}>
                      {a.type === 'no_exit' ? <ArrowRightFromLine className="w-3.5 h-3.5" /> : <Clock3 className="w-3.5 h-3.5" />}
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{a.passengerName}</p>
                      <p className="text-[11px] text-muted-foreground">{a.detail}</p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default OperationsAnalytics;
