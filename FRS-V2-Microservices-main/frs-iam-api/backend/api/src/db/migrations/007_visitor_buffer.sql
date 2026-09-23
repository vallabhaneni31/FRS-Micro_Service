-- Migration 007: Visitor Validation Buffer
-- Unmatched faces from edge devices land here first.
-- A background service validates each record against employee data before
-- promoting it to the person table (or dropping it as an employee match).

BEGIN;

CREATE TABLE IF NOT EXISTS public.visitor_buffer (
  pk_buffer_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES public.frs_tenant(pk_tenant_id) ON DELETE CASCADE,
  site_id             INTEGER     REFERENCES public.frs_site(pk_site_id) ON DELETE SET NULL,
  device_code         TEXT        NOT NULL,

  -- Face identity hints sent by the edge device
  tracking_id         TEXT,       -- raw visitor_id / fk_person_id from payload
  person_uuid         UUID,       -- deterministic UUID derived from tracking_id
  photo_url           TEXT,
  confidence          NUMERIC(5,2),
  event_payload       JSONB       NOT NULL,    -- original payload for audit

  -- Lifecycle
  buffered_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status              TEXT        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'employee_match', 'promoted', 'rejected')),
  validated_at        TIMESTAMPTZ,
  validation_note     TEXT,       -- human-readable reason for status change

  -- Result references
  matched_employee_id BIGINT      REFERENCES public.hr_employee(pk_employee_id) ON DELETE SET NULL,
  person_id           UUID        REFERENCES public.person(person_id) ON DELETE SET NULL  -- set on promote
);

-- Fast lookup of pending records due for validation
CREATE INDEX IF NOT EXISTS visitor_buffer_pending_idx
  ON public.visitor_buffer (tenant_id, buffered_at)
  WHERE status = 'pending';

-- Avoid duplicate person creation for the same tracking UUID
CREATE INDEX IF NOT EXISTS visitor_buffer_person_uuid_idx
  ON public.visitor_buffer (person_uuid)
  WHERE person_uuid IS NOT NULL;

COMMIT;
