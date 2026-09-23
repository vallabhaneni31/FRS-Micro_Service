package com.motivity.transport.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.motivity.transport.entity.Bus;
import com.motivity.transport.entity.TransportDevice;
import com.motivity.transport.kafka.TransportDeviceEventMessage;
import com.motivity.transport.kafka.TransportEventProducer;
import com.motivity.transport.entity.Depot;
import com.motivity.transport.entity.TransportUserScope;
import com.motivity.transport.repository.BusRepository;
import com.motivity.transport.repository.DepotRepository;
import com.motivity.transport.repository.OccupancySnapshotRepository;
import com.motivity.transport.repository.TransportDeviceRepository;
import com.motivity.transport.repository.TransportUserScopeRepository;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpServer;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.ConsumerRecords;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Phase 2g verification. Occupancy/history read APIs go through the real
 * security chain (same fake-JWKS technique as ManagementApiTest, 2f);
 * realtime publishing is verified by processing a REAL event through the
 * REAL worker (from 2e) and reading the resulting message back off the new
 * frs.transport-realtime topic with a genuine KafkaConsumer.
 */
@SpringBootTest
@AutoConfigureMockMvc
class OccupancyAndHistoryApiTest {

    private static final int TIMEOUT_SECONDS = 25;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private TransportEventProducer producer;

    @Autowired
    private BusRepository busRepository;

    @Autowired
    private TransportDeviceRepository deviceRepository;

    @Autowired
    private OccupancySnapshotRepository occupancySnapshotRepository;

    @Autowired
    private TransportUserScopeRepository scopeRepository;

    @Autowired
    private DepotRepository depotRepository;

    @Value("${spring.kafka.bootstrap-servers}")
    private String bootstrapServers;

    @Value("${transport.kafka.topic-prefix}")
    private String topicPrefix;

    private final ObjectMapper objectMapper = new ObjectMapper();

    private static HttpServer fakeKeycloak;
    private static RSAPrivateKey privateKey;

    @BeforeAll
    static void startFakeKeycloak() throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(2048);
        KeyPair pair = gen.generateKeyPair();
        privateKey = (RSAPrivateKey) pair.getPrivate();
        RSAPublicKey publicKey = (RSAPublicKey) pair.getPublic();

        RSAKey publicJwk = new RSAKey.Builder(publicKey).keyID("test-key").build();
        String jwksJson = new JWKSet(publicJwk).toJSONObject().toString();

        fakeKeycloak = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        fakeKeycloak.createContext("/realms/attendance/protocol/openid-connect/certs", exchange -> {
            byte[] bytes = jwksJson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        fakeKeycloak.start();
    }

    @AfterAll
    static void stopFakeKeycloak() {
        if (fakeKeycloak != null) fakeKeycloak.stop(0);
    }

    @DynamicPropertySource
    static void overrideKeycloakUrl(DynamicPropertyRegistry registry) {
        registry.add("keycloak.url", () -> "http://localhost:" + fakeKeycloak.getAddress().getPort());
    }

    private String tokenFor(UUID tenantId, String role) throws Exception {
        return tokenFor(tenantId, role, "test-user-" + UUID.randomUUID());
    }

    // Needed whenever a test has to pre-create a transport_user_scope row
    // for the token's subject before the request — see ManagementApiTest's
    // identical overload for the full rationale.
    private String tokenFor(UUID tenantId, String role, String subject) throws Exception {
        String issuer = "http://localhost:" + fakeKeycloak.getAddress().getPort() + "/realms/attendance";
        JWTClaimsSet.Builder builder = new JWTClaimsSet.Builder()
                .issuer(issuer)
                .subject(subject)
                .issueTime(Date.from(Instant.now().minusSeconds(10)))
                .expirationTime(Date.from(Instant.now().plusSeconds(300)))
                .claim("tenant_id", tenantId.toString())
                .claim("aud", "account")
                .claim("realm_access", Map.of("roles", List.of(role)));
        SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID("test-key").build(), builder.build());
        jwt.sign(new RSASSASigner(privateKey));
        return jwt.serialize();
    }

    private Bus persistBus(UUID tenantId, String code) {
        return busRepository.save(Bus.builder().tenantId(tenantId).busCode(code).build());
    }

    private TransportDevice persistDevice(UUID tenantId, UUID busId, String code) {
        return deviceRepository.save(TransportDevice.builder()
                .tenantId(tenantId).busId(busId).deviceCode(code)
                .deviceSecret("not-used-in-this-test-secret-0123456789abcdef")
                .cameraPosition("boarding").build());
    }

    private void publishAndAwaitProcessed(UUID tenantId, UUID busId, UUID deviceId, String eventType, int expectedCount) throws Exception {
        TransportDeviceEventMessage message = new TransportDeviceEventMessage(
                UUID.randomUUID(), tenantId, busId, deviceId, eventType, null, null, null, Instant.now(), Instant.now());
        producer.publish(message);
        awaitUntil(() -> occupancySnapshotRepository.findByBusId(busId)
                .map(s -> s.getOccupancyCount()).orElse(-1) == expectedCount, TIMEOUT_SECONDS);
    }

    @Test
    void occupancyListAndGetReturnRealDataScopedToTheCallersTenant() throws Exception {
        UUID tenantId = UUID.randomUUID();
        Bus bus = persistBus(tenantId, "OCC-API-BUS-01");
        TransportDevice device = persistDevice(tenantId, bus.getId(), "OCC-API-DEVICE-01");
        publishAndAwaitProcessed(tenantId, bus.getId(), device.getId(), "BOARDING", 1);

        String token = tokenFor(tenantId, "viewer");

        mockMvc.perform(get("/api/transport/occupancy/{busId}", bus.getId()).header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.occupancyCount").value(1));

        mockMvc.perform(get("/api/transport/occupancy").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].busId").value(bus.getId().toString()));
    }

    @Test
    void routeManagerOnlySeesOccupancyAndEventsForBusesInTheirOwnDepot() throws Exception {
        UUID tenantId = UUID.randomUUID();
        Depot depotA = depotRepository.save(Depot.builder().tenantId(tenantId).depotName("Occ Depot A").build());
        Depot depotB = depotRepository.save(Depot.builder().tenantId(tenantId).depotName("Occ Depot B").build());

        Bus busInA = busRepository.save(Bus.builder().tenantId(tenantId).busCode("OCC-DEPOT-A-BUS").depotId(depotA.getId()).build());
        Bus busInB = busRepository.save(Bus.builder().tenantId(tenantId).busCode("OCC-DEPOT-B-BUS").depotId(depotB.getId()).build());
        TransportDevice deviceA = persistDevice(tenantId, busInA.getId(), "OCC-DEPOT-A-DEVICE");
        TransportDevice deviceB = persistDevice(tenantId, busInB.getId(), "OCC-DEPOT-B-DEVICE");

        publishAndAwaitProcessed(tenantId, busInA.getId(), deviceA.getId(), "BOARDING", 1);
        publishAndAwaitProcessed(tenantId, busInB.getId(), deviceB.getId(), "BOARDING", 1);

        String subject = "rm-occ-" + UUID.randomUUID();
        scopeRepository.save(TransportUserScope.builder().tenantId(tenantId).keycloakSubject(subject).depotId(depotA.getId()).build());
        String routeManagerAToken = tokenFor(tenantId, "site_admin", subject);

        // Occupancy: only Depot A's bus shows up, not Depot B's.
        mockMvc.perform(get("/api/transport/occupancy").header("Authorization", "Bearer " + routeManagerAToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].busId").value(busInA.getId().toString()));

        mockMvc.perform(get("/api/transport/occupancy/{busId}", busInB.getId()).header("Authorization", "Bearer " + routeManagerAToken))
                .andExpect(status().isNotFound());

        // Event history: same story. Also proves the depot filter correctly
        // intersects with an explicit busId param rather than replacing it —
        // requesting Depot B's bus while scoped to Depot A yields zero rows,
        // not Depot A's events instead.
        mockMvc.perform(get("/api/transport/events")
                        .param("busId", busInA.getId().toString())
                        .header("Authorization", "Bearer " + routeManagerAToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.totalElements").value(1));

        mockMvc.perform(get("/api/transport/events")
                        .param("busId", busInB.getId().toString())
                        .header("Authorization", "Bearer " + routeManagerAToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.totalElements").value(0));
    }

    @Test
    void occupancyIsInvisibleToADifferentTenant() throws Exception {
        UUID tenantA = UUID.randomUUID();
        UUID tenantB = UUID.randomUUID();
        Bus bus = persistBus(tenantA, "OCC-ISO-BUS-01");
        TransportDevice device = persistDevice(tenantA, bus.getId(), "OCC-ISO-DEVICE-01");
        publishAndAwaitProcessed(tenantA, bus.getId(), device.getId(), "BOARDING", 1);

        String tokenB = tokenFor(tenantB, "tenant_admin");

        mockMvc.perform(get("/api/transport/occupancy/{busId}", bus.getId()).header("Authorization", "Bearer " + tokenB))
                .andExpect(status().isNotFound());
    }

    @Test
    void eventHistorySupportsFilteringByBusAndPagination() throws Exception {
        UUID tenantId = UUID.randomUUID();
        Bus bus = persistBus(tenantId, "HIST-API-BUS-01");
        TransportDevice device = persistDevice(tenantId, bus.getId(), "HIST-API-DEVICE-01");

        publishAndAwaitProcessed(tenantId, bus.getId(), device.getId(), "BOARDING", 1);
        publishAndAwaitProcessed(tenantId, bus.getId(), device.getId(), "BOARDING", 2);
        publishAndAwaitProcessed(tenantId, bus.getId(), device.getId(), "DEBOARDING", 1);

        // Operations Manager persona — has EVENTS_READ, but scoped to exactly
        // their one assigned bus; without this scope row they'd see nothing.
        String subject = "om-" + UUID.randomUUID();
        scopeRepository.save(TransportUserScope.builder().tenantId(tenantId).keycloakSubject(subject).busId(bus.getId()).build());
        String token = tokenFor(tenantId, "hr_manager", subject);

        mockMvc.perform(get("/api/transport/events")
                        .param("busId", bus.getId().toString())
                        .param("page", "0").param("size", "10")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.totalElements").value(3))
                .andExpect(jsonPath("$.content.length()").value(3));

        mockMvc.perform(get("/api/transport/events")
                        .param("busId", bus.getId().toString())
                        .param("page", "0").param("size", "2")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.totalElements").value(3))
                .andExpect(jsonPath("$.content.length()").value(2))
                .andExpect(jsonPath("$.totalPages").value(2));
    }

    @Test
    void aCommittedOccupancyChangePublishesARealtimeMessageWithCorrectPayload() throws Exception {
        UUID tenantId = UUID.randomUUID();
        Bus bus = persistBus(tenantId, "RT-API-BUS-01");
        TransportDevice device = persistDevice(tenantId, bus.getId(), "RT-API-DEVICE-01");

        publishAndAwaitProcessed(tenantId, bus.getId(), device.getId(), "BOARDING", 1);

        ConsumerRecord<String, String> record = consumeRealtimeUntilFound(bus.getId().toString(), TIMEOUT_SECONDS);
        assertThat(record).isNotNull();
        assertThat(record.key()).isEqualTo(tenantId.toString()); // keyed by tenantId, not busId — deliberately different from the events topic
        var payload = objectMapper.readTree(record.value());
        assertThat(payload.get("tenantId").asText()).isEqualTo(tenantId.toString());
        assertThat(payload.get("busId").asText()).isEqualTo(bus.getId().toString());
        assertThat(payload.get("occupancyCount").asInt()).isEqualTo(1);
        assertThat(payload.get("direction").asText()).isEqualTo("BOARDING");
    }

    private void awaitUntil(BooleanSupplier condition, int timeoutSeconds) {
        long deadline = System.currentTimeMillis() + timeoutSeconds * 1000L;
        while (System.currentTimeMillis() < deadline) {
            if (condition.getAsBoolean()) return;
            try {
                Thread.sleep(200);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        throw new AssertionError("condition not met within " + timeoutSeconds + "s");
    }

    private ConsumerRecord<String, String> consumeRealtimeUntilFound(String expectedBusId, int timeoutSeconds) {
        Properties props = new Properties();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "test-verify-realtime-" + UUID.randomUUID());
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);

        try (KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props)) {
            consumer.subscribe(List.of(topicPrefix + "transport-realtime"));
            long deadline = System.currentTimeMillis() + timeoutSeconds * 1000L;
            while (System.currentTimeMillis() < deadline) {
                ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(500));
                for (ConsumerRecord<String, String> record : records) {
                    if (record.value().contains(expectedBusId)) {
                        return record;
                    }
                }
            }
        }
        return null;
    }
}
