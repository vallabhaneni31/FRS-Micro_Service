package com.motivity.transport.security;

import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Component;

import java.util.UUID;

/**
 * Bridges the existing TransportPermissions role→permission map (built in
 * 2c) into Spring Security's @PreAuthorize SpEL, referenced as
 * "@transportAuthz.has(authentication, 'transport.buses.write')" on the
 * management controllers this phase adds. Not a new permission model —
 * just making the one already reviewed and confirmed declarative at the
 * controller level.
 */
@Component("transportAuthz")
public class TransportAuthorization {

    public boolean has(Authentication authentication, String permission) {
        if (!(authentication.getPrincipal() instanceof UserPrincipal principal)) {
            return false;
        }
        return TransportPermissions.hasPermission(principal.roles(), permission);
    }

    /** The caller's tenant, resolved server-side from the verified token — never trust a client-supplied tenantId. */
    public static UUID tenantIdOf(Authentication authentication) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        return principal.tenantId();
    }

    /** The caller's resolved depot/bus scope — see TransportScope for what each level means. */
    public static TransportScope scopeOf(Authentication authentication) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        return principal.scope();
    }
}
