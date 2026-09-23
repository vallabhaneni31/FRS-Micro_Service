package com.motivity.transport.repository;

import com.motivity.transport.entity.TransportDevice;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface TransportDeviceRepository extends JpaRepository<TransportDevice, UUID> {
    List<TransportDevice> findAllByTenantId(UUID tenantId);

    List<TransportDevice> findAllByBusId(UUID busId);

    // Tenant-scoped device listing, optionally narrowed to one bus.
    List<TransportDevice> findAllByTenantIdAndBusId(UUID tenantId, UUID busId);

    Optional<TransportDevice> findByIdAndTenantId(UUID id, UUID tenantId);

    // Route Manager (DEPOT scope) — devices have no depot_id of their own,
    // only bus_id, so this goes through the bus's depot via a subquery
    // rather than a direct column filter.
    @Query("SELECT d FROM TransportDevice d WHERE d.tenantId = :tenantId " +
           "AND d.busId IN (SELECT b.id FROM Bus b WHERE b.tenantId = :tenantId AND b.depotId = :depotId)")
    List<TransportDevice> findAllByTenantIdAndBusDepotId(@Param("tenantId") UUID tenantId, @Param("depotId") UUID depotId);

    // Used by device auth: look up purely by device_code (the JWT doesn't
    // carry tenant_id ahead of verification — the device's own row is what
    // tells us which tenant it belongs to).
    Optional<TransportDevice> findByDeviceCode(String deviceCode);

    // Heartbeat: a single UPDATE, not fetch-then-save — this is
    // high-frequency device telemetry, not something worth two round trips
    // for. Mirrors the existing platform's direct
    // "UPDATE facility_device SET last_heartbeat = NOW() ..." pattern
    // (heartbeat is idempotent state, not an event needing Kafka/ordering).
    //
    // clearAutomatically: a bulk @Modifying UPDATE writes straight to the
    // database but does NOT touch Hibernate's first-level (persistence
    // context) cache — without this, any TransportDevice already loaded
    // earlier in the same session/transaction keeps showing its
    // pre-update lastHeartbeat if re-fetched by findById, even though the
    // database row is correct. Caught by DeviceEventControllerTest's
    // heartbeat test doing exactly that re-fetch.
    @Modifying(clearAutomatically = true)
    @Query("UPDATE TransportDevice d SET d.lastHeartbeat = :timestamp WHERE d.id = :id")
    int updateLastHeartbeat(UUID id, OffsetDateTime timestamp);
}
