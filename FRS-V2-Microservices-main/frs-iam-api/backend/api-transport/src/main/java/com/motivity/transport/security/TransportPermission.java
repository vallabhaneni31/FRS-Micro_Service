package com.motivity.transport.security;

/** Permission string constants — used by TransportPermissions and, from phase 2f onward, route-level checks. */
public final class TransportPermission {
    private TransportPermission() {}

    public static final String BUSES_READ = "transport.buses.read";
    public static final String BUSES_WRITE = "transport.buses.write";
    public static final String BUSES_DELETE = "transport.buses.delete";

    public static final String DEPOTS_READ = "transport.depots.read";
    public static final String DEPOTS_WRITE = "transport.depots.write"; // create/edit depots — Admin only

    public static final String ROUTES_READ = "transport.routes.read";
    public static final String ROUTES_WRITE = "transport.routes.write";

    public static final String DEVICES_READ = "transport.devices.read";
    public static final String DEVICES_WRITE = "transport.devices.write";
    public static final String DEVICES_MANAGE = "transport.devices.manage"; // rotate secret / decommission

    public static final String PASSENGERS_READ = "transport.passengers.read";
    public static final String PASSENGERS_WRITE = "transport.passengers.write";

    public static final String EVENTS_READ = "transport.events.read";
    public static final String OCCUPANCY_READ = "transport.occupancy.read";
    public static final String REPORTS_READ = "transport.reports.read";
    public static final String SETTINGS_WRITE = "transport.settings.write";
    public static final String USERS_MANAGE = "transport.users.manage";
}
