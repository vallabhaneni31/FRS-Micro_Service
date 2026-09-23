package com.motivity.transport.service;

import com.motivity.transport.dto.DepotRequest;
import com.motivity.transport.dto.DepotResponse;
import com.motivity.transport.entity.Depot;
import com.motivity.transport.exception.NotFoundException;
import com.motivity.transport.repository.DepotRepository;
import com.motivity.transport.security.TransportScope;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

@Service
public class DepotService {

    private final DepotRepository depotRepository;

    public DepotService(DepotRepository depotRepository) {
        this.depotRepository = depotRepository;
    }

    public List<DepotResponse> list(TransportScope scope) {
        List<Depot> depots = switch (scope.level()) {
            case TENANT_WIDE -> depotRepository.findAllByTenantId(scope.tenantId());
            // Route Manager only ever needs to see their own one depot.
            case DEPOT -> depotRepository.findByIdAndTenantId(scope.depotId(), scope.tenantId()).map(List::of).orElse(List.of());
            case BUS, UNASSIGNED -> List.of();
        };
        return depots.stream().map(DepotResponse::from).toList();
    }

    public DepotResponse get(TransportScope scope, UUID id) {
        Depot depot = depotRepository.findByIdAndTenantId(id, scope.tenantId())
                .orElseThrow(() -> new NotFoundException("depot not found: " + id));
        boolean inScope = switch (scope.level()) {
            case TENANT_WIDE -> true;
            case DEPOT -> scope.depotId().equals(depot.getId());
            case BUS, UNASSIGNED -> false;
        };
        if (!inScope) {
            throw new NotFoundException("depot not found: " + id);
        }
        return DepotResponse.from(depot);
    }

    // Only DEPOTS_WRITE (tenant_admin) can ever reach create/update — see
    // TransportPermissions — so no depot-scope restriction is needed here,
    // unlike BusService/RouteService's writes.
    @Transactional
    public DepotResponse create(TransportScope scope, DepotRequest request) {
        if (request.depotName() == null || request.depotName().isBlank()) {
            throw new IllegalArgumentException("depotName is required");
        }
        Depot depot = Depot.builder()
                .tenantId(scope.tenantId())
                .depotName(request.depotName())
                .address(request.address())
                .build();
        return DepotResponse.from(depotRepository.save(depot));
    }

    @Transactional
    public DepotResponse update(TransportScope scope, UUID id, DepotRequest request) {
        Depot depot = depotRepository.findByIdAndTenantId(id, scope.tenantId())
                .orElseThrow(() -> new NotFoundException("depot not found: " + id));
        if (request.depotName() != null) depot.setDepotName(request.depotName());
        if (request.address() != null) depot.setAddress(request.address());
        return DepotResponse.from(depotRepository.save(depot));
    }
}
