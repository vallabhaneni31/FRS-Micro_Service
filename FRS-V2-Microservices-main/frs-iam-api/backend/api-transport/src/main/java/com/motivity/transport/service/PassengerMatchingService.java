package com.motivity.transport.service;

import com.motivity.transport.repository.PassengerFaceEmbeddingRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.Optional;
import java.util.UUID;

/**
 * Resolves a passenger identity from a boarding-event photo. Called BEFORE
 * TransportEventProcessingService's transactional write (see the plan's
 * design decision #1) — this does two network-ish calls (disk read +
 * face-quality-svc HTTP) that must never hold a DB transaction open.
 *
 * Every failure mode degrades silently to "unmatched" (design decision #2)
 * — occupancy counting must keep working even if the face service is down,
 * the photo is missing, or nothing clears the similarity threshold. This
 * method must never throw.
 */
@Service
public class PassengerMatchingService {

    private static final Logger log = LoggerFactory.getLogger(PassengerMatchingService.class);

    private final TransportStorageService storageService;
    private final FaceEmbeddingClient faceEmbeddingClient;
    private final PassengerFaceEmbeddingRepository embeddingRepository;
    private final double threshold;

    public PassengerMatchingService(TransportStorageService storageService, FaceEmbeddingClient faceEmbeddingClient,
                                     PassengerFaceEmbeddingRepository embeddingRepository,
                                     @Value("${transport.face-matching.threshold:0.50}") double threshold) {
        this.storageService = storageService;
        this.faceEmbeddingClient = faceEmbeddingClient;
        this.embeddingRepository = embeddingRepository;
        this.threshold = threshold;
    }

    public Optional<UUID> resolvePassenger(UUID tenantId, String photoKey) {
        try {
            byte[] photoBytes = storageService.retrieve(photoKey);
            FaceEmbeddingClient.FaceEmbeddingResult result = faceEmbeddingClient.embed(photoBytes, null);
            if (!result.hasEmbedding()) {
                return Optional.empty();
            }
            String literal = EmbeddingLiteral.of(result.embedding());
            return embeddingRepository.findBestMatch(tenantId, literal)
                    .filter(match -> match.getSimilarity() >= threshold)
                    .map(PassengerFaceEmbeddingRepository.MatchProjection::getPassengerId);
        } catch (Exception e) {
            log.warn("Passenger matching failed for tenantId={} photoKey={}: {}", tenantId, photoKey, e.getMessage());
            return Optional.empty();
        }
    }
}
