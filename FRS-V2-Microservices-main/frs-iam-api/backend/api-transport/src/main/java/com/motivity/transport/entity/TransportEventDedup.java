package com.motivity.transport.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.time.OffsetDateTime;
import java.util.UUID;

/** Idempotency claim table for the Kafka consumer — mirrors the existing platform's event_dedup table. */
@Entity
@Table(name = "transport_event_dedup")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class TransportEventDedup {

    @Id
    @Column(name = "event_uid")
    private UUID eventUid;

    @Column(name = "claimed_at", nullable = false)
    private OffsetDateTime claimedAt;
}
