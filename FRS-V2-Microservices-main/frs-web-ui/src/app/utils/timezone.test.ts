import { describe, it, expect } from 'vitest';
import { detectTimezoneFromLocation, formatDateInSiteTz, setSiteTimezone } from './timezone';

describe('detectTimezoneFromLocation (AB#3245)', () => {
  it('returns null for empty or null location', () => {
    expect(detectTimezoneFromLocation(null)).toBeNull();
    expect(detectTimezoneFromLocation(undefined)).toBeNull();
    expect(detectTimezoneFromLocation({})).toBeNull();
  });

  it('detects America/Los_Angeles for San Francisco, California, United States', () => {
    const tz = detectTimezoneFromLocation({
      country: 'United States',
      state: 'California',
      city: 'San Francisco',
      latitude: 37.7749,
      longitude: -122.4194,
    });
    expect(tz).toBe('America/Los_Angeles');
  });

  it('detects America/New_York for New York, United States', () => {
    const tz = detectTimezoneFromLocation({
      country: 'United States',
      state: 'New York',
      city: 'New York',
      latitude: 40.7128,
      longitude: -74.006,
    });
    expect(tz).toBe('America/New_York');
  });

  it('detects America/Chicago for Chicago, Illinois, United States', () => {
    const tz = detectTimezoneFromLocation({
      country: 'USA',
      state: 'Illinois',
      city: 'Chicago',
    });
    expect(tz).toBe('America/Chicago');
  });

  it('detects Europe/London for London, United Kingdom', () => {
    const tz = detectTimezoneFromLocation({
      country: 'United Kingdom',
      city: 'London',
      latitude: 51.5074,
      longitude: -0.1278,
    });
    expect(tz).toBe('Europe/London');
  });

  it('detects Europe/London for Manchester, United Kingdom (AB#3245)', () => {
    expect(detectTimezoneFromLocation({ country: 'United Kingdom', city: 'Manchester' })).toBe('Europe/London');
    expect(detectTimezoneFromLocation({ country: 'UK', city: 'Manchester' })).toBe('Europe/London');
    expect(detectTimezoneFromLocation({ country: 'England', city: 'Manchester' })).toBe('Europe/London');
    expect(detectTimezoneFromLocation({ displayName: 'Manchester, Greater Manchester, England, United Kingdom' })).toBe('Europe/London');
  });

  it('detects Asia/Kolkata for Hyderabad, India', () => {
    const tz = detectTimezoneFromLocation({
      country: 'India',
      state: 'Telangana',
      city: 'Hyderabad',
    });
    expect(tz).toBe('Asia/Kolkata');
  });

  it('detects Asia/Tokyo for Tokyo, Japan', () => {
    const tz = detectTimezoneFromLocation({
      country: 'Japan',
      city: 'Tokyo',
    });
    expect(tz).toBe('Asia/Tokyo');
  });

  it('returns null for an unmapped location without defaulting to Asia/Kolkata', () => {
    const tz = detectTimezoneFromLocation({
      country: 'Fantasyland',
      city: 'UnknownCity',
    });
    expect(tz).toBeNull();
  });
});

describe('formatDateInSiteTz', () => {
  it('formats raw UTC timestamp ISO string to user-friendly site date', () => {
    setSiteTimezone('Asia/Kolkata');
    const result = formatDateInSiteTz('2026-08-04T18:30:00.000Z');
    // In UTC+5:30 (Asia/Kolkata), 2026-08-04T18:30:00Z is 2026-08-05 00:00:00 -> 5 Aug 2026
    expect(result).toContain('2026');
    expect(result).toMatch(/5/);
    expect(result).not.toContain('T18:30');
  });

  it('returns fallback for null or empty input', () => {
    expect(formatDateInSiteTz(null)).toBe('—');
    expect(formatDateInSiteTz(undefined)).toBe('—');
  });
});

