import React, { useEffect, useMemo, useState } from 'react';
import { cn } from '../../../ui/utils';
import { Camera, RefreshCw } from 'lucide-react';
import { apiRequest } from '../../../../services/http/apiClient';
import { useAuth } from '../../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { getSiteTimezone } from '../../../../utils/timezone';

interface CameraRow {
  deviceCode: string;
  name: string;
  total: number;
  hours: number[]; // 24 slots, punch count per hour-of-day
}

interface PresenceResponse {
  tz: string;
  date: string;
  maxCell: number;
  totalPunches: number;
  activeHours: number;
  cameras: CameraRow[];
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => (h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`);

function cellStyle(count: number, maxCell: number): string {
  if (count <= 0) return 'bg-slate-100 dark:bg-slate-800/40 text-transparent';
  const ratio = maxCell > 0 ? count / maxCell : 0;
  if (ratio > 0.8) return 'bg-teal-600 text-white';
  if (ratio > 0.6) return 'bg-teal-500 text-white';
  if (ratio > 0.4) return 'bg-teal-400 text-teal-950';
  if (ratio > 0.2) return 'bg-teal-300 text-teal-900';
  return 'bg-teal-200 text-teal-900';
}

function formatDuration(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

interface Props {
  employeeId: number;
  employeeName?: string;
  date: string; // YYYY-MM-DD
}

export const CameraPresenceHeatmap: React.FC<Props> = ({ employeeId, employeeName, date }) => {
  const { accessToken } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const [data, setData] = useState<PresenceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useMemo(() => async () => {
    if (!employeeId || !date) return;
    setLoading(true);
    setError(null);
    try {
      const tz = getSiteTimezone();
      const qs = new URLSearchParams({ employeeId: String(employeeId), date, tz });
      const res = await apiRequest<PresenceResponse>(
        `/devices/employee-camera-heatmap?${qs.toString()}`,
        { accessToken, scopeHeaders, noCache: true },
      );
      setData(res);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load camera presence');
    } finally {
      setLoading(false);
    }
  }, [employeeId, date, accessToken, scopeHeaders]);

  useEffect(() => { load(); }, [load]);

  const cameras = data?.cameras ?? [];
  const totalHours = data?.activeHours ?? 0;

  return (
    <div className="glass-card border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-teal-50 dark:bg-teal-950/40 text-teal-600 dark:text-teal-400 rounded-xl">
            <Camera className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-extrabold text-slate-800 dark:text-slate-100 text-sm">
              Time in Region
              {totalHours > 0 && (
                <span className="ml-2 text-teal-600 dark:text-teal-400">
                  · {formatDuration(totalHours)}
                </span>
              )}
              {employeeName && (
                <span className="ml-1 text-slate-400 font-semibold">({employeeName})</span>
              )}
            </h3>
            <p className="text-[10px] text-slate-400 dark:text-slate-500 font-semibold tracking-wider uppercase mt-0.5">
              Detections per camera by hour of day
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
      ) : cameras.length === 0 ? (
        <div className="flex flex-col items-center gap-2 text-slate-400 py-10">
          <Camera className="w-6 h-6 opacity-40" />
          <p className="text-xs">No camera events for this employee on this day.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[640px]">
            {/* Hour axis */}
            <div className="flex items-center gap-1 pl-[160px] mb-1">
              {HOURS.map(h => (
                <div key={h} className="flex-1 text-center text-[8px] font-semibold text-slate-400 leading-none">
                  {h % 3 === 0 ? hourLabel(h) : ''}
                </div>
              ))}
            </div>
            {/* Camera rows */}
            <div className="space-y-1">
              {cameras.map(cam => (
                <div key={cam.deviceCode} className="flex items-center gap-1">
                  <div className="w-[160px] pr-2 shrink-0">
                    <div className="text-xs font-bold text-slate-700 dark:text-slate-200 truncate" title={cam.name}>
                      {cam.name}
                    </div>
                    <div className="text-[9px] text-slate-400 font-mono truncate">
                      {cam.deviceCode} · {cam.total} event{cam.total !== 1 ? 's' : ''}
                    </div>
                  </div>
                  {cam.hours.map((count, h) => (
                    <div
                      key={h}
                      title={count > 0 ? `${hourLabel(h)}: ${count} detection${count !== 1 ? 's' : ''}` : undefined}
                      className={cn(
                        'flex-1 h-7 rounded flex items-center justify-center text-[9px] font-bold transition-colors',
                        cellStyle(count, data?.maxCell ?? 1),
                      )}
                    >
                      {count > 0 ? count : ''}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            {/* Legend */}
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-100 dark:border-slate-800">
              <span className="text-[9px] text-slate-400 font-semibold">Less</span>
              {['bg-teal-100', 'bg-teal-200', 'bg-teal-300', 'bg-teal-400', 'bg-teal-600'].map(c => (
                <div key={c} className={cn('w-4 h-4 rounded', c)} />
              ))}
              <span className="text-[9px] text-slate-400 font-semibold">More</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
