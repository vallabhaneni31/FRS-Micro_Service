package com.motivity.transport.service;

import com.motivity.transport.entity.Passenger;
import com.motivity.transport.entity.PassengerFaceEmbedding;
import com.motivity.transport.repository.PassengerFaceEmbeddingRepository;
import com.motivity.transport.security.TransportScope;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Admin-facing photo enrollment — distinct from PassengerMatchingService
 * (which resolves an already-enrolled passenger's identity from a boarding
 * event photo). A Route Manager/Operations Manager uploads a passenger's
 * photo directly through this authenticated API; no invite/consent/approval
 * workflow (see the plan's "What gets reused vs. rebuilt" table for why).
 */
@Service
public class EnrollmentService {

    // Exact match to the pose-validation slugs already built into
    // face_quality_service.py's combine_score() — no adaptation needed.
    static final Set<String> VALID_ANGLES = Set.of(
            "front", "left", "right", "up", "down", "left_up", "right_up", "up_deep");

    private final PassengerService passengerService;
    private final PassengerFaceEmbeddingRepository embeddingRepository;
    private final TransportStorageService storageService;
    private final FaceEmbeddingClient faceEmbeddingClient;

    public EnrollmentService(PassengerService passengerService, PassengerFaceEmbeddingRepository embeddingRepository,
                              TransportStorageService storageService, FaceEmbeddingClient faceEmbeddingClient) {
        this.passengerService = passengerService;
        this.embeddingRepository = embeddingRepository;
        this.storageService = storageService;
        this.faceEmbeddingClient = faceEmbeddingClient;
    }

    @Transactional
    public void enrollPhoto(TransportScope scope, UUID passengerId, byte[] photoBytes, String angle) {
        if (angle == null || !VALID_ANGLES.contains(angle)) {
            throw new IllegalArgumentException("angle must be one of: " + VALID_ANGLES);
        }
        if (photoBytes == null || photoBytes.length == 0) {
            throw new IllegalArgumentException("photo is required");
        }
        Passenger passenger = passengerService.requireInScope(scope, passengerId);

        // face-quality-svc's own pose-tolerance validation for this exact
        // angle applies here (passing angle through) — a photo that doesn't
        // match the requested pose scores confidence: 0.0, same as "no face
        // detected". Reject at upload time rather than silently storing a
        // garbage embedding row.
        FaceEmbeddingClient.FaceEmbeddingResult result = faceEmbeddingClient.embed(photoBytes, angle);
        if (!result.hasEmbedding() || result.confidence() <= 0.0) {
            throw new IllegalArgumentException(
                    "no usable face detected for angle '" + angle + "' — retake the photo");
        }

        String photoKey = TransportStorageService.enrollmentPhotoKey(scope.tenantId(), passenger.getId(), angle);
        storageService.store(photoKey, photoBytes, "image/jpeg");

        embeddingRepository.insertEmbedding(
                scope.tenantId(), passenger.getId(), EmbeddingLiteral.of(result.embedding()),
                result.modelVersion() != null ? result.modelVersion() : "insightface-buffalo_sc",
                result.confidence(), angle, photoKey);
    }

    public List<PassengerFaceEmbedding> listEmbeddings(TransportScope scope, UUID passengerId) {
        Passenger passenger = passengerService.requireInScope(scope, passengerId);
        return embeddingRepository.findAllByTenantIdAndPassengerId(scope.tenantId(), passenger.getId());
    }

    @Transactional
    public void resetEnrollment(TransportScope scope, UUID passengerId) {
        Passenger passenger = passengerService.requireInScope(scope, passengerId);
        embeddingRepository.deleteAllByTenantIdAndPassengerId(scope.tenantId(), passenger.getId());
    }
}
