package com.motivity.transport.security;

import java.util.List;
import java.util.UUID;

/** Identity attached to the SecurityContext for a request authenticated as a human, via Keycloak. */
public record UserPrincipal(String subject, UUID tenantId, String realmSlug, List<String> roles, String email,
                             TransportScope scope) {
}
