export interface BreakSegment {
    from: Date;
    to: Date;
    mins: number;
    inferred: boolean;
}

/** 
 * Reconstruct per-break segments from raw entry/exit timestamps.
 * Only confirmed OUT→IN gaps are counted as breaks, capped at max single break duration.
 */
export function calcBreakSegments(checkIns: {time:string}[], checkOuts: {time:string}[], maxSingleBreakMins = 60): BreakSegment[] {
    const pings = [
        ...checkIns.map(x => ({ dir: 'in' as const, ts: new Date(x.time) })),
        ...checkOuts.map(x => ({ dir: 'out' as const, ts: new Date(x.time) })),
    ].filter(p => !isNaN(p.ts.getTime())).sort((a, b) => a.ts.getTime() - b.ts.getTime());

    const segments: BreakSegment[] = [];
    let lastInTime: Date | null = null;
    let lastOutTime: Date | null = null;
    let workStarted = false;

    for (const { dir, ts } of pings) {
        if (dir === 'in') {
            if (!workStarted) {
                workStarted = true;
                lastInTime = ts;
            } else if (lastOutTime) {
                const rawMins = Math.round((ts.getTime() - lastOutTime.getTime()) / 60000);
                if (rawMins >= 5) {
                    const mins = Math.min(rawMins, maxSingleBreakMins);
                    segments.push({ from: lastOutTime, to: ts, mins, inferred: false });
                }
                lastOutTime = null;
                lastInTime = ts;
            } else {
                lastInTime = ts;
            }
        } else {
            if (workStarted && !lastOutTime) lastOutTime = ts;
        }
    }

    return segments;
}

/**
 * Calculates net working minutes for a given attendance record, handling live duration for ongoing shifts
 * and deducting break times.
 */
export function calculateNetWorkingMins(record: any, isToday: boolean): number | null {
    const segmentBreakMins = calcBreakSegments(record.all_check_ins ?? [], record.all_check_outs ?? []).reduce((sum, s) => sum + s.mins, 0);
    const dbBreakMins = record.break_duration_minutes ? Math.min(Number(record.break_duration_minutes), 60) : 0;
    const breakMins = segmentBreakMins > 0 ? segmentBreakMins : dbBreakMins;

    const checkInMs = record.check_in ? new Date(record.check_in).getTime() : null;
    const checkOutMs = record.check_out ? new Date(record.check_out).getTime() : (isToday && checkInMs ? Date.now() : null);

    let netWorkingMins: number | null = null;
    if (checkInMs && checkOutMs && checkOutMs > checkInMs) {
        const grossMins = Math.round((checkOutMs - checkInMs) / 60000);
        netWorkingMins = Math.max(0, grossMins - (breakMins || 0));
    } else if (record.duration_minutes != null) {
        netWorkingMins = Math.max(0, Number(record.duration_minutes) - (breakMins || 0));
    }
    return netWorkingMins;
}

/**
 * Calculates the formatted average hours string (e.g. "4h 29m") across a list of attendance records.
 */
export function calculateAverageHoursMins(attendance: any[], isToday: boolean = true): string {
    if (!attendance || !attendance.length) return '0m';
    
    const durations = attendance
        .map(r => calculateNetWorkingMins(r, isToday))
        .filter((m): m is number => typeof m === 'number' && m > 0);
        
    const avgMins = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
    if (avgMins === 0) return '0m';
    
    const h = Math.floor(avgMins / 60);
    const m = avgMins % 60;
    return h === 0 ? `${m}m` : `${h}h ${m}m`;
}
