package com.motivity.transport.dto;

import com.fasterxml.jackson.databind.JsonNode;

import java.time.OffsetDateTime;
import java.util.UUID;

public record RouteResponse(
        UUID id,
        String routeName,
        UUID depotId,
        JsonNode stops,
        OffsetDateTime createdAt,
        OffsetDateTime updatedAt
) {
}
