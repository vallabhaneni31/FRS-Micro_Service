package com.motivity.transport.repository;

import com.motivity.transport.entity.OccupancySnapshot;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface OccupancySnapshotRepository extends JpaRepository<OccupancySnapshot, UUID> {
    Optional<OccupancySnapshot> findByBusId(UUID busId);

    // Tenant-scoped single lookup for the 2g read API — "tenantId in the
    // lookup itself" discipline, same as every other single-resource fetch
    // in this service.
    Optional<OccupancySnapshot> findByBusIdAndTenantId(UUID busId, UUID tenantId);

    List<OccupancySnapshot> findAllByTenantId(UUID tenantId);

    // Route Manager (DEPOT scope) — same subquery-through-the-bus approach
    // as TransportDeviceRepository.findAllByTenantIdAndBusDepotId, since
    // occupancy_snapshots has no depot_id of its own either.
    @Query("SELECT o FROM OccupancySnapshot o WHERE o.tenantId = :tenantId " +
           "AND o.busId IN (SELECT b.id FROM Bus b WHERE b.tenantId = :tenantId AND b.depotId = :depotId)")
    List<OccupancySnapshot> findAllByTenantIdAndBusDepotId(@Param("tenantId") UUID tenantId, @Param("depotId") UUID depotId);

    // Single atomic upsert — handles both "first event ever for this bus"
    // (INSERT branch) and "bus already has a snapshot row" (ON CONFLICT
    // UPDATE branch) with one statement, so there's no read-then-write race
    // between concurrent events for the same bus. delta is +1 for BOARDING,
    // -1 for DEBOARDING; GREATEST(...,0) floors both branches at zero —
    // a bus's very first recorded event being a stray/duplicate DEBOARDING
    // must not create a negative starting count.
    @Modifying
    @Query(value = """
            INSERT INTO occupancy_snapshots (id, tenant_id, bus_id, occupancy_count, updated_at)
            VALUES (gen_random_uuid(), :tenantId, :busId, GREATEST(:delta, 0), now())
            ON CONFLICT (bus_id) DO UPDATE
            SET occupancy_count = GREATEST(occupancy_snapshots.occupancy_count + :delta, 0),
                updated_at = now()
            """, nativeQuery = true)
    void upsertOccupancy(@Param("tenantId") UUID tenantId, @Param("busId") UUID busId, @Param("delta") int delta);
}
