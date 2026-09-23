-- 013_people_performance_indexes.sql
-- Performance indexes for People & Visitors query performance

CREATE INDEX IF NOT EXISTS idx_pfe_person_id_created 
ON person_face_embeddings (person_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_de_person_occurred 
ON device_events (fk_person_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_person_updated_at 
ON person (updated_at DESC);
