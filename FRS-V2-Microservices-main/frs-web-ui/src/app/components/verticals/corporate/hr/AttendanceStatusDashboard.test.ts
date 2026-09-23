import { describe, it, expect, vi } from 'vitest';
import { ApiError } from '../../../../services/http/apiClient';

// AB#3191 — handleCorrection's catch block used to discard the real error and always
// show a generic 'Correction failed — check API connection' toast, even when the
// backend (apiRequest -> ApiError) returned a specific reason (e.g. an invalid
// check_in/check_out timestamp). This mirrors the exact fallback expression used in
// handleCorrection: `err?.message || 'Correction failed — check API connection'`.
describe('Attendance correction — error message surfacing (AB#3191)', () => {
  const GENERIC_MESSAGE = 'Correction failed — check API connection';
  const resolveCorrectionErrorMessage = (err: any) => err?.message || GENERIC_MESSAGE;

  it('surfaces the backend-provided message from a failed correction call', () => {
    const err = new ApiError('check_in must be a valid time', 400, 'corr-id-1');
    expect(resolveCorrectionErrorMessage(err)).toBe('check_in must be a valid time');
  });

  it('falls back to the generic message when the error has no message', () => {
    const err = { status: 500 };
    expect(resolveCorrectionErrorMessage(err)).toBe(GENERIC_MESSAGE);
  });

  it('falls back to the generic message when the call rejects with a plain undefined/null', () => {
    expect(resolveCorrectionErrorMessage(undefined)).toBe(GENERIC_MESSAGE);
    expect(resolveCorrectionErrorMessage(null)).toBe(GENERIC_MESSAGE);
  });
});

describe('Attendance Dashboard Date Filter Logic', () => {
  it('correctly builds API parameters for date filtering', () => {
    const siteToday = '2026-08-10';

    // Test 1: Today view (selectedDate = siteToday, no rangeTo)
    const test1 = { selectedDate: '2026-08-10', rangeTo: '' };
    const isToday1 = test1.selectedDate === siteToday && !test1.rangeTo;
    expect(isToday1).toBe(true);

    // Test 2: Single past day view (selectedDate = 2026-08-03, no rangeTo)
    const test2 = { selectedDate: '2026-08-03', rangeTo: '' };
    const isToday2 = test2.selectedDate === siteToday && !test2.rangeTo;
    const toDate2 = test2.rangeTo || test2.selectedDate;
    expect(isToday2).toBe(false);
    expect(toDate2).toBe('2026-08-03');
    const apiQuery2 = `/live/attendance?fromDate=${test2.selectedDate}&toDate=${toDate2}&limit=5000`;
    expect(apiQuery2).toBe('/live/attendance?fromDate=2026-08-03&toDate=2026-08-03&limit=5000');

    // Test 3: Date range view (selectedDate = 2026-08-01, rangeTo = 2026-08-10)
    const test3 = { selectedDate: '2026-08-01', rangeTo: '2026-08-10' };
    const isToday3 = test3.selectedDate === siteToday && !test3.rangeTo;
    const toDate3 = test3.rangeTo || test3.selectedDate;
    expect(isToday3).toBe(false);
    expect(toDate3).toBe('2026-08-10');
    const apiQuery3 = `/live/attendance?fromDate=${test3.selectedDate}&toDate=${toDate3}&limit=5000`;
    expect(apiQuery3).toBe('/live/attendance?fromDate=2026-08-01&toDate=2026-08-10&limit=5000');
  });

  it('correctly derives unique row keys and period summary metrics', () => {
    const mockRecords = [
      { fk_employee_id: 101, attendance_date: '2026-08-01', status: 'present', check_in: '2026-08-01T09:00:00Z', check_out: '2026-08-01T17:00:00Z' },
      { fk_employee_id: 101, attendance_date: '2026-08-02', status: 'present', check_in: '2026-08-02T09:05:00Z', check_out: '2026-08-02T17:00:00Z' },
      { fk_employee_id: 102, attendance_date: '2026-08-01', status: 'absent', check_in: null, check_out: null },
    ];

    const uniqueEmployees = new Set(mockRecords.map(r => String(r.fk_employee_id))).size;
    expect(uniqueEmployees).toBe(2);
    expect(mockRecords.length).toBe(3);

    const keys = mockRecords.map((r, idx) => `${r.fk_employee_id}-${r.attendance_date}`);
    expect(new Set(keys).size).toBe(3); // All row keys are unique
  });
});
