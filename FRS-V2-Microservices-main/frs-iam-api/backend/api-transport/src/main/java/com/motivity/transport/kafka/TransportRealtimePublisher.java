package com.motivity.transport.kafka;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

/**
 * Publishes to a NEW topic (frs.transport-realtime) on the existing shared
 * cluster — additive only, nothing consumes it yet. Keyed by tenantId
 * (not busId): the eventual relay groups by the frontend's per-tenant
 * socket room, not per-bus ordering, so tenantId is the locality that
 * actually matters here — deliberately different from
 * TransportEventProducer's busId key, for a different reason.
 */
@Service
public class TransportRealtimePublisher {

    private final KafkaTemplate<String, Object> kafkaTemplate;
    private final String realtimeTopic;

    public TransportRealtimePublisher(KafkaTemplate<String, Object> kafkaTemplate,
                                       @Value("${transport.kafka.topic-prefix}") String topicPrefix) {
        this.kafkaTemplate = kafkaTemplate;
        this.realtimeTopic = topicPrefix + "transport-realtime";
    }

    public void publish(TransportRealtimeMessage message) {
        kafkaTemplate.send(realtimeTopic, message.tenantId().toString(), message);
    }
}
