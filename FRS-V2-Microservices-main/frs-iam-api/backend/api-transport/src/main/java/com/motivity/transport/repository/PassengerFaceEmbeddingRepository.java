package com.motivity.transport.repository;

import com.motivity.transport.entity.PassengerFaceEmbedding;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * The embedding column (vector(512)) is never mapped on the entity — see
 * PassengerFaceEmbedding's class comment. Creation and the similarity
 * search are both explicit native queries that cast a pgvector text
 * literal ("[0.1,0.2,...]") to ::vector inline. Every other query here is a
 * plain Spring Data derived query over the mapped columns.
 */
public interface PassengerFaceEmbeddingRepository extends JpaRepository<PassengerFaceEmbedding, UUID> {

    List<PassengerFaceEmbedding> findAllByTenantIdAndPassengerId(UUID tenantId, UUID passengerId);

    long deleteAllByTenantIdAndPassengerId(UUID tenantId, UUID passengerId);

    @Modifying
    @Query(value = "INSERT INTO passenger_face_embeddings " +
            "(id, tenant_id, passenger_id, embedding, model_version, quality_score, angle, photo_key) " +
            "VALUES (gen_random_uuid(), :tenantId, :passengerId, CAST(:embeddingLiteral AS vector), :modelVersion, :qualityScore, :angle, :photoKey)",
            nativeQuery = true)
    void insertEmbedding(@Param("tenantId") UUID tenantId, @Param("passengerId") UUID passengerId,
                          @Param("embeddingLiteral") String embeddingLiteral, @Param("modelVersion") String modelVersion,
                          @Param("qualityScore") Double qualityScore, @Param("angle") String angle,
                          @Param("photoKey") String photoKey);

    // Tenant-wide top-1 cosine-similarity match (design decision: not
    // bus-scoped — a passenger may occasionally board a different bus).
    // 1 - cosine_distance = cosine_similarity, same idiom already proven in
    // attendance_intelligence.employee_face_embeddings.
    @Query(value = "SELECT passenger_id AS passengerId, 1 - (embedding <=> CAST(:embeddingLiteral AS vector)) AS similarity " +
            "FROM passenger_face_embeddings WHERE tenant_id = :tenantId " +
            "ORDER BY embedding <=> CAST(:embeddingLiteral AS vector) LIMIT 1",
            nativeQuery = true)
    Optional<MatchProjection> findBestMatch(@Param("tenantId") UUID tenantId, @Param("embeddingLiteral") String embeddingLiteral);

    interface MatchProjection {
        UUID getPassengerId();
        double getSimilarity();
    }
}
