export interface ComputedAttendance {
  computedCheckIn: string | null;
  computedCheckOut: string | null;
  computedDurationMinutes: number;
  computedBreakMinutes: number;
  isActiveSession: boolean;
}

export function computeAttendanceFields(
  a: any, // The raw attendance record object
  parsedCheckins: any[], // [{time, photo_url}]
  parsedCheckouts: any[], // [{time, photo_url}]
  isToday: boolean
): ComputedAttendance {
  let computedCheckIn = a.check_in || null;
  let computedCheckOut = a.check_out || null;

  if (!computedCheckIn && parsedCheckins.length > 0) {
    computedCheckIn = parsedCheckins[0].time;
  }
  if (!computedCheckOut && parsedCheckouts.length > 0) {
    const lastCheckout = parsedCheckouts[parsedCheckouts.length - 1].time;
    if (computedCheckIn && new Date(lastCheckout) > new Date(computedCheckIn)) {
      computedCheckOut = lastCheckout;
    }
  }

  // Combine and sort events
  const events: { type: 'in' | 'out'; time: Date }[] = [];
  parsedCheckins.forEach(ci => {
    if (ci?.time) events.push({ type: 'in', time: new Date(ci.time) });
  });
  parsedCheckouts.forEach(co => {
    if (co?.time) events.push({ type: 'out', time: new Date(co.time) });
  });

  if (events.length === 0) {
    if (a.check_in) events.push({ type: 'in', time: new Date(a.check_in) });
    if (a.check_out) events.push({ type: 'out', time: new Date(a.check_out) });
  }

  events.sort((a, b) => a.time.getTime() - b.time.getTime());

  let computedDurationMinutes = 0;
  let computedBreakMinutes = 0;
  let inTime: Date | null = null;
  let outTime: Date | null = null;
  let isActiveSession = false;

  for (const event of events) {
    if (event.type === 'in') {
      if (!inTime) {
        if (outTime) {
          // Break time = difference between last out and this in
          computedBreakMinutes += (event.time.getTime() - outTime.getTime()) / 60000;
          outTime = null;
        }
        inTime = event.time;
      }
    } else if (event.type === 'out') {
      if (inTime) {
        computedDurationMinutes += (event.time.getTime() - inTime.getTime()) / 60000;
        inTime = null;
      }
      outTime = event.time;
    }
  }

  if (inTime && isToday) {
    isActiveSession = true;
    computedDurationMinutes += (new Date().getTime() - inTime.getTime()) / 60000;
  }

  return {
    computedCheckIn,
    computedCheckOut,
    computedDurationMinutes: Math.max(0, computedDurationMinutes),
    computedBreakMinutes: Math.max(0, computedBreakMinutes),
    isActiveSession,
  };
}
