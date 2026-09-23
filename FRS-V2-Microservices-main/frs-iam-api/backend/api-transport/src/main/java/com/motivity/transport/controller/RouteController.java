package com.motivity.transport.controller;

import com.motivity.transport.dto.RouteRequest;
import com.motivity.transport.dto.RouteResponse;
import com.motivity.transport.security.TransportAuthorization;
import com.motivity.transport.service.RouteService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

import static com.motivity.transport.security.TransportPermission.*;

/** No DELETE endpoint — ROUTES_DELETE was never defined as a permission (see TransportPermission), matching the confirmed 2c persona table. */
@RestController
@RequestMapping("/api/transport/routes")
public class RouteController {

    private final RouteService routeService;

    public RouteController(RouteService routeService) {
        this.routeService = routeService;
    }

    @GetMapping
    @PreAuthorize("@transportAuthz.has(authentication, '" + ROUTES_READ + "')")
    public List<RouteResponse> list(Authentication authentication) {
        return routeService.list(TransportAuthorization.scopeOf(authentication));
    }

    @GetMapping("/{id}")
    @PreAuthorize("@transportAuthz.has(authentication, '" + ROUTES_READ + "')")
    public RouteResponse get(@PathVariable UUID id, Authentication authentication) {
        return routeService.get(TransportAuthorization.scopeOf(authentication), id);
    }

    @PostMapping
    @PreAuthorize("@transportAuthz.has(authentication, '" + ROUTES_WRITE + "')")
    public ResponseEntity<RouteResponse> create(@Valid @RequestBody RouteRequest request, Authentication authentication) {
        RouteResponse created = routeService.create(TransportAuthorization.scopeOf(authentication), request);
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    @PatchMapping("/{id}")
    @PreAuthorize("@transportAuthz.has(authentication, '" + ROUTES_WRITE + "')")
    public RouteResponse update(@PathVariable UUID id, @Valid @RequestBody RouteRequest request, Authentication authentication) {
        return routeService.update(TransportAuthorization.scopeOf(authentication), id, request);
    }
}
