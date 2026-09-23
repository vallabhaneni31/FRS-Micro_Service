import React, { useEffect, useState, useCallback } from 'react';
import { History, Loader2, RefreshCw, ArrowUpFromLine, ArrowDownToLine, ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../hooks/useScopeHeaders';
import { apiRequest } from '../../../services/http/apiClient';
import { Card, CardContent } from '../../ui/card';
import { Button } from '../../ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';

const TRANSPORT_BASE = '/transport';
const PAGE_SIZE = 20;

interface BoardingEventRow {
  id: string;
  busId: string;
  deviceId: string;
  eventType: 'BOARDING' | 'DEBOARDING';
  personRef: string | null;
  confidence: number | null;
  eventTime: string;
}

interface BusOption { id: string; busCode: string; }

interface PagedResponse<T> {
  content: T[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
}

export const EventHistory: React.FC = () => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [events, setEvents] = useState<BoardingEventRow[]>([]);
  const [buses, setBuses] = useState<BusOption[]>([]);
  const [busFilter, setBusFilter] = useState<string>('all');
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [totalElements, setTotalElements] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!accessToken) return;
    apiRequest<BusOption[]>(`${TRANSPORT_BASE}/buses`, { method: 'GET', accessToken, scopeHeaders })
      .then(setBuses)
      .catch(() => {});
  }, [accessToken]);

  const load = useCallback(() => {
    if (!accessToken) return;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), size: String(PAGE_SIZE) });
    if (busFilter !== 'all') params.set('busId', busFilter);
    apiRequest<PagedResponse<BoardingEventRow>>(`${TRANSPORT_BASE}/events?${params.toString()}`, { method: 'GET', accessToken, scopeHeaders })
      .then(r => {
        setEvents(r.content);
        setTotalPages(r.totalPages);
        setTotalElements(r.totalElements);
      })
      .catch(() => toast.error('Failed to load event history'))
      .finally(() => setLoading(false));
  }, [accessToken, page, busFilter]);

  useEffect(() => { load(); }, [load]);

  // Filter changes reset back to page 0, rather than staying on a page that may no longer exist.
  const handleBusFilterChange = (v: string) => { setBusFilter(v); setPage(0); };

  const busCode = (id: string) => buses.find(b => b.id === id)?.busCode ?? id.slice(0, 8);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-800 dark:text-white">Boarding / Deboarding History</h1>
          <p className="text-sm text-muted-foreground">{totalElements} event{totalElements === 1 ? '' : 's'} recorded</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={busFilter} onValueChange={handleBusFilterChange}>
            <SelectTrigger className="w-48"><SelectValue placeholder="All buses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All buses</SelectItem>
              {buses.map(b => <SelectItem key={b.id} value={b.id}>{b.busCode}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={load}><RefreshCw className="w-4 h-4" /></Button>
        </div>
      </div>

      <Card className="border shadow-sm rounded-2xl overflow-hidden">
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
          ) : events.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              <History className="w-8 h-8 mx-auto mb-2 opacity-40" />
              No events match this filter.
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                  <th className="py-3 px-4 text-left">Type</th>
                  <th className="py-3 px-4 text-left">Bus</th>
                  <th className="py-3 px-4 text-left">Person</th>
                  <th className="py-3 px-4 text-center">Confidence</th>
                  <th className="py-3 px-4 text-left">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {events.map(e => (
                  <tr key={e.id} className="hover:bg-slate-50/40 dark:hover:bg-slate-800/10 transition-colors">
                    <td className="py-3 px-4">
                      <span className="inline-flex items-center gap-1.5 font-semibold">
                        {e.eventType === 'BOARDING'
                          ? <ArrowUpFromLine className="w-3.5 h-3.5 text-emerald-600" />
                          : <ArrowDownToLine className="w-3.5 h-3.5 text-amber-600" />}
                        {e.eventType === 'BOARDING' ? 'Boarding' : 'Deboarding'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-500">{busCode(e.busId)}</td>
                    <td className="py-3 px-4 text-slate-500">{e.personRef ?? 'Unrecognized'}</td>
                    <td className="py-3 px-4 text-center text-slate-500">{e.confidence != null ? `${Math.round(e.confidence * 100)}%` : '—'}</td>
                    <td className="py-3 px-4 text-slate-500">{new Date(e.eventTime).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="text-xs text-muted-foreground">Page {page + 1} of {totalPages}</span>
          <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      )}
    </div>
  );
};

export default EventHistory;
