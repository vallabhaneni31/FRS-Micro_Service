-- V4__add_passenger_face_embeddings.sql
-- Track B face enrollment. pgvector confirmed available (default_version
-- 0.5.1) but not yet enabled in this database — same physical Postgres
-- instance as attendance_intelligence, which already has it enabled, but
-- CREATE EXTENSION is per-database.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE passenger_face_embeddings (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL,
    passenger_id   UUID NOT NULL REFERENCES passengers(id) ON DELETE CASCADE,
    embedding      vector(512) NOT NULL,
    model_version  VARCHAR(50) NOT NULL DEFAULT 'insightface-buffalo_sc',
    quality_score  DOUBLE PRECISION,
    angle          VARCHAR(20) NOT NULL CHECK (angle IN ('front', 'left', 'right', 'up', 'down', 'left_up', 'right_up', 'up_deep')),
    photo_key      VARCHAR(500),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_passenger_face_embeddings_tenant_passenger ON passenger_face_embeddings (tenant_id, passenger_id);

-- Cosine-similarity matching index — same shape as attendance_intelligence's
-- employee_face_embeddings, a fresh table in this isolated database, no
-- connection to that one.
CREATE INDEX idx_passenger_face_hnsw ON passenger_face_embeddings
    USING hnsw (embedding vector_cosine_ops) WITH (m = '16', ef_construction = '64');

-- Boarding events gain a nullable resolved-identity column (Phase 5 wires
-- the matching pipeline that fills it in). Nullable on purpose — an
-- unmatched event is expected and must not block occupancy counting.
ALTER TABLE boarding_events ADD COLUMN passenger_id UUID REFERENCES passengers(id);
CREATE INDEX idx_boarding_events_tenant_passenger_time ON boarding_events (tenant_id, passenger_id, event_time);
