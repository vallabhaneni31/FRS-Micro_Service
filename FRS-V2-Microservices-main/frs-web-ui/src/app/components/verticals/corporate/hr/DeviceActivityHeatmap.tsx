import React, { useEffect, useMemo, useState } from 'react';
import { cn } from '../../../ui/utils';
import { Cpu, RefreshCw, Activity } from 'lucide-react';
import { apiRequest } from '../../../../services/http/apiClient';
import { useAuth } from '../../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { getSiteTimezone } from '../../../../utils/timezone';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../../ui/tooltip';

interface DeviceRow {
  deviceCode: string;
  name: string;
  total: number;
  hours: number[]; // 24 slots, punch count per hour-of-day
}

interface HeatmapResponse {
  tz: string;
  fromDate: string | null;
  toDate: string | null;
  maxCell: number;
  devices: DeviceRow[];
}

type RangePreset = '7d' | '30d' | 'today';

const PRESETS: { key: RangePreset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
];

// Build YYYY-MM-DD bounds for a preset, in the browser's local day.
function presetRange(preset: RangePreset): { fromDate?: string; toDate?: string } {
  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const today = new Date();
  if (preset === 'today') return { fromDate: fmt(today), toDate: fmt(today) };
  const from = new Date();
  from.setDate(today.getDate() - (preset === '7d' ? 6 : 29));
  return { fromDate: fmt(from), toDate: fmt(today) };
}

// Green intensity scaled to the busiest cell in the dataset.
function cellStyle(count: number, maxCell: number): string {
  if (count <= 0) return 'bg-slate-100 dark:bg-slate-800/40 text-transparent';
  const ratio = maxCell > 0 ? count / maxCell : 0;
  if (ratio > 0.8) return 'bg-emerald-600 text-white';
  if (ratio > 0.6) return 'bg-emerald-500 text-white';
  if (ratio > 0.4) return 'bg-emerald-400 text-emerald-950';
  if (ratio > 0.2) return 'bg-emerald-300 text-emerald-900';
  return 'bg-emerald-200 text-emerald-900';
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => (h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`);

function formatHourWindow(h: number): string {
  const formatHour = (hour: number) => {
    if (hour === 0 || hour === 24) return '12:00 AM';
    if (hour === 12) return '12:00 PM';
    return hour < 12 ? `${hour}:00 AM` : `${hour - 12}:00 PM`;
  };
  return `${formatHour(h)} – ${formatHour(h + 1)}`;
}

interface HeatmapProps {
  /** Pin the heatmap to a fixed date range (hides the preset toggle). */
  fixedFrom?: string;
  fixedTo?: string;
  /** Override the card title (e.g. "Device activity this day"). */
  title?: string;
}

export const DeviceActivityHeatmap: React.FC<HeatmapProps> = ({ fixedFrom, fixedTo, title }) => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const fixed = !!(fixedFrom && fixedTo);
  const [preset, setPreset] = useState<RangePreset>('7d');
  const [data, setData] = useState<HeatmapResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const daysDiff = useMemo(() => {
    if (fixed && fixedFrom && fixedTo) {
      const d1 = new Date(fixedFrom);
      const d2 = new Date(fixedTo);
      return Math.round((d2.getTime() - d1.getTime()) / 86400000) + 1;
    }
    if (preset === '7d') return 7;
    if (preset === '30d') return 30;
    return 1; // today
  }, [preset, fixed, fixedFrom, fixedTo]);

  const periodLabel = useMemo(() => {
    if (fixed) {
      return daysDiff === 1 ? 'Today' : `Total · ${daysDiff} days`;
    }
    if (preset === 'today') return 'Today';
    if (preset === '7d') return 'Total · Last 7 days';
    if (preset === '30d') return 'Total · Last 30 days';
    return '';
  }, [preset, fixed, daysDiff]);

  const load = useMemo(() => async () => {
    setLoading(true);
    setError(null);
    try {
      const { fromDate, toDate } = fixed ? { fromDate: fixedFrom, toDate: fixedTo } : presetRange(preset);
      const tz = getSiteTimezone();
      const qs = new URLSearchParams({ tz });
      if (fromDate) qs.set('fromDate', fromDate);
      if (toDate) qs.set('toDate', toDate);
      const res = await apiRequest<HeatmapResponse>(
        `/devices/activity-heatmap?${qs.toString()}`,
        { accessToken, scopeHeaders, noCache: true },
      );
      setData(res);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load device activity');
    } finally {
      setLoading(false);
    }
  }, [preset, fixed, fixedFrom, fixedTo, accessToken, scopeHeaders]);

  useEffect(() => { load(); }, [load]);

  const devices = data?.devices ?? [];
  const maxCell = data?.maxCell ?? 0;
  // Peak hour across all devices, for the header summary.
  const peakHour = useMemo(() => {
    const totals = Array(24).fill(0);
    devices.forEach(d => d.hours.forEach((c, h) => { totals[h] += c; }));
    const max = Math.max(...totals, 0);
    return max > 0 ? totals.indexOf(max) : null;
  }, [devices]);

  return (
    <TooltipProvider delayDuration={150}>
    <div className="glass-card border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 rounded-xl">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-extrabold text-slate-800 dark:text-slate-100 text-sm">{title ?? 'Device Activity Heatmap'}</h3>
            <p className="text-[10px] text-slate-400 dark:text-slate-500 font-semibold tracking-wider uppercase mt-0.5">
              Punches per device by hour-of-day
              {peakHour !== null && ` · peak ${hourLabel(peakHour)}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!fixed && (
          <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl text-xs">
            {PRESETS.map(p => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPreset(p.key)}
                className={cn(
                  'px-2.5 py-1 rounded-lg font-bold transition-all',
                  preset === p.key
                    ? 'bg-white dark:bg-slate-700 shadow-sm text-slate-800 dark:text-white'
                    : 'text-slate-500 hover:text-slate-800 dark:text-slate-400',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          )}
          <button
            type="button"
            onClick={() => load()}
            className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={cn('w-3.5 h-3.5 text-slate-500', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Body */}
      {error ? (
        <div className="text-center text-xs text-rose-500 py-8">{error}</div>
      ) : loading && !data ? (
        <div className="animate-pulse space-y-2" aria-busy="true">
          {[0, 1, 2].map(i => (
            <div key={i} className="flex items-center gap-2">
              <div className="h-6 w-[150px] shrink-0 rounded bg-slate-200 dark:bg-slate-800" />
              <div className="h-6 flex-1 rounded bg-slate-100 dark:bg-slate-800/60" />
            </div>
          ))}
        </div>
      ) : devices.length === 0 ? (
        <div className="flex flex-col items-center gap-2 text-slate-400 py-10">
          <Cpu className="w-6 h-6 opacity-40" />
          <p className="text-xs">No device punches in this range.</p>
        </div>
      ) : (
        <div className="overflow-x-auto pb-2 -mb-2">
          <div className="min-w-[640px] pr-2">
            {/* Hour axis */}
            <div className="flex items-center gap-1 pl-[160px] mb-1 transform-gpu translate-z-0 antialiased" style={{ backfaceVisibility: 'hidden' }}>
              {HOURS.map(h => (
                <div key={h} className="flex-1 text-center text-[8px] font-semibold text-slate-400 leading-none">
                  {h % 3 === 0 ? hourLabel(h) : ''}
                </div>
              ))}
            </div>
            {/* Rows */}
            <div className="space-y-1">
              {devices.map(d => (
                <div key={d.deviceCode} className="flex items-center gap-1">
                  <div className="w-[160px] pr-2 shrink-0">
                    <div className="text-xs font-bold text-slate-700 dark:text-slate-200 truncate" title={d.name}>
                      {d.name}
                    </div>
                    <div className="text-[9px] text-slate-400 font-mono truncate">
                      {d.deviceCode} · {d.total} punches
                    </div>
                  </div>
                  {d.hours.map((count, h) => (
                    <Tooltip key={h}>
                      <TooltipTrigger asChild>
                        <div
                          className={cn(
                            'flex-1 aspect-square min-w-[14px] rounded-[3px] flex items-center justify-center text-[8px] font-bold transition-all will-change-transform hover:scale-110 hover:ring-2 hover:ring-emerald-400/50 cursor-default',
                            cellStyle(count, maxCell),
                          )}
                        >
                          {count > 0 ? count : ''}
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="flex flex-col gap-1.5 p-3 shadow-xl">
                        <div>
                          <div className="font-bold text-slate-100">{d.name}</div>
                          <div className="text-slate-300 font-medium">{formatHourWindow(h)}</div>
                        </div>
                        <div>
                          <div className="font-bold text-emerald-400 text-sm">
                            {count.toLocaleString()} punch{count === 1 ? '' : 'es'}
                          </div>
                        </div>
                        <div className="text-slate-400 mt-1 text-[10px]">
                          <div className="font-semibold text-slate-300">{periodLabel}</div>
                          {daysDiff > 1 && (
                            <div>Avg. {(count / daysDiff).toFixed(1).replace(/\.0$/, '')} punches/day</div>
                          )}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Legend */}
      {devices.length > 0 && (
        <div className="flex items-center gap-2 pt-1 text-[10px] text-slate-400">
          <span className="font-semibold">Less</span>
          <span className="w-3.5 h-3.5 rounded-[3px] bg-slate-100 dark:bg-slate-800/40 inline-block" />
          <span className="w-3.5 h-3.5 rounded-[3px] bg-emerald-200 inline-block" />
          <span className="w-3.5 h-3.5 rounded-[3px] bg-emerald-300 inline-block" />
          <span className="w-3.5 h-3.5 rounded-[3px] bg-emerald-400 inline-block" />
          <span className="w-3.5 h-3.5 rounded-[3px] bg-emerald-500 inline-block" />
          <span className="w-3.5 h-3.5 rounded-[3px] bg-emerald-600 inline-block" />
          <span className="font-semibold">More</span>
        </div>
      )}
    </div>
    </TooltipProvider>
  );
};

export default DeviceActivityHeatmap;
