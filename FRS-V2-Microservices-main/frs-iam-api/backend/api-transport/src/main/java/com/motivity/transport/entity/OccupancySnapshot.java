package com.motivity.transport.entity;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.time.OffsetDateTime;
import java.util.UUID;

/** Current-state row per bus (upserted by the event worker) — not a history table; see boarding_events for that. */
@Entity
@Table(name = "occupancy_snapshots")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class OccupancySnapshot {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(name = "bus_id", nullable = false, unique = true)
    private UUID busId;

    @Column(name = "occupancy_count", nullable = false)
    @Builder.Default
    private Integer occupancyCount = 0;

    @Column(name = "updated_at", nullable = false)
    @Builder.Default
    private OffsetDateTime updatedAt = OffsetDateTime.now();
}
