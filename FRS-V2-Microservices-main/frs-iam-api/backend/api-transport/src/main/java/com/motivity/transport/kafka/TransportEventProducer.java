package com.motivity.transport.kafka;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.support.SendResult;
import org.springframework.stereotype.Service;

import java.util.concurrent.CompletableFuture;

/**
 * Publishes to frs.transport-device-events, keyed by busId — NOT tenantId
 * (the existing platform's jetson-device-events topic keys by tenantId).
 * Deliberate difference, reasoned through in the architecture plan §4: a
 * boarding event and its matching deboarding event for the SAME bus must
 * process in order, or occupancy can double-count or go negative. Keying by
 * tenantId would still guarantee that (a tenant's events all land in one
 * partition), but at the cost of forcing every bus in a tenant's whole
 * fleet through a single partition regardless of how many buses that
 * tenant runs. Keying by busId keeps the ordering guarantee that actually
 * matters while letting different buses process fully in parallel.
 */
@Service
public class TransportEventProducer {

    private final KafkaTemplate<String, Object> kafkaTemplate;
    private final String eventsTopic;

    public TransportEventProducer(KafkaTemplate<String, Object> kafkaTemplate,
                                   @Value("${transport.kafka.topic-prefix}") String topicPrefix) {
        this.kafkaTemplate = kafkaTemplate;
        this.eventsTopic = topicPrefix + "transport-device-events";
    }

    public CompletableFuture<SendResult<String, Object>> publish(TransportDeviceEventMessage message) {
        return kafkaTemplate.send(eventsTopic, message.busId().toString(), message);
    }
}
