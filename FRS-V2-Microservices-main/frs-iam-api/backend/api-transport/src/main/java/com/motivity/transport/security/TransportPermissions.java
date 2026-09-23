package com.motivity.transport.security;

import java.util.Collection;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

import static com.motivity.transport.security.TransportPermission.*;

/**
 * Persona → Keycloak role → permission mapping, confirmed in the build
 * checklist (§9, Personas & RBAC) — Transport Admin, Route Manager,
 * Operations Manager, Viewer/Auditor, mapped onto the existing platform's
 * generic realm roles (tenant_admin, site_admin, hr_manager, viewer). No
 * new Keycloak roles were needed for this.
 *
 * Shape mirrors the existing platform's ROLE_PERMISSIONS map in
 * backend/api/src/middleware/authz.js — a plain role→permission-set table,
 * not Spring's hasRole()/hasAuthority() DSL, so the same permission model
 * can be reused unchanged once route-level checks land in phase 2f.
 */
public final class TransportPermissions {

    private TransportPermissions() {}

    private static final Map<String, Set<String>> ROLE_PERMISSIONS = Map.of(
            // Transport Admin — full control, tenant-wide (TransportScope.tenantWide()).
            "tenant_admin", Set.of(
                    BUSES_READ, BUSES_WRITE, BUSES_DELETE,
                    ROUTES_READ, ROUTES_WRITE,
                    DEPOTS_READ, DEPOTS_WRITE,
                    DEVICES_READ, DEVICES_WRITE, DEVICES_MANAGE,
                    PASSENGERS_READ, PASSENGERS_WRITE,
                    EVENTS_READ, OCCUPANCY_READ, REPORTS_READ,
                    SETTINGS_WRITE, USERS_MANAGE
            ),
            // Route Manager — one assigned depot (TransportScope.depot(...)), can create
            // routes/buses within it (per the depot/route/bus hierarchy spec), no
            // fleet-wide delete, no depot creation (Admin-only). USERS_MANAGE lets
            // them reach the User Management page and assign Operations Managers —
            // TransportUserScopeService is what actually restricts this to their own
            // depot and forbids assigning another Route Manager, not this permission.
            "site_admin", Set.of(
                    BUSES_READ, BUSES_WRITE,
                    ROUTES_READ, ROUTES_WRITE,
                    DEPOTS_READ,
                    DEVICES_READ, DEVICES_WRITE, DEVICES_MANAGE,
                    PASSENGERS_READ, PASSENGERS_WRITE,
                    EVENTS_READ, OCCUPANCY_READ, REPORTS_READ,
                    USERS_MANAGE
            ),
            // Operations Manager — one assigned bus (TransportScope.bus(...)), monitor-only.
            // BUSES_READ added here (not present before this scope model existed) so Bus
            // View's metrics bar can read capacity/status — scope resolution restricts
            // this to exactly their one bus, not fleet-wide, regardless of the permission.
            "hr_manager", Set.of(
                    BUSES_READ, ROUTES_READ, PASSENGERS_READ, EVENTS_READ, OCCUPANCY_READ, REPORTS_READ, SETTINGS_WRITE
            ),
            // Viewer / Auditor — read-only everywhere, tenant-wide.
            "viewer", Set.of(
                    BUSES_READ, ROUTES_READ, DEPOTS_READ, DEVICES_READ, PASSENGERS_READ,
                    EVENTS_READ, OCCUPANCY_READ, REPORTS_READ
            )
    );

    public static Set<String> permissionsForRoles(Collection<String> roles) {
        Set<String> result = new HashSet<>();
        for (String role : roles) {
            result.addAll(ROLE_PERMISSIONS.getOrDefault(role, Set.of()));
        }
        return result;
    }

    public static boolean hasPermission(Collection<String> roles, String permission) {
        for (String role : roles) {
            if (ROLE_PERMISSIONS.getOrDefault(role, Set.of()).contains(permission)) {
                return true;
            }
        }
        return false;
    }
}
