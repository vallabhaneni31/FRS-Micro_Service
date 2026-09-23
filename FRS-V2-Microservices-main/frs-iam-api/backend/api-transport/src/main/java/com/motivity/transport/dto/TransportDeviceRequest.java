package com.motivity.transport.dto;

import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.util.UUID;

/**
 * Shared create/update DTO — busId and deviceCode required only on create
 * (enforced in TransportDeviceService); never carries device_secret, which
 * is generated server-side and returned exactly once (create/rotate).
 */
public record TransportDeviceRequest(
        UUID busId,
        @Size(max = 80) String deviceCode,
        @Pattern(regexp = "boarding|deboarding") String cameraPosition,
        @Pattern(regexp = "active|maintenance|offline") String status
) {
}
