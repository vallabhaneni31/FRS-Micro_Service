package com.motivity.transport.security;

import com.motivity.transport.entity.Bus;
import com.motivity.transport.entity.TransportDevice;
import com.motivity.transport.repository.BusRepository;
import com.motivity.transport.repository.TransportDeviceRepository;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import jakarta.servlet.FilterChain;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.test.annotation.Rollback;
import org.springframework.transaction.annotation.Transactional;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.Date;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Phase 2c verification. Real device rows written into the isolated
 * transport_intelligence database (safe — our own DB, and rolled back after
 * each test, same discipline as DatabaseLayerSmokeTest from 2b) — no fake
 * server needed here since there's no external dependency to fake: the
 * "authority" for a device credential is a row in our own database.
 */
@SpringBootTest
class DeviceAuthFilterTest {

    private static final String REAL_SECRET = "test-device-secret-0123456789abcdef0123456789ABCDEF";
    private static final String WRONG_SECRET = "wrong-device-secret-fedcba9876543210fedcba9876543210FED";

    @Autowired
    private BusRepository busRepository;

    @Autowired
    private TransportDeviceRepository deviceRepository;

    @AfterEach
    void clearSecurityContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    @Transactional
    @Rollback
    void acceptsAValidDeviceTokenAndAttachesThePrincipal() throws Exception {
        TransportDevice device = persistTestDevice(REAL_SECRET, null);
        String token = signDeviceToken(REAL_SECRET, device.getId().toString());

        var result = runFilter(token);

        assertThat(result.chainCalled).isTrue();
        assertThat(result.response.getStatus()).isEqualTo(200); // default, filter never touched it
        DevicePrincipal principal = (DevicePrincipal) SecurityContextHolder.getContext().getAuthentication().getPrincipal();
        assertThat(principal.deviceId()).isEqualTo(device.getId());
        assertThat(principal.tenantId()).isEqualTo(device.getTenantId());
        assertThat(principal.busId()).isEqualTo(device.getBusId());
    }

    @Test
    @Transactional
    @Rollback
    void rejectsATokenSignedWithTheWrongSecret() throws Exception {
        TransportDevice device = persistTestDevice(REAL_SECRET, null);
        String token = signDeviceToken(WRONG_SECRET, device.getId().toString());

        var result = runFilter(token);

        assertThat(result.chainCalled).isFalse();
        assertThat(result.response.getStatus()).isEqualTo(401);
        assertThat(result.response.getContentAsString()).contains("device_auth_failed");
    }

    @Test
    void rejectsAnUnknownDeviceId() throws Exception {
        String token = signDeviceToken(REAL_SECRET, UUID.randomUUID().toString());

        var result = runFilter(token);

        assertThat(result.chainCalled).isFalse();
        assertThat(result.response.getStatus()).isEqualTo(401);
        assertThat(result.response.getContentAsString()).contains("device_not_found");
    }

    @Test
    @Transactional
    @Rollback
    void rejectsADecommissionedDevice() throws Exception {
        TransportDevice device = persistTestDevice(REAL_SECRET, OffsetDateTime.now());
        String token = signDeviceToken(REAL_SECRET, device.getId().toString());

        var result = runFilter(token);

        assertThat(result.chainCalled).isFalse();
        assertThat(result.response.getStatus()).isEqualTo(401);
        assertThat(result.response.getContentAsString()).contains("device_decommissioned");
    }

    @Test
    void rejectsAMissingAuthorizationHeader() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest();
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicBoolean chainCalled = new AtomicBoolean(false);
        FilterChain chain = (req, res) -> chainCalled.set(true);

        new DeviceAuthFilter(deviceRepository).doFilter(request, response, chain);

        assertThat(chainCalled.get()).isFalse();
        assertThat(response.getStatus()).isEqualTo(401);
        assertThat(response.getContentAsString()).contains("missing_device_token");
    }

    @Test
    void rejectsAMalformedToken() throws Exception {
        var result = runFilter("not.a.jwt");

        assertThat(result.chainCalled).isFalse();
        assertThat(result.response.getStatus()).isEqualTo(401);
    }

    private TransportDevice persistTestDevice(String secret, OffsetDateTime decommissionedAt) {
        UUID tenantId = UUID.randomUUID();
        Bus bus = busRepository.save(Bus.builder()
                .tenantId(tenantId)
                .busCode("SEC-TEST-" + UUID.randomUUID().toString().substring(0, 8))
                .build());
        return deviceRepository.save(TransportDevice.builder()
                .tenantId(tenantId)
                .busId(bus.getId())
                .deviceCode("SEC-TEST-DEVICE-" + UUID.randomUUID().toString().substring(0, 8))
                .deviceSecret(secret)
                .cameraPosition("boarding")
                .decommissionedAt(decommissionedAt)
                .build());
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

    private FilterResult runFilter(String token) throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader("Authorization", "Bearer " + token);
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicBoolean chainCalled = new AtomicBoolean(false);
        FilterChain chain = (req, res) -> chainCalled.set(true);

        new DeviceAuthFilter(deviceRepository).doFilter(request, response, chain);

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
