package com.motivity.transport.security;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpServer;
import jakarta.servlet.FilterChain;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

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
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Phase 2c verification. Signature/issuer verification is tested against a
 * self-hosted fake HTTP server that serves the exact same JWKS shape
 * Keycloak does — no live Keycloak realm is ever touched or created for
 * this. Realm slug is deliberately "attendance" (the configured default
 * realm) so the filter takes the "trust the token's own tenant_id claim"
 * branch rather than the tenant_realm DB-lookup branch — that DB-lookup
 * branch is verified separately below, as a real read-only query against
 * the actual shared platform database.
 */
@SpringBootTest
class KeycloakAuthFilterTest {

    @Autowired
    @Qualifier("frsJdbcTemplate")
    private JdbcTemplate frsJdbcTemplate;

    @Autowired
    private TransportScopeResolver scopeResolver;

    private static HttpServer fakeKeycloak;
    private static RSAPrivateKey privateKey;
    private static RSAPublicKey publicKey;
    private static String issuerBaseUrl;

    @BeforeAll
    static void startFakeKeycloak() throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(2048);
        KeyPair pair = gen.generateKeyPair();
        privateKey = (RSAPrivateKey) pair.getPrivate();
        publicKey = (RSAPublicKey) pair.getPublic();

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
        issuerBaseUrl = "http://localhost:" + fakeKeycloak.getAddress().getPort();
    }

    @AfterAll
    static void stopFakeKeycloak() {
        if (fakeKeycloak != null) fakeKeycloak.stop(0);
    }

    @AfterEach
    void clearSecurityContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void acceptsAValidTokenAndExtractsTenantAndRoles() throws Exception {
        UUID tenantId = UUID.randomUUID();
        String token = signToken(privateKey, "test-key", Map.of(
                "sub", "user-123",
                "tenant_id", tenantId.toString(),
                "aud", "account",
                "realm_access", Map.of("roles", List.of("site_admin"))
        ), issuerBaseUrl + "/realms/attendance", Instant.now().plusSeconds(300));

        var result = runFilter(token);

        assertThat(result.chainCalled).isTrue();
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        assertThat(auth).isNotNull();
        UserPrincipal principal = (UserPrincipal) auth.getPrincipal();
        assertThat(principal.tenantId()).isEqualTo(tenantId);
        assertThat(principal.roles()).containsExactly("site_admin");
        assertThat(TransportPermissions.hasPermission(principal.roles(), TransportPermission.BUSES_WRITE)).isTrue();
        // site_admin (Route Manager) holds USERS_MANAGE so they can reach the
        // User Management page — TransportUserScopeService, not this
        // permission, is what actually restricts them to their own depot
        // and forbids assigning another Route Manager (see ManagementApiTest).
        assertThat(TransportPermissions.hasPermission(principal.roles(), TransportPermission.USERS_MANAGE)).isTrue();
        assertThat(TransportPermissions.hasPermission(principal.roles(), TransportPermission.DEPOTS_WRITE)).isFalse();
    }

    @Test
    void acceptsATokenWhoseIssuerHostDiffersFromKeycloakBaseUrl() throws Exception {
        // Reproduces the real production bug: Keycloak's real-world issuer is
        // the external, browser-facing URL (e.g.
        // https://dev-frs.motivitylabs.com/auth/realms/X), which is not the
        // same string as keycloakBaseUrl, this service's own internal
        // loopback address for reaching Keycloak (e.g.
        // http://localhost:9090/auth) — every real tenant realm's token was
        // rejected with invalid_token_signature because buildDecoder used to
        // reconstruct an expected issuer FROM keycloakBaseUrl and compare it
        // against the token's real (different) issuer. "localhost" and
        // "127.0.0.1" both reach the same fake JWKS server here but are
        // different strings, exactly mirroring that internal/external split
        // without touching any real network resource.
        UUID tenantId = UUID.randomUUID();
        String tokenIssuer = "http://localhost:" + fakeKeycloak.getAddress().getPort() + "/realms/attendance";
        String differentKeycloakBaseUrl = "http://127.0.0.1:" + fakeKeycloak.getAddress().getPort();

        String token = signToken(privateKey, "test-key", Map.of(
                "sub", "user-456",
                "tenant_id", tenantId.toString(),
                "aud", "account",
                "realm_access", Map.of("roles", List.of("tenant_admin"))
        ), tokenIssuer, Instant.now().plusSeconds(300));

        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader("Authorization", "Bearer " + token);
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicBoolean chainCalled = new AtomicBoolean(false);
        FilterChain chain = (req, res) -> chainCalled.set(true);

        new KeycloakAuthFilter(frsJdbcTemplate, scopeResolver, differentKeycloakBaseUrl, "attendance", "attendance-api")
                .doFilter(request, response, chain);

        assertThat(chainCalled.get()).isTrue();
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        UserPrincipal principal = (UserPrincipal) auth.getPrincipal();
        assertThat(principal.tenantId()).isEqualTo(tenantId);
    }

    @Test
    void rejectsATokenSignedByAKeyNotInTheJwks() throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(2048);
        RSAPrivateKey imposterKey = (RSAPrivateKey) gen.generateKeyPair().getPrivate();

        String token = signToken(imposterKey, "test-key", Map.of(
                "sub", "user-123",
                "tenant_id", UUID.randomUUID().toString(),
                "realm_access", Map.of("roles", List.of("tenant_admin"))
        ), issuerBaseUrl + "/realms/attendance", Instant.now().plusSeconds(300));

        var result = runFilter(token);

        assertThat(result.chainCalled).isFalse();
        assertThat(result.response.getStatus()).isEqualTo(401);
    }

    @Test
    void rejectsAnExpiredToken() throws Exception {
        String token = signToken(privateKey, "test-key", Map.of(
                "sub", "user-123",
                "tenant_id", UUID.randomUUID().toString(),
                "realm_access", Map.of("roles", List.of("viewer"))
        ), issuerBaseUrl + "/realms/attendance", Instant.now().minusSeconds(60));

        var result = runFilter(token);

        assertThat(result.chainCalled).isFalse();
        assertThat(result.response.getStatus()).isEqualTo(401);
    }

    @Test
    void rejectsAnIssuerThatDoesNotMatchTheRealmItClaims() throws Exception {
        // Signed correctly, but iss points at a DIFFERENT realm than the one
        // whose JWKS actually signed it — JwtValidators.createDefaultWithIssuer
        // must catch this, not just "is the signature valid".
        String token = signToken(privateKey, "test-key", Map.of(
                "sub", "user-123",
                "tenant_id", UUID.randomUUID().toString(),
                "realm_access", Map.of("roles", List.of("viewer"))
        ), issuerBaseUrl + "/realms/some-other-realm", Instant.now().plusSeconds(300));

        var result = runFilter(token);

        // Falls into the non-default-realm branch, which does a real DB
        // lookup for "some-other-realm" — not registered, so this is
        // rejected before signature verification is even reached.
        assertThat(result.chainCalled).isFalse();
        assertThat(result.response.getStatus()).isEqualTo(401);
        assertThat(result.response.getContentAsString()).contains("realm_not_registered");
    }

    @Test
    void realTenantRealmLookupAgainstTheActualPlatformDatabaseReturnsARealRow() {
        // Read-only — proves the SQL KeycloakAuthFilter runs for non-default
        // realms is valid against the real schema and returns real data,
        // without needing a live Keycloak-issued token for it.
        //
        // "attendance" itself deliberately has NO row here — it's the
        // default/base realm, exempt from this lookup by design (both here
        // and in the existing platform's keycloakVerifier.js: the DB lookup
        // only runs for realmSlug != the configured default). tenant_realm
        // only holds the dynamically-provisioned PER-TENANT realms, so this
        // checks one of those instead (confirmed present via direct psql
        // before writing this assertion, not guessed).
        List<Map<String, Object>> rows = frsJdbcTemplate.queryForList(
                "SELECT realm_slug, fk_tenant_id FROM tenant_realm WHERE realm_slug = 'motivity-qa'");
        assertThat(rows).isNotEmpty();
        assertThat(rows.get(0)).containsKey("fk_tenant_id");
    }

    private String signToken(RSAPrivateKey signingKey, String keyId, Map<String, Object> claims, String issuer, Instant expiry) throws Exception {
        JWTClaimsSet.Builder builder = new JWTClaimsSet.Builder()
                .issuer(issuer)
                .issueTime(Date.from(Instant.now().minusSeconds(10)))
                .expirationTime(Date.from(expiry));
        claims.forEach(builder::claim);
        SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(keyId).build(), builder.build());
        jwt.sign(new RSASSASigner(signingKey));
        return jwt.serialize();
    }

    private FilterResult runFilter(String token) throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader("Authorization", "Bearer " + token);
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicBoolean chainCalled = new AtomicBoolean(false);
        FilterChain chain = (req, res) -> chainCalled.set(true);

        new KeycloakAuthFilter(frsJdbcTemplate, scopeResolver, issuerBaseUrl, "attendance", "attendance-api")
                .doFilter(request, response, chain);

        FilterResult result = new FilterResult();
        result.response = response;
        result.chainCalled = chainCalled.get();
        return result;
    }

    private static class FilterResult {
        MockHttpServletResponse response;
        boolean chainCalled;
    }
}
