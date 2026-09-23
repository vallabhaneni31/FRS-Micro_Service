package com.motivity.transport.service;

import java.util.UUID;

/**
 * v1 implementation (LocalFilesystemStorageService) writes to local disk —
 * see the plan's "Photo storage v1" note. Kept as an interface so a future
 * S3-backed implementation is a drop-in swap: nothing that calls this
 * interface (EnrollmentService, PassengerMatchingService, the device photo
 * upload endpoint) needs to change when that happens.
 */
public interface TransportStorageService {

    String store(String key, byte[] bytes, String contentType);

    byte[] retrieve(String key);

    void delete(String key);

    boolean exists(String key);

    static String eventPhotoKey(UUID tenantId, UUID busId) {
        return "events/%s/%s/%s.jpg".formatted(tenantId, busId, UUID.randomUUID());
    }

    static String enrollmentPhotoKey(UUID tenantId, UUID passengerId, String angle) {
        return "enrollment/%s/%s/%s-%s.jpg".formatted(tenantId, passengerId, angle, UUID.randomUUID());
    }
}
