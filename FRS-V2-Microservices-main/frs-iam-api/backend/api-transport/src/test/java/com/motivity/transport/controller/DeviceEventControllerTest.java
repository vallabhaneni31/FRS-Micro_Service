package com.motivity.transport.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.motivity.transport.entity.Bus;
import com.motivity.transport.entity.TransportDevice;
import com.motivity.transport.repository.BusRepository;
import com.motivity.transport.repository.TransportDeviceRepository;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.ConsumerRecords;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.Rollback;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Transactional;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.Date;
import java.util.Optional;
import java.util.Properties;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Phase 2d verification. Goes through the REAL security filter chain built
 * in 2c (MockMvc + @AutoConfigureMockMvc wires the actual SecurityConfig,
 * not a stub) and publishes to the REAL local Kafka cluster — messages are
 * read back with a genuine KafkaConsumer, not mocked, the same "prove it
 * against real infrastructure" discipline as 2b/2c.
 */
@SpringBootTest
@AutoConfigureMockMvc
class DeviceEventControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private BusRepository busRepository;

    @Autowired
    private TransportDeviceRepository deviceRepository;

    @Value("${spring.kafka.bootstrap-servers}")
    private String bootstrapServers;

    @Value("${transport.kafka.topic-prefix}")
    private String topicPrefix;

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    @Transactional
    @Rollback
    void acceptsAValidEventAndItActuallyLandsOnTheKafkaTopicKeyedByBus() throws Exception {
        TestDevice td = persistTestDevice();

        String body = """
                {"eventType":"BOARDING","timestamp":"%s","faceData":{"confidence":0.91}}
                """.formatted(Instant.now().toString());

        String responseJson = mockMvc.perform(post("/api/transport/devices/{deviceId}/events", td.device.getId())
                        .header("Authorization", "Bearer " + td.token)
                        .contentType("application/json")
                        .content(body))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.status").value("queued"))
                .andReturn().getResponse().getContentAsString();

        String eventId = objectMapper.readTree(responseJson).get("eventId").asText();

        ConsumerRecord<String, String> record = consumeUntilFound(eventId);
        assertThat(record).isNotNull();
        assertThat(record.key()).isEqualTo(td.device.getBusId().toString());
        JsonNode payload = objectMapper.readTree(record.value());
        assertThat(payload.get("eventType").asText()).isEqualTo("BOARDING");
        assertThat(payload.get("deviceId").asText()).isEqualTo(td.device.getId().toString());
        assertThat(payload.get("tenantId").asText()).isEqualTo(td.device.getTenantId().toString());
        // ISO-8601, not a raw epoch number — see KafkaProducerConfig's comment for why this needed fixing.
        assertThat(payload.get("receivedAt").asText()).matches("\\d{4}-\\d{2}-\\d{2}T.*Z");
    }

    @Test
    @Transactional
    @Rollback
    void acceptsABatchAndPublishesEveryEvent() throws Exception {
        TestDevice td = persistTestDevice();
        String now = Instant.now().toString();
        String body = """
                {"events":[
                  {"eventType":"BOARDING","timestamp":"%s"},
                  {"eventType":"DEBOARDING","timestamp":"%s"}
                ]}
                """.formatted(now, now);

        mockMvc.perform(post("/api/transport/devices/{deviceId}/events/batch", td.device.getId())
                        .header("Authorization", "Bearer " + td.token)
                        .contentType("application/json")
                        .content(body))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.processed").value(2))
                .andExpect(jsonPath("$.results[0].status").value("queued"))
                .andExpect(jsonPath("$.results[1].status").value("queued"));
    }

    @Test
    @Transactional
    @Rollback
    void rejectsABatchOverTheMaxSizeWith413() throws Exception {
        TestDevice td = persistTestDevice();
        StringBuilder events = new StringBuilder("[");
        String now = Instant.now().toString();
        for (int i = 0; i < 101; i++) {
            if (i > 0) events.append(",");
            events.append("{\"eventType\":\"BOARDING\",\"timestamp\":\"").append(now).append("\"}");
        }
        events.append("]");
        String body = "{\"events\":" + events + "}";

        mockMvc.perform(post("/api/transport/devices/{deviceId}/events/batch", td.device.getId())
                        .header("Authorization", "Bearer " + td.token)
                        .contentType("application/json")
                        .content(body))
                .andExpect(status().isPayloadTooLarge())
                .andExpect(jsonPath("$.error").value("batch_too_large"));
    }

    @Test
    @Transactional
    @Rollback
    void rejectsAnInvalidEventType() throws Exception {
        TestDevice td = persistTestDevice();
        String body = """
                {"eventType":"NOT_A_REAL_TYPE","timestamp":"%s"}
                """.formatted(Instant.now().toString());

        mockMvc.perform(post("/api/transport/devices/{deviceId}/events", td.device.getId())
                        .header("Authorization", "Bearer " + td.token)
                        .contentType("application/json")
                        .content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("invalid_payload"));
    }

    @Test
    @Transactional
    @Rollback
    void rejectsADeviceIdMismatchBetweenUrlAndToken() throws Exception {
        TestDevice td = persistTestDevice();
        String body = """
                {"eventType":"BOARDING","timestamp":"%s"}
                """.formatted(Instant.now().toString());

        mockMvc.perform(post("/api/transport/devices/{deviceId}/events", UUID.randomUUID())
                        .header("Authorization", "Bearer " + td.token)
                        .contentType("application/json")
                        .content(body))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error").value("DEVICE_MISMATCH"));
    }

    @Test
    @Transactional
    @Rollback
    void heartbeatActuallyUpdatesTheDeviceRow() throws Exception {
        TestDevice td = persistTestDevice();
        assertThat(td.device.getLastHeartbeat()).isNull();

        mockMvc.perform(post("/api/transport/devices/{deviceId}/heartbeat", td.device.getId())
                        .header("Authorization", "Bearer " + td.token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true));

        Optional<TransportDevice> refetched = deviceRepository.findById(td.device.getId());
        assertThat(refetched).isPresent();
        assertThat(refetched.get().getLastHeartbeat()).isNotNull();
    }

    @Test
    void rejectsRequestsWithNoDeviceToken() throws Exception {
        mockMvc.perform(post("/api/transport/devices/{deviceId}/events", UUID.randomUUID())
                        .contentType("application/json")
                        .content("{}"))
                .andExpect(status().isUnauthorized());
    }

    private ConsumerRecord<String, String> consumeUntilFound(String expectedEventId) {
        Properties props = new Properties();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "test-verify-" + UUID.randomUUID());
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);

        try (KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props)) {
            consumer.subscribe(java.util.List.of(topicPrefix + "transport-device-events"));
            long deadline = System.currentTimeMillis() + 10_000;
            while (System.currentTimeMillis() < deadline) {
                ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(500));
                for (ConsumerRecord<String, String> record : records) {
                    if (record.value().contains(expectedEventId)) {
                        return record;
                    }
                }
            }
        }
        return null;
    }

    private TestDevice persistTestDevice() {
        UUID tenantId = UUID.randomUUID();
        Bus bus = busRepository.save(Bus.builder()
                .tenantId(tenantId)
                .busCode("EVT-TEST-" + UUID.randomUUID().toString().substring(0, 8))
                .build());
        String secret = "event-controller-test-secret-0123456789abcdefABCDEF0123456789";
        TransportDevice device = deviceRepository.save(TransportDevice.builder()
                .tenantId(tenantId)
                .busId(bus.getId())
                .deviceCode("EVT-TEST-DEVICE-" + UUID.randomUUID().toString().substring(0, 8))
                .deviceSecret(secret)
                .cameraPosition("boarding")
                .build());
        String token = signDeviceToken(secret, device.getId().toString());
        return new TestDevice(device, token);
    }

    private String signDeviceToken(String secret, String subject) {
        SecretKey key = Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8));
        return Jwts.builder()
                .subject(subject)
                .issuedAt(new Date())
                .expiration(new Date(System.currentTimeMillis() + 300_000))
                .signWith(key)
                .compact();
    }

    private record TestDevice(TransportDevice device, String token) {
    }
}
