package com.motivity.transport.entity;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.annotations.UpdateTimestamp;
import org.hibernate.type.SqlTypes;

import java.time.OffsetDateTime;
import java.util.UUID;

@Entity
@Table(name = "routes")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Route {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(name = "route_name", nullable = false, length = 150)
    private String routeName;

    @Column(name = "depot_id")
    private UUID depotId;

    // Stored as JSONB; kept as a raw JSON string at this layer rather than
    // introducing a JSON-mapping library dependency this early — callers
    // that need structured stop data can parse it, same shape decision
    // deferred to phase 2f (route management API) where the real DTO shape
    // will be driven by what the frontend actually needs.
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "stops", nullable = false)
    @Builder.Default
    private String stops = "[]";

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt;
}
