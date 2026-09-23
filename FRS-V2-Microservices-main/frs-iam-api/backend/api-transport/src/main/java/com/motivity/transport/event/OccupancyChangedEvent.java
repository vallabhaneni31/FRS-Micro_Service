package com.motivity.transport.event;

import java.time.Instant;
import java.util.UUID;

/**
 * Published within the processing transaction, but only actually turned
 * into a Kafka message AFTER that transaction commits (see
 * TransportRealtimeEventListener) — never notify the frontend about an
 * occupancy change that could still roll back.
 */
public record OccupancyChangedEvent(UUID tenantId, UUID busId, int occupancyCount, String direction, Instant occurredAt) {
}
