package com.motivity.transport.dto;

import jakarta.validation.constraints.Size;

/** Used for both create and update (PATCH semantics on update, matching BusRequest/RouteRequest). */
public record DepotRequest(
        @Size(max = 150) String depotName,
        @Size(max = 300) String address
) {
}
