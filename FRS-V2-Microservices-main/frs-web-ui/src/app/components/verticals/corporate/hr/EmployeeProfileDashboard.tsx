import { useDepartmentsAndShifts } from '../../../../hooks/useDepartmentsAndShifts';
import { formatTimeInSiteTz } from '../../../../utils/timezone';
import { computeAttendanceFields } from '../../../../utils/attendanceCalculator';
import React, { useEffect, useState, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Card, CardContent, CardHeader, CardTitle } from '../../../ui/card';
import { Badge } from '../../../ui/badge';
import { Button } from '../../../ui/button';
import {
  ArrowLeft, Mail, Phone, MapPin, Calendar, Clock, User,
  CheckCircle2, AlertCircle, Loader2, ScanFace, TrendingUp,
  Trash2, X, Building2,
  Briefcase, Hash, Fingerprint, ChevronLeft, ChevronRight,
  UserCog, UserX, Coffee,
} from 'lucide-react';
import { cn } from '../../../ui/utils';
import { lightTheme } from '../../../../../theme/lightTheme';
import { useAuth } from '../../../../contexts/AuthContext';
import { apiRequest } from '../../../../services/http/apiClient';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { FaceEnrollButton } from './FaceEnrollButton';
import { ErasureConfirmationModal } from './ErasureConfirmationModal';
import { AttendanceHeatmap } from './AttendanceHeatmap';
import { PunchDetailsModal } from './PunchDetailsModal';
import { useAuthedPhotoUrl, fetchAuthedPhotoBlobUrl } from '../../../../services/http/authedPhoto';

interface EmployeeProfileDashboardProps {
  canEnroll?: boolean;
  /** Deep-link intent: auto-scroll to & highlight the face-enroll panel on open. */
  autoEnroll?: boolean;
  employee: any;
  onBack: () => void;
}

// ── Formatting helpers ──────────────────────────────────────────────────────
function fmt(iso: string | null) {
  if (!iso) return '—';
  return formatTimeInSiteTz(iso);
}

function toLocalDateString(dateInput: string | Date): string {
  if (!dateInput) return '';
  const d = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (isNaN(d.getTime())) return typeof dateInput === 'string' ? dateInput.slice(0, 10) : '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const date = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${date}`;
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

const statusPillClass = (s: string) => {
  if (s === 'present')  return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-400 dark:border-emerald-500/30';
  if (s === 'late')     return 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-400 dark:border-amber-500/30';
  if (s === 'absent')   return 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/15 dark:text-rose-400 dark:border-rose-500/30';
  if (s === 'on-break') return 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/15 dark:text-blue-400 dark:border-blue-500/30';
  if (s === 'weekly-off') return 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700';
  return 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700';
};

// ── Small presentational primitives ─────────────────────────────────────────
const RailCard: React.FC<{ icon: React.ComponentType<{ className?: string }>; title: string; accent: string; children: React.ReactNode; className?: string }> = ({
  icon: Icon, title, accent, children, className,
}) => (
  <div className={cn('rounded-2xl border bg-white dark:bg-slate-900 border-slate-200/70 dark:border-slate-800 overflow-hidden flex flex-col', className)}>
    <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100 dark:border-slate-800 shrink-0">
      <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: accent + '1A', color: accent }}>
        <Icon className="w-3.5 h-3.5" />
      </span>
      <span className="text-[11px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">{title}</span>
    </div>
    <div className="p-4 flex-1 flex flex-col">{children}</div>
  </div>
);

const InfoRow: React.FC<{ icon: React.ComponentType<{ className?: string }>; label: string; value: React.ReactNode }> = ({ icon: Icon, label, value }) => (
  <div className="flex items-start gap-3 py-2">
    <Icon className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
    <div className="min-w-0 flex-1">
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
      <p className="text-sm font-semibold text-slate-700 dark:text-slate-200 truncate">{value}</p>
    </div>
  </div>
);

const StatCard: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  label: string; value: string; accent: string; progress?: number | null; overviewDays: number;
}> = ({ icon: Icon, label, value, accent, progress, overviewDays }) => (
  <div className="rounded-2xl border border-slate-200/70 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 transition-all hover:shadow-md hover:-translate-y-0.5">
    <div className="flex items-center justify-between mb-2">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 leading-tight">{label}</p>
      <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: accent + '1A', color: accent }}>
        <Icon className="w-3.5 h-3.5" />
      </span>
    </div>
    <p className="text-2xl font-black leading-none" style={{ color: accent }}>{value}</p>
    {progress != null ? (
      <div className="mt-2.5 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, Math.max(0, progress))}%`, backgroundColor: accent }} />
      </div>
    ) : (
      <p className="text-[10px] font-bold text-slate-400 mt-2">Last {overviewDays} days</p>
    )}
  </div>
);

// Attendance-table photo thumbnail that falls back to a muted dash when the
// image is missing or fails to load (so a 404 never shows a broken-image icon).
const PhotoCell: React.FC<{ photo: string | null; tone: 'emerald' | 'blue'; onOpen: (url: string) => void }> = ({ photo, tone, onOpen }) => {
  // /uploads requires a Bearer token, so a plain <img src> would 401 — fetch
  // it authenticated and render/open the resulting blob URL instead.
  const { url, error } = useAuthedPhotoUrl(photo);
  if (!photo || error) return <span className="text-slate-300">—</span>;
  if (!url) return <span className="text-slate-300">…</span>;
  const ring = tone === 'emerald' ? 'ring-emerald-500/50 hover:ring-emerald-400' : 'ring-blue-500/50 hover:ring-blue-400';
  return (
    <img
      src={url}
      loading="lazy"
      decoding="async"
      onClick={(e) => { e.stopPropagation(); onOpen(url); }}
      className={cn('w-20 h-14 rounded-lg object-cover shadow-sm cursor-zoom-in ring-1 hover:ring-2 transition-all', ring)}
    />
  );
};

export const EmployeeProfileDashboard: React.FC<EmployeeProfileDashboardProps> = ({ employee, onBack, canEnroll = false, autoEnroll = false }) => {
  const { shifts = [] } = useDepartmentsAndShifts();
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const enrollRef = useRef<HTMLDivElement | null>(null);
  const [enrollHighlight, setEnrollHighlight] = useState(false);

  const [attendance, setAttendance]   = useState<any[]>([]);
  const [isLoading, setIsLoading]     = useState(true);
  const [showErasureModal, setShowErasureModal] = useState(false);
  const [profilePhotoUrl, setProfilePhotoUrl] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<any | null>(null);
  const [overviewDays, setOverviewDays] = useState<number>(30);
  // Single source of truth for the full-screen photo viewer (replaces the old
  // imperative document.createElement lightboxes that leaked detached nodes).
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const PER = 10;
  const total = attendance.length;
  const pages = Math.ceil(total / PER);
  const pagedAttendance = attendance.slice((page - 1) * PER, page * PER);

  // Normalize field names — component accepts both API shape and mock shape
  const id     = employee.pk_employee_id || employee.id;
  const name   = employee.full_name      || employee.name   || '—';
  const email  = employee.email          || '—';
  const dept   = employee.department_name|| employee.department || '—';
  const rawPos = employee.position_title || (employee as any).designation || (employee as any).position || '';
  const pos    = (!rawPos || rawPos === '—' || rawPos.trim().toLowerCase() === 'engineer') ? 'Employee' : rawPos;
  const status = employee.status         || 'active';
  const phone  = employee.phone_number   || employee.phoneNumber || null;
  const loc    = employee.location_label || employee.location    || null;
  const joined = employee.join_date      || employee.joinDate    || null;
  const code   = employee.employee_code  || employee.employeeId  || '—';
  const shiftObj = shifts.find(s => (s.pk_shift_id || (s as any).id) == employee.fk_shift_id);
  const shift = shiftObj ? shiftObj.name : (employee.shift_type || '—');
  const managerName = employee.manager_name || null;
  const enrolled = !!(employee.face_enrolled || employee.faceEnrolled);
  const initials = name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2);


  // Scroll to top of window when viewing profile (unless autoEnroll intent is requested).
  useEffect(() => {
    if (autoEnroll && canEnroll) {
      const t = setTimeout(() => {
        enrollRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setEnrollHighlight(true);
      }, 250);
      const t2 = setTimeout(() => setEnrollHighlight(false), 3200);
      return () => { clearTimeout(t); clearTimeout(t2); };
    } else {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    }
  }, [id, autoEnroll, canEnroll]);

  // Close the photo lightbox on Escape.
  useEffect(() => {
    if (!lightboxUrl) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightboxUrl(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxUrl]);

  useEffect(() => {
    let cancelled = false;
    setAttendance([]);
    setProfilePhotoUrl(null);
    setSelectedDay(null);
    setPage(1);
    setIsLoading(true);

    if (!accessToken || !id) { setIsLoading(false); return; }
    (async () => {
      try {
        // Audit profile view
        apiRequest(`/employees/${id}/view-audit`, { accessToken, scopeHeaders, method: 'POST' }).catch(() => {});

        // Fetch profile photo
        apiRequest<{ url: string | null }>(`/employees/${id}/photo`, { accessToken, scopeHeaders, noCache: true })
          .then(async res => {
            if (cancelled) return;
            if (res?.url) {
              setProfilePhotoUrl(await fetchAuthedPhotoBlobUrl(res.url));
            } else {
              setProfilePhotoUrl(null);
            }
          })
          .catch(() => { if (!cancelled) setProfilePhotoUrl(null); });

        const toDateStr = toLocalDateString(new Date());
        const fromDateObj = new Date();
        fromDateObj.setDate(fromDateObj.getDate() - (overviewDays - 1));
        const fromDateStr = toLocalDateString(fromDateObj);

        const res = await apiRequest<{ data: any[] }>(
          `/hr/employees/${id}/attendance?fromDate=${fromDateStr}&toDate=${toDateStr}`, { accessToken, scopeHeaders, noCache: true }
        );
        if (!cancelled) {
          setAttendance(res.data ?? []);
        }
      } catch (_) {
        if (!cancelled) setAttendance([]);
      }
      finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id, accessToken, overviewDays]);

  // Stats from real attendance
  const presentDays   = attendance.filter(a => a.status === 'present' || a.status === 'late').length;
  const lateDays      = attendance.filter(a => a.status === 'late' || a.is_late || a.isLate).length;
  const absentDays    = attendance.filter(a => a.status === 'absent').length;
  const weeklyOffDays = attendance.filter(a => a.status === 'weekly-off').length;

  const avgHours     = attendance.length > 0
    ? (attendance.reduce((s, a) => s + (Number(a.working_hours) || 0), 0) / Math.max(presentDays, 1)).toFixed(1)
    : '—';
  const totalExpectedDays = presentDays + absentDays;
  const attendanceRate = totalExpectedDays > 0
    ? Math.round((presentDays / totalExpectedDays) * 100)
    : null;

  // ── Derived insights (selected records) ────────────────────────────────────
  const onTimeRate = presentDays > 0
    ? Math.round(((presentDays - lateDays) / presentDays) * 100)
    : null;
  const totalHours = attendance.reduce((s, a) => s + (Number(a.working_hours) || 0), 0);
  const accuracyVals = attendance
    .map(a => Number(a.recognition_accuracy))
    .filter(v => Number.isFinite(v) && v > 0);
  const avgAccuracy = accuracyVals.length
    ? (accuracyVals.reduce((s, v) => s + v, 0) / accuracyVals.length)
    : null;

  // Status breakdown for the Overview header (Present vs Absent only).
  const statusBreakdown = useMemo(() => {
    let presentCount = 0;
    let onBreakCount = 0;

    attendance.forEach(a => {
      if (a.status === 'on-break') {
        onBreakCount += 1;
      } else if (a.status !== 'absent' && a.status !== 'weekly-off') {
        presentCount += 1;
      }
    });

    return {
      present: presentCount,
      'on-break': onBreakCount,
      absent: absentDays,
    } as Record<string, number>;
  }, [attendance, absentDays]);

  const empStatusActive = status === 'active';

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Back */}
      <Button variant="ghost" onClick={onBack} className="gap-2 -ml-2 text-slate-500 hover:text-slate-800 dark:hover:text-slate-100">
        <ArrowLeft className="w-4 h-4" /> Back to Employees
      </Button>

      {/* ── Hero banner ─────────────────────────────────────────────────── */}
      <Card className={cn('relative overflow-hidden border-none shadow-sm', lightTheme.background.card)}>
        {/* Gradient banner */}
        <div className="relative h-28 bg-gradient-to-r from-indigo-600 via-violet-600 to-fuchsia-600">
          <div className="absolute inset-0 opacity-30 [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:18px_18px]" />
        </div>

        {/* Avatar — straddles the banner / content boundary (only the avatar
            overlaps; the name stays in the white area so it can't be clipped). */}
        <div className="absolute left-6 top-[3.5rem] z-10">
          {profilePhotoUrl ? (
            <img
              src={profilePhotoUrl}
              alt={name}
              onClick={() => setLightboxUrl(profilePhotoUrl)}
              className="w-24 h-24 rounded-2xl object-cover shadow-xl ring-4 ring-white dark:ring-slate-900 cursor-zoom-in"
              onError={() => setProfilePhotoUrl(null)}
            />
          ) : (
            <div className="w-24 h-24 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-xl ring-4 ring-white dark:ring-slate-900">
              <span className="text-3xl font-black text-white">{initials}</span>
            </div>
          )}
          <span
            title={empStatusActive ? 'Active' : 'Inactive'}
            className={cn('absolute -bottom-1 -right-1 w-5 h-5 rounded-full border-[3px] border-white dark:border-slate-900',
              empStatusActive ? 'bg-emerald-500' : 'bg-rose-400')}
          />
        </div>

        {/* Identity + meta — padded clear of the avatar (below it on mobile,
            beside it from sm up). */}
        <CardContent className="px-6 pb-6 pt-[4.5rem] sm:pt-4 sm:pl-[8.5rem]">
          <div className="flex items-start justify-between flex-wrap gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className={cn('text-2xl font-black truncate leading-tight', lightTheme.text.primary)}>{name}</h2>
                {employee.is_manager && (
                  <Badge className="rounded-md border-none bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400 px-2 py-0.5 text-xs font-black uppercase shrink-0">Manager</Badge>
                )}
              </div>
              <p className="text-slate-500 dark:text-slate-400 font-medium mt-0.5 truncate">{pos}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className={cn('text-xs font-black uppercase tracking-wide px-3 py-1 rounded-full',
                empStatusActive
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
                  : 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-400')}>
                {empStatusActive ? 'Active' : 'Inactive'}
              </span>
              {/* Data & Privacy — GDPR erasure, surfaced here in the header */}
              <button
                onClick={() => setShowErasureModal(true)}
                title="Data & Privacy — permanently delete all biometric and personal data (GDPR). Cannot be undone."
                className="inline-flex items-center gap-1.5 text-[11px] font-bold text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 rounded-lg px-2.5 py-1 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                Erase data
              </button>
            </div>
          </div>

          {/* Meta chips */}
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 px-2.5 py-1 rounded-lg">
              <Hash className="w-3.5 h-3.5 text-slate-400" />{code}
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 px-2.5 py-1 rounded-lg">
              <Building2 className="w-3.5 h-3.5 text-slate-400" />{dept}
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 px-2.5 py-1 rounded-lg">
              <Clock className="w-3.5 h-3.5 text-slate-400" />{shift}
            </span>
            <span className={cn('inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-lg',
              enrolled
                ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-400'
                : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400')}>
              <Fingerprint className="w-3.5 h-3.5" />{enrolled ? 'Face enrolled' : 'Not enrolled'}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ── Insights strip ──────────────────────────────────────────────── */}
      {!isLoading && attendance.length > 0 && (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[
            { label: 'On-time rate',   value: onTimeRate !== null ? `${onTimeRate}%` : '—', hint: 'of present days', accent: '#10b981' },
            { label: 'Total hours',    value: `${totalHours.toFixed(1)}h`, hint: `Last ${overviewDays} days`, accent: '#0ea5e9' },
          ].map(m => (
            <div key={m.label} className="rounded-xl border border-slate-200/70 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3 flex items-center gap-3">
              <span className="w-1.5 h-9 rounded-full shrink-0" style={{ backgroundColor: m.accent }} />
              <div className="min-w-0">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 leading-tight">{m.label}</p>
                <p className="text-lg font-black text-slate-800 dark:text-slate-100 leading-tight">{m.value}</p>
                <p className="text-[10px] font-medium text-slate-400 truncate">{m.hint}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Two-column dashboard ────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6 items-stretch">

        {/* Left rail */}
        <div className="flex flex-col gap-4 h-full">
          <RailCard icon={User} title="Employee Details" accent="#6366f1" className="flex-1">
            <div className="flex-1 flex flex-col gap-6 py-1">
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-indigo-500 mb-2">Identity</p>
                <div className="space-y-4">
                  <InfoRow icon={Mail} label="Email" value={email} />
                  {phone && <InfoRow icon={Phone} label="Phone" value={phone} />}
                  {loc && <InfoRow icon={MapPin} label="Location" value={loc} />}
                </div>
              </div>

              <div className="pt-4 border-t border-slate-100 dark:border-slate-800">
                <p className="text-[10px] font-black uppercase tracking-widest text-sky-500 mb-2">Employment</p>
                <div className="space-y-4">
                  <InfoRow icon={Building2} label="Department" value={dept} />
                  <InfoRow icon={Clock} label="Shift" value={shift} />
                  {managerName && <InfoRow icon={UserCog} label="Reports To" value={managerName} />}
                  {joined && <InfoRow icon={Calendar} label="Joined" value={fmtDate(joined)} />}
                </div>
              </div>
            </div>
          </RailCard>

          {canEnroll && (
            <div
              ref={enrollRef}
              className={cn('rounded-2xl transition-all duration-500',
                enrollHighlight && 'ring-2 ring-violet-400 ring-offset-2 dark:ring-offset-slate-900')}
            >
              <RailCard icon={ScanFace} title="Biometric Enrollment" accent="#8b5cf6">
                {autoEnroll && !enrolled && (
                  <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-xl bg-violet-50 dark:bg-violet-500/15 border border-violet-200 dark:border-violet-500/30 text-violet-700 dark:text-violet-300">
                    <ScanFace className="w-4 h-4 shrink-0" />
                    <p className="text-xs font-bold">Finish onboarding — enroll {name}’s face below.</p>
                  </div>
                )}
                <FaceEnrollButton
                  employeeId={String(employee.pk_employee_id || employee.id || employee.employeeId)}
                  employeeName={employee.full_name || employee.name || employee.employeeName}
                  enrolled={employee.face_enrolled || employee.enrolled}
                />
              </RailCard>
            </div>
          )}
        </div>

        {/* Main column */}
        <div className="space-y-6 min-w-0">
          {/* KPI cards */}
          {isLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-[104px] rounded-2xl bg-slate-100 dark:bg-slate-800 animate-pulse" />
              ))}
            </div>
          ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
            <StatCard icon={TrendingUp}   label="Attendance Rate" value={attendanceRate !== null ? `${attendanceRate}%` : '—'} accent="#3b82f6" progress={attendanceRate} overviewDays={overviewDays} />
            <StatCard icon={CheckCircle2} label="Days Present"     value={String(presentDays)} accent="#10b981" overviewDays={overviewDays} />
            <StatCard icon={AlertCircle}  label="Late Arrivals"    value={String(lateDays)}    accent="#f59e0b" overviewDays={overviewDays} />
            <StatCard icon={UserX}        label="Absent"           value={String(absentDays)} accent="#f43f5e" overviewDays={overviewDays} />
            <StatCard icon={Clock}        label="Avg Hours/Day"    value={avgHours !== '—' ? `${avgHours}h` : '—'} accent="#6366f1" overviewDays={overviewDays} />
          </div>
          )}

          {/* 30-day heatmap */}
          {!isLoading && attendance.length > 0 && (
            <Card className={cn(lightTheme.background.card, lightTheme.border.default)}>
              <CardHeader className={cn('border-b py-4 px-5', lightTheme.border.default)}>
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div className="flex items-center gap-3">
                    <CardTitle className={cn('text-sm font-bold', lightTheme.text.primary)}>Overview</CardTitle>
                    <div className="flex bg-slate-100/80 dark:bg-slate-800/80 p-1 rounded-lg border border-slate-200/60 dark:border-slate-700/60">
                      {[30, 60, 90].map(days => (
                        <button
                          key={days}
                          onClick={() => setOverviewDays(days)}
                          className={cn(
                            'px-3 py-1 text-xs font-bold rounded-md transition-all duration-200',
                            overviewDays === days 
                              ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 shadow-sm' 
                              : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-200/50 dark:hover:bg-slate-700/50'
                          )}
                        >
                          {days} Days
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {[
                      { key: 'present',  label: 'Present',  dot: 'bg-emerald-500' },
                      { key: 'absent',   label: 'Absent',   dot: 'bg-rose-400'    },
                    ].map(s => (
                      <span key={s.key} className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">
                        <span className={cn('w-2 h-2 rounded-full', s.dot)} />
                        {s.label}
                        <span className="font-black text-slate-700 dark:text-slate-200">{statusBreakdown[s.key]}</span>
                      </span>
                    ))}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-5">
                <AttendanceHeatmap
                  showLegend={false}
                  days={overviewDays}
                  records={attendance.map((a: any) => ({
                    date:   toLocalDateString(a.attendance_date ?? a.date ?? ''),
                    status: (a.is_late || a.isLate) ? 'late' : (a.status ?? 'absent'),
                    checkInCount: a.check_in_count ?? (a.check_in ? 1 : 0),
                    checkOutCount: a.check_out_count ?? (a.check_out ? 1 : 0),
                    checkIn: a.check_in ? formatTimeInSiteTz(a.check_in) : '—',
                    checkOut: a.check_out ? formatTimeInSiteTz(a.check_out) : '—',
                    allCheckIns: a.all_check_ins ?? (a.check_in ? [a.check_in] : []),
                    allCheckOuts: a.all_check_outs ?? (a.check_out ? [a.check_out] : []),
                  }))}
                />
              </CardContent>
            </Card>
          )}

        </div>
      </div>

      {/* Attendance history */}
      <Card className={cn(lightTheme.background.card, lightTheme.border.default)}>
        <CardHeader className={cn('border-b py-4 px-5', lightTheme.border.default)}>
              <div className="flex items-center justify-between">
                <CardTitle className={cn('text-sm font-bold', lightTheme.text.primary)}>Attendance History</CardTitle>
                <span className="text-xs font-semibold text-slate-400 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-md">{attendance.length} records</span>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="flex items-center justify-center py-16 gap-3">
                  <Loader2 className="w-5 h-5 animate-spin text-indigo-500" />
                  <span className="text-slate-400 text-sm">Loading attendance…</span>
                </div>
              ) : attendance.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2">
                  <Calendar className="w-8 h-8 text-slate-300" />
                  <p className="text-slate-500 dark:text-slate-300 text-sm font-semibold">No attendance records yet</p>
                  <p className="text-slate-400 text-xs">Records appear after the first check-in via camera</p>
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className={cn('border-b', lightTheme.background.secondary, lightTheme.border.default)}>
                          {['Date', 'Status', 'Check In', 'Check Out', 'Hours', 'Break', 'Arrival Status', 'In Photo', 'Out Photo'].map(h => (
                            <th key={h} className="text-left px-4 py-3 text-[10px] font-black text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className={cn('divide-y', lightTheme.border.default)}>
                        {pagedAttendance.map((a: any, i: number) => {
                          const parsedCheckins = typeof a.all_check_ins === 'string' ? (()=>{try{return JSON.parse(a.all_check_ins)}catch(e){return []}})() : (Array.isArray(a.all_check_ins) ? a.all_check_ins : []);
                          const parsedCheckouts = typeof a.all_check_outs === 'string' ? (()=>{try{return JSON.parse(a.all_check_outs)}catch(e){return []}})() : (Array.isArray(a.all_check_outs) ? a.all_check_outs : []);
                          const checkinPhotoRaw = a.checkin_photo_url || parsedCheckins.find((x: any) => !!x.photo_url)?.photo_url || null;
                          const checkoutPhotoRaw = a.checkout_photo_url || [...parsedCheckouts].reverse().find((x: any) => !!x.photo_url)?.photo_url || null;
                          const checkinPhoto = checkinPhotoRaw ?? null;
                          const checkoutPhoto = checkoutPhotoRaw ?? null;

                          const isToday = new Date(a.attendance_date).toDateString() === new Date().toDateString();
                          const computed = computeAttendanceFields(a, parsedCheckins, parsedCheckouts, isToday);

                          return (
                            <tr key={a.attendance_date || i}
                              onClick={() => {
                                setSelectedDay({
                                  date: toLocalDateString(a.attendance_date),
                                  status: a.status ?? 'absent',
                                  checkIn: computed.computedCheckIn ? formatTimeInSiteTz(computed.computedCheckIn) : '—',
                                  checkOut: computed.computedCheckOut ? formatTimeInSiteTz(computed.computedCheckOut) : (computed.computedCheckIn && a.status !== 'absent' ? (isToday ? 'Active Session' : 'Not Checked Out') : '—'),
                                  checkInCount: a.check_in_count ?? (a.check_in ? 1 : 0),
                                  checkOutCount: a.check_out_count ?? (a.check_out ? 1 : 0),
                                  allCheckIns: a.all_check_ins ?? (a.check_in ? [a.check_in] : []),
                                  allCheckOuts: a.all_check_outs ?? (a.check_out ? [a.check_out] : []),
                                  breakDurationMins: Math.floor(computed.computedBreakMinutes) || null,
                                });
                              }}
                              className={cn('hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors cursor-pointer border-b border-slate-100 dark:border-slate-800',
                                a.status === 'weekly-off' ? 'bg-slate-100 dark:bg-slate-800/40' : 'bg-white dark:bg-slate-900')}>
                              <td className="px-4 py-3 text-sm font-semibold whitespace-nowrap">{fmtDate(a.attendance_date)}</td>
                              <td className="px-4 py-3">
                                <span className={cn('text-[10px] font-black px-2 py-0.5 rounded-full border capitalize', statusPillClass(a.status === 'late' ? 'present' : a.status))}>
                                  {a.status === 'weekly-off' ? 'W-OFF' : (a.status === 'late' ? 'present' : a.status)}
                                </span>
                              </td>
                              {a.status === 'weekly-off' ? (
                                <td colSpan={7} className="px-4 py-3">
                                  <div className="w-full flex justify-center pr-[35%] text-xs text-slate-500 font-semibold">
                                    Full day Weekly-off
                                  </div>
                                </td>
                              ) : (
                                <>
                                  <td className="px-4 py-3 font-mono text-xs text-slate-500 whitespace-nowrap">{fmt(computed.computedCheckIn)}</td>
                                  <td className="px-4 py-3 font-mono text-xs text-slate-500 whitespace-nowrap">
                                    {computed.computedCheckOut ? fmt(computed.computedCheckOut) : (computed.computedCheckIn && a.status !== 'absent' ? (isToday ? 'Active Session' : 'Not Checked Out') : '—')}
                                  </td>
                                  <td className="px-4 py-3 text-xs text-slate-500">{computed.computedDurationMinutes > 0 ? `${(computed.computedDurationMinutes / 60).toFixed(1)}h` : '—'}</td>
                                  <td className="px-4 py-3 text-xs text-slate-500">{computed.computedBreakMinutes > 0 ? (() => { const h = Math.floor(computed.computedBreakMinutes / 60); const m = Math.floor(computed.computedBreakMinutes % 60); return h > 0 ? `${h}h ${m}m` : `${m}m`; })() : '—'}</td>
                                  <td className="px-4 py-3">
                                    {computed.computedCheckIn ? (a.is_late || a.isLate || a.status === 'late'
                                      ? <span className="text-xs text-amber-600 font-bold">Late</span>
                                      : <span className="text-xs text-emerald-600 font-bold">On time</span>)
                                      : <span className="text-xs text-slate-500">—</span>}
                                  </td>
                                  <td className="px-4 py-3">
                                    <PhotoCell photo={checkinPhoto} tone="emerald" onOpen={setLightboxUrl} />
                                  </td>
                                  <td className="px-4 py-3">
                                    <PhotoCell photo={checkoutPhoto} tone="blue" onOpen={setLightboxUrl} />
                                  </td>
                                </>
                              )}
                            </tr>

                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Pagination */}
                  {total > PER && (
                    <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 dark:border-slate-800">
                      <p className="text-xs text-slate-400 font-medium">
                        Showing {Math.min((page - 1) * PER + 1, total)}–{Math.min(page * PER, total)} of {total}
                      </p>
                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="h-8 gap-1 text-xs">
                          <ChevronLeft className="w-3.5 h-3.5" /> Prev
                        </Button>
                        <span className="text-xs font-bold text-slate-500 px-2">Page {page} / {pages}</span>
                        <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(pages, p + 1))} disabled={page >= pages} className="h-8 gap-1 text-xs">
                          Next <ChevronRight className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

      {/* ── Erasure modal ───────────────────────────────────────────────── */}
      {showErasureModal && (
        <ErasureConfirmationModal
          employee={{ id: String(id), name }}
          open={showErasureModal}
          onClose={() => setShowErasureModal(false)}
          onErased={() => { setShowErasureModal(false); onBack(); }}
          scopeHeaders={scopeHeaders}
        />
      )}

      {/* ── Photo lightbox (React-managed, portalled to <body>) ─────────── */}
      {lightboxUrl && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Attendance photo"
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-900/90 backdrop-blur-sm cursor-zoom-out p-4 animate-in fade-in duration-200"
          onClick={() => setLightboxUrl(null)}
        >
          <button
            onClick={() => setLightboxUrl(null)}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
          <img
            src={lightboxUrl}
            alt="Attendance capture"
            onClick={(e) => e.stopPropagation()}
            className="w-[90vw] md:w-[60vw] max-w-[800px] h-auto max-h-[90vh] rounded-xl shadow-[0_0_50px_rgba(0,0,0,0.5)] border border-slate-700/50 object-contain"
          />
        </div>,
        document.body,
      )}

      {/* ── Day-detail modal (shared with the 30-day heatmap) ───────────── */}
      {selectedDay && (
        <PunchDetailsModal day={selectedDay} onClose={() => setSelectedDay(null)} />
      )}
    </div>
  );
};
