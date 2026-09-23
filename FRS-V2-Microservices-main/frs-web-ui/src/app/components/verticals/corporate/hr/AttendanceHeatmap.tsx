import React, { useMemo, useState } from 'react';
import { cn } from '../../../ui/utils';
import { PunchDetailsModal } from './PunchDetailsModal';

interface Props {
  /** Array of { date: 'YYYY-MM-DD', status: 'present'|'late'|'on-break'|'absent', checkInCount?: number, checkOutCount?: number, checkIn?: string, checkOut?: string } */
  records: Array<{
    date: string;
    status: string;
    checkInCount?: number;
    checkOutCount?: number;
    checkIn?: string;
    checkOut?: string;
  }>;
  days?: number;
  showLegend?: boolean;
}

const STATUS_COLOR: Record<string, string> = {
  present:   'bg-emerald-500',
  'on-break':'bg-blue-400',
  late:      'bg-amber-400',
  absent:    'bg-red-400',
  weekend:   'bg-slate-300 dark:bg-slate-700 text-slate-600 dark:text-slate-300',
  'weekly-off': 'bg-slate-300 dark:bg-slate-700 text-slate-600 dark:text-slate-300',
};

const STATUS_LABEL: Record<string, string> = {
  present:   'Present',
  'on-break': 'On Break',
  late:      'Late',
  absent:    'Absent',
  weekend:   'Weekend',
  'weekly-off': 'Weekly Off',
};

const LEGEND = [
  { key: 'present',   label: 'Present',  color: 'bg-emerald-500' },
  { key: 'late',      label: 'Late',     color: 'bg-amber-400'   },
  { key: 'on-break',  label: 'On Break', color: 'bg-blue-400'    },
  { key: 'absent',    label: 'Absent',   color: 'bg-red-400'     },
  { key: 'weekly-off',label: 'Weekly Off',color: 'bg-slate-300 dark:bg-slate-700' },
  { key: 'future',    label: 'Future',   color: 'bg-slate-100'   },
];

function toLocalDateString(dateInput: string | Date): string {
  if (!dateInput) return '';
  const d = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (isNaN(d.getTime())) return typeof dateInput === 'string' ? dateInput.slice(0, 10) : '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const date = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${date}`;
}

export const AttendanceHeatmap: React.FC<Props> = ({ records, days = 30, showLegend = true }) => {
  const today = toLocalDateString(new Date());
  const [selectedDay, setSelectedDay] = useState<any | null>(null);

  const dayList = useMemo(() => {
    return Array.from({ length: days }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (days - 1 - i));
      return toLocalDateString(d);
    });
  }, [days]);

  const recordMap = useMemo(() => {
    const m = new Map<string, {
      status: string;
      checkInCount: number;
      checkOutCount: number;
      checkIn?: string;
      checkOut?: string;
      allCheckIns: any[];
      allCheckOuts: any[];
    }>();
    records.forEach(r => m.set(r.date, {
      status: r.status,
      checkInCount: r.checkInCount ?? (r.checkIn && r.checkIn !== '—' ? 1 : 0),
      checkOutCount: r.checkOutCount ?? (r.checkOut && r.checkOut !== '—' ? 1 : 0),
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      allCheckIns: (r as any).allCheckIns || (r.checkIn && r.checkIn !== '—' ? [r.checkIn] : []),
      allCheckOuts: (r as any).allCheckOuts || (r.checkOut && r.checkOut !== '—' ? [r.checkOut] : []),
    }));
    return m;
  }, [records]);

  const weeks: string[][] = [];
  for (let i = 0; i < dayList.length; i += 7) {
    weeks.push(dayList.slice(i, i + 7));
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        {weeks.map((week, wi) => (
          <div key={wi} className="flex gap-1.5">
            {week.map(day => {
              const isFuture = day > today;
              const record = recordMap.get(day);
              const dateObj = new Date(day + 'T12:00:00');
              const dow = dateObj.getDay();
              const isWeekend = dow === 0 || dow === 6;

              let effectiveStatus = record?.status ?? (isWeekend ? 'weekly-off' : 'absent');
              if (effectiveStatus === 'absent' && isWeekend) {
                effectiveStatus = 'weekly-off';
              }
              if (effectiveStatus === 'late') {
                effectiveStatus = 'present';
              }

              const colorClass = isFuture ? 'bg-slate-100 text-slate-400' : (STATUS_COLOR[effectiveStatus] ?? 'bg-slate-200 text-white');
              const label = isFuture ? '—' : (STATUS_LABEL[effectiveStatus] ?? effectiveStatus);
              const [, , dd] = day.split('-');
              const monthShort = dateObj.toLocaleString('default', { month: 'short' });
              const dayOfWeekShort = dateObj.toLocaleString('default', { weekday: 'short' });
              
              const checkInInfo = record && record.checkIn && record.checkIn !== '—' ? `\nFirst In: ${record.checkIn}` : '';
              const checkOutInfo = record && record.checkOut && record.checkOut !== '—' ? `\nLast Out: ${record.checkOut}` : '';
              
              const inCount = record ? record.checkInCount : 0;
              const outCount = record ? record.checkOutCount : 0;
              const tooltip = isFuture ? `${day} (${dayOfWeekShort}): Future` : `${day} (${dayOfWeekShort}): ${label}${checkInInfo}${checkOutInfo}\nTotal Punches: ${inCount} In / ${outCount} Out`;

              return (
                <div
                  key={day}
                  title={tooltip}
                  onClick={() => {
                    if (!isFuture) {
                      setSelectedDay({
                        date: day,
                        status: effectiveStatus,
                        checkIn: record?.checkIn || '—',
                        checkOut: record?.checkOut || '—',
                        checkInCount: inCount,
                        checkOutCount: outCount,
                        allCheckIns: record?.allCheckIns || [],
                        allCheckOuts: record?.allCheckOuts || [],
                      });
                    }
                  }}
                  className={cn(
                    'flex-1 rounded-md flex flex-col items-center justify-center py-2 gap-0.5 cursor-pointer transition-all hover:scale-105 active:scale-95 border border-transparent',
                    isFuture && 'opacity-30 cursor-default hover:scale-100',
                    colorClass,
                  )}
                >
                  <span className="text-[9px] font-bold leading-none">{dd}</span>
                  <span className="text-[8px] opacity-80 leading-none">{monthShort} · {dayOfWeekShort}</span>
                  {!isFuture && (
                    <div className="flex flex-col items-center gap-0.5 mt-1 leading-none text-[7px] font-semibold opacity-95">
                      <span>In: {record?.checkIn && record.checkIn !== '—' ? record.checkIn : '—'}</span>
                      <span>Out: {record?.checkOut && record.checkOut !== '—' ? record.checkOut : '—'}</span>
                    </div>
                  )}
                </div>
              );
            })}
            {week.length < 7 && Array.from({ length: 7 - week.length }).map((_, pi) => (
              <div key={`pad-${pi}`} className="flex-1" />
            ))}
          </div>
        ))}
      </div>

      {showLegend && (
        <div className="flex flex-wrap gap-3 pt-1">
          {LEGEND.map(({ key, label, color }) => (
            <span key={key} className="flex items-center gap-1.5 text-xs text-slate-500">
              <span className={cn('w-3 h-3 rounded-sm inline-block', color)} />
              {label}
            </span>
          ))}
        </div>
      )}

      {/* Punch-details modal (shared with the attendance table) */}
      {selectedDay && (
        <PunchDetailsModal day={selectedDay} onClose={() => setSelectedDay(null)} />
      )}
    </div>
  );
};
