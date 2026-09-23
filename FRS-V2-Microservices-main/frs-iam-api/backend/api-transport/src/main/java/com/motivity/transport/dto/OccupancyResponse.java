package com.motivity.transport.dto;

import com.motivity.transport.entity.OccupancySnapshot;

import java.time.OffsetDateTime;
import java.util.UUID;

public record OccupancyResponse(UUID busId, int occupancyCount, OffsetDateTime updatedAt) {
    public static OccupancyResponse from(OccupancySnapshot snapshot) {
        return new OccupancyResponse(snapshot.getBusId(), snapshot.getOccupancyCount(), snapshot.getUpdatedAt());
    }
}
