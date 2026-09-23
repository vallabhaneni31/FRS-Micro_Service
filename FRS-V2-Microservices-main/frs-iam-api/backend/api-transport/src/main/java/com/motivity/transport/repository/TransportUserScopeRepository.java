package com.motivity.transport.repository;

import com.motivity.transport.entity.TransportUserScope;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface TransportUserScopeRepository extends JpaRepository<TransportUserScope, UUID> {
    List<TransportUserScope> findAllByTenantIdAndKeycloakSubject(UUID tenantId, String keycloakSubject);

    List<TransportUserScope> findAllByTenantId(UUID tenantId);

    Optional<TransportUserScope> findByIdAndTenantId(UUID id, UUID tenantId);

    // Route Manager's own view: only Operations Manager (bus-level) rows
    // whose bus falls within their depot — a depot-level (Route Manager)
    // assignment row never matches this (busId is null on those), which is
    // exactly right: a Route Manager cannot see or manage other Route
    // Managers, only the Operations Managers under their own depot.
    @Query("SELECT s FROM TransportUserScope s WHERE s.tenantId = :tenantId " +
           "AND s.busId IN (SELECT b.id FROM Bus b WHERE b.tenantId = :tenantId AND b.depotId = :depotId)")
    List<TransportUserScope> findAllByTenantIdAndBusInDepot(@Param("tenantId") UUID tenantId, @Param("depotId") UUID depotId);
}
