package com.motivity.transport.security;

import java.util.UUID;

/**
 * What a request is actually allowed to see, beyond tenant isolation —
 * resolved once per request (KeycloakAuthFilter) from transport_user_scope
 * and carried on UserPrincipal. Separate concern from TransportPermissions:
 * permission answers "can this role hit this endpoint at all", scope
 * answers "which rows does the answer include" — a hr_manager can hold
 * BUSES_READ yet still only ever see the one bus their scope names.
 *
 * UNASSIGNED (a site_admin/hr_manager with no transport_user_scope row yet)
 * is deliberately distinct from an empty depotId/busId — it must resolve to
 * "sees nothing" (deny-by-default), never silently fall back to tenant-wide.
 */
public record TransportScope(UUID tenantId, Level level, UUID depotId, UUID busId) {

    public enum Level { TENANT_WIDE, DEPOT, BUS, UNASSIGNED }

    public static TransportScope tenantWide(UUID tenantId) {
        return new TransportScope(tenantId, Level.TENANT_WIDE, null, null);
    }

    public static TransportScope depot(UUID tenantId, UUID depotId) {
        return new TransportScope(tenantId, Level.DEPOT, depotId, null);
    }

    public static TransportScope bus(UUID tenantId, UUID busId) {
        return new TransportScope(tenantId, Level.BUS, null, busId);
    }

    public static TransportScope unassigned(UUID tenantId) {
        return new TransportScope(tenantId, Level.UNASSIGNED, null, null);
    }

    public boolean isTenantWide() {
        return level == Level.TENANT_WIDE;
    }
}
