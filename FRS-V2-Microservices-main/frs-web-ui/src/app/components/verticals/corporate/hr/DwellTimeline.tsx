import React, { useEffect, useState } from 'react';
import { cn } from '../../../ui/utils';
import { MapPin, Briefcase, Coffee, CircleDot, AlertTriangle } from 'lucide-react';
import { apiRequest } from '../../../../services/http/apiClient';
import { formatTimeInSiteTz } from '../../../../utils/timezone';

// Anomaly thresholds (minutes).
const BREAK_LIMIT_MIN = 90;     // total break time over this → flag
const LONG_STAY_MIN = 180;      // single non-work stay over this → flag
const OUTSIDE_SHIFT_MIN = 5;    // tracked-minus-worked over this → note

interface Segment {
  location: string;
  deviceCode: string;
  zoneType: 'work' | 'break' | 'other' | 'unassigned';
  zoneLabel: string | null;
  arrivedAt: string;
  leftAt: string | null;
  minutes: number | null;
  ongoing: boolean;
}

interface DwellResponse {
  employeeId: number;
  employeeName: string;
  date: string;
  tz: string;
  checkIn: string | null;
  checkOut: string | null;
  segments: Segment[];
  totalsByZone: Record<string, number>;
  totalsByLocation: { location: string; zoneType: string; minutes: number }[];
  totalTrackedMinutes: number;
  workedMinutes?: number | null;
  productivityPct?: number | null;
  arrivedBeforeCheckInMin?: number;
  leftAfterCheckOutMin?: number;
}

// Productivity pill tone by % of tracked time in Work zones.
const prodTone = (pct: number) =>
  pct >= 70 ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20'
  : pct >= 40 ? 'bg-amber-500/10 text-amber-600 border-amber-500/20'
  : 'bg-rose-500/10 text-rose-600 border-rose-500/20';

interface Props {
  employeeId: string;
  date: string; // YYYY-MM-DD
  accessToken: string | null;
  scopeHeaders: Record<string, string>;
}

// Each zone type gets a colour + icon, consistent across bar/legend/list.
const ZONE: Record<string, { label: string; bar: string; text: string; chip: string; icon: React.ReactNode }> = {
  work:       { label: 'Work',       bar: 'bg-emerald-500', text: 'text-emerald-600', chip: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20', icon: <Briefcase className="h-3 w-3" /> },
  break:      { label: 'Break',      bar: 'bg-amber-500',   text: 'text-amber-600',   chip: 'bg-amber-500/10 text-amber-600 border-amber-500/20',     icon: <Coffee className="h-3 w-3" /> },
  other:      { label: 'Other',      bar: 'bg-sky-500',     text: 'text-sky-600',     chip: 'bg-sky-500/10 text-sky-600 border-sky-500/20',           icon: <MapPin className="h-3 w-3" /> },
  unassigned: { label: 'Unassigned', bar: 'bg-slate-400',   text: 'text-slate-500',   chip: 'bg-slate-400/10 text-slate-500 border-slate-400/20',     icon: <CircleDot className="h-3 w-3" /> },
};

const fmtMins = (m?: number | null) => {
  if (m == null || m <= 0) return '0m';
  const h = Math.floor(m / 60), mm = m % 60;
  return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
};

export const DwellTimeline: React.FC<Props> = ({ employeeId, date, accessToken, scopeHeaders }) => {
  const [data, setData] = useState<DwellResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiRequest<DwellResponse>(
      `/attendance/dwell?employeeId=${encodeURIComponent(employeeId)}&date=${date}`,
      { accessToken, scopeHeaders, noCache: true },
    )
      .then(res => { if (!cancelled) setData(res); })
      .catch((e: any) => { if (!cancelled) setError(e?.message ?? 'Failed to load location data'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [employeeId, date, accessToken]);

  if (loading) {
    // Skeleton: header line, bar, and three stop rows.
    return (
      <div className="max-w-2xl animate-pulse space-y-3" aria-busy="true">
        <div className="h-4 w-48 rounded bg-muted" />
        <div className="h-2.5 w-full rounded-full bg-muted" />
        {[0, 1, 2].map(i => <div key={i} className="h-11 w-full rounded-xl bg-muted/60" />)}
      </div>
    );
  }
  if (error) return <div className="py-3 text-xs text-rose-500">{error}</div>;
  if (!data || data.segments.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-dashed border-border/70 px-3 py-4 text-xs text-muted-foreground">
        <MapPin className="h-4 w-4 opacity-40" /> No location data recorded for this day.
      </div>
    );
  }

  const total = data.totalTrackedMinutes || 1;
  const deviceCount = data.totalsByLocation.length;
  const dominant = Object.entries(data.totalsByZone).filter(([, m]) => m > 0).sort((a, b) => b[1] - a[1]);

  // ── Derive anomaly flags from the dwell shape ──────────────────────────────
  const z = data.totalsByZone;
  const worked = data.workedMinutes ?? null;
  const outside = worked != null ? data.totalTrackedMinutes - worked : 0;
  const anomalies: { text: string; sev: 'warn' | 'info' }[] = [];
  if ((z.break || 0) > BREAK_LIMIT_MIN) anomalies.push({ text: `${fmtMins(z.break)} on break (limit ${fmtMins(BREAK_LIMIT_MIN)})`, sev: 'warn' });
  if ((z.work || 0) === 0 && data.totalTrackedMinutes > 0) anomalies.push({ text: 'No time in a Work zone', sev: 'warn' });
  const longStay = data.segments.find(s => (s.zoneType === 'break' || s.zoneType === 'other') && (s.minutes ?? 0) > LONG_STAY_MIN);
  if (longStay) anomalies.push({ text: `Long stay at ${longStay.location} (${fmtMins(longStay.minutes)})`, sev: 'warn' });
  if ((z.unassigned || 0) > 0) anomalies.push({ text: `${fmtMins(z.unassigned)} at untagged device(s)`, sev: 'info' });
  if ((data.arrivedBeforeCheckInMin || 0) > OUTSIDE_SHIFT_MIN) anomalies.push({ text: `On site ${fmtMins(data.arrivedBeforeCheckInMin)} before check-in`, sev: 'info' });
  if ((data.leftAfterCheckOutMin || 0) > OUTSIDE_SHIFT_MIN) anomalies.push({ text: `Seen ${fmtMins(data.leftAfterCheckOutMin)} after check-out`, sev: 'info' });

  const productivityPct = data.productivityPct ?? null;
  const inProgress = data.segments.some(s => s.ongoing);

  return (
    <div className="max-w-2xl space-y-3">
      {/* Summary header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold text-muted-foreground">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600">
            <MapPin className="h-3.5 w-3.5" />
          </span>
          <span className="text-foreground">{deviceCount}</span> location{deviceCount === 1 ? '' : 's'}
          <span className="opacity-40">·</span>
          <span className="text-foreground">{fmtMins(data.totalTrackedMinutes)}</span> tracked
          {worked != null ? (
            <>
              <span className="opacity-40">·</span>
              <span className="text-foreground">{fmtMins(worked)}</span> worked
              {outside > OUTSIDE_SHIFT_MIN && (
                <span className="font-normal text-muted-foreground/70">({fmtMins(outside)} outside shift)</span>
              )}
            </>
          ) : inProgress && (
            <span className="flex items-center gap-1 font-bold text-emerald-600">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> in progress
            </span>
          )}
        </div>
        {/* Productivity + per-zone totals */}
        <div className="flex flex-wrap items-center gap-1.5">
          {productivityPct != null && (
            <span className={cn('flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold', prodTone(productivityPct))}
              title="Share of tracked time in Work zones">
              <Briefcase className="h-3 w-3" />{productivityPct}% productive
            </span>
          )}
          {dominant.map(([zone, m]) => {
            const z = ZONE[zone] ?? ZONE.unassigned;
            return (
              <span key={zone} className={cn('flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold', z.chip)}>
                {z.icon}
                <span className="tabular-nums">{fmtMins(m)}</span>
                <span className="opacity-70">{z.label}</span>
              </span>
            );
          })}
        </div>
      </div>

      {/* Proportional bar — width of each block = share of tracked time */}
      <div className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-muted">
        {data.segments.map((s, i) => {
          if (s.minutes == null || s.minutes <= 0) return null;
          const z = ZONE[s.zoneType] ?? ZONE.unassigned;
          return (
            <div key={i} className={cn('h-full first:rounded-l-full last:rounded-r-full', z.bar)}
              style={{ width: `${(s.minutes / total) * 100}%` }}
              title={`${s.location} · ${fmtMins(s.minutes)}`} />
          );
        })}
      </div>

      {/* Anomaly flags derived from the dwell shape */}
      {anomalies.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {anomalies.map((a, i) => (
            <span key={i} className={cn('flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold',
              a.sev === 'warn'
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-600'
                : 'border-slate-400/30 bg-slate-400/10 text-slate-500')}>
              <AlertTriangle className="h-3 w-3" />{a.text}
            </span>
          ))}
        </div>
      )}

      {/* Movement trail — one card per stop */}
      <div className="space-y-1.5">
        {data.segments.map((s, i) => {
          const z = ZONE[s.zoneType] ?? ZONE.unassigned;
          return (
            <div key={i} className="flex items-center gap-3 rounded-xl border border-border/60 bg-card px-3 py-2">
              <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', z.chip)}>{z.icon}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold text-foreground">
                  {s.location}
                  {s.zoneLabel && <span className="ml-1 font-normal text-muted-foreground">· {s.zoneLabel}</span>}
                </p>
                <p className="font-mono text-[10px] text-muted-foreground">
                  {formatTimeInSiteTz(s.arrivedAt)} – {s.ongoing ? 'now' : s.leftAt ? formatTimeInSiteTz(s.leftAt) : '—'}
                </p>
              </div>
              <span className={cn('shrink-0 text-right text-sm font-bold tabular-nums', z.text)}>
                {s.ongoing ? 'ongoing' : s.minutes == null ? '—' : fmtMins(s.minutes)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default DwellTimeline;
