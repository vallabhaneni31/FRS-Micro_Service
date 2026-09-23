import { getSiteTimezone } from '../../utils/timezone';
/**
 * ── Local mock fixtures for the Attendance Status screen ──────────────────────
 *
 * Lets the dashboard render the sample /live/employees + /live/attendance
 * payloads without a backend. Active in dev builds only; production never mocks.
 *
 * Disable in dev:  run `localStorage.MOCK_API = 'off'` in the console + reload.
 * Re-enable:       `localStorage.removeItem('MOCK_API')` + reload.
 */

export const MOCK_ENABLED = false;

const TENANT = '5aa1dbdd-d15f-4766-bdd7-6ca864cbd065';

/** Site-local "today" (matches the component's siteToday formula) so the
 *  today-path filter picks these records up. */
const TODAY = new Intl.DateTimeFormat('en-CA', {
    timeZone: getSiteTimezone(),
}).format(new Date());

const img = (seed: string) => `https://picsum.photos/seed/${seed}/160/110`;

// ── Employees (from /api/live/employees) ──────────────────────────────────────
const emp = (
    id: string, name: string, dept: string, location: string,
    faceEnrolled: boolean, position = 'Employee',
) => ({
    pk_employee_id: id,
    employee_code: `MLII${id}`,
    full_name: name,
    email: `${name.trim().split(/\s+/)[0].toLowerCase()}@motivitylabs.com`,
    position_title: position,
    location_label: location,
    status: 'active',
    join_date: '2026-06-07T18:30:00.000Z',
    face_enrolled: faceEnrolled,
    tenant_id: TENANT,
    department_name: dept,
    shift_name: 'General',
    shift_type: 'custom',
    start_time: '09:00:00',
    end_time: '18:00:00',
    grace_period_minutes: 10,
});

export const MOCK_EMPLOYEES = [
    emp('45', ' Akshitha Arra', 'Application Engineering', 'Madhapur', false),
    emp('37', 'Aashritha Naga Adoni', 'Data Engineering ', 'Ameerapet', true),
    emp('14', 'Abhijith', 'COE', 'Dallas Center', true),
    emp('25', 'Abhinav Reddy Dakareddy', 'Data Engineering ', 'Tellapur', true),
    emp('31', 'Afsheen Zara', 'AI/ML', 'Shaikpet ', true),
    emp('34', 'Akshaya Kumudha GNVSL', 'Quality Assurance', 'Chanda Nagar', true),
    emp('40', 'B. Keerthi Chandana', 'Application Engineering', 'Madhapur', false),
    emp('28', 'Harshavardhan Reddy Gopu', 'DevOps & Cloud', 'Madhapur', true),
    emp('35', 'Jhansi Priya Gedela', 'DevOps & Cloud', 'shivarampally', true),
    emp('15', 'Karthik ', 'COE', 'kondapur', true),
    emp('27', 'Mohd Salman Ahmed', 'Application Engineering', 'Malakpet', true),
    emp('30', 'Nithya Reddy Banala', 'AI/ML', 'LB Nagar', true),
    emp('26', 'Pavan Karthikeya Pillutla Sree Lakshmi', 'Application Engineering', 'Madhapur', true),
    emp('13', 'Phani ', 'COE', 'Kondapur', true, 'Manager'),
    emp('44', 'Prashanth Pittla', 'Quality Assurance', 'Madhapur', false),
    emp('29', 'Ram Puneeth Reddy B', 'Data Engineering ', 'Madhur Nagar', true),
    emp('12', 'Ramalingeswara Rao Badi', 'COE', 'Madhapur', true),
    emp('17', 'Sandeep Kumar', 'COE', 'Madhapur', true),
    emp('42', 'Sekireddy Vasudha', 'Application Engineering', 'Madhapur', false),
    emp('22', 'Shiva Teja Kothapally', 'Quality Assurance', 'Shankarapallie', true),
    emp('24', 'Srujan Jaini', 'AI/ML', 'Lingampally', true),
    emp('41', 'Surya Teja Yalala', 'Application Engineering', 'Madhapur', true),
    emp('21', 'Varshith Miryala', 'Quality Assurance', 'Alwal', true),
];

// ── Attendance (from /api/live/attendance) ────────────────────────────────────
// attendance_date is pinned to site-today so the live "today" path matches.
const punch = (time: string, photo: string | null) => ({ time, photo_url: photo });

const att = (o: {
    id: string; emp: string; name: string; dept: string;
    check_in: string | null; check_out: string | null;
    duration: number | null; late: boolean;
    inPhoto: string | null; outPhoto: string | null;
    inCount?: number; outCount?: number;
    allIns?: any[]; allOuts?: any[];
}) => ({
    pk_attendance_id: o.id,
    fk_employee_id: o.emp,
    full_name: o.name,
    department_name: o.dept,
    attendance_date: TODAY,
    check_in: o.check_in,
    check_out: o.check_out,
    status: 'present',
    is_late: o.late,
    is_late_computed: o.late,
    duration_minutes: o.duration,
    working_hours: o.duration ? (o.duration / 60).toFixed(2) : '0.00',
    overtime_hours: '0.00',
    location_label: null,
    recognition_accuracy: null,
    device_id: null,
    tenant_id: TENANT,
    checkin_photo_url: o.inPhoto,
    checkout_photo_url: o.outPhoto,
    check_in_count: o.inCount ?? (o.check_in ? 1 : 0),
    check_out_count: o.outCount ?? (o.check_out ? 1 : 0),
    all_check_ins: o.allIns ?? (o.check_in ? [punch(o.check_in, o.inPhoto)] : []),
    all_check_outs: o.allOuts ?? (o.check_out ? [punch(o.check_out, o.outPhoto)] : []),
});

export const MOCK_ATTENDANCE = [
    // Present (not late) — shows the Present state
    att({ id: '256', emp: '21', name: 'Varshith Miryala', dept: 'Quality Assurance',
        check_in: '2026-06-10T03:54:23.000Z', check_out: '2026-06-10T10:30:57.000Z',
        duration: 396, late: false, inPhoto: img('in21'), outPhoto: img('out21'),
        inCount: 1, outCount: 3,
        allOuts: [punch('2026-06-10T13:17:44+05:30', img('o21a')), punch('2026-06-10T14:04:41+05:30', img('o21b')), punch('2026-06-10T16:01:05+05:30', img('out21'))] }),
    att({ id: '258', emp: '29', name: 'Ram Puneeth Reddy B', dept: 'Data Engineering ',
        check_in: '2026-06-10T04:08:31.000Z', check_out: '2026-06-10T08:07:32.000Z',
        duration: 239, late: false, inPhoto: img('in29'), outPhoto: img('out29'),
        inCount: 1, outCount: 7,
        allOuts: [
            punch('2026-06-10T09:38:31+05:30', img('o29a')), punch('2026-06-10T09:41:42+05:30', img('o29b')),
            punch('2026-06-10T09:44:02+05:30', img('o29c')), punch('2026-06-10T13:35:14+05:30', img('o29d')),
            punch('2026-06-10T13:35:18+05:30', img('o29e')), punch('2026-06-10T13:37:23+05:30', img('o29f')),
            punch('2026-06-10T13:37:44+05:30', img('out29'))] }),
    att({ id: '283', emp: '28', name: 'Harshavardhan Reddy Gopu', dept: 'DevOps & Cloud',
        check_in: '2026-06-10T08:36:21.000Z', check_out: '2026-06-10T10:39:42.000Z',
        duration: 123, late: false, inPhoto: img('in28'), outPhoto: img('out28'),
        inCount: 1, outCount: 2,
        allOuts: [punch('2026-06-10T16:09:44+05:30', img('o28a')), punch('2026-06-10T16:10:11+05:30', img('out28'))] }),

    // Late — present + is_late → derived 'Late'
    att({ id: '262', emp: '27', name: 'Mohd Salman Ahmed', dept: 'Application Engineering',
        check_in: '2026-06-10T04:25:05.000Z', check_out: '2026-06-10T08:07:34.000Z',
        duration: 222, late: true, inPhoto: img('in27'), outPhoto: img('out27'), inCount: 1, outCount: 4 }),
    att({ id: '263', emp: '22', name: 'Shiva Teja Kothapally', dept: 'Quality Assurance',
        check_in: '2026-06-10T04:32:26.000Z', check_out: null,
        duration: null, late: true, inPhoto: img('in22'), outPhoto: null }),
    att({ id: '264', emp: '35', name: 'Jhansi Priya Gedela', dept: 'DevOps & Cloud',
        check_in: '2026-06-10T07:44:35.000Z', check_out: null,
        duration: null, late: true, inPhoto: img('in35'), outPhoto: null }),
    att({ id: '279', emp: '26', name: 'Pavan Karthikeya Pillutla Sree Lakshmi', dept: 'Application Engineering',
        check_in: '2026-06-10T08:12:12.000Z', check_out: null,
        duration: null, late: true, inPhoto: img('in26'), outPhoto: null }),
    att({ id: '280', emp: '17', name: 'Sandeep Kumar', dept: 'COE',
        check_in: '2026-06-10T08:17:25.000Z', check_out: null,
        duration: null, late: true, inPhoto: img('in17'), outPhoto: null }),
    att({ id: '281', emp: '34', name: 'Akshaya Kumudha GNVSL', dept: 'Quality Assurance',
        check_in: '2026-06-10T08:29:13.000Z', check_out: null,
        duration: null, late: true, inPhoto: img('in34'), outPhoto: null }),

    // Dirty records — exercise the warning flag
    att({ id: '257', emp: '25', name: 'Abhinav Reddy Dakareddy', dept: 'Data Engineering ',
        check_in: '2026-06-10T08:05:16.000Z', check_out: '2026-06-10T08:07:34.000Z',
        duration: 2, late: true, inPhoto: img('in25'), outPhoto: img('out25'),
        inCount: 1, outCount: 5 }), // very short session
    att({ id: '255', emp: '14', name: 'Abhijith', dept: 'COE',
        check_in: '2026-06-10T08:46:35.000Z', check_out: '2026-06-10T03:09:27.000Z',
        duration: null, late: true, inPhoto: null, outPhoto: img('out14'),
        inCount: 1, outCount: 1 }), // checkout-before-checkin + missing in-photo
    att({ id: '286', emp: '15', name: 'Karthik ', dept: 'COE',
        check_in: '2026-06-10T09:03:06.000Z', check_out: '2026-06-10T09:04:29.000Z',
        duration: 1, late: false, inPhoto: img('in15'), outPhoto: img('out15') }), // short session
];

// ── Weekly trend (from /api/live/trends/weekly) ───────────────────────────────
export const MOCK_WEEKLY = [
    { day: 'Mon', present: 78, late: 12, absent: 10 },
    { day: 'Tue', present: 82, late: 9, absent: 9 },
    { day: 'Wed', present: 75, late: 14, absent: 11 },
    { day: 'Thu', present: 80, late: 11, absent: 9 },
    { day: 'Fri', present: 70, late: 18, absent: 12 },
    { day: 'Sat', present: 30, late: 5, absent: 65 },
    { day: 'Sun', present: 8, late: 2, absent: 90 },
];

const MOCK_METRICS = {
    totalEmployees: MOCK_EMPLOYEES.length,
    presentToday: 3, lateToday: 9, absentToday: 11, onBreak: 0,
    avgWorkingHours: 6.4, totalOvertimeHours: 0,
    attendanceRate: 52, punctualityRate: 25,
};

/**
 * Return a canned response for a known live endpoint, or `undefined` to let the
 * request fall through to the real backend (auth, writes, anything unmocked).
 */
export function resolveMock(path: string, method: string): unknown | undefined {
    if (!MOCK_ENABLED || method !== 'GET') return undefined;
    const base = path.split('?')[0];
    const query = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';

    switch (base) {
        case '/live/employees':   return { data: MOCK_EMPLOYEES };
        case '/live/devices':     return { data: [] };
        case '/live/alerts':      return { data: [] };
        case '/live/metrics':     return MOCK_METRICS;
        case '/live/trends/weekly': return { data: MOCK_WEEKLY };
        case '/live/attendance': {
            // Today path (no fromDate) → full live set.
            if (!query.includes('fromDate=')) return { data: MOCK_ATTENDANCE };
            // Range/historical path → synthesize a deterministic month of data.
            const p = new URLSearchParams(query);
            return { data: genRange(p.get('fromDate')!, p.get('toDate') || p.get('fromDate')!) };
        }
        case '/attendance/dwell': {
            const p = new URLSearchParams(query);
            return genDwell(p.get('employeeId') || '', p.get('date') || TODAY);
        }
        case '/attendance/dwell-summary': {
            const p = new URLSearchParams(query);
            return genDwellSummary(p.get('fromDate') || TODAY, p.get('toDate') || TODAY);
        }
        case '/devices/activity-heatmap':
            return genHeatmap();
        case '/devices/activity-by-day': {
            const p = new URLSearchParams(query);
            return genDayHeatmap(p.get('fromDate') || TODAY, p.get('toDate') || TODAY);
        }
        default:
            return undefined;
    }
}

// ── Dwell-time / device-activity mocks (dev only) ─────────────────────────────
// Sample devices stand in for tagged locations until real pings exist.
const MOCK_DEVICES = [
    { code: 'DEV-WORK-01', name: 'Workplace Entrance', zone: 'work'  as const },
    { code: 'DEV-CAFE-01', name: 'Cafeteria',          zone: 'break' as const },
    { code: 'DEV-WS-02',   name: 'Workstation B',      zone: 'other' as const },
];

function genDwell(employeeId: string, date: string) {
    const emp = MOCK_EMPLOYEES.find(e => String(e.pk_employee_id) === String(employeeId));

    // Anchor to the matching attendance row so the dwell lines up with the table.
    //  • check_in + check_out → completed day, segments span check-in→check-out.
    //  • check_in only (today) → still on site: run to "now", last stop ongoing,
    //    no "worked" total (we don't know when they'll leave).
    //  • no row (other dates) → synthesise a plain 09:00–18:00 day.
    const att = MOCK_ATTENDANCE.find(a => String(a.fk_employee_id) === String(employeeId));
    let officialCheckInMs: number, endMs: number, ongoing = false, hasCheckout = false;
    if (date === TODAY && att?.check_in) {
        officialCheckInMs = new Date(att.check_in).getTime();
        if (att.check_out) { endMs = new Date(att.check_out).getTime(); hasCheckout = true; }
        else { endMs = Date.now(); ongoing = true; }
    } else {
        officialCheckInMs = new Date(`${date}T09:00:00`).getTime();
        endMs = new Date(`${date}T18:00:00`).getTime();
        hasCheckout = true;
    }

    // For ~1/3 of employees, the first device sighting is a few minutes before the
    // official check-in → demonstrates the "tracked vs worked" distinction.
    let sh = 0; const sseed = `${employeeId}-${date}`;
    for (let i = 0; i < sseed.length; i++) sh = (sh * 31 + sseed.charCodeAt(i)) >>> 0;
    const preCheckInMin = sh % 3 === 1 ? 12 : 0;

    const startMs = officialCheckInMs - preCheckInMin * 60000;   // first sighting
    if (!(endMs > startMs)) endMs = startMs + 60 * 60 * 1000;
    const span = endMs - startMs;

    // Distribute the time across locations (fractions sum to 1 → total == span).
    const splits = [
        { d: MOCK_DEVICES[0], frac: 0.45 },   // Workplace (morning)
        { d: MOCK_DEVICES[1], frac: 0.10 },   // Cafeteria
        { d: MOCK_DEVICES[2], frac: 0.20 },   // Workstation B
        { d: MOCK_DEVICES[0], frac: 0.25 },   // Workplace (afternoon)
    ];
    let cursor = startMs;
    const segments = splits.map((s, i) => {
        const last = i === splits.length - 1;
        const from = cursor;
        const to = last ? endMs : Math.round(from + span * s.frac);
        cursor = to;
        return {
            location: s.d.name, deviceCode: s.d.code, zoneType: s.d.zone, zoneLabel: null,
            arrivedAt: new Date(from).toISOString(),
            leftAt: (last && ongoing) ? null : new Date(to).toISOString(),
            minutes: Math.max(0, Math.round((to - from) / 60000)),
            ongoing: last && ongoing,
        };
    });

    const totalsByZone: Record<string, number> = { work: 0, break: 0, other: 0, unassigned: 0 };
    const locMap = new Map<string, { location: string; zoneType: string; minutes: number }>();
    let totalTrackedMinutes = 0;
    for (const s of segments) {
        totalsByZone[s.zoneType] += s.minutes;
        totalTrackedMinutes += s.minutes;
        if (!locMap.has(s.location)) locMap.set(s.location, { location: s.location, zoneType: s.zoneType, minutes: 0 });
        locMap.get(s.location)!.minutes += s.minutes;
    }
    const workedMinutes = hasCheckout ? Math.max(0, Math.round((endMs - officialCheckInMs) / 60000)) : null;
    const productivityPct = totalTrackedMinutes > 0 ? Math.round((totalsByZone.work / totalTrackedMinutes) * 100) : null;
    return {
        employeeId, employeeName: emp?.full_name ?? 'Employee', date, tz: 'UTC',
        checkIn: new Date(officialCheckInMs).toISOString(),
        checkOut: hasCheckout ? new Date(endMs).toISOString() : null,
        firstPingAt: new Date(startMs).toISOString(), lastActivityAt: new Date(endMs).toISOString(),
        arrivedBeforeCheckInMin: preCheckInMin, leftAfterCheckOutMin: 0,
        segments, totalsByZone,
        totalsByLocation: Array.from(locMap.values()).sort((a, b) => b.minutes - a.minutes),
        totalTrackedMinutes,
        workedMinutes,
        productivityPct,
    };
}

function genDwellSummary(fromDate: string, toDate: string) {
    const employees: Record<string, any> = {};
    MOCK_EMPLOYEES.forEach(e => {
        let h = 0; const seed = `${e.pk_employee_id}-${fromDate}`;
        for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
        const days = 17 + (h % 5);                       // working days in the range
        const total = days * (7 * 60 + (h % 90));        // ~7–8.5h/day
        const work  = Math.round(total * 0.70);
        const brk   = Math.round(total * 0.12);
        const other = total - work - brk;
        const locations = [
            { location: 'Workplace Entrance', zoneType: 'work',  minutes: work },
            { location: 'Cafeteria',          zoneType: 'break', minutes: brk },
            ...(h % 3 === 0 ? [] : [{ location: 'Workstation B', zoneType: 'other', minutes: other }]),
        ].filter(l => l.minutes > 0).sort((a, b) => b.minutes - a.minutes);
        const totalMinutes = locations.reduce((s, l) => s + l.minutes, 0);
        employees[String(e.pk_employee_id)] = {
            department: (e.department_name || 'Unassigned').trim(),
            deviceCount: locations.length,
            topLocation: locations[0]?.location ?? null,
            totalMinutes,
            productivityPct: totalMinutes > 0 ? Math.round((work / totalMinutes) * 100) : null,
            totalsByZone: { work, break: brk, other: (h % 3 === 0 ? 0 : other), unassigned: 0 },
            locations,
        };
    });

    // Roll up by department (mirror of the backend aggregate).
    const byDept: Record<string, any> = {};
    Object.values(employees).forEach((e: any) => {
        const d = e.department || 'Unassigned';
        if (!byDept[d]) byDept[d] = { department: d, employees: 0, totalMinutes: 0,
            totalsByZone: { work: 0, break: 0, other: 0, unassigned: 0 }, _ps: 0, _pn: 0 };
        const g = byDept[d];
        g.employees += 1; g.totalMinutes += e.totalMinutes;
        (['work', 'break', 'other', 'unassigned'] as const).forEach(k => { g.totalsByZone[k] += e.totalsByZone[k] || 0; });
        if (e.productivityPct != null) { g._ps += e.productivityPct; g._pn += 1; }
    });
    const departments = Object.values(byDept).map((g: any) => {
        const { _ps, _pn, ...rest } = g;
        return { ...rest, avgProductivityPct: _pn ? Math.round(_ps / _pn) : null };
    }).sort((a, b) => b.totalMinutes - a.totalMinutes);

    return { fromDate, toDate, tz: 'UTC', employees, departments };
}

function rangeDays(fromDate: string, toDate: string): string[] {
    const days: string[] = [];
    const end = new Date(toDate + 'T00:00:00Z');
    for (let d = new Date(fromDate + 'T00:00:00Z'); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        days.push(d.toISOString().slice(0, 10));
    }
    return days;
}

function genDayHeatmap(fromDate: string, toDate: string) {
    const days = rangeDays(fromDate, toDate);
    const mk = (deviceCode: string, name: string, base: number) => {
        const dayMap: Record<string, number> = {};
        days.forEach(day => {
            const dow = new Date(day + 'T00:00:00Z').getUTCDay();
            if (dow === 0 || dow === 6) { dayMap[day] = 0; return; }   // weekends quiet
            let h = 0; const seed = day + deviceCode;
            for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
            dayMap[day] = base + (h % Math.max(1, Math.round(base / 2)));
        });
        return { deviceCode, name, total: Object.values(dayMap).reduce((a, b) => a + b, 0), days: dayMap };
    };
    const devices = [
        mk('DEV-WORK-01', 'Workplace Entrance', 18),
        mk('DEV-CAFE-01', 'Cafeteria', 10),
        mk('DEV-WS-02', 'Workstation B', 6),
    ];
    const maxCell = Math.max(1, ...devices.flatMap(d => Object.values(d.days)));
    return { tz: 'UTC', fromDate, toDate, days, maxCell, devices };
}

function genHeatmap() {
    const mk = (deviceCode: string, name: string, peaks: [number, number][]) => {
        const hours = Array(24).fill(0);
        peaks.forEach(([hr, val]) => { hours[hr] = val; });
        return { deviceCode, name, total: hours.reduce((a, b) => a + b, 0), hours };
    };
    const devices = [
        mk('DEV-WORK-01', 'Workplace Entrance', [[8, 12], [9, 28], [10, 9], [13, 6], [17, 14], [18, 22], [19, 7]]),
        mk('DEV-CAFE-01', 'Cafeteria',          [[12, 24], [13, 18], [16, 8]]),
        mk('DEV-WS-02',   'Workstation B',      [[9, 5], [11, 7], [14, 9], [15, 6]]),
    ];
    const maxCell = Math.max(...devices.flatMap(d => d.hours));
    return { tz: 'UTC', fromDate: null, toDate: null, maxCell, devices };
}

/** Deterministic per-employee/day attendance across a date range (for monthly grid + past days). */
function genRange(from: string, to: string): any[] {
    const out: any[] = [];
    const start = new Date(from + 'T00:00:00');
    const end = new Date(to + 'T00:00:00');
    const today = new Date(TODAY + 'T00:00:00');
    let guard = 0;
    for (let d = new Date(start); d <= end && guard < 250; d.setDate(d.getDate() + 1), guard++) {
        if (d > today) break;                         // no future records
        const dow = d.getDay();
        if (dow === 0 || dow === 6) continue;          // weekends → grid defaults to "W"
        const dateStr = new Intl.DateTimeFormat('en-CA').format(d);
        const isHoliday = d.getDate() === 16;          // demo: 16th is a public holiday
        MOCK_EMPLOYEES.forEach(e => {
            // hash(empId + date) → stable pseudo-status
            const seed = `${e.pk_employee_id}-${dateStr}`;
            let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
            const r = h % 100;
            let status: string, late = false;
            if (isHoliday)      status = 'holiday';
            else if (r < 7)     status = 'absent';
            else if (r < 13)    status = 'leave';
            else if (r < 20)    status = 'wfh';
            else { status = 'present'; late = r < 32; }
            const worked = status === 'present' || status === 'wfh';
            out.push({
                pk_attendance_id: `${e.pk_employee_id}_${dateStr}`,
                fk_employee_id: e.pk_employee_id,
                full_name: e.full_name,
                department_name: e.department_name,
                attendance_date: dateStr,
                status,
                is_late: late,
                is_late_computed: late,
                check_in: worked ? `${dateStr}T0${late ? '4' : '3'}:${pad2(h % 60)}:00.000Z` : null,
                check_out: worked ? `${dateStr}T11:${pad2((h >> 3) % 60)}:00.000Z` : null,
                duration_minutes: worked ? 420 + (h % 90) : null,
                checkin_photo_url: null, checkout_photo_url: null,
                check_in_count: worked ? 1 : 0,
                check_out_count: worked ? 1 : 0,
                all_check_ins: [], all_check_outs: [],
            });
        });
    }
    return out;
}
const pad2 = (n: number) => String(n).padStart(2, '0');
