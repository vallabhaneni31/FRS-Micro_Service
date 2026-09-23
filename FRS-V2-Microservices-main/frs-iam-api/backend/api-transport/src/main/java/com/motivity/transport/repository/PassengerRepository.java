package com.motivity.transport.repository;

import com.motivity.transport.entity.Passenger;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface PassengerRepository extends JpaRepository<Passenger, UUID> {
    List<Passenger> findAllByTenantId(UUID tenantId);

    List<Passenger> findAllByTenantIdAndBusId(UUID tenantId, UUID busId);

    Optional<Passenger> findByIdAndTenantId(UUID id, UUID tenantId);

    // Route Manager (DEPOT scope) — passengers have no depot_id of their
    // own, only bus_id, same pattern as TransportDeviceRepository's
    // findAllByTenantIdAndBusDepotId.
    @Query("SELECT p FROM Passenger p WHERE p.tenantId = :tenantId " +
           "AND p.busId IN (SELECT b.id FROM Bus b WHERE b.tenantId = :tenantId AND b.depotId = :depotId)")
    List<Passenger> findAllByTenantIdAndBusDepotId(@Param("tenantId") UUID tenantId, @Param("depotId") UUID depotId);
}
