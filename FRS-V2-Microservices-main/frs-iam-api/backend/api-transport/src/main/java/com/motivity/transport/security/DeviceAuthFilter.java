package com.motivity.transport.security;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.motivity.transport.entity.TransportDevice;
import com.motivity.transport.repository.TransportDeviceRepository;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

import javax.crypto.SecretKey;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Per-device secret JWT verification — only wired onto the device event
 * ingestion paths (see SecurityConfig). Mirrors the existing platform's
 * device auth exactly: api-retail/src/middleware/authenticateDevice.js
 * decodes the token first (unverified) to find which device it claims to
 * be, looks up THAT device's own row for its signing secret, then verifies
 * the signature with it — not a single shared platform secret. Same
 * two-step shape here: peekDeviceId() decodes without verifying (there's no
 * key yet to verify with), then the real verification happens once the
 * device's own secret is in hand.
 */
public class DeviceAuthFilter extends OncePerRequestFilter {

    private final TransportDeviceRepository deviceRepository;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public DeviceAuthFilter(TransportDeviceRepository deviceRepository) {
        this.deviceRepository = deviceRepository;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String authHeader = request.getHeader("Authorization");
        if (authHeader == null || !authHeader.startsWith("Bearer ")) {
            reject(response, "missing_device_token");
            return;
        }
        String token = authHeader.substring(7);

        UUID deviceId;
        try {
            deviceId = peekDeviceId(token);
        } catch (Exception e) {
            reject(response, "invalid_device_token");
            return;
        }
        if (deviceId == null) {
            reject(response, "invalid_device_token");
            return;
        }

        Optional<TransportDevice> deviceOpt = deviceRepository.findById(deviceId);
        if (deviceOpt.isEmpty()) {
            reject(response, "device_not_found");
            return;
        }
        TransportDevice device = deviceOpt.get();
        if (device.getDecommissionedAt() != null) {
            reject(response, "device_decommissioned");
            return;
        }

        try {
            Jwts.parser()
                    .verifyWith(hmacKey(device.getDeviceSecret()))
                    .build()
                    .parseSignedClaims(token);
        } catch (JwtException | IllegalArgumentException e) {
            reject(response, "device_auth_failed");
            return;
        }

        DevicePrincipal principal = new DevicePrincipal(
                device.getId(), device.getTenantId(), device.getBusId(), device.getDeviceCode());
        var authentication = new UsernamePasswordAuthenticationToken(
                principal, null, List.of(new SimpleGrantedAuthority("ROLE_DEVICE")));
        SecurityContextHolder.getContext().setAuthentication(authentication);

        chain.doFilter(request, response);
    }

    /** Decodes the JWT payload without verifying its signature, purely to read `sub` (the device id). */
    private UUID peekDeviceId(String token) throws Exception {
        String[] parts = token.split("\\.");
        if (parts.length < 2) return null;
        byte[] payloadBytes = Base64.getUrlDecoder().decode(parts[1]);
        JsonNode payload = objectMapper.readTree(payloadBytes);
        JsonNode sub = payload.get("sub");
        if (sub == null) return null;
        return UUID.fromString(sub.asText());
    }

    private SecretKey hmacKey(String secret) {
        return Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8));
    }

    private void reject(HttpServletResponse response, String errorCode) throws IOException {
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType("application/json");
        response.getWriter().write("{\"error\":\"" + errorCode + "\"}");
    }
}
