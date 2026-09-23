package com.motivity.transport.service;

import com.motivity.transport.dto.BusRequest;
import com.motivity.transport.dto.BusResponse;
import com.motivity.transport.entity.Bus;
import com.motivity.transport.exception.InvalidReferenceException;
import com.motivity.transport.exception.NotFoundException;
import com.motivity.transport.repository.BusRepository;
import com.motivity.transport.repository.DepotRepository;
import com.motivity.transport.repository.RouteRepository;
import com.motivity.transport.security.TransportScope;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/**
 * Every method takes a TransportScope, not a bare tenantId — tenantId is
 * still the outer isolation boundary (scope.tenantId()), but scope also
 * carries the depot/bus restriction a Route Manager or Operations Manager
 * is under. TENANT_WIDE (Admin/Viewer) behaves exactly as this service did
 * before scope existed.
 */
@Service
public class BusService {

    private final BusRepository busRepository;
    private final RouteRepository routeRepository;
    private final DepotRepository depotRepository;

    public BusService(BusRepository busRepository, RouteRepository routeRepository, DepotRepository depotRepository) {
        this.busRepository = busRepository;
        this.routeRepository = routeRepository;
        this.depotRepository = depotRepository;
    }

    public List<BusResponse> list(TransportScope scope) {
        List<Bus> buses = switch (scope.level()) {
            case TENANT_WIDE -> busRepository.findAllByTenantId(scope.tenantId());
            case DEPOT -> busRepository.findAllByTenantIdAndDepotId(scope.tenantId(), scope.depotId());
            // Operations Manager: their "list" is always just their one bus.
            case BUS -> busRepository.findByIdAndTenantId(scope.busId(), scope.tenantId()).map(List::of).orElse(List.of());
            case UNASSIGNED -> List.of();
        };
        return buses.stream().map(BusResponse::from).toList();
    }

    public BusResponse get(TransportScope scope, UUID id) {
        return BusResponse.from(requireInScope(scope, id));
    }

    @Transactional
    public BusResponse create(TransportScope scope, BusRequest request) {
        if (request.busCode() == null || request.busCode().isBlank()) {
            throw new IllegalArgumentException("busCode is required");
        }
        if (scope.level() == TransportScope.Level.BUS || scope.level() == TransportScope.Level.UNASSIGNED) {
            // Defensive: neither role holding these scope levels has BUSES_WRITE
            // today, but scope is the actual enforcement boundary, not the
            // permission check alone — never rely on just one layer.
            throw new InvalidReferenceException("caller's scope does not permit creating a bus");
        }
        validateRouteReference(scope.tenantId(), request.routeId());
        UUID depotId = resolveDepotIdForWrite(scope, request.depotId());

        Bus bus = Bus.builder()
                .tenantId(scope.tenantId())
                .busCode(request.busCode())
                .registrationNo(request.registrationNo())
                .routeId(request.routeId())
                .depotId(depotId)
                .capacity(request.capacity())
                .status(request.status() != null ? request.status() : "active")
                .build();
        return BusResponse.from(busRepository.save(bus));
    }

    // PATCH semantics: only non-null fields in the request overwrite the existing row.
    @Transactional
    public BusResponse update(TransportScope scope, UUID id, BusRequest request) {
        Bus bus = requireInScope(scope, id);

        if (request.busCode() != null) bus.setBusCode(request.busCode());
        if (request.registrationNo() != null) bus.setRegistrationNo(request.registrationNo());
        if (request.routeId() != null) {
            validateRouteReference(scope.tenantId(), request.routeId());
            bus.setRouteId(request.routeId());
        }
        if (request.depotId() != null) {
            bus.setDepotId(resolveDepotIdForWrite(scope, request.depotId()));
        }
        if (request.capacity() != null) bus.setCapacity(request.capacity());
        if (request.status() != null) bus.setStatus(request.status());

        return BusResponse.from(busRepository.save(bus));
    }

    @Transactional
    public void delete(TransportScope scope, UUID id) {
        Bus bus = requireInScope(scope, id);
        busRepository.delete(bus);
    }

    /**
     * Fetches by tenant+id (as before), then additionally enforces the
     * caller's depot/bus scope. A bus outside the caller's scope resolves
     * to NotFoundException, same as a different tenant's bus — never leaks
     * existence, matches the pattern already established for cross-tenant
     * lookups.
     */
    private Bus requireInScope(TransportScope scope, UUID id) {
        Bus bus = busRepository.findByIdAndTenantId(id, scope.tenantId())
                .orElseThrow(() -> new NotFoundException("bus not found: " + id));
        boolean inScope = switch (scope.level()) {
            case TENANT_WIDE -> true;
            case DEPOT -> scope.depotId().equals(bus.getDepotId());
            case BUS -> scope.busId().equals(bus.getId());
            case UNASSIGNED -> false;
        };
        if (!inScope) {
            throw new NotFoundException("bus not found: " + id);
        }
        return bus;
    }

    // A DEPOT-scoped caller's depotId is always forced to their own scope —
    // a client-supplied depotId is ignored for them, the same "never trust
    // client input for the boundary that matters" rule tenantId already
    // follows. A TENANT_WIDE caller's requested depotId is validated for
    // real (must belong to their tenant) rather than trusted outright.
    private UUID resolveDepotIdForWrite(TransportScope scope, UUID requestedDepotId) {
        if (scope.level() == TransportScope.Level.DEPOT) {
            return scope.depotId();
        }
        if (requestedDepotId == null) return null;
        depotRepository.findByIdAndTenantId(requestedDepotId, scope.tenantId())
                .orElseThrow(() -> new InvalidReferenceException("depotId does not belong to your tenant: " + requestedDepotId));
        return requestedDepotId;
    }

    // routes.id has no tenant-aware foreign key at the database level — a
    // bus must never be linkable to another tenant's route.
    private void validateRouteReference(UUID tenantId, UUID routeId) {
        if (routeId == null) return;
        routeRepository.findByIdAndTenantId(routeId, tenantId)
                .orElseThrow(() -> new InvalidReferenceException("routeId does not belong to your tenant: " + routeId));
    }
}
