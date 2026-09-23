package com.motivity.transport.controller;

import com.motivity.transport.dto.TransportUserScopeRequest;
import com.motivity.transport.dto.TransportUserScopeResponse;
import com.motivity.transport.security.TransportAuthorization;
import com.motivity.transport.service.TransportUserScopeService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

import static com.motivity.transport.security.TransportPermission.USERS_MANAGE;

/**
 * Assigns/unassigns depot or bus scope for an already-created user — never
 * creates a Keycloak user or realm role itself (see TransportUserScopeService).
 * Human/Keycloak-authenticated only — falls under SecurityConfig's userChain.
 */
@RestController
@RequestMapping("/api/transport/user-scopes")
public class TransportUserScopeController {

    private final TransportUserScopeService scopeService;

    public TransportUserScopeController(TransportUserScopeService scopeService) {
        this.scopeService = scopeService;
    }

    @GetMapping
    @PreAuthorize("@transportAuthz.has(authentication, '" + USERS_MANAGE + "')")
    public List<TransportUserScopeResponse> list(Authentication authentication) {
        return scopeService.list(TransportAuthorization.scopeOf(authentication));
    }

    @PostMapping
    @PreAuthorize("@transportAuthz.has(authentication, '" + USERS_MANAGE + "')")
    public ResponseEntity<TransportUserScopeResponse> create(@Valid @RequestBody TransportUserScopeRequest request, Authentication authentication) {
        TransportUserScopeResponse created = scopeService.create(TransportAuthorization.scopeOf(authentication), request);
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    @DeleteMapping("/{id}")
    @PreAuthorize("@transportAuthz.has(authentication, '" + USERS_MANAGE + "')")
    public ResponseEntity<Void> delete(@PathVariable UUID id, Authentication authentication) {
        scopeService.delete(TransportAuthorization.scopeOf(authentication), id);
        return ResponseEntity.noContent().build();
    }
}
