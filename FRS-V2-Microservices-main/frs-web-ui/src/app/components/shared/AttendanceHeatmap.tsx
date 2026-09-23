import React, { useState, useMemo } from 'react';
import { Calendar, Info, Flame, Sparkles } from 'lucide-react';
import { cn } from '../ui/utils';

interface HeatmapDataPoint {
  date: string;
  present: number;
  checked_out?: number;
  rate?: number;
}

interface AttendanceHeatmapProps {
  data: HeatmapDataPoint[];
  title?: string;
  maxEmployees?: number;
}

export const AttendanceHeatmap: React.FC<AttendanceHeatmapProps> = ({
  data,
  title = "Attendance Density (Last 30 Days)",
  maxEmployees = 2
}) => {
  const [hoveredDay, setHoveredDay] = useState<HeatmapDataPoint | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  // Fallback to calculate rate if not provided in data
  const normalizedData = useMemo(() => {
    if (!data || data.length === 0) return [];
    
    // Find absolute max present in dataset to avoid division by zero or under-reporting
    const maxPresentInDb = Math.max(...data.map(d => d.present), 1);
    const resolvedMax = Math.max(maxEmployees, maxPresentInDb);

    // Let's create an array of the last 30 days to make sure we don't have gaps
    const datesMap = new Map<string, HeatmapDataPoint>();
    data.forEach(d => {
      datesMap.set(d.date, d);
    });

    const result: HeatmapDataPoint[] = [];
    for (let i = 29; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      
      const existing = datesMap.get(dateStr);
      if (existing) {
        result.push({
          ...existing,
          rate: existing.rate !== undefined ? existing.rate : Math.round((existing.present / resolvedMax) * 100)
        });
      } else {
        // Safe placeholder for days with no records (e.g. weekends with 0 checked in)
        result.push({
          date: dateStr,
          present: 0,
          checked_out: 0,
          rate: 0
        });
      }
    }
    return result;
  }, [data, maxEmployees]);

  // Color mapper based on attendance rate
  const getColorClass = (rate: number = 0) => {
    if (rate === 0) return 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700';
    if (rate <= 25) return 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900';
    if (rate <= 50) return 'bg-emerald-300 dark:bg-emerald-800 text-emerald-900 dark:text-emerald-200 border-emerald-400 dark:border-emerald-700';
    if (rate <= 75) return 'bg-emerald-500 dark:bg-emerald-600 text-white border-emerald-600 dark:border-emerald-500';
    return 'bg-gradient-to-br from-emerald-500 to-indigo-600 dark:from-emerald-600 dark:to-indigo-500 text-white border-emerald-600 dark:border-indigo-600 shadow-sm shadow-emerald-200 dark:shadow-indigo-950';
  };

  const getIntensityLabel = (rate: number = 0) => {
    if (rate === 0) return 'No Attendance';
    if (rate <= 25) return 'Low Attendance';
    if (rate <= 50) return 'Moderate Attendance';
    if (rate <= 75) return 'Optimal Attendance';
    return 'Peak Attendance';
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const tooltipWidth = window.innerWidth < 640 ? 208 : 224;
    
    let x = e.clientX - rect.left + 15;
    if (x + tooltipWidth > rect.width) {
      x = e.clientX - rect.left - tooltipWidth - 15;
    }
    if (x < 0) x = 10;

    setTooltipPos({
      x,
      y: e.clientY - rect.top - 15
    });
  };

  if (!data || data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-8 bg-muted/40/50 rounded-2xl border border-dashed border-slate-200 dark:border-slate-800 text-slate-400">
        <Calendar className="w-8 h-8 mb-2 stroke-1" />
        <p className="text-sm font-medium">No heatmap logs available</p>
      </div>
    );
  }

  // Calculate statistics for the heatmap
  const stats = useMemo(() => {
    const rates = normalizedData.map(d => d.rate || 0);
    const avgRate = rates.reduce((a, b) => a + b, 0) / Math.max(rates.length, 1);
    const peakDay = [...normalizedData].sort((a, b) => b.present - a.present)[0];
    const streak = normalizedData.filter(d => d.present > 0).length;

    return {
      avgRate: Math.round(avgRate),
      peakDay,
      streak
    };
  }, [normalizedData]);

  return (
    <div className="relative overflow-hidden glass-card border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm hover:shadow-md transition-all duration-300">
      
      {/* Top Banner Accent */}
      <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-400 via-teal-500 to-indigo-500" />

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-emerald-50 dark:bg-emerald-950/50 rounded-xl text-emerald-600 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-900/50">
            <Calendar className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
              {title}
              {stats.avgRate >= 75 && (
                <Sparkles className="w-4 h-4 text-amber-500 animate-pulse" />
              )}
            </h3>
            <p className="text-xs text-slate-400 dark:text-slate-500 font-medium">Interactive daily punch density timeline</p>
          </div>
        </div>

        {/* Top Info Badges */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 px-3 py-1 bg-emerald-50/50 dark:bg-emerald-950/20 text-emerald-600 dark:text-emerald-400 rounded-lg text-xs font-semibold border border-emerald-100/50 dark:border-emerald-900/20">
            <Flame className="w-3.5 h-3.5" />
            <span>Avg {stats.avgRate}%</span>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1 bg-indigo-50/50 dark:bg-indigo-950/20 text-indigo-600 dark:text-indigo-400 rounded-lg text-xs font-semibold border border-indigo-100/50 dark:border-indigo-900/20">
            <span>{stats.streak}/30 Active Days</span>
          </div>
        </div>
      </div>

      {/* Grid Container */}
      <div className="relative" onMouseMove={handleMouseMove}>
        {/* Heatmap Grid */}
        <div className="grid grid-cols-10 sm:grid-cols-15 gap-2 sm:gap-2.5 py-4 px-2 bg-slate-50/40 dark:bg-slate-900/40 rounded-xl border border-slate-100 dark:border-slate-800/40">
          {normalizedData.map((d, index) => {
            const colorClass = getColorClass(d.rate);
            const isHovered = hoveredDay?.date === d.date;

            return (
              <div
                key={d.date}
                className={cn(
                  "aspect-square rounded-lg border cursor-pointer transition-all duration-200 relative group flex items-center justify-center font-bold text-xxs sm:text-xs",
                  colorClass,
                  isHovered ? "scale-115 ring-2 ring-indigo-400 dark:ring-indigo-500 ring-offset-2 dark:ring-offset-slate-900 z-10" : "hover:scale-108"
                )}
                onMouseEnter={() => setHoveredDay(d)}
                onMouseLeave={() => setHoveredDay(null)}
              >
                {/* Visual day number inside cell to make it highly informative */}
                <span className="opacity-40 group-hover:opacity-100 transition-opacity">
                  {new Date(d.date).getDate()}
                </span>
              </div>
            );
          })}
        </div>

        {/* Premium Tooltip Container */}
        {hoveredDay && (
          <div
            className="absolute bg-slate-900/95 dark:bg-slate-950/95 backdrop-blur-md text-white text-xs rounded-xl p-3.5 shadow-xl border border-slate-800 z-30 pointer-events-none transition-all duration-75 flex flex-col gap-1.5 w-52 sm:w-56"
            style={{
              left: `${tooltipPos.x}px`,
              top: `${tooltipPos.y}px`,
            }}
          >
            {/* Tooltip Header */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-1.5 mb-1.5">
              <span className="font-bold text-slate-200">{formatDate(hoveredDay.date)}</span>
              {hoveredDay.date === new Date().toISOString().split('T')[0] && (
                <div className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
              )}
            </div>

            {/* Tooltip Content */}
            <div className="flex justify-between items-center text-slate-400">
              <span>Status:</span>
              <span className="font-semibold text-slate-100 text-right">
                {getIntensityLabel(hoveredDay.rate)}
              </span>
            </div>
            
            <div className="flex justify-between items-center text-slate-400">
              <span>Checked In:</span>
              <span className="font-bold text-emerald-400">
                {hoveredDay.present} {hoveredDay.present === 1 ? 'Employee' : 'Employees'}
              </span>
            </div>

            <div className="flex justify-between items-center text-slate-400">
              <span>Checked Out:</span>
              <span className="font-bold text-blue-400">
                {hoveredDay.checked_out ?? 0} {(hoveredDay.checked_out ?? 0) === 1 ? 'Employee' : 'Employees'}
              </span>
            </div>

            <div className="flex justify-between items-center text-slate-400">
              <span>Attendance Rate:</span>
              <span className="font-extrabold text-indigo-300">
                {hoveredDay.rate}%
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Heatmap Footer Legend & Quick Summary */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center sm:justify-between gap-4 mt-6 pt-4 border-t border-slate-100 dark:border-slate-800/60">
        <div className="flex items-center gap-1.5 text-xs text-slate-400 dark:text-slate-500 font-medium">
          <Info className="w-3.5 h-3.5 text-slate-400" />
          <span>Hover over cells to inspect granular punch records.</span>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-2 self-end sm:self-auto">
          <span className="text-xxs uppercase tracking-wider text-slate-400 font-bold">Less</span>
          <div className="flex gap-1">
            <div className="w-3 h-3 rounded-sm bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700" title="0%" />
            <div className="w-3 h-3 rounded-sm bg-emerald-100 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-900" title="1-25%" />
            <div className="w-3 h-3 rounded-sm bg-emerald-300 dark:bg-emerald-800 border border-emerald-400 dark:border-emerald-700" title="26-50%" />
            <div className="w-3 h-3 rounded-sm bg-emerald-500 dark:bg-emerald-600 border border-emerald-600 dark:border-emerald-500" title="51-75%" />
            <div className="w-3 h-3 rounded-sm bg-gradient-to-br from-emerald-500 to-indigo-600 border border-emerald-600 dark:border-indigo-600" title="76-100%" />
          </div>
          <span className="text-xxs uppercase tracking-wider text-slate-400 font-bold">More</span>
        </div>
      </div>

    </div>
  );
};
