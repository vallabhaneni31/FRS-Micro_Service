package com.motivity.transport.dto;

import java.time.Instant;
import java.util.UUID;

public record DeviceEventResponse(boolean success, UUID eventId, Instant receivedAt, String status) {
}
