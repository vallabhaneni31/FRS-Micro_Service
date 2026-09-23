-- Migration 009: Search history (PERF-0005)
-- Records WHICH SEARCH an operator ran, so the UI can offer "recent searches".
--
-- Stores query CRITERIA ONLY (never result rows, face ids, embeddings or photos),
-- which keeps this table out of GDPR Art.9 special-category territory and off the
-- DPIA's encryption-at-rest obligations.
--
-- tenant_id is TEXT rather than UUID because super_admin activity is recorded under
-- the literal '_platform' bucket (see spec §4.3); a CHECK enforces uuid-or-_platform
-- so no arbitrary client-supplied value can land here.

BEGIN;

CREATE TABLE IF NOT EXISTS public.search_history (
  pk_search_id  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT        NOT NULL,
  fk_user_id    BIGINT      NOT NULL REFERENCES public.frs_user(pk_user_id) ON DELETE CASCADE,
  params        JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT search_history_tenant_id_check CHECK (
    tenant_id = '_platform'
    OR tenant_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
);

-- Primary access path: "this user's recent searches, newest first".
CREATE INDEX IF NOT EXISTS search_history_tenant_user_created_idx
  ON public.search_history (tenant_id, fk_user_id, created_at DESC);

-- Retention sweep (dataRetentionCron) scans by age across all tenants.
CREATE INDEX IF NOT EXISTS search_history_created_at_idx
  ON public.search_history (created_at);

COMMIT;
