package com.motivity.transport.security;

import com.motivity.transport.entity.TransportUserScope;
import com.motivity.transport.repository.TransportUserScopeRepository;
import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

/**
 * Resolves a TransportScope once per authenticated request, called from
 * KeycloakAuthFilter. tenant_admin and viewer are tenant-wide by role alone
 * (no DB lookup needed); site_admin/hr_manager require a
 * transport_user_scope row — its absence resolves to UNASSIGNED (sees
 * nothing), never a silent fallback to tenant-wide.
 */
@Component
public class TransportScopeResolver {

    private final TransportUserScopeRepository scopeRepository;

    public TransportScopeResolver(TransportUserScopeRepository scopeRepository) {
        this.scopeRepository = scopeRepository;
    }

    public TransportScope resolve(UUID tenantId, String keycloakSubject, Collection<String> roles) {
        if (roles.contains("tenant_admin") || roles.contains("viewer")) {
            return TransportScope.tenantWide(tenantId);
        }

        List<TransportUserScope> rows = scopeRepository.findAllByTenantIdAndKeycloakSubject(tenantId, keycloakSubject);

        if (roles.contains("site_admin")) {
            return rows.stream()
                    .filter(r -> r.getDepotId() != null)
                    .findFirst()
                    .map(r -> TransportScope.depot(tenantId, r.getDepotId()))
                    .orElse(TransportScope.unassigned(tenantId));
        }

        if (roles.contains("hr_manager")) {
            return rows.stream()
                    .filter(r -> r.getBusId() != null)
                    .findFirst()
                    .map(r -> TransportScope.bus(tenantId, r.getBusId()))
                    .orElse(TransportScope.unassigned(tenantId));
        }

        // No recognized scoping role — deny-by-default, matches
        // TransportPermissions.ROLE_PERMISSIONS' own default-deny for an
        // unrecognized role (Set.of() for anything not in the map).
        return TransportScope.unassigned(tenantId);
    }
}
