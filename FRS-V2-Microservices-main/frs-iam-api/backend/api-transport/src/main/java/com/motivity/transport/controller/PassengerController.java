package com.motivity.transport.controller;

import com.motivity.transport.dto.PassengerRequest;
import com.motivity.transport.dto.PassengerResponse;
import com.motivity.transport.security.TransportAuthorization;
import com.motivity.transport.service.PassengerService;
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
@RequestMapping("/api/transport/passengers")
public class PassengerController {

    private final PassengerService passengerService;

    public PassengerController(PassengerService passengerService) {
        this.passengerService = passengerService;
    }

    @GetMapping
    @PreAuthorize("@transportAuthz.has(authentication, '" + PASSENGERS_READ + "')")
    public List<PassengerResponse> list(Authentication authentication) {
        return passengerService.list(TransportAuthorization.scopeOf(authentication));
    }

    @GetMapping("/{id}")
    @PreAuthorize("@transportAuthz.has(authentication, '" + PASSENGERS_READ + "')")
    public PassengerResponse get(@PathVariable UUID id, Authentication authentication) {
        return passengerService.get(TransportAuthorization.scopeOf(authentication), id);
    }

    @PostMapping
    @PreAuthorize("@transportAuthz.has(authentication, '" + PASSENGERS_WRITE + "')")
    public ResponseEntity<PassengerResponse> create(@Valid @RequestBody PassengerRequest request, Authentication authentication) {
        PassengerResponse created = passengerService.create(TransportAuthorization.scopeOf(authentication), request);
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    @PatchMapping("/{id}")
    @PreAuthorize("@transportAuthz.has(authentication, '" + PASSENGERS_WRITE + "')")
    public PassengerResponse update(@PathVariable UUID id, @Valid @RequestBody PassengerRequest request, Authentication authentication) {
        return passengerService.update(TransportAuthorization.scopeOf(authentication), id, request);
    }

    @DeleteMapping("/{id}")
    @PreAuthorize("@transportAuthz.has(authentication, '" + PASSENGERS_WRITE + "')")
    public ResponseEntity<Void> delete(@PathVariable UUID id, Authentication authentication) {
        passengerService.delete(TransportAuthorization.scopeOf(authentication), id);
        return ResponseEntity.noContent().build();
    }
}
