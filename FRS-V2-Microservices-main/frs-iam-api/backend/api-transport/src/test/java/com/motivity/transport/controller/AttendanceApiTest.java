package com.motivity.transport.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.motivity.transport.entity.Bus;
import com.motivity.transport.entity.BoardingEvent;
import com.motivity.transport.entity.TransportDevice;
import com.motivity.transport.repository.BoardingEventRepository;
import com.motivity.transport.repository.BusRepository;
import com.motivity.transport.repository.TransportDeviceRepository;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
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
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Track B, Phase 6 — attendance is purely derived from boarding_events, so
 * this test seeds boarding_events directly (bypassing Kafka/matching, which
 * TransportEventConsumerTest already covers) and asserts the derived status
 * per passenger.
 */
@SpringBootTest
@AutoConfigureMockMvc
class AttendanceApiTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private BusRepository busRepository;

    @Autowired
    private TransportDeviceRepository deviceRepository;

    @Autowired
    private BoardingEventRepository boardingEventRepository;

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
        String issuer = "http://localhost:" + fakeKeycloak.getAddress().getPort() + "/realms/attendance";
        JWTClaimsSet.Builder builder = new JWTClaimsSet.Builder()
                .issuer(issuer)
                .subject("test-user-" + UUID.randomUUID())
                .issueTime(Date.from(Instant.now().minusSeconds(10)))
                .expirationTime(Date.from(Instant.now().plusSeconds(300)))
                .claim("tenant_id", tenantId.toString())
                .claim("aud", "account")
                .claim("realm_access", Map.of("roles", List.of(role)));
        SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID("test-key").build(), builder.build());
        jwt.sign(new RSASSASigner(privateKey));
        return jwt.serialize();
    }

    private String createPassenger(String token, UUID tenantId, UUID busId, String code) throws Exception {
        String body = """
                {"busId":"%s","passengerCode":"%s","fullName":"Attendance Test %s"}
                """.formatted(busId, code, code);
        String response = mockMvc.perform(post("/api/transport/passengers")
                        .header("Authorization", "Bearer " + token).contentType("application/json").content(body))
                .andExpect(status().isCreated())
                .andReturn().getResponse().getContentAsString();
        return objectMapper.readTree(response).get("id").asText();
    }

    private void seedEvent(UUID tenantId, UUID busId, UUID deviceId, UUID passengerId, String eventType, OffsetDateTime time) {
        boardingEventRepository.save(BoardingEvent.builder()
                .eventUid(UUID.randomUUID())
                .tenantId(tenantId)
                .busId(busId)
                .deviceId(deviceId)
                .eventType(eventType)
                .passengerId(passengerId)
                .eventTime(time)
                .receivedAt(time)
                .build());
    }

    @Test
    void dailyAttendanceDerivesStatusPerPassengerFromBoardingEvents() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String token = tokenFor(tenantId, "tenant_admin");
        Bus bus = busRepository.save(Bus.builder().tenantId(tenantId).busCode("ATT-BUS-" + UUID.randomUUID().toString().substring(0, 8)).build());
        TransportDevice device = deviceRepository.save(TransportDevice.builder()
                .tenantId(tenantId).busId(bus.getId())
                .deviceCode("ATT-DEVICE-" + UUID.randomUUID().toString().substring(0, 8))
                .deviceSecret("not-used-for-auth-in-this-test")
                .cameraPosition("boarding").build());

        LocalDate today = LocalDate.now(ZoneOffset.UTC);
        OffsetDateTime morning = today.atTime(8, 0).atOffset(ZoneOffset.UTC);
        OffsetDateTime evening = today.atTime(17, 0).atOffset(ZoneOffset.UTC);

        String fullyBoarded = createPassenger(token, tenantId, bus.getId(), "BOARDED");
        seedEvent(tenantId, bus.getId(), device.getId(), UUID.fromString(fullyBoarded), "BOARDING", morning);
        seedEvent(tenantId, bus.getId(), device.getId(), UUID.fromString(fullyBoarded), "DEBOARDING", evening);

        String noDeboard = createPassenger(token, tenantId, bus.getId(), "NODEBOARD");
        seedEvent(tenantId, bus.getId(), device.getId(), UUID.fromString(noDeboard), "BOARDING", morning);

        String absent = createPassenger(token, tenantId, bus.getId(), "ABSENT");
        // no events for this passenger at all

        mockMvc.perform(get("/api/transport/attendance")
                        .param("date", today.toString())
                        .param("busId", bus.getId().toString())
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(3))
                .andExpect(jsonPath("$[?(@.passengerCode=='BOARDED')].status").value("boarded"))
                .andExpect(jsonPath("$[?(@.passengerCode=='NODEBOARD')].status").value("boarded_no_deboard"))
                .andExpect(jsonPath("$[?(@.passengerCode=='ABSENT')].status").value("not_boarded"));
    }
}
