import React, { useMemo, useRef, useEffect } from 'react';
import { MapContainer, TileLayer, CircleMarker, Tooltip, useMap } from 'react-leaflet';
import { Layers, ZoomIn, ZoomOut, Maximize2, Building2, MapPin, Target } from 'lucide-react';
import { cn } from '../ui/utils';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

// Fix default icon path broken by bundlers
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

export interface MapLocation {
  id: string | number;
  name: string;
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  country: string | null;
  location_address?: string | null;
  tenant: string;
  tenant_id?: string;
  edge_node_count: number;
  camera_count: number;
}

interface OperationalWorkMapProps {
  locations: MapLocation[];
  totalSites?: number;
  totalTenants?: number;
  totalEdgeNodes?: number;
  totalCameras?: number;
}

// Distinct color palette for tenant differentiation
const TENANT_COLORS = [
  '#6366f1', // indigo
  '#0ea5e9', // sky
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ec4899', // pink
  '#8b5cf6', // violet
  '#14b8a6', // teal
  '#f97316', // orange
  '#84cc16', // lime
  '#06b6d4', // cyan
];

// Fallback coordinates when location data is missing
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
  manhattan: { lat: 40.7831, lon: -73.9712 },
  sanfrancisco: { lat: 37.7749, lon: -122.4194 },
  san_francisco: { lat: 37.7749, lon: -122.4194 },
  chicago: { lat: 41.8781, lon: -87.6298 },
  losangeles: { lat: 34.0522, lon: -118.2437 },
  london: { lat: 51.5074, lon: -0.1278 },
  singapore: { lat: 1.3521, lon: 103.8198 },
  tokyo: { lat: 35.6762, lon: 139.6503 },
  sydney: { lat: -33.8688, lon: 151.2093 },
  dubai: { lat: 25.2048, lon: 55.2708 },
  berlin: { lat: 52.52, lon: 13.405 },
  paris: { lat: 48.8566, lon: 2.3522 },
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

const getCoords = (loc: MapLocation): [number, number] => {
  const lat = loc.latitude !== null && loc.latitude !== undefined ? Number(loc.latitude) : null;
  const lon = loc.longitude !== null && loc.longitude !== undefined ? Number(loc.longitude) : null;
  if (lat !== null && lon !== null && !isNaN(lat) && !isNaN(lon)) {
    return [lat, lon];
  }
  const fullText = `${loc.location_address || ''} ${loc.name || ''} ${loc.city || ''}`.toLowerCase();
  for (const [area, coords] of Object.entries(AREA_COORDINATES)) {
    if (fullText.includes(area)) {
      return [coords.lat, coords.lon];
    }
  }
  const key = (loc.city || '').toLowerCase().replace(/[^a-z]+/g, '');
  if (CITY_COORDINATES[key]) {
    return [CITY_COORDINATES[key].lat, CITY_COORDINATES[key].lon];
  }
  // Hash-based deterministic scatter for unresolved locations around NY
  const hash = String(loc.id).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return [40.7128 + ((hash % 10) - 5) * 0.02, -74.006 + ((hash * 3 % 10) - 5) * 0.02];
};

const isHQ = (name: string) =>
  name.toLowerCase().includes('headquarter') ||
  name.toLowerCase().includes(' hq') ||
  name.toLowerCase().endsWith('hq');

const MapZoomButtons: React.FC<{
  center: [number, number];
  zoom: number;
  mapStyle: 'satellite' | 'streets';
  onToggleStyle: (style: 'satellite' | 'streets') => void;
}> = ({ center, zoom, mapStyle, onToggleStyle }) => {
  const map = useMap();
  return (
    <>
      {/* Top right map style switcher */}
      <div className="absolute top-4 right-4 z-[1000] flex items-center bg-slate-900/85 backdrop-blur-md rounded-lg p-0.5 border border-white/20 shadow-lg text-xs">
        <button
          type="button"
          onClick={() => onToggleStyle('satellite')}
          className={cn(
            "px-2.5 py-1 rounded-md text-[11px] font-medium transition-all",
            mapStyle === 'satellite'
              ? "bg-indigo-600 text-white shadow-sm font-semibold"
              : "text-slate-300 hover:text-white"
          )}
        >
          Satellite
        </button>
        <button
          type="button"
          onClick={() => onToggleStyle('streets')}
          className={cn(
            "px-2.5 py-1 rounded-md text-[11px] font-medium transition-all",
            mapStyle === 'streets'
              ? "bg-indigo-600 text-white shadow-sm font-semibold"
              : "text-slate-300 hover:text-white"
          )}
        >
          Street
        </button>
      </div>

      <div className="absolute bottom-6 right-6 flex flex-col gap-2 z-[1000]">
        <button
          type="button"
          onClick={() => map.zoomIn()}
          className="w-8 h-8 rounded-xl bg-slate-900/85 hover:bg-slate-800 border border-white/20 shadow-md flex items-center justify-center text-white font-bold text-lg active:scale-95 transition-all backdrop-blur-md"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => map.zoomOut()}
          className="w-8 h-8 rounded-xl bg-slate-900/85 hover:bg-slate-800 border border-white/20 shadow-md flex items-center justify-center text-white font-bold text-lg active:scale-95 transition-all backdrop-blur-md"
        >
          -
        </button>
        <button
          type="button"
          onClick={() => map.setView(center, zoom)}
          className="w-8 h-8 rounded-xl bg-indigo-600 text-white shadow-md flex items-center justify-center hover:bg-indigo-700 active:scale-95 transition-all"
        >
          <Target className="w-4 h-4 text-white" />
        </button>
      </div>
    </>
  );
};

const MapResizer: React.FC = () => {
  const map = useMap();
  
  useEffect(() => {
    if (!map) return;
    const resizeObserver = new ResizeObserver(() => {
      map.invalidateSize();
    });
    
    const container = map.getContainer();
    if (container) {
      resizeObserver.observe(container);
    }
    
    return () => {
      resizeObserver.disconnect();
    };
  }, [map]);
  
  return null;
};

export const OperationalWorkMap: React.FC<OperationalWorkMapProps> = ({ 
  locations = [],
  totalSites,
  totalTenants,
  totalEdgeNodes,
  totalCameras
}) => {
  const mapRef = useRef<L.Map | null>(null);

  // Resolve coordinates for all locations
  const validLocations = useMemo(() => {
    if (!locations || !Array.isArray(locations)) return [];
    return locations
      .map(loc => {
        if (!loc) return null;
        try {
          const coords = getCoords(loc);
          if (!coords || isNaN(coords[0]) || isNaN(coords[1])) {
            return null;
          }
          return { ...loc, coords };
        } catch (e) {
          console.error("Error getting coords for site", loc, e);
          return null;
        }
      })
      .filter((loc): loc is MapLocation & { coords: [number, number] } => loc !== null);
  }, [locations]);

  // Build a per-tenant color map (deterministic — same tenant always gets same color)
  const tenantColorMap = useMemo(() => {
    const tenants = Array.from(new Set(validLocations.map(l => l.tenant))).sort();
    return Object.fromEntries(tenants.map((t, i) => [t, TENANT_COLORS[i % TENANT_COLORS.length]]));
  }, [validLocations]);

  // Calculate initial map center
  const initialCenter: [number, number] = useMemo(() => {
    if (validLocations.length === 0) return [20, 0];
    const avgLat = validLocations.reduce((s, l) => s + l.coords[0], 0) / validLocations.length;
    const avgLon = validLocations.reduce((s, l) => s + l.coords[1], 0) / validLocations.length;
    
    if (isNaN(avgLat) || isNaN(avgLon)) {
      return [20, 0];
    }
    return [avgLat, avgLon];
  }, [validLocations]);

  const initialZoom = validLocations.length === 0 ? 2 : validLocations.length === 1 ? 10 : 4;

  const uniqueTenants = Object.keys(tenantColorMap);
  const [mapStyle, setMapStyle] = useState<'satellite' | 'streets'>('satellite');

  return (
    <div className={cn("relative w-full h-full select-none", mapStyle === 'satellite' ? 'map-satellite' : 'map-street')}>
      <style>{`
        .leaflet-container { background: #0b1120 !important; }
        .dark .leaflet-container { background: #0b1120 !important; }
        .map-street.dark .leaflet-tile-container {
          filter: invert(100%) hue-rotate(180deg) brightness(95%) contrast(90%);
        }
        .map-satellite .leaflet-tile-container {
          filter: none !important;
        }
        .leaflet-control-zoom { display: none !important; }
        .leaflet-control-attribution {
          background: rgba(255, 255, 255, 0.85) !important;
          color: rgba(15, 23, 42, 0.5) !important;
          font-size: 9px !important;
          padding: 2px 6px !important;
        }
        .dark .leaflet-control-attribution {
          background: rgba(15, 23, 42, 0.85) !important;
          color: rgba(248, 250, 252, 0.5) !important;
        }
        .leaflet-control-attribution a { color: #6366f1 !important; }
        .dark .leaflet-control-attribution a { color: #818cf8 !important; }
        .op-tooltip {
          background: rgba(255, 255, 255, 0.99) !important;
          border: 1px solid rgba(226, 232, 240, 1) !important;
          border-radius: 12px !important;
          padding: 10px 14px !important;
          color: #0f172a !important;
          box-shadow: 0 4px 24px rgba(15, 23, 42, 0.1) !important;
          font-size: 12px !important;
          white-space: nowrap;
          pointer-events: none;
          min-width: 220px;
        }
        .dark .op-tooltip {
          background: rgba(15, 23, 42, 0.99) !important;
          border: 1px solid rgba(51, 65, 85, 1) !important;
          color: #f8fafc !important;
          box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5) !important;
        }
        .dark .op-tooltip .text-slate-800 {
          color: #f8fafc !important;
        }
        .dark .op-tooltip .bg-slate-50 {
          background-color: rgba(30, 41, 59, 0.5) !important;
          border-color: rgba(51, 65, 85, 0.5) !important;
        }
        .dark .op-tooltip .text-slate-700 {
          color: #cbd5e1 !important;
        }
        .op-tooltip::before { display: none !important; }
      `}</style>

      <MapContainer
        ref={mapRef}
        center={initialCenter}
        zoom={initialZoom}
        minZoom={2}
        maxBounds={[[-85, -180], [85, 180]]}
        maxBoundsViscosity={1.0}
        style={{ height: '100%', width: '100%' }}
        zoomControl={false}
        attributionControl={true}
        scrollWheelZoom={true}
      >
        <MapResizer />
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

        {/* Site/Branch Markers — one per site in the database */}
        {validLocations.map((loc) => {
          const color = tenantColorMap[loc.tenant] ?? '#6366f1';
          const hq = isHQ(loc.name);
          const isDegraded = loc.edge_node_count > 0 && loc.camera_count === 0;
          const statusColor = isDegraded ? '#d97706' : '#059669';

          return (
            <React.Fragment key={`${loc.id}`}>
              {/* Outer glow ring */}
              <CircleMarker
                center={loc.coords}
                radius={hq ? 22 : 16}
                pathOptions={{
                  color,
                  fillColor: color,
                  fillOpacity: 0.12,
                  weight: 0,
                }}
              />
              {/* Pulsing border ring */}
              <CircleMarker
                center={loc.coords}
                radius={hq ? 14 : 10}
                pathOptions={{
                  color,
                  fillColor: 'transparent',
                  fillOpacity: 0,
                  weight: hq ? 2.5 : 1.5,
                  opacity: 0.5,
                  dashArray: hq ? undefined : '4 4',
                }}
              />
              {/* Inner solid dot */}
              <CircleMarker
                center={loc.coords}
                radius={hq ? 8 : 6}
                pathOptions={{
                  color: 'white',
                  fillColor: color,
                  fillOpacity: 1,
                  weight: 2,
                  opacity: 1,
                }}
              >
                <Tooltip
                  permanent={false}
                  direction="top"
                  offset={[0, -12]}
                  className="op-tooltip"
                >
                  <div>
                    {/* Header row */}
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          {hq && <Building2 className="w-3 h-3 shrink-0" style={{ color }} />}
                          <span className="font-bold text-slate-800 text-xs leading-tight">{loc.name}</span>
                        </div>

                      </div>
                      <span
                        className={cn(
                          'shrink-0 text-[9px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider',
                          isDegraded
                            ? 'bg-amber-50 text-amber-700 border border-amber-200'
                            : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        )}
                      >
                        {isDegraded ? 'WARN' : 'OK'}
                      </span>
                    </div>

                    {/* Metrics grid */}
                    <div className="grid grid-cols-2 gap-1.5 mb-2">
                      <div className="bg-slate-50 rounded-lg p-2 border border-slate-100 text-center">
                        <div className="text-[9px] text-slate-400 uppercase tracking-wider mb-0.5">Edge Nodes</div>
                        <div className="font-bold text-slate-700 text-sm">{loc.edge_node_count}</div>
                      </div>
                      <div className="bg-slate-50 rounded-lg p-2 border border-slate-100 text-center">
                        <div className="text-[9px] text-slate-400 uppercase tracking-wider mb-0.5">Cameras</div>
                        <div className="font-bold text-slate-700 text-sm">{loc.camera_count}</div>
                      </div>
                    </div>

                    {/* Location row */}
                    <div className="flex items-center gap-1.5 text-[10px] text-slate-500 border-t border-slate-100 pt-1.5">
                      <MapPin className="w-3 h-3 text-slate-400 shrink-0" />
                      <span className="truncate">{[loc.city, loc.country].filter(Boolean).join(', ') || 'Location unspecified'}</span>
                    </div>
                  </div>
                </Tooltip>
              </CircleMarker>
            </React.Fragment>
          );
        })}

        <MapZoomButtons center={initialCenter} zoom={initialZoom} mapStyle={mapStyle} onToggleStyle={setMapStyle} />
      </MapContainer>

    </div>
  );
};
