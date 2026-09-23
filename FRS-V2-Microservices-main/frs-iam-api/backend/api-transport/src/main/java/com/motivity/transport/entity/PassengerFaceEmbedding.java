package com.motivity.transport.entity;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import org.hibernate.annotations.CreationTimestamp;

import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * Deliberately does NOT map the `embedding` column (vector(512)) — Spring
 * Data JPA has no first-class pgvector support, and this codebase already
 * decided against fighting Hibernate's type system for cases like this (see
 * PassengerFaceEmbeddingRepository — the embedding write and the similarity
 * search are both explicit native queries, casting to ::vector inline).
 * This entity is read/write for every OTHER column via normal JPA, and is
 * what PassengerFaceEmbeddingRepository.findAllByPassengerId returns for
 * listing enrollment metadata (angle/quality/enrolled-at) — never the
 * vector itself.
 */
@Entity
@Table(name = "passenger_face_embeddings")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class PassengerFaceEmbedding {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(name = "passenger_id", nullable = false)
    private UUID passengerId;

    @Column(name = "model_version", nullable = false, length = 50)
    private String modelVersion;

    @Column(name = "quality_score")
    private Double qualityScore;

    @Column(nullable = false, length = 20)
    private String angle;

    @Column(name = "photo_key", length = 500)
    private String photoKey;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;
}
