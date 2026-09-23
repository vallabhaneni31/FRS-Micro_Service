package com.motivity.transport.repository;

import com.motivity.transport.entity.Depot;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface DepotRepository extends JpaRepository<Depot, UUID> {
    List<Depot> findAllByTenantId(UUID tenantId);

    // Same "tenantId in the lookup itself" discipline as every other
    // repository in this service — a depot id from one tenant can never
    // resolve under another tenant's id.
    Optional<Depot> findByIdAndTenantId(UUID id, UUID tenantId);
}
