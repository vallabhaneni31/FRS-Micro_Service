package com.motivity.transport.kafka;

import com.motivity.transport.event.OccupancyChangedEvent;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

/**
 * AFTER_COMMIT, deliberately — never publish a realtime signal for an
 * occupancy change that could still roll back. The processing transaction
 * publishes OccupancyChangedEvent as a plain Spring application event;
 * this listener only turns it into a Kafka message once that transaction
 * has actually committed.
 */
@Component
public class TransportRealtimeEventListener {

    private final TransportRealtimePublisher publisher;

    public TransportRealtimeEventListener(TransportRealtimePublisher publisher) {
        this.publisher = publisher;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onOccupancyChanged(OccupancyChangedEvent event) {
        publisher.publish(new TransportRealtimeMessage(
                event.tenantId(), event.busId(), event.occupancyCount(), event.direction(), event.occurredAt()));
    }
}
