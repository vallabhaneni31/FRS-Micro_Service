package com.motivity.transport.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.motivity.transport.entity.Bus;
import com.motivity.transport.entity.Depot;
import com.motivity.transport.entity.TransportUserScope;
import com.motivity.transport.repository.BusRepository;
import com.motivity.transport.repository.DepotRepository;
import com.motivity.transport.repository.TransportUserScopeRepository;
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
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Track B, Phase 1 — Passenger CRUD, same real-chain verification shape as
 * ManagementApiTest (fake JWKS server, real SecurityConfig/KeycloakAuthFilter,
 * real @PreAuthorize + TransportPermissions, real database).
 */
@SpringBootTest
@AutoConfigureMockMvc
class PassengerApiTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private BusRepository busRepository;

    @Autowired
    private DepotRepository depotRepository;

    @Autowired
    private TransportUserScopeRepository scopeRepository;

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

    private Bus persistBus(UUID tenantId, UUID depotId) {
        return busRepository.save(Bus.builder()
                .tenantId(tenantId)
                .busCode("PAX-BUS-" + UUID.randomUUID().toString().substring(0, 8))
                .depotId(depotId)
                .build());
    }

    @Test
    void tenantAdminCanCreateReadUpdateAndDeleteAPassenger() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String token = tokenFor(tenantId, "tenant_admin");
        Bus bus = persistBus(tenantId, null);

        String createBody = """
                {"busId":"%s","passengerCode":"PAX-001","fullName":"Asha Rao","phone":"9999999999"}
                """.formatted(bus.getId());
        String createResponse = mockMvc.perform(post("/api/transport/passengers")
                        .header("Authorization", "Bearer " + token)
                        .contentType("application/json").content(createBody))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.passengerCode").value("PAX-001"))
                .andExpect(jsonPath("$.status").value("active"))
                .andReturn().getResponse().getContentAsString();
        String passengerId = objectMapper.readTree(createResponse).get("id").asText();

        mockMvc.perform(get("/api/transport/passengers/{id}", passengerId).header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.fullName").value("Asha Rao"));

        mockMvc.perform(patch("/api/transport/passengers/{id}", passengerId)
                        .header("Authorization", "Bearer " + token)
                        .contentType("application/json").content("{\"phone\":\"8888888888\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.phone").value("8888888888"));

        mockMvc.perform(delete("/api/transport/passengers/{id}", passengerId).header("Authorization", "Bearer " + token))
                .andExpect(status().isNoContent());

        mockMvc.perform(get("/api/transport/passengers/{id}", passengerId).header("Authorization", "Bearer " + token))
                .andExpect(status().isNotFound());
    }

    @Test
    void duplicatePassengerCodeInSameTenantIsRejected() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String token = tokenFor(tenantId, "tenant_admin");
        Bus bus = persistBus(tenantId, null);

        String body = """
                {"busId":"%s","passengerCode":"DUP-001","fullName":"First"}
                """.formatted(bus.getId());
        mockMvc.perform(post("/api/transport/passengers")
                        .header("Authorization", "Bearer " + token).contentType("application/json").content(body))
                .andExpect(status().isCreated());

        String dupBody = """
                {"busId":"%s","passengerCode":"DUP-001","fullName":"Second"}
                """.formatted(bus.getId());
        mockMvc.perform(post("/api/transport/passengers")
                        .header("Authorization", "Bearer " + token).contentType("application/json").content(dupBody))
                .andExpect(status().isConflict());
    }

    @Test
    void hrManagerCanReadButNotWritePassengers() throws Exception {
        UUID tenantId = UUID.randomUUID();
        Bus bus = persistBus(tenantId, null);
        String subject = "om-" + UUID.randomUUID();
        scopeRepository.save(TransportUserScope.builder().tenantId(tenantId).keycloakSubject(subject).busId(bus.getId()).build());
        String hrManagerToken = tokenFor(tenantId, "hr_manager", subject);

        mockMvc.perform(get("/api/transport/passengers").header("Authorization", "Bearer " + hrManagerToken))
                .andExpect(status().isOk());

        mockMvc.perform(post("/api/transport/passengers")
                        .header("Authorization", "Bearer " + hrManagerToken)
                        .contentType("application/json")
                        .content("{\"busId\":\"" + bus.getId() + "\",\"passengerCode\":\"SHOULD-FAIL\",\"fullName\":\"X\"}"))
                .andExpect(status().isForbidden());
    }

    @Test
    void routeManagerOnlySeesPassengersInTheirOwnDepot() throws Exception {
        UUID tenantId = UUID.randomUUID();
        Depot depotA = depotRepository.save(Depot.builder().tenantId(tenantId).depotName("Depot A").build());
        Depot depotB = depotRepository.save(Depot.builder().tenantId(tenantId).depotName("Depot B").build());
        Bus busInA = persistBus(tenantId, depotA.getId());
        Bus busInB = persistBus(tenantId, depotB.getId());
        String adminToken = tokenFor(tenantId, "tenant_admin");

        String paxInA = objectMapper.readTree(mockMvc.perform(post("/api/transport/passengers")
                        .header("Authorization", "Bearer " + adminToken).contentType("application/json")
                        .content("{\"busId\":\"" + busInA.getId() + "\",\"passengerCode\":\"A-PAX\",\"fullName\":\"A Pax\"}"))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString()).get("id").asText();

        String paxInB = objectMapper.readTree(mockMvc.perform(post("/api/transport/passengers")
                        .header("Authorization", "Bearer " + adminToken).contentType("application/json")
                        .content("{\"busId\":\"" + busInB.getId() + "\",\"passengerCode\":\"B-PAX\",\"fullName\":\"B Pax\"}"))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString()).get("id").asText();

        String subject = "rm-a-" + UUID.randomUUID();
        scopeRepository.save(TransportUserScope.builder().tenantId(tenantId).keycloakSubject(subject).depotId(depotA.getId()).build());
        String routeManagerAToken = tokenFor(tenantId, "site_admin", subject);

        mockMvc.perform(get("/api/transport/passengers").header("Authorization", "Bearer " + routeManagerAToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].passengerCode").value("A-PAX"));

        mockMvc.perform(get("/api/transport/passengers/{id}", paxInA).header("Authorization", "Bearer " + routeManagerAToken))
                .andExpect(status().isOk());

        mockMvc.perform(get("/api/transport/passengers/{id}", paxInB).header("Authorization", "Bearer " + routeManagerAToken))
                .andExpect(status().isNotFound());

        // A Depot A-scoped Route Manager cannot enroll a passenger against a
        // bus in Depot B, even by naming its id directly.
        mockMvc.perform(post("/api/transport/passengers")
                        .header("Authorization", "Bearer " + routeManagerAToken).contentType("application/json")
                        .content("{\"busId\":\"" + busInB.getId() + "\",\"passengerCode\":\"SHOULD-FAIL\",\"fullName\":\"X\"}"))
                .andExpect(status().isBadRequest());
    }
}
