import { formatTimeInSiteTz, formatDateInSiteTz, getSiteTimezone } from '../../../../utils/timezone';
import { computeAttendanceFields } from '../../../../utils/attendanceCalculator';
import { authConfig } from '../../../../config/authConfig';
import { useAuthedPhotoUrl } from '../../../../services/http/authedPhoto';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Area, AreaChart
} from 'recharts';
import {
  Download, RefreshCw, ChevronLeft, ChevronRight,
  Calendar, Users, TrendingUp, Search,
  CheckCircle, AlertTriangle, Timer, Camera, X,
  Check, ChevronsUpDown, Building
} from 'lucide-react';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../../../ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../../../ui/command';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';
import { cn } from '../../../ui/utils';
import { useAuth } from '../../../../contexts/AuthContext';
import { apiRequest } from '../../../../services/http/apiClient';
import { toast } from 'sonner';

// ─── Types ────────────────────────────────────────────────────────────────────
interface Employee {
  pk_employee_id: number;
  employee_code: string;
  full_name: string;
  department_name?: string;
  shift_name?: string;
}

interface AttendanceRecord {
  pk_attendance_id: number;
  attendance_date: string;
  check_in?: string;
  check_out?: string;
  all_check_ins?: string[];
  all_check_outs?: string[];
  duration_minutes?: number;
  status: string;
  is_late?: boolean;
  recognition_confidence?: number;
  checkin_photo_url?: string;
  checkout_photo_url?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt = (iso?: string) => iso
  ? formatTimeInSiteTz(iso)
  : '—';

const fmtDur = (mins?: number) => {
  if (!mins || mins <= 0) return '—';
  const totalMins = Math.round(mins);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
};

const dayName = (s: string) => {
  if (!s) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: getSiteTimezone(), weekday: 'short' }).format(new Date(s));
  } catch {
    return new Date(s).toLocaleDateString('en', { weekday: 'short' });
  }
};

const monthDays = (y: number, m: number) => ({
  first: new Date(y, m, 1).getDay(),
  total: new Date(y, m + 1, 0).getDate(),
});

const _apiRoot = authConfig.apiBaseUrl.replace(/\/api$/, '');
const photoUrl = (u?: string) => u ? (u.startsWith('/') ? u : '/api/attendance/photos/' + u.split('/').pop()) : null;

const AuthedAnalyticsImg = ({ photoPath, alt, className, onError, onClick }: { photoPath?: string | null; alt: string; className?: string; onError?: (e: any) => void; onClick?: () => void }) => {
  const { url, loading, error } = useAuthedPhotoUrl(photoPath);
  if (loading) return <div className={cn('animate-pulse bg-muted rounded-lg', className)} />;
  if (error || !url) return null;
  return <img src={url} alt={alt} loading="lazy" decoding="async" className={className} onError={onError} onClick={onClick} />;
};

// ─── Status Badge ─────────────────────────────────────────────────────────────
const Badge = ({ s }: { s: string }) => {
  const cls: Record<string, string> = {
    present: 'bg-emerald-500/15 text-emerald-500',
    late: 'bg-amber-500/15 text-amber-500',
    absent: 'bg-rose-500/15 text-rose-500',
  };
  return (
    <span className={cn('px-2.5 py-1 text-[10px] font-bold uppercase rounded-full',
      cls[s?.toLowerCase()] ?? 'bg-muted text-muted-foreground')}>
      {s ?? '—'}
    </span>
  );
};

// ─── KPI Card ─────────────────────────────────────────────────────────────────
const KpiCard = ({ label, value, sub, icon: Icon, cls }: {
  label: string; value: string | number; sub?: string;
  icon: React.ElementType; cls: string;
}) => (
  <div className="bg-card text-card-foreground border border-border rounded-xl p-5 shadow-sm hover:shadow-md transition-all">
    <div className="flex justify-between items-start mb-4">
      <div className={cn('p-2 rounded-lg opacity-80', cls.replace('text-', 'bg-').replace('500', '500/15'))}>
        <Icon className={cn('w-5 h-5', cls)} />
      </div>
    </div>
    <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold mb-1">{label}</p>
    <h3 className={cn('text-3xl font-bold', cls)}>{value}</h3>
    {sub && <p className="text-[10px] text-muted-foreground mt-1">{sub}</p>}
  </div>
);

// ─── Tooltip ──────────────────────────────────────────────────────────────────
const ChartTip = ({ active, payload, label, suffix = '' }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-xl p-3 shadow-xl text-xs text-foreground">
      <p className="font-semibold mb-1 text-foreground">{label}</p>
      {payload.map((p: any) => (
        <p key={p.name} style={{ color: p.fill ?? p.stroke }}>
          {p.name}: <b>{p.value}{suffix}</b>
        </p>
      ))}
    </div>
  );
};

// ─── Calendar ─────────────────────────────────────────────────────────────────
const Cal = ({ recs, y, m, onPrev, onNext, sel, onSel, onPhotoClick }: {
  recs: AttendanceRecord[]; y: number; m: number;
  onPrev: () => void; onNext: () => void;
  sel: string | null; onSel: (d: string | null) => void;
  onPhotoClick: (url: string) => void;

}) => {
  const { first, total } = monthDays(y, m);
  const title = new Date(y, m, 1).toLocaleDateString('en', { month: 'long', year: 'numeric' });
  const now = new Date();

  const map = useMemo(() => {
    const r: Record<number, AttendanceRecord> = {};
    recs.forEach(x => { r[new Date(x.attendance_date).getDate()] = x; });
    return r;
  }, [recs]);

  const dateStr = (d: number) =>
    `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  const cellCls = (d: number) => {
    const ds = dateStr(d);
    const rec = map[d];
    const isToday = now.getFullYear() === y && now.getMonth() === m && now.getDate() === d;
    const isSel = sel === ds;
    const dow = new Date(y, m, d).getDay();
    const isWe = dow === 0 || dow === 6;

    if (isSel) return 'ring-2 ring-primary bg-primary/20 text-primary font-bold';
    if (isToday && !rec) return 'ring-2 ring-primary/40 text-primary font-semibold';
    if (!rec) return isWe
      ? 'text-muted-foreground/25'
      : 'text-muted-foreground/50 hover:bg-accent/30';
    const s = rec.status?.toLowerCase();
    if (s === 'present') return 'bg-emerald-500/15 text-emerald-500 border border-emerald-500/25 hover:bg-emerald-500/25 cursor-pointer';
    if (s === 'late') return 'bg-amber-500/15 text-amber-500 border border-amber-500/25 hover:bg-amber-500/25 cursor-pointer';
    if (s === 'absent') return 'bg-rose-500/15 text-rose-500 border border-rose-500/25 cursor-pointer';
    return 'text-muted-foreground';
  };

  const selRec = sel ? map[new Date(sel).getDate()] : null;

  return (
    <div className="bg-card text-card-foreground border border-border rounded-xl p-5 shadow-sm h-full flex flex-col">
      {/* Header */}
      <div className="flex justify-between items-center mb-3">
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        <div className="flex items-center gap-1">
          {sel && (
            <button onClick={() => onSel(null)}
              className="text-[10px] text-primary hover:underline flex items-center gap-0.5 mr-1">
              <X className="w-3 h-3" /> Clear
            </button>
          )}
          <button onClick={onPrev} className="p-1.5 rounded-lg hover:bg-accent/50 transition-colors">
            <ChevronLeft className="w-4 h-4 text-muted-foreground" />
          </button>
          <button onClick={onNext} className="p-1.5 rounded-lg hover:bg-accent/50 transition-colors">
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex gap-3 mb-3 flex-wrap">
        {[['bg-emerald-500/20', 'Present'], ['bg-amber-500/20', 'Late'], ['bg-rose-500/20', 'Absent']].map(([c, l]) => (
          <span key={l} className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className={cn('w-2 h-2 rounded-sm', c)} />{l}
          </span>
        ))}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-7 gap-1 text-center">
        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(d => (
          <div key={d} className="text-[10px] font-bold text-muted-foreground uppercase py-1">{d}</div>
        ))}
        {Array.from({ length: first }).map((_, i) => <div key={`e${i}`} />)}
        {Array.from({ length: total }).map((_, i) => {
          const d = i + 1;
          const rec = map[d];
          return (
            <div key={d}
              onClick={() => map[d] && onSel(sel === dateStr(d) ? null : dateStr(d))}
              title={map[d] ? `${map[d].status} · ${fmt(map[d].check_in)}` : undefined}
              className={cn(
                'flex flex-col items-center justify-start text-xs rounded-lg transition-all py-1 px-0.5 min-h-[3rem]',
                cellCls(d),
                map[d] ? 'cursor-pointer' : 'cursor-default'
              )}>
              {/* Day number */}
              <span className="font-semibold leading-none mb-0.5">{d}</span>
              {/* Check-in / Check-out times */}
              {rec?.check_in && (
                <span className="text-[8px] leading-tight font-mono text-emerald-600 dark:text-emerald-400 truncate w-full text-center">
                  ↑{fmt(rec.check_in)}
                </span>
              )}
              {rec?.check_out && (
                <span className="text-[8px] leading-tight font-mono text-rose-500 dark:text-rose-400 truncate w-full text-center">
                  ↓{fmt(rec.check_out)}
                </span>
              )}
            </div>
          );
        })}

      </div>

      {/* Selected day detail */}
      {sel && (
        <div className="mt-4 pt-4 border-t border-border flex-1">
          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
            {new Date(sel).toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
          {selRec ? (
            <div className="space-y-2">
              <Badge s={selRec.status} />
              <div className="grid grid-cols-2 gap-1.5 mt-2">
                {[
                  ['In', fmt(selRec.check_in), 'text-emerald-500'],
                  ['Out', fmt(selRec.check_out), 'text-rose-500'],
                ].map(([lbl, val, c]) => (
                  <div key={lbl} className="bg-muted/50 rounded-lg p-2">
                    <p className="text-[9px] text-muted-foreground uppercase">{lbl}</p>
                    <p className={cn('text-xs font-mono font-semibold', c)}>{val}</p>
                  </div>
                ))}
                <div className="bg-muted/50 rounded-lg p-2 col-span-2">
                  <p className="text-[9px] text-muted-foreground uppercase">Duration</p>
                  <p className="text-xs font-semibold text-primary">{fmtDur(selRec.duration_minutes)}</p>
                </div>
              </div>
              {(selRec.checkin_photo_url || selRec.checkout_photo_url) && (
                <div className="flex gap-2 mt-1">
                  {[
                    [selRec.checkin_photo_url, 'border-emerald-500/30', 'Check-in'],
                    [selRec.checkout_photo_url, 'border-rose-500/30', 'Check-out'],
                  ].filter(([u]) => u).map(([u, b, a]) => (
                    <button key={a as string} onClick={() => onPhotoClick(u as string)}>
                      <AuthedAnalyticsImg photoPath={u as string} alt={a as string}
                        className={cn('w-16 h-12 rounded-lg object-cover border-2 hover:scale-110 transition-transform', b)}
                        onError={e => { (e.target as HTMLElement).style.display = 'none'; }} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No record for this date</p>
          )}
        </div>
      )}
    </div>
  );
};

export const EmployeeAnalytics: React.FC = () => {
  const { accessToken , isAuthenticated } = useAuth();
  const sh = useScopeHeaders();



  // ─── Single Employee Analytics (for Employee tab) ──────────────────────────────
  const [emps, setEmps] = useState<Employee[]>([]);
  const [depts, setDepts] = useState<any[]>([]);
  const [deptId, setDeptId] = useState('all');
  const [empId, setEmpId] = useState('');
  const [empSearch, setEmpSearch] = useState('');
  const [isEmpSearchOpen, setIsEmpSearchOpen] = useState(false);
  const [recs, setRecs] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState('THIS_MONTH');
  const [page, setPage] = useState(1);
  const recordsTableRef = React.useRef<HTMLElement>(null);
  const isFirstPageMount = React.useRef(true);
  useEffect(() => {
    if (isFirstPageMount.current) {
      isFirstPageMount.current = false;
      return;
    }
    recordsTableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [page]);
  const [calY, setCalY] = useState(new Date().getFullYear());
  const [calM, setCalM] = useState(new Date().getMonth());
  const [selDate, setSelDate] = useState<string | null>(null);

  const toLocalISOString = (date: Date) => {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };

  const [from, setFrom] = useState(() => {
    const d = new Date(); d.setDate(1); return toLocalISOString(d);
  });
  const [to, setTo] = useState(() => toLocalISOString(new Date()));

  const PER = 10;
  const [modalPhoto, setModalPhoto] = useState<string | null>(null);

  const [shifts, setShifts] = useState<any[]>([]);

  useEffect(() => {
    if (!isAuthenticated) return;

    // Fetch Employees
    apiRequest('/live/employees?limit=100', { accessToken, scopeHeaders: sh })
      .then((d: any) => {
        const list = d.data ?? d ?? [];
        setEmps(list);
        if (list.length > 0) {
          setEmpId((prev) => prev || String(list[0].pk_employee_id || list[0].id || list[0].employee_id || ''));
        }
      }).catch(() => { });

    // Fetch Departments
    apiRequest('/hr/departments', { accessToken, scopeHeaders: sh })
      .then((d: any) => {
        setDepts(d.data ?? []);
      }).catch(() => { });

    // Fetch Shifts
    apiRequest('/hr/shifts', { accessToken, scopeHeaders: sh })
      .then((d: any) => {
        setShifts(d.data ?? d ?? []);
      }).catch(() => { });
  }, [accessToken, isAuthenticated, sh]);

  const load = useCallback(() => {
    if (!empId) return;
    const today = toLocalISOString(new Date());
    let effectiveTo = to;
    if (to && to > today) {
      toast.error('To Date cannot be in the future.');
      effectiveTo = today;
      setTo(today);
    }
    if (from && effectiveTo && new Date(from) > new Date(effectiveTo)) {
      toast.error('From Date cannot be greater than To Date.');
      return;
    }
    setLoading(true); setSelDate(null);
    apiRequest(`/employees/${empId}/attendance?fromDate=${from}&toDate=${effectiveTo}`, { accessToken, scopeHeaders: sh })
      .then((d: any) => { setRecs(Array.isArray(d) ? d : (d.data ?? [])); setPage(1); })
      .catch(() => setRecs([]))
      .finally(() => setLoading(false));
  }, [accessToken, empId, from, to, sh]);

  useEffect(() => { load(); }, [load]);

  const applyPeriod = (p: string) => {
    setPeriod(p);
    const now = new Date();
    let f = new Date();
    if (p === 'TODAY') {
      f = now;
    } else if (p === 'LAST_7_DAYS') {
      f = new Date(now);
      f.setDate(now.getDate() - 6);
    } else if (p === 'LAST_30_DAYS') {
      f = new Date(now);
      f.setDate(now.getDate() - 29);
    } else if (p === 'THIS_WEEK') {
      f = new Date(now);
      f.setDate(now.getDate() - now.getDay());
    } else if (p === 'THIS_MONTH') {
      f = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (p === 'YTD') {
      f = new Date(now.getFullYear(), 0, 1);
    }
    setFrom(toLocalISOString(f));
    setTo(toLocalISOString(now));
  };

  const selEmp = useMemo(() => emps.find(e => String(e.pk_employee_id) === empId), [emps, empId]);

  const selEmpShift = useMemo(() => {
    if (!selEmp) return null;
    return shifts.find(s => String(s.pk_shift_id || s.id) === String((selEmp as any).fk_shift_id || (selEmp as any).shift_id) || s.name === selEmp.shift_name);
  }, [shifts, selEmp]);

  const isWorkingDay = useCallback((d: Date, shift?: any) => {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayStr = dayNames[d.getDay()];
    if (shift && Array.isArray(shift.work_days) && shift.work_days.length > 0) {
      return shift.work_days.includes(dayStr);
    }
    // Default working days: Mon–Fri
    return d.getDay() !== 0 && d.getDay() !== 6;
  }, []);

  const todayStr = useMemo(() => toLocalISOString(new Date()), []);

  const fullRecs = useMemo(() => {
    if (!from || !to || !empId) return recs;

    const attendedMap = new Map<string, AttendanceRecord>();
    recs.forEach(r => {
      if (r.attendance_date) {
        const dStr = r.attendance_date.slice(0, 10);
        attendedMap.set(dStr, r);
      }
    });

    const start = new Date(from);
    const end = new Date(to);
    const today = new Date();
    today.setHours(23, 59, 59, 999);

    const effectiveEnd = end > today ? today : end;

    const combined: AttendanceRecord[] = [];
    const curr = new Date(start);
    let synthId = -1;

    while (curr <= effectiveEnd) {
      const dStr = toLocalISOString(curr);
      const existing = attendedMap.get(dStr);

      if (existing) {
        combined.push(existing);
      } else {
        if (isWorkingDay(curr, selEmpShift)) {
          combined.push({
            pk_attendance_id: synthId--,
            attendance_date: dStr,
            status: 'absent',
            check_in: undefined,
            check_out: undefined,
            duration_minutes: 0,
            is_late: false,
          });
        }
      }
      curr.setDate(curr.getDate() + 1);
    }

    return combined.map(a => {
      if (!a.pk_attendance_id || a.pk_attendance_id < 0) return a;
      const parsedCheckins = typeof (a as any).all_check_ins === 'string' ? (()=>{try{return JSON.parse((a as any).all_check_ins)}catch(e){return []}})() : (Array.isArray((a as any).all_check_ins) ? (a as any).all_check_ins : []);
      const parsedCheckouts = typeof (a as any).all_check_outs === 'string' ? (()=>{try{return JSON.parse((a as any).all_check_outs)}catch(e){return []}})() : (Array.isArray((a as any).all_check_outs) ? (a as any).all_check_outs : []);
      const isToday = new Date(a.attendance_date).toDateString() === new Date().toDateString();
      const computed = computeAttendanceFields(a, parsedCheckins, parsedCheckouts, isToday);
      
      const checkinPhotoRaw = a.checkin_photo_url || parsedCheckins.find((x: any) => !!x.photo_url)?.photo_url || null;
      const checkoutPhotoRaw = a.checkout_photo_url || [...parsedCheckouts].reverse().find((x: any) => !!x.photo_url)?.photo_url || null;

      return {
        ...a,
        check_in: computed.computedCheckIn || a.check_in,
        check_out: computed.computedCheckOut || a.check_out,
        checkin_photo_url: checkinPhotoRaw,
        checkout_photo_url: checkoutPhotoRaw,
        duration_minutes: computed.computedDurationMinutes > 0 ? computed.computedDurationMinutes : (a.duration_minutes || 0),
        break_duration_minutes: Math.floor(computed.computedBreakMinutes) || (a as any).break_duration_minutes || null,
        isActiveSession: computed.isActiveSession,
      };
    }).sort((a, b) => new Date(b.attendance_date).getTime() - new Date(a.attendance_date).getTime());
  }, [from, to, empId, recs, selEmpShift, isWorkingDay]);

  const kpi = useMemo(() => {
    const total = fullRecs.length;
    const present = fullRecs.filter(r => r.status === 'present' || r.status === 'late').length;
    const late = fullRecs.filter(r => r.is_late || r.status?.toLowerCase() === 'late').length;
    const mins = fullRecs.reduce((s, r) => s + (r.duration_minutes ?? 0), 0);
    return {
      rate: total > 0 ? Math.round((present / total) * 100) : 0,
      present, total, late,
      avg: present > 0 ? Math.round((mins / present / 60) * 10) / 10 : 0,
    };
  }, [fullRecs]);

  const hourly = useMemo(() => {
    const siteTz: string = getSiteTimezone();
    const getLocalHour = (iso: string): number => {
      const d = new Date(iso);
      return parseInt(
        new Intl.DateTimeFormat('en', { timeZone: siteTz, hour: 'numeric', hour12: false }).format(d),
        10
      );
    };

    const src = selDate ? recs.filter(r => r.attendance_date?.slice(0, 10) === selDate) : recs;
    const counts: Record<number, { Entry: number; Exit: number }> = {};
    src.forEach((r: any) => {
      const ins = Array.isArray(r.all_check_ins) ? r.all_check_ins : (r.check_in ? [r.check_in] : []);
      const outs = Array.isArray(r.all_check_outs) ? r.all_check_outs : (r.check_out ? [r.check_out] : []);

      ins.forEach((timeStr: string) => {
        if (!timeStr) return;
        const h = getLocalHour(timeStr);
        if (!counts[h]) counts[h] = { Entry: 0, Exit: 0 };
        counts[h].Entry++;
      });

      outs.forEach((timeStr: string) => {
        if (!timeStr) return;
        const h = getLocalHour(timeStr);
        if (!counts[h]) counts[h] = { Entry: 0, Exit: 0 };
        counts[h].Exit++;
      });
    });
    const hours = Object.keys(counts).map(Number);
    if (hours.length === 0) return [];
    const minH = Math.max(0, Math.min(...hours) - 1);
    const maxH = Math.min(23, Math.max(...hours) + 1);
    return Array.from({ length: maxH - minH + 1 }, (_, i) => {
      const h = minH + i;
      return { hour: `${h.toString().padStart(2, '00')}:00`, Entry: counts[h]?.Entry ?? 0, Exit: counts[h]?.Exit ?? 0 };
    });
  }, [recs, selDate]);

  const weekly = useMemo(() => {
    if (!fullRecs || fullRecs.length === 0) return [];

    const sorted = [...fullRecs].sort(
      (a, b) => new Date(a.attendance_date).getTime() - new Date(b.attendance_date).getTime()
    );

    return sorted.map(r => {
      const dStr = r.attendance_date?.slice(0, 10) || '';
      let label = dStr;
      if (dStr) {
        const parts = dStr.split('-').map(Number);
        if (parts.length === 3 && !parts.some(isNaN)) {
          label = new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
          });
        }
      }

      const actualHours = Math.round(((r.duration_minutes || 0) / 60) * 10) / 10;
      return {
        week: label,
        Actual: actualHours,
        Target: 8,
      };
    });
  }, [fullRecs]);

  const calRecs = useMemo(() =>
    fullRecs.filter(r => { const d = new Date(r.attendance_date); return d.getFullYear() === calY && d.getMonth() === calM; }),
    [fullRecs, calY, calM]);

  const filtered = useMemo(() => {
    return selDate ? fullRecs.filter(r => r.attendance_date?.slice(0, 10) === selDate) : fullRecs;
  }, [fullRecs, selDate]);

  const filteredEmps = useMemo(() => {
    if (deptId === 'all') return emps;
    const selectedDept = depts.find(d => String(d.id) === deptId);
    return emps.filter(e => String(e.department_name) === selectedDept?.name);
  }, [emps, depts, deptId]);

  // When department changes, reset selected employee to empty
  useEffect(() => {
    setEmpId('');
  }, [deptId]);

  const searchFilteredEmps = useMemo(() => {
    const q = empSearch.toLowerCase().trim();
    if (!q) return filteredEmps;
    return filteredEmps.filter(e => 
      e.full_name?.toLowerCase().includes(q) || 
      e.employee_code?.toLowerCase().includes(q)
    );
  }, [filteredEmps, empSearch]);

  const pages = Math.ceil(filtered.length / PER);
  const pageRecs = filtered.slice((page - 1) * PER, page * PER);

  const isRefreshing = loading;

  const handleExportCSV = () => {
    if (!fullRecs || fullRecs.length === 0) {
      toast.error('No records to export for the selected date range.');
      return;
    }

    const fmtTime = (iso: string) => {
      return formatTimeInSiteTz(iso);
    };

    const headers = ['Date', 'Status', 'Check-In', 'Check-Out', 'Duration', 'Arrival Status'];
    const rows = fullRecs.map(r => {
      const isToday = new Date(r.attendance_date).toDateString() === new Date().toDateString();
      const checkOutFallback = isToday ? 'Active Session' : 'Not Checked Out';

      return [
        formatDateInSiteTz(r.attendance_date),
        r.status || '—',
        r.check_in ? fmtTime(r.check_in) : '—',
        r.check_out ? fmtTime(r.check_out) : ((r.check_in && r.status !== 'absent') ? checkOutFallback : '—'),
        fmtDur(r.duration_minutes),
        r.check_in ? ((r.is_late || r.status?.toLowerCase() === 'late') ? 'Late' : 'On time') : '—'
      ];
    });

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    
    const empName = selEmp?.full_name || 'employee';
    link.setAttribute('download', `${empName.replace(/\s+/g, '_')}_attendance_${from}_to_${to}.csv`);
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    
    toast.success('Analytics report exported successfully!');
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-2xl font-bold text-foreground tracking-tight">Workforce Analytics</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Detailed attendance insights for {selEmp?.full_name || 'selected employee'}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} disabled={loading}
            className="p-2 rounded-full border border-border text-muted-foreground hover:text-foreground transition-colors">
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
          </button>
          <button onClick={handleExportCSV} className="flex items-center gap-2 px-4 py-2 border border-primary text-primary rounded-lg text-sm font-medium hover:bg-primary/5 transition-colors">
            <Download className="w-4 h-4" /> Export
          </button>
        </div>
      </div>

      {isRefreshing && (
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

      <div className={cn("transition-opacity duration-300 space-y-6", isRefreshing && "opacity-60 pointer-events-none")}>
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
          {/* Filters */}
          <section className="bg-card border border-border rounded-xl p-4 flex flex-wrap items-center gap-4 shadow-sm">

            {/* Department Filter */}
            <div className="w-56">
              <Select value={deptId} onValueChange={setDeptId}>
                <SelectTrigger className="w-full bg-muted border-border h-11">
                  <div className="flex items-center gap-2">
                    <Building className="w-4 h-4 text-muted-foreground" />
                    <SelectValue placeholder="All Departments" />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Departments</SelectItem>
                  {depts.map(d => (
                    <SelectItem key={d.id} value={String(d.id)}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Searchable Employee Selector */}
            <div className="w-64">
              <Popover open={isEmpSearchOpen} onOpenChange={setIsEmpSearchOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={isEmpSearchOpen}
                    className="w-full justify-between bg-muted border-border h-11 font-normal"
                  >
                    <div className="flex items-center gap-2 overflow-hidden">
                      <Users className="w-4 h-4 text-muted-foreground shrink-0" />
                      <span className="truncate">
                        {selEmp ? `${selEmp.full_name} (${selEmp.employee_code})` : "Select employee..."}
                      </span>
                    </div>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80 p-3" align="start">
                  <div className="space-y-3">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        placeholder="Search employee..."
                        className="pl-9 h-9"
                        value={empSearch}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmpSearch(e.target.value)}
                        autoFocus
                      />
                    </div>
                    <div className="max-h-[300px] overflow-y-auto space-y-1 pr-1 custom-scrollbar">
                      {searchFilteredEmps.map((e) => (
                        <button
                          key={e.pk_employee_id}
                          onClick={() => {
                            setEmpId(String(e.pk_employee_id));
                            setEmpSearch('');
                            setIsEmpSearchOpen(false);
                          }}
                          className={cn(
                            "w-full flex items-center px-2 py-2 rounded-md transition-colors text-left",
                            empId === String(e.pk_employee_id) ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                          )}
                        >
                          <Check className={cn("mr-2 h-4 w-4 flex-shrink-0", empId === String(e.pk_employee_id) ? "opacity-100" : "opacity-0")} />
                          <div className="flex flex-col overflow-hidden">
                            <span className="font-medium text-sm truncate">{e.full_name}</span>
                            <span className="text-[10px] opacity-70">{e.employee_code}</span>
                          </div>
                        </button>
                      ))}

                      {searchFilteredEmps.length === 0 && (
                        <div className="py-4 text-center text-sm text-muted-foreground">
                          No employees found.
                        </div>
                      )}
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            <div className="flex bg-muted p-1 rounded-lg gap-1">
              {[
                ['Today', 'TODAY'],
                ['7 Days', 'LAST_7_DAYS'],
                ['30 Days', 'LAST_30_DAYS'],
                ['This Month', 'THIS_MONTH'],
                ['YTD', 'YTD']
              ].map(([l, v]) => (
                <button key={v} onClick={() => applyPeriod(v)}
                  className={cn('px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-md transition-all',
                    period === v ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                  {l}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <input type="date" value={from} max={todayStr} onChange={e => {
                const val = e.target.value;
                if (val && val > todayStr) return;
                setFrom(val);
                setPeriod('CUSTOM');
              }} className="bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-1 focus:ring-primary focus:outline-none" />
              <span className="text-muted-foreground text-xs">to</span>
              <input type="date" value={to} max={todayStr} onChange={e => {
                const val = e.target.value;
                if (val && val > todayStr) {
                  toast.error('To Date cannot be in the future.');
                  setTo(todayStr);
                  setPeriod('CUSTOM');
                  return;
                }
                setTo(val);
                setPeriod('CUSTOM');
              }} className="bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-1 focus:ring-primary focus:outline-none" />
            </div>
          </section>

          {!empId ? (
            <div className="bg-card border border-border rounded-xl p-12 text-center text-muted-foreground shadow-sm flex flex-col items-center justify-center min-h-[300px]">
              <Users className="w-12 h-12 mb-3 stroke-1 text-muted-foreground/60" />
              <h3 className="text-lg font-bold text-foreground">No Employee Selected</h3>
              <p className="text-sm mt-1">Please select an employee to view their attendance analytics.</p>
            </div>
          ) : (
            <>
              {/* KPIs */}
              <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard label="Attendance Rate" value={`${kpi.rate}%`} sub="Selected period" icon={CheckCircle} cls="text-emerald-500" />
            <KpiCard label="Present Days" value={`${kpi.present} / ${kpi.total}`} sub="Working days" icon={Calendar} cls="text-indigo-500" />
            <KpiCard label="Late Arrivals" value={kpi.late} sub="Selected period" icon={AlertTriangle} cls="text-amber-500" />
            <KpiCard label="Avg Working Hours" value={`${kpi.avg}h`} sub="Per working day" icon={Timer} cls="text-violet-500" />
          </section>

          {/* Charts Row */}
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Hourly Bar */}
            <div className="bg-card border border-border rounded-xl p-6 shadow-sm flex flex-col h-full">
              <div className="flex justify-between items-center mb-5">
                <div>
                  <h4 className="text-sm font-semibold text-foreground">Hourly Entry / Exit Activity</h4>
                  {selDate && <p className="text-[10px] text-muted-foreground mt-0.5">
                    {new Date(selDate).toLocaleDateString('en', { month: 'short', day: 'numeric' })}
                  </p>}
                </div>
                <div className="flex gap-3 text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Entry</span>
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-rose-500" /> Exit</span>
                </div>
              </div>
              <div className="flex-1 min-h-[400px]">
                {hourly.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-sm text-muted-foreground">No activity data</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={hourly} barCategoryGap="20%" barSize={24}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#cbd5e1" vertical={true} horizontal={true} />
                      <XAxis dataKey="hour" tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} axisLine={{ stroke: '#cbd5e1' }} tickLine={{ stroke: '#cbd5e1' }} />
                      <YAxis tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} axisLine={{ stroke: '#cbd5e1' }} tickLine={{ stroke: '#cbd5e1' }} allowDecimals={false} domain={[0, (dataMax: number) => Math.max(dataMax + 1, 3)]} tickCount={4} />
                      <Tooltip content={<ChartTip />} cursor={false} />
                      <Bar dataKey="Entry" fill="#22c55e" fillOpacity={0.8} radius={[4, 4, 0, 0]} activeBar={{ fillOpacity: 1 }} />
                      <Bar dataKey="Exit" fill="#ef4444" fillOpacity={0.8} radius={[4, 4, 0, 0]} activeBar={{ fillOpacity: 1 }} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* Calendar */}
            <div className="h-full">
              <Cal recs={calRecs} y={calY} m={calM}
                onPrev={() => { if (calM === 0) { setCalM(11); setCalY(y => y - 1); } else setCalM(m => m - 1); }}
                onNext={() => { if (calM === 11) { setCalM(0); setCalY(y => y + 1); } else setCalM(m => m + 1); }}
                sel={selDate}
                onSel={(d) => { setSelDate(d); setPage(1); }}
                onPhotoClick={(url) => setModalPhoto(url)} />
            </div>
          </section>

          {/* Table */}
          <section ref={recordsTableRef} className="bg-card border border-border rounded-xl overflow-hidden shadow-sm scroll-mt-24">
            <div className="px-6 py-4 flex flex-wrap justify-between items-center gap-3 border-b border-border">
              <div className="flex items-center gap-3 flex-wrap">
                <h4 className="text-sm font-semibold text-foreground">Attendance History for {selEmp?.full_name || 'selected employee'}</h4>
                <span className="px-2 py-0.5 bg-primary/10 text-primary text-[10px] font-bold rounded">
                  {filtered.length} Records
                </span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-muted/40 border-b border-border">
                    {['Date', 'Day', 'Status', 'In', 'Out', 'Duration', 'Arrival Status', 'Photos'].map(h => (
                      <th key={h} className="px-5 py-3.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {loading ? (
                    <tr><td colSpan={8} className="px-5 py-10 text-center text-sm text-muted-foreground">Loading...</td></tr>
                  ) : pageRecs.length === 0 ? (
                    <tr><td colSpan={8} className="px-5 py-10 text-center text-sm text-muted-foreground">No records found</td></tr>
                  ) : pageRecs.map(r => {
                    const ci = photoUrl(r.checkin_photo_url);
                    const co = photoUrl(r.checkout_photo_url);
                    return (
                      <tr key={r.pk_attendance_id}
                        className="transition-colors hover:bg-accent/30">
                        <td className="px-5 py-4">
                          <p className="text-sm font-medium text-foreground">
                            {formatDateInSiteTz(r.attendance_date)}
                          </p>
                        </td>
                        <td className="px-5 py-4 text-xs text-muted-foreground">{dayName(r.attendance_date)}</td>
                        <td className="px-5 py-4"><Badge s={r.status} /></td>
                        <td className="px-5 py-4 font-mono text-xs text-emerald-500">{fmt(r.check_in)}</td>
                        <td className="px-5 py-4 font-mono text-xs text-rose-500">
                          {r.check_out ? fmt(r.check_out) : (r.check_in && r.status !== 'absent' ? (new Date(r.attendance_date).toDateString() === new Date().toDateString() ? 'Active Session' : 'Not Checked Out') : '—')}
                        </td>
                        <td className="px-5 py-4 text-xs font-semibold text-primary">{fmtDur(r.duration_minutes)}</td>
                        <td className="px-5 py-4">
                          {r.check_in ? ((r.is_late || r.status?.toLowerCase() === 'late')
                            ? <span className="text-xs text-amber-500">Late</span>
                            : <span className="text-xs text-emerald-500">On time</span>)
                            : <span className="text-xs text-muted-foreground">—</span>}
                        </td>
                        <td className="px-5 py-4">
                          <div className="flex gap-1.5">
                            {[
                              [r.checkin_photo_url, 'border-emerald-500/30', 'In'],
                              [r.checkout_photo_url, 'border-rose-500/30', 'Out'],
                            ].map(([u, b, a]) => u ? (
                              <button key={a as string} onClick={() => setModalPhoto(u as string)}>
                                <AuthedAnalyticsImg photoPath={u as string} alt={a as string}
                                  className={cn('w-8 h-8 rounded-lg object-cover border-2 hover:scale-150 transition-transform cursor-zoom-in', b)}
                                  onError={e => { (e.target as HTMLElement).style.display = 'none'; }} />
                              </button>
                            ) : (
                              <div key={a as string} className="w-8 h-8 rounded-lg border border-dashed border-border/50 flex items-center justify-center">
                                <Camera className="w-3 h-3 text-muted-foreground/30" />
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="px-6 py-4 flex justify-between items-center border-t border-border bg-muted/20">
              <p className="text-xs text-muted-foreground">
                {filtered.length === 0 ? 'No entries' :
                  `${Math.min((page - 1) * PER + 1, filtered.length)}–${Math.min(page * PER, filtered.length)} of ${filtered.length}`}
              </p>
              <div className="flex gap-1">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                  className="px-3 py-1 rounded text-xs text-muted-foreground border border-border hover:bg-accent/40 disabled:opacity-40 transition-colors">Prev</button>
                {Array.from({ length: Math.min(pages, 5) }).map((_, i) => (
                  <button key={i + 1} onClick={() => setPage(i + 1)}
                    className={cn('px-3 py-1 rounded text-xs font-bold transition-colors',
                      page === i + 1 ? 'bg-primary text-primary-foreground' : 'text-muted-foreground border border-border hover:bg-accent/40')}>
                    {i + 1}
                  </button>
                ))}
                <button onClick={() => setPage(p => Math.min(pages, p + 1))} disabled={page >= pages}
                  className="px-3 py-1 rounded text-xs text-muted-foreground border border-border hover:bg-accent/40 disabled:opacity-40 transition-colors">Next</button>
              </div>
            </div>
          </section>

          {/* Weekly Trend */}
          <section className="bg-card border border-border rounded-xl p-6 shadow-sm">
            <div className="flex justify-between items-center mb-5">
              <div>
                <h4 className="text-sm font-semibold text-foreground">Weekly Working Hours Trend</h4>
                <p className="text-xs text-muted-foreground mt-0.5">vs 8h daily target</p>
              </div>
              <div className="flex gap-3 text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
                <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 bg-primary inline-block" /> Actual</span>
                <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 border-b-2 border-dashed border-amber-400 inline-block" /> 8h Target</span>
              </div>
            </div>
            <div className="h-52">
              {weekly.length === 0
                ? <div className="h-full flex items-center justify-center text-sm text-muted-foreground">No data</div>
                : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={weekly}>
                      <defs>
                        <linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.2} />
                          <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border, #cbd5e1)" opacity={0.6} />
                      <XAxis dataKey="week" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={{ stroke: 'var(--border, #cbd5e1)' }} tickLine={{ stroke: 'var(--border, #cbd5e1)' }} />
                      <YAxis domain={[0, 12]} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={{ stroke: 'var(--border, #cbd5e1)' }} tickLine={{ stroke: 'var(--border, #cbd5e1)' }} />
                      <Tooltip content={<ChartTip suffix="h" />} />
                      <ReferenceLine y={8} stroke="#f59e0b" strokeDasharray="5 5" strokeWidth={2} />
                      <Area type="monotone" dataKey="Actual" stroke="hsl(var(--primary))" strokeWidth={2.5}
                        fill="url(#ag)"
                        dot={{ fill: 'hsl(var(--primary))', r: 4, strokeWidth: 2, stroke: 'hsl(var(--card))' }}
                        activeDot={{ r: 6 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
            </div>
          </section>
          </>)}
        </div>

      {/* ── Photo Modal (portal) ── */}
      {modalPhoto ? (createPortal(
        <div
          className="fixed inset-0 z-[9999] bg-black/85 flex items-center justify-center p-6"
          onClick={() => setModalPhoto(null)}
        >
          <div className="relative max-w-4xl w-full" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setModalPhoto(null)}
              className="absolute -top-10 right-0 text-white/80 hover:text-white text-sm flex items-center gap-1"
            >
              <X className="w-4 h-4" /> Close
            </button>
            <AuthedAnalyticsImg
              photoPath={modalPhoto}
              alt="Attendance proof"
              className="w-full h-auto max-h-[85vh] object-contain rounded-2xl shadow-2xl"
            />
          </div>
        </div>,
        document.body
      ) as any) : null}
      </div>
    </div>
  );
};

export default EmployeeAnalytics;