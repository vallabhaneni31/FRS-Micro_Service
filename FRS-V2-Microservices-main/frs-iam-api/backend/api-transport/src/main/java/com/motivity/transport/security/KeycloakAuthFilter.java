package com.motivity.transport.security;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Validates human/browser Keycloak tokens across every tenant realm — the
 * existing platform provisions ONE dedicated Keycloak realm PER TENANT
 * (confirmed in the architecture analysis), so there is no single static
 * issuer to configure. This mirrors backend/api's
 * middleware/keycloakVerifier.js step for step:
 *   1. decode (unverified) to read the `iss` claim
 *   2. parse the realm slug out of the issuer URL
 *   3. if it's not the default realm, resolve tenant_id via a READ-ONLY
 *      lookup against the existing platform's tenant_realm table — an
 *      unregistered realm is rejected outright, same as the Node version
 *   4. fetch/cache that realm's JWKS and verify the signature + issuer
 *   5. pull roles out of realm_access.roles
 *
 * Only ever touches the shared platform database via the read-only
 * frsJdbcTemplate (see FrsReadOnlyDataSourceConfig) — never writes.
 */
public class KeycloakAuthFilter extends OncePerRequestFilter {

    private static final Pattern REALM_PATTERN = Pattern.compile("/realms/([^/]+)");
    private static final Set<String> DEFAULT_ALLOWED_AUDIENCES = Set.of("account");

    private final JdbcTemplate frsJdbcTemplate;
    private final TransportScopeResolver scopeResolver;
    private final String keycloakBaseUrl;
    private final String defaultRealm;
    private final String expectedAudience;
    private final ObjectMapper objectMapper = new ObjectMapper();
    // Keyed by the observed issuer string (not realm slug) — see buildDecoder's comment for why.
    private final Map<String, JwtDecoder> decoderCache = new ConcurrentHashMap<>();

    public KeycloakAuthFilter(JdbcTemplate frsJdbcTemplate, TransportScopeResolver scopeResolver,
                               String keycloakBaseUrl, String defaultRealm, String expectedAudience) {
        this.frsJdbcTemplate = frsJdbcTemplate;
        this.scopeResolver = scopeResolver;
        this.keycloakBaseUrl = keycloakBaseUrl;
        this.defaultRealm = defaultRealm;
        this.expectedAudience = expectedAudience;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String authHeader = request.getHeader("Authorization");
        if (authHeader == null || !authHeader.startsWith("Bearer ")) {
            reject(response, "missing_auth_header");
            return;
        }
        String token = authHeader.substring(7);

        String issuer;
        try {
            issuer = peekIssuer(token);
        } catch (Exception e) {
            reject(response, "invalid_token");
            return;
        }
        if (issuer == null) {
            reject(response, "invalid_token");
            return;
        }

        Matcher matcher = REALM_PATTERN.matcher(issuer);
        if (!matcher.find()) {
            reject(response, "invalid_issuer_format");
            return;
        }
        String realmSlug = matcher.group(1);

        UUID tenantId;
        if (!realmSlug.equals(defaultRealm)) {
            try {
                tenantId = frsJdbcTemplate.queryForObject(
                        "SELECT fk_tenant_id FROM tenant_realm WHERE realm_slug = ?",
                        UUID.class, realmSlug);
            } catch (org.springframework.dao.EmptyResultDataAccessException e) {
                reject(response, "realm_not_registered");
                return;
            }
        } else {
            tenantId = null; // resolved from the verified token's own tenant_id claim below
        }

        Jwt jwt;
        try {
            JwtDecoder decoder = decoderCache.computeIfAbsent(issuer, iss -> buildDecoder(realmSlug, iss));
            jwt = decoder.decode(token);
        } catch (JwtException e) {
            reject(response, "invalid_token_signature");
            return;
        }

        List<String> audience = jwt.getAudience() == null ? List.of() : jwt.getAudience();
        boolean audienceOk = audience.contains(expectedAudience) || audience.stream().anyMatch(DEFAULT_ALLOWED_AUDIENCES::contains);
        if (!audience.isEmpty() && !audienceOk) {
            reject(response, "audience_mismatch");
            return;
        }

        if (tenantId == null) {
            String claimTenantId = jwt.getClaimAsString("tenant_id");
            tenantId = claimTenantId != null ? UUID.fromString(claimTenantId) : null;
        }

        List<String> roles = extractRealmRoles(jwt);
        TransportScope scope = scopeResolver.resolve(tenantId, jwt.getSubject(), roles);

        UserPrincipal principal = new UserPrincipal(
                jwt.getSubject(), tenantId, realmSlug, roles, jwt.getClaimAsString("email"), scope);

        List<SimpleGrantedAuthority> authorities = new ArrayList<>();
        for (String role : roles) {
            authorities.add(new SimpleGrantedAuthority("ROLE_" + role));
        }

        var authentication = new UsernamePasswordAuthenticationToken(principal, null, authorities);
        SecurityContextHolder.getContext().setAuthentication(authentication);

        chain.doFilter(request, response);
    }

    @SuppressWarnings("unchecked")
    private List<String> extractRealmRoles(Jwt jwt) {
        Map<String, Object> realmAccess = jwt.getClaim("realm_access");
        if (realmAccess == null) return List.of();
        Object roles = realmAccess.get("roles");
        if (roles instanceof List<?> list) {
            return (List<String>) list;
        }
        return List.of();
    }

    /**
     * jwksUri is always built from keycloakBaseUrl (the trusted, pre-configured
     * deployment) — never from the token's own claimed issuer host, which
     * would let a forged issuer redirect this fetch to an attacker-controlled
     * server. The realm slug is only trusted for this because it was already
     * validated against tenant_realm before this method is ever called (see
     * doFilterInternal) — the same trust boundary keycloakVerifier.js relies
     * on (env.keycloak.url + realmSlug, never decoded.iss's host).
     *
     * issuer, in contrast, is the token's own observed `iss` value, used only
     * to satisfy JwtValidators.createDefaultWithIssuer's self-consistency
     * check (the claim matches itself) — NOT reconstructed from
     * keycloakBaseUrl. Keycloak's real-world token issuer is the external,
     * browser-facing URL (e.g. https://dev-frs.motivitylabs.com/auth/realms/X),
     * which is not necessarily equal to keycloakBaseUrl (this service's
     * internal loopback address, e.g. http://localhost:9090/auth) — mirrors
     * keycloakVerifier.js's `issuer: decoded.iss`, which never assumes those
     * two are the same string. A real 401 in production traced to exactly
     * this divergence: every request to a real tenant's realm failed
     * "invalid_token_signature" because this method used to reconstruct an
     * issuer from keycloakBaseUrl and compare it against the token's real
     * (external) issuer — a guaranteed mismatch for every realm, not just
     * one, that the fake-JWKS-server tests never caught because the test
     * issuer was set to equal keycloakBaseUrl by construction.
     */
    private JwtDecoder buildDecoder(String realmSlug, String issuer) {
        String jwksUri = keycloakBaseUrl + "/realms/" + realmSlug + "/protocol/openid-connect/certs";
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withJwkSetUri(jwksUri).build();
        decoder.setJwtValidator(JwtValidators.createDefaultWithIssuer(issuer));
        return decoder;
    }

    /** Decodes the JWT payload without verifying its signature, purely to read `iss` (needed to pick the realm/JWKS). */
    private String peekIssuer(String token) throws Exception {
        String[] parts = token.split("\\.");
        if (parts.length < 2) return null;
        byte[] payloadBytes = Base64.getUrlDecoder().decode(parts[1]);
        JsonNode payload = objectMapper.readTree(payloadBytes);
        JsonNode iss = payload.get("iss");
        return iss != null ? iss.asText() : null;
    }

    private void reject(HttpServletResponse response, String errorCode) throws IOException {
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType("application/json");
        response.getWriter().write("{\"error\":\"" + errorCode + "\"}");
    }
}
