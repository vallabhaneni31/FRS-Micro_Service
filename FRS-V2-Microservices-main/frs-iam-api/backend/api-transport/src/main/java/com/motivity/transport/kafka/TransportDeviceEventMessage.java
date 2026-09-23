package com.motivity.transport.kafka;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/**
 * The actual Kafka message shape published to frs.transport-device-events.
 * tenantId/busId/deviceId come from the authenticated device's own record,
 * never from client input — see DeviceEventController.
 */
public record TransportDeviceEventMessage(
        UUID eventUid,
        UUID tenantId,
        UUID busId,
        UUID deviceId,
        String eventType,
        String personRef,
        BigDecimal confidence,
        String photoKey,
        Instant eventTime,
        Instant receivedAt
) {
}
