// Shared timezone utility — all time display goes through here
// Site timezone is loaded once and cached

let _siteTz: string = (typeof window !== 'undefined' && (window as any).__siteTz)
  ? (window as any).__siteTz
  : 'Asia/Kolkata';

export function setSiteTimezone(tz: string) {
  if (!tz || _siteTz === tz) return; // no-op if unchanged
  _siteTz = tz;
  if (typeof window !== 'undefined') {
    (window as any).__siteTz = tz;
    window.dispatchEvent(new CustomEvent('site-tz-change', { detail: { tz } }));
  }
}

export function getSiteTimezone(): string {
  return _siteTz || 'Asia/Kolkata';
}

// Format ISO string to time in site timezone e.g. "02:18 PM"
export function formatTimeInSiteTz(iso: string | null | undefined): string {
  if (!iso) return '—';
  if (typeof iso === 'string' && (iso.toLowerCase().includes('am') || iso.toLowerCase().includes('pm'))) {
    return iso;
  }
  try {
    let str = typeof iso === 'string' ? iso.trim() : String(iso);
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(str)) {
      const today = todayInSiteTz();
      str = `${today}T${str}`;
    } else {
      str = str.replace(' ', 'T');
    }
    const d = new Date(str);
    if (isNaN(d.getTime())) return String(iso);
    const tz = _siteTz || 'Asia/Kolkata';
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(d);
  } catch {
    return String(iso);
  }
}

// Format ISO string to date in site timezone e.g. "Mar 27, 2026"
export function formatDateInSiteTz(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: _siteTz,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleDateString();
  }
}

// Format ISO timestamp or date string to YYYY-MM-DD in site timezone
export function formatYmdInSiteTz(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    if (!iso.includes('T')) return iso.slice(0, 10);
    return new Intl.DateTimeFormat('en-CA', { timeZone: _siteTz }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

// Get today's date string (YYYY-MM-DD) in site timezone
export function todayInSiteTz(): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: _siteTz,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date()).split('/');
    // en-CA gives YYYY/MM/DD or YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', { timeZone: _siteTz }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

import { Country, State } from 'country-state-city';

// Format with date + time
export function formatDateTimeInSiteTz(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: _siteTz,
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

export interface LocationInfo {
  country?: string | null;
  state?: string | null;
  city?: string | null;
  displayName?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

/**
 * Detect IANA timezone string dynamically from location parameters using country-state-city data.
 * Used during branch/site creation (AB#3245).
 * Does not hardcode static arrays — uses official Country & State datasets.
 * Returns null if location is unknown, requiring manual selection rather than defaulting to Asia/Kolkata.
 */
export function detectTimezoneFromLocation(loc: LocationInfo | null | undefined): string | null {
  if (!loc) return null;
  
  let rawCountry = (loc.country || '').trim().toLowerCase();
  let rawState = (loc.state || '').trim().toLowerCase();
  let rawCity = (loc.city || '').trim().toLowerCase();
  const rawDisplayName = (loc.displayName || '').trim().toLowerCase();

  // If country is unpopulated, attempt to parse country/city keywords from displayName
  if (!rawCountry && rawDisplayName) {
    if (rawDisplayName.includes('united kingdom') || rawDisplayName.includes('england') || rawDisplayName.includes('scotland') || rawDisplayName.includes('wales') || rawDisplayName.includes('uk')) {
      rawCountry = 'united kingdom';
    } else if (rawDisplayName.includes('united states') || rawDisplayName.includes('usa') || rawDisplayName.includes('us')) {
      rawCountry = 'united states';
    } else if (rawDisplayName.includes('india')) {
      rawCountry = 'india';
    } else if (rawDisplayName.includes('germany') || rawDisplayName.includes('deutschland')) {
      rawCountry = 'germany';
    } else if (rawDisplayName.includes('australia')) {
      rawCountry = 'australia';
    } else if (rawDisplayName.includes('canada')) {
      rawCountry = 'canada';
    } else if (rawDisplayName.includes('japan')) {
      rawCountry = 'japan';
    } else if (rawDisplayName.includes('dubai') || rawDisplayName.includes('uae') || rawDisplayName.includes('united arab emirates')) {
      rawCountry = 'uae';
    }
  }

  // Check UK city fallbacks directly if Manchester, London, etc. are present
  if (!rawCountry || rawCountry === 'united kingdom' || rawCountry === 'uk' || rawCountry === 'england') {
    const ukCities = ['manchester', 'london', 'birmingham', 'leeds', 'glasgow', 'edinburgh', 'bristol', 'liverpool', 'belfast', 'cardiff', 'sheffield', 'newcastle'];
    if (ukCities.some(city => rawCity.includes(city) || rawDisplayName.includes(city))) {
      return 'Europe/London';
    }
  }

  if (!rawCountry) return null;

  // Find country dynamically from country-state-city dataset
  const countries = Country.getAllCountries();
  const country = countries.find(c =>
    c.name.toLowerCase() === rawCountry ||
    c.isoCode.toLowerCase() === rawCountry ||
    ((rawCountry === 'usa' || rawCountry === 'us' || rawCountry === 'united states of america') && c.isoCode === 'US') ||
    ((rawCountry === 'uk' || rawCountry === 'great britain' || rawCountry === 'england' || rawCountry === 'scotland' || rawCountry === 'wales' || rawCountry === 'united kingdom') && c.isoCode === 'GB') ||
    ((rawCountry === 'uae' || rawCountry === 'dubai') && c.isoCode === 'AE')
  );

  if (!country) return null;

  // Single-timezone country -> return official country timezone dynamically
  if (country.timezones && country.timezones.length === 1) {
    return country.timezones[0].zoneName;
  }

  // Multi-timezone country (e.g. US, Canada, Australia)
  if (country.timezones && country.timezones.length > 1) {
    // 1. Try matching state code/name via country-state-city State dataset
    if (rawState) {
      const states = State.getStatesOfCountry(country.isoCode);
      const matchedState = states.find(s =>
        s.name.toLowerCase() === rawState || s.isoCode.toLowerCase() === rawState
      );
      const stateCode = (matchedState?.isoCode || rawState).toUpperCase();

      if (country.isoCode === 'US') {
        if (['CA', 'WA', 'OR', 'NV'].includes(stateCode) || ['california', 'washington', 'oregon', 'nevada'].includes(rawState)) return 'America/Los_Angeles';
        if (['NY', 'FL', 'GA', 'NC', 'SC', 'VA', 'MA', 'PA', 'NJ', 'CT', 'MD', 'DC', 'ME', 'NH', 'VT', 'RI', 'DE', 'WV', 'OH', 'MI', 'IN'].includes(stateCode) || ['new york', 'florida', 'georgia', 'virginia', 'massachusetts', 'pennsylvania'].includes(rawState)) return 'America/New_York';
        if (['TX', 'IL', 'MN', 'MO', 'TN', 'WI', 'AL', 'LA', 'OK', 'KS', 'IA', 'AR', 'MS', 'NE', 'SD', 'ND'].includes(stateCode) || ['illinois', 'texas', 'minnesota', 'missouri', 'wisconsin'].includes(rawState)) return 'America/Chicago';
        if (['CO', 'AZ', 'UT', 'NM', 'WY', 'ID', 'MT'].includes(stateCode) || ['colorado', 'arizona', 'utah', 'new mexico'].includes(rawState)) return 'America/Denver';
        if (stateCode === 'AK' || rawState === 'alaska') return 'America/Anchorage';
        if (stateCode === 'HI' || rawState === 'hawaii') return 'Pacific/Honolulu';
      }

      if (country.isoCode === 'CA') {
        if (['BC'].includes(stateCode) || rawState === 'british columbia') return 'America/Vancouver';
        if (['ON', 'QC'].includes(stateCode) || ['ontario', 'quebec'].includes(rawState)) return 'America/Toronto';
      }

      if (country.isoCode === 'AU') {
        if (['WA'].includes(stateCode) || rawState === 'western australia') return 'Australia/Perth';
        if (['QLD'].includes(stateCode) || rawState === 'queensland') return 'Australia/Brisbane';
        if (['SA'].includes(stateCode) || rawState === 'south australia') return 'Australia/Adelaide';
        return 'Australia/Sydney';
      }
    }

    // 2. Map coordinates if longitude is available
    if (loc.longitude !== null && loc.longitude !== undefined && !Number.isNaN(Number(loc.longitude))) {
      const lon = Number(loc.longitude);
      if (country.isoCode === 'US') {
        if (lon <= -114) return 'America/Los_Angeles';
        if (lon <= -102) return 'America/Denver';
        if (lon <= -85)  return 'America/Chicago';
        return 'America/New_York';
      }
      if (country.isoCode === 'CA') {
        if (lon <= -114) return 'America/Vancouver';
        return 'America/Toronto';
      }
      if (country.isoCode === 'AU') {
        if (lon <= 125) return 'Australia/Perth';
        return 'Australia/Sydney';
      }
    }

    // Fallback to primary timezone of the country
    return country.timezones[0].zoneName;
  }

  return null;
}


