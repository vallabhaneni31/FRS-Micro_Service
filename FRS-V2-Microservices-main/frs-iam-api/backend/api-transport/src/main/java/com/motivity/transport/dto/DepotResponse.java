package com.motivity.transport.dto;

import com.motivity.transport.entity.Depot;

import java.time.OffsetDateTime;
import java.util.UUID;

public record DepotResponse(
        UUID id,
        String depotName,
        String address,
        OffsetDateTime createdAt,
        OffsetDateTime updatedAt
) {
    public static DepotResponse from(Depot depot) {
        return new DepotResponse(depot.getId(), depot.getDepotName(), depot.getAddress(), depot.getCreatedAt(), depot.getUpdatedAt());
    }
}
