package com.motivity.transport.config;

import org.apache.kafka.clients.admin.NewTopic;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.TopicBuilder;

/**
 * Declares this service's Kafka topics as code — Spring Kafka's
 * KafkaAdmin creates/reconciles any NewTopic bean automatically at startup,
 * so a fresh environment is self-sufficient without a manual
 * kafka-topics.sh step. Additive only: these are new topic names on the
 * EXISTING shared cluster (same brokers as backend/api), not new
 * infrastructure. Partition count (3) and replication factor (1) match the
 * existing platform's frs.jetson-device-events topic, confirmed via
 * `kafka-topics.sh --describe` before writing this.
 */
@Configuration
public class KafkaTopicConfig {

    @Bean
    public NewTopic transportDeviceEventsTopic(@Value("${transport.kafka.topic-prefix}") String topicPrefix) {
        return TopicBuilder.name(topicPrefix + "transport-device-events")
                .partitions(3)
                .replicas(1)
                .build();
    }

    @Bean
    public NewTopic transportDeadLetterTopic(@Value("${transport.kafka.topic-prefix}") String topicPrefix) {
        return TopicBuilder.name(topicPrefix + "transport-dead-letter")
                .partitions(3)
                .replicas(1)
                .build();
    }

    // Phase 2g: realtime signal, published after every committed occupancy
    // change. Nothing consumes this yet — the Node-side relay that would
    // forward it into the frontend's socket room is a separate, explicitly
    // gated addition to the existing platform (see the build checklist,
    // 2g task 9), not part of this service.
    @Bean
    public NewTopic transportRealtimeTopic(@Value("${transport.kafka.topic-prefix}") String topicPrefix) {
        return TopicBuilder.name(topicPrefix + "transport-realtime")
                .partitions(3)
                .replicas(1)
                .build();
    }
}
