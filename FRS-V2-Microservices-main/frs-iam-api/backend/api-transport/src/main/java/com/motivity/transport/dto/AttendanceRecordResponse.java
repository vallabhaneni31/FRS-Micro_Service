package com.motivity.transport.dto;

import java.util.UUID;

/**
 * One row per enrolled passenger for the queried day — derived from
 * boarding_events, never a separately persisted attendance state.
 * status: "boarded" (last event that day was a DEBOARDING), "boarded_no_deboard"
 * (last event was a BOARDING with no matching deboard yet), or "not_boarded"
 * (no matched boarding events at all that day).
 */
public record AttendanceRecordResponse(
        UUID passengerId,
        String passengerCode,
        String fullName,
        String status
) {
}
