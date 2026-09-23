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
@Table(name = "transport_devices")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TransportDevice {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(name = "bus_id", nullable = false)
    private UUID busId;

    @Column(name = "device_code", nullable = false, length = 80)
    private String deviceCode;

    // Per-device signing secret — see the migration's column comment and
    // the architecture plan's device-auth decision. Never logged, never
    // returned in any API response (services/controllers must exclude it).
    @Column(name = "device_secret", nullable = false)
    private String deviceSecret;

    @Column(name = "camera_position", nullable = false, length = 20)
    private String cameraPosition;

    @Column(nullable = false, length = 20)
    @Builder.Default
    private String status = "active";

    @Column(name = "last_heartbeat")
    private OffsetDateTime lastHeartbeat;

    @Column(name = "decommissioned_at")
    private OffsetDateTime decommissionedAt;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;
}
