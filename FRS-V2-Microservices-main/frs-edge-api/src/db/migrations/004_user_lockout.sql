-- Migration 004: User Lockout Support
BEGIN;

-- 1. Add failed_login_attempts and locked_until to public.frs_user
ALTER TABLE public.frs_user ADD COLUMN IF NOT EXISTS failed_login_attempts integer DEFAULT 0 NOT NULL;
ALTER TABLE public.frs_user ADD COLUMN IF NOT EXISTS locked_until timestamp with time zone;

-- 2. Update public.users view to select failed_login_attempts and locked_until from frs_user
CREATE OR REPLACE VIEW public.users AS
 SELECT (pk_user_id)::text AS pk_user_id,
    email,
    username,
    username AS first_name,
    NULL::text AS last_name,
    NULL::text AS phone,
    'keycloak'::text AS sso_provider,
    keycloak_sub AS sso_external_id,
    '{}'::jsonb AS sso_metadata,
    ( SELECT frs_tenant_user_map.fk_tenant_id
           FROM public.frs_tenant_user_map
          WHERE (frs_tenant_user_map.fk_user_id = fu.pk_user_id)
          ORDER BY frs_tenant_user_map.fk_tenant_id
         LIMIT 1) AS home_tenant_id,
    is_active,
    false AS is_verified,
    NULL::timestamp with time zone AS last_login_at,
    failed_login_attempts,
    locked_until,
    'UTC'::text AS timezone,
    'en'::text AS language,
    '{}'::jsonb AS preferences,
    created_at,
    created_at AS updated_at,
    NULL::timestamp with time zone AS deleted_at
   FROM public.frs_user fu;

COMMIT;
