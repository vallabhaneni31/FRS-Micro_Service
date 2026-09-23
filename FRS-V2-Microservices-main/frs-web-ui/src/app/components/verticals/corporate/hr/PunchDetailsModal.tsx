import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../../ui/utils';
import { X, CalendarDays, Camera, ImageOff, LogIn, LogOut, Clock, ArrowDownUp } from 'lucide-react';
import { formatTimeInSiteTz } from '../../../../utils/timezone';
import { useAuthedPhotoUrl } from '../../../../services/http/authedPhoto';

interface BreakSegment {
  from: Date;
  to: Date;
  mins: number;
  inferred: boolean; // true = exit camera gap; false = confirmed OUT→IN
}

export interface PunchDay {
  date: string;            // 'YYYY-MM-DD'
  status: string;          // present | late | on-break | absent
  checkInCount: number;
  checkOutCount: number;
  allCheckIns: any[];      // string[] | { time, photo_url }[]
  allCheckOuts: any[];
  breakDurationMins?: number | null;
}

function fmtMins(mins: number | null | undefined): string {
  if (!mins || mins <= 0) return '—';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Mirror of the backend break algorithm — runs client-side for display only. */
function calcBreakSegments(checkIns: any[], checkOuts: any[], maxSingleBreakMins = 60): BreakSegment[] {
  const toTs = (x: any) => new Date(typeof x === 'string' ? x : x?.time ?? '');
  const pings = [
    ...checkIns.map(x  => ({ dir: 'in'  as const, ts: toTs(x) })),
    ...checkOuts.map(x => ({ dir: 'out' as const, ts: toTs(x) })),
  ].filter(p => !isNaN(p.ts.getTime())).sort((a, b) => a.ts.getTime() - b.ts.getTime());

  const segs: BreakSegment[] = [];
  let lastInTime: Date | null = null;
  let lastOutTime: Date | null = null;
  let workStarted = false;

  for (const { dir, ts } of pings) {
    if (dir === 'in') {
      if (!workStarted) {
        workStarted = true; lastInTime = ts;
      } else if (lastOutTime) {
        const rawMins = Math.round((ts.getTime() - lastOutTime.getTime()) / 60000);
        if (rawMins >= 5) {
          const mins = Math.min(rawMins, maxSingleBreakMins);
          segs.push({ from: lastOutTime, to: ts, mins, inferred: false });
        }
        lastOutTime = null; lastInTime = ts;
      } else {
        lastInTime = ts;
      }
    } else if (workStarted && !lastOutTime) {
      lastOutTime = ts;
    }
  }
  return segs;
}

const STATUS_LABEL: Record<string, string> = {
  present: 'Present', late: 'Late', 'on-break': 'On Break', absent: 'Absent',
};
const STATUS_DOT: Record<string, string> = {
  present: 'bg-emerald-300', late: 'bg-amber-300', 'on-break': 'bg-sky-300', absent: 'bg-rose-300',
};

type Timing = { type: 'check-in' | 'check-out'; time: string; raw: string; photoUrl: string | null };

// Thumbnail that falls back to a muted tile when there's no photo OR the image
// fails to load (so a 404 never renders the browser's broken-image icon).
const NoPhoto: React.FC = () => (
  <span className="ml-auto shrink-0 w-16 h-12 rounded-xl bg-slate-50 dark:bg-slate-800 flex items-center justify-center text-slate-300 dark:text-slate-600" title="No photo">
    <ImageOff className="w-4 h-4" />
  </span>
);

const PunchThumb: React.FC<{ photo: string | null; onOpen: (url: string) => void }> = ({ photo, onOpen }) => {
  // /uploads requires a Bearer token, so a plain <img src> would 401 — fetch
  // it authenticated and render/open the resulting blob URL instead.
  const { url, loading, error } = useAuthedPhotoUrl(photo);
  if (!photo || error) return <NoPhoto />;
  if (loading || !url) {
    return (
      <span className="ml-auto shrink-0 w-16 h-12 rounded-xl bg-slate-50 dark:bg-slate-800 flex items-center justify-center text-slate-300 dark:text-slate-600">
        <Camera className="w-4 h-4 animate-pulse" />
      </span>
    );
  }
  return (
    <button type="button" onClick={() => onOpen(url)} title="View punch photo" className="ml-auto shrink-0 group relative">
      <img
        src={url}
        loading="lazy"
        decoding="async"
        alt="punch"
        className="w-16 h-12 rounded-xl object-cover ring-1 ring-slate-200 dark:ring-slate-700 group-hover:ring-2 group-hover:ring-indigo-400 transition-all"
      />
      <span className="absolute inset-0 rounded-xl bg-black/0 group-hover:bg-black/25 flex items-center justify-center transition-colors">
        <Camera className="w-4 h-4 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
      </span>
    </button>
  );
};

export const PunchDetailsModal = ({ day, onClose }: { day: PunchDay; onClose: () => void }) => {
  const [tab, setTab] = useState<'all' | 'check-ins' | 'check-outs'>('all');
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [lightboxError, setLightboxError] = useState(false);
  const breakSegs = useMemo(() => calcBreakSegments(day.allCheckIns, day.allCheckOuts), [day.allCheckIns, day.allCheckOuts]);

  useEffect(() => { setLightboxError(false); }, [lightboxUrl]);

  // Escape closes the lightbox first, then the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (lightboxUrl) setLightboxUrl(null); else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxUrl, onClose]);

  const { all, checkIns, checkOuts, firstIn, lastOut } = useMemo(() => {
    const toEntry = (type: 'check-in' | 'check-out') => (t: any): Timing => {
      const timeStr = typeof t === 'string' ? t : t?.time || '';
      const photoUrl = typeof t === 'string' ? null : t?.photo_url || null;
      const formatted = timeStr.includes('T') || timeStr.includes('-') ? formatTimeInSiteTz(timeStr) : timeStr;
      return { type, time: formatted, raw: String(timeStr), photoUrl };
    };
    const byRaw = (a: Timing, b: Timing) => a.raw.localeCompare(b.raw);
    const ins  = (day.allCheckIns  || []).map(toEntry('check-in')).sort(byRaw);
    const outs = (day.allCheckOuts || []).map(toEntry('check-out')).sort(byRaw);
    return {
      all: [...ins, ...outs].sort(byRaw),
      checkIns: ins,
      checkOuts: outs,
      firstIn: ins[0]?.time ?? '—',
      lastOut: outs[outs.length - 1]?.time ?? '—',
    };
  }, [day]);

  const list = tab === 'check-ins' ? checkIns : tab === 'check-outs' ? checkOuts : all;

  const prettyDate = new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric', year: 'numeric',
  });

  const TABS: [typeof tab, string, number][] = [
    ['all', 'All', all.length],
    ['check-ins', 'In', checkIns.length],
    ['check-outs', 'Out', checkOuts.length],
  ];

  const SummaryCell: React.FC<{ label: string; value: React.ReactNode; tone?: string }> = ({ label, value, tone }) => (
    <div className="py-3 px-2 text-center">
      <p className="text-[9px] font-black uppercase tracking-wider text-slate-400 dark:text-slate-500">{label}</p>
      <p className={cn('mt-0.5 font-black leading-none', tone ?? 'text-slate-700 dark:text-slate-200')}>{value}</p>
    </div>
  );

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Punch details"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md max-h-[88vh] flex flex-col overflow-hidden rounded-3xl bg-white dark:bg-slate-900 shadow-2xl ring-1 ring-black/5 dark:ring-white/10 animate-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        {/* Gradient header */}
        <div className="relative px-5 pt-5 pb-4 bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-600 text-white">
          <div className="absolute inset-0 opacity-20 [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:16px_16px] pointer-events-none" />
          <button
            onClick={onClose}
            className="absolute top-4 right-4 z-20 p-1.5 rounded-full bg-white/15 hover:bg-white/30 transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
          <div className="relative flex items-center gap-3">
            <span className="w-11 h-11 rounded-2xl bg-white/15 flex items-center justify-center shrink-0">
              <CalendarDays className="w-5 h-5" />
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-widest text-white/70">Punch details</p>
              <h4 className="text-base font-black truncate">{prettyDate}</h4>
            </div>
          </div>
          <span className="relative mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/15 text-[10px] font-black uppercase tracking-wide">
            <span className={cn('w-1.5 h-1.5 rounded-full', STATUS_DOT[day.status] ?? 'bg-white')} />
            {STATUS_LABEL[day.status] ?? day.status}
          </span>
        </div>

        {/* Summary band */}
        <div className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
          <div className="grid grid-cols-3 divide-x divide-slate-100 dark:divide-slate-800 border-b border-slate-100 dark:border-slate-800">
            <SummaryCell label="Check-ins"  value={<span className="text-xl">{day.checkInCount}</span>}  tone="text-emerald-600 dark:text-emerald-400" />
            <SummaryCell label="Check-outs" value={<span className="text-xl">{day.checkOutCount}</span>} tone="text-blue-600 dark:text-blue-400" />
            <SummaryCell label="Break Time" value={<span className="text-lg font-mono">{fmtMins(day.breakDurationMins)}</span>} tone="text-amber-600 dark:text-amber-400" />
          </div>
          <div className="grid grid-cols-2 divide-x divide-slate-100 dark:divide-slate-800">
            <SummaryCell label="First in"   value={<span className="text-xs font-mono">{firstIn}</span>} />
            <SummaryCell label="Last out"   value={<span className="text-xs font-mono">{lastOut}</span>} />
          </div>
          {/* Break segment breakdown */}
          {breakSegs.length > 0 && (
            <div className="px-3 py-2.5 border-t border-slate-100 dark:border-slate-800">
              <p className="text-[9px] font-black uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-1.5 flex items-center gap-1">
                <Clock className="w-3 h-3" /> Break breakdown
              </p>
              <ul className="space-y-1.5">
                {breakSegs.map((seg, i) => (
                  <li key={i} className="flex items-center gap-2 text-[11px]">
                    <span className={cn('h-2 w-2 rounded-full shrink-0', seg.inferred ? 'bg-amber-400' : 'bg-emerald-400')} />
                    <span className="font-mono text-slate-500 dark:text-slate-400">
                      {formatTimeInSiteTz(seg.from.toISOString())} → {formatTimeInSiteTz(seg.to.toISOString())}
                    </span>
                    <span className="font-bold text-slate-700 dark:text-slate-200 ml-auto">{fmtMins(seg.mins)}</span>
                    {seg.inferred
                      ? <span className="text-[10px] font-bold text-amber-500 bg-amber-50 dark:bg-amber-950/30 px-1.5 py-0.5 rounded-full whitespace-nowrap">~est · camera gap</span>
                      : <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 px-1.5 py-0.5 rounded-full">confirmed</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex flex-col gap-3 p-4 overflow-hidden">
          {/* Filter pills */}
          <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl text-xs">
            {TABS.map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={cn('flex-1 py-1.5 rounded-lg font-bold transition-all flex items-center justify-center gap-1.5',
                  tab === key ? 'bg-white dark:bg-slate-700 shadow-sm text-slate-800 dark:text-white' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400')}
              >
                {label}
                <span className={cn('text-[10px] font-black px-1.5 rounded-full',
                  tab === key ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300' : 'bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400')}>
                  {count}
                </span>
              </button>
            ))}
          </div>

          {/* Punch list */}
          {list.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <ArrowDownUp className="w-8 h-8 text-slate-300" />
              <p className="text-xs font-semibold text-slate-400">No punches recorded</p>
            </div>
          ) : (
            <ul className="space-y-2 max-h-[300px] overflow-y-auto pr-1 -mr-1">
              {list.map((t, idx) => {
                const isIn = t.type === 'check-in';
                const photo = t.photoUrl;
                return (
                  <li
                    key={idx}
                    className="relative overflow-hidden rounded-2xl border border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900/40 hover:border-slate-200 dark:hover:border-slate-700 transition-colors"
                  >
                    <span className={cn('absolute left-0 top-0 bottom-0 w-1', isIn ? 'bg-emerald-500' : 'bg-blue-500')} />
                    <div className="flex items-center gap-3 pl-4 pr-3 py-2.5">
                      <span className={cn('w-9 h-9 rounded-xl flex items-center justify-center shrink-0',
                        isIn ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400' : 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400')}>
                        {isIn ? <LogIn className="w-4 h-4" /> : <LogOut className="w-4 h-4" />}
                      </span>
                      <div className="min-w-0">
                        <p className="font-mono font-black text-sm text-slate-800 dark:text-slate-100 leading-tight">{t.time}</p>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                          {isIn ? 'Check in' : 'Check out'} · #{idx + 1}
                        </p>
                      </div>
                      <PunchThumb photo={photo} onOpen={setLightboxUrl} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 pb-4 pt-1">
          <button
            onClick={onClose}
            className="w-full py-2.5 bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:hover:bg-slate-200 dark:text-slate-900 text-white text-xs font-bold rounded-xl shadow-sm transition-all active:scale-[0.98] flex items-center justify-center gap-2"
          >
            <Clock className="w-3.5 h-3.5" /> Close
          </button>
        </div>
      </div>

      {/* Photo lightbox */}
      {lightboxUrl && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Punch photo"
          className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-900/90 backdrop-blur-sm cursor-zoom-out p-4 animate-in fade-in duration-200"
          onClick={(e) => { e.stopPropagation(); setLightboxUrl(null); }}
        >
          <button onClick={(e) => { e.stopPropagation(); setLightboxUrl(null); }} className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
          {lightboxError ? (
            <div onClick={e => e.stopPropagation()} className="flex flex-col items-center gap-3 text-slate-300">
              <ImageOff className="w-12 h-12 opacity-60" />
              <p className="text-sm font-semibold">Image unavailable</p>
            </div>
          ) : (
            <img
              src={lightboxUrl}
              alt="Punch capture"
              onClick={e => e.stopPropagation()}
              onError={() => setLightboxError(true)}
              className="w-[90vw] md:w-[60vw] max-w-[800px] h-auto max-h-[90vh] rounded-xl shadow-[0_0_50px_rgba(0,0,0,0.5)] border border-slate-700/50 object-contain"
            />
          )}
        </div>
      )}
    </div>,
    document.body,
  );
};
