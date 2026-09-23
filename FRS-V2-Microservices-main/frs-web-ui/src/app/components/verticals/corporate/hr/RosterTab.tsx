import { getSiteTimezone } from '../../../../utils/timezone';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { apiRequest } from '../../../../services/http/apiClient';
import { cn } from '../../../ui/utils';
import { ChevronLeft, ChevronRight, Plus, Trash2, RefreshCw, Download, ArrowLeftRight, Calendar, List, Check, X } from 'lucide-react';

interface RosterEntry {
  pk_roster_id: string;
  fk_employee_id: string;
  fk_shift_id: string;
  roster_date: string;
  is_recurring: boolean;
  recur_day_of_week: number | null;
  status: string;
  swapped_with: string | null;
  notes: string | null;
  full_name: string;
  employee_code: string;
  shift_name: string;
  shift_type: string;
  start_time: string | null;
  end_time: string | null;
  department_name: string;
  swapped_with_name: string | null;
}

interface Employee { pk_employee_id: string; full_name: string; employee_code: string; department_name: string; }
interface Shift { id: string; name: string; shift_type: string; start_time: string | null; end_time: string | null; }

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const shiftBadge = (type: string) => {
  const m: Record<string,string> = { morning:'bg-amber-100 text-amber-700 border-amber-200', afternoon:'bg-orange-100 text-orange-700 border-orange-200', evening:'bg-blue-100 text-blue-700 border-blue-200', night:'bg-indigo-100 text-indigo-700 border-indigo-200', flexible:'bg-slate-100 text-slate-600 border-slate-200' };
  return m[type] || m.flexible;
};

const fmt12 = (t: string | null) => { if (!t) return ''; const [h,m] = t.split(':').map(Number); return `${h%12||12}:${String(m).padStart(2,'0')}${h>=12?'PM':'AM'}`; };
const toDateStr = (d: Date) => d.toISOString().slice(0,10);

interface RosterTabProps { employees: Employee[]; shifts: Shift[]; }

export function RosterTab({ employees, shifts }: RosterTabProps) {
  const { accessToken , isAuthenticated } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [viewMode, setViewMode] = useState<'weekly'|'monthly'>('weekly');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [addModal, setAddModal] = useState<{ date: string; employeeId?: string } | null>(null);
  const [recurModal, setRecurModal] = useState(false);
  const [swapModal, setSwapModal] = useState<RosterEntry | null>(null);
  const [addForm, setAddForm] = useState({ employee_id: '', shift_id: '', date: '', notes: '' });
  const [recurForm, setRecurForm] = useState({ employee_id: '', shift_id: '', day_of_week: 1, weeks_ahead: 4 });
  const [swapWith, setSwapWith] = useState('');

  // Date range for current view
  const { startDate, endDate, dates } = useMemo(() => {
    if (viewMode === 'weekly') {
      const d = new Date(currentDate);
      d.setDate(d.getDate() - d.getDay()); // Start of week (Sun)
      const start = new Date(d);
      const end = new Date(d); end.setDate(end.getDate() + 6);
      const ds = Array.from({ length: 7 }, (_, i) => { const x = new Date(d); x.setDate(x.getDate() + i); return x; });
      return { startDate: toDateStr(start), endDate: toDateStr(end), dates: ds };
    } else {
      const y = currentDate.getFullYear(), m = currentDate.getMonth();
      const start = new Date(y, m, 1);
      const end = new Date(y, m + 1, 0);
      const ds = Array.from({ length: end.getDate() }, (_, i) => new Date(y, m, i + 1));
      return { startDate: toDateStr(start), endDate: toDateStr(end), dates: ds };
    }
  }, [currentDate, viewMode]);

  const fetchRoster = useCallback(async () => {
    if (!isAuthenticated) return;
    setLoading(true);
    try {
      const res = await apiRequest<{ data: RosterEntry[] }>(`/hr/roster?start=${startDate}&end=${endDate}`, { accessToken, scopeHeaders });
      setRoster(res.data);
    } catch {}
    setLoading(false);
  }, [accessToken, startDate, endDate]);

  useEffect(() => { fetchRoster(); }, [fetchRoster]);

  const navigate = (dir: number) => {
    const d = new Date(currentDate);
    if (viewMode === 'weekly') d.setDate(d.getDate() + dir * 7);
    else d.setMonth(d.getMonth() + dir);
    setCurrentDate(d);
  };

  const addEntry = async () => {
    if (!addForm.employee_id || !addForm.shift_id || !addForm.date) return;
    await apiRequest('/hr/roster', { accessToken, scopeHeaders, method: 'POST', body: JSON.stringify({ entries: [{ employee_id: Number(addForm.employee_id), shift_id: Number(addForm.shift_id), date: addForm.date, notes: addForm.notes || null }] }) });
    setAddModal(null); fetchRoster();
  };

  const deleteEntry = async (id: string) => {
    await apiRequest(`/hr/roster/${id}`, { accessToken, scopeHeaders, method: 'DELETE' });
    fetchRoster();
  };

  const addRecurring = async () => {
    await apiRequest('/hr/roster/recurring', { accessToken, scopeHeaders, method: 'POST', body: JSON.stringify({ employee_id: Number(recurForm.employee_id), shift_id: Number(recurForm.shift_id), day_of_week: recurForm.day_of_week, weeks_ahead: recurForm.weeks_ahead }) });
    setRecurModal(false); fetchRoster();
  };

  const doSwap = async () => {
    if (!swapModal || !swapWith) return;
    await apiRequest(`/hr/roster/${swapModal.pk_roster_id}/swap`, { accessToken, scopeHeaders, method: 'PATCH', body: JSON.stringify({ swap_with_employee_id: Number(swapWith) }) });
    setSwapModal(null); fetchRoster();
  };

  const exportCSV = () => {
    const headers = ['Date','Employee','Code','Department','Shift','Start','End','Status'];
    const rows = roster.map(r => [r.roster_date.slice(0,10), r.full_name, r.employee_code, r.department_name, r.shift_name, fmt12(r.start_time), fmt12(r.end_time), r.status]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `roster-${startDate}-${endDate}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Group roster by employee for weekly view
  const rosterByEmployee = useMemo(() => {
    const map: Record<string, Record<string, RosterEntry>> = {};
    roster.forEach(r => {
      if (!map[r.fk_employee_id]) map[r.fk_employee_id] = {};
      map[r.fk_employee_id][r.roster_date.slice(0,10)] = r;
    });
    return map;
  }, [roster]);

  const rosterByDate = useMemo(() => {
    const map: Record<string, RosterEntry[]> = {};
    roster.forEach(r => {
      const d = r.roster_date.slice(0,10);
      if (!map[d]) map[d] = [];
      map[d].push(r);
    });
    return map;
  }, [roster]);

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: getSiteTimezone(),
  }).format(new Date());

  const [page, setPage] = useState(1);
  const PER = 10;
  const total = employees.length;
  const pages = Math.ceil(total / PER);
  const pagedEmployees = employees.slice((page - 1) * PER, page * PER);

  return (
    <div className="space-y-4">
      {/* Roster toolbar */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <button onClick={() => navigate(-1)} className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"><ChevronLeft className="w-4 h-4 text-slate-500" /></button>
          <span className="font-semibold text-slate-900 dark:text-white text-sm min-w-[180px] text-center">
            {viewMode === 'weekly' ? `${dates[0]?.toLocaleDateString('en-IN',{day:'numeric',month:'short'})} – ${dates[6]?.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}` : `${MONTHS[currentDate.getMonth()]} ${currentDate.getFullYear()}`}
          </span>
          <button onClick={() => navigate(1)} className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"><ChevronRight className="w-4 h-4 text-slate-500" /></button>
          <button onClick={() => setCurrentDate(new Date())} className="px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg">Today</button>
        </div>
        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-lg">
            <button onClick={() => setViewMode('weekly')} className={cn("px-3 py-1 text-xs font-semibold rounded-md transition-all", viewMode==='weekly'?"glass-card shadow-sm text-slate-900 dark:text-white":"text-slate-500")}>
              <List className="w-3.5 h-3.5 inline mr-1" />Week
            </button>
            <button onClick={() => setViewMode('monthly')} className={cn("px-3 py-1 text-xs font-semibold rounded-md transition-all", viewMode==='monthly'?"glass-card shadow-sm text-slate-900 dark:text-white":"text-slate-500")}>
              <Calendar className="w-3.5 h-3.5 inline mr-1" />Month
            </button>
          </div>
          <button onClick={() => setRecurModal(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-purple-600 bg-purple-50 dark:bg-purple-900/20 hover:bg-purple-100 dark:hover:bg-purple-900/30 border border-purple-200 dark:border-purple-800 rounded-lg transition-colors">
            <RefreshCw className="w-3.5 h-3.5" /> Recurring
          </button>
          <button onClick={() => { setAddForm({ employee_id:'', shift_id:'', date: today, notes:'' }); setAddModal({ date: today }); }} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors">
            <Plus className="w-3.5 h-3.5" /> Add Entry
          </button>
          <button onClick={exportCSV} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg transition-colors">
            <Download className="w-3.5 h-3.5" /> Export
          </button>
        </div>
      </div>

      {/* ── WEEKLY VIEW ── */}
      {viewMode === 'weekly' && (
        <div className="space-y-3">
          <div className="glass-card border border-slate-200 dark:border-slate-700 rounded-2xl overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px]">
                <thead>
                  <tr className="border-b border-slate-100 dark:border-slate-800">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 w-36">Employee</th>
                    {dates.map(d => {
                      const ds = toDateStr(d);
                      const isToday = ds === today;
                      return (
                        <th key={ds} className={cn("px-2 py-3 text-center text-xs font-semibold", isToday ? "text-blue-600" : "text-slate-500")}>
                          <div>{DAYS[d.getDay()]}</div>
                          <div className={cn("w-7 h-7 rounded-full flex items-center justify-center mx-auto mt-0.5 text-sm font-bold", isToday ? "bg-blue-600 text-white" : "text-slate-700 dark:text-slate-300")}>
                            {d.getDate()}
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {pagedEmployees.map(emp => (
                    <tr key={emp.pk_employee_id} className="border-b border-slate-50 dark:border-slate-800/50 hover:bg-slate-50/50 dark:hover:bg-slate-800/20">
                      <td className="px-4 py-2">
                        <p className="text-xs font-semibold text-slate-800 dark:text-slate-200">{emp.full_name}</p>
                        <p className="text-[10px] text-slate-400">{emp.employee_code}</p>
                      </td>
                      {dates.map(d => {
                        const ds = toDateStr(d);
                        const entry = rosterByEmployee[emp.pk_employee_id]?.[ds];
                        const isWknd = d.getDay() === 0 || d.getDay() === 6;
                        return (
                          <td key={ds} className={cn("px-1 py-1.5 text-center align-middle", isWknd ? "bg-slate-50/80 dark:bg-slate-800/20" : "")}>
                            {entry ? (
                              <div className="group relative">
                                <span className={cn("inline-flex items-center px-2 py-0.5 rounded-lg text-[10px] font-semibold border cursor-pointer", shiftBadge(entry.shift_type), entry.status === 'swapped' ? 'opacity-60' : '')}>
                                  {entry.shift_name.split(' ')[0]}
                                  {entry.is_recurring && <RefreshCw className="w-2.5 h-2.5 ml-1 opacity-60" />}
                                  {entry.status === 'swapped' && <ArrowLeftRight className="w-2.5 h-2.5 ml-1" />}
                                </span>
                                {/* Hover actions */}
                                <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-full hidden group-hover:flex glass-card border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg p-1 gap-1 z-10">
                                  <button onClick={() => setSwapModal(entry)} className="p-1 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded" title="Swap"><ArrowLeftRight className="w-3 h-3" /></button>
                                  <button onClick={() => deleteEntry(entry.pk_roster_id)} className="p-1 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded" title="Remove"><Trash2 className="w-3 h-3" /></button>
                                </div>
                              </div>
                            ) : (
                              <button onClick={() => { setAddForm({ employee_id: emp.pk_employee_id, shift_id: '', date: ds, notes: '' }); setAddModal({ date: ds, employeeId: emp.pk_employee_id }); }} className="w-full h-7 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity">
                                <Plus className="w-3.5 h-3.5 text-slate-300 hover:text-blue-500" />
                              </button>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination Controls */}
          {total > PER && (
            <div className="flex items-center justify-between px-4 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl">
              <p className="text-xs text-slate-500">
                Showing {Math.min((page - 1) * PER + 1, total)}–{Math.min(page * PER, total)} of {total} employees
              </p>
              <div className="flex gap-1">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1 rounded text-xs text-slate-500 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-900 disabled:opacity-40 transition-colors"
                >
                  Prev
                </button>
                {Array.from({ length: pages }).map((_, i) => (
                  <button
                    key={i + 1}
                    onClick={() => setPage(i + 1)}
                    className={cn(
                      "px-3 py-1 rounded text-xs font-bold transition-colors",
                      page === i + 1
                        ? "bg-blue-600 text-white"
                        : "text-slate-500 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-900"
                    )}
                  >
                    {i + 1}
                  </button>
                ))}
                <button
                  onClick={() => setPage(p => Math.min(pages, p + 1))}
                  disabled={page >= pages}
                  className="px-3 py-1 rounded text-xs text-slate-500 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-900 disabled:opacity-40 transition-colors"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── MONTHLY VIEW ── */}
      {viewMode === 'monthly' && (
        <div className="glass-card border border-slate-200 dark:border-slate-700 rounded-2xl overflow-hidden shadow-sm">
          {/* Day headers */}
          <div className="grid grid-cols-7 border-b border-slate-100 dark:border-slate-800">
            {DAYS.map(d => (
              <div key={d} className={cn("py-2 text-center text-xs font-semibold", d==='Sun'||d==='Sat'?"text-rose-400":"text-slate-400")}>{d}</div>
            ))}
          </div>
          {/* Calendar grid */}
          {(() => {
            const firstDay = dates[0].getDay();
            const cells: (Date | null)[] = [...Array(firstDay).fill(null), ...dates];
            while (cells.length % 7 !== 0) cells.push(null);
            const weeks = [];
            for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i+7));
            return weeks.map((week, wi) => (
              <div key={wi} className="grid grid-cols-7 border-b border-slate-50 dark:border-slate-800/50 last:border-0">
                {week.map((d, di) => {
                  if (!d) return <div key={di} className="min-h-[80px] border-r border-slate-50 dark:border-slate-800/30 bg-slate-50/30 dark:bg-slate-800/10" />;
                  const ds = toDateStr(d);
                  const entries = rosterByDate[ds] || [];
                  const isToday = ds === today;
                  const isWknd = d.getDay() === 0 || d.getDay() === 6;
                  return (
                    <div key={ds} className={cn("min-h-[80px] border-r border-slate-50 dark:border-slate-800/30 p-1.5", isWknd ? "bg-rose-50/30 dark:bg-rose-900/5" : "", isToday ? "bg-blue-50/50 dark:bg-blue-900/10" : "")}>
                      <div className="flex items-center justify-between mb-1">
                        <span className={cn("w-6 h-6 flex items-center justify-center rounded-full text-xs font-bold", isToday ? "bg-blue-600 text-white" : "text-slate-500 dark:text-slate-400")}>{d.getDate()}</span>
                        <button onClick={() => { setAddForm({ employee_id:'', shift_id:'', date: ds, notes:'' }); setAddModal({ date: ds }); }} className="opacity-0 hover:opacity-100 p-0.5 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-opacity">
                          <Plus className="w-3 h-3 text-blue-500" />
                        </button>
                      </div>
                      <div className="space-y-0.5">
                        {entries.slice(0, 3).map(entry => (
                          <div key={entry.pk_roster_id} className={cn("text-[9px] font-semibold px-1 py-0.5 rounded truncate border cursor-pointer hover:opacity-80", shiftBadge(entry.shift_type))} title={`${entry.full_name} - ${entry.shift_name}`} onClick={() => setSwapModal(entry)}>
                            {entry.full_name.split(' ')[0]} · {entry.shift_name.split(' ')[0]}
                          </div>
                        ))}
                        {entries.length > 3 && <div className="text-[9px] text-slate-400 pl-1">+{entries.length-3} more</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ));
          })()}
        </div>
      )}

      {/* ── ADD ENTRY MODAL ── */}
      {addModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setAddModal(null)}>
          <div className="glass-card rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
              <h3 className="font-bold text-slate-900 dark:text-white">Add Roster Entry</h3>
              <button onClick={() => setAddModal(null)}><X className="w-4 h-4 text-slate-500" /></button>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase">Date</label>
                <input type="date" value={addForm.date} onChange={e => setAddForm(f => ({...f, date: e.target.value}))} className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 glass-card text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase">Employee</label>
                <select value={addForm.employee_id} onChange={e => setAddForm(f => ({...f, employee_id: e.target.value}))} className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 glass-card text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">Select employee...</option>
                  {employees.map(e => <option key={e.pk_employee_id} value={e.pk_employee_id}>{e.full_name} ({e.employee_code})</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase">Shift</label>
                <select value={addForm.shift_id} onChange={e => setAddForm(f => ({...f, shift_id: e.target.value}))} className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 glass-card text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">Select shift...</option>
                  {shifts.map(s => <option key={s.id} value={s.id}>{s.name} {s.start_time ? `(${fmt12(s.start_time)}-${fmt12(s.end_time)})` : ''}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase">Notes (optional)</label>
                <input value={addForm.notes} onChange={e => setAddForm(f => ({...f, notes: e.target.value}))} placeholder="Any notes..." className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 glass-card text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="flex gap-2 pt-1">
                <button onClick={addEntry} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2"><Check className="w-4 h-4" />Add</button>
                <button onClick={() => setAddModal(null)} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── RECURRING MODAL ── */}
      {recurModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setRecurModal(false)}>
          <div className="glass-card rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
              <h3 className="font-bold text-slate-900 dark:text-white">Set Recurring Schedule</h3>
              <button onClick={() => setRecurModal(false)}><X className="w-4 h-4 text-slate-500" /></button>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase">Employee</label>
                <select value={recurForm.employee_id} onChange={e => setRecurForm(f => ({...f, employee_id: e.target.value}))} className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 glass-card text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">Select employee...</option>
                  {employees.map(e => <option key={e.pk_employee_id} value={e.pk_employee_id}>{e.full_name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase">Shift</label>
                <select value={recurForm.shift_id} onChange={e => setRecurForm(f => ({...f, shift_id: e.target.value}))} className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 glass-card text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">Select shift...</option>
                  {shifts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase">Day of Week</label>
                <div className="flex gap-1 mt-1">
                  {DAYS.map((d, i) => (
                    <button key={i} onClick={() => setRecurForm(f => ({...f, day_of_week: i}))} className={cn("flex-1 py-1.5 text-xs font-bold rounded-lg border transition-colors", recurForm.day_of_week === i ? "bg-blue-600 text-white border-blue-600" : "border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-blue-300")}>
                      {d[0]}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase">Weeks Ahead</label>
                <select value={recurForm.weeks_ahead} onChange={e => setRecurForm(f => ({...f, weeks_ahead: Number(e.target.value)}))} className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 glass-card text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  {[2,4,8,12].map(w => <option key={w} value={w}>{w} weeks</option>)}
                </select>
              </div>
              <div className="flex gap-2 pt-1">
                <button onClick={addRecurring} className="flex-1 bg-purple-600 hover:bg-purple-700 text-white text-sm font-semibold py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2"><RefreshCw className="w-4 h-4" />Set Recurring</button>
                <button onClick={() => setRecurModal(false)} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── SWAP MODAL ── */}
      {swapModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setSwapModal(null)}>
          <div className="glass-card rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
              <h3 className="font-bold text-slate-900 dark:text-white">Swap Shift</h3>
              <button onClick={() => setSwapModal(null)}><X className="w-4 h-4 text-slate-500" /></button>
            </div>
            <div className="p-5 space-y-4">
              <div className="bg-slate-50 dark:bg-slate-800 rounded-xl p-3 text-sm">
                <p className="font-semibold text-slate-800 dark:text-slate-200">{swapModal.full_name}</p>
                <p className="text-slate-500 text-xs mt-0.5">{swapModal.shift_name} · {swapModal.roster_date.slice(0,10)}</p>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase">Swap with</label>
                <select value={swapWith} onChange={e => setSwapWith(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 glass-card text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">Select employee...</option>
                  {employees.filter(e => e.pk_employee_id !== swapModal.fk_employee_id).map(e => <option key={e.pk_employee_id} value={e.pk_employee_id}>{e.full_name}</option>)}
                </select>
              </div>
              <div className="flex gap-2">
                <button onClick={doSwap} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2.5 rounded-lg flex items-center justify-center gap-2"><ArrowLeftRight className="w-4 h-4" />Confirm Swap</button>
                <button onClick={() => setSwapModal(null)} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
