-- Migration 003: Visitor Remote Enrollment & Biometric Consent Support
BEGIN;

-- 1. Make fk_employee_id nullable on enrollment_invitations, add fk_person_id referencing person
ALTER TABLE public.enrollment_invitations ALTER COLUMN fk_employee_id DROP NOT NULL;
ALTER TABLE public.enrollment_invitations ADD COLUMN IF NOT EXISTS fk_person_id uuid REFERENCES public.person(person_id) ON DELETE CASCADE;

-- 2. Make fk_employee_id nullable on biometric_consent, add fk_person_id referencing person
ALTER TABLE public.biometric_consent ALTER COLUMN fk_employee_id DROP NOT NULL;
ALTER TABLE public.biometric_consent ADD COLUMN IF NOT EXISTS fk_person_id uuid REFERENCES public.person(person_id) ON DELETE CASCADE;

-- 3. Add consent tracking columns to public.person
ALTER TABLE public.person ADD COLUMN IF NOT EXISTS consent_given_at timestamp with time zone;
ALTER TABLE public.person ADD COLUMN IF NOT EXISTS consent_withdrawn_at timestamp with time zone;
ALTER TABLE public.person ADD COLUMN IF NOT EXISTS consent_method character varying(32);

COMMIT;
