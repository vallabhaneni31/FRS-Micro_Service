import React, { useEffect, useMemo, useState } from 'react';
import { cn } from '../../../ui/utils';
import { Cpu, RefreshCw, CalendarRange } from 'lucide-react';
import { apiRequest } from '../../../../services/http/apiClient';
import { useAuth } from '../../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { getSiteTimezone } from '../../../../utils/timezone';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../../ui/tooltip';

interface DeviceRow {
  deviceCode: string;
  name: string;
  total: number;
  days: Record<string, number>; // 'YYYY-MM-DD' -> punch count
}

interface DayHeatmapResponse {
  tz: string;
  fromDate: string;
  toDate: string;
  days: string[];
  maxCell: number;
  devices: DeviceRow[];
}

interface Props {
  fromDate: string; // YYYY-MM-DD
  toDate: string;   // YYYY-MM-DD
}

function cellStyle(count: number, maxCell: number): string {
  if (count <= 0) return 'bg-slate-100 dark:bg-slate-800/40 text-transparent';
  const ratio = maxCell > 0 ? count / maxCell : 0;
  if (ratio > 0.8) return 'bg-emerald-600 text-white';
  if (ratio > 0.6) return 'bg-emerald-500 text-white';
  if (ratio > 0.4) return 'bg-emerald-400 text-emerald-950';
  if (ratio > 0.2) return 'bg-emerald-300 text-emerald-900';
  return 'bg-emerald-200 text-emerald-900';
}

function formatDate(dStr: string, isWknd: boolean): string {
  const [y, m, d] = dStr.split('-');
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  const formatted = date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
  return isWknd ? `${formatted} (Weekend)` : formatted;
}

export const DeviceDayHeatmap: React.FC<Props> = ({ fromDate, toDate }) => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [data, setData] = useState<DayHeatmapResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useMemo(() => async () => {
    setLoading(true);
    setError(null);
    try {
      const tz = getSiteTimezone();
      const qs = new URLSearchParams({ tz, fromDate, toDate });
      const res = await apiRequest<DayHeatmapResponse>(
        `/devices/activity-by-day?${qs.toString()}`,
        { accessToken, scopeHeaders, noCache: true },
      );
      setData(res);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load device activity');
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate, accessToken, scopeHeaders]);

  useEffect(() => { load(); }, [load]);

  const devices = data?.devices ?? [];
  const days = data?.days ?? [];
  const maxCell = data?.maxCell ?? 0;
  const dayNum = (d: string) => Number(d.slice(8, 10));
  const isWeekend = (d: string) => { const dow = new Date(d + 'T00:00:00Z').getUTCDay(); return dow === 0 || dow === 6; };

  return (
    <TooltipProvider delayDuration={150}>
    <div className="glass-card border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 rounded-xl">
            <CalendarRange className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-extrabold text-slate-800 dark:text-slate-100 text-sm">Device Activity · by day</h3>
            <p className="text-[10px] text-slate-400 dark:text-slate-500 font-semibold tracking-wider uppercase mt-0.5">
              Punches per device, each day of the month
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => load()}
          className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
          title="Refresh"
        >
          <RefreshCw className={cn('w-3.5 h-3.5 text-slate-500', loading && 'animate-spin')} />
        </button>
      </div>

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
          <p className="text-xs">No device punches this month.</p>
        </div>
      ) : (
        <div className="overflow-x-auto pb-2 -mb-2">
          <div className="min-w-[640px] pr-2">
            {/* Day axis */}
            <div className="flex items-center gap-0.5 pl-[160px] mb-1 transform-gpu translate-z-0 antialiased" style={{ backfaceVisibility: 'hidden' }}>
              {days.map(d => (
                <div key={d} className={cn('flex-1 text-center text-[8px] font-semibold leading-none', isWeekend(d) ? 'text-rose-300' : 'text-slate-400')}>
                  {dayNum(d) % 5 === 0 || dayNum(d) === 1 ? dayNum(d) : ''}
                </div>
              ))}
            </div>
            <div className="space-y-1">
              {devices.map(dev => (
                <div key={dev.deviceCode} className="flex items-center gap-0.5">
                  <div className="w-[160px] pr-2 shrink-0">
                    <div className="text-xs font-bold text-slate-700 dark:text-slate-200 truncate" title={dev.name}>{dev.name}</div>
                    <div className="text-[9px] text-slate-400 font-mono truncate">{dev.deviceCode} · {dev.total} punches</div>
                  </div>
                  {days.map(d => {
                    const count = dev.days[d] ?? 0;
                    const wknd = isWeekend(d);
                    return (
                      <Tooltip key={d}>
                        <TooltipTrigger asChild>
                          <div
                            className={cn(
                              'flex-1 aspect-square min-w-[12px] rounded-[3px] flex items-center justify-center text-[7px] font-bold transition-all will-change-transform hover:scale-110 hover:ring-2 hover:ring-emerald-400/50 cursor-default',
                              cellStyle(count, maxCell),
                              count <= 0 && wknd && 'bg-slate-200/70 dark:bg-slate-800/70',
                            )}
                          >
                            {count > 0 ? count : ''}
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="flex flex-col gap-1.5 p-3 shadow-xl">
                          <div>
                            <div className="font-bold text-slate-100">{dev.name}</div>
                            <div className="text-slate-300 font-medium">{formatDate(d, wknd)}</div>
                          </div>
                          <div>
                            <div className="font-bold text-emerald-400 text-sm">
                              {count.toLocaleString()} punch{count === 1 ? '' : 'es'}
                            </div>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

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

export default DeviceDayHeatmap;
