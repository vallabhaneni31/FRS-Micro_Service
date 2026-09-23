package com.motivity.transport.entity;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import org.hibernate.annotations.CreationTimestamp;

import java.time.OffsetDateTime;
import java.util.UUID;

@Entity
@Table(name = "transport_user_scope")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TransportUserScope {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    // Keycloak JWT `sub` claim — see TransportScopeResolver for how this is looked up.
    @Column(name = "keycloak_subject", nullable = false, length = 100)
    private String keycloakSubject;

    @Column(name = "depot_id")
    private UUID depotId;

    @Column(name = "bus_id")
    private UUID busId;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;
}
