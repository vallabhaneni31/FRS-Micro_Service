package com.motivity.transport.dto;

import com.motivity.transport.entity.TransportDevice;

import java.time.OffsetDateTime;
import java.util.UUID;

/** Deliberately has no device_secret field — never returned by list/get, only by create/rotate (see TransportDeviceCreatedResponse). */
public record TransportDeviceResponse(
        UUID id,
        UUID busId,
        String deviceCode,
        String cameraPosition,
        String status,
        OffsetDateTime lastHeartbeat,
        OffsetDateTime decommissionedAt,
        OffsetDateTime createdAt
) {
    public static TransportDeviceResponse from(TransportDevice device) {
        return new TransportDeviceResponse(
                device.getId(), device.getBusId(), device.getDeviceCode(), device.getCameraPosition(),
                device.getStatus(), device.getLastHeartbeat(), device.getDecommissionedAt(), device.getCreatedAt());
    }
}
