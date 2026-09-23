-- Migration 002: FRS Visitor & Unknown Person Management (Consolidated)
-- Target Database: PostgreSQL

BEGIN;

-- 1. Unified person table containing all types (visitor, unknown)
CREATE TABLE IF NOT EXISTS public.person (
    person_id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    person_type character varying(20) NOT NULL, -- 'visitor', 'unknown', or 'employee'
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT person_pkey PRIMARY KEY (person_id),
    CONSTRAINT person_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.frs_tenant(pk_tenant_id) ON DELETE CASCADE
);

-- Alter table to add missing fields if they don't exist
ALTER TABLE public.person ADD COLUMN IF NOT EXISTS full_name character varying(255);
ALTER TABLE public.person ADD COLUMN IF NOT EXISTS phone character varying(50);
ALTER TABLE public.person ADD COLUMN IF NOT EXISTS email character varying(255);
ALTER TABLE public.person ADD COLUMN IF NOT EXISTS organization character varying(255);
ALTER TABLE public.person ADD COLUMN IF NOT EXISTS designation character varying(255);
ALTER TABLE public.person ADD COLUMN IF NOT EXISTS photo_url text;

-- Visitor Fields (nullable)
ALTER TABLE public.person ADD COLUMN IF NOT EXISTS visitor_type character varying(50);
ALTER TABLE public.person ADD COLUMN IF NOT EXISTS host_employee_id bigint;
ALTER TABLE public.person ADD COLUMN IF NOT EXISTS visit_purpose text;
ALTER TABLE public.person ADD COLUMN IF NOT EXISTS valid_from timestamp with time zone;
ALTER TABLE public.person ADD COLUMN IF NOT EXISTS valid_to timestamp with time zone;

-- Unknown Fields (nullable)
ALTER TABLE public.person ADD COLUMN IF NOT EXISTS first_seen timestamp with time zone DEFAULT now();
ALTER TABLE public.person ADD COLUMN IF NOT EXISTS last_seen timestamp with time zone DEFAULT now();
ALTER TABLE public.person ADD COLUMN IF NOT EXISTS visit_count integer DEFAULT 1;
ALTER TABLE public.person ADD COLUMN IF NOT EXISTS risk_score double precision DEFAULT 0.0;

-- Backfill full_name for existing records if null
UPDATE public.person SET full_name = 'Unknown Person' WHERE full_name IS NULL;

-- Now make full_name NOT NULL as required by the schema design
ALTER TABLE public.person ALTER COLUMN full_name SET NOT NULL;

-- Add/ensure constraints
ALTER TABLE public.person DROP CONSTRAINT IF EXISTS person_type_check;
ALTER TABLE public.person ADD CONSTRAINT person_type_check CHECK ((person_type)::text = ANY (ARRAY['visitor'::text, 'unknown'::text, 'employee'::text]));

ALTER TABLE public.person DROP CONSTRAINT IF EXISTS person_status_check;
ALTER TABLE public.person ADD CONSTRAINT person_status_check CHECK ((status)::text = ANY (ARRAY['active'::text, 'inactive'::text, 'archived'::text]));

ALTER TABLE public.person DROP CONSTRAINT IF EXISTS person_host_fkey;
ALTER TABLE public.person ADD CONSTRAINT person_host_fkey FOREIGN KEY (host_employee_id) REFERENCES public.hr_employee(pk_employee_id) ON DELETE SET NULL;


-- 2. Face embedding table (supports pgvector, compatible with FIX-021 encryption)
CREATE TABLE IF NOT EXISTS public.person_face_embeddings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    person_id uuid NOT NULL,
    embedding public.vector(512) NOT NULL,
    model_version character varying(50) DEFAULT 'arcface-r50-fp16'::character varying NOT NULL,
    quality_score double precision,
    photo_path text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    encrypted_embedding text,
    embedding_key_id character varying(32) DEFAULT 'v1'::character varying,
    embedding_encrypted_at timestamp with time zone,
    
    CONSTRAINT person_face_embeddings_pkey PRIMARY KEY (id),
    CONSTRAINT person_face_embeddings_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.person(person_id) ON DELETE CASCADE
);

-- Comments for FIX-021 compliance auditing
COMMENT ON COLUMN public.person_face_embeddings.encrypted_embedding IS 'FIX-021: AES-256-GCM encrypted face embedding; format = base64(iv[12] || ciphertext || authTag[16])';
COMMENT ON COLUMN public.person_face_embeddings.embedding_key_id IS 'FIX-021: Key version used to encrypt this row — enables key rotation';

-- 3. Approximate Nearest Neighbor Index (HNSW for pgvector cosine distance)
CREATE INDEX IF NOT EXISTS idx_person_face_hnsw ON public.person_face_embeddings 
USING hnsw (embedding public.vector_cosine_ops) 
WITH (m='16', ef_construction='64');

-- 4. Add foreign key linking device events to the central person table for sightings timelines
DO $$ 
BEGIN 
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name='device_events' AND column_name='fk_person_id'
  ) THEN
    ALTER TABLE public.device_events ADD COLUMN fk_person_id uuid;
    ALTER TABLE public.device_events ADD CONSTRAINT device_events_person_id_fkey 
      FOREIGN KEY (fk_person_id) REFERENCES public.person(person_id) ON DELETE SET NULL;
  END IF;
END $$;

-- 5. Seed the new sidebar navigation item 'visitors' (labeled 'People/Visitors')
INSERT INTO public.nav_item (role_name, item_key, label, icon, sort_order, is_active, vertical)
VALUES
  ('site_admin',   'visitors', 'People/Visitors', 'Users', 16, true, 'corporate'),
  ('tenant_admin', 'visitors', 'People/Visitors', 'Users', 16, true, 'corporate'),
  ('hr_manager',   'visitors', 'People/Visitors', 'Users', 16, true, 'corporate')
ON CONFLICT (role_name, item_key) DO NOTHING;

-- 6. Seed the RBAC permissions required for the visitor feature APIs
INSERT INTO public.rbac_permission (permission_code, category, display_name, description, is_scope_aware)
VALUES
  ('people.read',      'visitors', 'View Visitors/Unknowns Directory', 'View Visitors and Unknown People directory', true),
  ('visitors.write',   'visitors', 'Register & Edit Visitors', 'Register and edit visitor profiles', true),
  ('visitors.convert', 'visitors', 'Convert Unknown to Visitor', 'Convert unknown person to visitor', true)
ON CONFLICT (permission_code) DO NOTHING;

COMMIT;
