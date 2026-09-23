package com.motivity.transport.repository;

import com.motivity.transport.entity.BoardingEvent;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.OffsetDateTime;
import java.util.UUID;

public interface BoardingEventRepository extends JpaRepository<BoardingEvent, UUID> {
    Page<BoardingEvent> findAllByTenantId(UUID tenantId, Pageable pageable);

    // Single flexible query for the 2g history endpoint — busId/from/to are
    // all optional (null = "don't filter on this"), covering every
    // combination the API needs without a narrower method per combination.
    // Replaces an earlier, unused findAllByTenantIdAndBusIdAndEventTimeBetween
    // that required every filter to be present.
    //
    // Native, not JPQL, with explicit casts: the JPQL version of this query
    // failed at runtime with "ERROR: could not determine data type of
    // parameter $4" — when a bind parameter's ONLY occurrence in the
    // generated SQL is inside "? IS NULL" (true whenever from/to are
    // omitted, which is the common case), Postgres's extended query
    // protocol has no other usage to infer its type from at PREPARE time
    // and refuses outright. Same root cause class already hit and fixed
    // with explicit casts in OccupancySnapshotRepository's upsert (2e).
    //
    // CAST(:x AS type), not the shorter :x::type — Postgres's "::" cast
    // shorthand immediately after a named parameter broke Spring Data's own
    // native-query parameter parser ("No parameter named ':busId'... it
    // read "busId::uuid" as the parameter name). A second, different bug
    // from the same one-line fix attempt, caught by actually running the
    // test rather than assuming the first correction was sufficient.
    //
    // countQuery is required because Spring Data can't auto-derive a count
    // query from arbitrary native SQL.
    // depotId (added alongside busId, same optional-filter shape and same
    // CAST(:x AS type) discipline as the other three params — see the
    // class comment above for why that specific syntax is load-bearing
    // here) intersects with busId rather than replacing it: a DEPOT-scoped
    // caller who also passes a busId outside their depot correctly gets
    // zero rows from the AND, no separate pre-validation needed.
    @Query(
            value = """
                    SELECT * FROM boarding_events
                    WHERE tenant_id = :tenantId
                      AND (CAST(:busId AS uuid) IS NULL OR bus_id = CAST(:busId AS uuid))
                      AND (CAST(:depotId AS uuid) IS NULL OR bus_id IN (SELECT id FROM buses WHERE depot_id = CAST(:depotId AS uuid)))
                      AND (CAST(:from AS timestamptz) IS NULL OR event_time >= CAST(:from AS timestamptz))
                      AND (CAST(:to AS timestamptz) IS NULL OR event_time <= CAST(:to AS timestamptz))
                    ORDER BY event_time DESC
                    """,
            countQuery = """
                    SELECT count(*) FROM boarding_events
                    WHERE tenant_id = :tenantId
                      AND (CAST(:busId AS uuid) IS NULL OR bus_id = CAST(:busId AS uuid))
                      AND (CAST(:depotId AS uuid) IS NULL OR bus_id IN (SELECT id FROM buses WHERE depot_id = CAST(:depotId AS uuid)))
                      AND (CAST(:from AS timestamptz) IS NULL OR event_time >= CAST(:from AS timestamptz))
                      AND (CAST(:to AS timestamptz) IS NULL OR event_time <= CAST(:to AS timestamptz))
                    """,
            nativeQuery = true)
    Page<BoardingEvent> search(@Param("tenantId") UUID tenantId,
                                @Param("busId") UUID busId,
                                @Param("depotId") UUID depotId,
                                @Param("from") OffsetDateTime from,
                                @Param("to") OffsetDateTime to,
                                Pageable pageable);
}
