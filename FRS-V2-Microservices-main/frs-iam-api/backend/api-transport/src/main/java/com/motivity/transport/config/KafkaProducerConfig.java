package com.motivity.transport.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.springframework.boot.autoconfigure.kafka.KafkaProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.core.DefaultKafkaProducerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.core.ProducerFactory;
import org.springframework.kafka.support.serializer.JsonSerializer;

import java.util.Map;

/**
 * Spring Kafka's JsonSerializer, when wired purely via the
 * spring.kafka.producer.value-serializer=...JsonSerializer property (a
 * class name string), builds its OWN default ObjectMapper rather than
 * reusing Spring Boot's auto-configured one — and that default does NOT
 * have Spring Boot's ISO-8601 date customization applied. Caught in manual
 * testing: the REST response's `receivedAt` came back as
 * "2026-08-11T18:29:19.225628161Z" but the same Instant, published to
 * Kafka, showed up as a raw epoch number (1786472959.225628161). Explicitly
 * building the ProducerFactory with the real Spring-managed ObjectMapper
 * fixes it — both representations now match.
 */
@Configuration
public class KafkaProducerConfig {

    @Bean
    public ProducerFactory<String, Object> producerFactory(KafkaProperties kafkaProperties, ObjectMapper objectMapper) {
        Map<String, Object> configProps = kafkaProperties.buildProducerProperties(null);
        configProps.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, org.apache.kafka.common.serialization.StringSerializer.class);
        configProps.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, JsonSerializer.class);
        DefaultKafkaProducerFactory<String, Object> factory = new DefaultKafkaProducerFactory<>(configProps);
        factory.setValueSerializer(new JsonSerializer<>(objectMapper));
        return factory;
    }

    @Bean
    public KafkaTemplate<String, Object> kafkaTemplate(ProducerFactory<String, Object> producerFactory) {
        return new KafkaTemplate<>(producerFactory);
    }
}
