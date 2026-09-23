package com.motivity.transport.entity;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.OffsetDateTime;
import java.util.UUID;

@Entity
@Table(name = "buses")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Bus {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    // Every entity in this schema carries tenantId directly — see the
    // migration's header comment. Every repository query must filter by it.
    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(name = "bus_code", nullable = false, length = 50)
    private String busCode;

    @Column(name = "registration_no", length = 50)
    private String registrationNo;

    @Column(name = "route_id")
    private UUID routeId;

    @Column(name = "depot_id")
    private UUID depotId;

    private Integer capacity;

    @Column(nullable = false, length = 20)
    @Builder.Default
    private String status = "active";

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt;
}
