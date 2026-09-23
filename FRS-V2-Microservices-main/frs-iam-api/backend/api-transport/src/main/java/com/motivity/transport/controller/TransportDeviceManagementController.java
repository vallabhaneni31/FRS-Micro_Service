package com.motivity.transport.controller;

import com.motivity.transport.dto.TransportDeviceCreatedResponse;
import com.motivity.transport.dto.TransportDeviceRequest;
import com.motivity.transport.dto.TransportDeviceResponse;
import com.motivity.transport.security.TransportAuthorization;
import com.motivity.transport.service.TransportDeviceService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

import static com.motivity.transport.security.TransportPermission.*;

/**
 * Human/Keycloak management of transport_devices — distinct from the
 * device SELF-SERVICE endpoints in DeviceEventController
 * (/api/transport/devices/{id}/{events,heartbeat,...}). SecurityConfig's
 * device chain only matches those specific event-suffix patterns, so plain
 * GET/POST/PATCH/DELETE here (no matching suffix) correctly falls through
 * to the Keycloak chain — verified live back in 2c/2d.
 */
@RestController
@RequestMapping("/api/transport/devices")
public class TransportDeviceManagementController {

    private final TransportDeviceService deviceService;

    public TransportDeviceManagementController(TransportDeviceService deviceService) {
        this.deviceService = deviceService;
    }

    @GetMapping
    @PreAuthorize("@transportAuthz.has(authentication, '" + DEVICES_READ + "')")
    public List<TransportDeviceResponse> list(@RequestParam(required = false) UUID busId, Authentication authentication) {
        return deviceService.list(TransportAuthorization.scopeOf(authentication), busId);
    }

    @GetMapping("/{id}")
    @PreAuthorize("@transportAuthz.has(authentication, '" + DEVICES_READ + "')")
    public TransportDeviceResponse get(@PathVariable UUID id, Authentication authentication) {
        return deviceService.get(TransportAuthorization.scopeOf(authentication), id);
    }

    @PostMapping
    @PreAuthorize("@transportAuthz.has(authentication, '" + DEVICES_WRITE + "')")
    public ResponseEntity<TransportDeviceCreatedResponse> create(@Valid @RequestBody TransportDeviceRequest request, Authentication authentication) {
        TransportDeviceCreatedResponse created = deviceService.create(TransportAuthorization.scopeOf(authentication), request);
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    @PatchMapping("/{id}")
    @PreAuthorize("@transportAuthz.has(authentication, '" + DEVICES_WRITE + "')")
    public TransportDeviceResponse update(@PathVariable UUID id, @Valid @RequestBody TransportDeviceRequest request, Authentication authentication) {
        return deviceService.update(TransportAuthorization.scopeOf(authentication), id, request);
    }

    @PostMapping("/{id}/rotate-secret")
    @PreAuthorize("@transportAuthz.has(authentication, '" + DEVICES_MANAGE + "')")
    public TransportDeviceCreatedResponse rotateSecret(@PathVariable UUID id, Authentication authentication) {
        return deviceService.rotateSecret(TransportAuthorization.scopeOf(authentication), id);
    }

    @PostMapping("/{id}/decommission")
    @PreAuthorize("@transportAuthz.has(authentication, '" + DEVICES_MANAGE + "')")
    public TransportDeviceResponse decommission(@PathVariable UUID id, Authentication authentication) {
        return deviceService.decommission(TransportAuthorization.scopeOf(authentication), id);
    }
}
