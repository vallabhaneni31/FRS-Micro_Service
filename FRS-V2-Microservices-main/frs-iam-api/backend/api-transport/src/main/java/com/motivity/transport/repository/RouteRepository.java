package com.motivity.transport.repository;

import com.motivity.transport.entity.Route;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface RouteRepository extends JpaRepository<Route, UUID> {
    List<Route> findAllByTenantId(UUID tenantId);

    // Route Manager (DEPOT scope) — same "in the lookup itself" discipline as BusRepository.
    List<Route> findAllByTenantIdAndDepotId(UUID tenantId, UUID depotId);

    // Same "tenantId in the lookup itself" discipline as BusRepository —
    // also used to validate a bus's routeId actually belongs to the
    // caller's tenant before linking them (routes.id has no tenant-aware
    // FK at the DB level).
    Optional<Route> findByIdAndTenantId(UUID id, UUID tenantId);
}
