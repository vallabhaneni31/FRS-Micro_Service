import React from "react";
import { LucideIcon } from "lucide-react";
import { cn } from "../ui/utils";

interface MetricCardProps {
  title: string;
  value: string | number;
  icon?: LucideIcon;
  symbol?: string;
  trend?: { value: number; isPositive: boolean; };
  description?: string;
  colorClass?: string;
}

const colorConfig: Record<string, {
  bg: string; iconBg: string; iconColor: string;
  valuColor: string; titleColor: string; border: string;
}> = {
  'text-emerald-500': {
    bg: 'bg-gradient-to-br from-emerald-50 to-green-100 dark:from-emerald-950/40 dark:to-green-900/30',
    iconBg: 'bg-emerald-500', iconColor: 'text-white',
    valuColor: 'text-emerald-700 dark:text-emerald-300',
    titleColor: 'text-emerald-600 dark:text-emerald-400',
    border: 'border-emerald-200 dark:border-emerald-800',
  },
  'text-rose-500': {
    bg: 'bg-gradient-to-br from-rose-50 to-red-100 dark:from-rose-950/40 dark:to-red-900/30',
    iconBg: 'bg-rose-500', iconColor: 'text-white',
    valuColor: 'text-rose-700 dark:text-rose-300',
    titleColor: 'text-rose-600 dark:text-rose-400',
    border: 'border-rose-200 dark:border-rose-800',
  },
  'text-amber-500': {
    bg: 'bg-gradient-to-br from-amber-50 to-yellow-100 dark:from-amber-950/40 dark:to-yellow-900/30',
    iconBg: 'bg-amber-500', iconColor: 'text-white',
    valuColor: 'text-amber-700 dark:text-amber-300',
    titleColor: 'text-amber-600 dark:text-amber-400',
    border: 'border-amber-200 dark:border-amber-800',
  },
  'text-violet-500': {
    bg: 'bg-gradient-to-br from-violet-50 to-purple-100 dark:from-violet-950/40 dark:to-purple-900/30',
    iconBg: 'bg-violet-500', iconColor: 'text-white',
    valuColor: 'text-violet-700 dark:text-violet-300',
    titleColor: 'text-violet-600 dark:text-violet-400',
    border: 'border-violet-200 dark:border-violet-800',
  },
  'text-indigo-500': {
    bg: 'bg-gradient-to-br from-indigo-50 to-blue-100 dark:from-indigo-950/40 dark:to-blue-900/30',
    iconBg: 'bg-indigo-500', iconColor: 'text-white',
    valuColor: 'text-indigo-700 dark:text-indigo-300',
    titleColor: 'text-indigo-600 dark:text-indigo-400',
    border: 'border-indigo-200 dark:border-indigo-800',
  },
  'text-blue-500': {
    bg: 'bg-gradient-to-br from-blue-50 to-sky-100 dark:from-blue-950/40 dark:to-sky-900/30',
    iconBg: 'bg-blue-500', iconColor: 'text-white',
    valuColor: 'text-blue-700 dark:text-blue-300',
    titleColor: 'text-blue-600 dark:text-blue-400',
    border: 'border-blue-200 dark:border-blue-800',
  },
  'text-teal-500': {
    bg: 'bg-gradient-to-br from-teal-50 to-cyan-100 dark:from-teal-950/40 dark:to-cyan-900/30',
    iconBg: 'bg-teal-500', iconColor: 'text-white',
    valuColor: 'text-teal-700 dark:text-teal-300',
    titleColor: 'text-teal-600 dark:text-teal-400',
    border: 'border-teal-200 dark:border-teal-800',
  },
  'text-orange-500': {
    bg: 'bg-gradient-to-br from-orange-50 to-amber-100 dark:from-orange-950/40 dark:to-amber-900/30',
    iconBg: 'bg-orange-500', iconColor: 'text-white',
    valuColor: 'text-orange-700 dark:text-orange-300',
    titleColor: 'text-orange-600 dark:text-orange-400',
    border: 'border-orange-200 dark:border-orange-800',
  },
  'text-blue-600': {
    bg: 'glass-card',
    iconBg: 'bg-blue-50 dark:bg-blue-900/20', iconColor: 'text-blue-600',
    valuColor: 'text-slate-800 dark:text-white',
    titleColor: 'text-blue-600',
    border: 'border-slate-100 dark:border-slate-800',
  },
  'text-emerald-600': {
    bg: 'glass-card',
    iconBg: 'bg-emerald-50 dark:bg-emerald-900/20', iconColor: 'text-emerald-600',
    valuColor: 'text-slate-800 dark:text-white',
    titleColor: 'text-emerald-600',
    border: 'border-slate-100 dark:border-slate-800',
  },
  'text-rose-600': {
    bg: 'glass-card',
    iconBg: 'bg-rose-50 dark:bg-rose-900/20', iconColor: 'text-rose-600',
    valuColor: 'text-slate-800 dark:text-white',
    titleColor: 'text-rose-600',
    border: 'border-slate-100 dark:border-slate-800',
  },
  'text-amber-600': {
    bg: 'glass-card',
    iconBg: 'bg-amber-50 dark:bg-amber-900/20', iconColor: 'text-amber-600',
    valuColor: 'text-slate-800 dark:text-white',
    titleColor: 'text-amber-600',
    border: 'border-slate-100 dark:border-slate-800',
  },
  'text-violet-600': {
    bg: 'glass-card',
    iconBg: 'bg-violet-50 dark:bg-violet-900/20', iconColor: 'text-violet-600',
    valuColor: 'text-slate-800 dark:text-white',
    titleColor: 'text-violet-600',
    border: 'border-slate-100 dark:border-slate-800',
  },
  'text-indigo-600': {
    bg: 'glass-card',
    iconBg: 'bg-indigo-50 dark:bg-indigo-900/20', iconColor: 'text-indigo-600',
    valuColor: 'text-slate-800 dark:text-white',
    titleColor: 'text-indigo-600',
    border: 'border-slate-100 dark:border-slate-800',
  },
  'text-red-600': {
    bg: 'glass-card',
    iconBg: 'bg-red-50 dark:bg-red-900/20', iconColor: 'text-red-600',
    valuColor: 'text-slate-800 dark:text-white',
    titleColor: 'text-red-600',
    border: 'border-slate-100 dark:border-slate-800',
  },
  'text-slate-600': {
    bg: 'glass-card',
    iconBg: 'bg-slate-50 dark:bg-slate-800/50', iconColor: 'text-slate-600',
    valuColor: 'text-slate-800 dark:text-white',
    titleColor: 'text-slate-600',
    border: 'border-slate-100 dark:border-slate-800',
  },
};

const defaultConfig = {
  bg: 'bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-800/40 dark:to-slate-700/30',
  iconBg: 'bg-slate-500', iconColor: 'text-white',
  valuColor: 'text-slate-800 dark:text-slate-100',
  titleColor: 'text-slate-500 dark:text-slate-400',
  border: 'border-slate-200 dark:border-slate-700',
};

export const MetricCard: React.FC<MetricCardProps> = ({
  title, value, icon: Icon, symbol, trend, description, colorClass,
}) => {
  const cfg = colorClass ? (colorConfig[colorClass] || defaultConfig) : defaultConfig;
  const displayValue = typeof value === "string" && value.includes("NaN")
    ? value.replace(/NaN/gi, "0") : value;

  return (
    <div className={cn(
      "rounded-2xl border p-4 flex flex-col justify-between",
      "hover:shadow-lg transition-all duration-300 hover:-translate-y-0.5",
      cfg.bg, cfg.border
    )}>
      {/* Top row: title + icon */}
      <div className="flex items-start justify-between mb-3">
        <p className={cn("text-xs font-semibold uppercase tracking-wider", cfg.titleColor)}>
          {title}
        </p>
        <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center shadow-sm flex-shrink-0", cfg.iconBg)}>
          {symbol ? (
            <span className="text-lg">{symbol}</span>
          ) : Icon ? (
            <Icon className={cn("w-5 h-5", cfg.iconColor)} />
          ) : null}
        </div>
      </div>

      {/* Value */}
      <div>
        <p className={cn("text-3xl font-bold tracking-tight leading-none", cfg.valuColor)}>
          {displayValue}
        </p>
        {description && !trend && (
          <p className={cn("text-xs font-medium mt-1.5", cfg.titleColor)}>
            {description}
          </p>
        )}
      </div>

      {/* Trend */}
      {trend && (
        <div className="flex items-center gap-1 mt-2">
          <span className={cn(
            "text-xs font-semibold",
            trend.isPositive ? "text-emerald-600" : "text-rose-600"
          )}>
            {trend.isPositive ? "↑" : "↓"} {Math.abs(trend.value)}%
          </span>
          <span className={cn("text-xs", cfg.titleColor)}>vs last period</span>
        </div>
      )}
    </div>
  );
};
