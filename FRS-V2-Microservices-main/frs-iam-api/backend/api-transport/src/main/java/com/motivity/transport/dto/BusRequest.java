package com.motivity.transport.dto;

import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;

import java.util.UUID;

/**
 * Used for both create and update (PATCH semantics on update: a null field
 * leaves the existing value alone — see BusService.update). busCode is
 * required on create; the service enforces that separately since a single
 * DTO is shared between the two operations.
 */
public record BusRequest(
        @Size(max = 50) String busCode,
        @Size(max = 50) String registrationNo,
        UUID routeId,
        UUID depotId,
        @Positive Integer capacity,
        @Pattern(regexp = "active|maintenance|retired") String status
) {
}
