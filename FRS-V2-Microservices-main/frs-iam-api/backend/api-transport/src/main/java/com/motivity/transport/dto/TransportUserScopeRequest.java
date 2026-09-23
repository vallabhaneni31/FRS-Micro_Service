package com.motivity.transport.dto;

import jakarta.validation.constraints.NotBlank;

import java.util.UUID;

/**
 * Exactly one of depotId/busId must be set — enforced in
 * TransportUserScopeService, mirroring the DB's own
 * chk_scope_has_target constraint. depotId assigns a Route Manager to a
 * depot; busId assigns an Operations Manager to a bus. keycloakSubject is
 * the target user's Keycloak `sub` — obtained from the existing platform's
 * GET /users response (keycloak_sub field), not generated here; this
 * service never creates Keycloak users itself.
 */
public record TransportUserScopeRequest(
        @NotBlank String keycloakSubject,
        UUID depotId,
        UUID busId
) {
}
