package com.motivity.transport.controller;

import com.motivity.transport.dto.DepotRequest;
import com.motivity.transport.dto.DepotResponse;
import com.motivity.transport.security.TransportAuthorization;
import com.motivity.transport.service.DepotService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

import static com.motivity.transport.security.TransportPermission.*;

/** Human/Keycloak-authenticated only — falls under SecurityConfig's userChain. */
@RestController
@RequestMapping("/api/transport/depots")
public class DepotController {

    private final DepotService depotService;

    public DepotController(DepotService depotService) {
        this.depotService = depotService;
    }

    @GetMapping
    @PreAuthorize("@transportAuthz.has(authentication, '" + DEPOTS_READ + "')")
    public List<DepotResponse> list(Authentication authentication) {
        return depotService.list(TransportAuthorization.scopeOf(authentication));
    }

    @GetMapping("/{id}")
    @PreAuthorize("@transportAuthz.has(authentication, '" + DEPOTS_READ + "')")
    public DepotResponse get(@PathVariable UUID id, Authentication authentication) {
        return depotService.get(TransportAuthorization.scopeOf(authentication), id);
    }

    @PostMapping
    @PreAuthorize("@transportAuthz.has(authentication, '" + DEPOTS_WRITE + "')")
    public ResponseEntity<DepotResponse> create(@Valid @RequestBody DepotRequest request, Authentication authentication) {
        DepotResponse created = depotService.create(TransportAuthorization.scopeOf(authentication), request);
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    @PatchMapping("/{id}")
    @PreAuthorize("@transportAuthz.has(authentication, '" + DEPOTS_WRITE + "')")
    public DepotResponse update(@PathVariable UUID id, @Valid @RequestBody DepotRequest request, Authentication authentication) {
        return depotService.update(TransportAuthorization.scopeOf(authentication), id, request);
    }
}
