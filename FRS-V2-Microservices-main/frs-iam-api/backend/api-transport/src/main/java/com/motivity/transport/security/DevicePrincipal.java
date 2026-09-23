package com.motivity.transport.security;

import java.util.UUID;

/** Identity attached to the SecurityContext for a request authenticated as a Jetson device (not a human). */
public record DevicePrincipal(UUID deviceId, UUID tenantId, UUID busId, String deviceCode) {
}
