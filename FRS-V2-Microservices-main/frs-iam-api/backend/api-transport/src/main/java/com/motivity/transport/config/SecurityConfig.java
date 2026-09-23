package com.motivity.transport.config;

import com.motivity.transport.repository.TransportDeviceRepository;
import com.motivity.transport.security.DeviceAuthFilter;
import com.motivity.transport.security.KeycloakAuthFilter;
import com.motivity.transport.security.TransportScopeResolver;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

/**
 * Three filter chains, evaluated in @Order — the first whose securityMatcher
 * matches a request handles it exclusively:
 *
 *   0. /api/health, /actuator/**            — open, no auth
 *   1. /api/transport/devices/{id}/{events,events/batch,heartbeat,photo-upload-url}
 *                                            — DeviceAuthFilter (per-device secret JWT)
 *   2. /api/transport/**  (everything else) — KeycloakAuthFilter (human/browser)
 *
 * Chain 1's patterns are deliberately specific (device self-service only) so
 * a future human-facing "GET/POST /api/transport/devices" management
 * endpoint — no trailing /events segment — correctly falls through to
 * chain 2 instead of requiring a device credential.
 *
 * Scoped to /api/transport/** rather than a catch-all "/**": every real
 * endpoint this service will ever expose lives under that prefix (plus
 * health/actuator, covered by chain 0) — revisit if that stops being true
 * once phase 2f's full route surface exists.
 */
@Configuration
@EnableMethodSecurity // enables @PreAuthorize("@transportAuthz.has(...)") on phase 2f's management controllers
public class SecurityConfig {

    private final TransportDeviceRepository deviceRepository;
    private final JdbcTemplate frsJdbcTemplate;
    private final TransportScopeResolver scopeResolver;

    @Value("${keycloak.url}")
    private String keycloakUrl;

    @Value("${keycloak.realm}")
    private String defaultRealm;

    @Value("${keycloak.audience:attendance-api}")
    private String expectedAudience;

    public SecurityConfig(TransportDeviceRepository deviceRepository,
                           @Qualifier("frsJdbcTemplate") JdbcTemplate frsJdbcTemplate,
                           TransportScopeResolver scopeResolver) {
        this.deviceRepository = deviceRepository;
        this.frsJdbcTemplate = frsJdbcTemplate;
        this.scopeResolver = scopeResolver;
    }

    @Bean
    @Order(0)
    public SecurityFilterChain publicChain(HttpSecurity http) throws Exception {
        http.securityMatcher("/api/health", "/actuator/**")
                .csrf(csrf -> csrf.disable())
                .sessionManagement(sm -> sm.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
        return http.build();
    }

    @Bean
    @Order(1)
    public SecurityFilterChain deviceChain(HttpSecurity http) throws Exception {
        http.securityMatcher(
                        "/api/transport/devices/*/events",
                        "/api/transport/devices/*/events/batch",
                        "/api/transport/devices/*/heartbeat",
                        "/api/transport/devices/*/photo-upload-url",
                        "/api/transport/devices/*/photos")
                .csrf(csrf -> csrf.disable())
                .sessionManagement(sm -> sm.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .addFilterBefore(new DeviceAuthFilter(deviceRepository), UsernamePasswordAuthenticationFilter.class)
                .authorizeHttpRequests(auth -> auth.anyRequest().authenticated());
        return http.build();
    }

    @Bean
    @Order(2)
    public SecurityFilterChain userChain(HttpSecurity http) throws Exception {
        http.securityMatcher("/api/transport/**")
                .csrf(csrf -> csrf.disable())
                .sessionManagement(sm -> sm.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .addFilterBefore(
                        new KeycloakAuthFilter(frsJdbcTemplate, scopeResolver, keycloakUrl, defaultRealm, expectedAudience),
                        UsernamePasswordAuthenticationFilter.class)
                .authorizeHttpRequests(auth -> auth.anyRequest().authenticated());
        return http.build();
    }
}
