import { describe, it, expect } from 'vitest';
import { formatYmdInSiteTz, setSiteTimezone } from '../../../../utils/timezone';

describe('Employee Timesheet Attendance Date Parsing (AB#3265)', () => {
  it('correctly parses UTC ISO timestamp into site timezone YYYY-MM-DD instead of previous day slice', () => {
    setSiteTimezone('Asia/Kolkata');

    // 2026-08-09T18:30:00.000Z in UTC corresponds to 2026-08-10 00:00:00 IST
    const utcIsoDate = '2026-08-09T18:30:00.000Z';

    // Before fix: raw .slice(0, 10) yielded '2026-08-09' (shifting the attendance record to previous day)
    expect(utcIsoDate.slice(0, 10)).toBe('2026-08-09');

    // After fix: formatYmdInSiteTz formats to site timezone '2026-08-10'
    const formattedDate = formatYmdInSiteTz(utcIsoDate);
    expect(formattedDate).toBe('2026-08-10');
  });

  it('handles plain YYYY-MM-DD strings without shifting', () => {
    setSiteTimezone('Asia/Kolkata');
    const plainDate = '2026-08-10';
    expect(formatYmdInSiteTz(plainDate)).toBe('2026-08-10');
  });

  it('handles empty or null values gracefully', () => {
    expect(formatYmdInSiteTz(null)).toBe('');
    expect(formatYmdInSiteTz(undefined)).toBe('');
  });
});
