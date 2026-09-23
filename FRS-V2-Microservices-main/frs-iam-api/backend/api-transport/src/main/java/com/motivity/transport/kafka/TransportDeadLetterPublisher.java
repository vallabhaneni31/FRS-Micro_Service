package com.motivity.transport.kafka;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

import java.time.Instant;

/** Mirrors the existing platform's routeToDeadLetter — a message that exhausted its retries is never silently dropped. */
@Service
public class TransportDeadLetterPublisher {

    private final KafkaTemplate<String, Object> kafkaTemplate;
    private final String deadLetterTopic;

    public TransportDeadLetterPublisher(KafkaTemplate<String, Object> kafkaTemplate,
                                         @Value("${transport.kafka.topic-prefix}") String topicPrefix) {
        this.kafkaTemplate = kafkaTemplate;
        this.deadLetterTopic = topicPrefix + "transport-dead-letter";
    }

    public void publish(String originalTopic, TransportDeviceEventMessage originalMessage, Throwable error) {
        DeadLetterMessage deadLetterMessage = new DeadLetterMessage(
                originalTopic,
                error.getMessage(),
                Instant.now(),
                originalMessage
        );
        kafkaTemplate.send(deadLetterTopic, originalMessage.busId().toString(), deadLetterMessage);
    }
}
