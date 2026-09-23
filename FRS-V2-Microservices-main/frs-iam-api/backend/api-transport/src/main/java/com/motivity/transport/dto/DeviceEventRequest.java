package com.motivity.transport.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Single boarding/deboarding event, as sent by the Jetson box.
 *
 * Deliberately does NOT carry busId or tenantId — both are derived
 * server-side from the authenticated device's own record
 * (DevicePrincipal), never trusted from the request body. A device is
 * physically fixed to one bus; it has no business declaring a different
 * one per event.
 */
public record DeviceEventRequest(
        @NotNull EventType eventType,
        @NotNull Instant timestamp,
        @Valid FaceData faceData,
        @Size(max = 500) String photoKey,
        @Size(max = 100) String personRef
) {
    public record FaceData(
            @DecimalMin("0.0") @DecimalMax("1.0") BigDecimal confidence
    ) {
    }
}
