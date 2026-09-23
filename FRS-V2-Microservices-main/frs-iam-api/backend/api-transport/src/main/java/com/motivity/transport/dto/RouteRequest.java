package com.motivity.transport.dto;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.Size;

import java.util.UUID;

/** Shared create/update DTO — routeName required only on create, enforced in RouteService. */
public record RouteRequest(
        @Size(max = 150) String routeName,
        UUID depotId,
        JsonNode stops
) {
}
