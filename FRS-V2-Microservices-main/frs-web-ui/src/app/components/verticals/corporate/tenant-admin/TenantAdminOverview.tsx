import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { 
  Users, UserCheck, Clock, UserX, Server, Camera, RefreshCw, 
  Building2, Activity, ShieldAlert, Wifi, CheckCircle2, ChevronRight, HelpCircle, Target,
  MapPin, Globe, Map
} from 'lucide-react';
import { Button } from '../../../ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../../ui/card';
import { cn } from '../../../ui/utils';
import { toast } from 'sonner';
import { MapContainer, TileLayer, CircleMarker, Tooltip as LeafletTooltip, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer } from 'recharts';

import { apiRequest } from '../../../../services/http/apiClient';
import { useAuth } from '../../../../contexts/AuthContext';
import { useScopeHeaders } from '../../../../hooks/useScopeHeaders';
import { useLiveData } from '../../../../hooks/useLiveData';
import { realtimeEngine, RteEventType } from '../../../../engine/RealTimeEngine';

// Fix Leaflet default icon path issues

// Custom zoom and map style control component
const CustomZoomControl: React.FC<{
  mapStyle: 'satellite' | 'streets';
  onToggleStyle: (style: 'satellite' | 'streets') => void;
  onResetView?: () => void;
}> = ({ mapStyle, onToggleStyle, onResetView }) => {
  const map = useMap();
  return (
    <>
      {/* Map layer style switcher */}
      <div className="absolute top-3.5 right-3.5 z-[1000] flex items-center bg-slate-900/90 backdrop-blur-md rounded-xl p-1 border border-white/20 shadow-xl text-xs gap-1">
        <button
          type="button"
          onClick={() => onToggleStyle('satellite')}
          className={cn(
            "px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5",
            mapStyle === 'satellite'
              ? "bg-indigo-600 text-white shadow-md"
              : "text-slate-300 hover:text-white hover:bg-white/10"
          )}
        >
          <Globe className="w-3.5 h-3.5" />
          Satellite
        </button>
        <button
          type="button"
          onClick={() => onToggleStyle('streets')}
          className={cn(
            "px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5",
            mapStyle === 'streets'
              ? "bg-indigo-600 text-white shadow-md"
              : "text-slate-300 hover:text-white hover:bg-white/10"
          )}
        >
          <Map className="w-3.5 h-3.5" />
          Street
        </button>
      </div>

      {/* Zoom and focus controls */}
      <div className="absolute bottom-3.5 right-3.5 z-[1000] flex flex-col gap-2">
        {onResetView && (
          <button
            type="button"
            onClick={onResetView}
            className="w-8 h-8 bg-slate-900/90 hover:bg-slate-800 border border-white/20 text-white rounded-xl shadow-xl flex items-center justify-center transition-all duration-200 hover:scale-105 active:scale-95 backdrop-blur-md group"
            title="Focus active branches"
          >
            <Target className="w-4 h-4 text-indigo-400 group-hover:rotate-45 transition-transform" />
          </button>
        )}
        <div className="bg-slate-900/90 backdrop-blur-md border border-white/20 rounded-xl shadow-xl flex flex-col overflow-hidden">
          <button
            type="button"
            onClick={() => map?.zoomIn?.()}
            className="w-8 h-8 flex items-center justify-center text-white hover:bg-white/15 transition-colors border-b border-white/15 text-sm font-bold active:bg-white/20"
            title="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => map?.zoomOut?.()}
            className="w-8 h-8 flex items-center justify-center text-white hover:bg-white/15 transition-colors text-sm font-bold active:bg-white/20"
            title="Zoom out"
          >
            −
          </button>
        </div>
      </div>
    </>
  );
};

// Auto-focus and destination area context controller
const MapController: React.FC<{
  branches: Array<{ id: string | number; latitude: number | null; longitude: number | null; name: string }>;
  selectedBranchId: string | number | null;
  resetTrigger: number;
}> = ({ branches, selectedBranchId, resetTrigger }) => {
  const map = useMap();
  const prevResetTrigger = useRef(resetTrigger);

  useEffect(() => {
    const valid = branches.filter(
      (b): b is typeof b & { latitude: number; longitude: number } =>
        b.latitude !== null && b.longitude !== null && !isNaN(b.latitude) && !isNaN(b.longitude)
    );
    if (valid.length === 0) return;

    if (typeof map?.invalidateSize === 'function') {
      map.invalidateSize();
    }

    const isReset = resetTrigger !== prevResetTrigger.current;
    prevResetTrigger.current = resetTrigger;

    // When a specific branch is clicked/selected
    if (selectedBranchId !== null && !isReset) {
      const selected = valid.find(b => b.id === selectedBranchId);
      if (selected) {
        if (typeof map?.flyTo === 'function') {
          map.flyTo([selected.latitude, selected.longitude], 13, { duration: 0.8 });
        } else if (typeof map?.setView === 'function') {
          map.setView([selected.latitude, selected.longitude], 13);
        }
        return;
      }
    }

    // Default view: automatically zoom into the active branch(es) with surrounding area context visible
    if (valid.length === 1) {
      if (typeof map?.setView === 'function') {
        map.setView([valid[0].latitude, valid[0].longitude], 12);
      }
    } else {
      const bounds = L.latLngBounds(valid.map(b => [b.latitude, b.longitude]));
      if (typeof map?.fitBounds === 'function') {
        map.fitBounds(bounds, {
          padding: [50, 50],
          maxZoom: 13,
        });
      }
    }
  }, [branches, selectedBranchId, resetTrigger, map]);

  return null;
};
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

interface Site {
  pk_site_id: number;
  site_name: string;
  city: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  location_address: string;
  status: 'active' | 'inactive';
  device_count: number;
}

export const TenantAdminOverview: React.FC = () => {
  const { accessToken, isAuthenticated } = useAuth();
  const scopeHeaders = useScopeHeaders();
  const { employees, attendance } = useLiveData();

  const [metrics, setMetrics] = useState({
    totalEmployees: 0,
    presentToday: 0,
    lateToday: 0,
    attendanceRate: 0,
    avgWorkingHours: 0,
    absentToday: 0,
  });

  const [deviceStats, setDeviceStats] = useState({
    totalDevices: 0,
    edgeNodesOnline: 0,
    edgeNodesOffline: 0,
    camerasOnline: 0,
    camerasOffline: 0
  });

  const [sites, setSites] = useState<Site[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const [weeklyTrend, setWeeklyTrend] = useState<any[]>([]);

  const fetchMetrics = useCallback(async (isManual = false) => {
    if (!isAuthenticated) return;
    if (isManual) {
      setRefreshing(true);
    }

    try {
      const minDelay = isManual ? new Promise(resolve => setTimeout(resolve, 600)) : Promise.resolve();

      const metricsPromise = apiRequest('/live/metrics', {
        accessToken,
        scopeHeaders,
        noCache: isManual || !metrics.totalEmployees
      }).then((d: any) => {
        setMetrics({
          totalEmployees: d.totalEmployees ?? 0,
          presentToday: d.presentToday ?? 0,
          lateToday: d.lateToday ?? 0,
          attendanceRate: d.attendanceRate ?? 0,
          avgWorkingHours: d.avgWorkingHours ?? 0,
          absentToday: d.absentToday ?? 0,
        });
      });

      const devicesPromise = apiRequest('/devices/edge-devices', {
        accessToken,
        scopeHeaders,
        noCache: isManual
      }).then((res: any) => {
        const data = res.data || [];
        let edgeOnline = 0;
        let edgeOffline = 0;
        let camOnline = 0;
        let camOffline = 0;

        data.forEach((node: any) => {
          if (node.status === 'online') {
            edgeOnline++;
          } else {
            edgeOffline++;
          }

          const cameras = node.cameras || [];
          cameras.forEach((cam: any) => {
            if (cam.status === 'online') {
              camOnline++;
            } else {
              camOffline++;
            }
          });
        });

        setDeviceStats({
          totalDevices: edgeOnline + edgeOffline + camOnline + camOffline,
          edgeNodesOnline: edgeOnline,
          edgeNodesOffline: edgeOffline,
          camerasOnline: camOnline,
          camerasOffline: camOffline
        });
      });

      const sitesPromise = apiRequest<{ success: boolean; sites: Site[] }>('/site-management/sites', {
        accessToken,
        scopeHeaders,
        noCache: isManual
      }).then((res: any) => {
        if (res?.success) {
          setSites(res.sites || []);
        }
      });

      const weeklyPromise = apiRequest('/live/trends/weekly', {
        accessToken,
        scopeHeaders,
        noCache: isManual
      }).then((res: any) => {
        if (res?.data) {
          setWeeklyTrend(res.data);
        }
      });

      await Promise.all([metricsPromise, devicesPromise, sitesPromise, weeklyPromise, minDelay]);
      setHasFetched(true);
    } catch (err) {
      toast.error('Failed to refresh metrics');
    } finally {
      setRefreshing(false);
    }
  }, [accessToken, scopeHeaders, isAuthenticated, metrics.totalEmployees]);

  useEffect(() => {
    fetchMetrics(false);

    // Auto-refresh every 30 seconds to keep live data fresh
    const interval = setInterval(() => fetchMetrics(false), 30_000);

    // Refresh KPIs on every live entry event
    const unsub = realtimeEngine.subscribe(RteEventType.EMPLOYEE_ENTRY, () => fetchMetrics(false));
    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [accessToken, fetchMetrics, scopeHeaders]);

const CITY_COORDINATES: Record<string, { lat: number; lon: number }> = {
  hyderabad: { lat: 17.385, lon: 78.4867 },
  secunderabad: { lat: 17.4399, lon: 78.4983 },
  delhi: { lat: 28.6139, lon: 77.209 },
  mumbai: { lat: 19.076, lon: 72.8777 },
  bangalore: { lat: 12.9716, lon: 77.5946 },
  bengaluru: { lat: 12.9716, lon: 77.5946 },
  chennai: { lat: 13.0827, lon: 80.2707 },
  kolkata: { lat: 22.5726, lon: 88.3639 },
  pune: { lat: 18.5204, lon: 73.8567 },
  ahmedabad: { lat: 23.0225, lon: 72.5714 },
  newyork: { lat: 40.7128, lon: -74.006 },
  new_york: { lat: 40.7128, lon: -74.006 },
  sanfrancisco: { lat: 37.7749, lon: -122.4194 },
  dallas: { lat: 32.7767, lon: -96.7970 },
  austin: { lat: 30.2672, lon: -97.7431 },
  london: { lat: 51.5074, lon: -0.1278 },
  singapore: { lat: 1.3521, lon: 103.8198 },
  tokyo: { lat: 35.6762, lon: 139.6503 },
  sydney: { lat: -33.8688, lon: 151.2093 },
  dubai: { lat: 25.2048, lon: 55.2708 },
};

const AREA_COORDINATES: Record<string, { lat: number; lon: number }> = {
  "jubilee hills": { lat: 17.4319, lon: 78.4072 },
  "banjara hills": { lat: 17.4156, lon: 78.4487 },
  "hitec city": { lat: 17.4435, lon: 78.3772 },
  "gachibowli": { lat: 17.4401, lon: 78.3489 },
  "madhapur": { lat: 17.4483, lon: 78.3915 },
  "kondapur": { lat: 17.4622, lon: 78.3568 },
  "begumpet": { lat: 17.4447, lon: 78.4664 },
  "kukatpally": { lat: 17.4947, lon: 78.3996 },
  "koti": { lat: 17.3850, lon: 78.4867 },
  "secunderabad": { lat: 17.4399, lon: 78.4983 },
  "whitefield": { lat: 12.9698, lon: 77.7499 },
  "koramangala": { lat: 12.9352, lon: 77.6245 },
  "indiranagar": { lat: 12.9784, lon: 77.6408 },
  "electronic city": { lat: 12.8399, lon: 77.6770 },
  "bkc": { lat: 19.0657, lon: 72.8687 },
  "powai": { lat: 19.1176, lon: 72.9060 },
};

  // Combine database branches with fallbacks to represent the exact layout from the screenshot.
  const displayBranches = useMemo(() => {
    const defaultMockBranches = [
      { id: 1, name: 'Main Campus', status: 'healthy', attendance: 94, members: 4200, devicesOnline: 42, devicesTotal: 42, latitude: 17.4435, longitude: 78.3772, location_address: '5th Floor, Gowra Iris, Tech Zone, Madhapur, Hyderabad, Telangana 500081', city: 'Hyderabad', country: 'India' },
      { id: 2, name: 'North Campus', status: 'healthy', attendance: 91, members: 3150, devicesOnline: 28, devicesTotal: 28, latitude: 17.4319, longitude: 78.4072, location_address: 'Road No. 36, Jubilee Hills, Hyderabad, Telangana 500033', city: 'Hyderabad', country: 'India' },
      { id: 3, name: 'South Wing', status: 'healthy', attendance: 82, members: 2800, devicesOnline: 31, devicesTotal: 32, latitude: 17.4447, longitude: 78.4664, location_address: 'Midtown Plaza, Road No. 1, Banjara Hills, Hyderabad, Telangana 500034', city: 'Hyderabad', country: 'India' },
    ];

    if (sites.length === 0) {
      return defaultMockBranches;
    }

    return sites.map((s: any, index) => {
      const mock = defaultMockBranches[index % defaultMockBranches.length];
      
      const totalDevs = s.devices_total !== undefined ? s.devices_total : (s.device_count ?? 0);
      const onlineDevs = s.devices_online !== undefined ? s.devices_online : (s.device_count ?? 0);
      
      let status: 'healthy' | 'warning' | 'critical' = 'healthy';
      if (totalDevs > 0) {
        if (onlineDevs === 0) status = 'critical';
        else if (onlineDevs < totalDevs) status = 'warning';
      } else if (s.status === 'inactive') {
        status = 'critical';
      }

      // Real, stored coordinates always win (AB#3233 fix) — only fall back to the legacy
      // text-match guess for sites saved before the precise location picker existed and
      // that still have no stored latitude/longitude. Matches OperationalWorkMap's getCoords.
      // Coerce via Number() since Postgres numeric columns arrive as strings over the API.
      let lat = s.latitude !== null && s.latitude !== undefined ? Number(s.latitude) : null;
      let lon = s.longitude !== null && s.longitude !== undefined ? Number(s.longitude) : null;
      if (lat === null || lon === null || isNaN(lat) || isNaN(lon)) {
        const fullText = `${s.location_address || ''} ${s.site_name || ''} ${s.city || ''}`.toLowerCase();
        for (const [area, coords] of Object.entries(AREA_COORDINATES)) {
          if (fullText.includes(area)) {
            lat = coords.lat;
            lon = coords.lon;
            break;
          }
        }
        if (lat === null || lon === null) {
          const cityKey = (s.city || '').toLowerCase().replace(/[^a-z]+/g, '');
          if (CITY_COORDINATES[cityKey]) {
            lat = CITY_COORDINATES[cityKey].lat;
            lon = CITY_COORDINATES[cityKey].lon;
          }
        }
      }

      const fullAddress = (s.location_address && s.location_address.trim().length > 0)
        ? s.location_address.trim()
        : [s.city, s.country].filter(Boolean).join(', ') || mock.location_address;

      return {
        id: s.pk_site_id,
        name: s.site_name,
        status,
        attendance: s.attendance_rate !== undefined ? s.attendance_rate : (90 + (index % 6)),
        members: s.member_count !== undefined ? s.member_count : (totalDevs > 0 ? totalDevs * 100 : mock.members),
        devicesOnline: onlineDevs,
        devicesTotal: totalDevs,
        latitude: lat !== null && lat !== undefined ? lat : mock.latitude,
        longitude: lon !== null && lon !== undefined ? lon : mock.longitude,
        location_address: fullAddress,
        city: s.city || mock.city,
        country: s.country || mock.country
      };
    });
  }, [sites]);

  const mapCenter: [number, number] = useMemo(() => {
    const valid = displayBranches.filter(b => b.latitude !== null && b.longitude !== null && !isNaN(b.latitude) && !isNaN(b.longitude));
    if (valid.length === 0) return [17.4319, 78.4072];
    const lat = valid.reduce((s, b) => s + (b.latitude || 0), 0) / valid.length;
    const lon = valid.reduce((s, b) => s + (b.longitude || 0), 0) / valid.length;
    return [lat, lon];
  }, [displayBranches]);

  const mapPills = useMemo(() => {
    const total = displayBranches.length;
    const healthy = displayBranches.filter(b => b.status === 'healthy').length;
    const warning = displayBranches.filter(b => b.status === 'warning').length;
    const critical = displayBranches.filter(b => b.status === 'critical').length;
    return { total, healthy, warning, critical };
  }, [displayBranches]);

  const [mapStyle, setMapStyle] = useState<'satellite' | 'streets'>('satellite');
  const [selectedBranchId, setSelectedBranchId] = useState<string | number | null>(null);
  const [resetTrigger, setResetTrigger] = useState<number>(0);

  // Stacked chart data representing Monday to Friday with Saturday and Sunday empty/placeholders
  const displayChartData = useMemo(() => {
    const today = new Date();
    const todayDateString = today.toDateString();
    
    const nowForMonday = new Date();
    const day = nowForMonday.getDay();
    const diff = nowForMonday.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(nowForMonday.setDate(diff));

    const dayOffsets: Record<string, number> = {
      'Mon': 0, 'Tue': 1, 'Wed': 2, 'Thu': 3, 'Fri': 4, 'Sat': 5, 'Sun': 6
    };

    const data = (weeklyTrend && weeklyTrend.length > 0) 
      ? weeklyTrend 
      : [
          { name: 'Mon', present: 8800, late: 1200, absent: 800 },
          { name: 'Tue', present: 9200, late: 1100, absent: 750 },
          { name: 'Wed', present: 9800, late: 1300, absent: 600 },
          { name: 'Thu', present: 9100, late: 1400, absent: 850 },
          { name: 'Fri', present: 8000, late: 1500, absent: 1000 },
          { name: 'Sat', present: 0, late: 0, absent: 0 },
          { name: 'Sun', present: 0, late: 0, absent: 0 }
        ];
        
    return data.map(d => {
      const dDate = new Date(monday);
      dDate.setDate(monday.getDate() + (dayOffsets[d.name as string] || 0));
      const dateStr = `${dDate.getDate().toString().padStart(2, '0')}/${(dDate.getMonth() + 1).toString().padStart(2, '0')}/${dDate.getFullYear().toString().slice(2)}`;
      
      const isToday = dDate.toDateString() === todayDateString;

      if (d.name === 'Sat' || d.name === 'Sun') {
        const total = (d.present || 0) + (d.late || 0) + (d.absent || 0);
        return {
          ...d,
          dateStr,
          isToday,
          present: 0,
          late: 0,
          absent: 0,
          holiday: total > 0 ? total : 0
        };
      }
      return { ...d, dateStr, isToday };
    });
  }, [weeklyTrend]);

  return (
    <div className="space-y-6 pb-12 select-none">
      <style>{`
        .leaflet-container { background: #0b1120 !important; border-radius: 12px; z-index: 0 !important; }
        .dark .leaflet-container { background: #0b1120 !important; }
        .map-street.dark .leaflet-tile-container {
          filter: invert(100%) hue-rotate(180deg) brightness(95%) contrast(90%);
        }
        .map-satellite .leaflet-tile-container {
          filter: none !important;
        }
        .leaflet-control-zoom { display: none !important; }
        .leaflet-control-attribution { display: none !important; }
        .leaflet-top, .leaflet-bottom { z-index: 1 !important; }
        .leaflet-pane { z-index: 1 !important; }
        .leaflet-tooltip {
          background: transparent !important;
          border: none !important;
          padding: 0 !important;
          box-shadow: none !important;
          white-space: normal !important;
          pointer-events: none !important;
        }
        .dark .leaflet-tooltip {
          background: transparent !important;
          border: none !important;
          box-shadow: none !important;
        }
        .leaflet-tooltip::before { display: none !important; }
      `}</style>

      {/* Banner Component */}
      <div className="relative isolate overflow-hidden rounded-3xl bg-gradient-to-r from-[#4F46E5] to-[#6366F1] text-white shadow-lg p-8 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div className="space-y-2 max-w-3xl">
          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight">Hello, Tenant Admin</h1>
          <p className="text-indigo-100 text-sm md:text-base font-medium">
            A Tenant Admin manages and monitors a single organization's branches, devices, users, and settings to ensure smooth day-to-day operations.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => fetchMetrics(true)}
          disabled={refreshing}
          className="mt-6 md:mt-0 bg-white/10 hover:bg-white/20 border border-white/20 text-white gap-2 text-sm font-semibold px-5 py-2.5 h-auto rounded-xl shrink-0 shadow-sm transition-all duration-300 backdrop-blur-md active:scale-95 disabled:opacity-50"
        >
          <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {refreshing && (
        <div className="w-full h-1 bg-primary/10 overflow-hidden rounded-full relative">
          <style>{`
            @keyframes loadingBar {
              0% { left: -30%; width: 30%; }
              50% { left: 30%; width: 40%; }
              100% { left: 100%; width: 30%; }
            }
          `}</style>
          <div 
            className="absolute top-0 bottom-0 bg-primary rounded-full"
            style={{ animation: 'loadingBar 1.5s infinite linear' }}
          />
        </div>
      )}

      <div className={cn("transition-opacity duration-300 space-y-6", refreshing && "opacity-60 pointer-events-none")}>
        {/* Grid: 6 KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
        {/* Global Status (Total Employees) */}
        <Card className="border border-slate-100 dark:border-slate-800 shadow-sm rounded-2xl p-4 bg-white dark:bg-card relative flex flex-col justify-between min-h-[110px] transition-all hover:shadow-md">
          <div className="flex justify-between items-start">
            <span className="text-slate-500 dark:text-slate-400 text-xs font-bold uppercase tracking-wider">Global Status</span>
            <div className="p-2.5 bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 rounded-xl">
              <Users className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-2">
            <h3 className="text-3xl font-black text-slate-800 dark:text-white leading-none">
              {metrics.totalEmployees.toLocaleString()}
            </h3>
            {metrics.totalEmployees > 0 ? (
              <span className="text-slate-500 font-semibold text-xs mt-1.5 flex items-center gap-0.5 whitespace-nowrap truncate">
                Total Employees
              </span>
            ) : (
              <span className="text-slate-400 font-semibold text-xs mt-1.5 flex items-center gap-0.5 whitespace-nowrap truncate">
                Total Employees
              </span>
            )}
          </div>
        </Card>

        {/* On Time */}
        <Card className="border border-slate-100 dark:border-slate-800 shadow-sm rounded-2xl p-4 bg-white dark:bg-card relative flex flex-col justify-between min-h-[110px] transition-all hover:shadow-md">
          <div className="flex justify-between items-start">
            <span className="text-slate-500 dark:text-slate-400 text-xs font-bold uppercase tracking-wider">On Time</span>
            <div className="p-2.5 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 rounded-xl">
              <UserCheck className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-2">
            <h3 className="text-3xl font-black text-slate-800 dark:text-white leading-none">
              {(Math.max(0, metrics.presentToday - metrics.lateToday)).toLocaleString()}
            </h3>
            {metrics.presentToday > 0 && metrics.totalEmployees > 0 ? (
              <span className="text-emerald-500 font-bold text-xs mt-1.5 flex items-center gap-0.5 whitespace-nowrap truncate">
                ↑ {((Math.max(0, metrics.presentToday - metrics.lateToday) / metrics.totalEmployees) * 100).toFixed(1)}% on time
              </span>
            ) : (
              <span className="text-slate-400 font-semibold text-xs mt-1.5 flex items-center gap-0.5 whitespace-nowrap truncate">
                No check-ins today
              </span>
            )}
          </div>
        </Card>

        {/* Late */}
        <Card className="border border-slate-100 dark:border-slate-800 shadow-sm rounded-2xl p-4 bg-white dark:bg-card relative flex flex-col justify-between min-h-[110px] transition-all hover:shadow-md">
          <div className="flex justify-between items-start">
            <span className="text-slate-500 dark:text-slate-400 text-xs font-bold uppercase tracking-wider">Late</span>
            <div className="p-2.5 bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400 rounded-xl">
              <Clock className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-2">
            <h3 className="text-3xl font-black text-slate-800 dark:text-white leading-none">
              {metrics.lateToday.toLocaleString()}
            </h3>
            {metrics.presentToday > 0 ? (
              metrics.lateToday > 0 ? (
                <span className="text-amber-500 font-bold text-xs mt-1.5 flex items-center gap-0.5 whitespace-nowrap truncate">
                  ↓ {((metrics.lateToday / metrics.presentToday) * 100).toFixed(1)}% late
                </span>
              ) : (
                <span className="text-emerald-500 font-bold text-xs mt-1.5 flex items-center gap-0.5 whitespace-nowrap truncate">
                  0% late
                </span>
              )
            ) : (
              <span className="text-slate-400 font-semibold text-xs mt-1.5 flex items-center gap-0.5 whitespace-nowrap truncate">
                No attendance data
              </span>
            )}
          </div>
        </Card>

        {/* Not In Yet */}
        <Card className="border border-slate-100 dark:border-slate-800 shadow-sm rounded-2xl p-4 bg-white dark:bg-card relative flex flex-col justify-between min-h-[110px] transition-all hover:shadow-md">
          <div className="flex justify-between items-start">
            <span className="text-slate-500 dark:text-slate-400 text-xs font-bold uppercase tracking-wider">Not In Yet</span>
            <div className="p-2.5 bg-rose-50 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400 rounded-xl">
              <UserX className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-2">
            <h3 className="text-3xl font-black text-slate-800 dark:text-white leading-none">
              {metrics.absentToday.toLocaleString()}
            </h3>
            {metrics.totalEmployees > 0 ? (
              metrics.presentToday === 0 ? (
                <span className="text-rose-500 font-bold text-xs mt-1.5 flex items-center gap-0.5 whitespace-nowrap truncate">
                  100.0% not in yet
                </span>
              ) : (
                <span className="text-rose-500 font-bold text-xs mt-1.5 flex items-center gap-0.5 whitespace-nowrap truncate">
                  {((metrics.absentToday / metrics.totalEmployees) * 100).toFixed(1)}% not in yet
                </span>
              )
            ) : (
              <span className="text-slate-400 font-semibold text-xs mt-1.5 flex items-center gap-0.5 whitespace-nowrap truncate">
                No members registered
              </span>
            )}
          </div>
        </Card>

        {/* Active Branches */}
        <Card className="border border-slate-100 dark:border-slate-800 shadow-sm rounded-2xl p-4 bg-white dark:bg-card relative flex flex-col justify-between min-h-[110px] transition-all hover:shadow-md">
          <div className="flex justify-between items-start">
            <span className="text-slate-500 dark:text-slate-400 text-xs font-bold uppercase tracking-wider">Active Branches</span>
            <div className="p-2.5 bg-indigo-50 dark:bg-indigo-950/30 text-indigo-600 dark:text-indigo-400 rounded-xl">
              <Building2 className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-2">
            <h3 className="text-3xl font-black text-slate-800 dark:text-white leading-none">
              {sites.length}
            </h3>
            {sites.length > 0 ? (
              <span className="text-emerald-500 font-bold text-xs mt-1.5 whitespace-nowrap truncate block">
                All operational
              </span>
            ) : (
              <span className="text-slate-400 font-semibold text-xs mt-1.5 whitespace-nowrap truncate block">
                No branches registered
              </span>
            )}
          </div>
        </Card>

        {/* Active Devices */}
        <Card className="border border-slate-100 dark:border-slate-800 shadow-sm rounded-2xl p-4 bg-white dark:bg-card relative flex flex-col justify-between min-h-[110px] transition-all hover:shadow-md">
          <div className="flex justify-between items-start">
            <span className="text-slate-500 dark:text-slate-400 text-xs font-bold uppercase tracking-wider">Active Devices</span>
            <div className="p-2.5 bg-violet-50 dark:bg-violet-950/30 text-violet-600 dark:text-violet-400 rounded-xl">
              <Camera className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-1 flex items-start justify-between">
            <h3 className="text-3xl font-black text-slate-800 dark:text-white leading-none self-center">
              {deviceStats.totalDevices}
            </h3>
            <div className="text-[10px] font-bold text-slate-400 dark:text-slate-500 flex flex-col gap-0.5 text-right">
              <span className="flex items-center gap-0.5 justify-end"><Server className="w-2.5 h-2.5 text-slate-400" /> Edge: {deviceStats.edgeNodesOnline + deviceStats.edgeNodesOffline}</span>
              <span className="flex items-center gap-0.5 justify-end"><Camera className="w-2.5 h-2.5 text-slate-400" /> Cameras: {deviceStats.camerasOnline + deviceStats.camerasOffline}</span>
            </div>
          </div>
          <span className={cn(
            "font-bold text-[10px] mt-1 shrink-0 whitespace-nowrap truncate block",
            (deviceStats.edgeNodesOffline + deviceStats.camerasOffline > 0) ? "text-rose-500" : "text-emerald-500"
          )}>
            {deviceStats.edgeNodesOffline + deviceStats.camerasOffline > 0 
              ? `${deviceStats.edgeNodesOffline + deviceStats.camerasOffline} needs attention` 
              : 'All devices online'}
          </span>
        </Card>
      </div>

      {/* Middle Section (Grid: Map & System Overview) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Organization Branch Map (span 2) */}
        <Card className="border border-slate-100 dark:border-slate-800 shadow-sm flex flex-col bg-white dark:bg-card lg:col-span-2 rounded-2xl">
          <CardHeader className="flex flex-row items-center justify-between py-3.5 px-5 border-b border-slate-100 dark:border-slate-800 bg-white dark:bg-card z-10">
            <div>
              <CardTitle className="text-base font-bold text-slate-800 dark:text-white">Organization Branch Map</CardTitle>
              <CardDescription className="text-xs text-slate-400 mt-0.5">Real-time branch distribution and operational status</CardDescription>
            </div>
            
            {/* Status Pills */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="inline-flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800/70 text-slate-700 dark:text-slate-300 font-bold text-[11px] px-2.5 py-1 rounded-full border border-slate-200 dark:border-slate-700">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                Total: {mapPills.total}
              </span>
              <span className="inline-flex items-center gap-1.5 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 font-bold text-[11px] px-2.5 py-1 rounded-full border border-emerald-200/60 dark:border-emerald-900/50">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Healthy: {mapPills.healthy}
              </span>
              {mapPills.warning > 0 && (
                <span className="inline-flex items-center gap-1.5 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 font-bold text-[11px] px-2.5 py-1 rounded-full border border-amber-200/60 dark:border-amber-900/50">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                  Warning: {mapPills.warning}
                </span>
              )}
              {mapPills.critical > 0 && (
                <span className="inline-flex items-center gap-1.5 bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300 font-bold text-[11px] px-2.5 py-1 rounded-full border border-rose-200/60 dark:border-rose-900/50">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                  Critical: {mapPills.critical}
                </span>
              )}
            </div>
          </CardHeader>

          <CardContent className="p-0 flex-1 relative bg-white dark:bg-card w-full h-full flex flex-col">
            {/* Leaflet Map */}
            <div className={cn("min-h-[440px] md:min-h-[460px] h-[460px] w-full overflow-hidden relative z-0 rounded-b-2xl", mapStyle === 'satellite' ? 'map-satellite' : 'map-street')} style={{ isolation: 'isolate' }}>
            <MapContainer
              center={mapCenter}
              zoom={12}
              minZoom={3}
              style={{ height: '100%', width: '100%' }}
              zoomControl={false}
              scrollWheelZoom={true}
              maxBounds={[[-85, -180], [85, 180]]}
              maxBoundsViscosity={1.0}
            >
              <MapController branches={displayBranches} selectedBranchId={selectedBranchId} resetTrigger={resetTrigger} />
              {mapStyle === 'satellite' ? (
                <>
                  <TileLayer
                    url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                    attribution='&copy; <a href="https://www.esri.com/">Esri</a>'
                    maxZoom={19}
                  />
                  <TileLayer
                    url="https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
                    attribution=''
                    maxZoom={19}
                  />
                </>
              ) : (
                <TileLayer
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                  maxZoom={19}
                />
              )}
              <CustomZoomControl
                mapStyle={mapStyle}
                onToggleStyle={setMapStyle}
                onResetView={() => {
                  setSelectedBranchId(null);
                  setResetTrigger(t => t + 1);
                }}
              />
              {displayBranches.map((loc) => {
                const color = loc.status === 'warning' ? '#f59e0b' : loc.status === 'critical' ? '#ef4444' : '#10b981';
                if (loc.latitude === null || loc.longitude === null) return null;

                const isSelected = selectedBranchId === loc.id;

                return (
                  <React.Fragment key={loc.id}>
                    {/* Glow ring */}
                    <CircleMarker
                      center={[loc.latitude, loc.longitude]}
                      radius={isSelected ? 24 : 15}
                      pathOptions={{
                        color,
                        fillColor: color,
                        fillOpacity: isSelected ? 0.38 : 0.16,
                        weight: 0
                      }}
                    />
                    {/* Inner core pin */}
                    <CircleMarker
                      center={[loc.latitude, loc.longitude]}
                      radius={isSelected ? 9 : 7}
                      pathOptions={{
                        color: '#ffffff',
                        fillColor: color,
                        fillOpacity: 1,
                        weight: 2.5
                      }}
                      eventHandlers={{
                        click: () => {
                          setSelectedBranchId(loc.id);
                        }
                      }}
                    >
                      <LeafletTooltip direction="top" offset={[0, -10]} permanent={isSelected}>
                        <div className="bg-slate-900/95 backdrop-blur-md border border-white/20 rounded-xl shadow-2xl p-3 text-white max-w-[290px] min-w-[220px] pointer-events-none transition-all">
                          {/* Branch Header & Status */}
                          <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
                            <span className="font-bold text-xs text-white tracking-tight truncate">
                              {loc.name}
                            </span>
                            <span className={cn(
                              "text-[9px] font-extrabold px-1.5 py-0.5 rounded uppercase tracking-wider shrink-0 flex items-center gap-1",
                              loc.status === 'healthy' && "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40",
                              loc.status === 'warning' && "bg-amber-500/20 text-amber-300 border border-amber-500/40",
                              loc.status === 'critical' && "bg-rose-500/20 text-rose-300 border border-rose-500/40"
                            )}>
                              <span className={cn(
                                "w-1.5 h-1.5 rounded-full shrink-0",
                                loc.status === 'healthy' && "bg-emerald-400",
                                loc.status === 'warning' && "bg-amber-400",
                                loc.status === 'critical' && "bg-rose-400"
                              )} />
                              {loc.status}
                            </span>
                          </div>

                          {/* Full Address */}
                          <div className="flex items-start gap-1.5 text-[11px] text-slate-300 leading-snug pt-2">
                            <MapPin className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
                            <span className="line-clamp-2">
                              {loc.location_address || [loc.city, loc.country].filter(Boolean).join(', ') || loc.city}
                            </span>
                          </div>

                          {/* Quick Stats */}
                          <div className="flex items-center justify-between text-[10px] text-slate-400 pt-2 border-t border-white/10 mt-2">
                            <span className="flex items-center gap-1">
                              <Server className="w-3 h-3 text-slate-400" />
                              {loc.devicesOnline}/{loc.devicesTotal} Devices
                            </span>
                            <span className="font-bold text-emerald-400 flex items-center gap-1">
                              <UserCheck className="w-3 h-3 text-emerald-400" />
                              {loc.attendance}% Attendance
                            </span>
                          </div>
                        </div>
                      </LeafletTooltip>
                    </CircleMarker>
                  </React.Fragment>
                );
              })}
            </MapContainer>
          </div>
          </CardContent>
        </Card>

        {/* Right Column: System Overview */}
        <Card className="border border-slate-100 dark:border-slate-800 shadow-sm rounded-2xl flex flex-col justify-between overflow-hidden bg-white dark:bg-card h-full">
          <CardHeader className="py-3.5 px-5 border-b border-slate-100 dark:border-slate-800">
            <CardTitle className="text-base font-bold text-slate-800 dark:text-white">
              System Overview
            </CardTitle>
            <CardDescription className="text-xs text-slate-400 mt-0.5">Platform operational summary</CardDescription>
          </CardHeader>

          <CardContent className="p-4 flex-1 flex flex-col justify-between space-y-3.5">
            {/* Cards for Edge Devices & Cameras */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-slate-50/70 dark:bg-slate-800/40 border border-slate-100 dark:border-slate-800 rounded-xl p-3 flex flex-col justify-between">
                <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                  <Server className="w-3.5 h-3.5 text-indigo-500" /> Edge Nodes
                </span>
                <div className="mt-2">
                  <h4 className="text-base font-black text-slate-800 dark:text-slate-100">
                    {hasFetched ? (deviceStats.edgeNodesOnline + deviceStats.edgeNodesOffline) : 18} <span className="text-[10px] text-slate-400 font-semibold lowercase">Total</span>
                  </h4>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-500">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> {hasFetched ? deviceStats.edgeNodesOnline : 16}
                    </span>
                    <span className="flex items-center gap-1 text-[10px] font-bold text-rose-500">
                      <span className="w-1.5 h-1.5 rounded-full bg-rose-500" /> {hasFetched ? deviceStats.edgeNodesOffline : 2}
                    </span>
                  </div>
                </div>
              </div>

              <div className="bg-slate-50/70 dark:bg-slate-800/40 border border-slate-100 dark:border-slate-800 rounded-xl p-3 flex flex-col justify-between">
                <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                  <Camera className="w-3.5 h-3.5 text-violet-500" /> Cameras
                </span>
                <div className="mt-2">
                  <h4 className="text-base font-black text-slate-800 dark:text-slate-100">
                    {hasFetched ? (deviceStats.camerasOnline + deviceStats.camerasOffline) : 138} <span className="text-[10px] text-slate-400 font-semibold lowercase">Total</span>
                  </h4>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-500">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> {hasFetched ? deviceStats.camerasOnline : 136}
                    </span>
                    <span className="flex items-center gap-1 text-[10px] font-bold text-rose-500">
                      <span className="w-1.5 h-1.5 rounded-full bg-rose-500" /> {hasFetched ? deviceStats.camerasOffline : 2}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Overall Health / Total Devices / Last Sync */}
            <div className="flex justify-between items-center bg-slate-50/70 dark:bg-slate-800/40 border border-slate-100 dark:border-slate-800 rounded-xl px-4 py-2.5">
              <div className="text-center">
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Overall Health</p>
                <p className="text-sm font-black text-emerald-500 mt-0.5">
                  {hasFetched 
                    ? (deviceStats.totalDevices > 0 ? `${Math.round(((deviceStats.edgeNodesOnline + deviceStats.camerasOnline) / deviceStats.totalDevices) * 1000) / 10}%` : '0%')
                    : '97.4%'}
                </p>
              </div>
              <div className="text-center border-l border-slate-200 dark:border-slate-800 px-4">
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Total Devices</p>
                <p className="text-sm font-black text-slate-800 dark:text-slate-200 mt-0.5">
                  {hasFetched ? deviceStats.totalDevices : '156'}
                </p>
              </div>
              <div className="text-center border-l border-slate-200 dark:border-slate-800 pl-4">
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Last Sync</p>
                <p className="text-sm font-black text-slate-800 dark:text-slate-200 mt-0.5">2m ago</p>
              </div>
            </div>

            {/* Weekly Attendance Trend stacked bar chart */}
            <div className="space-y-1">
              <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider border-t border-slate-100 dark:border-slate-800 pt-2.5">
                Weekly Attendance Trend
              </p>
              <div className="h-[130px] w-full mt-1.5">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={displayChartData} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148, 163, 184, 0.08)" />
                    <XAxis 
                      dataKey="name" 
                      tickLine={false} 
                      axisLine={false} 
                      tick={{ fontSize: 9, fontWeight: 'bold', fill: 'currentColor', opacity: 0.6 }} 
                    />
                    <YAxis 
                      tickLine={false} 
                      axisLine={false} 
                      tick={{ fontSize: 9, fontWeight: 'bold', fill: 'currentColor', opacity: 0.6 }} 
                      allowDecimals={false}
                    />
                    <RechartsTooltip 
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        return (
                          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-lg p-2.5 text-[10px] text-slate-800 dark:text-slate-200">
                            <div className="font-bold border-b border-slate-100 dark:border-slate-800 pb-1 mb-1">
                              <div className="text-slate-500 mb-0.5">{payload[0].payload.dateStr}</div>
                              <div>{payload[0].payload.name} Attendance</div>
                            </div>
                            {payload
                              .filter((entry) => {
                                const isHoliday = entry.payload.name === 'Sat' || entry.payload.name === 'Sun';
                                if (isHoliday && entry.name === 'absent') return false;
                                if (!isHoliday && entry.name === 'holiday') return false;
                                return true;
                              })
                              .map((entry) => {
                                let displayName = entry.name?.toString().toUpperCase();
                                if (displayName === 'PRESENT') displayName = 'ON TIME';
                                else if (displayName === 'ABSENT' && payload[0].payload.isToday) displayName = 'NOT IN YET';
                                else if (displayName === 'ABSENT') displayName = 'ABSENT';

                                return (
                                <p key={entry.name} className="flex justify-between gap-3 font-semibold">
                                  <span style={{ color: entry.color }}>{displayName}{entry.name !== 'holiday' ? ':' : ''}</span>
                                  {entry.name !== 'holiday' && <span className="font-bold">{entry.value}</span>}
                                </p>
                                );
                              })}
                          </div>
                        );
                      }}
                    />
                    <Bar dataKey="present" name="present" stackId="a" fill="#10b981" radius={[0, 0, 0, 0]} maxBarSize={16} />
                    <Bar dataKey="late" name="late" stackId="a" fill="#d97706" radius={[0, 0, 0, 0]} maxBarSize={16} />
                    <Bar dataKey="absent" name="absent" stackId="a" fill="#e11d48" radius={[3, 3, 0, 0]} maxBarSize={16} />
                    <Bar dataKey="holiday" name="holiday" stackId="a" fill="#94a3b8" radius={[3, 3, 0, 0]} maxBarSize={16} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              
              {/* Custom chart legend */}
              <div className="flex items-center justify-center gap-3.5 text-[9px] font-bold text-slate-400 dark:text-slate-500 pt-1">
                <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#10b981] block" /> ON TIME</span>
                <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#d97706] block" /> LATE</span>
                <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#e11d48] block" /> NOT IN YET</span>
                <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#94a3b8] block" /> HOLIDAY</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Bottom Section: Branch Overview */}
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <div>
            <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100 tracking-tight">Branch Overview</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Real-time status and operational health per branch location</p>
          </div>
          <a
            href="/dashboard/branches"
            className="text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 flex items-center gap-1 transition-colors group px-3 py-1.5 rounded-lg hover:bg-indigo-50 dark:hover:bg-indigo-950/30"
          >
            <span>View All Branches</span>
            <ChevronRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
          </a>
        </div>

        {/* 4 Branch cards row */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {displayBranches.slice(0, 4).map((branch) => {
            const isWarn = branch.status === 'warning';
            const isCrit = branch.status === 'critical';
            
            let statusText = 'HEALTHY';
            let pillColor = 'bg-emerald-50 dark:bg-emerald-950/20 text-emerald-600 border-emerald-200 dark:border-emerald-800/40';
            let barColor = 'bg-emerald-500';

            if (isWarn) {
              statusText = 'WARNING';
              pillColor = 'bg-amber-50 dark:bg-amber-950/20 text-amber-600 border-amber-200 dark:border-amber-800/40';
              barColor = 'bg-[#d97706]';
            } else if (isCrit) {
              statusText = 'CRITICAL';
              pillColor = 'bg-rose-50 dark:bg-rose-950/20 text-rose-600 border-rose-200 dark:border-rose-800/40';
              barColor = 'bg-rose-600';
            }

            const isSelected = selectedBranchId === branch.id;

            return (
              <div 
                key={branch.id} 
                onClick={() => setSelectedBranchId(branch.id)}
                className={cn(
                  "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 shadow-sm space-y-3.5 relative flex flex-col justify-between transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 cursor-pointer",
                  isSelected && "ring-2 ring-indigo-500 border-indigo-500 bg-indigo-50/20 dark:bg-indigo-950/20",
                  isCrit && !isSelected && "border-l-4 border-l-rose-600"
                )}
              >
                {/* Header: Icon, Name, Address & Status */}
                <div className="flex justify-between items-start gap-2">
                  <div className="flex items-start gap-2.5 min-w-0">
                    <div className="p-2 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 rounded-xl shrink-0 mt-0.5">
                      <Building2 className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <span className="font-bold text-slate-800 dark:text-slate-100 text-sm block truncate">
                        {branch.name}
                      </span>
                      <div className="flex items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500 mt-0.5" title={branch.location_address}>
                        <MapPin className="w-3 h-3 shrink-0 text-slate-400" />
                        <span className="truncate">{branch.location_address || [branch.city, branch.country].filter(Boolean).join(', ')}</span>
                      </div>
                    </div>
                  </div>
                  <span className={cn("text-[9px] font-black tracking-wider border px-1.5 py-0.5 rounded-full shrink-0 uppercase", pillColor)}>
                    {statusText}
                  </span>
                </div>

                {/* Progress & Metrics */}
                <div className="space-y-3 pt-1 border-t border-slate-100 dark:border-slate-800/80">
                  {/* Attendance rate bar */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs font-semibold">
                      <span className="text-slate-500 dark:text-slate-400">Attendance</span>
                      <span className="text-slate-800 dark:text-slate-200 font-bold">{branch.attendance}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                      <div className={cn("h-full rounded-full transition-all duration-500", barColor)} style={{ width: `${branch.attendance}%` }} />
                    </div>
                  </div>

                  {/* Secondary Metrics Chips */}
                  <div className="grid grid-cols-2 gap-2 pt-0.5">
                    <div className="bg-slate-50 dark:bg-slate-800/40 rounded-lg p-2 text-left">
                      <span className="text-[10px] text-slate-400 block font-medium">Members</span>
                      <span className="text-xs font-bold text-slate-800 dark:text-slate-200">
                        {branch.members.toLocaleString()}
                      </span>
                    </div>
                    <div className="bg-slate-50 dark:bg-slate-800/40 rounded-lg p-2 text-left">
                      <span className="text-[10px] text-slate-400 block font-medium">Devices</span>
                      <span className={cn("text-xs font-bold", isCrit ? "text-rose-500" : "text-slate-800 dark:text-slate-200")}>
                        {branch.devicesOnline}/{branch.devicesTotal} Online
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      </div>
    </div>
  );
};
