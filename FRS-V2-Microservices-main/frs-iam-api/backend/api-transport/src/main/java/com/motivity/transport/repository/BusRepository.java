package com.motivity.transport.repository;

import com.motivity.transport.entity.Bus;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface BusRepository extends JpaRepository<Bus, UUID> {
    List<Bus> findAllByTenantId(UUID tenantId);

    // Route Manager (DEPOT scope) — same "in the lookup itself" discipline.
    List<Bus> findAllByTenantIdAndDepotId(UUID tenantId, UUID depotId);

    // tenantId included in the lookup itself, not checked after the fact —
    // a bus id from one tenant can never resolve under another tenant's id.
    Optional<Bus> findByIdAndTenantId(UUID id, UUID tenantId);
}
