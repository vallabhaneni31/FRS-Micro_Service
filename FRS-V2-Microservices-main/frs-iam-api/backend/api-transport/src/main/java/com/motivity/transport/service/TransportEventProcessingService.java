package com.motivity.transport.service;

import com.motivity.transport.entity.BoardingEvent;
import com.motivity.transport.event.OccupancyChangedEvent;
import com.motivity.transport.kafka.TransportDeviceEventMessage;
import com.motivity.transport.repository.BoardingEventRepository;
import com.motivity.transport.repository.OccupancySnapshotRepository;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

/**
 * Claim → insert → upsert, all in ONE transaction (see the build checklist,
 * task 1, for why this deliberately differs from the existing platform's
 * worker, which claims a whole batch's dedup rows separately from
 * processing each one). If the boarding_events insert or the occupancy
 * upsert throws, the dedup claim rolls back with it — a retry of the same
 * event_uid will find it unclaimed and correctly reprocess it, instead of
 * silently treating a half-failed event as "already handled".
 */
@Service
public class TransportEventProcessingService {

    private final JdbcTemplate jdbcTemplate;
    private final BoardingEventRepository boardingEventRepository;
    private final OccupancySnapshotRepository occupancySnapshotRepository;
    private final ApplicationEventPublisher eventPublisher;

    public TransportEventProcessingService(@Qualifier("transportJdbcTemplate") JdbcTemplate jdbcTemplate,
                                            BoardingEventRepository boardingEventRepository,
                                            OccupancySnapshotRepository occupancySnapshotRepository,
                                            ApplicationEventPublisher eventPublisher) {
        this.jdbcTemplate = jdbcTemplate;
        this.boardingEventRepository = boardingEventRepository;
        this.occupancySnapshotRepository = occupancySnapshotRepository;
        this.eventPublisher = eventPublisher;
    }

    public enum Outcome { PROCESSED, DUPLICATE_SKIPPED }

    /** Convenience overload for callers with no resolved passenger identity (e.g. tests, or personRef already present). */
    @Transactional
    public Outcome process(TransportDeviceEventMessage message) {
        return process(message, null);
    }

    // resolvedPassengerId is looked up by the caller (TransportEventConsumer,
    // via PassengerMatchingService) BEFORE this transactional method runs —
    // matching does network I/O (disk read + face-quality-svc HTTP call)
    // that must never happen inside an open DB transaction (see the plan's
    // design decision #1). Passing null is always safe: an unmatched event
    // is expected and must never block occupancy counting.
    @Transactional
    public Outcome process(TransportDeviceEventMessage message, UUID resolvedPassengerId) {
        if (!claim(message.eventUid())) {
            return Outcome.DUPLICATE_SKIPPED;
        }

        boardingEventRepository.save(BoardingEvent.builder()
                .eventUid(message.eventUid())
                .tenantId(message.tenantId())
                .busId(message.busId())
                .deviceId(message.deviceId())
                .eventType(message.eventType())
                .personRef(message.personRef())
                .passengerId(resolvedPassengerId)
                .confidence(message.confidence())
                .photoKey(message.photoKey())
                .eventTime(OffsetDateTime.ofInstant(message.eventTime(), ZoneOffset.UTC))
                .receivedAt(OffsetDateTime.ofInstant(message.receivedAt(), ZoneOffset.UTC))
                .build());

        int delta = "BOARDING".equals(message.eventType()) ? 1 : -1;
        occupancySnapshotRepository.upsertOccupancy(message.tenantId(), message.busId(), delta);

        // Published now, but only turned into a Kafka message by
        // TransportRealtimeEventListener AFTER this transaction actually
        // commits — see that class for why. findByBusId here is a fresh
        // read within this same transaction (this entity was never loaded
        // earlier in the session, so there's no first-level-cache
        // staleness risk the way the heartbeat bulk-update had in 2d).
        int newCount = occupancySnapshotRepository.findByBusId(message.busId())
                .map(s -> s.getOccupancyCount()).orElse(0);
        eventPublisher.publishEvent(new OccupancyChangedEvent(
                message.tenantId(), message.busId(), newCount, message.eventType(), Instant.now()));

        return Outcome.PROCESSED;
    }

    /** Returns true if this event_uid was newly claimed (not a redelivery of an already-processed event). */
    private boolean claim(java.util.UUID eventUid) {
        int rows = jdbcTemplate.update(
                "INSERT INTO transport_event_dedup (event_uid, claimed_at) VALUES (?, now()) ON CONFLICT DO NOTHING",
                eventUid);
        return rows > 0;
    }
}
