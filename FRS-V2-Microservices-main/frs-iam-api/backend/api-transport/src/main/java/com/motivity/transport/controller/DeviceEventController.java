package com.motivity.transport.controller;

import com.motivity.transport.dto.BatchEventResult;
import com.motivity.transport.dto.DeviceEventBatchRequest;
import com.motivity.transport.dto.DeviceEventBatchResponse;
import com.motivity.transport.dto.DeviceEventRequest;
import com.motivity.transport.dto.DeviceEventResponse;
import com.motivity.transport.dto.DevicePhotoUploadResponse;
import com.motivity.transport.exception.DeviceMismatchException;
import com.motivity.transport.kafka.TransportDeviceEventMessage;
import com.motivity.transport.kafka.TransportEventProducer;
import com.motivity.transport.repository.TransportDeviceRepository;
import com.motivity.transport.security.DevicePrincipal;
import com.motivity.transport.service.TransportStorageService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Only ever reached via the "device" SecurityFilterChain wired in 2c
 * (SecurityConfig) — DeviceAuthFilter has already verified the caller's
 * per-device secret JWT and populated a DevicePrincipal before any of these
 * methods run.
 *
 * events / events/batch: auth → validate → publish → 202. No DB write on
 * this path — the worker (phase 2e) does that, off the request thread.
 * heartbeat: the one deliberate exception (see TransportDeviceRepository)
 * — a direct, synchronous state update, matching how the existing platform
 * treats device heartbeats.
 */
@RestController
@RequestMapping("/api/transport/devices/{deviceId}")
public class DeviceEventController {

    private static final int MAX_BATCH_EVENTS = 100;

    private final TransportEventProducer producer;
    private final TransportDeviceRepository deviceRepository;
    private final TransportStorageService storageService;

    public DeviceEventController(TransportEventProducer producer, TransportDeviceRepository deviceRepository,
                                  TransportStorageService storageService) {
        this.producer = producer;
        this.deviceRepository = deviceRepository;
        this.storageService = storageService;
    }

    @PostMapping("/events")
    public ResponseEntity<DeviceEventResponse> postEvent(@PathVariable UUID deviceId,
                                                           @Valid @RequestBody DeviceEventRequest request,
                                                           Authentication authentication) {
        DevicePrincipal principal = requireMatchingPrincipal(deviceId, authentication);

        UUID eventUid = UUID.randomUUID();
        Instant receivedAt = Instant.now();
        producer.publish(toMessage(principal, eventUid, receivedAt, request));

        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .body(new DeviceEventResponse(true, eventUid, receivedAt, "queued"));
    }

    @PostMapping("/events/batch")
    public ResponseEntity<?> postBatch(@PathVariable UUID deviceId,
                                        @Valid @RequestBody DeviceEventBatchRequest request,
                                        Authentication authentication) {
        DevicePrincipal principal = requireMatchingPrincipal(deviceId, authentication);

        if (request.events().size() > MAX_BATCH_EVENTS) {
            return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE).body(Map.of(
                    "error", "batch_too_large",
                    "message", "batch exceeds max of " + MAX_BATCH_EVENTS + " events",
                    "max", MAX_BATCH_EVENTS
            ));
        }

        Instant receivedAt = Instant.now();
        List<BatchEventResult> results = new ArrayList<>();
        int index = 0;
        for (DeviceEventRequest event : request.events()) {
            UUID eventUid = UUID.randomUUID();
            producer.publish(toMessage(principal, eventUid, receivedAt, event));
            results.add(new BatchEventResult(index++, eventUid, "queued", null));
        }

        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .body(new DeviceEventBatchResponse(true, results.size(), results));
    }

    // Direct upload — v1 photo storage is local disk, not S3, so there's no
    // presigned-URL step to generate first (see TransportStorageService).
    // The device PUTs/POSTs its raw JPEG bytes here and gets a photoKey back
    // to include on its next /events call.
    @PostMapping(value = "/photos", consumes = MediaType.ALL_VALUE)
    public ResponseEntity<DevicePhotoUploadResponse> postPhoto(@PathVariable UUID deviceId,
                                                                 @RequestBody byte[] photoBytes,
                                                                 Authentication authentication) {
        DevicePrincipal principal = requireMatchingPrincipal(deviceId, authentication);
        if (photoBytes == null || photoBytes.length == 0) {
            throw new IllegalArgumentException("photo body is required");
        }
        String key = TransportStorageService.eventPhotoKey(principal.tenantId(), principal.busId());
        storageService.store(key, photoBytes, "image/jpeg");
        return ResponseEntity.status(HttpStatus.CREATED).body(new DevicePhotoUploadResponse(key));
    }

    @PostMapping("/heartbeat")
    @Transactional
    public ResponseEntity<Map<String, Object>> heartbeat(@PathVariable UUID deviceId, Authentication authentication) {
        DevicePrincipal principal = requireMatchingPrincipal(deviceId, authentication);
        deviceRepository.updateLastHeartbeat(principal.deviceId(), OffsetDateTime.now());
        return ResponseEntity.ok(Map.of("success", true, "status", "ok"));
    }

    private DevicePrincipal requireMatchingPrincipal(UUID urlDeviceId, Authentication authentication) {
        DevicePrincipal principal = (DevicePrincipal) authentication.getPrincipal();
        if (!principal.deviceId().equals(urlDeviceId)) {
            throw new DeviceMismatchException();
        }
        return principal;
    }

    private TransportDeviceEventMessage toMessage(DevicePrincipal principal, UUID eventUid, Instant receivedAt, DeviceEventRequest request) {
        return new TransportDeviceEventMessage(
                eventUid,
                principal.tenantId(),
                principal.busId(),
                principal.deviceId(),
                request.eventType().name(),
                request.personRef(),
                request.faceData() != null ? request.faceData().confidence() : null,
                request.photoKey(),
                request.timestamp(),
                receivedAt
        );
    }
}
