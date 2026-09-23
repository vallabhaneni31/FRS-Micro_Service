-- Migration 027: Add lockout_duration_minutes to public.tenant_realm
ALTER TABLE public.tenant_realm ADD COLUMN IF NOT EXISTS lockout_duration_minutes integer DEFAULT 15 NOT NULL;
