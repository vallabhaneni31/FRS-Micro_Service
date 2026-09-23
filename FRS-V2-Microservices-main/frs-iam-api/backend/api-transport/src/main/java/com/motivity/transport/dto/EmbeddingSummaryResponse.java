package com.motivity.transport.dto;

import com.motivity.transport.entity.PassengerFaceEmbedding;

import java.time.OffsetDateTime;
import java.util.UUID;

/** Enrollment metadata only — the vector itself is never returned over the API. */
public record EmbeddingSummaryResponse(
        UUID id,
        String angle,
        Double qualityScore,
        String modelVersion,
        OffsetDateTime createdAt
) {
    public static EmbeddingSummaryResponse from(PassengerFaceEmbedding embedding) {
        return new EmbeddingSummaryResponse(
                embedding.getId(), embedding.getAngle(), embedding.getQualityScore(),
                embedding.getModelVersion(), embedding.getCreatedAt());
    }
}
