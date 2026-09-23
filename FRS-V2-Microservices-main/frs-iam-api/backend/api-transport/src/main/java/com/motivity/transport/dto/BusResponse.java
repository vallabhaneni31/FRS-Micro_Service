package com.motivity.transport.dto;

import com.motivity.transport.entity.Bus;

import java.time.OffsetDateTime;
import java.util.UUID;

public record BusResponse(
        UUID id,
        String busCode,
        String registrationNo,
        UUID routeId,
        UUID depotId,
        Integer capacity,
        String status,
        OffsetDateTime createdAt,
        OffsetDateTime updatedAt
) {
    public static BusResponse from(Bus bus) {
        return new BusResponse(
                bus.getId(), bus.getBusCode(), bus.getRegistrationNo(), bus.getRouteId(), bus.getDepotId(),
                bus.getCapacity(), bus.getStatus(), bus.getCreatedAt(), bus.getUpdatedAt());
    }
}
