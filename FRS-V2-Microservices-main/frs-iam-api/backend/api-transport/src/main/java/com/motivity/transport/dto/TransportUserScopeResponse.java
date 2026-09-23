package com.motivity.transport.dto;

import com.motivity.transport.entity.TransportUserScope;

import java.time.OffsetDateTime;
import java.util.UUID;

public record TransportUserScopeResponse(
        UUID id,
        String keycloakSubject,
        UUID depotId,
        UUID busId,
        OffsetDateTime createdAt
) {
    public static TransportUserScopeResponse from(TransportUserScope scope) {
        return new TransportUserScopeResponse(
                scope.getId(), scope.getKeycloakSubject(), scope.getDepotId(), scope.getBusId(), scope.getCreatedAt());
    }
}
