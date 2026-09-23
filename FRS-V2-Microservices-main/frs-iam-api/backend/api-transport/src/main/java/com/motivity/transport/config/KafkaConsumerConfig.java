package com.motivity.transport.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.motivity.transport.kafka.TransportDeviceEventMessage;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.springframework.boot.autoconfigure.kafka.KafkaProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.annotation.EnableKafka;
import org.springframework.kafka.config.ConcurrentKafkaListenerContainerFactory;
import org.springframework.kafka.core.ConsumerFactory;
import org.springframework.kafka.core.DefaultKafkaConsumerFactory;
import org.springframework.kafka.listener.ContainerProperties;
import org.springframework.kafka.support.serializer.JsonDeserializer;

import java.util.Map;

/**
 * Batch listener, manual ack, concurrency 3 (matching
 * frs.transport-device-events' 3 partitions — see KafkaTopicConfig — so
 * different buses' events, which land in different partitions, actually
 * process in parallel).
 *
 * The deserializer is told the target type directly
 * (JsonDeserializer(TransportDeviceEventMessage.class, ..., false)) rather
 * than trusting the producer's __TypeId__ header — simpler than configuring
 * spring.json.trusted.packages, and this consumer only ever reads a topic
 * this same service produces to, so there's exactly one real shape it needs
 * to know about.
 */
@Configuration
@EnableKafka
public class KafkaConsumerConfig {

    @Bean
    public ConsumerFactory<String, TransportDeviceEventMessage> transportConsumerFactory(
            KafkaProperties kafkaProperties, ObjectMapper objectMapper) {
        Map<String, Object> props = kafkaProperties.buildConsumerProperties(null);
        JsonDeserializer<TransportDeviceEventMessage> valueDeserializer =
                new JsonDeserializer<>(TransportDeviceEventMessage.class, objectMapper, false);
        return new DefaultKafkaConsumerFactory<>(props, new StringDeserializer(), valueDeserializer);
    }

    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, TransportDeviceEventMessage> transportBatchListenerContainerFactory(
            ConsumerFactory<String, TransportDeviceEventMessage> transportConsumerFactory) {
        ConcurrentKafkaListenerContainerFactory<String, TransportDeviceEventMessage> factory =
                new ConcurrentKafkaListenerContainerFactory<>();
        factory.setConsumerFactory(transportConsumerFactory);
        factory.setBatchListener(true);
        factory.setConcurrency(3);
        factory.getContainerProperties().setAckMode(ContainerProperties.AckMode.MANUAL);
        return factory;
    }
}
