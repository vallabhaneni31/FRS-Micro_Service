package com.motivity.transport.entity;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.time.OffsetDateTime;
import java.util.UUID;

/** Immutable raw event log — one row per Jetson-reported boarding/deboarding detection. */
@Entity
@Table(name = "boarding_events")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class BoardingEvent {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    // Producer-supplied idempotency key — claimed in transport_event_dedup
    // before this row is ever inserted (see TransportEventDedup).
    @Column(name = "event_uid", nullable = false, unique = true)
    private UUID eventUid;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(name = "bus_id", nullable = false)
    private UUID busId;

    @Column(name = "device_id", nullable = false)
    private UUID deviceId;

    @Column(name = "event_type", nullable = false, length = 12)
    private String eventType; // BOARDING | DEBOARDING

    @Column(name = "person_ref", length = 100)
    private String personRef;

    // Resolved via PassengerMatchingService (Track B) when personRef wasn't
    // already provided by the device — nullable, an unmatched event is
    // expected and must never block occupancy counting.
    @Column(name = "passenger_id")
    private UUID passengerId;

    private java.math.BigDecimal confidence;

    @Column(name = "photo_key", length = 500)
    private String photoKey;

    @Column(name = "event_time", nullable = false)
    private OffsetDateTime eventTime;

    @Column(name = "received_at", nullable = false)
    @Builder.Default
    private OffsetDateTime receivedAt = OffsetDateTime.now();
}
