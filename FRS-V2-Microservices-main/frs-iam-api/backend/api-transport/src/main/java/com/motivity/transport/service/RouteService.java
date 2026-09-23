package com.motivity.transport.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.motivity.transport.dto.RouteRequest;
import com.motivity.transport.dto.RouteResponse;
import com.motivity.transport.entity.Route;
import com.motivity.transport.exception.InvalidReferenceException;
import com.motivity.transport.exception.NotFoundException;
import com.motivity.transport.repository.BusRepository;
import com.motivity.transport.repository.DepotRepository;
import com.motivity.transport.repository.RouteRepository;
import com.motivity.transport.security.TransportScope;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Mirrors BusService's scope handling exactly — see its class comment. */
@Service
public class RouteService {

    private final RouteRepository routeRepository;
    private final DepotRepository depotRepository;
    private final BusRepository busRepository;
    private final ObjectMapper objectMapper;

    public RouteService(RouteRepository routeRepository, DepotRepository depotRepository,
                         BusRepository busRepository, ObjectMapper objectMapper) {
        this.routeRepository = routeRepository;
        this.depotRepository = depotRepository;
        this.busRepository = busRepository;
        this.objectMapper = objectMapper;
    }

    public List<RouteResponse> list(TransportScope scope) {
        List<Route> routes = switch (scope.level()) {
            case TENANT_WIDE -> routeRepository.findAllByTenantId(scope.tenantId());
            case DEPOT -> routeRepository.findAllByTenantIdAndDepotId(scope.tenantId(), scope.depotId());
            // Operations Manager — read-only visibility into the single
            // route their own bus runs (Track B UI needs this for Bus
            // Stops / Dashboard / Settings). Resolved transitively through
            // Bus.routeId since routes carry no bus_id of their own.
            // hr_manager holds ROUTES_READ only, never ROUTES_WRITE.
            case BUS -> resolveOwnRoute(scope).map(List::of).orElse(List.of());
            case UNASSIGNED -> List.of();
        };
        return routes.stream().map(this::toResponse).toList();
    }

    public RouteResponse get(TransportScope scope, UUID id) {
        return toResponse(requireInScope(scope, id));
    }

    @Transactional
    public RouteResponse create(TransportScope scope, RouteRequest request) {
        if (request.routeName() == null || request.routeName().isBlank()) {
            throw new IllegalArgumentException("routeName is required");
        }
        if (scope.level() == TransportScope.Level.BUS || scope.level() == TransportScope.Level.UNASSIGNED) {
            throw new InvalidReferenceException("caller's scope does not permit creating a route");
        }
        UUID depotId = resolveDepotIdForWrite(scope, request.depotId());

        Route route = Route.builder()
                .tenantId(scope.tenantId())
                .routeName(request.routeName())
                .depotId(depotId)
                .stops(request.stops() != null ? request.stops().toString() : "[]")
                .build();
        return toResponse(routeRepository.save(route));
    }

    // PATCH semantics — only non-null fields overwrite the existing row.
    @Transactional
    public RouteResponse update(TransportScope scope, UUID id, RouteRequest request) {
        Route route = requireInScope(scope, id);
        if (request.routeName() != null) route.setRouteName(request.routeName());
        if (request.depotId() != null) route.setDepotId(resolveDepotIdForWrite(scope, request.depotId()));
        if (request.stops() != null) route.setStops(request.stops().toString());
        return toResponse(routeRepository.save(route));
    }

    private Route requireInScope(TransportScope scope, UUID id) {
        Route route = routeRepository.findByIdAndTenantId(id, scope.tenantId())
                .orElseThrow(() -> new NotFoundException("route not found: " + id));
        boolean inScope = switch (scope.level()) {
            case TENANT_WIDE -> true;
            case DEPOT -> scope.depotId().equals(route.getDepotId());
            case BUS -> resolveOwnRoute(scope).map(r -> r.getId().equals(route.getId())).orElse(false);
            case UNASSIGNED -> false;
        };
        if (!inScope) {
            throw new NotFoundException("route not found: " + id);
        }
        return route;
    }

    private Optional<Route> resolveOwnRoute(TransportScope scope) {
        return busRepository.findByIdAndTenantId(scope.busId(), scope.tenantId())
                .flatMap(bus -> bus.getRouteId() == null
                        ? Optional.empty()
                        : routeRepository.findByIdAndTenantId(bus.getRouteId(), scope.tenantId()));
    }

    // Same "DEPOT-scoped caller's depotId is always forced to their own
    // scope" rule as BusService.resolveDepotIdForWrite.
    private UUID resolveDepotIdForWrite(TransportScope scope, UUID requestedDepotId) {
        if (scope.level() == TransportScope.Level.DEPOT) {
            return scope.depotId();
        }
        if (requestedDepotId == null) return null;
        depotRepository.findByIdAndTenantId(requestedDepotId, scope.tenantId())
                .orElseThrow(() -> new InvalidReferenceException("depotId does not belong to your tenant: " + requestedDepotId));
        return requestedDepotId;
    }

    private RouteResponse toResponse(Route route) {
        JsonNode stops;
        try {
            stops = objectMapper.readTree(route.getStops());
        } catch (Exception e) {
            stops = objectMapper.createArrayNode();
        }
        return new RouteResponse(route.getId(), route.getRouteName(), route.getDepotId(), stops, route.getCreatedAt(), route.getUpdatedAt());
    }
}
