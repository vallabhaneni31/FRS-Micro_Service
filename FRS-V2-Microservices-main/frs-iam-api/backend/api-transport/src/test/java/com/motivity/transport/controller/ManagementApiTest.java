package com.motivity.transport.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.motivity.transport.entity.Bus;
import com.motivity.transport.entity.Depot;
import com.motivity.transport.entity.Route;
import com.motivity.transport.entity.TransportUserScope;
import com.motivity.transport.repository.BusRepository;
import com.motivity.transport.repository.DepotRepository;
import com.motivity.transport.repository.RouteRepository;
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

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Phase 2f verification — the FULL real chain: SecurityConfig's userChain,
 * the real KeycloakAuthFilter, @PreAuthorize + the real TransportPermissions
 * map, and the real database. keycloak.url is overridden (via
 * @DynamicPropertySource, resolved before context startup) to point at a
 * self-hosted fake JWKS server for the SAME reason as KeycloakAuthFilterTest
 * in 2c — no live Keycloak realm is ever touched.
 */
@SpringBootTest
@AutoConfigureMockMvc
class ManagementApiTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private RouteRepository routeRepository;

    @Autowired
    private DepotRepository depotRepository;

    @Autowired
    private TransportUserScopeRepository scopeRepository;

    @Autowired
    private BusRepository busRepository;

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
    // (depot/bus assignment) for the token's subject BEFORE the request —
    // the plain tokenFor() above mints a fresh random subject each call,
    // which works fine for TENANT_WIDE roles but leaves DEPOT/BUS-scoped
    // roles permanently UNASSIGNED (no row could ever have been created
    // for a subject nobody knew in advance).
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

    // ---- Transport Admin: full CRUD on buses ----

    @Test
    void transportAdminCanCreateReadUpdateAndDeleteABus() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String token = tokenFor(tenantId, "tenant_admin");

        String createBody = """
                {"busCode":"ADMIN-BUS-01","capacity":40}
                """;
        String createResponse = mockMvc.perform(post("/api/transport/buses")
                        .header("Authorization", "Bearer " + token)
                        .contentType("application/json").content(createBody))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.busCode").value("ADMIN-BUS-01"))
                .andReturn().getResponse().getContentAsString();
        String busId = objectMapper.readTree(createResponse).get("id").asText();

        mockMvc.perform(get("/api/transport/buses/{id}", busId).header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.busCode").value("ADMIN-BUS-01"));

        mockMvc.perform(patch("/api/transport/buses/{id}", busId)
                        .header("Authorization", "Bearer " + token)
                        .contentType("application/json").content("{\"capacity\":55}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.capacity").value(55));

        mockMvc.perform(delete("/api/transport/buses/{id}", busId).header("Authorization", "Bearer " + token))
                .andExpect(status().isNoContent());

        mockMvc.perform(get("/api/transport/buses/{id}", busId).header("Authorization", "Bearer " + token))
                .andExpect(status().isNotFound());
    }

    // ---- Viewer: read-only ----

    @Test
    void viewerCanReadButNotWriteBuses() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String viewerToken = tokenFor(tenantId, "viewer");

        mockMvc.perform(get("/api/transport/buses").header("Authorization", "Bearer " + viewerToken))
                .andExpect(status().isOk());

        mockMvc.perform(post("/api/transport/buses")
                        .header("Authorization", "Bearer " + viewerToken)
                        .contentType("application/json").content("{\"busCode\":\"VIEWER-SHOULD-NOT-CREATE\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error").value("FORBIDDEN"));
    }

    // ---- Route Manager: can write buses (within their own depot), but not delete ----

    @Test
    void routeManagerCanWriteBusesButCannotDeleteThem() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String subject = "rm-" + UUID.randomUUID();
        Depot depot = depotRepository.save(Depot.builder().tenantId(tenantId).depotName("RM Depot").build());
        scopeRepository.save(TransportUserScope.builder().tenantId(tenantId).keycloakSubject(subject).depotId(depot.getId()).build());
        String siteAdminToken = tokenFor(tenantId, "site_admin", subject);

        String createResponse = mockMvc.perform(post("/api/transport/buses")
                        .header("Authorization", "Bearer " + siteAdminToken)
                        .contentType("application/json").content("{\"busCode\":\"RM-BUS-01\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.depotId").value(depot.getId().toString())) // forced to their own depot
                .andReturn().getResponse().getContentAsString();
        String busId = objectMapper.readTree(createResponse).get("id").asText();

        mockMvc.perform(delete("/api/transport/buses/{id}", busId).header("Authorization", "Bearer " + siteAdminToken))
                .andExpect(status().isForbidden());
    }

    @Test
    void routeManagerWithNoScopeAssignmentCannotCreateBuses() throws Exception {
        // A site_admin who authenticates successfully but has no
        // transport_user_scope row yet — UNASSIGNED, deny-by-default,
        // never a silent fallback to tenant-wide access.
        UUID tenantId = UUID.randomUUID();
        String siteAdminToken = tokenFor(tenantId, "site_admin");

        mockMvc.perform(get("/api/transport/buses").header("Authorization", "Bearer " + siteAdminToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$").isArray())
                .andExpect(jsonPath("$").isEmpty());

        mockMvc.perform(post("/api/transport/buses")
                        .header("Authorization", "Bearer " + siteAdminToken)
                        .contentType("application/json").content("{\"busCode\":\"SHOULD-NOT-BE-CREATED\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void routeManagerOnlySeesBusesInTheirOwnDepot() throws Exception {
        UUID tenantId = UUID.randomUUID();
        Depot depotA = depotRepository.save(Depot.builder().tenantId(tenantId).depotName("Depot A").build());
        Depot depotB = depotRepository.save(Depot.builder().tenantId(tenantId).depotName("Depot B").build());
        String adminToken = tokenFor(tenantId, "tenant_admin");

        String busInA = objectMapper.readTree(mockMvc.perform(post("/api/transport/buses")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType("application/json")
                        .content("{\"busCode\":\"DEPOT-A-BUS\",\"depotId\":\"" + depotA.getId() + "\"}"))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString()).get("id").asText();

        String busInB = objectMapper.readTree(mockMvc.perform(post("/api/transport/buses")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType("application/json")
                        .content("{\"busCode\":\"DEPOT-B-BUS\",\"depotId\":\"" + depotB.getId() + "\"}"))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString()).get("id").asText();

        String subject = "rm-a-" + UUID.randomUUID();
        scopeRepository.save(TransportUserScope.builder().tenantId(tenantId).keycloakSubject(subject).depotId(depotA.getId()).build());
        String routeManagerAToken = tokenFor(tenantId, "site_admin", subject);

        mockMvc.perform(get("/api/transport/buses").header("Authorization", "Bearer " + routeManagerAToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].busCode").value("DEPOT-A-BUS"));

        mockMvc.perform(get("/api/transport/buses/{id}", busInA).header("Authorization", "Bearer " + routeManagerAToken))
                .andExpect(status().isOk());

        // Depot B's bus must not resolve for a Depot A-scoped Route Manager
        // — not even as a 403, which would leak that it exists.
        mockMvc.perform(get("/api/transport/buses/{id}", busInB).header("Authorization", "Bearer " + routeManagerAToken))
                .andExpect(status().isNotFound());

        // Attempting to plant a bus in someone else's depot via a spoofed
        // depotId in the request body is ignored — always forced to their
        // own scope, the same "never trust client input for the boundary
        // that matters" rule tenantId already follows.
        String spoofResponse = mockMvc.perform(post("/api/transport/buses")
                        .header("Authorization", "Bearer " + routeManagerAToken)
                        .contentType("application/json")
                        .content("{\"busCode\":\"SPOOF-ATTEMPT\",\"depotId\":\"" + depotB.getId() + "\"}"))
                .andExpect(status().isCreated())
                .andReturn().getResponse().getContentAsString();
        assertThat(objectMapper.readTree(spoofResponse).get("depotId").asText()).isEqualTo(depotA.getId().toString());
    }

    // ---- Operations Manager: read-only, and only their one assigned bus ----

    @Test
    void operationsManagerCanOnlyReadTheirOwnAssignedBus() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String adminToken = tokenFor(tenantId, "tenant_admin");

        String busA = objectMapper.readTree(mockMvc.perform(post("/api/transport/buses")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType("application/json").content("{\"busCode\":\"OM-OWN-BUS\"}"))
                .andReturn().getResponse().getContentAsString()).get("id").asText();
        String busB = objectMapper.readTree(mockMvc.perform(post("/api/transport/buses")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType("application/json").content("{\"busCode\":\"OM-OTHER-BUS\"}"))
                .andReturn().getResponse().getContentAsString()).get("id").asText();

        String subject = "om-" + UUID.randomUUID();
        scopeRepository.save(TransportUserScope.builder().tenantId(tenantId).keycloakSubject(subject)
                .busId(UUID.fromString(busA)).build());
        String hrManagerToken = tokenFor(tenantId, "hr_manager", subject);

        mockMvc.perform(get("/api/transport/buses").header("Authorization", "Bearer " + hrManagerToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].id").value(busA));

        mockMvc.perform(get("/api/transport/buses/{id}", busA).header("Authorization", "Bearer " + hrManagerToken))
                .andExpect(status().isOk());
        mockMvc.perform(get("/api/transport/buses/{id}", busB).header("Authorization", "Bearer " + hrManagerToken))
                .andExpect(status().isNotFound());

        // Still no write access — BUSES_READ was added for the Bus View
        // metrics bar, BUSES_WRITE was never granted to hr_manager.
        mockMvc.perform(patch("/api/transport/buses/{id}", busA)
                        .header("Authorization", "Bearer " + hrManagerToken)
                        .contentType("application/json").content("{\"capacity\":10}"))
                .andExpect(status().isForbidden());
    }

    @Test
    void operationsManagerWithNoScopeAssignmentSeesNothing() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String hrManagerToken = tokenFor(tenantId, "hr_manager");

        mockMvc.perform(get("/api/transport/buses").header("Authorization", "Bearer " + hrManagerToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$").isEmpty());
    }

    // ---- Depot scoping: Routes and Devices (same pattern as Buses) ----

    @Test
    void routeManagerOnlySeesRoutesInTheirOwnDepot() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String adminToken = tokenFor(tenantId, "tenant_admin");
        Depot depotA = depotRepository.save(Depot.builder().tenantId(tenantId).depotName("Route Depot A").build());
        Depot depotB = depotRepository.save(Depot.builder().tenantId(tenantId).depotName("Route Depot B").build());

        mockMvc.perform(post("/api/transport/routes")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType("application/json")
                        .content("{\"routeName\":\"Route-A\",\"depotId\":\"" + depotA.getId() + "\"}"))
                .andExpect(status().isCreated());
        String routeBId = objectMapper.readTree(mockMvc.perform(post("/api/transport/routes")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType("application/json")
                        .content("{\"routeName\":\"Route-B\",\"depotId\":\"" + depotB.getId() + "\"}"))
                .andReturn().getResponse().getContentAsString()).get("id").asText();

        String subject = "rm-routes-" + UUID.randomUUID();
        scopeRepository.save(TransportUserScope.builder().tenantId(tenantId).keycloakSubject(subject).depotId(depotA.getId()).build());
        String routeManagerAToken = tokenFor(tenantId, "site_admin", subject);

        mockMvc.perform(get("/api/transport/routes").header("Authorization", "Bearer " + routeManagerAToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].routeName").value("Route-A"));

        mockMvc.perform(get("/api/transport/routes/{id}", routeBId).header("Authorization", "Bearer " + routeManagerAToken))
                .andExpect(status().isNotFound());
    }

    @Test
    void routeManagerCannotRegisterADeviceOnABusOutsideTheirDepot() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String adminToken = tokenFor(tenantId, "tenant_admin");
        Depot depotA = depotRepository.save(Depot.builder().tenantId(tenantId).depotName("Device Depot A").build());
        Depot depotB = depotRepository.save(Depot.builder().tenantId(tenantId).depotName("Device Depot B").build());

        String busInA = objectMapper.readTree(mockMvc.perform(post("/api/transport/buses")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType("application/json")
                        .content("{\"busCode\":\"DEV-DEPOT-A-BUS\",\"depotId\":\"" + depotA.getId() + "\"}"))
                .andReturn().getResponse().getContentAsString()).get("id").asText();
        String busInB = objectMapper.readTree(mockMvc.perform(post("/api/transport/buses")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType("application/json")
                        .content("{\"busCode\":\"DEV-DEPOT-B-BUS\",\"depotId\":\"" + depotB.getId() + "\"}"))
                .andReturn().getResponse().getContentAsString()).get("id").asText();

        String subject = "rm-devices-" + UUID.randomUUID();
        scopeRepository.save(TransportUserScope.builder().tenantId(tenantId).keycloakSubject(subject).depotId(depotA.getId()).build());
        String routeManagerAToken = tokenFor(tenantId, "site_admin", subject);

        // Their own depot's bus: fine.
        mockMvc.perform(post("/api/transport/devices")
                        .header("Authorization", "Bearer " + routeManagerAToken)
                        .contentType("application/json")
                        .content("{\"busId\":\"" + busInA + "\",\"deviceCode\":\"DEV-A-01\",\"cameraPosition\":\"boarding\"}"))
                .andExpect(status().isCreated());

        // A real bus, same tenant, but a different depot: rejected as an
        // invalid reference — not a 403, matching how a cross-tenant
        // reference is already rejected for BUSES/ROUTES.
        mockMvc.perform(post("/api/transport/devices")
                        .header("Authorization", "Bearer " + routeManagerAToken)
                        .contentType("application/json")
                        .content("{\"busId\":\"" + busInB + "\",\"deviceCode\":\"DEV-B-01\",\"cameraPosition\":\"boarding\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("INVALID_REFERENCE"));

        mockMvc.perform(get("/api/transport/devices").header("Authorization", "Bearer " + routeManagerAToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].deviceCode").value("DEV-A-01"));
    }

    // ---- User scope assignment: Admin can assign depots/buses tenant-wide; Route Manager only buses in their own depot ----

    @Test
    void tenantAdminCanAssignARouteManagerToADepotAndAnOperationsManagerToABus() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String adminToken = tokenFor(tenantId, "tenant_admin");
        Depot depot = depotRepository.save(Depot.builder().tenantId(tenantId).depotName("Scope Depot").build());
        Bus bus = busRepository.save(Bus.builder().tenantId(tenantId).busCode("SCOPE-BUS-01").depotId(depot.getId()).build());

        mockMvc.perform(post("/api/transport/user-scopes")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType("application/json")
                        .content("{\"keycloakSubject\":\"rm-user-1\",\"depotId\":\"" + depot.getId() + "\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.keycloakSubject").value("rm-user-1"))
                .andExpect(jsonPath("$.depotId").value(depot.getId().toString()))
                .andExpect(jsonPath("$.busId").doesNotExist());

        mockMvc.perform(post("/api/transport/user-scopes")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType("application/json")
                        .content("{\"keycloakSubject\":\"om-user-1\",\"busId\":\"" + bus.getId() + "\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.busId").value(bus.getId().toString()));

        mockMvc.perform(get("/api/transport/user-scopes").header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(2));
    }

    @Test
    void requestWithBothOrNeitherOfDepotIdAndBusIdIsRejected() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String adminToken = tokenFor(tenantId, "tenant_admin");

        mockMvc.perform(post("/api/transport/user-scopes")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType("application/json")
                        .content("{\"keycloakSubject\":\"neither-test\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void routeManagerCanOnlyAssignOperationsManagersToBusesInTheirOwnDepotAndCannotAssignAnotherRouteManager() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String adminToken = tokenFor(tenantId, "tenant_admin");
        Depot depotA = depotRepository.save(Depot.builder().tenantId(tenantId).depotName("Scope Depot A").build());
        Depot depotB = depotRepository.save(Depot.builder().tenantId(tenantId).depotName("Scope Depot B").build());
        Bus busInA = busRepository.save(Bus.builder().tenantId(tenantId).busCode("SCOPE-A-BUS").depotId(depotA.getId()).build());
        Bus busInB = busRepository.save(Bus.builder().tenantId(tenantId).busCode("SCOPE-B-BUS").depotId(depotB.getId()).build());

        String subject = "rm-scope-" + UUID.randomUUID();
        scopeRepository.save(TransportUserScope.builder().tenantId(tenantId).keycloakSubject(subject).depotId(depotA.getId()).build());
        String routeManagerAToken = tokenFor(tenantId, "site_admin", subject);

        // Assigning an Operations Manager to a bus in their own depot: fine.
        mockMvc.perform(post("/api/transport/user-scopes")
                        .header("Authorization", "Bearer " + routeManagerAToken)
                        .contentType("application/json")
                        .content("{\"keycloakSubject\":\"om-a-1\",\"busId\":\"" + busInA.getId() + "\"}"))
                .andExpect(status().isCreated());

        // A real bus, same tenant, but a different depot: rejected.
        mockMvc.perform(post("/api/transport/user-scopes")
                        .header("Authorization", "Bearer " + routeManagerAToken)
                        .contentType("application/json")
                        .content("{\"keycloakSubject\":\"om-b-1\",\"busId\":\"" + busInB.getId() + "\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("INVALID_REFERENCE"));

        // Cannot assign another Route Manager (depot-level scope) at all.
        mockMvc.perform(post("/api/transport/user-scopes")
                        .header("Authorization", "Bearer " + routeManagerAToken)
                        .contentType("application/json")
                        .content("{\"keycloakSubject\":\"rm-2\",\"depotId\":\"" + depotA.getId() + "\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("INVALID_REFERENCE"));

        // Their own list view only shows Depot A's Operations Manager, not
        // anything from Depot B, and not the Route Manager-level row created
        // by the admin in the previous test's tenant (different tenant here anyway).
        mockMvc.perform(get("/api/transport/user-scopes").header("Authorization", "Bearer " + routeManagerAToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].keycloakSubject").value("om-a-1"));
    }

    @Test
    void operationsManagerCannotReachUserScopeEndpointsAtAll() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String hrManagerToken = tokenFor(tenantId, "hr_manager");

        mockMvc.perform(get("/api/transport/user-scopes").header("Authorization", "Bearer " + hrManagerToken))
                .andExpect(status().isForbidden());
        mockMvc.perform(post("/api/transport/user-scopes")
                        .header("Authorization", "Bearer " + hrManagerToken)
                        .contentType("application/json")
                        .content("{\"keycloakSubject\":\"x\",\"busId\":\"" + UUID.randomUUID() + "\"}"))
                .andExpect(status().isForbidden());
    }

    @Test
    void routeManagerCanUnassignOnlyTheirOwnDepotsOperationsManagers() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String adminToken = tokenFor(tenantId, "tenant_admin");
        Depot depotA = depotRepository.save(Depot.builder().tenantId(tenantId).depotName("Unassign Depot A").build());
        Depot depotB = depotRepository.save(Depot.builder().tenantId(tenantId).depotName("Unassign Depot B").build());
        Bus busInA = busRepository.save(Bus.builder().tenantId(tenantId).busCode("UNASSIGN-A-BUS").depotId(depotA.getId()).build());
        Bus busInB = busRepository.save(Bus.builder().tenantId(tenantId).busCode("UNASSIGN-B-BUS").depotId(depotB.getId()).build());

        String scopeAId = objectMapper.readTree(mockMvc.perform(post("/api/transport/user-scopes")
                        .header("Authorization", "Bearer " + adminToken).contentType("application/json")
                        .content("{\"keycloakSubject\":\"om-unassign-a\",\"busId\":\"" + busInA.getId() + "\"}"))
                .andReturn().getResponse().getContentAsString()).get("id").asText();
        String scopeBId = objectMapper.readTree(mockMvc.perform(post("/api/transport/user-scopes")
                        .header("Authorization", "Bearer " + adminToken).contentType("application/json")
                        .content("{\"keycloakSubject\":\"om-unassign-b\",\"busId\":\"" + busInB.getId() + "\"}"))
                .andReturn().getResponse().getContentAsString()).get("id").asText();

        String subject = "rm-unassign-" + UUID.randomUUID();
        scopeRepository.save(TransportUserScope.builder().tenantId(tenantId).keycloakSubject(subject).depotId(depotA.getId()).build());
        String routeManagerAToken = tokenFor(tenantId, "site_admin", subject);

        mockMvc.perform(delete("/api/transport/user-scopes/{id}", scopeAId).header("Authorization", "Bearer " + routeManagerAToken))
                .andExpect(status().isNoContent());
        mockMvc.perform(delete("/api/transport/user-scopes/{id}", scopeBId).header("Authorization", "Bearer " + routeManagerAToken))
                .andExpect(status().isNotFound());
    }

    // ---- Depots: Admin-only create, Route Manager read-only their own ----

    @Test
    void onlyTransportAdminCanCreateDepots() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String adminToken = tokenFor(tenantId, "tenant_admin");
        String siteAdminToken = tokenFor(tenantId, "site_admin");

        mockMvc.perform(post("/api/transport/depots")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType("application/json").content("{\"depotName\":\"Main Yard\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.depotName").value("Main Yard"));

        mockMvc.perform(post("/api/transport/depots")
                        .header("Authorization", "Bearer " + siteAdminToken)
                        .contentType("application/json").content("{\"depotName\":\"Should Not Be Created\"}"))
                .andExpect(status().isForbidden());
    }

    // ---- Tenant isolation ----

    @Test
    void oneTenantCannotSeeAnotherTenantsBus() throws Exception {
        UUID tenantA = UUID.randomUUID();
        UUID tenantB = UUID.randomUUID();
        String tokenA = tokenFor(tenantA, "tenant_admin");
        String tokenB = tokenFor(tenantB, "tenant_admin");

        String createResponse = mockMvc.perform(post("/api/transport/buses")
                        .header("Authorization", "Bearer " + tokenA)
                        .contentType("application/json").content("{\"busCode\":\"TENANT-A-ONLY\"}"))
                .andExpect(status().isCreated())
                .andReturn().getResponse().getContentAsString();
        String busId = objectMapper.readTree(createResponse).get("id").asText();

        // Tenant B's own token, same bus id — must not resolve, not even as a 403 (which would leak existence).
        mockMvc.perform(get("/api/transport/buses/{id}", busId).header("Authorization", "Bearer " + tokenB))
                .andExpect(status().isNotFound());

        List<?> tenantBBuses = objectMapper.readValue(
                mockMvc.perform(get("/api/transport/buses").header("Authorization", "Bearer " + tokenB))
                        .andExpect(status().isOk()).andReturn().getResponse().getContentAsString(),
                List.class);
        assertThat(tenantBBuses).isEmpty();
    }

    // ---- Cross-tenant reference rejection ----

    @Test
    void creatingABusWithAnotherTenantsRouteIdIsRejected() throws Exception {
        UUID tenantA = UUID.randomUUID();
        UUID tenantB = UUID.randomUUID();
        String tokenB = tokenFor(tenantB, "tenant_admin");

        Route tenantARoute = routeRepository.save(Route.builder()
                .tenantId(tenantA)
                .routeName("TENANT-A-ROUTE-" + UUID.randomUUID().toString().substring(0, 8))
                .stops("[]")
                .build());

        String body = "{\"busCode\":\"CROSS-TENANT-TEST\",\"routeId\":\"" + tenantARoute.getId() + "\"}";
        mockMvc.perform(post("/api/transport/buses")
                        .header("Authorization", "Bearer " + tokenB)
                        .contentType("application/json").content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("INVALID_REFERENCE"));

        routeRepository.delete(tenantARoute);
    }

    // ---- Device secret handling ----

    @Test
    void deviceSecretIsReturnedOnlyOnceAtCreationAndRotationNeverOnListOrGet() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String token = tokenFor(tenantId, "tenant_admin");

        String busResponse = mockMvc.perform(post("/api/transport/buses")
                        .header("Authorization", "Bearer " + token)
                        .contentType("application/json").content("{\"busCode\":\"DEVICE-TEST-BUS\"}"))
                .andExpect(status().isCreated())
                .andReturn().getResponse().getContentAsString();
        String busId = objectMapper.readTree(busResponse).get("id").asText();

        String deviceBody = "{\"busId\":\"" + busId + "\",\"deviceCode\":\"DEVICE-TEST-01\",\"cameraPosition\":\"boarding\"}";
        String createResponse = mockMvc.perform(post("/api/transport/devices")
                        .header("Authorization", "Bearer " + token)
                        .contentType("application/json").content(deviceBody))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.deviceSecret").exists())
                .andReturn().getResponse().getContentAsString();
        JsonNode created = objectMapper.readTree(createResponse);
        String deviceId = created.get("device").get("id").asText();
        String firstSecret = created.get("deviceSecret").asText();
        assertThat(firstSecret).hasSize(64); // 32 bytes hex-encoded

        // GET and LIST must never include the secret field at all.
        mockMvc.perform(get("/api/transport/devices/{id}", deviceId).header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.deviceSecret").doesNotExist());
        mockMvc.perform(get("/api/transport/devices").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].deviceSecret").doesNotExist());

        // Rotation returns a genuinely new secret.
        String rotateResponse = mockMvc.perform(post("/api/transport/devices/{id}/rotate-secret", deviceId)
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
        String secondSecret = objectMapper.readTree(rotateResponse).get("deviceSecret").asText();
        assertThat(secondSecret).isNotEqualTo(firstSecret);
    }

    @Test
    void decommissioningADeviceSetsStatusOfflineAndTimestamp() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String token = tokenFor(tenantId, "tenant_admin");

        String busResponse = mockMvc.perform(post("/api/transport/buses")
                        .header("Authorization", "Bearer " + token)
                        .contentType("application/json").content("{\"busCode\":\"DECOMM-TEST-BUS\"}"))
                .andReturn().getResponse().getContentAsString();
        String busId = objectMapper.readTree(busResponse).get("id").asText();

        String deviceBody = "{\"busId\":\"" + busId + "\",\"deviceCode\":\"DECOMM-TEST-DEVICE\",\"cameraPosition\":\"deboarding\"}";
        String createResponse = mockMvc.perform(post("/api/transport/devices")
                        .header("Authorization", "Bearer " + token)
                        .contentType("application/json").content(deviceBody))
                .andReturn().getResponse().getContentAsString();
        String deviceId = objectMapper.readTree(createResponse).get("device").get("id").asText();

        mockMvc.perform(post("/api/transport/devices/{id}/decommission", deviceId).header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("offline"))
                .andExpect(jsonPath("$.decommissionedAt").exists());
    }
}
