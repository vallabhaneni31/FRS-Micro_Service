package com.motivity.transport.kafka;

import com.motivity.transport.service.PassengerMatchingService;
import com.motivity.transport.service.TransportEventProcessingService;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.UUID;

/**
 * Consumes frs.transport-device-events in batches. Each event gets up to
 * MAX_ATTEMPTS in-process retries (mirrors the existing platform's
 * deviceEventConsumer.js MAX_ATTEMPTS/RETRY_BASE_MS) before being routed to
 * the dead-letter topic — one bad event never blocks the rest of the batch,
 * and the whole batch's offset is only acknowledged once every event has
 * either been processed or dead-lettered, never left in limbo.
 */
@Component
public class TransportEventConsumer {

    private static final Logger log = LoggerFactory.getLogger(TransportEventConsumer.class);
    private static final int MAX_ATTEMPTS = 3;
    private static final long RETRY_BASE_MS = 500;

    private final TransportEventProcessingService processingService;
    private final TransportDeadLetterPublisher deadLetterPublisher;
    private final PassengerMatchingService passengerMatchingService;

    public TransportEventConsumer(TransportEventProcessingService processingService,
                                   TransportDeadLetterPublisher deadLetterPublisher,
                                   PassengerMatchingService passengerMatchingService) {
        this.processingService = processingService;
        this.deadLetterPublisher = deadLetterPublisher;
        this.passengerMatchingService = passengerMatchingService;
    }

    @KafkaListener(
            topics = "${transport.kafka.topic-prefix}transport-device-events",
            containerFactory = "transportBatchListenerContainerFactory")
    public void onMessage(List<ConsumerRecord<String, TransportDeviceEventMessage>> records, Acknowledgment acknowledgment) {
        for (ConsumerRecord<String, TransportDeviceEventMessage> record : records) {
            processWithRetry(record);
        }
        acknowledgment.acknowledge();
    }

    private void processWithRetry(ConsumerRecord<String, TransportDeviceEventMessage> record) {
        TransportDeviceEventMessage message = record.value();
        Exception lastError = null;

        // Resolved ONCE, outside the retry loop and outside any DB
        // transaction — see PassengerMatchingService and the plan's design
        // decision #1. If the device already asserted a personRef (e.g. a
        // future firmware that resolves identity on-device), that takes
        // precedence and matching is skipped entirely.
        UUID resolvedPassengerId = null;
        if (message.personRef() == null && message.photoKey() != null) {
            resolvedPassengerId = passengerMatchingService
                    .resolvePassenger(message.tenantId(), message.photoKey())
                    .orElse(null);
        }

        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                processingService.process(message, resolvedPassengerId);
                return;
            } catch (Exception e) {
                lastError = e;
                log.warn("[TransportEventConsumer] attempt {}/{} failed for eventUid={}: {}",
                        attempt, MAX_ATTEMPTS, message.eventUid(), e.getMessage());
                if (attempt < MAX_ATTEMPTS) {
                    sleep(RETRY_BASE_MS * attempt);
                }
            }
        }

        log.error("[TransportEventConsumer] exhausted retries for eventUid={}, routing to dead-letter", message.eventUid());
        deadLetterPublisher.publish(record.topic(), message, lastError);
    }

    private void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
