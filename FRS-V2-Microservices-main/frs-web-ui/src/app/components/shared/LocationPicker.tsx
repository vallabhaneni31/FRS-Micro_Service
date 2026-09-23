import React, { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, ZoomControl } from 'react-leaflet';
import type { LeafletEvent } from 'leaflet';
import L from 'leaflet';
import { Search, Loader2, MapPin } from 'lucide-react';
import { Input } from '../ui/input';
import { cn } from '../ui/utils';
import 'leaflet/dist/leaflet.css';

// Fix default marker icon path broken by bundlers (same fix used by OperationalWorkMap.tsx)
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const SEARCH_DEBOUNCE_MS = 700;
const MIN_QUERY_LENGTH = 3;

export interface PickedLocation {
  latitude: number;
  longitude: number;
  displayName: string;
  /** Derived from Nominatim's address breakdown — city/town/village/suburb, first non-empty. */
  city?: string;
  /** Derived from Nominatim's address breakdown. */
  state?: string;
  /** Derived from Nominatim's address breakdown. */
  country?: string;
}

interface NominatimAddress {
  road?: string;
  house_number?: string;
  suburb?: string;
  neighbourhood?: string;
  city?: string;
  town?: string;
  village?: string;
  state?: string;
  country?: string;
  postcode?: string;
}

interface NominatimResult {
  place_id: number | string;
  display_name: string;
  lat: string;
  lon: string;
  /** Present because we request addressdetails=1 — used to auto-fill city/state/country. */
  address?: NominatimAddress;
}

interface LocationPickerProps {
  /** Existing latitude, e.g. when editing a site that already has a real, saved pin. */
  initialLatitude?: number | null;
  /** Existing longitude, e.g. when editing a site that already has a real, saved pin. */
  initialLongitude?: number | null;
  /** Existing label to preload the search box with (usually the saved address). */
  initialDisplayName?: string | null;
  /** Fired whenever the admin picks/moves the pin — the source of truth for the parent form. */
  onLocationSelected: (location: PickedLocation) => void;
  className?: string;
}

/**
 * Search-and-pin location picker (AB#3233 permanent fix).
 *
 * Lets an admin search for a building/place name via the free Nominatim
 * geocoder, pick the exact result, then fine-tune the pin by dragging it on
 * an inline Leaflet map. Replaces the old city/area text-matching guess —
 * the coordinates this component reports are always an explicit, precise
 * choice made by the admin (search selection or manual drag), never a guess.
 */
export const LocationPicker: React.FC<LocationPickerProps> = ({
  initialLatitude = null,
  initialLongitude = null,
  initialDisplayName = null,
  onLocationSelected,
  className,
}) => {
  const [query, setQuery] = useState(initialDisplayName || '');
  const [isFocused, setIsFocused] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [position, setPosition] = useState<PickedLocation | null>(() => {
    // Postgres `numeric` columns come back from the API as strings (node-postgres
    // doesn't auto-convert numeric to float), so initialLatitude/initialLongitude
    // can arrive as "17.4319" rather than 17.4319 despite the `number | null` type —
    // coerce before storing, matching the pattern already used in OperationalWorkMap.tsx.
    const lat = initialLatitude !== null && initialLatitude !== undefined ? Number(initialLatitude) : null;
    const lon = initialLongitude !== null && initialLongitude !== undefined ? Number(initialLongitude) : null;
    if (lat === null || lon === null || Number.isNaN(lat) || Number.isNaN(lon)) return null;
    return {
      latitude: lat,
      longitude: lon,
      displayName: initialDisplayName || `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    };
  });
  const markerRef = useRef<L.Marker | null>(null);
  const [mapStyle, setMapStyle] = useState<'satellite' | 'streets'>('satellite');

  // Debounced search — only fires while the input is focused, 600-800ms after typing stops.
  useEffect(() => {
    if (!isFocused) return;
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setShowDropdown(false);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&q=${encodeURIComponent(trimmed)}`
        );
        const data = await res.json();
        setResults(Array.isArray(data) ? data : []);
        setShowDropdown(true);
      } catch (err) {
        console.error('Nominatim search failed', err);
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, isFocused]);

  const handleSelectResult = (result: NominatimResult) => {
    const latitude = parseFloat(result.lat);
    const longitude = parseFloat(result.lon);
    if (isNaN(latitude) || isNaN(longitude)) return;

    const addr = result.address;
    // Fallback chain: Nominatim doesn't guarantee `city` — a lot of results only carry
    // `town`/`village`/`suburb` depending on how OSM tagged the place.
    const city = addr?.city || addr?.town || addr?.village || addr?.suburb || undefined;
    const state = addr?.state || undefined;
    const country = addr?.country || undefined;

    const picked: PickedLocation = { latitude, longitude, displayName: result.display_name, city, state, country };
    setPosition(picked);
    setQuery(result.display_name);
    setShowDropdown(false);
    setResults([]);
    onLocationSelected(picked);
  };

  const handleDragEnd = (event: LeafletEvent) => {
    const marker = event.target as L.Marker;
    const latlng = marker.getLatLng();
    const picked: PickedLocation = {
      latitude: latlng.lat,
      longitude: latlng.lng,
      displayName: position?.displayName || query.trim() || 'Custom pin location',
      // A drag is a fine-tune of an already-picked location, not a new search —
      // carry forward whatever address fields the last search/selection resolved.
      city: position?.city,
      state: position?.state,
      country: position?.country,
    };
    setPosition(picked);
    onLocationSelected(picked);
  };

  return (
    <div className={cn('space-y-2', className)}>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
        <Input
          placeholder="Search building, place name, or landmark…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          className="pl-9 pr-9"
        />
        {isSearching && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 animate-spin" />
        )}

        {showDropdown && results.length > 0 && (
          <div
            className="absolute left-0 right-0 mt-1 max-h-60 overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-lg z-[2000]"
            // Prevent the input's blur (which would hide this dropdown) from firing before the click registers.
            onMouseDown={(e) => e.preventDefault()}
          >
            {results.map((result) => (
              <button
                key={result.place_id}
                type="button"
                onClick={() => handleSelectResult(result)}
                className="w-full text-left px-3 py-2 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 border-b border-slate-100 dark:border-slate-800 last:border-b-0 flex items-start gap-2"
              >
                <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                <span className="truncate">{result.display_name}</span>
              </button>
            ))}
          </div>
        )}

        {showDropdown && !isSearching && results.length === 0 && query.trim().length >= MIN_QUERY_LENGTH && (
          <div className="absolute left-0 right-0 mt-1 px-3 py-2 text-xs text-slate-400 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-lg z-[2000]">
            No matching places found
          </div>
        )}
      </div>

      {position ? (
        <div className="rounded-lg overflow-hidden border border-slate-200 dark:border-slate-800 relative" style={{ height: 220 }}>
          {/* Layer switcher */}
          <div className="absolute top-2 right-2 z-[1000] flex items-center bg-slate-900/85 backdrop-blur-md rounded-lg p-0.5 border border-white/20 shadow-md text-xs">
            <button
              type="button"
              onClick={() => setMapStyle('satellite')}
              className={cn(
                "px-2 py-0.5 rounded text-[10px] font-medium transition-all",
                mapStyle === 'satellite'
                  ? "bg-indigo-600 text-white shadow-sm font-semibold"
                  : "text-slate-300 hover:text-white"
              )}
            >
              Satellite
            </button>
            <button
              type="button"
              onClick={() => setMapStyle('streets')}
              className={cn(
                "px-2 py-0.5 rounded text-[10px] font-medium transition-all",
                mapStyle === 'streets'
                  ? "bg-indigo-600 text-white shadow-sm font-semibold"
                  : "text-slate-300 hover:text-white"
              )}
            >
              Street
            </button>
          </div>
          <MapContainer
            center={[position.latitude, position.longitude]}
            zoom={17}
            zoomControl={false}
            style={{ height: '100%', width: '100%' }}
            scrollWheelZoom={false}
          >
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
            <ZoomControl position="bottomright" />
            <Marker
              ref={markerRef}
              position={[position.latitude, position.longitude]}
              draggable
              eventHandlers={{ dragend: handleDragEnd }}
            />
          </MapContainer>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-slate-200 dark:border-slate-800 p-3 text-[11px] text-slate-400 flex items-center gap-2">
          <MapPin className="w-3.5 h-3.5 shrink-0" />
          Search above and pick a result to drop a precise pin.
        </div>
      )}

      {position && (
        <p className="text-[10px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
          <MapPin className="w-3 h-3 text-emerald-500 shrink-0" />
          Pin set at {position.latitude.toFixed(5)}°, {position.longitude.toFixed(5)}° — drag the marker to fine-tune.
        </p>
      )}
    </div>
  );
};
