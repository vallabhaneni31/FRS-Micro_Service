package com.motivity.transport.controller;

import com.motivity.transport.dto.BusRequest;
import com.motivity.transport.dto.BusResponse;
import com.motivity.transport.security.TransportAuthorization;
import com.motivity.transport.service.BusService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

import static com.motivity.transport.security.TransportPermission.*;

/** Human/Keycloak-authenticated only — falls under SecurityConfig's userChain, never the device chain. */
@RestController
@RequestMapping("/api/transport/buses")
public class BusController {

    private final BusService busService;

    public BusController(BusService busService) {
        this.busService = busService;
    }

    @GetMapping
    @PreAuthorize("@transportAuthz.has(authentication, '" + BUSES_READ + "')")
    public List<BusResponse> list(Authentication authentication) {
        return busService.list(TransportAuthorization.scopeOf(authentication));
    }

    @GetMapping("/{id}")
    @PreAuthorize("@transportAuthz.has(authentication, '" + BUSES_READ + "')")
    public BusResponse get(@PathVariable UUID id, Authentication authentication) {
        return busService.get(TransportAuthorization.scopeOf(authentication), id);
    }

    @PostMapping
    @PreAuthorize("@transportAuthz.has(authentication, '" + BUSES_WRITE + "')")
    public ResponseEntity<BusResponse> create(@Valid @RequestBody BusRequest request, Authentication authentication) {
        BusResponse created = busService.create(TransportAuthorization.scopeOf(authentication), request);
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    @PatchMapping("/{id}")
    @PreAuthorize("@transportAuthz.has(authentication, '" + BUSES_WRITE + "')")
    public BusResponse update(@PathVariable UUID id, @Valid @RequestBody BusRequest request, Authentication authentication) {
        return busService.update(TransportAuthorization.scopeOf(authentication), id, request);
    }

    @DeleteMapping("/{id}")
    @PreAuthorize("@transportAuthz.has(authentication, '" + BUSES_DELETE + "')")
    public ResponseEntity<Void> delete(@PathVariable UUID id, Authentication authentication) {
        busService.delete(TransportAuthorization.scopeOf(authentication), id);
        return ResponseEntity.noContent().build();
    }
}
