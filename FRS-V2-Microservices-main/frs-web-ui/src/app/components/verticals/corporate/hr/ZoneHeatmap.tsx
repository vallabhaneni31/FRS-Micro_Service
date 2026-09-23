import React, { useEffect, useMemo, useState } from 'react';
import { cn } from '../../../ui/utils';
import { MapPin, RefreshCw, Users, TrendingUp, ChevronDown, Building2 } from 'lucide-react';
import { apiRequest } from '../../../../services/http/apiClient';
import { useAuth } from '../../../../contexts/AuthContext';
import { useScopeHeaders, buildScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { getSiteTimezone } from '../../../../utils/timezone';

interface ZoneRow {
  zone: string;
  zoneType: 'work' | 'break' | 'other' | 'unassigned';
  zoneLabel: string | null;
  total: number;
  uniqueEmployees: number;
  hours: number[]; // 24 slots — unique employee count per hour-of-day
}

interface ZoneHeatmapResponse {
  tz: string;
  date: string | null;
  maxCell: number;
  zones: ZoneRow[];
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) =>
  h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`;

// Short badge labels that fit narrow tiles
const ZONE_BADGE: Record<string, string> = {
  work:       'Work',
  break:      'Break',
  other:      'Other',
  unassigned: 'N/A',
};

// Per zone-type color themes
const ZONE_THEME: Record<string, {
  tileBg:   (intensity: number) => string;
  border:   string;
  badge:    string;
  badgeText:string;
  barFill:  string;
  glow:     string;
  accent:   string; // for the bottom bar (inactive tiles use this too)
}> = {
  work: {
    tileBg:    (i) => i > 0.75 ? 'bg-emerald-500' : i > 0.5 ? 'bg-emerald-400' : i > 0.25 ? 'bg-emerald-200 dark:bg-emerald-900/50' : 'bg-white dark:bg-slate-900',
    border:    'border-emerald-200 dark:border-emerald-800',
    badge:     'bg-emerald-600',
    badgeText: 'text-white',
    barFill:   'bg-emerald-500',
    glow:      'shadow-emerald-200 dark:shadow-emerald-900/40',
    accent:    'bg-emerald-400',
  },
  break: {
    tileBg:    (i) => i > 0.75 ? 'bg-amber-400' : i > 0.5 ? 'bg-amber-300' : i > 0.25 ? 'bg-amber-100 dark:bg-amber-900/40' : 'bg-white dark:bg-slate-900',
    border:    'border-amber-200 dark:border-amber-800',
    badge:     'bg-amber-500',
    badgeText: 'text-white',
    barFill:   'bg-amber-400',
    glow:      'shadow-amber-200 dark:shadow-amber-900/40',
    accent:    'bg-amber-300',
  },
  other: {
    tileBg:    (i) => i > 0.75 ? 'bg-sky-500' : i > 0.5 ? 'bg-sky-300' : i > 0.25 ? 'bg-sky-100 dark:bg-sky-900/40' : 'bg-white dark:bg-slate-900',
    border:    'border-sky-200 dark:border-sky-800',
    badge:     'bg-sky-600',
    badgeText: 'text-white',
    barFill:   'bg-sky-400',
    glow:      'shadow-sky-200 dark:shadow-sky-900/40',
    accent:    'bg-sky-300',
  },
  unassigned: {
    tileBg:    (i) => i > 0.75 ? 'bg-slate-500' : i > 0.5 ? 'bg-slate-300' : i > 0.25 ? 'bg-slate-200 dark:bg-slate-700/60' : 'bg-white dark:bg-slate-900',
    border:    'border-slate-200 dark:border-slate-700',
    badge:     'bg-slate-500',
    badgeText: 'text-white',
    barFill:   'bg-slate-400',
    glow:      'shadow-slate-200 dark:shadow-slate-900/40',
    accent:    'bg-slate-300',
  },
};

function textColor(intensity: number) {
  return intensity > 0.5 ? 'text-white' : 'text-slate-800 dark:text-slate-100';
}
function subColor(intensity: number) {
  return intensity > 0.5 ? 'text-white/70' : 'text-slate-500 dark:text-slate-400';
}

// Mini sparkline — 6 am → 10 pm window
function Sparkline({ hours, barFill, intensity, hasActivity }: {
  hours: number[];
  barFill: string;
  intensity: number;
  hasActivity: boolean;
}) {
  const slice = hours.slice(6, 22);
  const max   = Math.max(...slice, 1);
  const fill  = intensity > 0.5 ? 'bg-white/50' : barFill;
  const empty = intensity > 0.5 ? 'bg-white/15' : 'bg-slate-200 dark:bg-slate-600/40';

  return (
    <div className="flex items-end gap-px h-6 w-full">
      {slice.map((v, i) => (
        <div
          key={i}
          title={v > 0 ? `${hourLabel(i + 6)}: ${v}` : undefined}
          className={cn('flex-1 rounded-sm transition-all', v > 0 ? fill : empty)}
          style={{ height: hasActivity ? (v > 0 ? `${Math.max(20, Math.round((v / max) * 100))}%` : '15%') : '15%' }}
        />
      ))}
    </div>
  );
}

// Hourly bar-chart detail panel shown when a tile is clicked
function ZoneDetailPanel({ zone, maxCell }: { zone: ZoneRow; maxCell: number }) {
  const theme     = ZONE_THEME[zone.zoneType] ?? ZONE_THEME.unassigned;
  const peakHour  = zone.hours.indexOf(Math.max(...zone.hours));
  // If activity exists outside 6am-9pm (e.g. 4am peak), display all 24 hours so bars match peak label
  const hasOffHoursActivity = zone.hours.some((v, h) => v > 0 && (h < 6 || h >= 22));
  const displayHours = hasOffHoursActivity ? HOURS : HOURS.slice(6, 22);
  const maxBar    = Math.max(...zone.hours, 1);

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/60 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className="text-xs font-extrabold text-slate-700 dark:text-slate-200 truncate max-w-[60%]">
          {zone.zone}
        </span>
        {zone.hours[peakHour] > 0 && (
          <span className="text-[10px] text-slate-400">
            Peak <span className="font-bold text-slate-600 dark:text-slate-300">
              {hourLabel(peakHour)} · {zone.hours[peakHour]} emp
            </span>
          </span>
        )}
      </div>

      {zone.total === 0 ? (
        <p className="text-[11px] text-slate-400 text-center py-4">No activity recorded today for this zone.</p>
      ) : (
        <>
          {/* Axis labels */}
          <div className="flex gap-px">
            {displayHours.map(h => (
              <div key={h} className="flex-1 text-center text-[8px] text-slate-400 font-semibold">
                {h % 3 === 0 ? hourLabel(h) : ''}
              </div>
            ))}
          </div>
          {/* Bars */}
          <div className="flex items-end gap-px h-16">
            {displayHours.map(h => {
              const v   = zone.hours[h];
              const pct = Math.max(v > 0 ? 8 : 0, Math.round((v / maxBar) * 100));
              return (
                <div key={h} className="flex-1 flex flex-col items-center justify-end h-full">
                  <div
                    title={v > 0 ? `${hourLabel(h)}: ${v} emp` : undefined}
                    className={cn('w-full rounded-t transition-all', v > 0 ? theme.barFill : 'bg-slate-200 dark:bg-slate-700/50')}
                    style={{ height: `${pct}%` }}
                  />
                </div>
              );
            })}
          </div>
          {/* Value labels */}
          <div className="flex gap-px">
            {displayHours.map(h => (
              <div key={h} className="flex-1 text-center text-[7px] text-slate-400 font-mono">
                {zone.hours[h] > 0 ? zone.hours[h] : ''}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface Props {
  date?: string;
  bizHoursOnly?: boolean;
  title?: string;
}

export const ZoneHeatmap: React.FC<Props> = ({
  date,
  bizHoursOnly = true,
  title = 'Zone Activity Heatmap',
}) => {
  const { accessToken, activeScope, sites, verticalLabel } = useAuth();
  const scopeHeaders     = useScopeHeaders();
  const [data, setData]  = useState<ZoneHeatmapResponse | null>(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [selectedZone, setSelectedZone] = useState<string | null>(null);

  // Local drill-down filter — only meaningful (and only shown) while the
  // portal-wide site pill is on "All Sites". Once a specific site is picked
  // up top, this section just follows that. The header filter only appears
  // once a site has been chosen from the centre prompt; showing a second, independently
  // overridable filter next to it invited exactly the confusion where the
  // two disagreed (pill said IVIS, this said "All sites").
  const [siteOverride, setSiteOverride] = useState('');
  const siteLbl = verticalLabel('Site', 'Campus');
  const globalSiteId = activeScope?.siteId || '';
  const showLocalFilter = !globalSiteId && sites.length > 0;
  const effectiveSiteId = globalSiteId || siteOverride || undefined;
  // On "All Sites" with no drill-down picked yet, there's no single site to
  // scope this section to — show a prompt to pick one instead of silently
  // aggregating across every site (which is what caused the cross-site
  // zone-leak confusion this whole thread started from).
  const needsSiteSelection = showLocalFilter && !siteOverride;

  const effectiveHeaders = useMemo(() => {
    if (!activeScope) return scopeHeaders;
    return buildScopeHeaders({ ...activeScope, siteId: effectiveSiteId });
  }, [activeScope, scopeHeaders, effectiveSiteId]);

  const load = useMemo(() => async () => {
    if (needsSiteSelection) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const tz = getSiteTimezone();
      const qs = new URLSearchParams({ tz });
      if (date) qs.set('date', date);
      const res = await apiRequest<ZoneHeatmapResponse>(
        `/devices/zone-heatmap?${qs.toString()}`,
        { accessToken, scopeHeaders: effectiveHeaders, noCache: true },
      );
      setData(res);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load zone heatmap');
    } finally {
      setLoading(false);
    }
  }, [date, accessToken, effectiveHeaders, needsSiteSelection]);

  useEffect(() => { load(); }, [load]);

  const zones = data?.zones ?? [];

  const maxZoneEmployees = useMemo(
    () => Math.max(...zones.map(z => z.uniqueEmployees), 1),
    [zones],
  );

  const totalPings  = zones.reduce((s, z) => s + z.total, 0);
  // Count of zones configured for the selected scope (matches the Tenant
  // Admin Portal's "Zone Groups" count) — not "had a ping today", which
  // undercounts on quiet days and reads as broken when e.g. 3 zones are
  // configured but only 1 has seen traffic yet.
  const activeZones = zones.length;
  const busiest     = zones.find(z => z.uniqueEmployees > 0); // first with activity

  const selectedZoneData = zones.find(z => z.zone === selectedZone) ?? null;

  return (
    <div className="glass-card border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4 flex flex-col">

      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 rounded-xl">
            <MapPin className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-extrabold text-slate-800 dark:text-slate-100 text-sm">{title}</h3>
            <p className="text-[10px] text-slate-400 dark:text-slate-500 font-semibold tracking-wider uppercase mt-0.5">
              Click a zone to see hourly breakdown
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {showLocalFilter && !needsSiteSelection && (
            <div className="relative">
              <Building2 className="w-3 h-3 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
              <select
                aria-label={`Filter by ${siteLbl.toLowerCase()}`}
                value={siteOverride}
                onChange={(e) => setSiteOverride(e.target.value)}
                title={`Filter this section by ${siteLbl.toLowerCase()}`}
                className="text-[10px] font-bold rounded-lg border border-slate-200 dark:border-slate-700 bg-white/70 dark:bg-slate-900/70 pl-6 pr-2 py-1.5 max-w-[130px] truncate appearance-none cursor-pointer"
              >
                <option value="">All {siteLbl.toLowerCase()}s</option>
                {sites.map(site => (
                  <option key={site.id} value={site.id}>{site.name}</option>
                ))}
              </select>
            </div>
          )}
          <button
            type="button"
            onClick={() => load()}
            className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors shrink-0"
            title="Refresh"
          >
            <RefreshCw className={cn('w-3.5 h-3.5 text-slate-500', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* ── Summary strip ── */}
      {zones.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {[
            { icon: <MapPin className="w-3.5 h-3.5" />, value: String(activeZones), label: 'Active zones' },
            { icon: <Users className="w-3.5 h-3.5" />,  value: String(totalPings),  label: 'Total pings'  },
            { icon: <TrendingUp className="w-3.5 h-3.5" />, value: busiest?.zone ?? '—', label: 'Busiest zone', truncate: true },
          ].map(({ icon, value, label, truncate }) => (
            <div key={label} className="rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-700/50 px-3 py-2.5 flex items-center gap-2 min-w-0">
              <span className="text-slate-400 shrink-0">{icon}</span>
              <div className="min-w-0">
                <div
                  className={cn('text-xs font-black text-slate-800 dark:text-slate-100', truncate && 'truncate')}
                  title={truncate ? value : undefined}
                >
                  {value}
                </div>
                <div className="text-[9px] text-slate-400 font-semibold uppercase tracking-wide whitespace-nowrap">{label}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Body ── */}
      {needsSiteSelection ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-5 text-slate-400 py-16">
          <MapPin className="w-14 h-14 opacity-30" />
          <p className="text-base font-semibold text-slate-500 dark:text-slate-300">
            Select a {siteLbl.toLowerCase()} to view its zone activity
          </p>
          <select
            aria-label={`Select ${siteLbl.toLowerCase()}`}
            value={siteOverride}
            onChange={(e) => setSiteOverride(e.target.value)}
            className="text-sm font-bold rounded-xl border border-slate-200 dark:border-slate-700 bg-white/70 dark:bg-slate-900/70 px-4 py-3 min-w-[260px] cursor-pointer"
          >
            <option value="" disabled>Choose a {siteLbl.toLowerCase()}…</option>
            {sites.map(site => (
              <option key={site.id} value={site.id}>{site.name}</option>
            ))}
          </select>
        </div>

      ) : error ? (
        <div className="text-center text-xs text-rose-500 py-8">{error}</div>

      ) : loading && !data ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3" aria-busy="true">
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => (
            <div key={i} className="animate-pulse rounded-2xl bg-slate-100 dark:bg-slate-800 min-h-[156px]" />
          ))}
        </div>

      ) : zones.length === 0 ? (
        <div className="flex flex-col items-center gap-2 text-slate-400 py-10">
          <MapPin className="w-7 h-7 opacity-30" />
          <p className="text-xs font-semibold">No zone data available.</p>
          <p className="text-[10px] text-slate-400 max-w-xs text-center">
            Assign a zone_label or location_label to devices in the device registry.
          </p>
        </div>

      ) : (
        <>
          {/* Zone tile grid — full-width responsive, uniform height rows */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {zones.map(zone => {
              const theme       = ZONE_THEME[zone.zoneType] ?? ZONE_THEME.unassigned;
              const hasActivity = zone.uniqueEmployees > 0;
              const intensity   = hasActivity ? zone.uniqueEmployees / maxZoneEmployees : 0;
              const tileBg      = theme.tileBg(intensity);
              const textCls     = textColor(intensity);
              const subCls      = subColor(intensity);
              const isSelected  = selectedZone === zone.zone;
              const peakHour    = zone.hours.indexOf(Math.max(...zone.hours));

              return (
                <button
                  key={zone.zone}
                  type="button"
                  onClick={() => setSelectedZone(isSelected ? null : zone.zone)}
                  className={cn(
                    'relative text-left rounded-2xl border p-4 flex flex-col gap-1.5 transition-all duration-200',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                    'min-h-[156px]',
                    tileBg,
                    theme.border,
                    hasActivity && intensity > 0.25 ? `shadow-md ${theme.glow}` : 'shadow-sm',
                    !hasActivity && 'opacity-70',
                    isSelected  && 'ring-2 ring-offset-1 ring-current scale-[1.02] shadow-lg',
                    !isSelected && 'hover:scale-[1.01] hover:shadow-md hover:opacity-100',
                  )}
                >
                  {/* Row 1: badge + expand icon */}
                  <div className="flex items-center justify-between gap-1">
                    <span className={cn(
                      'inline-block px-2 py-0.5 rounded-full text-[9px] font-extrabold uppercase tracking-wider shrink-0',
                      theme.badge, theme.badgeText,
                    )}>
                      {ZONE_BADGE[zone.zoneType] ?? zone.zoneType}
                    </span>
                    {isSelected && <ChevronDown className={cn('w-3.5 h-3.5 shrink-0', textCls)} />}
                  </div>

                  {/* Row 2: zone name — single line with tooltip for full name */}
                  <div
                    className={cn('text-[13px] font-extrabold leading-tight line-clamp-2', textCls)}
                    title={zone.zone}
                  >
                    {zone.zone}
                  </div>

                  {/* Row 3: employee count + pings — pushed to bottom */}
                  <div className={cn('flex items-baseline gap-1.5 mt-auto', subCls)}>
                    <span className={cn('text-2xl font-black leading-none tabular-nums', textCls)}>
                      {zone.uniqueEmployees}
                    </span>
                    <div className="text-[9px] font-semibold leading-tight">
                      <div>visited</div>
                      <div>{zone.total} pings</div>
                    </div>
                  </div>

                  {/* Row 4: sparkline */}
                  <Sparkline
                    hours={zone.hours}
                    barFill={theme.barFill}
                    intensity={intensity}
                    hasActivity={hasActivity}
                  />

                  {/* Row 5: peak hour or "no activity" note */}
                  <div className={cn('text-[9px] font-semibold', subCls)}>
                    {hasActivity && zone.hours[peakHour] > 0
                      ? `Peak ${hourLabel(peakHour)}`
                      : 'No activity today'}
                  </div>

                  {/* Bottom accent bar */}
                  <div className="absolute bottom-0 left-0 right-0 h-[3px] rounded-b-2xl overflow-hidden">
                    <div
                      className={cn(theme.accent, 'h-full transition-all duration-500')}
                      style={{ width: hasActivity ? `${Math.max(4, Math.round(intensity * 100))}%` : '100%', opacity: hasActivity ? 0.7 : 0.2 }}
                    />
                  </div>
                </button>
              );
            })}
          </div>

          {/* Expanded hourly detail panel */}
          {selectedZoneData && (
            <ZoneDetailPanel zone={selectedZoneData!} maxCell={data?.maxCell ?? 1} />
          )}

          {/* Legend */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-3 border-t border-slate-100 dark:border-slate-800">
            {Object.entries(ZONE_THEME).map(([type, t]) => (
              <div key={type} className="flex items-center gap-1.5">
                <span className={cn('inline-block w-2.5 h-2.5 rounded-sm', t.badge)} />
                <span className="text-[9px] text-slate-500 dark:text-slate-400 font-semibold capitalize">
                  {ZONE_BADGE[type] ?? type}
                </span>
              </div>
            ))}
            <div className="ml-auto flex items-center gap-1.5 text-[9px] text-slate-400 font-semibold">
              <span>Low</span>
              <div className="flex gap-0.5">
                {['opacity-20', 'opacity-40', 'opacity-60', 'opacity-80', 'opacity-100'].map(o => (
                  <div key={o} className={cn('w-3 h-3 rounded-sm bg-slate-400', o)} />
                ))}
              </div>
              <span>High</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
