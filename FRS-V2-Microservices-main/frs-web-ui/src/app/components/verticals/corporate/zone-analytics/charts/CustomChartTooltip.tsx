import React from 'react';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Sparkles,
  Info,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';

export type TooltipBadgeVariant =
  | 'indigo'
  | 'emerald'
  | 'amber'
  | 'rose'
  | 'cyan'
  | 'purple'
  | 'slate'
  | 'blue';

export interface TooltipMetric {
  label: string;
  value: string | number;
  unit?: string;
  change?: string | number;
  changeType?: 'positive' | 'negative' | 'neutral';
  color?: string; // hex or tailwind text color
  dotColor?: string;
  icon?: React.ComponentType<{ className?: string }>;
  subtext?: string;
}

export interface CustomChartTooltipProps {
  active?: boolean;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  badge?: {
    text: string;
    variant?: TooltipBadgeVariant;
  };
  icon?: React.ComponentType<{ className?: string }>;
  metrics?: TooltipMetric[];
  progress?: {
    label?: string;
    value: number; // 0-100
    displayValue?: string;
    color?: string;
  };
  footerNote?: React.ReactNode;
  accentColor?: string;
  minWidth?: string;
  className?: string;
}

const BADGE_STYLES: Record<TooltipBadgeVariant, string> = {
  indigo: 'bg-indigo-950/80 text-indigo-300 border-indigo-700/60',
  emerald: 'bg-emerald-950/80 text-emerald-300 border-emerald-700/60',
  amber: 'bg-amber-950/80 text-amber-300 border-amber-700/60',
  rose: 'bg-rose-950/80 text-rose-300 border-rose-700/60',
  cyan: 'bg-cyan-950/80 text-cyan-300 border-cyan-700/60',
  purple: 'bg-purple-950/80 text-purple-300 border-purple-700/60',
  slate: 'bg-slate-800/80 text-slate-300 border-slate-700',
  blue: 'bg-blue-950/80 text-blue-300 border-blue-700/60',
};

export const CustomChartTooltip: React.FC<CustomChartTooltipProps> = ({
  active = true,
  title,
  subtitle,
  badge,
  icon: Icon,
  metrics = [],
  progress,
  footerNote,
  accentColor,
  minWidth = 'min-w-[220px]',
  className = '',
}) => {
  if (!active) return null;

  return (
    <div
      className={`bg-slate-900/95 text-white p-3.5 rounded-xl shadow-2xl border border-slate-700/80 backdrop-blur-md text-xs pointer-events-none select-none animate-in fade-in zoom-in-95 duration-150 ${minWidth} ${className}`}
      style={{
        boxShadow:
          '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5)',
      }}
    >
      {/* Accent strip if specified */}
      {accentColor && (
        <div
          className="h-1 -mx-3.5 -mt-3.5 mb-3 rounded-t-xl"
          style={{ backgroundColor: accentColor }}
        />
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-3 pb-2 mb-2 border-b border-slate-800">
        <div className="flex items-start gap-2 min-w-0">
          {Icon && (
            <div className="p-1 rounded-md bg-slate-800 text-slate-300 shrink-0 mt-0.5">
              <Icon className="w-3.5 h-3.5" />
            </div>
          )}
          <div className="min-w-0">
            <div className="font-bold text-slate-100 text-xs tracking-tight truncate flex items-center gap-1.5">
              <span>{title}</span>
            </div>
            {subtitle && (
              <div className="text-[10px] text-slate-400 mt-0.5 truncate font-medium">
                {subtitle}
              </div>
            )}
          </div>
        </div>

        {badge && (
          <span
            className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border shrink-0 ${
              BADGE_STYLES[badge.variant || 'indigo']
            }`}
          >
            {badge.text}
          </span>
        )}
      </div>

      {/* Metrics List */}
      {metrics.length > 0 && (
        <div className="space-y-1.5 py-0.5">
          {metrics.map((m, idx) => {
            const MetricIcon = m.icon;
            return (
              <div
                key={idx}
                className="flex items-center justify-between gap-3 py-0.5"
              >
                <div className="flex items-center gap-1.5 text-slate-300 text-xs">
                  {m.dotColor && (
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: m.dotColor }}
                    />
                  )}
                  {MetricIcon && (
                    <MetricIcon className="w-3 h-3 text-slate-400 shrink-0" />
                  )}
                  <span className="font-normal">{m.label}</span>
                </div>

                <div className="flex items-center gap-1.5 text-right shrink-0">
                  <span
                    className={`font-mono font-bold text-xs ${
                      m.color ? '' : 'text-slate-100'
                    }`}
                    style={m.color ? { color: m.color } : undefined}
                  >
                    {m.value}
                    {m.unit && (
                      <span className="text-[10px] text-slate-400 ml-0.5 font-normal">
                        {m.unit}
                      </span>
                    )}
                  </span>

                  {m.change !== undefined && (
                    <span
                      className={`inline-flex items-center text-[10px] font-mono font-semibold px-1 rounded ${
                        m.changeType === 'positive'
                          ? 'text-emerald-400 bg-emerald-950/60'
                          : m.changeType === 'negative'
                          ? 'text-rose-400 bg-rose-950/60'
                          : 'text-slate-400 bg-slate-800'
                      }`}
                    >
                      {m.changeType === 'positive' && (
                        <TrendingUp className="w-2.5 h-2.5 mr-0.5 inline" />
                      )}
                      {m.changeType === 'negative' && (
                        <TrendingDown className="w-2.5 h-2.5 mr-0.5 inline" />
                      )}
                      {m.change}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Progress Bar (if provided) */}
      {progress && (
        <div className="mt-2.5 pt-2 border-t border-slate-800/80">
          <div className="flex items-center justify-between text-[10px] mb-1">
            <span className="text-slate-400">{progress.label || 'Peak share'}</span>
            <span className="font-mono font-semibold text-slate-200">
              {progress.displayValue || `${Math.round(progress.value)}%`}
            </span>
          </div>
          <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${Math.min(100, Math.max(0, progress.value))}%`,
                backgroundColor: progress.color || '#6366F1',
              }}
            />
          </div>
        </div>
      )}

      {/* Footer Note */}
      {footerNote && (
        <div className="mt-2 pt-2 border-t border-slate-800/80 text-[10px] text-slate-400 flex items-center gap-1.5 leading-tight">
          <Info className="w-3 h-3 text-slate-500 shrink-0" />
          <div className="truncate">{footerNote}</div>
        </div>
      )}
    </div>
  );
};

export interface FloatingTooltipPosition {
  x: number;
  y: number;
}

export interface InteractiveFloatingTooltipProps extends CustomChartTooltipProps {
  position: FloatingTooltipPosition | null;
  visible: boolean;
}

/**
 * Floating tooltip component positioned at absolute mouse/screen coordinates
 * with auto-viewport clamping to prevent overflow off the screen.
 */
export const InteractiveFloatingTooltip: React.FC<InteractiveFloatingTooltipProps> = ({
  position,
  visible,
  ...tooltipProps
}) => {
  if (!visible || !position) return null;

  // Clamping within screen bounds
  const x = Math.min(Math.max(16, position.x + 14), window.innerWidth - 280);
  const y = Math.max(16, position.y - 12);

  return (
    <div
      className="fixed z-50 pointer-events-none transition-transform duration-75 ease-out"
      style={{
        left: `${x}px`,
        top: `${y}px`,
      }}
    >
      <CustomChartTooltip {...tooltipProps} active={true} />
    </div>
  );
};
