package com.motivity.transport.service;

import com.motivity.transport.dto.TransportUserScopeRequest;
import com.motivity.transport.dto.TransportUserScopeResponse;
import com.motivity.transport.entity.Bus;
import com.motivity.transport.entity.TransportUserScope;
import com.motivity.transport.exception.InvalidReferenceException;
import com.motivity.transport.exception.NotFoundException;
import com.motivity.transport.repository.BusRepository;
import com.motivity.transport.repository.DepotRepository;
import com.motivity.transport.repository.TransportUserScopeRepository;
import com.motivity.transport.security.TransportScope;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/**
 * Assigns/unassigns which depot (Route Manager) or bus (Operations
 * Manager) a Keycloak user is scoped to. Does NOT create Keycloak users or
 * assign realm roles — that's the existing platform's POST /api/users,
 * reused as-is (see the build checklist for why: fully generic, no
 * vertical checks, already supports site_admin/hr_manager). This service
 * only ever writes to transport_user_scope, inside the isolated
 * transport_intelligence database.
 *
 * Permission (TransportPermissions.USERS_MANAGE) says who can reach these
 * endpoints at all; scope enforcement here says what they're allowed to do
 * once there — the same split already used for Bus/Route/Device writes.
 */
@Service
public class TransportUserScopeService {

    private final TransportUserScopeRepository scopeRepository;
    private final DepotRepository depotRepository;
    private final BusRepository busRepository;

    public TransportUserScopeService(TransportUserScopeRepository scopeRepository,
                                      DepotRepository depotRepository,
                                      BusRepository busRepository) {
        this.scopeRepository = scopeRepository;
        this.depotRepository = depotRepository;
        this.busRepository = busRepository;
    }

    public List<TransportUserScopeResponse> list(TransportScope callerScope) {
        List<TransportUserScope> rows = switch (callerScope.level()) {
            case TENANT_WIDE -> scopeRepository.findAllByTenantId(callerScope.tenantId());
            // Route Manager: only the Operations Managers under their own
            // depot — never other Route Managers, matching "assign
            // Operations Managers to their own routes/buses only".
            case DEPOT -> scopeRepository.findAllByTenantIdAndBusInDepot(callerScope.tenantId(), callerScope.depotId());
            case BUS, UNASSIGNED -> List.of();
        };
        return rows.stream().map(TransportUserScopeResponse::from).toList();
    }

    @Transactional
    public TransportUserScopeResponse create(TransportScope callerScope, TransportUserScopeRequest request) {
        boolean hasDepot = request.depotId() != null;
        boolean hasBus = request.busId() != null;
        if (hasDepot == hasBus) { // both null or both set — exactly one is required
            throw new IllegalArgumentException("exactly one of depotId or busId is required");
        }

        UUID depotId = null;
        UUID busId = null;

        if (callerScope.level() == TransportScope.Level.TENANT_WIDE) {
            if (hasDepot) {
                depotId = validateDepotBelongsToTenant(callerScope.tenantId(), request.depotId());
            } else {
                busId = validateBusBelongsToTenant(callerScope.tenantId(), request.busId());
            }
        } else if (callerScope.level() == TransportScope.Level.DEPOT) {
            // Route Manager: can only assign Operations Managers (busId),
            // never another Route Manager (depotId) — and only to a bus
            // within their own depot.
            if (hasDepot) {
                throw new InvalidReferenceException("Route Managers cannot assign depot-level scope");
            }
            Bus bus = busRepository.findByIdAndTenantId(request.busId(), callerScope.tenantId())
                    .orElseThrow(() -> new InvalidReferenceException("busId does not belong to your tenant: " + request.busId()));
            if (!callerScope.depotId().equals(bus.getDepotId())) {
                throw new InvalidReferenceException("busId does not belong to your depot: " + request.busId());
            }
            busId = bus.getId();
        } else {
            // BUS/UNASSIGNED never hold USERS_MANAGE — defensive, matches
            // the same belt-and-suspenders pattern already used in BusService.
            throw new InvalidReferenceException("caller's scope does not permit assigning users");
        }

        TransportUserScope scope = TransportUserScope.builder()
                .tenantId(callerScope.tenantId())
                .keycloakSubject(request.keycloakSubject())
                .depotId(depotId)
                .busId(busId)
                .build();
        return TransportUserScopeResponse.from(scopeRepository.save(scope));
    }

    @Transactional
    public void delete(TransportScope callerScope, UUID id) {
        TransportUserScope scope = scopeRepository.findByIdAndTenantId(id, callerScope.tenantId())
                .orElseThrow(() -> new NotFoundException("scope assignment not found: " + id));

        boolean inScope = switch (callerScope.level()) {
            case TENANT_WIDE -> true;
            // Route Manager can only unassign an Operations Manager whose
            // bus is in their own depot — never a depot-level (Route
            // Manager) assignment, even their own.
            case DEPOT -> scope.getBusId() != null
                    && busRepository.findByIdAndTenantId(scope.getBusId(), callerScope.tenantId())
                            .map(b -> callerScope.depotId().equals(b.getDepotId())).orElse(false);
            case BUS, UNASSIGNED -> false;
        };
        if (!inScope) {
            throw new NotFoundException("scope assignment not found: " + id);
        }
        scopeRepository.delete(scope);
    }

    private UUID validateDepotBelongsToTenant(UUID tenantId, UUID depotId) {
        return depotRepository.findByIdAndTenantId(depotId, tenantId)
                .orElseThrow(() -> new InvalidReferenceException("depotId does not belong to your tenant: " + depotId))
                .getId();
    }

    private UUID validateBusBelongsToTenant(UUID tenantId, UUID busId) {
        return busRepository.findByIdAndTenantId(busId, tenantId)
                .orElseThrow(() -> new InvalidReferenceException("busId does not belong to your tenant: " + busId))
                .getId();
    }
}
