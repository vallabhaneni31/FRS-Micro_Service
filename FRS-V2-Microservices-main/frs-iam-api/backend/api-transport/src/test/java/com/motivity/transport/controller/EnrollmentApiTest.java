package com.motivity.transport.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.motivity.transport.entity.Bus;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpServer;
import com.motivity.transport.repository.BusRepository;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
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
 * Track B, Phase 4 — real end-to-end enrollment against the actual
 * dedicated face-quality-svc-transport instance (:5051, deployed alongside
 * this feature) and the real passenger_face_embeddings table (pgvector
 * insert via native query). No mocking of the face service — these tests
 * only pass if the whole chain (multipart upload -> local disk ->
 * FaceEmbeddingClient -> face-quality-svc-transport -> pgvector insert)
 * genuinely works.
 */
@SpringBootTest
@AutoConfigureMockMvc
class EnrollmentApiTest {

    @Autowired
    private MockMvc mockMvc;

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

    private byte[] testFace(String name) throws Exception {
        return Files.readAllBytes(java.nio.file.Path.of(
                getClass().getClassLoader().getResource(name).toURI()));
    }

    private String createPassenger(String token, UUID tenantId) throws Exception {
        Bus bus = busRepository.save(Bus.builder().tenantId(tenantId).busCode("ENROLL-BUS-" + UUID.randomUUID().toString().substring(0, 8)).build());
        String body = """
                {"busId":"%s","passengerCode":"ENROLL-%s","fullName":"Enrollment Test Passenger"}
                """.formatted(bus.getId(), UUID.randomUUID().toString().substring(0, 8));
        String response = mockMvc.perform(post("/api/transport/passengers")
                        .header("Authorization", "Bearer " + token).contentType("application/json").content(body))
                .andExpect(status().isCreated())
                .andReturn().getResponse().getContentAsString();
        return objectMapper.readTree(response).get("id").asText();
    }

    @Test
    void enrollingARealFacePhotoCreatesAnEmbeddingRow() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String token = tokenFor(tenantId, "tenant_admin");
        String passengerId = createPassenger(token, tenantId);

        MockMultipartFile photo = new MockMultipartFile("photo", "front.jpg", "image/jpeg", testFace("test-face-front.jpg"));

        mockMvc.perform(multipart("/api/transport/passengers/{id}/photos", passengerId)
                        .file(photo)
                        .param("angle", "front")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isCreated());

        mockMvc.perform(get("/api/transport/passengers/{id}/photos", passengerId)
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].angle").value("front"))
                .andExpect(jsonPath("$[0].modelVersion").value("insightface-buffalo_sc"))
                .andExpect(jsonPath("$[0].qualityScore").exists());
    }

    @Test
    void enrollingTwoAnglesAddsTwoRowsAndResetRemovesBoth() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String token = tokenFor(tenantId, "tenant_admin");
        String passengerId = createPassenger(token, tenantId);

        mockMvc.perform(multipart("/api/transport/passengers/{id}/photos", passengerId)
                        .file(new MockMultipartFile("photo", "front.jpg", "image/jpeg", testFace("test-face-front.jpg")))
                        .param("angle", "front")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isCreated());

        mockMvc.perform(multipart("/api/transport/passengers/{id}/photos", passengerId)
                        .file(new MockMultipartFile("photo", "down.jpg", "image/jpeg", testFace("test-face-down.jpg")))
                        .param("angle", "down")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isCreated());

        mockMvc.perform(get("/api/transport/passengers/{id}/photos", passengerId).header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(2));

        mockMvc.perform(delete("/api/transport/passengers/{id}/photos", passengerId).header("Authorization", "Bearer " + token))
                .andExpect(status().isNoContent());

        mockMvc.perform(get("/api/transport/passengers/{id}/photos", passengerId).header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(0));
    }

    @Test
    void invalidAngleIsRejected() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String token = tokenFor(tenantId, "tenant_admin");
        String passengerId = createPassenger(token, tenantId);

        mockMvc.perform(multipart("/api/transport/passengers/{id}/photos", passengerId)
                        .file(new MockMultipartFile("photo", "front.jpg", "image/jpeg", testFace("test-face-front.jpg")))
                        .param("angle", "sideways")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("VALIDATION_ERROR"));
    }

    @Test
    void aPhotoWithNoDetectableFaceIsRejected() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String token = tokenFor(tenantId, "tenant_admin");
        String passengerId = createPassenger(token, tenantId);

        // A tiny solid-color JPEG has no face for InsightFace to detect.
        byte[] blank = blankJpeg();

        mockMvc.perform(multipart("/api/transport/passengers/{id}/photos", passengerId)
                        .file(new MockMultipartFile("photo", "blank.jpg", "image/jpeg", blank))
                        .param("angle", "front")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("VALIDATION_ERROR"));
    }

    private byte[] blankJpeg() throws Exception {
        java.awt.image.BufferedImage img = new java.awt.image.BufferedImage(100, 100, java.awt.image.BufferedImage.TYPE_INT_RGB);
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        javax.imageio.ImageIO.write(img, "jpg", out);
        return out.toByteArray();
    }

    @Test
    void hrManagerCannotEnrollPhotos() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String adminToken = tokenFor(tenantId, "tenant_admin");
        String passengerId = createPassenger(adminToken, tenantId);
        String hrManagerToken = tokenFor(tenantId, "hr_manager");

        mockMvc.perform(multipart("/api/transport/passengers/{id}/photos", passengerId)
                        .file(new MockMultipartFile("photo", "front.jpg", "image/jpeg", testFace("test-face-front.jpg")))
                        .param("angle", "front")
                        .header("Authorization", "Bearer " + hrManagerToken))
                .andExpect(status().isForbidden());
    }
}
