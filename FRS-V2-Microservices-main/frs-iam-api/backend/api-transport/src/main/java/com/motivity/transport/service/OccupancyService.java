package com.motivity.transport.service;

import com.motivity.transport.dto.OccupancyResponse;
import com.motivity.transport.entity.Bus;
import com.motivity.transport.exception.NotFoundException;
import com.motivity.transport.repository.BusRepository;
import com.motivity.transport.entity.OccupancySnapshot;
import com.motivity.transport.repository.OccupancySnapshotRepository;
import com.motivity.transport.security.TransportScope;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.UUID;

/** occupancy_snapshots has no depot_id of its own — see OccupancySnapshotRepository. */
@Service
public class OccupancyService {

    private final OccupancySnapshotRepository occupancySnapshotRepository;
    private final BusRepository busRepository;

    public OccupancyService(OccupancySnapshotRepository occupancySnapshotRepository, BusRepository busRepository) {
        this.occupancySnapshotRepository = occupancySnapshotRepository;
        this.busRepository = busRepository;
    }

    public List<OccupancyResponse> list(TransportScope scope) {
        List<OccupancySnapshot> snapshots = switch (scope.level()) {
            case TENANT_WIDE -> occupancySnapshotRepository.findAllByTenantId(scope.tenantId());
            case DEPOT -> occupancySnapshotRepository.findAllByTenantIdAndBusDepotId(scope.tenantId(), scope.depotId());
            case BUS -> occupancySnapshotRepository.findByBusIdAndTenantId(scope.busId(), scope.tenantId())
                    .map(List::of).orElse(List.of());
            case UNASSIGNED -> List.of();
        };
        return snapshots.stream().map(OccupancyResponse::from).toList();
    }

    public OccupancyResponse get(TransportScope scope, UUID busId) {
        if (!busInScope(scope, busId)) {
            throw new NotFoundException("no occupancy record for bus: " + busId);
        }
        return occupancySnapshotRepository.findByBusIdAndTenantId(busId, scope.tenantId())
                .map(OccupancyResponse::from)
                .orElseThrow(() -> new NotFoundException("no occupancy record for bus: " + busId));
    }

    private boolean busInScope(TransportScope scope, UUID busId) {
        return switch (scope.level()) {
            case TENANT_WIDE -> true;
            case DEPOT -> {
                Bus bus = busRepository.findByIdAndTenantId(busId, scope.tenantId()).orElse(null);
                yield bus != null && scope.depotId().equals(bus.getDepotId());
            }
            case BUS -> scope.busId().equals(busId);
            case UNASSIGNED -> false;
        };
    }
}
