package com.motivity.transport.kafka;

import java.time.Instant;
import java.util.UUID;

/**
 * Published to frs.transport-realtime after a successful, committed
 * occupancy change. Shape matches what the (not-yet-approved) Node-side
 * relay would forward into the frontend as a "transport.occupancy_update"
 * socket event — see the build checklist, 2g task 9.
 */
public record TransportRealtimeMessage(UUID tenantId, UUID busId, int occupancyCount, String direction, Instant occurredAt) {
}
