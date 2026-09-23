--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: prevent_audit_modification(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_audit_modification() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION
    'audit_log records are immutable. Attempted % on row id=%. Contact your DBA.',
    TG_OP, OLD.pk_audit_id;
END;
$$;


--
-- Name: purge_audit_log_for_tenant(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.purge_audit_log_for_tenant(p_tenant_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  EXECUTE 'ALTER TABLE public.audit_log DISABLE TRIGGER audit_log_immutable';
  BEGIN
    DELETE FROM public.audit_log
    WHERE tenant_id = p_tenant_id;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'ALTER TABLE public.audit_log ENABLE TRIGGER audit_log_immutable';
    RAISE;
  END;
  EXECUTE 'ALTER TABLE public.audit_log ENABLE TRIGGER audit_log_immutable';
END;
$$;


--
-- Name: safe_uuid(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.safe_uuid(text) RETURNS uuid
    LANGUAGE plpgsql IMMUTABLE STRICT
    AS $_$
BEGIN
  RETURN $1::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$_$;


--
-- Name: FUNCTION safe_uuid(text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.safe_uuid(text) IS 'FIX-013: Null-safe UUID cast used by RLS policies to avoid crashing when app.tenant_id is unset';


--
-- Name: set_audit_log_hash(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_audit_log_hash() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  last_hash VARCHAR(64);
  payload   TEXT;
BEGIN
  -- Get the most recent hash for this tenant (chain per tenant)
  SELECT row_hash
  INTO last_hash
  FROM audit_log
  WHERE tenant_id IS NOT DISTINCT FROM NEW.tenant_id
  ORDER BY pk_audit_id DESC
  LIMIT 1;

  NEW.prev_hash := COALESCE(last_hash, 'GENESIS');

  -- Build deterministic payload
  payload := COALESCE(NEW.tenant_id::text, 'null')
          || '|' || COALESCE(NEW.action, '')
          || '|' || COALESCE(NEW.fk_user_id::text, 'null')
          || '|' || COALESCE(NEW.ip_address::text, 'null')
          || '|' || COALESCE(NEW.prev_hash, 'GENESIS')
          || '|' || to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');

  NEW.row_hash := encode(digest(payload, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;


--
-- Name: sync_face_enrolled(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_face_enrolled() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE hr_employee
      SET face_enrolled = TRUE
      WHERE pk_employee_id = NEW.employee_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE hr_employee
      SET face_enrolled = (
        EXISTS (
          SELECT 1 FROM employee_face_embeddings
          WHERE employee_id = OLD.employee_id
        )
      )
      WHERE pk_employee_id = OLD.employee_id;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: sync_frs_group_to_groups(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_frs_group_to_groups() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF (TG_OP = 'INSERT') THEN
        INSERT INTO groups (
            pk_group_id, fk_tenant_id, name, description,
            is_admin, is_default, is_active, created_at, updated_at
        ) VALUES (
            NEW.pk_group_id,
            NEW.fk_tenant_id,
            NEW.group_name,
            NEW.description,
            NEW.is_admin_group,
            NEW.is_default,
            NEW.is_active,
            NEW.created_at,
            NEW.updated_at
        ) ON CONFLICT (pk_group_id) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            is_admin = EXCLUDED.is_admin,
            is_default = EXCLUDED.is_default,
            is_active = EXCLUDED.is_active;
    ELSIF (TG_OP = 'UPDATE') THEN
        UPDATE groups SET
            name = NEW.group_name,
            description = NEW.description,
            is_admin = NEW.is_admin_group,
            is_default = NEW.is_default,
            is_active = NEW.is_active,
            updated_at = NEW.updated_at
        WHERE pk_group_id = NEW.pk_group_id;
    ELSIF (TG_OP = 'DELETE') THEN
        DELETE FROM groups WHERE pk_group_id = OLD.pk_group_id;
    END IF;
    RETURN NULL;
END;
$$;


--
-- Name: sync_frs_tenant_to_tenants(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_frs_tenant_to_tenants() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF (TG_OP = 'INSERT') THEN
        INSERT INTO tenants (
            pk_tenant_id, parent_id, root_id, hierarchy_path,
            level, tenant_kind, vertical, name, slug, status, settings
        ) VALUES (
            NEW.pk_tenant_id,
            '00000000-0000-0000-0000-000000000001'::uuid,
            '00000000-0000-0000-0000-000000000001'::uuid,
            '/00000000-0000-0000-0000-000000000001/' || NEW.pk_tenant_id || '/',
            1,
            'customer',
            NEW.vertical,
            NEW.tenant_name,
            LOWER(regexp_replace(NEW.tenant_name, '[^a-zA-Z0-9]+', '-', 'g')),
            'active',
            '{}'::jsonb
        ) ON CONFLICT (pk_tenant_id) DO UPDATE SET
            name = EXCLUDED.name,
            vertical = EXCLUDED.vertical;
    ELSIF (TG_OP = 'UPDATE') THEN
        UPDATE tenants SET
            name = NEW.tenant_name,
            vertical = NEW.vertical
        WHERE pk_tenant_id = NEW.pk_tenant_id;
    ELSIF (TG_OP = 'DELETE') THEN
        DELETE FROM tenants WHERE pk_tenant_id = OLD.pk_tenant_id;
    END IF;
    RETURN NULL;
END;
$$;


--
-- Name: sync_groups_to_frs_group(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_groups_to_frs_group() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF (TG_OP = 'INSERT') THEN
        INSERT INTO frs_group (
            pk_group_id, fk_tenant_id, group_name, description,
            is_admin_group, is_default, is_active, created_at, updated_at
        ) VALUES (
            NEW.pk_group_id,
            NEW.fk_tenant_id,
            NEW.name,
            NEW.description,
            NEW.is_admin,
            NEW.is_default,
            NEW.is_active,
            NEW.created_at,
            NEW.updated_at
        ) ON CONFLICT (pk_group_id) DO UPDATE SET
            group_name = EXCLUDED.group_name,
            description = EXCLUDED.description,
            is_admin_group = EXCLUDED.is_admin_group,
            is_default = EXCLUDED.is_default,
            is_active = EXCLUDED.is_active;
    ELSIF (TG_OP = 'UPDATE') THEN
        UPDATE frs_group SET
            group_name = NEW.name,
            description = NEW.description,
            is_admin_group = NEW.is_admin,
            is_default = NEW.is_default,
            is_active = NEW.is_active,
            updated_at = NEW.updated_at
        WHERE pk_group_id = NEW.pk_group_id;
    ELSIF (TG_OP = 'DELETE') THEN
        DELETE FROM frs_group WHERE pk_group_id = OLD.pk_group_id;
    END IF;
    RETURN NULL;
END;
$$;


--
-- Name: sync_tenants_to_frs_tenant(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_tenants_to_frs_tenant() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF (TG_OP = 'INSERT') THEN
        IF NEW.level = 1 THEN
            INSERT INTO frs_tenant (
                pk_tenant_id, tenant_name, vertical
            ) VALUES (
                NEW.pk_tenant_id,
                NEW.name,
                COALESCE(NEW.vertical, 'corporate')
            ) ON CONFLICT (pk_tenant_id) DO UPDATE SET
                tenant_name = EXCLUDED.tenant_name,
                vertical = EXCLUDED.vertical;
        END IF;
    ELSIF (TG_OP = 'UPDATE') THEN
        IF NEW.level = 1 THEN
            UPDATE frs_tenant SET
                tenant_name = NEW.name,
                vertical = NEW.vertical
            WHERE pk_tenant_id = NEW.pk_tenant_id;
        END IF;
    ELSIF (TG_OP = 'DELETE') THEN
        DELETE FROM frs_tenant WHERE pk_tenant_id = OLD.pk_tenant_id;
    END IF;
    RETURN NULL;
END;
$$;


--
-- Name: tenant_descendants(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tenant_descendants(root_id uuid) RETURNS SETOF uuid
    LANGUAGE sql STABLE
    AS $_$
    SELECT t.pk_tenant_id
      FROM tenants t
     WHERE t.status = 'active'
       AND t.hierarchy_path LIKE (
            (SELECT hierarchy_path FROM tenants WHERE pk_tenant_id = $1)
           ) || '%'
$_$;


--
-- Name: update_enrollment_invitation_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_enrollment_invitation_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: _archived_users_060; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._archived_users_060 (
    pk_user_id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(256) NOT NULL,
    username character varying(128),
    first_name character varying(128),
    last_name character varying(128),
    phone character varying(32),
    sso_provider character varying(64) DEFAULT 'keycloak'::character varying NOT NULL,
    sso_external_id character varying(256) NOT NULL,
    sso_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    home_tenant_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    is_verified boolean DEFAULT false NOT NULL,
    last_login_at timestamp with time zone,
    failed_login_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    timezone character varying(64) DEFAULT 'UTC'::character varying,
    language character varying(8) DEFAULT 'en'::character varying,
    preferences jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: _migration_site_id_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._migration_site_id_map (
    old_site_id_bigint bigint NOT NULL,
    new_tenant_id uuid NOT NULL
);


--
-- Name: ai_bias_evaluations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_bias_evaluations (
    pk_evaluation_id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    evaluation_date date DEFAULT CURRENT_DATE NOT NULL,
    model_version character varying(64),
    threshold_used double precision NOT NULL,
    total_attempts integer DEFAULT 0 NOT NULL,
    total_correct integer DEFAULT 0 NOT NULL,
    overall_accuracy double precision,
    accuracy_male double precision,
    accuracy_female double precision,
    accuracy_unknown_gender double precision,
    accuracy_age_18_30 double precision,
    accuracy_age_31_45 double precision,
    accuracy_age_46_60 double precision,
    accuracy_age_60_plus double precision,
    count_male integer DEFAULT 0,
    count_female integer DEFAULT 0,
    count_age_18_30 integer DEFAULT 0,
    count_age_31_45 integer DEFAULT 0,
    count_age_46_60 integer DEFAULT 0,
    count_age_60_plus integer DEFAULT 0,
    max_accuracy_gap double precision,
    bias_flag boolean DEFAULT false NOT NULL,
    bias_threshold double precision DEFAULT 0.05 NOT NULL,
    sample_period_days integer DEFAULT 30 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    notes text
);


--
-- Name: TABLE ai_bias_evaluations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_bias_evaluations IS 'FIX-036: NIST AI RMF — per-demographic face recognition accuracy for bias detection';


--
-- Name: ai_drift_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_drift_snapshots (
    pk_snapshot_id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    snapshot_date date DEFAULT CURRENT_DATE NOT NULL,
    model_version character varying(64),
    threshold_used double precision NOT NULL,
    window_days integer DEFAULT 7 NOT NULL,
    total_attempts integer DEFAULT 0 NOT NULL,
    total_correct integer DEFAULT 0 NOT NULL,
    accuracy double precision,
    previous_accuracy double precision,
    accuracy_delta double precision,
    drift_flag boolean DEFAULT false NOT NULL,
    drift_threshold double precision DEFAULT 0.03 NOT NULL,
    false_positive_rate double precision,
    false_negative_rate double precision,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    mt_tenant_id uuid
);


--
-- Name: TABLE ai_drift_snapshots; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_drift_snapshots IS 'FIX-037: Weekly AI model drift snapshots — alerts when accuracy drops > 3%';


--
-- Name: attendance_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attendance_events (
    pk_attendance_event_id bigint NOT NULL,
    fk_employee_id bigint,
    fk_device_id uuid,
    fk_original_event_id uuid,
    event_type character varying(50) NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    confidence_score double precision,
    verification_method character varying(50),
    recognition_model_version character varying(50),
    frame_image_url text,
    face_bounding_box jsonb,
    location_zone character varying(120),
    entry_exit_direction character varying(20),
    fk_shift_id bigint,
    is_expected_entry boolean,
    is_on_time boolean,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: attendance_events_pk_attendance_event_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.attendance_events_pk_attendance_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: attendance_events_pk_attendance_event_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.attendance_events_pk_attendance_event_id_seq OWNED BY public.attendance_events.pk_attendance_event_id;


--
-- Name: attendance_record; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attendance_record (
    pk_attendance_id bigint NOT NULL,
    customer_id bigint,
    site_id bigint,
    unit_id bigint,
    fk_employee_id bigint NOT NULL,
    attendance_date date NOT NULL,
    check_in timestamp with time zone,
    check_out timestamp with time zone,
    break_start timestamp with time zone,
    break_end timestamp with time zone,
    status character varying(20) NOT NULL,
    working_hours numeric(8,2) DEFAULT 0 NOT NULL,
    break_duration_minutes integer DEFAULT 0 NOT NULL,
    overtime_hours numeric(8,2) DEFAULT 0 NOT NULL,
    is_late boolean DEFAULT false NOT NULL,
    is_early_departure boolean DEFAULT false NOT NULL,
    device_id character varying(80),
    location_label character varying(180),
    recognition_accuracy numeric(5,2),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    duration_minutes integer,
    tenant_id uuid NOT NULL,
    checkin_photo_url text,
    checkout_photo_url text,
    mt_tenant_id uuid,
    CONSTRAINT attendance_record_status_check CHECK (((status)::text = ANY ((ARRAY['present'::character varying, 'late'::character varying, 'absent'::character varying, 'on-leave'::character varying, 'on-break'::character varying])::text[])))
);


--
-- Name: attendance_record_pk_attendance_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.attendance_record_pk_attendance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: attendance_record_pk_attendance_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.attendance_record_pk_attendance_id_seq OWNED BY public.attendance_record.pk_attendance_id;


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    pk_audit_id bigint NOT NULL,
    customer_id bigint,
    site_id bigint,
    unit_id bigint,
    fk_user_id bigint,
    action character varying(120) NOT NULL,
    details text NOT NULL,
    ip_address character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_agent text,
    method character varying(10),
    entity_type character varying(50),
    entity_id character varying(100),
    entity_name character varying(200),
    before_data jsonb,
    after_data jsonb,
    source character varying(20) DEFAULT 'ui'::character varying,
    user_name character varying(200),
    user_role character varying(50),
    tenant_id uuid NOT NULL,
    mt_tenant_id uuid,
    row_hash character varying(64),
    prev_hash character varying(64)
);


--
-- Name: COLUMN audit_log.row_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_log.row_hash IS 'FIX-007: SHA-256 of key fields — tamper detection';


--
-- Name: COLUMN audit_log.prev_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_log.prev_hash IS 'FIX-007: Hash of the previous row in the chain for this tenant';


--
-- Name: audit_log_pk_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_log_pk_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_pk_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_log_pk_audit_id_seq OWNED BY public.audit_log.pk_audit_id;


--
-- Name: auth_session_token; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_session_token (
    token_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fk_user_id bigint NOT NULL,
    access_token character varying(128) NOT NULL,
    refresh_token character varying(128) NOT NULL,
    access_expires_at timestamp with time zone NOT NULL,
    refresh_expires_at timestamp with time zone NOT NULL,
    revoked boolean DEFAULT false NOT NULL,
    user_agent character varying(512),
    ip_address character varying(45),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: biometric_consent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.biometric_consent (
    pk_consent_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fk_employee_id bigint NOT NULL,
    tenant_id uuid NOT NULL,
    consent_given boolean DEFAULT false NOT NULL,
    consent_version character varying(32) DEFAULT '1.0'::character varying NOT NULL,
    consent_method character varying(32) DEFAULT 'enrollment_portal'::character varying NOT NULL,
    ip_address inet,
    user_agent character varying(500),
    consented_at timestamp with time zone,
    withdrawn_at timestamp with time zone,
    withdrawn_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE biometric_consent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.biometric_consent IS 'FIX-025: GDPR Art.9 / BIPA §15 biometric data processing consent records';


--
-- Name: blacklisted_enrollment_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blacklisted_enrollment_tokens (
    pk_blacklist_id integer NOT NULL,
    token text NOT NULL,
    blacklisted_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: blacklisted_enrollment_tokens_pk_blacklist_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.blacklisted_enrollment_tokens_pk_blacklist_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: blacklisted_enrollment_tokens_pk_blacklist_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.blacklisted_enrollment_tokens_pk_blacklist_id_seq OWNED BY public.blacklisted_enrollment_tokens.pk_blacklist_id;


--
-- Name: completed_report_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.completed_report_runs (
    pk_run_id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    schedule_id uuid,
    name character varying(255) NOT NULL,
    report_type character varying(50) NOT NULL,
    file_format character varying(10) NOT NULL,
    file_path text NOT NULL,
    file_size integer NOT NULL,
    run_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    status character varying(20) DEFAULT 'success'::character varying NOT NULL
);


--
-- Name: device_activation_code; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_activation_code (
    pk_activation_id bigint NOT NULL,
    fk_tenant_id uuid NOT NULL,
    activation_pin character varying(10) NOT NULL,
    token_validity_days integer DEFAULT 365 NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    fk_site_id bigint,
    device_role character varying(100) DEFAULT 'entry_point'::character varying,
    zone_name character varying(100)
);


--
-- Name: device_activation_code_pk_activation_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.device_activation_code_pk_activation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: device_activation_code_pk_activation_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.device_activation_code_pk_activation_id_seq OWNED BY public.device_activation_code.pk_activation_id;


--
-- Name: device_command_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_command_queue (
    pk_command_id integer NOT NULL,
    device_id bigint NOT NULL,
    command_type character varying(50) NOT NULL,
    command_payload jsonb DEFAULT '{}'::jsonb,
    status character varying(20) DEFAULT 'pending'::character varying,
    priority integer DEFAULT 5,
    created_at timestamp with time zone DEFAULT now(),
    created_by bigint,
    expires_at timestamp with time zone,
    executed_at timestamp with time zone,
    result_payload jsonb
);


--
-- Name: device_command_queue_pk_command_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.device_command_queue_pk_command_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: device_command_queue_pk_command_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.device_command_queue_pk_command_id_seq OWNED BY public.device_command_queue.pk_command_id;


--
-- Name: device_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_events (
    pk_event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fk_device_id uuid NOT NULL,
    event_type character varying(50) NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now(),
    processed_at timestamp with time zone,
    processing_status character varying(20) DEFAULT 'pending'::character varying,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    detected_face_embedding jsonb,
    confidence_score double precision,
    frame_url text,
    processing_attempts integer DEFAULT 0,
    processing_error text,
    device_code text,
    tenant_id uuid,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    processed boolean DEFAULT false NOT NULL,
    process_error text,
    mt_tenant_id uuid,
    CONSTRAINT device_events_event_type_check CHECK (((event_type)::text = ANY ((ARRAY['FACE_DETECTED'::character varying, 'MOTION_DETECTED'::character varying, 'EMPLOYEE_ENTRY'::character varying, 'EMPLOYEE_EXIT'::character varying, 'DEVICE_HEARTBEAT'::character varying, 'DEVICE_ERROR'::character varying, 'FRAME_CAPTURED'::character varying])::text[]))),
    CONSTRAINT device_events_processing_status_check CHECK (((processing_status)::text = ANY ((ARRAY['pending'::character varying, 'processing'::character varying, 'completed'::character varying, 'failed'::character varying, 'ignored'::character varying])::text[])))
);


--
-- Name: device_heartbeat; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_heartbeat (
    pk_heartbeat_id bigint NOT NULL,
    device_id bigint NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
    status character varying(20) NOT NULL,
    metrics jsonb DEFAULT '{}'::jsonb,
    ip_address character varying(64),
    response_time_ms integer
);


--
-- Name: device_heartbeat_pk_heartbeat_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.device_heartbeat_pk_heartbeat_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: device_heartbeat_pk_heartbeat_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.device_heartbeat_pk_heartbeat_id_seq OWNED BY public.device_heartbeat.pk_heartbeat_id;


--
-- Name: device_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_status_history (
    pk_history_id bigint NOT NULL,
    device_id bigint NOT NULL,
    old_status character varying(20),
    new_status character varying(20) NOT NULL,
    transition_reason text,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    duration_seconds integer
);


--
-- Name: device_status_history_pk_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.device_status_history_pk_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: device_status_history_pk_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.device_status_history_pk_history_id_seq OWNED BY public.device_status_history.pk_history_id;


--
-- Name: device_token_revocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_token_revocations (
    pk_revocation_id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id bigint NOT NULL,
    jti character varying(64) NOT NULL,
    revoked_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_by bigint,
    reason character varying(255)
);


--
-- Name: TABLE device_token_revocations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.device_token_revocations IS 'FIX-012: Tracks revoked device JWTs so authenticateDevice can reject them immediately';


--
-- Name: device_type; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_type (
    pk_device_type_id integer NOT NULL,
    type_code character varying(50) NOT NULL,
    type_name character varying(100) NOT NULL,
    category character varying(50) NOT NULL,
    manufacturer character varying(100),
    model character varying(100),
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: device_type_pk_device_type_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.device_type_pk_device_type_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: device_type_pk_device_type_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.device_type_pk_device_type_id_seq OWNED BY public.device_type.pk_device_type_id;


--
-- Name: devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.devices (
    pk_device_id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_code character varying(50) NOT NULL,
    device_name character varying(100),
    device_type character varying(20),
    fk_site_id uuid,
    location_description text,
    ip_address inet,
    mac_address character varying(17),
    keycloak_client_id character varying(100),
    api_key_hash character varying(64),
    status character varying(20) DEFAULT 'offline'::character varying,
    config_json jsonb DEFAULT '{}'::jsonb,
    capabilities jsonb DEFAULT '["face_detection"]'::jsonb,
    last_heartbeat_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    firmware_version character varying(50),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    camera_mode character varying(10) DEFAULT 'MIXED'::character varying,
    CONSTRAINT devices_device_type_check CHECK (((device_type)::text = ANY ((ARRAY['camera'::character varying, 'lpu'::character varying, 'sensor'::character varying, 'gateway'::character varying])::text[]))),
    CONSTRAINT devices_status_check CHECK (((status)::text = ANY ((ARRAY['online'::character varying, 'offline'::character varying, 'error'::character varying, 'maintenance'::character varying])::text[])))
);


--
-- Name: edu_student; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.edu_student (
    pk_student_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fk_tenant_id uuid NOT NULL,
    roll_number character varying(64),
    admission_number character varying(64),
    first_name character varying(128) NOT NULL,
    last_name character varying(128),
    email character varying(256),
    phone character varying(32),
    class_label character varying(64),
    section character varying(16),
    grade character varying(16),
    dob date,
    gender character varying(16),
    admission_date date,
    parent_name character varying(256),
    parent_phone character varying(32),
    parent_email character varying(256),
    photo_path text,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: edu_student_face_embedding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.edu_student_face_embedding (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    fk_student_id uuid NOT NULL,
    embedding public.vector(512) NOT NULL,
    model_version character varying(50) DEFAULT 'arcface-r50-fp16'::character varying,
    quality_score double precision,
    is_primary boolean DEFAULT false,
    enrolled_by uuid,
    enrolled_at timestamp with time zone DEFAULT now(),
    angle character varying(20),
    photo_path text
);


--
-- Name: employee_face_embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_face_embeddings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employee_id bigint NOT NULL,
    embedding public.vector(512) NOT NULL,
    model_version character varying(50) DEFAULT 'arcface-r50-fp16'::character varying,
    quality_score double precision,
    is_primary boolean DEFAULT false,
    enrolled_by bigint,
    enrolled_at timestamp with time zone DEFAULT now(),
    angle character varying(20),
    photo_path text,
    encrypted_embedding text,
    embedding_key_id character varying(32) DEFAULT 'v1'::character varying,
    embedding_encrypted_at timestamp with time zone
);


--
-- Name: COLUMN employee_face_embeddings.angle; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.employee_face_embeddings.angle IS 'Pose angle captured: front, left, right, up, down';


--
-- Name: COLUMN employee_face_embeddings.encrypted_embedding; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.employee_face_embeddings.encrypted_embedding IS 'FIX-021: AES-256-GCM encrypted face embedding; format = base64(iv[12] || ciphertext || authTag[16])';


--
-- Name: COLUMN employee_face_embeddings.embedding_key_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.employee_face_embeddings.embedding_key_id IS 'FIX-021: Key version used to encrypt this row — enables key rotation';


--
-- Name: enrollment_duplicate_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enrollment_duplicate_checks (
    pk_check_id uuid DEFAULT gen_random_uuid() NOT NULL,
    invitation_id integer NOT NULL,
    duplicate_emp_id bigint,
    similarity_score double precision NOT NULL,
    threshold_used double precision NOT NULL,
    status character varying(32) DEFAULT 'flagged'::character varying NOT NULL,
    checked_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_by bigint,
    reviewed_at timestamp with time zone,
    notes text
);


--
-- Name: TABLE enrollment_duplicate_checks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.enrollment_duplicate_checks IS 'FIX-023: Results of cosine-similarity duplicate enrollment detection';


--
-- Name: enrollment_invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enrollment_invitations (
    pk_invitation_id integer NOT NULL,
    fk_employee_id integer NOT NULL,
    tenant_id integer,
    customer_id integer,
    site_id integer,
    invitation_token text NOT NULL,
    status character varying(50) DEFAULT 'pending'::character varying,
    sent_at timestamp without time zone DEFAULT now(),
    expires_at timestamp without time zone NOT NULL,
    opened_at timestamp without time zone,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    device_info jsonb,
    quality_scores jsonb,
    photo_paths jsonb,
    approval_status character varying(50) DEFAULT 'pending'::character varying,
    average_quality numeric(5,2),
    approved_by integer,
    approved_at timestamp without time zone,
    rejection_reason text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    rejected_at timestamp without time zone,
    rejected_by integer,
    mt_tenant_id uuid,
    photo_integrity_tokens jsonb DEFAULT '{}'::jsonb NOT NULL,
    photos_purged_at timestamp with time zone,
    embedding_status character varying(32) DEFAULT 'pending'::character varying,
    consent_id uuid
);


--
-- Name: COLUMN enrollment_invitations.approved_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.enrollment_invitations.approved_by IS 'User ID who approved the enrollment';


--
-- Name: COLUMN enrollment_invitations.approved_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.enrollment_invitations.approved_at IS 'Timestamp when enrollment was approved';


--
-- Name: COLUMN enrollment_invitations.rejection_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.enrollment_invitations.rejection_reason IS 'Reason for rejection';


--
-- Name: COLUMN enrollment_invitations.rejected_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.enrollment_invitations.rejected_at IS 'Timestamp when enrollment was rejected';


--
-- Name: COLUMN enrollment_invitations.rejected_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.enrollment_invitations.rejected_by IS 'User ID who rejected the enrollment';


--
-- Name: COLUMN enrollment_invitations.photo_integrity_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.enrollment_invitations.photo_integrity_tokens IS 'FIX-008: HMAC-SHA256 tokens keyed by angle (front/left/right/up/down) for tamper detection';


--
-- Name: COLUMN enrollment_invitations.photos_purged_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.enrollment_invitations.photos_purged_at IS 'FIX-022: Timestamp when enrollment photos were deleted from disk after embedding creation';


--
-- Name: COLUMN enrollment_invitations.embedding_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.enrollment_invitations.embedding_status IS 'FIX-022: Lifecycle status of the photo → embedding pipeline';


--
-- Name: COLUMN enrollment_invitations.consent_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.enrollment_invitations.consent_id IS 'FIX-025: FK to biometric_consent — must be set before photos can be uploaded';


--
-- Name: enrollment_invitations_pk_invitation_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.enrollment_invitations_pk_invitation_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: enrollment_invitations_pk_invitation_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.enrollment_invitations_pk_invitation_id_seq OWNED BY public.enrollment_invitations.pk_invitation_id;


--
-- Name: enrollment_session_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enrollment_session_progress (
    pk_session_id integer NOT NULL,
    fk_invitation_id integer NOT NULL,
    started_at timestamp without time zone DEFAULT now(),
    last_activity timestamp without time zone DEFAULT now(),
    angles_captured jsonb DEFAULT '{"up": false, "down": false, "left": false, "front": false, "right": false}'::jsonb,
    current_angle character varying(20),
    temp_photo_paths jsonb,
    temp_quality_scores jsonb,
    retry_count integer DEFAULT 0,
    last_error text
);


--
-- Name: enrollment_session_progress_pk_session_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.enrollment_session_progress_pk_session_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: enrollment_session_progress_pk_session_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.enrollment_session_progress_pk_session_id_seq OWNED BY public.enrollment_session_progress.pk_session_id;


--
-- Name: facility_device; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.facility_device (
    pk_device_id bigint NOT NULL,
    customer_id bigint,
    site_id bigint,
    unit_id bigint,
    external_device_id character varying(80) NOT NULL,
    name character varying(200) NOT NULL,
    location_label character varying(200) NOT NULL,
    ip_address character varying(64) NOT NULL,
    status character varying(20) NOT NULL,
    recognition_accuracy numeric(5,2) DEFAULT 0 NOT NULL,
    total_scans integer DEFAULT 0 NOT NULL,
    error_rate numeric(5,2) DEFAULT 0 NOT NULL,
    model character varying(120),
    last_active timestamp with time zone DEFAULT now() NOT NULL,
    device_type_id integer,
    serial_number character varying(100),
    mac_address character varying(100),
    device_notes text,
    created_by bigint,
    device_config jsonb DEFAULT '{}'::jsonb,
    device_secret_hash character varying(255),
    token_issued_at timestamp with time zone,
    token_expires_at timestamp with time zone,
    decommissioned_at timestamp with time zone,
    decommissioned_by bigint,
    parent_device_id bigint,
    last_heartbeat timestamp with time zone,
    tenant_id uuid NOT NULL,
    mt_tenant_id uuid,
    current_jti character varying(64),
    CONSTRAINT facility_device_status_check CHECK (((status)::text = ANY ((ARRAY['online'::character varying, 'offline'::character varying, 'error'::character varying])::text[])))
);


--
-- Name: COLUMN facility_device.current_jti; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.facility_device.current_jti IS 'FIX-012: JTI of the most recently issued device token (for single-token-per-device enforcement)';


--
-- Name: facility_device_pk_device_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.facility_device_pk_device_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: facility_device_pk_device_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.facility_device_pk_device_id_seq OWNED BY public.facility_device.pk_device_id;


--
-- Name: frs_alert; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_alert (
    pk_alert_id bigint NOT NULL,
    tenant_id uuid NOT NULL,
    site_id bigint,
    alert_type text NOT NULL,
    severity text DEFAULT 'medium'::text NOT NULL,
    title text NOT NULL,
    description text,
    entity_type text,
    entity_id text,
    snapshot_url text,
    status text DEFAULT 'open'::text NOT NULL,
    acknowledged_by bigint,
    acknowledged_at timestamp with time zone,
    resolved_by bigint,
    resolved_at timestamp with time zone,
    assigned_to bigint,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    mt_tenant_id uuid
);


--
-- Name: frs_alert_pk_alert_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frs_alert_pk_alert_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frs_alert_pk_alert_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frs_alert_pk_alert_id_seq OWNED BY public.frs_alert.pk_alert_id;


--
-- Name: frs_building; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_building (
    pk_building_id integer NOT NULL,
    fk_site_id integer,
    name character varying(100) NOT NULL,
    address text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: frs_building_pk_building_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frs_building_pk_building_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frs_building_pk_building_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frs_building_pk_building_id_seq OWNED BY public.frs_building.pk_building_id;


--
-- Name: frs_camera; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_camera (
    pk_camera_id integer NOT NULL,
    fk_nug_id integer,
    fk_floor_id integer,
    fk_zone_id integer,
    name character varying(100) NOT NULL,
    cam_id character varying(100),
    rtsp_url text,
    ip_address character varying(50),
    model character varying(100),
    status character varying(20) DEFAULT 'offline'::character varying,
    recognition_accuracy numeric(5,4) DEFAULT 0,
    total_scans integer DEFAULT 0,
    error_rate numeric(5,4) DEFAULT 0,
    last_active timestamp with time zone,
    map_x numeric(10,4),
    map_y numeric(10,4),
    map_angle numeric(6,2) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: frs_camera_pk_camera_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frs_camera_pk_camera_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frs_camera_pk_camera_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frs_camera_pk_camera_id_seq OWNED BY public.frs_camera.pk_camera_id;


--
-- Name: frs_confidence_review; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_confidence_review (
    pk_review_id bigint NOT NULL,
    tenant_id uuid NOT NULL,
    site_id bigint,
    event_id bigint,
    face_snapshot_url text,
    ai_confidence numeric(5,4) NOT NULL,
    ai_match_id bigint,
    ai_match_name text,
    review_status text DEFAULT 'pending'::text NOT NULL,
    reviewer_id bigint,
    reviewed_at timestamp with time zone,
    reviewer_notes text,
    correct_match_id bigint,
    flagged_for_audit boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: frs_confidence_review_pk_review_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frs_confidence_review_pk_review_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frs_confidence_review_pk_review_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frs_confidence_review_pk_review_id_seq OWNED BY public.frs_confidence_review.pk_review_id;


--
-- Name: frs_confidence_threshold; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_confidence_threshold (
    pk_threshold_id bigint NOT NULL,
    tenant_id uuid NOT NULL,
    auto_accept_above numeric(5,4) DEFAULT 0.9500 NOT NULL,
    auto_reject_below numeric(5,4) DEFAULT 0.5000 NOT NULL,
    review_band_low numeric(5,4) DEFAULT 0.5000 NOT NULL,
    review_band_high numeric(5,4) DEFAULT 0.9500 NOT NULL,
    alert_on_low boolean DEFAULT true NOT NULL,
    updated_by bigint,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: frs_confidence_threshold_pk_threshold_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frs_confidence_threshold_pk_threshold_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frs_confidence_threshold_pk_threshold_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frs_confidence_threshold_pk_threshold_id_seq OWNED BY public.frs_confidence_threshold.pk_threshold_id;


--
-- Name: frs_customer; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_customer (
    pk_customer_id bigint NOT NULL,
    customer_name character varying(200) NOT NULL,
    fk_tenant_id uuid NOT NULL
);


--
-- Name: frs_customer_pk_customer_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frs_customer_pk_customer_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frs_customer_pk_customer_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frs_customer_pk_customer_id_seq OWNED BY public.frs_customer.pk_customer_id;


--
-- Name: frs_customer_user_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_customer_user_map (
    fk_user_id bigint NOT NULL,
    fk_customer_id bigint NOT NULL
);


--
-- Name: frs_floor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_floor (
    pk_floor_id integer NOT NULL,
    fk_building_id integer,
    floor_number integer NOT NULL,
    floor_name character varying(100),
    floor_plan_url text,
    floor_plan_data jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: frs_floor_pk_floor_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frs_floor_pk_floor_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frs_floor_pk_floor_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frs_floor_pk_floor_id_seq OWNED BY public.frs_floor.pk_floor_id;


--
-- Name: frs_group; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_group (
    pk_group_id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_name character varying(100) NOT NULL,
    description text,
    is_default boolean DEFAULT false NOT NULL,
    is_admin_group boolean DEFAULT false NOT NULL,
    fk_tenant_id uuid NOT NULL,
    created_by bigint,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: frs_incident; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_incident (
    pk_incident_id bigint NOT NULL,
    tenant_id uuid NOT NULL,
    site_id bigint,
    incident_number text DEFAULT ''::text NOT NULL,
    title text NOT NULL,
    description text,
    incident_type text DEFAULT 'other'::text NOT NULL,
    severity text DEFAULT 'medium'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    reporter_id bigint,
    assigned_to bigint,
    related_alert_id bigint,
    evidence_urls text[] DEFAULT '{}'::text[] NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    resolved_at timestamp with time zone,
    closed_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    mt_tenant_id uuid
);


--
-- Name: frs_incident_pk_incident_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frs_incident_pk_incident_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frs_incident_pk_incident_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frs_incident_pk_incident_id_seq OWNED BY public.frs_incident.pk_incident_id;


--
-- Name: frs_incident_timeline; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_incident_timeline (
    pk_timeline_id bigint NOT NULL,
    fk_incident_id bigint NOT NULL,
    user_id bigint,
    action text NOT NULL,
    old_value text,
    new_value text,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: frs_incident_timeline_pk_timeline_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frs_incident_timeline_pk_timeline_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frs_incident_timeline_pk_timeline_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frs_incident_timeline_pk_timeline_id_seq OWNED BY public.frs_incident_timeline.pk_timeline_id;


--
-- Name: frs_mfa_challenge; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_mfa_challenge (
    pk_challenge_id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id bigint NOT NULL,
    challenge_token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:02:00'::interval) NOT NULL,
    used_at timestamp with time zone
);


--
-- Name: frs_nug_box; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_nug_box (
    pk_nug_id integer NOT NULL,
    fk_site_id integer,
    fk_building_id integer,
    fk_floor_id integer,
    fk_zone_id integer,
    name character varying(100) NOT NULL,
    device_code character varying(100),
    ip_address character varying(50),
    port integer DEFAULT 5000,
    match_threshold numeric(4,3) DEFAULT 0.38,
    conf_threshold numeric(4,3) DEFAULT 0.35,
    cooldown_seconds integer DEFAULT 3,
    x_threshold integer DEFAULT 25,
    tracking_window integer DEFAULT 6,
    status character varying(20) DEFAULT 'offline'::character varying,
    cpu_percent numeric(5,2),
    memory_used_mb numeric(10,2),
    memory_total_mb numeric(10,2),
    gpu_percent numeric(5,2),
    temperature_c numeric(5,2),
    disk_used_gb numeric(10,2),
    uptime_seconds bigint,
    last_heartbeat timestamp with time zone,
    map_x numeric(10,4),
    map_y numeric(10,4),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    use_tls boolean DEFAULT true NOT NULL,
    tls_cert_fingerprint character varying(128)
);


--
-- Name: COLUMN frs_nug_box.use_tls; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.frs_nug_box.use_tls IS 'FIX-002: Whether this device communicates over HTTPS (default: true in production)';


--
-- Name: COLUMN frs_nug_box.tls_cert_fingerprint; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.frs_nug_box.tls_cert_fingerprint IS 'FIX-002: SHA-256 fingerprint of the device TLS certificate for pinning';


--
-- Name: frs_nug_box_pk_nug_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frs_nug_box_pk_nug_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frs_nug_box_pk_nug_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frs_nug_box_pk_nug_id_seq OWNED BY public.frs_nug_box.pk_nug_id;


--
-- Name: frs_site; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_site (
    pk_site_id bigint NOT NULL,
    site_name character varying(200) NOT NULL,
    fk_customer_id bigint NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying,
    city character varying(100),
    country character varying(100),
    timezone_offset character varying(100) DEFAULT 'Asia/Kolkata'::character varying,
    latitude numeric(10,8),
    longitude numeric(11,8),
    location_address text,
    site_config jsonb DEFAULT '{}'::jsonb,
    created_by_user_id bigint,
    enhanced_at timestamp with time zone DEFAULT now(),
    timezone character varying(100) DEFAULT 'Asia/Kolkata'::character varying,
    timezone_label character varying(100) DEFAULT '(GMT+05:30) Chennai, Kolkata, Mumbai, New Delhi'::character varying,
    keycloak_org_id character varying(255),
    keycloak_org_alias character varying(255),
    CONSTRAINT frs_site_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'inactive'::character varying])::text[])))
);


--
-- Name: frs_site_pk_site_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frs_site_pk_site_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frs_site_pk_site_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frs_site_pk_site_id_seq OWNED BY public.frs_site.pk_site_id;


--
-- Name: frs_telemetry_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_telemetry_history (
    pk_history_id integer NOT NULL,
    fk_nug_id integer NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now(),
    cpu numeric(5,2),
    gpu numeric(5,2),
    ram numeric(5,2)
);


--
-- Name: frs_telemetry_history_pk_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frs_telemetry_history_pk_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frs_telemetry_history_pk_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frs_telemetry_history_pk_history_id_seq OWNED BY public.frs_telemetry_history.pk_history_id;


--
-- Name: frs_tenant; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_tenant (
    tenant_name character varying(200) NOT NULL,
    pk_tenant_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fk_tenant_type_id uuid,
    vertical character varying(20) DEFAULT 'corporate'::character varying,
    CONSTRAINT frs_tenant_vertical_check CHECK (((vertical)::text = ANY ((ARRAY['corporate'::character varying, 'education'::character varying])::text[])))
);


--
-- Name: frs_tenant_user_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_tenant_user_map (
    fk_user_id bigint NOT NULL,
    fk_tenant_id uuid NOT NULL
);


--
-- Name: frs_unit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_unit (
    pk_unit_id bigint NOT NULL,
    unit_name character varying(200) NOT NULL,
    fk_site_id bigint NOT NULL
);


--
-- Name: frs_unit_pk_unit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frs_unit_pk_unit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frs_unit_pk_unit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frs_unit_pk_unit_id_seq OWNED BY public.frs_unit.pk_unit_id;


--
-- Name: frs_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_user (
    pk_user_id bigint NOT NULL,
    email character varying(320) NOT NULL,
    username character varying(150) NOT NULL,
    fk_user_type_id integer,
    role character varying(20) NOT NULL,
    password_hash character varying(255),
    department character varying(150),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    keycloak_sub character varying(64),
    auth_provider character varying(20) DEFAULT 'internal'::character varying NOT NULL,
    last_identity_sync_at timestamp with time zone,
    must_set_password boolean DEFAULT false NOT NULL,
    mfa_secret text,
    mfa_enabled boolean DEFAULT false NOT NULL,
    mfa_backup_codes text[] DEFAULT '{}'::text[],
    mfa_enabled_at timestamp with time zone,
    preferences jsonb DEFAULT '{}'::jsonb,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT frs_user_auth_provider_check CHECK (((auth_provider)::text = ANY ((ARRAY['internal'::character varying, 'keycloak'::character varying, 'federated'::character varying])::text[]))),
    CONSTRAINT frs_user_role_check CHECK (((role)::text = ANY (ARRAY['admin'::text, 'hr'::text, 'super_admin'::text, 'site_admin'::text, 'hr_manager'::text, 'viewer'::text, 'device_operator'::text, 'tenant_admin'::text])))
);


--
-- Name: frs_user_membership; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_user_membership (
    pk_membership_id bigint NOT NULL,
    fk_user_id bigint NOT NULL,
    role character varying(20) NOT NULL,
    customer_id bigint,
    site_id bigint,
    unit_id bigint,
    permissions text[] DEFAULT '{}'::text[] NOT NULL,
    tenant_id uuid NOT NULL,
    mt_tenant_id uuid,
    CONSTRAINT frs_user_membership_role_check CHECK (((role)::text = ANY ((ARRAY['admin'::character varying, 'hr'::character varying, 'super_admin'::character varying, 'site_admin'::character varying, 'hr_manager'::character varying, 'viewer'::character varying, 'device_operator'::character varying])::text[])))
);


--
-- Name: frs_user_membership_pk_membership_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frs_user_membership_pk_membership_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frs_user_membership_pk_membership_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frs_user_membership_pk_membership_id_seq OWNED BY public.frs_user_membership.pk_membership_id;


--
-- Name: frs_user_pk_user_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frs_user_pk_user_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frs_user_pk_user_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frs_user_pk_user_id_seq OWNED BY public.frs_user.pk_user_id;


--
-- Name: frs_watchlist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_watchlist (
    pk_watchlist_id bigint NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    category text DEFAULT 'general'::text NOT NULL,
    priority text DEFAULT 'medium'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    alert_on_match boolean DEFAULT true NOT NULL,
    notify_emails text[] DEFAULT '{}'::text[] NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: frs_watchlist_person; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_watchlist_person (
    pk_person_id bigint NOT NULL,
    fk_watchlist_id bigint NOT NULL,
    tenant_id uuid NOT NULL,
    full_name text NOT NULL,
    aliases text[] DEFAULT '{}'::text[] NOT NULL,
    photo_url text,
    face_vector jsonb,
    notes text,
    added_by bigint,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: frs_watchlist_person_pk_person_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frs_watchlist_person_pk_person_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frs_watchlist_person_pk_person_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frs_watchlist_person_pk_person_id_seq OWNED BY public.frs_watchlist_person.pk_person_id;


--
-- Name: frs_watchlist_pk_watchlist_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frs_watchlist_pk_watchlist_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frs_watchlist_pk_watchlist_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frs_watchlist_pk_watchlist_id_seq OWNED BY public.frs_watchlist.pk_watchlist_id;


--
-- Name: frs_zone; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frs_zone (
    pk_zone_id integer NOT NULL,
    fk_floor_id integer,
    zone_name character varying(100) NOT NULL,
    zone_type character varying(50) DEFAULT 'common'::character varying,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: frs_zone_pk_zone_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frs_zone_pk_zone_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frs_zone_pk_zone_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frs_zone_pk_zone_id_seq OWNED BY public.frs_zone.pk_zone_id;


--
-- Name: gdpr_erasure_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gdpr_erasure_requests (
    pk_erasure_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fk_employee_id bigint NOT NULL,
    tenant_id uuid NOT NULL,
    requested_by bigint,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    status character varying(32) DEFAULT 'pending'::character varying NOT NULL,
    db_erased_at timestamp with time zone,
    photos_erased_at timestamp with time zone,
    jetson_purged_at timestamp with time zone,
    error_message text,
    completed_at timestamp with time zone,
    completion_report jsonb
);


--
-- Name: TABLE gdpr_erasure_requests; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.gdpr_erasure_requests IS 'FIX-026: GDPR Art.17 right-to-erasure request tracking';


--
-- Name: group_role_assignment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_role_assignment (
    pk_assignment_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fk_group_id uuid NOT NULL,
    fk_role_id uuid NOT NULL,
    fk_scope_tenant_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: group_role_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_role_map (
    pk_group_role_id bigint NOT NULL,
    fk_group_id uuid NOT NULL,
    fk_role_id integer NOT NULL,
    fk_site_id bigint,
    granted_by bigint,
    granted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: group_role_map_pk_group_role_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.group_role_map_pk_group_role_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: group_role_map_pk_group_role_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.group_role_map_pk_group_role_id_seq OWNED BY public.group_role_map.pk_group_role_id;


--
-- Name: groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.groups (
    pk_group_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fk_tenant_id uuid NOT NULL,
    name character varying(64) NOT NULL,
    description text,
    is_admin boolean DEFAULT false NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: hr_department; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_department (
    pk_department_id bigint NOT NULL,
    name character varying(150) NOT NULL,
    code character varying(30) NOT NULL,
    color character varying(20),
    tenant_id uuid NOT NULL,
    description text,
    head_employee_id bigint,
    mt_tenant_id uuid
);


--
-- Name: hr_department_pk_department_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.hr_department_pk_department_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hr_department_pk_department_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.hr_department_pk_department_id_seq OWNED BY public.hr_department.pk_department_id;


--
-- Name: hr_employee; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_employee (
    pk_employee_id bigint NOT NULL,
    customer_id bigint,
    site_id bigint,
    unit_id bigint,
    fk_department_id bigint,
    fk_shift_id bigint,
    employee_code character varying(40) NOT NULL,
    full_name character varying(180) NOT NULL,
    email character varying(320) NOT NULL,
    position_title character varying(180) NOT NULL,
    location_label character varying(180),
    status character varying(20) NOT NULL,
    join_date date NOT NULL,
    phone_number character varying(40),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    face_enrolled boolean DEFAULT false,
    tenant_id uuid NOT NULL,
    kiosk_enrollment_status text,
    mt_tenant_id uuid,
    consent_given_at timestamp with time zone,
    consent_withdrawn_at timestamp with time zone,
    consent_method character varying(32),
    CONSTRAINT hr_employee_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'inactive'::character varying, 'on-leave'::character varying])::text[])))
);


--
-- Name: hr_employee_pk_employee_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.hr_employee_pk_employee_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hr_employee_pk_employee_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.hr_employee_pk_employee_id_seq OWNED BY public.hr_employee.pk_employee_id;


--
-- Name: hr_roster; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_roster (
    pk_roster_id bigint NOT NULL,
    tenant_id uuid NOT NULL,
    fk_employee_id bigint NOT NULL,
    fk_shift_id bigint NOT NULL,
    roster_date date NOT NULL,
    notes text,
    is_recurring boolean DEFAULT false NOT NULL,
    recur_day_of_week integer,
    swapped_with bigint,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    mt_tenant_id uuid
);


--
-- Name: hr_roster_pk_roster_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.hr_roster_pk_roster_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hr_roster_pk_roster_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.hr_roster_pk_roster_id_seq OWNED BY public.hr_roster.pk_roster_id;


--
-- Name: hr_shift; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_shift (
    pk_shift_id bigint NOT NULL,
    name character varying(120) NOT NULL,
    shift_type character varying(30) NOT NULL,
    start_time time without time zone,
    end_time time without time zone,
    grace_period_minutes integer DEFAULT 10 NOT NULL,
    is_flexible boolean DEFAULT false NOT NULL,
    tenant_id uuid NOT NULL,
    work_days text[] DEFAULT '{Mon,Tue,Wed,Thu,Fri}'::text[],
    break_duration_minutes integer DEFAULT 0,
    mt_tenant_id uuid,
    CONSTRAINT hr_shift_shift_type_check CHECK (((shift_type)::text = ANY ((ARRAY['morning'::character varying, 'afternoon'::character varying, 'evening'::character varying, 'night'::character varying, 'flexible'::character varying, 'fixed'::character varying, 'rotational'::character varying, 'custom'::character varying])::text[])))
);


--
-- Name: hr_shift_pk_shift_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.hr_shift_pk_shift_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hr_shift_pk_shift_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.hr_shift_pk_shift_id_seq OWNED BY public.hr_shift.pk_shift_id;


--
-- Name: nav_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nav_item (
    pk_nav_item_id bigint NOT NULL,
    role_name text NOT NULL,
    item_key text NOT NULL,
    label text NOT NULL,
    icon text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    vertical character varying(20),
    CONSTRAINT nav_item_vertical_check CHECK ((((vertical)::text = ANY ((ARRAY['corporate'::character varying, 'education'::character varying])::text[])) OR (vertical IS NULL)))
);


--
-- Name: nav_item_pk_nav_item_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.nav_item_pk_nav_item_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: nav_item_pk_nav_item_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.nav_item_pk_nav_item_id_seq OWNED BY public.nav_item.pk_nav_item_id;


--
-- Name: rbac_permission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rbac_permission (
    pk_permission_id integer NOT NULL,
    permission_code character varying(80) NOT NULL,
    category character varying(40) NOT NULL,
    display_name character varying(120) NOT NULL,
    description text,
    is_scope_aware boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: rbac_permission_pk_permission_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.rbac_permission_pk_permission_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rbac_permission_pk_permission_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.rbac_permission_pk_permission_id_seq OWNED BY public.rbac_permission.pk_permission_id;


--
-- Name: rbac_role; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rbac_role (
    pk_role_id integer NOT NULL,
    role_name character varying(50) NOT NULL,
    display_name character varying(100) NOT NULL,
    description text,
    scope_type character varying(20) DEFAULT 'flexible'::character varying NOT NULL,
    is_system boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rbac_role_scope_type_check CHECK (((scope_type)::text = ANY ((ARRAY['global'::character varying, 'site'::character varying, 'flexible'::character varying, 'tenant'::character varying])::text[])))
);


--
-- Name: rbac_role_permission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rbac_role_permission (
    fk_role_id integer NOT NULL,
    fk_permission_id integer NOT NULL
);


--
-- Name: rbac_role_pk_role_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.rbac_role_pk_role_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rbac_role_pk_role_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.rbac_role_pk_role_id_seq OWNED BY public.rbac_role.pk_role_id;


--
-- Name: report_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_schedules (
    pk_schedule_id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    report_type character varying(50) NOT NULL,
    frequency character varying(50) NOT NULL,
    "time" character varying(10) NOT NULL,
    recipients text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    last_run timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    mt_tenant_id uuid
);


--
-- Name: role_capability_grant; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_capability_grant (
    pk_grant_id bigint NOT NULL,
    grantor_role text NOT NULL,
    grantee_role text NOT NULL,
    capability text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: role_capability_grant_pk_grant_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.role_capability_grant_pk_grant_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: role_capability_grant_pk_grant_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.role_capability_grant_pk_grant_id_seq OWNED BY public.role_capability_grant.pk_grant_id;


--
-- Name: role_scope_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_scope_mapping (
    fk_role_id uuid NOT NULL,
    fk_scope_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    pk_role_id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(64) NOT NULL,
    display_name character varying(128),
    description text,
    fk_tenant_id uuid,
    is_default boolean DEFAULT false NOT NULL,
    is_super_role boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scopes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scopes (
    pk_scope_id uuid DEFAULT gen_random_uuid() NOT NULL,
    scope_code character varying(128) NOT NULL,
    menu_name character varying(64) NOT NULL,
    sub_menu character varying(64),
    action character varying(32) NOT NULL,
    display_name character varying(256),
    description text,
    vertical character varying(16),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scopes_vertical_check CHECK (((vertical)::text = ANY ((ARRAY['corporate'::character varying, 'education'::character varying])::text[])))
);


--
-- Name: site_device_assignment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.site_device_assignment (
    pk_assignment_id integer NOT NULL,
    site_id bigint NOT NULL,
    device_id bigint NOT NULL,
    device_role character varying(50) DEFAULT 'entrance'::character varying,
    zone_name character varying(100),
    is_active boolean DEFAULT true,
    assigned_at timestamp with time zone DEFAULT now(),
    assigned_by bigint,
    unassigned_at timestamp with time zone,
    unassigned_by bigint,
    unassignment_reason text
);


--
-- Name: site_device_assignment_pk_assignment_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.site_device_assignment_pk_assignment_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: site_device_assignment_pk_assignment_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.site_device_assignment_pk_assignment_id_seq OWNED BY public.site_device_assignment.pk_assignment_id;


--
-- Name: slo_measurements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slo_measurements (
    pk_measurement_id uuid DEFAULT gen_random_uuid() NOT NULL,
    measured_at timestamp with time zone DEFAULT now() NOT NULL,
    environment character varying(32) DEFAULT 'production'::character varying NOT NULL,
    test_type character varying(64) NOT NULL,
    duration_seconds integer NOT NULL,
    total_requests integer DEFAULT 0 NOT NULL,
    failed_requests integer DEFAULT 0 NOT NULL,
    error_rate double precision,
    p50_ms double precision,
    p90_ms double precision,
    p95_ms double precision,
    p99_ms double precision,
    max_ms double precision,
    requests_per_sec double precision,
    slo_p95_target_ms integer DEFAULT 500 NOT NULL,
    slo_error_rate_max double precision DEFAULT 0.01 NOT NULL,
    slo_p95_passed boolean,
    slo_error_passed boolean,
    slo_overall_pass boolean,
    vus integer,
    notes text
);


--
-- Name: TABLE slo_measurements; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.slo_measurements IS 'FIX-043: API SLO tracking — p95 < 500ms, error rate < 1%';


--
-- Name: student_attendance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.student_attendance (
    pk_attendance_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fk_student_id uuid NOT NULL,
    fk_tenant_id uuid NOT NULL,
    attendance_date date NOT NULL,
    status character varying(16) DEFAULT 'present'::character varying NOT NULL,
    check_in_at timestamp with time zone,
    check_out_at timestamp with time zone,
    marked_by_device text,
    marked_by_user_id uuid,
    confidence numeric(4,3),
    source character varying(16) DEFAULT 'face_recognition'::character varying NOT NULL,
    notes text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT student_attendance_source_check CHECK (((source)::text = ANY ((ARRAY['face_recognition'::character varying, 'manual'::character varying, 'import'::character varying, 'api'::character varying])::text[]))),
    CONSTRAINT student_attendance_status_check CHECK (((status)::text = ANY ((ARRAY['present'::character varying, 'absent'::character varying, 'late'::character varying, 'half_day'::character varying, 'excused'::character varying])::text[])))
);


--
-- Name: subscription_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_plans (
    pk_plan_id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(128) NOT NULL,
    plan_type character varying(32) NOT NULL,
    vertical character varying(16) DEFAULT 'corporate'::character varying NOT NULL,
    billing_cycle character varying(16) DEFAULT 'monthly'::character varying NOT NULL,
    base_price numeric(10,2),
    currency character varying(3) DEFAULT 'INR'::character varying,
    max_users integer,
    max_sites integer,
    max_units integer,
    max_devices integer,
    max_employees integer,
    data_retention_days integer,
    log_retention_days integer,
    api_rate_limit_per_hour integer,
    features jsonb DEFAULT '[]'::jsonb NOT NULL,
    nav_items jsonb DEFAULT '[]'::jsonb NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscription_plans_billing_cycle_check CHECK (((billing_cycle)::text = ANY ((ARRAY['monthly'::character varying, 'annual'::character varying, 'perpetual'::character varying, 'none'::character varying])::text[]))),
    CONSTRAINT subscription_plans_plan_type_check CHECK (((plan_type)::text = ANY (ARRAY['basic'::text, 'smb'::text, 'enterprise'::text, 'internal'::text, 'institute'::text, 'custom'::text, 'school'::text, 'university'::text]))),
    CONSTRAINT subscription_plans_vertical_check CHECK (((vertical)::text = ANY ((ARRAY['corporate'::character varying, 'education'::character varying])::text[])))
);


--
-- Name: system_alert; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_alert (
    pk_alert_id bigint NOT NULL,
    customer_id bigint,
    site_id bigint,
    unit_id bigint,
    alert_type character varying(80) NOT NULL,
    severity character varying(20) NOT NULL,
    title character varying(220),
    message text NOT NULL,
    fk_employee_id bigint,
    fk_device_id bigint,
    is_read boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid NOT NULL,
    mt_tenant_id uuid,
    CONSTRAINT system_alert_severity_check CHECK (((severity)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'critical'::character varying])::text[])))
);


--
-- Name: system_alert_pk_alert_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.system_alert_pk_alert_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: system_alert_pk_alert_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.system_alert_pk_alert_id_seq OWNED BY public.system_alert.pk_alert_id;


--
-- Name: tenant_holidays; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_holidays (
    pk_holiday_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fk_tenant_id uuid NOT NULL,
    name text NOT NULL,
    date date NOT NULL,
    type text DEFAULT 'public'::text NOT NULL,
    recurring boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_holidays_type_check CHECK ((type = ANY (ARRAY['public'::text, 'company'::text, 'optional'::text])))
);


--
-- Name: tenant_realm; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_realm (
    pk_realm_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fk_tenant_id uuid NOT NULL,
    realm_slug character varying(100) NOT NULL,
    realm_name character varying(255) NOT NULL,
    domain character varying(255),
    session_timeout_minutes integer DEFAULT 480 NOT NULL,
    max_failed_logins integer DEFAULT 5 NOT NULL,
    password_min_length integer DEFAULT 8 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tenant_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_settings (
    fk_tenant_id uuid NOT NULL,
    logo_url text,
    favicon_url text,
    primary_color character varying(7),
    secondary_color character varying(7),
    custom_css text,
    sso_enabled boolean DEFAULT false,
    sso_provider character varying(64),
    sso_config jsonb DEFAULT '{}'::jsonb,
    sso_domains text[],
    webhook_url text,
    webhook_secret text,
    slack_webhook_url text,
    teams_webhook_url text,
    email_notifications boolean DEFAULT true,
    allowed_ip_ranges inet[],
    api_rate_limit integer,
    data_retention_days integer,
    log_retention_days integer,
    custom_features jsonb DEFAULT '[]'::jsonb,
    disabled_features jsonb DEFAULT '[]'::jsonb,
    custom_settings jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tenant_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_subscriptions (
    pk_subscription_id uuid DEFAULT gen_random_uuid() NOT NULL,
    fk_tenant_id uuid NOT NULL,
    fk_plan_id uuid NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    starts_at timestamp with time zone DEFAULT now() NOT NULL,
    ends_at timestamp with time zone,
    auto_renew boolean DEFAULT true NOT NULL,
    custom_features jsonb DEFAULT '[]'::jsonb NOT NULL,
    disabled_features jsonb DEFAULT '[]'::jsonb NOT NULL,
    custom_limits jsonb DEFAULT '{}'::jsonb NOT NULL,
    current_users integer DEFAULT 0,
    current_sites integer DEFAULT 0,
    current_devices integer DEFAULT 0,
    current_employees integer DEFAULT 0,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_subscriptions_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'expired'::character varying, 'suspended'::character varying, 'cancelled'::character varying, 'trial'::character varying])::text[])))
);


--
-- Name: tenant_type; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_type (
    pk_tenant_type_id uuid DEFAULT gen_random_uuid() NOT NULL,
    type_name character varying(100) NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tenant_type_feature_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_type_feature_map (
    fk_tenant_type_id uuid NOT NULL,
    feature_key text NOT NULL
);


--
-- Name: tenant_ui_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_ui_config (
    pk_config_id bigint NOT NULL,
    logo_url text,
    primary_color text DEFAULT '#6366f1'::text NOT NULL,
    enabled_features jsonb DEFAULT '[]'::jsonb NOT NULL,
    dashboard_widgets jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    fk_tenant_id uuid NOT NULL
);


--
-- Name: tenant_ui_config_pk_config_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tenant_ui_config_pk_config_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tenant_ui_config_pk_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tenant_ui_config_pk_config_id_seq OWNED BY public.tenant_ui_config.pk_config_id;


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    pk_tenant_id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_id uuid,
    root_id uuid,
    hierarchy_path character varying(512) NOT NULL,
    level smallint NOT NULL,
    tenant_kind character varying(16) NOT NULL,
    vertical character varying(16),
    name character varying(256) NOT NULL,
    slug character varying(128) NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    domain character varying(256),
    external_id character varying(256),
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    created_by uuid,
    updated_by uuid,
    CONSTRAINT tenants_level_check CHECK (((level >= 0) AND (level <= 3))),
    CONSTRAINT tenants_level_kind_chk CHECK ((((level = 0) AND (parent_id IS NULL) AND ((tenant_kind)::text = 'platform'::text)) OR ((level = 1) AND (parent_id IS NOT NULL) AND ((tenant_kind)::text = 'customer'::text)) OR ((level = 2) AND (parent_id IS NOT NULL) AND ((tenant_kind)::text = 'site'::text)) OR ((level = 3) AND (parent_id IS NOT NULL) AND ((tenant_kind)::text = 'unit'::text)))),
    CONSTRAINT tenants_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'suspended'::character varying, 'inactive'::character varying, 'pending'::character varying])::text[]))),
    CONSTRAINT tenants_tenant_kind_check CHECK (((tenant_kind)::text = ANY ((ARRAY['platform'::character varying, 'customer'::character varying, 'site'::character varying, 'unit'::character varying])::text[]))),
    CONSTRAINT tenants_vertical_check CHECK (((vertical)::text = ANY ((ARRAY['corporate'::character varying, 'education'::character varying])::text[])))
);


--
-- Name: unauthorized_access_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.unauthorized_access_log (
    pk_log_id integer NOT NULL,
    tenant_id bigint,
    customer_id bigint,
    site_id bigint,
    unit_id bigint,
    device_id character varying(100),
    employee_code character varying(50),
    confidence_score numeric(5,4),
    image_url text,
    event_timestamp timestamp with time zone DEFAULT now(),
    resolved_at timestamp with time zone,
    resolved_by bigint,
    remarks text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: unauthorized_access_log_pk_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.unauthorized_access_log_pk_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: unauthorized_access_log_pk_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.unauthorized_access_log_pk_log_id_seq OWNED BY public.unauthorized_access_log.pk_log_id;


--
-- Name: user_group_assignment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_group_assignment (
    fk_user_id uuid NOT NULL,
    fk_group_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_group_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_group_map (
    fk_user_id bigint NOT NULL,
    fk_group_id uuid NOT NULL,
    added_by bigint,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_invite; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_invite (
    pk_invite_id bigint NOT NULL,
    fk_user_id bigint NOT NULL,
    invite_token text NOT NULL,
    invited_by_id bigint,
    invited_by_name text,
    role_label text,
    tenant_name text,
    site_name text,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_invite_pk_invite_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_invite_pk_invite_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_invite_pk_invite_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_invite_pk_invite_id_seq OWNED BY public.user_invite.pk_invite_id;


--
-- Name: user_role; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_role (
    pk_user_role_id bigint NOT NULL,
    fk_user_id bigint NOT NULL,
    fk_role_id integer NOT NULL,
    fk_site_id bigint,
    granted_by bigint,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_role_pk_user_role_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_role_pk_user_role_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_role_pk_user_role_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_role_pk_user_role_id_seq OWNED BY public.user_role.pk_user_role_id;


--
-- Name: users; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.users AS
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
    0 AS failed_login_attempts,
    NULL::timestamp with time zone AS locked_until,
    'UTC'::text AS timezone,
    'en'::text AS language,
    '{}'::jsonb AS preferences,
    created_at,
    created_at AS updated_at,
    NULL::timestamp with time zone AS deleted_at
   FROM public.frs_user fu;


--
-- Name: attendance_events pk_attendance_event_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_events ALTER COLUMN pk_attendance_event_id SET DEFAULT nextval('public.attendance_events_pk_attendance_event_id_seq'::regclass);


--
-- Name: attendance_record pk_attendance_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_record ALTER COLUMN pk_attendance_id SET DEFAULT nextval('public.attendance_record_pk_attendance_id_seq'::regclass);


--
-- Name: audit_log pk_audit_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log ALTER COLUMN pk_audit_id SET DEFAULT nextval('public.audit_log_pk_audit_id_seq'::regclass);


--
-- Name: blacklisted_enrollment_tokens pk_blacklist_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blacklisted_enrollment_tokens ALTER COLUMN pk_blacklist_id SET DEFAULT nextval('public.blacklisted_enrollment_tokens_pk_blacklist_id_seq'::regclass);


--
-- Name: device_activation_code pk_activation_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_activation_code ALTER COLUMN pk_activation_id SET DEFAULT nextval('public.device_activation_code_pk_activation_id_seq'::regclass);


--
-- Name: device_command_queue pk_command_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_command_queue ALTER COLUMN pk_command_id SET DEFAULT nextval('public.device_command_queue_pk_command_id_seq'::regclass);


--
-- Name: device_heartbeat pk_heartbeat_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_heartbeat ALTER COLUMN pk_heartbeat_id SET DEFAULT nextval('public.device_heartbeat_pk_heartbeat_id_seq'::regclass);


--
-- Name: device_status_history pk_history_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_status_history ALTER COLUMN pk_history_id SET DEFAULT nextval('public.device_status_history_pk_history_id_seq'::regclass);


--
-- Name: device_type pk_device_type_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_type ALTER COLUMN pk_device_type_id SET DEFAULT nextval('public.device_type_pk_device_type_id_seq'::regclass);


--
-- Name: enrollment_invitations pk_invitation_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_invitations ALTER COLUMN pk_invitation_id SET DEFAULT nextval('public.enrollment_invitations_pk_invitation_id_seq'::regclass);


--
-- Name: enrollment_session_progress pk_session_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_session_progress ALTER COLUMN pk_session_id SET DEFAULT nextval('public.enrollment_session_progress_pk_session_id_seq'::regclass);


--
-- Name: facility_device pk_device_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facility_device ALTER COLUMN pk_device_id SET DEFAULT nextval('public.facility_device_pk_device_id_seq'::regclass);


--
-- Name: frs_alert pk_alert_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_alert ALTER COLUMN pk_alert_id SET DEFAULT nextval('public.frs_alert_pk_alert_id_seq'::regclass);


--
-- Name: frs_building pk_building_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_building ALTER COLUMN pk_building_id SET DEFAULT nextval('public.frs_building_pk_building_id_seq'::regclass);


--
-- Name: frs_camera pk_camera_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_camera ALTER COLUMN pk_camera_id SET DEFAULT nextval('public.frs_camera_pk_camera_id_seq'::regclass);


--
-- Name: frs_confidence_review pk_review_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_confidence_review ALTER COLUMN pk_review_id SET DEFAULT nextval('public.frs_confidence_review_pk_review_id_seq'::regclass);


--
-- Name: frs_confidence_threshold pk_threshold_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_confidence_threshold ALTER COLUMN pk_threshold_id SET DEFAULT nextval('public.frs_confidence_threshold_pk_threshold_id_seq'::regclass);


--
-- Name: frs_customer pk_customer_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_customer ALTER COLUMN pk_customer_id SET DEFAULT nextval('public.frs_customer_pk_customer_id_seq'::regclass);


--
-- Name: frs_floor pk_floor_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_floor ALTER COLUMN pk_floor_id SET DEFAULT nextval('public.frs_floor_pk_floor_id_seq'::regclass);


--
-- Name: frs_incident pk_incident_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_incident ALTER COLUMN pk_incident_id SET DEFAULT nextval('public.frs_incident_pk_incident_id_seq'::regclass);


--
-- Name: frs_incident_timeline pk_timeline_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_incident_timeline ALTER COLUMN pk_timeline_id SET DEFAULT nextval('public.frs_incident_timeline_pk_timeline_id_seq'::regclass);


--
-- Name: frs_nug_box pk_nug_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_nug_box ALTER COLUMN pk_nug_id SET DEFAULT nextval('public.frs_nug_box_pk_nug_id_seq'::regclass);


--
-- Name: frs_site pk_site_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_site ALTER COLUMN pk_site_id SET DEFAULT nextval('public.frs_site_pk_site_id_seq'::regclass);


--
-- Name: frs_telemetry_history pk_history_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_telemetry_history ALTER COLUMN pk_history_id SET DEFAULT nextval('public.frs_telemetry_history_pk_history_id_seq'::regclass);


--
-- Name: frs_unit pk_unit_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_unit ALTER COLUMN pk_unit_id SET DEFAULT nextval('public.frs_unit_pk_unit_id_seq'::regclass);


--
-- Name: frs_user pk_user_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_user ALTER COLUMN pk_user_id SET DEFAULT nextval('public.frs_user_pk_user_id_seq'::regclass);


--
-- Name: frs_user_membership pk_membership_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_user_membership ALTER COLUMN pk_membership_id SET DEFAULT nextval('public.frs_user_membership_pk_membership_id_seq'::regclass);


--
-- Name: frs_watchlist pk_watchlist_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_watchlist ALTER COLUMN pk_watchlist_id SET DEFAULT nextval('public.frs_watchlist_pk_watchlist_id_seq'::regclass);


--
-- Name: frs_watchlist_person pk_person_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_watchlist_person ALTER COLUMN pk_person_id SET DEFAULT nextval('public.frs_watchlist_person_pk_person_id_seq'::regclass);


--
-- Name: frs_zone pk_zone_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_zone ALTER COLUMN pk_zone_id SET DEFAULT nextval('public.frs_zone_pk_zone_id_seq'::regclass);


--
-- Name: group_role_map pk_group_role_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_role_map ALTER COLUMN pk_group_role_id SET DEFAULT nextval('public.group_role_map_pk_group_role_id_seq'::regclass);


--
-- Name: hr_department pk_department_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_department ALTER COLUMN pk_department_id SET DEFAULT nextval('public.hr_department_pk_department_id_seq'::regclass);


--
-- Name: hr_employee pk_employee_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employee ALTER COLUMN pk_employee_id SET DEFAULT nextval('public.hr_employee_pk_employee_id_seq'::regclass);


--
-- Name: hr_roster pk_roster_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_roster ALTER COLUMN pk_roster_id SET DEFAULT nextval('public.hr_roster_pk_roster_id_seq'::regclass);


--
-- Name: hr_shift pk_shift_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_shift ALTER COLUMN pk_shift_id SET DEFAULT nextval('public.hr_shift_pk_shift_id_seq'::regclass);


--
-- Name: nav_item pk_nav_item_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nav_item ALTER COLUMN pk_nav_item_id SET DEFAULT nextval('public.nav_item_pk_nav_item_id_seq'::regclass);


--
-- Name: rbac_permission pk_permission_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_permission ALTER COLUMN pk_permission_id SET DEFAULT nextval('public.rbac_permission_pk_permission_id_seq'::regclass);


--
-- Name: rbac_role pk_role_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_role ALTER COLUMN pk_role_id SET DEFAULT nextval('public.rbac_role_pk_role_id_seq'::regclass);


--
-- Name: role_capability_grant pk_grant_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_capability_grant ALTER COLUMN pk_grant_id SET DEFAULT nextval('public.role_capability_grant_pk_grant_id_seq'::regclass);


--
-- Name: site_device_assignment pk_assignment_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_device_assignment ALTER COLUMN pk_assignment_id SET DEFAULT nextval('public.site_device_assignment_pk_assignment_id_seq'::regclass);


--
-- Name: system_alert pk_alert_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_alert ALTER COLUMN pk_alert_id SET DEFAULT nextval('public.system_alert_pk_alert_id_seq'::regclass);


--
-- Name: tenant_ui_config pk_config_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_ui_config ALTER COLUMN pk_config_id SET DEFAULT nextval('public.tenant_ui_config_pk_config_id_seq'::regclass);


--
-- Name: unauthorized_access_log pk_log_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unauthorized_access_log ALTER COLUMN pk_log_id SET DEFAULT nextval('public.unauthorized_access_log_pk_log_id_seq'::regclass);


--
-- Name: user_invite pk_invite_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_invite ALTER COLUMN pk_invite_id SET DEFAULT nextval('public.user_invite_pk_invite_id_seq'::regclass);


--
-- Name: user_role pk_user_role_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_role ALTER COLUMN pk_user_role_id SET DEFAULT nextval('public.user_role_pk_user_role_id_seq'::regclass);


--
-- Name: _migration_site_id_map _migration_site_id_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._migration_site_id_map
    ADD CONSTRAINT _migration_site_id_map_pkey PRIMARY KEY (old_site_id_bigint);


--
-- Name: ai_bias_evaluations ai_bias_evaluations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_bias_evaluations
    ADD CONSTRAINT ai_bias_evaluations_pkey PRIMARY KEY (pk_evaluation_id);


--
-- Name: ai_drift_snapshots ai_drift_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_drift_snapshots
    ADD CONSTRAINT ai_drift_snapshots_pkey PRIMARY KEY (pk_snapshot_id);


--
-- Name: attendance_events attendance_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_events
    ADD CONSTRAINT attendance_events_pkey PRIMARY KEY (pk_attendance_event_id);


--
-- Name: attendance_record attendance_record_emp_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_record
    ADD CONSTRAINT attendance_record_emp_date_key UNIQUE (fk_employee_id, attendance_date);


--
-- Name: attendance_record attendance_record_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_record
    ADD CONSTRAINT attendance_record_pkey PRIMARY KEY (pk_attendance_id);


--
-- Name: attendance_record attendance_record_tenant_id_fk_employee_id_attendance_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_record
    ADD CONSTRAINT attendance_record_tenant_id_fk_employee_id_attendance_date_key UNIQUE (tenant_id, fk_employee_id, attendance_date);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (pk_audit_id);


--
-- Name: auth_session_token auth_session_token_access_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session_token
    ADD CONSTRAINT auth_session_token_access_token_key UNIQUE (access_token);


--
-- Name: auth_session_token auth_session_token_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session_token
    ADD CONSTRAINT auth_session_token_pkey PRIMARY KEY (token_id);


--
-- Name: auth_session_token auth_session_token_refresh_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session_token
    ADD CONSTRAINT auth_session_token_refresh_token_key UNIQUE (refresh_token);


--
-- Name: biometric_consent biometric_consent_fk_employee_id_consent_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.biometric_consent
    ADD CONSTRAINT biometric_consent_fk_employee_id_consent_version_key UNIQUE (fk_employee_id, consent_version);


--
-- Name: biometric_consent biometric_consent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.biometric_consent
    ADD CONSTRAINT biometric_consent_pkey PRIMARY KEY (pk_consent_id);


--
-- Name: blacklisted_enrollment_tokens blacklisted_enrollment_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blacklisted_enrollment_tokens
    ADD CONSTRAINT blacklisted_enrollment_tokens_pkey PRIMARY KEY (pk_blacklist_id);


--
-- Name: blacklisted_enrollment_tokens blacklisted_enrollment_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blacklisted_enrollment_tokens
    ADD CONSTRAINT blacklisted_enrollment_tokens_token_key UNIQUE (token);


--
-- Name: completed_report_runs completed_report_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.completed_report_runs
    ADD CONSTRAINT completed_report_runs_pkey PRIMARY KEY (pk_run_id);


--
-- Name: device_activation_code device_activation_code_activation_pin_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_activation_code
    ADD CONSTRAINT device_activation_code_activation_pin_key UNIQUE (activation_pin);


--
-- Name: device_activation_code device_activation_code_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_activation_code
    ADD CONSTRAINT device_activation_code_pkey PRIMARY KEY (pk_activation_id);


--
-- Name: device_command_queue device_command_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_command_queue
    ADD CONSTRAINT device_command_queue_pkey PRIMARY KEY (pk_command_id);


--
-- Name: device_events device_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_events
    ADD CONSTRAINT device_events_pkey PRIMARY KEY (pk_event_id);


--
-- Name: device_heartbeat device_heartbeat_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_heartbeat
    ADD CONSTRAINT device_heartbeat_pkey PRIMARY KEY (pk_heartbeat_id);


--
-- Name: device_status_history device_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_status_history
    ADD CONSTRAINT device_status_history_pkey PRIMARY KEY (pk_history_id);


--
-- Name: device_token_revocations device_token_revocations_jti_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_token_revocations
    ADD CONSTRAINT device_token_revocations_jti_key UNIQUE (jti);


--
-- Name: device_token_revocations device_token_revocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_token_revocations
    ADD CONSTRAINT device_token_revocations_pkey PRIMARY KEY (pk_revocation_id);


--
-- Name: device_type device_type_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_type
    ADD CONSTRAINT device_type_pkey PRIMARY KEY (pk_device_type_id);


--
-- Name: device_type device_type_type_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_type
    ADD CONSTRAINT device_type_type_code_key UNIQUE (type_code);


--
-- Name: devices devices_device_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_device_code_key UNIQUE (device_code);


--
-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (pk_device_id);


--
-- Name: edu_student_face_embedding edu_student_face_embedding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edu_student_face_embedding
    ADD CONSTRAINT edu_student_face_embedding_pkey PRIMARY KEY (id);


--
-- Name: edu_student edu_student_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edu_student
    ADD CONSTRAINT edu_student_pkey PRIMARY KEY (pk_student_id);


--
-- Name: employee_face_embeddings employee_face_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_face_embeddings
    ADD CONSTRAINT employee_face_embeddings_pkey PRIMARY KEY (id);


--
-- Name: enrollment_duplicate_checks enrollment_duplicate_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_duplicate_checks
    ADD CONSTRAINT enrollment_duplicate_checks_pkey PRIMARY KEY (pk_check_id);


--
-- Name: enrollment_invitations enrollment_invitations_invitation_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_invitations
    ADD CONSTRAINT enrollment_invitations_invitation_token_key UNIQUE (invitation_token);


--
-- Name: enrollment_invitations enrollment_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_invitations
    ADD CONSTRAINT enrollment_invitations_pkey PRIMARY KEY (pk_invitation_id);


--
-- Name: enrollment_session_progress enrollment_session_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_session_progress
    ADD CONSTRAINT enrollment_session_progress_pkey PRIMARY KEY (pk_session_id);


--
-- Name: facility_device facility_device_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facility_device
    ADD CONSTRAINT facility_device_pkey PRIMARY KEY (pk_device_id);


--
-- Name: facility_device facility_device_tenant_id_external_device_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facility_device
    ADD CONSTRAINT facility_device_tenant_id_external_device_id_key UNIQUE (tenant_id, external_device_id);


--
-- Name: frs_alert frs_alert_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_alert
    ADD CONSTRAINT frs_alert_pkey PRIMARY KEY (pk_alert_id);


--
-- Name: frs_building frs_building_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_building
    ADD CONSTRAINT frs_building_pkey PRIMARY KEY (pk_building_id);


--
-- Name: frs_camera frs_camera_cam_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_camera
    ADD CONSTRAINT frs_camera_cam_id_key UNIQUE (cam_id);


--
-- Name: frs_camera frs_camera_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_camera
    ADD CONSTRAINT frs_camera_pkey PRIMARY KEY (pk_camera_id);


--
-- Name: frs_confidence_review frs_confidence_review_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_confidence_review
    ADD CONSTRAINT frs_confidence_review_pkey PRIMARY KEY (pk_review_id);


--
-- Name: frs_confidence_threshold frs_confidence_threshold_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_confidence_threshold
    ADD CONSTRAINT frs_confidence_threshold_pkey PRIMARY KEY (pk_threshold_id);


--
-- Name: frs_confidence_threshold frs_confidence_threshold_tenant_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_confidence_threshold
    ADD CONSTRAINT frs_confidence_threshold_tenant_id_key UNIQUE (tenant_id);


--
-- Name: frs_customer frs_customer_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_customer
    ADD CONSTRAINT frs_customer_pkey PRIMARY KEY (pk_customer_id);


--
-- Name: frs_customer_user_map frs_customer_user_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_customer_user_map
    ADD CONSTRAINT frs_customer_user_map_pkey PRIMARY KEY (fk_user_id, fk_customer_id);


--
-- Name: frs_floor frs_floor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_floor
    ADD CONSTRAINT frs_floor_pkey PRIMARY KEY (pk_floor_id);


--
-- Name: frs_group frs_group_fk_tenant_id_group_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_group
    ADD CONSTRAINT frs_group_fk_tenant_id_group_name_key UNIQUE (fk_tenant_id, group_name);


--
-- Name: frs_group frs_group_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_group
    ADD CONSTRAINT frs_group_pkey PRIMARY KEY (pk_group_id);


--
-- Name: frs_incident frs_incident_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_incident
    ADD CONSTRAINT frs_incident_pkey PRIMARY KEY (pk_incident_id);


--
-- Name: frs_incident_timeline frs_incident_timeline_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_incident_timeline
    ADD CONSTRAINT frs_incident_timeline_pkey PRIMARY KEY (pk_timeline_id);


--
-- Name: frs_mfa_challenge frs_mfa_challenge_challenge_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_mfa_challenge
    ADD CONSTRAINT frs_mfa_challenge_challenge_token_key UNIQUE (challenge_token);


--
-- Name: frs_mfa_challenge frs_mfa_challenge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_mfa_challenge
    ADD CONSTRAINT frs_mfa_challenge_pkey PRIMARY KEY (pk_challenge_id);


--
-- Name: frs_nug_box frs_nug_box_device_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_nug_box
    ADD CONSTRAINT frs_nug_box_device_code_key UNIQUE (device_code);


--
-- Name: frs_nug_box frs_nug_box_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_nug_box
    ADD CONSTRAINT frs_nug_box_pkey PRIMARY KEY (pk_nug_id);


--
-- Name: frs_site frs_site_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_site
    ADD CONSTRAINT frs_site_pkey PRIMARY KEY (pk_site_id);


--
-- Name: frs_telemetry_history frs_telemetry_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_telemetry_history
    ADD CONSTRAINT frs_telemetry_history_pkey PRIMARY KEY (pk_history_id);


--
-- Name: frs_tenant frs_tenant_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_tenant
    ADD CONSTRAINT frs_tenant_pkey PRIMARY KEY (pk_tenant_id);


--
-- Name: frs_tenant_user_map frs_tenant_user_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_tenant_user_map
    ADD CONSTRAINT frs_tenant_user_map_pkey PRIMARY KEY (fk_user_id, fk_tenant_id);


--
-- Name: frs_unit frs_unit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_unit
    ADD CONSTRAINT frs_unit_pkey PRIMARY KEY (pk_unit_id);


--
-- Name: frs_user frs_user_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_user
    ADD CONSTRAINT frs_user_email_key UNIQUE (email);


--
-- Name: frs_user frs_user_keycloak_sub_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_user
    ADD CONSTRAINT frs_user_keycloak_sub_key UNIQUE (keycloak_sub);


--
-- Name: frs_user_membership frs_user_membership_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_user_membership
    ADD CONSTRAINT frs_user_membership_pkey PRIMARY KEY (pk_membership_id);


--
-- Name: frs_user frs_user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_user
    ADD CONSTRAINT frs_user_pkey PRIMARY KEY (pk_user_id);


--
-- Name: frs_watchlist_person frs_watchlist_person_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_watchlist_person
    ADD CONSTRAINT frs_watchlist_person_pkey PRIMARY KEY (pk_person_id);


--
-- Name: frs_watchlist frs_watchlist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_watchlist
    ADD CONSTRAINT frs_watchlist_pkey PRIMARY KEY (pk_watchlist_id);


--
-- Name: frs_zone frs_zone_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_zone
    ADD CONSTRAINT frs_zone_pkey PRIMARY KEY (pk_zone_id);


--
-- Name: gdpr_erasure_requests gdpr_erasure_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gdpr_erasure_requests
    ADD CONSTRAINT gdpr_erasure_requests_pkey PRIMARY KEY (pk_erasure_id);


--
-- Name: group_role_assignment group_role_assignment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_role_assignment
    ADD CONSTRAINT group_role_assignment_pkey PRIMARY KEY (pk_assignment_id);


--
-- Name: group_role_map group_role_map_fk_group_id_fk_role_id_fk_site_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_role_map
    ADD CONSTRAINT group_role_map_fk_group_id_fk_role_id_fk_site_id_key UNIQUE (fk_group_id, fk_role_id, fk_site_id);


--
-- Name: group_role_map group_role_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_role_map
    ADD CONSTRAINT group_role_map_pkey PRIMARY KEY (pk_group_role_id);


--
-- Name: groups groups_name_unique_per_tenant; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_name_unique_per_tenant UNIQUE (fk_tenant_id, name);


--
-- Name: groups groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (pk_group_id);


--
-- Name: hr_department hr_department_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_department
    ADD CONSTRAINT hr_department_pkey PRIMARY KEY (pk_department_id);


--
-- Name: hr_department hr_department_tenant_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_department
    ADD CONSTRAINT hr_department_tenant_id_code_key UNIQUE (tenant_id, code);


--
-- Name: hr_employee hr_employee_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employee
    ADD CONSTRAINT hr_employee_pkey PRIMARY KEY (pk_employee_id);


--
-- Name: hr_employee hr_employee_tenant_id_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employee
    ADD CONSTRAINT hr_employee_tenant_id_email_key UNIQUE (tenant_id, email);


--
-- Name: hr_employee hr_employee_tenant_id_employee_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employee
    ADD CONSTRAINT hr_employee_tenant_id_employee_code_key UNIQUE (tenant_id, employee_code);


--
-- Name: hr_roster hr_roster_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_roster
    ADD CONSTRAINT hr_roster_pkey PRIMARY KEY (pk_roster_id);


--
-- Name: hr_shift hr_shift_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_shift
    ADD CONSTRAINT hr_shift_pkey PRIMARY KEY (pk_shift_id);


--
-- Name: nav_item nav_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nav_item
    ADD CONSTRAINT nav_item_pkey PRIMARY KEY (pk_nav_item_id);


--
-- Name: nav_item nav_item_role_name_item_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nav_item
    ADD CONSTRAINT nav_item_role_name_item_key_key UNIQUE (role_name, item_key);


--
-- Name: rbac_permission rbac_permission_permission_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_permission
    ADD CONSTRAINT rbac_permission_permission_code_key UNIQUE (permission_code);


--
-- Name: rbac_permission rbac_permission_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_permission
    ADD CONSTRAINT rbac_permission_pkey PRIMARY KEY (pk_permission_id);


--
-- Name: rbac_role_permission rbac_role_permission_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_role_permission
    ADD CONSTRAINT rbac_role_permission_pkey PRIMARY KEY (fk_role_id, fk_permission_id);


--
-- Name: rbac_role rbac_role_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_role
    ADD CONSTRAINT rbac_role_pkey PRIMARY KEY (pk_role_id);


--
-- Name: rbac_role rbac_role_role_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_role
    ADD CONSTRAINT rbac_role_role_name_key UNIQUE (role_name);


--
-- Name: report_schedules report_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_schedules
    ADD CONSTRAINT report_schedules_pkey PRIMARY KEY (pk_schedule_id);


--
-- Name: role_capability_grant role_capability_grant_grantor_role_grantee_role_capability_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_capability_grant
    ADD CONSTRAINT role_capability_grant_grantor_role_grantee_role_capability_key UNIQUE (grantor_role, grantee_role, capability);


--
-- Name: role_capability_grant role_capability_grant_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_capability_grant
    ADD CONSTRAINT role_capability_grant_pkey PRIMARY KEY (pk_grant_id);


--
-- Name: role_scope_mapping role_scope_mapping_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_scope_mapping
    ADD CONSTRAINT role_scope_mapping_pkey PRIMARY KEY (fk_role_id, fk_scope_id);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (pk_role_id);


--
-- Name: scopes scopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scopes
    ADD CONSTRAINT scopes_pkey PRIMARY KEY (pk_scope_id);


--
-- Name: scopes scopes_scope_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scopes
    ADD CONSTRAINT scopes_scope_code_key UNIQUE (scope_code);


--
-- Name: site_device_assignment site_device_assignment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_device_assignment
    ADD CONSTRAINT site_device_assignment_pkey PRIMARY KEY (pk_assignment_id);


--
-- Name: slo_measurements slo_measurements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slo_measurements
    ADD CONSTRAINT slo_measurements_pkey PRIMARY KEY (pk_measurement_id);


--
-- Name: student_attendance student_attendance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_attendance
    ADD CONSTRAINT student_attendance_pkey PRIMARY KEY (pk_attendance_id);


--
-- Name: subscription_plans subscription_plans_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plans
    ADD CONSTRAINT subscription_plans_name_key UNIQUE (name);


--
-- Name: subscription_plans subscription_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plans
    ADD CONSTRAINT subscription_plans_pkey PRIMARY KEY (pk_plan_id);


--
-- Name: system_alert system_alert_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_alert
    ADD CONSTRAINT system_alert_pkey PRIMARY KEY (pk_alert_id);


--
-- Name: tenant_holidays tenant_holidays_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_holidays
    ADD CONSTRAINT tenant_holidays_pkey PRIMARY KEY (pk_holiday_id);


--
-- Name: tenant_realm tenant_realm_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_realm
    ADD CONSTRAINT tenant_realm_pkey PRIMARY KEY (pk_realm_id);


--
-- Name: tenant_realm tenant_realm_unique_slug; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_realm
    ADD CONSTRAINT tenant_realm_unique_slug UNIQUE (realm_slug);


--
-- Name: tenant_realm tenant_realm_unique_tenant; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_realm
    ADD CONSTRAINT tenant_realm_unique_tenant UNIQUE (fk_tenant_id);


--
-- Name: tenant_settings tenant_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_settings
    ADD CONSTRAINT tenant_settings_pkey PRIMARY KEY (fk_tenant_id);


--
-- Name: tenant_subscriptions tenant_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_subscriptions
    ADD CONSTRAINT tenant_subscriptions_pkey PRIMARY KEY (pk_subscription_id);


--
-- Name: tenant_type_feature_map tenant_type_feature_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_type_feature_map
    ADD CONSTRAINT tenant_type_feature_map_pkey PRIMARY KEY (fk_tenant_type_id, feature_key);


--
-- Name: tenant_type tenant_type_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_type
    ADD CONSTRAINT tenant_type_pkey PRIMARY KEY (pk_tenant_type_id);


--
-- Name: tenant_type tenant_type_type_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_type
    ADD CONSTRAINT tenant_type_type_name_key UNIQUE (type_name);


--
-- Name: tenant_ui_config tenant_ui_config_fk_tenant_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_ui_config
    ADD CONSTRAINT tenant_ui_config_fk_tenant_id_key UNIQUE (fk_tenant_id);


--
-- Name: tenant_ui_config tenant_ui_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_ui_config
    ADD CONSTRAINT tenant_ui_config_pkey PRIMARY KEY (pk_config_id);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (pk_tenant_id);


--
-- Name: tenants tenants_slug_unique_per_parent; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_slug_unique_per_parent UNIQUE (parent_id, slug);


--
-- Name: unauthorized_access_log unauthorized_access_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unauthorized_access_log
    ADD CONSTRAINT unauthorized_access_log_pkey PRIMARY KEY (pk_log_id);


--
-- Name: hr_roster uq_roster_emp_date; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_roster
    ADD CONSTRAINT uq_roster_emp_date UNIQUE (tenant_id, fk_employee_id, roster_date);


--
-- Name: student_attendance uq_student_attendance_per_day; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_attendance
    ADD CONSTRAINT uq_student_attendance_per_day UNIQUE (fk_student_id, attendance_date);


--
-- Name: user_group_assignment user_group_assignment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_assignment
    ADD CONSTRAINT user_group_assignment_pkey PRIMARY KEY (fk_user_id, fk_group_id);


--
-- Name: user_group_map user_group_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_map
    ADD CONSTRAINT user_group_map_pkey PRIMARY KEY (fk_user_id, fk_group_id);


--
-- Name: user_invite user_invite_invite_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_invite
    ADD CONSTRAINT user_invite_invite_token_key UNIQUE (invite_token);


--
-- Name: user_invite user_invite_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_invite
    ADD CONSTRAINT user_invite_pkey PRIMARY KEY (pk_invite_id);


--
-- Name: user_role user_role_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_role
    ADD CONSTRAINT user_role_pkey PRIMARY KEY (pk_user_role_id);


--
-- Name: _archived_users_060 users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._archived_users_060
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: _archived_users_060 users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._archived_users_060
    ADD CONSTRAINT users_pkey PRIMARY KEY (pk_user_id);


--
-- Name: _archived_users_060 users_sso_provider_external_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._archived_users_060
    ADD CONSTRAINT users_sso_provider_external_unique UNIQUE (sso_provider, sso_external_id);


--
-- Name: _archived_users_060 users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._archived_users_060
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: idx_abe_bias_flag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_abe_bias_flag ON public.ai_bias_evaluations USING btree (bias_flag) WHERE (bias_flag = true);


--
-- Name: idx_abe_tenant_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_abe_tenant_date ON public.ai_bias_evaluations USING btree (tenant_id, evaluation_date DESC);


--
-- Name: idx_activation_pin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activation_pin ON public.device_activation_code USING btree (activation_pin);


--
-- Name: idx_ads_drift_flag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ads_drift_flag ON public.ai_drift_snapshots USING btree (drift_flag) WHERE (drift_flag = true);


--
-- Name: idx_ads_tenant_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ads_tenant_date ON public.ai_drift_snapshots USING btree (tenant_id, snapshot_date DESC);


--
-- Name: idx_alert_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_created ON public.frs_alert USING btree (created_at DESC);


--
-- Name: idx_alert_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_severity ON public.frs_alert USING btree (severity);


--
-- Name: idx_alert_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_site ON public.frs_alert USING btree (site_id) WHERE (site_id IS NOT NULL);


--
-- Name: idx_alert_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_status ON public.frs_alert USING btree (status);


--
-- Name: idx_alert_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_tenant ON public.frs_alert USING btree (tenant_id);


--
-- Name: idx_attendance_employee_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attendance_employee_date ON public.attendance_record USING btree (fk_employee_id, attendance_date DESC);


--
-- Name: idx_attendance_record_mt_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attendance_record_mt_tenant ON public.attendance_record USING btree (mt_tenant_id);


--
-- Name: idx_audit_log_mt_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_log_mt_tenant ON public.audit_log USING btree (mt_tenant_id);


--
-- Name: idx_auth_session_token_access; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_session_token_access ON public.auth_session_token USING btree (access_token);


--
-- Name: idx_auth_session_token_refresh; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_session_token_refresh ON public.auth_session_token USING btree (refresh_token);


--
-- Name: idx_bc_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bc_employee ON public.biometric_consent USING btree (fk_employee_id);


--
-- Name: idx_bc_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bc_tenant ON public.biometric_consent USING btree (tenant_id);


--
-- Name: idx_bc_withdrawn; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bc_withdrawn ON public.biometric_consent USING btree (withdrawn_at) WHERE (withdrawn_at IS NULL);


--
-- Name: idx_confrev_confidence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_confrev_confidence ON public.frs_confidence_review USING btree (ai_confidence);


--
-- Name: idx_confrev_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_confrev_created ON public.frs_confidence_review USING btree (created_at DESC);


--
-- Name: idx_confrev_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_confrev_status ON public.frs_confidence_review USING btree (tenant_id, review_status);


--
-- Name: idx_confrev_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_confrev_tenant ON public.frs_confidence_review USING btree (tenant_id);


--
-- Name: idx_device_events_device_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_events_device_time ON public.device_events USING btree (fk_device_id, occurred_at DESC);


--
-- Name: idx_device_events_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_events_lookup ON public.device_events USING btree (tenant_id, event_type, received_at DESC);


--
-- Name: idx_device_events_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_events_pending ON public.device_events USING btree (processed, received_at) WHERE (processed = false);


--
-- Name: idx_device_events_type_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_events_type_time ON public.device_events USING btree (event_type, occurred_at DESC);


--
-- Name: idx_device_events_unprocessed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_events_unprocessed ON public.device_events USING btree (processing_status);


--
-- Name: idx_devices_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_code ON public.devices USING btree (device_code);


--
-- Name: idx_devices_heartbeat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_heartbeat ON public.devices USING btree (last_heartbeat_at);


--
-- Name: idx_devices_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_site ON public.devices USING btree (fk_site_id);


--
-- Name: idx_devices_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_status ON public.devices USING btree (status);


--
-- Name: idx_dtr_device_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dtr_device_id ON public.device_token_revocations USING btree (device_id);


--
-- Name: idx_dtr_jti; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dtr_jti ON public.device_token_revocations USING btree (jti);


--
-- Name: idx_edc_invitation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edc_invitation ON public.enrollment_duplicate_checks USING btree (invitation_id);


--
-- Name: idx_edc_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edc_status ON public.enrollment_duplicate_checks USING btree (status) WHERE ((status)::text = 'flagged'::text);


--
-- Name: idx_edu_student_class; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edu_student_class ON public.edu_student USING btree (fk_tenant_id, class_label) WHERE (is_active = true);


--
-- Name: idx_edu_student_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edu_student_tenant ON public.edu_student USING btree (fk_tenant_id);


--
-- Name: idx_ei_purge_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ei_purge_pending ON public.enrollment_invitations USING btree (pk_invitation_id) WHERE (((embedding_status)::text = 'complete'::text) AND (photos_purged_at IS NULL));


--
-- Name: idx_employee_face_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employee_face_hnsw ON public.employee_face_embeddings USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: idx_enrollment_invitations_mt_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enrollment_invitations_mt_tenant ON public.enrollment_invitations USING btree (mt_tenant_id);


--
-- Name: idx_facility_device_mt_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_facility_device_mt_tenant ON public.facility_device USING btree (mt_tenant_id);


--
-- Name: idx_fe_unencrypted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fe_unencrypted ON public.employee_face_embeddings USING btree (id) WHERE (encrypted_embedding IS NULL);


--
-- Name: idx_frs_alert_mt_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_frs_alert_mt_tenant ON public.frs_alert USING btree (mt_tenant_id);


--
-- Name: idx_frs_building_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_frs_building_site ON public.frs_building USING btree (fk_site_id);


--
-- Name: idx_frs_camera_cam_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_frs_camera_cam_id ON public.frs_camera USING btree (cam_id);


--
-- Name: idx_frs_camera_nug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_frs_camera_nug ON public.frs_camera USING btree (fk_nug_id);


--
-- Name: idx_frs_floor_building; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_frs_floor_building ON public.frs_floor USING btree (fk_building_id);


--
-- Name: idx_frs_incident_mt_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_frs_incident_mt_tenant ON public.frs_incident USING btree (mt_tenant_id);


--
-- Name: idx_frs_nug_device_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_frs_nug_device_code ON public.frs_nug_box USING btree (device_code);


--
-- Name: idx_frs_nug_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_frs_nug_site ON public.frs_nug_box USING btree (fk_site_id);


--
-- Name: idx_frs_nug_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_frs_nug_status ON public.frs_nug_box USING btree (status);


--
-- Name: idx_frs_site_keycloak_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_frs_site_keycloak_org ON public.frs_site USING btree (keycloak_org_id);


--
-- Name: idx_frs_site_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_frs_site_status ON public.frs_site USING btree (status);


--
-- Name: idx_frs_user_keycloak_sub; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_frs_user_keycloak_sub ON public.frs_user USING btree (keycloak_sub);


--
-- Name: idx_frs_user_membership_mt_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_frs_user_membership_mt_tenant ON public.frs_user_membership USING btree (mt_tenant_id);


--
-- Name: idx_frs_zone_floor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_frs_zone_floor ON public.frs_zone USING btree (fk_floor_id);


--
-- Name: idx_ger_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ger_employee ON public.gdpr_erasure_requests USING btree (fk_employee_id);


--
-- Name: idx_ger_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ger_status ON public.gdpr_erasure_requests USING btree (status) WHERE ((status)::text <> 'complete'::text);


--
-- Name: idx_gra_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gra_role ON public.group_role_assignment USING btree (fk_role_id);


--
-- Name: idx_gra_scope_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gra_scope_tenant ON public.group_role_assignment USING btree (fk_scope_tenant_id);


--
-- Name: idx_groups_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_groups_tenant ON public.groups USING btree (fk_tenant_id);


--
-- Name: idx_hr_employee_mt_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hr_employee_mt_tenant ON public.hr_employee USING btree (mt_tenant_id);


--
-- Name: idx_hr_roster_tenant_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hr_roster_tenant_date ON public.hr_roster USING btree (tenant_id, roster_date);


--
-- Name: idx_incident_assigned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_incident_assigned ON public.frs_incident USING btree (assigned_to) WHERE (assigned_to IS NOT NULL);


--
-- Name: idx_incident_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_incident_created ON public.frs_incident USING btree (created_at DESC);


--
-- Name: idx_incident_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_incident_status ON public.frs_incident USING btree (status);


--
-- Name: idx_incident_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_incident_tenant ON public.frs_incident USING btree (tenant_id);


--
-- Name: idx_invitation_approval; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitation_approval ON public.enrollment_invitations USING btree (approval_status);


--
-- Name: idx_invitation_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitation_employee ON public.enrollment_invitations USING btree (fk_employee_id);


--
-- Name: idx_invitation_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitation_status ON public.enrollment_invitations USING btree (status);


--
-- Name: idx_invitation_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitation_token ON public.enrollment_invitations USING btree (invitation_token);


--
-- Name: idx_membership_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_membership_user ON public.frs_user_membership USING btree (fk_user_id);


--
-- Name: idx_mfa_challenge_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mfa_challenge_token ON public.frs_mfa_challenge USING btree (challenge_token);


--
-- Name: idx_mfa_challenge_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mfa_challenge_user ON public.frs_mfa_challenge USING btree (user_id);


--
-- Name: idx_nav_item_vertical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nav_item_vertical ON public.nav_item USING btree (role_name, vertical);


--
-- Name: idx_rbac_perm_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rbac_perm_category ON public.rbac_permission USING btree (category);


--
-- Name: idx_role_scope_mapping_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_role_scope_mapping_scope ON public.role_scope_mapping USING btree (fk_scope_id);


--
-- Name: idx_roles_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roles_tenant ON public.roles USING btree (fk_tenant_id);


--
-- Name: idx_rrp_perm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rrp_perm ON public.rbac_role_permission USING btree (fk_permission_id);


--
-- Name: idx_rrp_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rrp_role ON public.rbac_role_permission USING btree (fk_role_id);


--
-- Name: idx_scopes_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scopes_action ON public.scopes USING btree (action);


--
-- Name: idx_scopes_menu; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scopes_menu ON public.scopes USING btree (menu_name, sub_menu);


--
-- Name: idx_scopes_vertical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scopes_vertical ON public.scopes USING btree (vertical);


--
-- Name: idx_session_invitation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_session_invitation ON public.enrollment_session_progress USING btree (fk_invitation_id);


--
-- Name: idx_slo_failures; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_slo_failures ON public.slo_measurements USING btree (slo_overall_pass) WHERE (slo_overall_pass = false);


--
-- Name: idx_slo_measured_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_slo_measured_at ON public.slo_measurements USING btree (measured_at DESC);


--
-- Name: idx_slo_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_slo_type ON public.slo_measurements USING btree (test_type, measured_at DESC);


--
-- Name: idx_student_attendance_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_attendance_status ON public.student_attendance USING btree (fk_tenant_id, attendance_date, status);


--
-- Name: idx_student_attendance_student_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_attendance_student_date ON public.student_attendance USING btree (fk_student_id, attendance_date DESC);


--
-- Name: idx_student_attendance_tenant_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_attendance_tenant_date ON public.student_attendance USING btree (fk_tenant_id, attendance_date DESC);


--
-- Name: idx_student_face_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_face_hnsw ON public.edu_student_face_embedding USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: idx_student_face_student; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_face_student ON public.edu_student_face_embedding USING btree (fk_student_id);


--
-- Name: idx_system_alert_mt_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_alert_mt_tenant ON public.system_alert USING btree (mt_tenant_id);


--
-- Name: idx_telemetry_nug_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telemetry_nug_time ON public.frs_telemetry_history USING btree (fk_nug_id, "timestamp" DESC);


--
-- Name: idx_tenant_holidays_tenant_year; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_holidays_tenant_year ON public.tenant_holidays USING btree (fk_tenant_id, date);


--
-- Name: idx_tenant_subscriptions_plan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_subscriptions_plan ON public.tenant_subscriptions USING btree (fk_plan_id);


--
-- Name: idx_tenants_hierarchy_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenants_hierarchy_path ON public.tenants USING btree (hierarchy_path varchar_pattern_ops);


--
-- Name: idx_tenants_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenants_kind ON public.tenants USING btree (tenant_kind);


--
-- Name: idx_tenants_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenants_parent ON public.tenants USING btree (parent_id);


--
-- Name: idx_tenants_root; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenants_root ON public.tenants USING btree (root_id);


--
-- Name: idx_tenants_status_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenants_status_active ON public.tenants USING btree (status) WHERE ((status)::text = 'active'::text);


--
-- Name: idx_tenants_vertical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenants_vertical ON public.tenants USING btree (vertical);


--
-- Name: idx_timeline_incident; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_timeline_incident ON public.frs_incident_timeline USING btree (fk_incident_id);


--
-- Name: idx_uga_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uga_group ON public.user_group_assignment USING btree (fk_group_id);


--
-- Name: idx_unauthorized_access_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_unauthorized_access_tenant ON public.unauthorized_access_log USING btree (tenant_id);


--
-- Name: idx_unauthorized_access_unresolved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_unauthorized_access_unresolved ON public.unauthorized_access_log USING btree (resolved_at) WHERE (resolved_at IS NULL);


--
-- Name: idx_user_invite_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_invite_token ON public.user_invite USING btree (invite_token);


--
-- Name: idx_user_invite_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_invite_user ON public.user_invite USING btree (fk_user_id);


--
-- Name: idx_user_role_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_role_site ON public.user_role USING btree (fk_site_id);


--
-- Name: idx_user_role_user_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_role_user_active ON public.user_role USING btree (fk_user_id, is_active);


--
-- Name: idx_users_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_active ON public._archived_users_060 USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_users_home_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_home_tenant ON public._archived_users_060 USING btree (home_tenant_id);


--
-- Name: idx_watchlist_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watchlist_active ON public.frs_watchlist USING btree (tenant_id, is_active);


--
-- Name: idx_watchlist_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watchlist_tenant ON public.frs_watchlist USING btree (tenant_id);


--
-- Name: idx_wlperson_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wlperson_active ON public.frs_watchlist_person USING btree (tenant_id, is_active);


--
-- Name: idx_wlperson_list; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wlperson_list ON public.frs_watchlist_person USING btree (fk_watchlist_id);


--
-- Name: idx_wlperson_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wlperson_tenant ON public.frs_watchlist_person USING btree (tenant_id);


--
-- Name: uq_edu_student_admission_per_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_edu_student_admission_per_tenant ON public.edu_student USING btree (fk_tenant_id, admission_number) WHERE ((admission_number IS NOT NULL) AND (is_active = true) AND (deleted_at IS NULL));


--
-- Name: uq_edu_student_roll_per_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_edu_student_roll_per_tenant ON public.edu_student USING btree (fk_tenant_id, roll_number) WHERE ((roll_number IS NOT NULL) AND (is_active = true) AND (deleted_at IS NULL));


--
-- Name: uq_gra_no_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_gra_no_scope ON public.group_role_assignment USING btree (fk_group_id, fk_role_id) WHERE (fk_scope_tenant_id IS NULL);


--
-- Name: uq_gra_with_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_gra_with_scope ON public.group_role_assignment USING btree (fk_group_id, fk_role_id, fk_scope_tenant_id) WHERE (fk_scope_tenant_id IS NOT NULL);


--
-- Name: uq_roles_system_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_roles_system_name ON public.roles USING btree (name) WHERE (fk_tenant_id IS NULL);


--
-- Name: uq_roles_tenant_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_roles_tenant_name ON public.roles USING btree (fk_tenant_id, name) WHERE (fk_tenant_id IS NOT NULL);


--
-- Name: uq_site_device_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_site_device_active ON public.site_device_assignment USING btree (site_id, device_id) WHERE (is_active = true);


--
-- Name: uq_student_face_primary; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_student_face_primary ON public.edu_student_face_embedding USING btree (fk_student_id) WHERE (is_primary = true);


--
-- Name: uq_tenant_subscriptions_active_one; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_tenant_subscriptions_active_one ON public.tenant_subscriptions USING btree (fk_tenant_id) WHERE ((status)::text = 'active'::text);


--
-- Name: uq_user_role_global; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_user_role_global ON public.user_role USING btree (fk_user_id, fk_role_id) WHERE ((fk_site_id IS NULL) AND (is_active = true));


--
-- Name: uq_user_role_site; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_user_role_site ON public.user_role USING btree (fk_user_id, fk_role_id, fk_site_id) WHERE ((fk_site_id IS NOT NULL) AND (is_active = true));


--
-- Name: audit_log audit_log_hash_chain; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_log_hash_chain BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.set_audit_log_hash();


--
-- Name: audit_log audit_log_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_log_immutable BEFORE DELETE OR UPDATE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_modification();


--
-- Name: employee_face_embeddings trg_sync_face_enrolled; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_face_enrolled AFTER INSERT OR DELETE ON public.employee_face_embeddings FOR EACH ROW EXECUTE FUNCTION public.sync_face_enrolled();


--
-- Name: frs_group trigger_sync_frs_group; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_sync_frs_group AFTER INSERT OR DELETE OR UPDATE ON public.frs_group FOR EACH ROW EXECUTE FUNCTION public.sync_frs_group_to_groups();


--
-- Name: frs_tenant trigger_sync_frs_tenant; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_sync_frs_tenant AFTER INSERT OR DELETE OR UPDATE ON public.frs_tenant FOR EACH ROW EXECUTE FUNCTION public.sync_frs_tenant_to_tenants();


--
-- Name: groups trigger_sync_groups; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_sync_groups AFTER INSERT OR DELETE OR UPDATE ON public.groups FOR EACH ROW EXECUTE FUNCTION public.sync_groups_to_frs_group();


--
-- Name: tenants trigger_sync_tenants; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_sync_tenants AFTER INSERT OR DELETE OR UPDATE ON public.tenants FOR EACH ROW EXECUTE FUNCTION public.sync_tenants_to_frs_tenant();


--
-- Name: enrollment_invitations trigger_update_enrollment_invitation_timestamp; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_update_enrollment_invitation_timestamp BEFORE UPDATE ON public.enrollment_invitations FOR EACH ROW EXECUTE FUNCTION public.update_enrollment_invitation_timestamp();


--
-- Name: devices update_devices_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_devices_updated_at BEFORE UPDATE ON public.devices FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: ai_drift_snapshots ai_drift_snapshots_mt_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_drift_snapshots
    ADD CONSTRAINT ai_drift_snapshots_mt_tenant_id_fkey FOREIGN KEY (mt_tenant_id) REFERENCES public.tenants(pk_tenant_id);


--
-- Name: attendance_events attendance_events_fk_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_events
    ADD CONSTRAINT attendance_events_fk_employee_id_fkey FOREIGN KEY (fk_employee_id) REFERENCES public.hr_employee(pk_employee_id);


--
-- Name: attendance_events attendance_events_fk_original_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_events
    ADD CONSTRAINT attendance_events_fk_original_event_id_fkey FOREIGN KEY (fk_original_event_id) REFERENCES public.device_events(pk_event_id);


--
-- Name: attendance_events attendance_events_fk_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_events
    ADD CONSTRAINT attendance_events_fk_shift_id_fkey FOREIGN KEY (fk_shift_id) REFERENCES public.hr_shift(pk_shift_id);


--
-- Name: attendance_record attendance_record_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_record
    ADD CONSTRAINT attendance_record_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.frs_customer(pk_customer_id);


--
-- Name: attendance_record attendance_record_fk_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_record
    ADD CONSTRAINT attendance_record_fk_employee_id_fkey FOREIGN KEY (fk_employee_id) REFERENCES public.hr_employee(pk_employee_id);


--
-- Name: attendance_record attendance_record_mt_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_record
    ADD CONSTRAINT attendance_record_mt_tenant_id_fkey FOREIGN KEY (mt_tenant_id) REFERENCES public.tenants(pk_tenant_id);


--
-- Name: attendance_record attendance_record_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_record
    ADD CONSTRAINT attendance_record_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.frs_site(pk_site_id);


--
-- Name: attendance_record attendance_record_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_record
    ADD CONSTRAINT attendance_record_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.frs_tenant(pk_tenant_id);


--
-- Name: attendance_record attendance_record_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_record
    ADD CONSTRAINT attendance_record_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.frs_unit(pk_unit_id);


--
-- Name: audit_log audit_log_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.frs_customer(pk_customer_id);


--
-- Name: audit_log audit_log_fk_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_fk_user_id_fkey FOREIGN KEY (fk_user_id) REFERENCES public.frs_user(pk_user_id);


--
-- Name: audit_log audit_log_mt_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_mt_tenant_id_fkey FOREIGN KEY (mt_tenant_id) REFERENCES public.tenants(pk_tenant_id);


--
-- Name: audit_log audit_log_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.frs_site(pk_site_id);


--
-- Name: audit_log audit_log_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.frs_tenant(pk_tenant_id);


--
-- Name: audit_log audit_log_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.frs_unit(pk_unit_id);


--
-- Name: auth_session_token auth_session_token_fk_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session_token
    ADD CONSTRAINT auth_session_token_fk_user_id_fkey FOREIGN KEY (fk_user_id) REFERENCES public.frs_user(pk_user_id);


--
-- Name: biometric_consent biometric_consent_fk_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.biometric_consent
    ADD CONSTRAINT biometric_consent_fk_employee_id_fkey FOREIGN KEY (fk_employee_id) REFERENCES public.hr_employee(pk_employee_id) ON DELETE CASCADE;


--
-- Name: completed_report_runs completed_report_runs_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.completed_report_runs
    ADD CONSTRAINT completed_report_runs_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES public.report_schedules(pk_schedule_id) ON DELETE SET NULL;


--
-- Name: device_activation_code device_activation_code_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_activation_code
    ADD CONSTRAINT device_activation_code_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.frs_user(pk_user_id) ON DELETE SET NULL;


--
-- Name: device_activation_code device_activation_code_fk_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_activation_code
    ADD CONSTRAINT device_activation_code_fk_site_id_fkey FOREIGN KEY (fk_site_id) REFERENCES public.frs_site(pk_site_id) ON DELETE SET NULL;


--
-- Name: device_activation_code device_activation_code_fk_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_activation_code
    ADD CONSTRAINT device_activation_code_fk_tenant_id_fkey FOREIGN KEY (fk_tenant_id) REFERENCES public.frs_tenant(pk_tenant_id) ON DELETE CASCADE;


--
-- Name: device_command_queue device_command_queue_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_command_queue
    ADD CONSTRAINT device_command_queue_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.facility_device(pk_device_id);


--
-- Name: device_events device_events_mt_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_events
    ADD CONSTRAINT device_events_mt_tenant_id_fkey FOREIGN KEY (mt_tenant_id) REFERENCES public.tenants(pk_tenant_id);


--
-- Name: device_heartbeat device_heartbeat_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_heartbeat
    ADD CONSTRAINT device_heartbeat_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.facility_device(pk_device_id);


--
-- Name: device_status_history device_status_history_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_status_history
    ADD CONSTRAINT device_status_history_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.facility_device(pk_device_id);


--
-- Name: device_token_revocations device_token_revocations_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_token_revocations
    ADD CONSTRAINT device_token_revocations_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.facility_device(pk_device_id) ON DELETE CASCADE;


--
-- Name: device_token_revocations device_token_revocations_revoked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_token_revocations
    ADD CONSTRAINT device_token_revocations_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES public.frs_user(pk_user_id);


--
-- Name: edu_student_face_embedding edu_student_face_embedding_enrolled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edu_student_face_embedding
    ADD CONSTRAINT edu_student_face_embedding_enrolled_by_fkey FOREIGN KEY (enrolled_by) REFERENCES public._archived_users_060(pk_user_id);


--
-- Name: edu_student_face_embedding edu_student_face_embedding_fk_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edu_student_face_embedding
    ADD CONSTRAINT edu_student_face_embedding_fk_student_id_fkey FOREIGN KEY (fk_student_id) REFERENCES public.edu_student(pk_student_id) ON DELETE CASCADE;


--
-- Name: edu_student edu_student_fk_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edu_student
    ADD CONSTRAINT edu_student_fk_tenant_id_fkey FOREIGN KEY (fk_tenant_id) REFERENCES public.tenants(pk_tenant_id) ON DELETE RESTRICT;


--
-- Name: employee_face_embeddings employee_face_embeddings_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_face_embeddings
    ADD CONSTRAINT employee_face_embeddings_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employee(pk_employee_id) ON DELETE CASCADE;


--
-- Name: employee_face_embeddings employee_face_embeddings_enrolled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_face_embeddings
    ADD CONSTRAINT employee_face_embeddings_enrolled_by_fkey FOREIGN KEY (enrolled_by) REFERENCES public.frs_user(pk_user_id);


--
-- Name: enrollment_duplicate_checks enrollment_duplicate_checks_duplicate_emp_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_duplicate_checks
    ADD CONSTRAINT enrollment_duplicate_checks_duplicate_emp_id_fkey FOREIGN KEY (duplicate_emp_id) REFERENCES public.hr_employee(pk_employee_id);


--
-- Name: enrollment_duplicate_checks enrollment_duplicate_checks_invitation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_duplicate_checks
    ADD CONSTRAINT enrollment_duplicate_checks_invitation_id_fkey FOREIGN KEY (invitation_id) REFERENCES public.enrollment_invitations(pk_invitation_id) ON DELETE CASCADE;


--
-- Name: enrollment_duplicate_checks enrollment_duplicate_checks_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_duplicate_checks
    ADD CONSTRAINT enrollment_duplicate_checks_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.frs_user(pk_user_id);


--
-- Name: enrollment_invitations enrollment_invitations_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_invitations
    ADD CONSTRAINT enrollment_invitations_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.frs_user(pk_user_id);


--
-- Name: enrollment_invitations enrollment_invitations_consent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_invitations
    ADD CONSTRAINT enrollment_invitations_consent_id_fkey FOREIGN KEY (consent_id) REFERENCES public.biometric_consent(pk_consent_id);


--
-- Name: enrollment_invitations enrollment_invitations_fk_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_invitations
    ADD CONSTRAINT enrollment_invitations_fk_employee_id_fkey FOREIGN KEY (fk_employee_id) REFERENCES public.hr_employee(pk_employee_id) ON DELETE CASCADE;


--
-- Name: enrollment_invitations enrollment_invitations_mt_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_invitations
    ADD CONSTRAINT enrollment_invitations_mt_tenant_id_fkey FOREIGN KEY (mt_tenant_id) REFERENCES public.tenants(pk_tenant_id);


--
-- Name: enrollment_session_progress enrollment_session_progress_fk_invitation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_session_progress
    ADD CONSTRAINT enrollment_session_progress_fk_invitation_id_fkey FOREIGN KEY (fk_invitation_id) REFERENCES public.enrollment_invitations(pk_invitation_id) ON DELETE CASCADE;


--
-- Name: facility_device facility_device_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facility_device
    ADD CONSTRAINT facility_device_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.frs_customer(pk_customer_id);


--
-- Name: facility_device facility_device_device_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facility_device
    ADD CONSTRAINT facility_device_device_type_id_fkey FOREIGN KEY (device_type_id) REFERENCES public.device_type(pk_device_type_id);


--
-- Name: facility_device facility_device_mt_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facility_device
    ADD CONSTRAINT facility_device_mt_tenant_id_fkey FOREIGN KEY (mt_tenant_id) REFERENCES public.tenants(pk_tenant_id);


--
-- Name: facility_device facility_device_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facility_device
    ADD CONSTRAINT facility_device_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.frs_site(pk_site_id);


--
-- Name: facility_device facility_device_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facility_device
    ADD CONSTRAINT facility_device_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.frs_tenant(pk_tenant_id);


--
-- Name: facility_device facility_device_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facility_device
    ADD CONSTRAINT facility_device_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.frs_unit(pk_unit_id);


--
-- Name: frs_alert frs_alert_mt_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_alert
    ADD CONSTRAINT frs_alert_mt_tenant_id_fkey FOREIGN KEY (mt_tenant_id) REFERENCES public.tenants(pk_tenant_id);


--
-- Name: frs_camera frs_camera_fk_floor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_camera
    ADD CONSTRAINT frs_camera_fk_floor_id_fkey FOREIGN KEY (fk_floor_id) REFERENCES public.frs_floor(pk_floor_id) ON DELETE SET NULL;


--
-- Name: frs_camera frs_camera_fk_nug_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_camera
    ADD CONSTRAINT frs_camera_fk_nug_id_fkey FOREIGN KEY (fk_nug_id) REFERENCES public.frs_nug_box(pk_nug_id) ON DELETE SET NULL;


--
-- Name: frs_camera frs_camera_fk_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_camera
    ADD CONSTRAINT frs_camera_fk_zone_id_fkey FOREIGN KEY (fk_zone_id) REFERENCES public.frs_zone(pk_zone_id) ON DELETE SET NULL;


--
-- Name: frs_confidence_review frs_confidence_review_reviewer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_confidence_review
    ADD CONSTRAINT frs_confidence_review_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES public.frs_user(pk_user_id);


--
-- Name: frs_confidence_threshold frs_confidence_threshold_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_confidence_threshold
    ADD CONSTRAINT frs_confidence_threshold_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.frs_user(pk_user_id);


--
-- Name: frs_customer frs_customer_fk_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_customer
    ADD CONSTRAINT frs_customer_fk_tenant_id_fkey FOREIGN KEY (fk_tenant_id) REFERENCES public.frs_tenant(pk_tenant_id);


--
-- Name: frs_customer_user_map frs_customer_user_map_fk_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_customer_user_map
    ADD CONSTRAINT frs_customer_user_map_fk_customer_id_fkey FOREIGN KEY (fk_customer_id) REFERENCES public.frs_customer(pk_customer_id);


--
-- Name: frs_customer_user_map frs_customer_user_map_fk_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_customer_user_map
    ADD CONSTRAINT frs_customer_user_map_fk_user_id_fkey FOREIGN KEY (fk_user_id) REFERENCES public.frs_user(pk_user_id);


--
-- Name: frs_floor frs_floor_fk_building_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_floor
    ADD CONSTRAINT frs_floor_fk_building_id_fkey FOREIGN KEY (fk_building_id) REFERENCES public.frs_building(pk_building_id) ON DELETE CASCADE;


--
-- Name: frs_group frs_group_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_group
    ADD CONSTRAINT frs_group_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.frs_user(pk_user_id) ON DELETE SET NULL;


--
-- Name: frs_group frs_group_fk_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_group
    ADD CONSTRAINT frs_group_fk_tenant_id_fkey FOREIGN KEY (fk_tenant_id) REFERENCES public.frs_tenant(pk_tenant_id) ON DELETE CASCADE;


--
-- Name: frs_incident frs_incident_mt_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_incident
    ADD CONSTRAINT frs_incident_mt_tenant_id_fkey FOREIGN KEY (mt_tenant_id) REFERENCES public.tenants(pk_tenant_id);


--
-- Name: frs_incident_timeline frs_incident_timeline_fk_incident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_incident_timeline
    ADD CONSTRAINT frs_incident_timeline_fk_incident_id_fkey FOREIGN KEY (fk_incident_id) REFERENCES public.frs_incident(pk_incident_id) ON DELETE CASCADE;


--
-- Name: frs_incident_timeline frs_incident_timeline_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_incident_timeline
    ADD CONSTRAINT frs_incident_timeline_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.frs_user(pk_user_id);


--
-- Name: frs_mfa_challenge frs_mfa_challenge_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_mfa_challenge
    ADD CONSTRAINT frs_mfa_challenge_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.frs_user(pk_user_id) ON DELETE CASCADE;


--
-- Name: frs_nug_box frs_nug_box_fk_building_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_nug_box
    ADD CONSTRAINT frs_nug_box_fk_building_id_fkey FOREIGN KEY (fk_building_id) REFERENCES public.frs_building(pk_building_id) ON DELETE SET NULL;


--
-- Name: frs_nug_box frs_nug_box_fk_floor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_nug_box
    ADD CONSTRAINT frs_nug_box_fk_floor_id_fkey FOREIGN KEY (fk_floor_id) REFERENCES public.frs_floor(pk_floor_id) ON DELETE SET NULL;


--
-- Name: frs_nug_box frs_nug_box_fk_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_nug_box
    ADD CONSTRAINT frs_nug_box_fk_zone_id_fkey FOREIGN KEY (fk_zone_id) REFERENCES public.frs_zone(pk_zone_id) ON DELETE SET NULL;


--
-- Name: frs_site frs_site_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_site
    ADD CONSTRAINT frs_site_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.frs_user(pk_user_id);


--
-- Name: frs_site frs_site_fk_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_site
    ADD CONSTRAINT frs_site_fk_customer_id_fkey FOREIGN KEY (fk_customer_id) REFERENCES public.frs_customer(pk_customer_id);


--
-- Name: frs_telemetry_history frs_telemetry_history_fk_nug_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_telemetry_history
    ADD CONSTRAINT frs_telemetry_history_fk_nug_id_fkey FOREIGN KEY (fk_nug_id) REFERENCES public.frs_nug_box(pk_nug_id) ON DELETE CASCADE;


--
-- Name: frs_tenant frs_tenant_fk_tenant_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_tenant
    ADD CONSTRAINT frs_tenant_fk_tenant_type_id_fkey FOREIGN KEY (fk_tenant_type_id) REFERENCES public.tenant_type(pk_tenant_type_id) ON DELETE SET NULL;


--
-- Name: frs_tenant_user_map frs_tenant_user_map_fk_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_tenant_user_map
    ADD CONSTRAINT frs_tenant_user_map_fk_tenant_id_fkey FOREIGN KEY (fk_tenant_id) REFERENCES public.frs_tenant(pk_tenant_id);


--
-- Name: frs_tenant_user_map frs_tenant_user_map_fk_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_tenant_user_map
    ADD CONSTRAINT frs_tenant_user_map_fk_user_id_fkey FOREIGN KEY (fk_user_id) REFERENCES public.frs_user(pk_user_id);


--
-- Name: frs_unit frs_unit_fk_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_unit
    ADD CONSTRAINT frs_unit_fk_site_id_fkey FOREIGN KEY (fk_site_id) REFERENCES public.frs_site(pk_site_id);


--
-- Name: frs_user_membership frs_user_membership_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_user_membership
    ADD CONSTRAINT frs_user_membership_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.frs_customer(pk_customer_id);


--
-- Name: frs_user_membership frs_user_membership_fk_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_user_membership
    ADD CONSTRAINT frs_user_membership_fk_user_id_fkey FOREIGN KEY (fk_user_id) REFERENCES public.frs_user(pk_user_id);


--
-- Name: frs_user_membership frs_user_membership_mt_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_user_membership
    ADD CONSTRAINT frs_user_membership_mt_tenant_id_fkey FOREIGN KEY (mt_tenant_id) REFERENCES public.tenants(pk_tenant_id);


--
-- Name: frs_user_membership frs_user_membership_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_user_membership
    ADD CONSTRAINT frs_user_membership_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.frs_site(pk_site_id);


--
-- Name: frs_user_membership frs_user_membership_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_user_membership
    ADD CONSTRAINT frs_user_membership_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.frs_tenant(pk_tenant_id);


--
-- Name: frs_user_membership frs_user_membership_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_user_membership
    ADD CONSTRAINT frs_user_membership_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.frs_unit(pk_unit_id);


--
-- Name: frs_watchlist frs_watchlist_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_watchlist
    ADD CONSTRAINT frs_watchlist_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.frs_user(pk_user_id);


--
-- Name: frs_watchlist_person frs_watchlist_person_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_watchlist_person
    ADD CONSTRAINT frs_watchlist_person_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.frs_user(pk_user_id);


--
-- Name: frs_watchlist_person frs_watchlist_person_fk_watchlist_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_watchlist_person
    ADD CONSTRAINT frs_watchlist_person_fk_watchlist_id_fkey FOREIGN KEY (fk_watchlist_id) REFERENCES public.frs_watchlist(pk_watchlist_id) ON DELETE CASCADE;


--
-- Name: frs_zone frs_zone_fk_floor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frs_zone
    ADD CONSTRAINT frs_zone_fk_floor_id_fkey FOREIGN KEY (fk_floor_id) REFERENCES public.frs_floor(pk_floor_id) ON DELETE CASCADE;


--
-- Name: gdpr_erasure_requests gdpr_erasure_requests_fk_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gdpr_erasure_requests
    ADD CONSTRAINT gdpr_erasure_requests_fk_employee_id_fkey FOREIGN KEY (fk_employee_id) REFERENCES public.hr_employee(pk_employee_id);


--
-- Name: gdpr_erasure_requests gdpr_erasure_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gdpr_erasure_requests
    ADD CONSTRAINT gdpr_erasure_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.frs_user(pk_user_id);


--
-- Name: group_role_assignment group_role_assignment_fk_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_role_assignment
    ADD CONSTRAINT group_role_assignment_fk_group_id_fkey FOREIGN KEY (fk_group_id) REFERENCES public.groups(pk_group_id) ON DELETE CASCADE;


--
-- Name: group_role_assignment group_role_assignment_fk_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_role_assignment
    ADD CONSTRAINT group_role_assignment_fk_role_id_fkey FOREIGN KEY (fk_role_id) REFERENCES public.roles(pk_role_id) ON DELETE CASCADE;


--
-- Name: group_role_assignment group_role_assignment_fk_scope_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_role_assignment
    ADD CONSTRAINT group_role_assignment_fk_scope_tenant_id_fkey FOREIGN KEY (fk_scope_tenant_id) REFERENCES public.tenants(pk_tenant_id) ON DELETE CASCADE;


--
-- Name: group_role_map group_role_map_fk_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_role_map
    ADD CONSTRAINT group_role_map_fk_group_id_fkey FOREIGN KEY (fk_group_id) REFERENCES public.frs_group(pk_group_id) ON DELETE CASCADE;


--
-- Name: group_role_map group_role_map_fk_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_role_map
    ADD CONSTRAINT group_role_map_fk_role_id_fkey FOREIGN KEY (fk_role_id) REFERENCES public.rbac_role(pk_role_id) ON DELETE CASCADE;


--
-- Name: group_role_map group_role_map_fk_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_role_map
    ADD CONSTRAINT group_role_map_fk_site_id_fkey FOREIGN KEY (fk_site_id) REFERENCES public.frs_site(pk_site_id) ON DELETE CASCADE;


--
-- Name: group_role_map group_role_map_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_role_map
    ADD CONSTRAINT group_role_map_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.frs_user(pk_user_id) ON DELETE SET NULL;


--
-- Name: groups groups_fk_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_fk_tenant_id_fkey FOREIGN KEY (fk_tenant_id) REFERENCES public.tenants(pk_tenant_id) ON DELETE CASCADE;


--
-- Name: hr_department hr_department_head_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_department
    ADD CONSTRAINT hr_department_head_employee_id_fkey FOREIGN KEY (head_employee_id) REFERENCES public.hr_employee(pk_employee_id) ON DELETE SET NULL;


--
-- Name: hr_department hr_department_mt_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_department
    ADD CONSTRAINT hr_department_mt_tenant_id_fkey FOREIGN KEY (mt_tenant_id) REFERENCES public.tenants(pk_tenant_id);


--
-- Name: hr_department hr_department_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_department
    ADD CONSTRAINT hr_department_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.frs_tenant(pk_tenant_id);


--
-- Name: hr_employee hr_employee_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employee
    ADD CONSTRAINT hr_employee_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.frs_customer(pk_customer_id);


--
-- Name: hr_employee hr_employee_fk_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employee
    ADD CONSTRAINT hr_employee_fk_department_id_fkey FOREIGN KEY (fk_department_id) REFERENCES public.hr_department(pk_department_id);


--
-- Name: hr_employee hr_employee_fk_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employee
    ADD CONSTRAINT hr_employee_fk_shift_id_fkey FOREIGN KEY (fk_shift_id) REFERENCES public.hr_shift(pk_shift_id);


--
-- Name: hr_employee hr_employee_mt_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employee
    ADD CONSTRAINT hr_employee_mt_tenant_id_fkey FOREIGN KEY (mt_tenant_id) REFERENCES public.tenants(pk_tenant_id);


--
-- Name: hr_employee hr_employee_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employee
    ADD CONSTRAINT hr_employee_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.frs_site(pk_site_id);


--
-- Name: hr_employee hr_employee_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employee
    ADD CONSTRAINT hr_employee_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.frs_tenant(pk_tenant_id);


--
-- Name: hr_employee hr_employee_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employee
    ADD CONSTRAINT hr_employee_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.frs_unit(pk_unit_id);


--
-- Name: hr_roster hr_roster_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_roster
    ADD CONSTRAINT hr_roster_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.frs_user(pk_user_id);


--
-- Name: hr_roster hr_roster_fk_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_roster
    ADD CONSTRAINT hr_roster_fk_employee_id_fkey FOREIGN KEY (fk_employee_id) REFERENCES public.hr_employee(pk_employee_id) ON DELETE CASCADE;


--
-- Name: hr_roster hr_roster_fk_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_roster
    ADD CONSTRAINT hr_roster_fk_shift_id_fkey FOREIGN KEY (fk_shift_id) REFERENCES public.hr_shift(pk_shift_id);


--
-- Name: hr_roster hr_roster_mt_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_roster
    ADD CONSTRAINT hr_roster_mt_tenant_id_fkey FOREIGN KEY (mt_tenant_id) REFERENCES public.tenants(pk_tenant_id);


--
-- Name: hr_roster hr_roster_swapped_with_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_roster
    ADD CONSTRAINT hr_roster_swapped_with_fkey FOREIGN KEY (swapped_with) REFERENCES public.hr_employee(pk_employee_id);


--
-- Name: hr_roster hr_roster_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_roster
    ADD CONSTRAINT hr_roster_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.frs_tenant(pk_tenant_id) ON DELETE CASCADE;


--
-- Name: hr_shift hr_shift_mt_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_shift
    ADD CONSTRAINT hr_shift_mt_tenant_id_fkey FOREIGN KEY (mt_tenant_id) REFERENCES public.tenants(pk_tenant_id);


--
-- Name: hr_shift hr_shift_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_shift
    ADD CONSTRAINT hr_shift_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.frs_tenant(pk_tenant_id);


--
-- Name: rbac_role_permission rbac_role_permission_fk_permission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_role_permission
    ADD CONSTRAINT rbac_role_permission_fk_permission_id_fkey FOREIGN KEY (fk_permission_id) REFERENCES public.rbac_permission(pk_permission_id) ON DELETE CASCADE;


--
-- Name: rbac_role_permission rbac_role_permission_fk_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rbac_role_permission
    ADD CONSTRAINT rbac_role_permission_fk_role_id_fkey FOREIGN KEY (fk_role_id) REFERENCES public.rbac_role(pk_role_id) ON DELETE CASCADE;


--
-- Name: report_schedules report_schedules_mt_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_schedules
    ADD CONSTRAINT report_schedules_mt_tenant_id_fkey FOREIGN KEY (mt_tenant_id) REFERENCES public.tenants(pk_tenant_id);


--
-- Name: role_scope_mapping role_scope_mapping_fk_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_scope_mapping
    ADD CONSTRAINT role_scope_mapping_fk_role_id_fkey FOREIGN KEY (fk_role_id) REFERENCES public.roles(pk_role_id) ON DELETE CASCADE;


--
-- Name: role_scope_mapping role_scope_mapping_fk_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_scope_mapping
    ADD CONSTRAINT role_scope_mapping_fk_scope_id_fkey FOREIGN KEY (fk_scope_id) REFERENCES public.scopes(pk_scope_id) ON DELETE CASCADE;


--
-- Name: roles roles_fk_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_fk_tenant_id_fkey FOREIGN KEY (fk_tenant_id) REFERENCES public.tenants(pk_tenant_id) ON DELETE CASCADE;


--
-- Name: site_device_assignment site_device_assignment_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_device_assignment
    ADD CONSTRAINT site_device_assignment_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.facility_device(pk_device_id);


--
-- Name: site_device_assignment site_device_assignment_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_device_assignment
    ADD CONSTRAINT site_device_assignment_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.frs_site(pk_site_id);


--
-- Name: student_attendance student_attendance_fk_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_attendance
    ADD CONSTRAINT student_attendance_fk_student_id_fkey FOREIGN KEY (fk_student_id) REFERENCES public.edu_student(pk_student_id) ON DELETE CASCADE;


--
-- Name: student_attendance student_attendance_fk_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_attendance
    ADD CONSTRAINT student_attendance_fk_tenant_id_fkey FOREIGN KEY (fk_tenant_id) REFERENCES public.tenants(pk_tenant_id) ON DELETE RESTRICT;


--
-- Name: student_attendance student_attendance_marked_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_attendance
    ADD CONSTRAINT student_attendance_marked_by_user_id_fkey FOREIGN KEY (marked_by_user_id) REFERENCES public._archived_users_060(pk_user_id);


--
-- Name: system_alert system_alert_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_alert
    ADD CONSTRAINT system_alert_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.frs_customer(pk_customer_id);


--
-- Name: system_alert system_alert_fk_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_alert
    ADD CONSTRAINT system_alert_fk_device_id_fkey FOREIGN KEY (fk_device_id) REFERENCES public.facility_device(pk_device_id);


--
-- Name: system_alert system_alert_fk_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_alert
    ADD CONSTRAINT system_alert_fk_employee_id_fkey FOREIGN KEY (fk_employee_id) REFERENCES public.hr_employee(pk_employee_id);


--
-- Name: system_alert system_alert_mt_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_alert
    ADD CONSTRAINT system_alert_mt_tenant_id_fkey FOREIGN KEY (mt_tenant_id) REFERENCES public.tenants(pk_tenant_id);


--
-- Name: system_alert system_alert_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_alert
    ADD CONSTRAINT system_alert_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.frs_site(pk_site_id);


--
-- Name: system_alert system_alert_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_alert
    ADD CONSTRAINT system_alert_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.frs_tenant(pk_tenant_id);


--
-- Name: system_alert system_alert_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_alert
    ADD CONSTRAINT system_alert_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.frs_unit(pk_unit_id);


--
-- Name: tenant_holidays tenant_holidays_fk_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_holidays
    ADD CONSTRAINT tenant_holidays_fk_tenant_id_fkey FOREIGN KEY (fk_tenant_id) REFERENCES public.frs_tenant(pk_tenant_id) ON DELETE CASCADE;


--
-- Name: tenant_realm tenant_realm_fk_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_realm
    ADD CONSTRAINT tenant_realm_fk_tenant_id_fkey FOREIGN KEY (fk_tenant_id) REFERENCES public.frs_tenant(pk_tenant_id) ON DELETE CASCADE;


--
-- Name: tenant_settings tenant_settings_fk_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_settings
    ADD CONSTRAINT tenant_settings_fk_tenant_id_fkey FOREIGN KEY (fk_tenant_id) REFERENCES public.tenants(pk_tenant_id) ON DELETE CASCADE;


--
-- Name: tenant_subscriptions tenant_subscriptions_fk_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_subscriptions
    ADD CONSTRAINT tenant_subscriptions_fk_plan_id_fkey FOREIGN KEY (fk_plan_id) REFERENCES public.subscription_plans(pk_plan_id);


--
-- Name: tenant_subscriptions tenant_subscriptions_fk_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_subscriptions
    ADD CONSTRAINT tenant_subscriptions_fk_tenant_id_fkey FOREIGN KEY (fk_tenant_id) REFERENCES public.tenants(pk_tenant_id) ON DELETE CASCADE;


--
-- Name: tenant_type_feature_map tenant_type_feature_map_fk_tenant_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_type_feature_map
    ADD CONSTRAINT tenant_type_feature_map_fk_tenant_type_id_fkey FOREIGN KEY (fk_tenant_type_id) REFERENCES public.tenant_type(pk_tenant_type_id) ON DELETE CASCADE;


--
-- Name: tenant_ui_config tenant_ui_config_fk_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_ui_config
    ADD CONSTRAINT tenant_ui_config_fk_tenant_id_fkey FOREIGN KEY (fk_tenant_id) REFERENCES public.frs_tenant(pk_tenant_id) ON DELETE CASCADE;


--
-- Name: tenants tenants_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.tenants(pk_tenant_id) ON DELETE RESTRICT;


--
-- Name: tenants tenants_root_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_root_id_fkey FOREIGN KEY (root_id) REFERENCES public.tenants(pk_tenant_id);


--
-- Name: user_group_assignment user_group_assignment_fk_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_assignment
    ADD CONSTRAINT user_group_assignment_fk_group_id_fkey FOREIGN KEY (fk_group_id) REFERENCES public.groups(pk_group_id) ON DELETE CASCADE;


--
-- Name: user_group_assignment user_group_assignment_fk_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_assignment
    ADD CONSTRAINT user_group_assignment_fk_user_id_fkey FOREIGN KEY (fk_user_id) REFERENCES public._archived_users_060(pk_user_id) ON DELETE CASCADE;


--
-- Name: user_group_map user_group_map_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_map
    ADD CONSTRAINT user_group_map_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.frs_user(pk_user_id) ON DELETE SET NULL;


--
-- Name: user_group_map user_group_map_fk_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_map
    ADD CONSTRAINT user_group_map_fk_group_id_fkey FOREIGN KEY (fk_group_id) REFERENCES public.frs_group(pk_group_id) ON DELETE CASCADE;


--
-- Name: user_group_map user_group_map_fk_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_map
    ADD CONSTRAINT user_group_map_fk_user_id_fkey FOREIGN KEY (fk_user_id) REFERENCES public.frs_user(pk_user_id) ON DELETE CASCADE;


--
-- Name: user_invite user_invite_fk_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_invite
    ADD CONSTRAINT user_invite_fk_user_id_fkey FOREIGN KEY (fk_user_id) REFERENCES public.frs_user(pk_user_id) ON DELETE CASCADE;


--
-- Name: user_invite user_invite_invited_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_invite
    ADD CONSTRAINT user_invite_invited_by_id_fkey FOREIGN KEY (invited_by_id) REFERENCES public.frs_user(pk_user_id);


--
-- Name: user_role user_role_fk_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_role
    ADD CONSTRAINT user_role_fk_role_id_fkey FOREIGN KEY (fk_role_id) REFERENCES public.rbac_role(pk_role_id) ON DELETE RESTRICT;


--
-- Name: user_role user_role_fk_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_role
    ADD CONSTRAINT user_role_fk_site_id_fkey FOREIGN KEY (fk_site_id) REFERENCES public.frs_site(pk_site_id) ON DELETE SET NULL;


--
-- Name: user_role user_role_fk_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_role
    ADD CONSTRAINT user_role_fk_user_id_fkey FOREIGN KEY (fk_user_id) REFERENCES public.frs_user(pk_user_id) ON DELETE CASCADE;


--
-- Name: user_role user_role_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_role
    ADD CONSTRAINT user_role_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.frs_user(pk_user_id) ON DELETE SET NULL;


--
-- Name: _archived_users_060 users_home_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._archived_users_060
    ADD CONSTRAINT users_home_tenant_id_fkey FOREIGN KEY (home_tenant_id) REFERENCES public.tenants(pk_tenant_id) ON DELETE SET NULL;


--
-- Name: ai_drift_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_drift_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: attendance_record; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.attendance_record ENABLE ROW LEVEL SECURITY;

--
-- Name: attendance_record attendance_record_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY attendance_record_tenant_isolation ON public.attendance_record USING (((tenant_id = public.safe_uuid(current_setting('app.tenant_id'::text, true))) OR (current_setting('app.bypass_rls'::text, true) = 'on'::text)));


--
-- Name: audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_log audit_log_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_log_tenant_isolation ON public.audit_log USING (((tenant_id = public.safe_uuid(current_setting('app.tenant_id'::text, true))) OR (current_setting('app.bypass_rls'::text, true) = 'on'::text)));


--
-- Name: device_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.device_events ENABLE ROW LEVEL SECURITY;

--
-- Name: edu_student; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.edu_student ENABLE ROW LEVEL SECURITY;

--
-- Name: enrollment_invitations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.enrollment_invitations ENABLE ROW LEVEL SECURITY;

--
-- Name: enrollment_invitations enrollment_invitations_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY enrollment_invitations_tenant_isolation ON public.enrollment_invitations USING ((EXISTS ( SELECT 1
   FROM public.hr_employee e
  WHERE ((e.pk_employee_id = enrollment_invitations.fk_employee_id) AND ((e.tenant_id = public.safe_uuid(current_setting('app.tenant_id'::text, true))) OR (current_setting('app.bypass_rls'::text, true) = 'on'::text))))));


--
-- Name: facility_device; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.facility_device ENABLE ROW LEVEL SECURITY;

--
-- Name: facility_device facility_device_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY facility_device_tenant_isolation ON public.facility_device USING (((tenant_id = public.safe_uuid(current_setting('app.tenant_id'::text, true))) OR (current_setting('app.bypass_rls'::text, true) = 'on'::text)));


--
-- Name: frs_alert; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.frs_alert ENABLE ROW LEVEL SECURITY;

--
-- Name: frs_incident; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.frs_incident ENABLE ROW LEVEL SECURITY;

--
-- Name: frs_user_membership; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.frs_user_membership ENABLE ROW LEVEL SECURITY;

--
-- Name: hr_department; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hr_department ENABLE ROW LEVEL SECURITY;

--
-- Name: hr_employee; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hr_employee ENABLE ROW LEVEL SECURITY;

--
-- Name: hr_employee hr_employee_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hr_employee_tenant_isolation ON public.hr_employee USING (((tenant_id = public.safe_uuid(current_setting('app.tenant_id'::text, true))) OR (current_setting('app.bypass_rls'::text, true) = 'on'::text)));


--
-- Name: hr_roster; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hr_roster ENABLE ROW LEVEL SECURITY;

--
-- Name: hr_shift; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hr_shift ENABLE ROW LEVEL SECURITY;

--
-- Name: report_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.report_schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: student_attendance; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.student_attendance ENABLE ROW LEVEL SECURITY;

--
-- Name: system_alert; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.system_alert ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_drift_snapshots tenant_isolation_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_policy ON public.ai_drift_snapshots USING (((mt_tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid) OR (current_setting('app.bypass_rls'::text, true) = 'true'::text)));


--
-- Name: attendance_record tenant_isolation_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_policy ON public.attendance_record USING (((mt_tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid) OR (current_setting('app.bypass_rls'::text, true) = 'true'::text)));


--
-- Name: audit_log tenant_isolation_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_policy ON public.audit_log USING (((mt_tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid) OR (current_setting('app.bypass_rls'::text, true) = 'true'::text)));


--
-- Name: device_events tenant_isolation_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_policy ON public.device_events USING (((mt_tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid) OR (current_setting('app.bypass_rls'::text, true) = 'true'::text)));


--
-- Name: edu_student tenant_isolation_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_policy ON public.edu_student USING (((fk_tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid) OR (current_setting('app.bypass_rls'::text, true) = 'true'::text)));


--
-- Name: enrollment_invitations tenant_isolation_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_policy ON public.enrollment_invitations USING (((mt_tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid) OR (current_setting('app.bypass_rls'::text, true) = 'true'::text)));


--
-- Name: facility_device tenant_isolation_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_policy ON public.facility_device USING (((mt_tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid) OR (current_setting('app.bypass_rls'::text, true) = 'true'::text)));


--
-- Name: frs_alert tenant_isolation_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_policy ON public.frs_alert USING (((mt_tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid) OR (current_setting('app.bypass_rls'::text, true) = 'true'::text)));


--
-- Name: frs_incident tenant_isolation_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_policy ON public.frs_incident USING (((mt_tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid) OR (current_setting('app.bypass_rls'::text, true) = 'true'::text)));


--
-- Name: frs_user_membership tenant_isolation_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_policy ON public.frs_user_membership USING (((mt_tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid) OR (current_setting('app.bypass_rls'::text, true) = 'true'::text)));


--
-- Name: hr_department tenant_isolation_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_policy ON public.hr_department USING (((mt_tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid) OR (current_setting('app.bypass_rls'::text, true) = 'true'::text)));


--
-- Name: hr_employee tenant_isolation_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_policy ON public.hr_employee USING (((mt_tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid) OR (current_setting('app.bypass_rls'::text, true) = 'true'::text)));


--
-- Name: hr_roster tenant_isolation_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_policy ON public.hr_roster USING (((mt_tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid) OR (current_setting('app.bypass_rls'::text, true) = 'true'::text)));


--
-- Name: hr_shift tenant_isolation_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_policy ON public.hr_shift USING (((mt_tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid) OR (current_setting('app.bypass_rls'::text, true) = 'true'::text)));


--
-- Name: report_schedules tenant_isolation_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_policy ON public.report_schedules USING (((mt_tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid) OR (current_setting('app.bypass_rls'::text, true) = 'true'::text)));


--
-- Name: student_attendance tenant_isolation_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_policy ON public.student_attendance USING (((fk_tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid) OR (current_setting('app.bypass_rls'::text, true) = 'true'::text)));


--
-- Name: system_alert tenant_isolation_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_policy ON public.system_alert USING (((mt_tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid) OR (current_setting('app.bypass_rls'::text, true) = 'true'::text)));


--
-- PostgreSQL database dump complete
--


--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: rbac_permission; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.rbac_permission VALUES (1, 'system.settings.read', 'system', 'View System Settings', NULL, false, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (2, 'system.settings.write', 'system', 'Edit System Settings', NULL, false, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (3, 'system.audit.read', 'system', 'View Audit Logs', NULL, false, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (4, 'sites.read', 'sites', 'View Sites', NULL, false, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (5, 'sites.write', 'sites', 'Create / Edit Sites', NULL, false, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (6, 'sites.delete', 'sites', 'Delete Sites', NULL, false, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (7, 'devices.read', 'devices', 'View Devices', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (8, 'devices.write', 'devices', 'Add / Edit Devices', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (9, 'devices.reboot', 'devices', 'Reboot Devices', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (10, 'devices.configure', 'devices', 'Configure Device Settings', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (11, 'devices.provision', 'devices', 'Provision New Devices', NULL, false, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (12, 'devices.decommission', 'devices', 'Decommission Devices', NULL, false, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (13, 'employees.read', 'employees', 'View Employees', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (14, 'employees.write', 'employees', 'Add / Edit Employees', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (15, 'employees.delete', 'employees', 'Permanently Delete Employees', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (16, 'employees.deactivate', 'employees', 'Deactivate Employees (soft disable)', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (17, 'employees.bulk_import', 'employees', 'Bulk Import Employees', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (18, 'employees.bulk_assign', 'employees', 'Bulk Assign Employees to Site/Shift', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (19, 'attendance.read', 'attendance', 'View Attendance Records', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (20, 'attendance.write', 'attendance', 'Record Attendance', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (21, 'attendance.correct', 'attendance', 'Directly Correct Attendance Records', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (22, 'attendance.correct_request', 'attendance', 'Submit Attendance Correction Request', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (23, 'shifts.read', 'shifts', 'View Shift Definitions', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (24, 'shifts.write', 'shifts', 'Create / Edit Shifts', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (25, 'shifts.assign', 'shifts', 'Assign Shifts to Employees', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (26, 'reports.generate', 'reports', 'Generate Reports', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (27, 'reports.export', 'reports', 'Export Reports', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (28, 'users.read', 'users', 'View Users', NULL, false, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (29, 'users.write', 'users', 'Create / Edit Users', NULL, false, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (30, 'users.roles.manage', 'users', 'Assign / Revoke Roles', NULL, false, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (31, 'alerts.read', 'alerts', 'View Alerts', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (32, 'alerts.acknowledge', 'alerts', 'Acknowledge Alerts', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (33, 'alerts.configure', 'alerts', 'Configure Alert Rules', NULL, false, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (34, 'breaks.configure', 'workforce', 'Configure Break Rules', NULL, true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_permission VALUES (35, 'overtime.configure', 'workforce', 'Configure Overtime Rules', NULL, true, '2026-05-31 11:21:57.616566+05:30');


--
-- Data for Name: rbac_role; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.rbac_role VALUES (1, 'super_admin', 'Super Admin', 'Full system access across all sites and tenants. Role assignment must be global (fk_site_id = NULL). Only role with hard-delete, provisioning, and role-management permissions.', 'global', true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_role VALUES (2, 'site_admin', 'Site Admin', 'Full management of one assigned site: devices, employees, shifts, leave, attendance, and HR user creation. Role assignment must include a specific site (fk_site_id IS NOT NULL). Cannot create/delete sites, provision/decommission devices, or manage other site admins.', 'site', true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_role VALUES (3, 'hr_manager', 'HR Manager', 'Employee lifecycle and attendance management. No access to devices, sites, system settings, or user management. Can be assigned globally (all sites) or scoped to a single site.', 'flexible', true, '2026-05-31 11:21:57.616566+05:30');
INSERT INTO public.rbac_role VALUES (4, 'viewer', 'Viewer', 'Read-only access to attendance and analytics. Scoping is flexible.', 'flexible', true, '2026-05-31 11:21:58.309845+05:30');
INSERT INTO public.rbac_role VALUES (5, 'device_operator', 'Device Operator', 'Access only to read device status and telemetry. Site scoped.', 'site', true, '2026-05-31 11:21:58.309845+05:30');
INSERT INTO public.rbac_role VALUES (7, 'tenant_admin', 'Tenant Admin', 'Full management of one tenant: sites, customers, users, groups, features, UI branding, and analytics. Cannot access cross-tenant system admin features.', 'tenant', true, '2026-05-31 13:08:13.944764+05:30');


--
-- Data for Name: rbac_role_permission; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.rbac_role_permission VALUES (1, 1);
INSERT INTO public.rbac_role_permission VALUES (1, 2);
INSERT INTO public.rbac_role_permission VALUES (1, 3);
INSERT INTO public.rbac_role_permission VALUES (1, 4);
INSERT INTO public.rbac_role_permission VALUES (1, 5);
INSERT INTO public.rbac_role_permission VALUES (1, 6);
INSERT INTO public.rbac_role_permission VALUES (1, 7);
INSERT INTO public.rbac_role_permission VALUES (1, 8);
INSERT INTO public.rbac_role_permission VALUES (1, 9);
INSERT INTO public.rbac_role_permission VALUES (1, 10);
INSERT INTO public.rbac_role_permission VALUES (1, 11);
INSERT INTO public.rbac_role_permission VALUES (1, 12);
INSERT INTO public.rbac_role_permission VALUES (1, 13);
INSERT INTO public.rbac_role_permission VALUES (1, 14);
INSERT INTO public.rbac_role_permission VALUES (1, 15);
INSERT INTO public.rbac_role_permission VALUES (1, 16);
INSERT INTO public.rbac_role_permission VALUES (1, 17);
INSERT INTO public.rbac_role_permission VALUES (1, 18);
INSERT INTO public.rbac_role_permission VALUES (1, 19);
INSERT INTO public.rbac_role_permission VALUES (1, 20);
INSERT INTO public.rbac_role_permission VALUES (1, 21);
INSERT INTO public.rbac_role_permission VALUES (1, 26);
INSERT INTO public.rbac_role_permission VALUES (1, 27);
INSERT INTO public.rbac_role_permission VALUES (1, 28);
INSERT INTO public.rbac_role_permission VALUES (1, 29);
INSERT INTO public.rbac_role_permission VALUES (1, 30);
INSERT INTO public.rbac_role_permission VALUES (1, 31);
INSERT INTO public.rbac_role_permission VALUES (1, 32);
INSERT INTO public.rbac_role_permission VALUES (1, 33);
INSERT INTO public.rbac_role_permission VALUES (2, 4);
INSERT INTO public.rbac_role_permission VALUES (2, 7);
INSERT INTO public.rbac_role_permission VALUES (2, 8);
INSERT INTO public.rbac_role_permission VALUES (2, 9);
INSERT INTO public.rbac_role_permission VALUES (2, 10);
INSERT INTO public.rbac_role_permission VALUES (2, 13);
INSERT INTO public.rbac_role_permission VALUES (2, 14);
INSERT INTO public.rbac_role_permission VALUES (2, 16);
INSERT INTO public.rbac_role_permission VALUES (2, 17);
INSERT INTO public.rbac_role_permission VALUES (2, 18);
INSERT INTO public.rbac_role_permission VALUES (2, 19);
INSERT INTO public.rbac_role_permission VALUES (2, 20);
INSERT INTO public.rbac_role_permission VALUES (2, 22);
INSERT INTO public.rbac_role_permission VALUES (2, 23);
INSERT INTO public.rbac_role_permission VALUES (2, 24);
INSERT INTO public.rbac_role_permission VALUES (2, 25);
INSERT INTO public.rbac_role_permission VALUES (2, 26);
INSERT INTO public.rbac_role_permission VALUES (2, 27);
INSERT INTO public.rbac_role_permission VALUES (2, 28);
INSERT INTO public.rbac_role_permission VALUES (2, 29);
INSERT INTO public.rbac_role_permission VALUES (2, 31);
INSERT INTO public.rbac_role_permission VALUES (2, 32);
INSERT INTO public.rbac_role_permission VALUES (3, 13);
INSERT INTO public.rbac_role_permission VALUES (3, 14);
INSERT INTO public.rbac_role_permission VALUES (3, 16);
INSERT INTO public.rbac_role_permission VALUES (3, 17);
INSERT INTO public.rbac_role_permission VALUES (3, 18);
INSERT INTO public.rbac_role_permission VALUES (3, 19);
INSERT INTO public.rbac_role_permission VALUES (3, 20);
INSERT INTO public.rbac_role_permission VALUES (3, 22);
INSERT INTO public.rbac_role_permission VALUES (3, 23);
INSERT INTO public.rbac_role_permission VALUES (3, 24);
INSERT INTO public.rbac_role_permission VALUES (3, 25);
INSERT INTO public.rbac_role_permission VALUES (3, 26);
INSERT INTO public.rbac_role_permission VALUES (3, 27);
INSERT INTO public.rbac_role_permission VALUES (3, 34);
INSERT INTO public.rbac_role_permission VALUES (3, 35);
INSERT INTO public.rbac_role_permission VALUES (2, 30);
INSERT INTO public.rbac_role_permission VALUES (3, 28);
INSERT INTO public.rbac_role_permission VALUES (3, 30);
INSERT INTO public.rbac_role_permission VALUES (4, 19);
INSERT INTO public.rbac_role_permission VALUES (4, 26);
INSERT INTO public.rbac_role_permission VALUES (4, 27);
INSERT INTO public.rbac_role_permission VALUES (5, 7);
INSERT INTO public.rbac_role_permission VALUES (7, 1);
INSERT INTO public.rbac_role_permission VALUES (7, 3);
INSERT INTO public.rbac_role_permission VALUES (7, 4);
INSERT INTO public.rbac_role_permission VALUES (7, 5);
INSERT INTO public.rbac_role_permission VALUES (7, 6);
INSERT INTO public.rbac_role_permission VALUES (7, 7);
INSERT INTO public.rbac_role_permission VALUES (7, 8);
INSERT INTO public.rbac_role_permission VALUES (7, 9);
INSERT INTO public.rbac_role_permission VALUES (7, 10);
INSERT INTO public.rbac_role_permission VALUES (7, 11);
INSERT INTO public.rbac_role_permission VALUES (7, 12);
INSERT INTO public.rbac_role_permission VALUES (7, 13);
INSERT INTO public.rbac_role_permission VALUES (7, 14);
INSERT INTO public.rbac_role_permission VALUES (7, 15);
INSERT INTO public.rbac_role_permission VALUES (7, 16);
INSERT INTO public.rbac_role_permission VALUES (7, 17);
INSERT INTO public.rbac_role_permission VALUES (7, 18);
INSERT INTO public.rbac_role_permission VALUES (7, 19);
INSERT INTO public.rbac_role_permission VALUES (7, 20);
INSERT INTO public.rbac_role_permission VALUES (7, 21);
INSERT INTO public.rbac_role_permission VALUES (7, 22);
INSERT INTO public.rbac_role_permission VALUES (7, 23);
INSERT INTO public.rbac_role_permission VALUES (7, 24);
INSERT INTO public.rbac_role_permission VALUES (7, 25);
INSERT INTO public.rbac_role_permission VALUES (7, 26);
INSERT INTO public.rbac_role_permission VALUES (7, 27);
INSERT INTO public.rbac_role_permission VALUES (7, 28);
INSERT INTO public.rbac_role_permission VALUES (7, 29);
INSERT INTO public.rbac_role_permission VALUES (7, 30);
INSERT INTO public.rbac_role_permission VALUES (7, 31);
INSERT INTO public.rbac_role_permission VALUES (7, 32);
INSERT INTO public.rbac_role_permission VALUES (7, 33);
INSERT INTO public.rbac_role_permission VALUES (7, 34);
INSERT INTO public.rbac_role_permission VALUES (7, 35);


--
-- Data for Name: roles; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.roles VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'super_admin', 'Super Admin', 'Platform-level administrator with full access', NULL, false, true, true, '2026-05-31 11:21:58.085073+05:30', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.roles VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'tenant_admin', 'Tenant Admin', 'Full access within the assigned tenant subtree', NULL, false, false, true, '2026-05-31 11:21:58.085073+05:30', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.roles VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'site_admin', 'Site Admin', 'Manages a single site and the units beneath it', NULL, false, false, true, '2026-05-31 11:21:58.085073+05:30', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.roles VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'hr_manager', 'HR Manager', 'Employees, attendance, and reports', NULL, true, false, true, '2026-05-31 11:21:58.085073+05:30', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.roles VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', 'viewer', 'Viewer', 'Read-only access within the assigned scope', NULL, false, false, true, '2026-05-31 11:21:58.085073+05:30', '2026-05-31 11:21:58.085073+05:30');


--
-- Data for Name: scopes; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.scopes VALUES ('c7a4ccf7-6c84-47ae-9c2f-b9888d0dde90', 'dashboard.overview.read', 'Dashboard', 'Overview', 'read', 'View dashboard overview', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('16edb6ff-cc0f-475c-9b09-daa121f29090', 'dashboard.analytics.read', 'Dashboard', 'Analytics', 'read', 'View analytics', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('40567616-2588-4b88-a51e-7ad5b14431ca', 'dashboard.analytics.export', 'Dashboard', 'Analytics', 'export', 'Export analytics', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('ce2afe4e-7735-436e-9bf5-10fcb76a1a9e', 'tenants.list.read', 'Tenants', 'List', 'read', 'List tenants', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('5b17c835-fce3-4903-b566-ce800f468d81', 'tenants.list.write', 'Tenants', 'List', 'write', 'Create or edit tenant', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('6a2c46d1-3ea9-4d77-bec1-c3956d016049', 'tenants.list.manage', 'Tenants', 'List', 'manage', 'Suspend or restore tenant', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('6131889a-a5ff-4ae5-acbb-89fc62d3fd89', 'tenants.hierarchy.read', 'Tenants', 'Hierarchy', 'read', 'View tenant tree', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('1f7ee48d-26f3-40cb-b341-22b68b710b82', 'tenants.hierarchy.manage', 'Tenants', 'Hierarchy', 'manage', 'Move tenants within tree', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('263f880f-45fe-466d-b666-ded931f9c518', 'tenants.subscriptions.read', 'Tenants', 'Subscriptions', 'read', 'View tenant subscriptions', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('e885ea78-23af-48c6-aa8d-32fb8bfcce60', 'tenants.subscriptions.manage', 'Tenants', 'Subscriptions', 'manage', 'Assign plan / change quotas', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('0e0a1bb2-db27-44ac-b22d-1c75edc53845', 'users.list.read', 'Users', 'List', 'read', 'List users', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('b7e0d54e-a40a-4823-b538-218c8ef73e27', 'users.list.write', 'Users', 'List', 'write', 'Create or edit user', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('46bb87fc-d348-4011-b7d6-a6790419a2f6', 'users.list.deactivate', 'Users', 'List', 'deactivate', 'Deactivate user', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('6dca2d9c-a0d3-45de-a0a7-d6657deb8be8', 'users.list.manage', 'Users', 'List', 'manage', 'Full user management', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('304acbbd-e0fd-4945-9c4e-c19529b266f2', 'users.roles.read', 'Users', 'Roles', 'read', 'View role assignments', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('bf19debd-540a-40b9-9119-47ac9c361f43', 'users.roles.manage', 'Users', 'Roles', 'manage', 'Assign or revoke roles', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('71cbe6ab-e77e-425b-a4ca-9e4c266d29eb', 'users.groups.read', 'Users', 'Groups', 'read', 'View group memberships', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('02bfbaad-bad1-40db-895e-7466fedc0d73', 'users.groups.manage', 'Users', 'Groups', 'manage', 'Manage group membership', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('68d4aeb6-7fb0-49cf-ab24-d5ed11e10fb9', 'employees.list.read', 'Employees', 'List', 'read', 'View employees', NULL, 'corporate', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('6f8ed687-8f95-4e5b-bf10-5561a5d828aa', 'employees.list.write', 'Employees', 'List', 'write', 'Create or edit employee', NULL, 'corporate', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('4fc697b0-412f-4bd3-85c1-5c184b77d131', 'employees.list.delete', 'Employees', 'List', 'delete', 'Delete employee', NULL, 'corporate', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('24de4b4a-c370-4cdb-885a-d6c674402e01', 'employees.profile.read', 'Employees', 'Profile', 'read', 'View employee profile', NULL, 'corporate', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('b17e8d5e-61d7-405e-87c6-240ab18ca0ad', 'employees.profile.write', 'Employees', 'Profile', 'write', 'Edit employee profile', NULL, 'corporate', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('d5ee5c64-071b-46d1-8476-f3f4d8da65cc', 'employees.bulk.import', 'Employees', 'Bulk', 'import', 'Bulk import employees', NULL, 'corporate', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('e24616e1-e636-4c10-8355-fa234d33b9a8', 'employees.bulk.assign', 'Employees', 'Bulk', 'assign', 'Bulk assign employees', NULL, 'corporate', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('a21cf5fb-22c0-4b56-8fbe-f82282acb48a', 'students.list.read', 'Students', 'List', 'read', 'View students', NULL, 'education', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('d05b4225-6ddc-4171-96ef-8b0fc84a7566', 'students.list.write', 'Students', 'List', 'write', 'Create or edit student', NULL, 'education', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('e6c81b5e-284d-4cda-809b-d586d0585139', 'students.list.delete', 'Students', 'List', 'delete', 'Delete student', NULL, 'education', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('f1f0508d-03a1-4990-8c92-8a06855172e9', 'students.list.manage', 'Students', 'List', 'manage', 'Full student lifecycle', NULL, 'education', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('bf0e28d3-1c0b-4050-a41e-dc0fa80925a5', 'students.profile.read', 'Students', 'Profile', 'read', 'View student profile', NULL, 'education', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('4f050b76-c2a5-4e6e-940a-c4447be222cb', 'students.profile.write', 'Students', 'Profile', 'write', 'Edit student profile', NULL, 'education', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('e038265e-fd54-4848-8fca-34283dd65772', 'students.bulk.import', 'Students', 'Bulk', 'import', 'Bulk import students', NULL, 'education', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('b9a7f40f-a386-4340-b448-c7db98c2b175', 'students.bulk.assign', 'Students', 'Bulk', 'assign', 'Bulk assign students to classes', NULL, 'education', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('1bbff93c-dabe-4576-8236-854fb06fd03a', 'students.attendance.read', 'Students', 'Attendance', 'read', 'View student attendance', NULL, 'education', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('934a5a31-df0f-4865-b898-92bfc8ba798d', 'students.attendance.write', 'Students', 'Attendance', 'write', 'Edit student attendance', NULL, 'education', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('b123e4f5-c31e-423d-a006-23fa6d774540', 'students.attendance.correct', 'Students', 'Attendance', 'correct', 'Approve student attendance correction', NULL, 'education', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('e3cde11b-81ab-4d31-90d0-e5251595cf8d', 'students.attendance.export', 'Students', 'Attendance', 'export', 'Export student attendance', NULL, 'education', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('cdb054f3-66d7-4c54-834e-88add884b40a', 'enrollment.invitations.read', 'Enrollment', 'Invitations', 'read', 'View invitations', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('3ffa55e3-a566-4f8b-99ea-71580e45c4d5', 'enrollment.invitations.write', 'Enrollment', 'Invitations', 'write', 'Send invitation', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('f4f55fe0-b419-443a-89a2-f314b19e3ea1', 'enrollment.approvals.read', 'Enrollment', 'Approvals', 'read', 'View pending approvals', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('a287c480-3498-4030-89e2-f8b65ccefbf1', 'enrollment.approvals.approve', 'Enrollment', 'Approvals', 'approve', 'Approve enrollment', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('414f07da-98ef-45b7-9946-8d9fa74e157d', 'attendance.calendar.read', 'Attendance', 'Calendar', 'read', 'View attendance calendar', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('8a233c71-b0f6-4f73-ba8c-c0b484c1eee5', 'attendance.status.read', 'Attendance', 'Status', 'read', 'View live status', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('8cbb717e-adf2-406a-8c84-04585ee5d5be', 'attendance.records.read', 'Attendance', 'Records', 'read', 'View attendance records', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('e994c570-7ae7-4dc1-b4d7-cac3fa424a10', 'attendance.records.write', 'Attendance', 'Records', 'write', 'Edit attendance records', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('b1d82467-1a00-48d8-b216-cd8882ecaf20', 'attendance.records.correct', 'Attendance', 'Records', 'correct', 'Approve correction requests', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('f63f2166-b279-4593-b040-97baf37301fa', 'attendance.shifts.read', 'Attendance', 'Shifts', 'read', 'View shifts', NULL, 'corporate', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('c3c47777-a93a-42f5-b3e9-e6f3576704b6', 'attendance.shifts.write', 'Attendance', 'Shifts', 'write', 'Create or edit shifts', NULL, 'corporate', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('6876ba3a-4d4a-49fd-a320-c732014ad35a', 'attendance.shifts.assign', 'Attendance', 'Shifts', 'assign', 'Assign shifts to employees', NULL, 'corporate', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('4d838746-66f9-440c-ad5d-b0e38e5da52e', 'attendance.rosters.read', 'Attendance', 'Rosters', 'read', 'View rosters', NULL, 'corporate', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('aba30fdd-2bf7-4a75-9e19-a6d1a6fe4bf0', 'attendance.rosters.write', 'Attendance', 'Rosters', 'write', 'Edit rosters', NULL, 'corporate', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('7abbf519-288e-465d-b615-544704139acf', 'attendance.leaves.read', 'Attendance', 'Leaves', 'read', 'View leave requests', NULL, 'corporate', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('a5b2b2d3-573c-4086-b3ea-c2e738b31739', 'attendance.leaves.write', 'Attendance', 'Leaves', 'write', 'Approve / edit leave', NULL, 'corporate', true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('f8c7d876-6d7d-415d-bbdd-98769ad7468e', 'devices.list.read', 'Devices', 'List', 'read', 'View devices', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('6d2a0739-2417-4414-881d-70c945779bc2', 'devices.list.write', 'Devices', 'List', 'write', 'Edit device metadata', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('800dde02-70af-4df5-8773-e28327da62ac', 'devices.provisioning.provision', 'Devices', 'Provisioning', 'provision', 'Provision device', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('8ed757cd-8c7b-401f-931d-7ecb7883aa03', 'devices.provisioning.decommission', 'Devices', 'Provisioning', 'decommission', 'Decommission device', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('74ccf88b-1c2c-41b9-9482-6ba1d966e404', 'devices.control.reboot', 'Devices', 'Control', 'reboot', 'Reboot device', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('9676ab90-35b6-4bd0-a97e-924460dbbfdc', 'devices.control.configure', 'Devices', 'Control', 'configure', 'Configure device', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('6f316ec5-f916-4251-b675-6003987dc760', 'devices.events.read', 'Devices', 'Events', 'read', 'View device events', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('4d53e118-6b9a-4fa7-9304-927554ed8096', 'sites.list.read', 'Sites', 'List', 'read', 'View sites / campuses', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('123b242d-514b-4311-aabc-1b05db68325d', 'sites.list.write', 'Sites', 'List', 'write', 'Create or edit site / campus', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('493f668f-12c0-4137-ab63-edc4f80bbbe3', 'sites.list.delete', 'Sites', 'List', 'delete', 'Delete site / campus', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('2572adba-c19b-4901-9872-85eabfc349f8', 'sites.list.manage', 'Sites', 'List', 'manage', 'Full site / campus lifecycle', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('8c77414d-c7fe-4688-8ef6-04a71c0dd145', 'sites.settings.read', 'Sites', 'Settings', 'read', 'View site / campus settings', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('1ad09030-377f-4407-9797-e32b9d793e6e', 'sites.settings.write', 'Sites', 'Settings', 'write', 'Edit site / campus settings', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('0641f5f3-4dc8-4be1-84c0-4e599071ed96', 'face_recognition.embeddings.read', 'Face Recognition', 'Embeddings', 'read', 'View face embeddings', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('b2a71af0-11fc-470d-a0ff-4965851c7b2b', 'face_recognition.embeddings.write', 'Face Recognition', 'Embeddings', 'write', 'Edit face embeddings', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('f1c0a3d9-d0b1-4e6f-bfed-82cd28219370', 'face_recognition.matching.configure', 'Face Recognition', 'Matching', 'configure', 'Configure matching thresholds', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('85131977-5e4c-4425-a73c-ed0d1d44776f', 'reports.generate.generate', 'Reports', 'Generate', 'generate', 'Run a report', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('2ca4e37b-efd4-4d54-a477-458125e044f9', 'reports.generate.export', 'Reports', 'Generate', 'export', 'Export report', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('e8ddfa46-4abc-4212-bc52-3256c4685c0d', 'reports.scheduled.read', 'Reports', 'Scheduled', 'read', 'View scheduled reports', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('54b12bde-de18-4e2c-a18f-8e655a5d4c85', 'reports.scheduled.write', 'Reports', 'Scheduled', 'write', 'Schedule reports', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('e9fbb3a9-c245-457f-8658-635e9246438b', 'alerts.list.read', 'Alerts', 'List', 'read', 'View alerts', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('f2e89aa5-bd4e-459f-95f6-7ee7c38fb314', 'alerts.list.acknowledge', 'Alerts', 'List', 'acknowledge', 'Acknowledge alert', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('5e3eb653-7fa4-4301-b62b-a43fc1c5d326', 'alerts.rules.read', 'Alerts', 'Rules', 'read', 'View alert rules', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('2a603174-0b05-4853-9b98-6a4e29c7d9cd', 'alerts.rules.configure', 'Alerts', 'Rules', 'configure', 'Configure alert rules', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('9666acfe-ac07-469a-99bf-21259efabdcc', 'settings.branding.read', 'Settings', 'Branding', 'read', 'View branding', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('96846b8a-cdf0-4f1f-9070-7e328a5b1fec', 'settings.branding.write', 'Settings', 'Branding', 'write', 'Edit branding', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('50d0ca36-c62d-4684-a388-c3cbbb2acab8', 'settings.integrations.read', 'Settings', 'Integrations', 'read', 'View integrations', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('9610864b-9495-4a9b-9cec-90437b64ea1c', 'settings.integrations.write', 'Settings', 'Integrations', 'write', 'Edit integrations', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('bbdcab9d-27b6-4c79-86c2-02a3a8d76520', 'settings.security.read', 'Settings', 'Security', 'read', 'View security settings', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('6c34525d-3cc6-4534-acf8-f0ac3ec18eb2', 'settings.security.write', 'Settings', 'Security', 'write', 'Edit security settings', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('1c89f88e-5770-4da1-9f64-4b9ccbf8e7d2', 'settings.features.read', 'Settings', 'Features', 'read', 'View feature flags', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('563499ec-f751-4310-9d73-88f28dd61f5c', 'system.audit_log.read', 'System', 'Audit Log', 'read', 'View audit log', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('d4747028-10de-4f61-8bc0-3c48d2666211', 'system.health.read', 'System', 'Health', 'read', 'View system health', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('871aefd0-8b96-4cf5-ba12-1d2aa481a260', 'system.configuration.read', 'System', 'Configuration', 'read', 'View system configuration', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('f4286e33-3785-49e6-a408-b93951e9349a', 'system.configuration.write', 'System', 'Configuration', 'write', 'Edit system configuration', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.scopes VALUES ('08ce6b8d-7a53-461c-927b-50665561721a', 'activity.log.read', 'Activity', 'Log', 'read', 'View activity log', NULL, NULL, true, '2026-05-31 11:21:58.085073+05:30');


--
-- Data for Name: role_scope_mapping; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'c7a4ccf7-6c84-47ae-9c2f-b9888d0dde90', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '16edb6ff-cc0f-475c-9b09-daa121f29090', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '40567616-2588-4b88-a51e-7ad5b14431ca', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'ce2afe4e-7735-436e-9bf5-10fcb76a1a9e', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '5b17c835-fce3-4903-b566-ce800f468d81', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '6a2c46d1-3ea9-4d77-bec1-c3956d016049', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '6131889a-a5ff-4ae5-acbb-89fc62d3fd89', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '1f7ee48d-26f3-40cb-b341-22b68b710b82', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '263f880f-45fe-466d-b666-ded931f9c518', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'e885ea78-23af-48c6-aa8d-32fb8bfcce60', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '0e0a1bb2-db27-44ac-b22d-1c75edc53845', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'b7e0d54e-a40a-4823-b538-218c8ef73e27', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '46bb87fc-d348-4011-b7d6-a6790419a2f6', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '6dca2d9c-a0d3-45de-a0a7-d6657deb8be8', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '304acbbd-e0fd-4945-9c4e-c19529b266f2', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'bf19debd-540a-40b9-9119-47ac9c361f43', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '71cbe6ab-e77e-425b-a4ca-9e4c266d29eb', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '02bfbaad-bad1-40db-895e-7466fedc0d73', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '68d4aeb6-7fb0-49cf-ab24-d5ed11e10fb9', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '6f8ed687-8f95-4e5b-bf10-5561a5d828aa', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '4fc697b0-412f-4bd3-85c1-5c184b77d131', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '24de4b4a-c370-4cdb-885a-d6c674402e01', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'b17e8d5e-61d7-405e-87c6-240ab18ca0ad', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'd5ee5c64-071b-46d1-8476-f3f4d8da65cc', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'e24616e1-e636-4c10-8355-fa234d33b9a8', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'a21cf5fb-22c0-4b56-8fbe-f82282acb48a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'd05b4225-6ddc-4171-96ef-8b0fc84a7566', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'e6c81b5e-284d-4cda-809b-d586d0585139', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'f1f0508d-03a1-4990-8c92-8a06855172e9', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'bf0e28d3-1c0b-4050-a41e-dc0fa80925a5', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '4f050b76-c2a5-4e6e-940a-c4447be222cb', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'e038265e-fd54-4848-8fca-34283dd65772', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'b9a7f40f-a386-4340-b448-c7db98c2b175', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '1bbff93c-dabe-4576-8236-854fb06fd03a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '934a5a31-df0f-4865-b898-92bfc8ba798d', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'b123e4f5-c31e-423d-a006-23fa6d774540', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'e3cde11b-81ab-4d31-90d0-e5251595cf8d', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'cdb054f3-66d7-4c54-834e-88add884b40a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '3ffa55e3-a566-4f8b-99ea-71580e45c4d5', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'f4f55fe0-b419-443a-89a2-f314b19e3ea1', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'a287c480-3498-4030-89e2-f8b65ccefbf1', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '414f07da-98ef-45b7-9946-8d9fa74e157d', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '8a233c71-b0f6-4f73-ba8c-c0b484c1eee5', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '8cbb717e-adf2-406a-8c84-04585ee5d5be', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'e994c570-7ae7-4dc1-b4d7-cac3fa424a10', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'b1d82467-1a00-48d8-b216-cd8882ecaf20', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'f63f2166-b279-4593-b040-97baf37301fa', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'c3c47777-a93a-42f5-b3e9-e6f3576704b6', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '6876ba3a-4d4a-49fd-a320-c732014ad35a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '4d838746-66f9-440c-ad5d-b0e38e5da52e', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'aba30fdd-2bf7-4a75-9e19-a6d1a6fe4bf0', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '7abbf519-288e-465d-b615-544704139acf', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'a5b2b2d3-573c-4086-b3ea-c2e738b31739', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'f8c7d876-6d7d-415d-bbdd-98769ad7468e', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '6d2a0739-2417-4414-881d-70c945779bc2', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '800dde02-70af-4df5-8773-e28327da62ac', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '8ed757cd-8c7b-401f-931d-7ecb7883aa03', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '74ccf88b-1c2c-41b9-9482-6ba1d966e404', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '9676ab90-35b6-4bd0-a97e-924460dbbfdc', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '6f316ec5-f916-4251-b675-6003987dc760', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '4d53e118-6b9a-4fa7-9304-927554ed8096', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '123b242d-514b-4311-aabc-1b05db68325d', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '493f668f-12c0-4137-ab63-edc4f80bbbe3', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '2572adba-c19b-4901-9872-85eabfc349f8', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '8c77414d-c7fe-4688-8ef6-04a71c0dd145', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '1ad09030-377f-4407-9797-e32b9d793e6e', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '0641f5f3-4dc8-4be1-84c0-4e599071ed96', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'b2a71af0-11fc-470d-a0ff-4965851c7b2b', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'f1c0a3d9-d0b1-4e6f-bfed-82cd28219370', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '85131977-5e4c-4425-a73c-ed0d1d44776f', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '2ca4e37b-efd4-4d54-a477-458125e044f9', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'e8ddfa46-4abc-4212-bc52-3256c4685c0d', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '54b12bde-de18-4e2c-a18f-8e655a5d4c85', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'e9fbb3a9-c245-457f-8658-635e9246438b', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'f2e89aa5-bd4e-459f-95f6-7ee7c38fb314', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '5e3eb653-7fa4-4301-b62b-a43fc1c5d326', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '2a603174-0b05-4853-9b98-6a4e29c7d9cd', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '9666acfe-ac07-469a-99bf-21259efabdcc', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '96846b8a-cdf0-4f1f-9070-7e328a5b1fec', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '50d0ca36-c62d-4684-a388-c3cbbb2acab8', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '9610864b-9495-4a9b-9cec-90437b64ea1c', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'bbdcab9d-27b6-4c79-86c2-02a3a8d76520', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '6c34525d-3cc6-4534-acf8-f0ac3ec18eb2', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '1c89f88e-5770-4da1-9f64-4b9ccbf8e7d2', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '563499ec-f751-4310-9d73-88f28dd61f5c', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'd4747028-10de-4f61-8bc0-3c48d2666211', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '871aefd0-8b96-4cf5-ba12-1d2aa481a260', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', 'f4286e33-3785-49e6-a408-b93951e9349a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('4fed29ca-7458-4249-b102-c0751fcd4fda', '08ce6b8d-7a53-461c-927b-50665561721a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'c7a4ccf7-6c84-47ae-9c2f-b9888d0dde90', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '16edb6ff-cc0f-475c-9b09-daa121f29090', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '40567616-2588-4b88-a51e-7ad5b14431ca', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '0e0a1bb2-db27-44ac-b22d-1c75edc53845', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'b7e0d54e-a40a-4823-b538-218c8ef73e27', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '46bb87fc-d348-4011-b7d6-a6790419a2f6', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '6dca2d9c-a0d3-45de-a0a7-d6657deb8be8', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '304acbbd-e0fd-4945-9c4e-c19529b266f2', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'bf19debd-540a-40b9-9119-47ac9c361f43', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '71cbe6ab-e77e-425b-a4ca-9e4c266d29eb', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '02bfbaad-bad1-40db-895e-7466fedc0d73', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '68d4aeb6-7fb0-49cf-ab24-d5ed11e10fb9', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '6f8ed687-8f95-4e5b-bf10-5561a5d828aa', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '4fc697b0-412f-4bd3-85c1-5c184b77d131', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '24de4b4a-c370-4cdb-885a-d6c674402e01', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'b17e8d5e-61d7-405e-87c6-240ab18ca0ad', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'd5ee5c64-071b-46d1-8476-f3f4d8da65cc', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'e24616e1-e636-4c10-8355-fa234d33b9a8', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'a21cf5fb-22c0-4b56-8fbe-f82282acb48a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'd05b4225-6ddc-4171-96ef-8b0fc84a7566', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'e6c81b5e-284d-4cda-809b-d586d0585139', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'f1f0508d-03a1-4990-8c92-8a06855172e9', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'bf0e28d3-1c0b-4050-a41e-dc0fa80925a5', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '4f050b76-c2a5-4e6e-940a-c4447be222cb', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'e038265e-fd54-4848-8fca-34283dd65772', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'b9a7f40f-a386-4340-b448-c7db98c2b175', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '1bbff93c-dabe-4576-8236-854fb06fd03a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '934a5a31-df0f-4865-b898-92bfc8ba798d', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'b123e4f5-c31e-423d-a006-23fa6d774540', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'e3cde11b-81ab-4d31-90d0-e5251595cf8d', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'cdb054f3-66d7-4c54-834e-88add884b40a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '3ffa55e3-a566-4f8b-99ea-71580e45c4d5', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'f4f55fe0-b419-443a-89a2-f314b19e3ea1', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'a287c480-3498-4030-89e2-f8b65ccefbf1', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '414f07da-98ef-45b7-9946-8d9fa74e157d', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '8a233c71-b0f6-4f73-ba8c-c0b484c1eee5', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '8cbb717e-adf2-406a-8c84-04585ee5d5be', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'e994c570-7ae7-4dc1-b4d7-cac3fa424a10', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'b1d82467-1a00-48d8-b216-cd8882ecaf20', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'f63f2166-b279-4593-b040-97baf37301fa', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'c3c47777-a93a-42f5-b3e9-e6f3576704b6', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '6876ba3a-4d4a-49fd-a320-c732014ad35a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '4d838746-66f9-440c-ad5d-b0e38e5da52e', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'aba30fdd-2bf7-4a75-9e19-a6d1a6fe4bf0', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '7abbf519-288e-465d-b615-544704139acf', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'a5b2b2d3-573c-4086-b3ea-c2e738b31739', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'f8c7d876-6d7d-415d-bbdd-98769ad7468e', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '6d2a0739-2417-4414-881d-70c945779bc2', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '800dde02-70af-4df5-8773-e28327da62ac', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '8ed757cd-8c7b-401f-931d-7ecb7883aa03', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '74ccf88b-1c2c-41b9-9482-6ba1d966e404', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '9676ab90-35b6-4bd0-a97e-924460dbbfdc', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '6f316ec5-f916-4251-b675-6003987dc760', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '4d53e118-6b9a-4fa7-9304-927554ed8096', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '123b242d-514b-4311-aabc-1b05db68325d', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '493f668f-12c0-4137-ab63-edc4f80bbbe3', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '2572adba-c19b-4901-9872-85eabfc349f8', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '8c77414d-c7fe-4688-8ef6-04a71c0dd145', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '1ad09030-377f-4407-9797-e32b9d793e6e', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '0641f5f3-4dc8-4be1-84c0-4e599071ed96', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'b2a71af0-11fc-470d-a0ff-4965851c7b2b', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'f1c0a3d9-d0b1-4e6f-bfed-82cd28219370', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '85131977-5e4c-4425-a73c-ed0d1d44776f', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '2ca4e37b-efd4-4d54-a477-458125e044f9', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'e8ddfa46-4abc-4212-bc52-3256c4685c0d', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '54b12bde-de18-4e2c-a18f-8e655a5d4c85', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'e9fbb3a9-c245-457f-8658-635e9246438b', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'f2e89aa5-bd4e-459f-95f6-7ee7c38fb314', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '5e3eb653-7fa4-4301-b62b-a43fc1c5d326', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '2a603174-0b05-4853-9b98-6a4e29c7d9cd', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '9666acfe-ac07-469a-99bf-21259efabdcc', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '96846b8a-cdf0-4f1f-9070-7e328a5b1fec', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '50d0ca36-c62d-4684-a388-c3cbbb2acab8', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '9610864b-9495-4a9b-9cec-90437b64ea1c', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', 'bbdcab9d-27b6-4c79-86c2-02a3a8d76520', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '6c34525d-3cc6-4534-acf8-f0ac3ec18eb2', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '1c89f88e-5770-4da1-9f64-4b9ccbf8e7d2', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('b095c520-f8ed-4975-8407-6413fe39591e', '08ce6b8d-7a53-461c-927b-50665561721a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'c7a4ccf7-6c84-47ae-9c2f-b9888d0dde90', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '16edb6ff-cc0f-475c-9b09-daa121f29090', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '40567616-2588-4b88-a51e-7ad5b14431ca', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '68d4aeb6-7fb0-49cf-ab24-d5ed11e10fb9', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '6f8ed687-8f95-4e5b-bf10-5561a5d828aa', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '4fc697b0-412f-4bd3-85c1-5c184b77d131', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '24de4b4a-c370-4cdb-885a-d6c674402e01', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'b17e8d5e-61d7-405e-87c6-240ab18ca0ad', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'd5ee5c64-071b-46d1-8476-f3f4d8da65cc', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'e24616e1-e636-4c10-8355-fa234d33b9a8', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'a21cf5fb-22c0-4b56-8fbe-f82282acb48a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'd05b4225-6ddc-4171-96ef-8b0fc84a7566', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'e6c81b5e-284d-4cda-809b-d586d0585139', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'f1f0508d-03a1-4990-8c92-8a06855172e9', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'bf0e28d3-1c0b-4050-a41e-dc0fa80925a5', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '4f050b76-c2a5-4e6e-940a-c4447be222cb', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'e038265e-fd54-4848-8fca-34283dd65772', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'b9a7f40f-a386-4340-b448-c7db98c2b175', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '1bbff93c-dabe-4576-8236-854fb06fd03a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '934a5a31-df0f-4865-b898-92bfc8ba798d', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'b123e4f5-c31e-423d-a006-23fa6d774540', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'e3cde11b-81ab-4d31-90d0-e5251595cf8d', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '414f07da-98ef-45b7-9946-8d9fa74e157d', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '8a233c71-b0f6-4f73-ba8c-c0b484c1eee5', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '8cbb717e-adf2-406a-8c84-04585ee5d5be', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'e994c570-7ae7-4dc1-b4d7-cac3fa424a10', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'b1d82467-1a00-48d8-b216-cd8882ecaf20', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'f63f2166-b279-4593-b040-97baf37301fa', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'c3c47777-a93a-42f5-b3e9-e6f3576704b6', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '6876ba3a-4d4a-49fd-a320-c732014ad35a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '4d838746-66f9-440c-ad5d-b0e38e5da52e', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'aba30fdd-2bf7-4a75-9e19-a6d1a6fe4bf0', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '7abbf519-288e-465d-b615-544704139acf', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'a5b2b2d3-573c-4086-b3ea-c2e738b31739', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'f8c7d876-6d7d-415d-bbdd-98769ad7468e', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '6d2a0739-2417-4414-881d-70c945779bc2', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '800dde02-70af-4df5-8773-e28327da62ac', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '8ed757cd-8c7b-401f-931d-7ecb7883aa03', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '74ccf88b-1c2c-41b9-9482-6ba1d966e404', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '9676ab90-35b6-4bd0-a97e-924460dbbfdc', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '6f316ec5-f916-4251-b675-6003987dc760', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '4d53e118-6b9a-4fa7-9304-927554ed8096', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '123b242d-514b-4311-aabc-1b05db68325d', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '493f668f-12c0-4137-ab63-edc4f80bbbe3', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '2572adba-c19b-4901-9872-85eabfc349f8', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '8c77414d-c7fe-4688-8ef6-04a71c0dd145', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '1ad09030-377f-4407-9797-e32b9d793e6e', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '0641f5f3-4dc8-4be1-84c0-4e599071ed96', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'b2a71af0-11fc-470d-a0ff-4965851c7b2b', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'f1c0a3d9-d0b1-4e6f-bfed-82cd28219370', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '85131977-5e4c-4425-a73c-ed0d1d44776f', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '2ca4e37b-efd4-4d54-a477-458125e044f9', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'e8ddfa46-4abc-4212-bc52-3256c4685c0d', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '54b12bde-de18-4e2c-a18f-8e655a5d4c85', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'e9fbb3a9-c245-457f-8658-635e9246438b', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', 'f2e89aa5-bd4e-459f-95f6-7ee7c38fb314', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '5e3eb653-7fa4-4301-b62b-a43fc1c5d326', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '2a603174-0b05-4853-9b98-6a4e29c7d9cd', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('f90b15b4-fef6-46e3-ab9d-5b68cb5d81df', '08ce6b8d-7a53-461c-927b-50665561721a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'c7a4ccf7-6c84-47ae-9c2f-b9888d0dde90', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', '16edb6ff-cc0f-475c-9b09-daa121f29090', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', '40567616-2588-4b88-a51e-7ad5b14431ca', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', '68d4aeb6-7fb0-49cf-ab24-d5ed11e10fb9', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', '6f8ed687-8f95-4e5b-bf10-5561a5d828aa', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', '4fc697b0-412f-4bd3-85c1-5c184b77d131', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', '24de4b4a-c370-4cdb-885a-d6c674402e01', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'b17e8d5e-61d7-405e-87c6-240ab18ca0ad', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'd5ee5c64-071b-46d1-8476-f3f4d8da65cc', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'e24616e1-e636-4c10-8355-fa234d33b9a8', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'a21cf5fb-22c0-4b56-8fbe-f82282acb48a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'd05b4225-6ddc-4171-96ef-8b0fc84a7566', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'e6c81b5e-284d-4cda-809b-d586d0585139', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'f1f0508d-03a1-4990-8c92-8a06855172e9', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'bf0e28d3-1c0b-4050-a41e-dc0fa80925a5', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', '4f050b76-c2a5-4e6e-940a-c4447be222cb', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'e038265e-fd54-4848-8fca-34283dd65772', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'b9a7f40f-a386-4340-b448-c7db98c2b175', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', '1bbff93c-dabe-4576-8236-854fb06fd03a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', '934a5a31-df0f-4865-b898-92bfc8ba798d', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'b123e4f5-c31e-423d-a006-23fa6d774540', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'e3cde11b-81ab-4d31-90d0-e5251595cf8d', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'cdb054f3-66d7-4c54-834e-88add884b40a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', '3ffa55e3-a566-4f8b-99ea-71580e45c4d5', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'f4f55fe0-b419-443a-89a2-f314b19e3ea1', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'a287c480-3498-4030-89e2-f8b65ccefbf1', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', '414f07da-98ef-45b7-9946-8d9fa74e157d', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', '8a233c71-b0f6-4f73-ba8c-c0b484c1eee5', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', '8cbb717e-adf2-406a-8c84-04585ee5d5be', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'e994c570-7ae7-4dc1-b4d7-cac3fa424a10', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'b1d82467-1a00-48d8-b216-cd8882ecaf20', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'f63f2166-b279-4593-b040-97baf37301fa', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'c3c47777-a93a-42f5-b3e9-e6f3576704b6', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', '6876ba3a-4d4a-49fd-a320-c732014ad35a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', '4d838746-66f9-440c-ad5d-b0e38e5da52e', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'aba30fdd-2bf7-4a75-9e19-a6d1a6fe4bf0', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', '7abbf519-288e-465d-b615-544704139acf', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'a5b2b2d3-573c-4086-b3ea-c2e738b31739', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', '85131977-5e4c-4425-a73c-ed0d1d44776f', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', '2ca4e37b-efd4-4d54-a477-458125e044f9', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', 'e8ddfa46-4abc-4212-bc52-3256c4685c0d', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('e71d267f-2cad-416a-8500-8c74e0eb81a9', '54b12bde-de18-4e2c-a18f-8e655a5d4c85', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', 'c7a4ccf7-6c84-47ae-9c2f-b9888d0dde90', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', '16edb6ff-cc0f-475c-9b09-daa121f29090', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', '0e0a1bb2-db27-44ac-b22d-1c75edc53845', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', '304acbbd-e0fd-4945-9c4e-c19529b266f2', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', '71cbe6ab-e77e-425b-a4ca-9e4c266d29eb', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', '68d4aeb6-7fb0-49cf-ab24-d5ed11e10fb9', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', '24de4b4a-c370-4cdb-885a-d6c674402e01', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', 'a21cf5fb-22c0-4b56-8fbe-f82282acb48a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', 'bf0e28d3-1c0b-4050-a41e-dc0fa80925a5', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', '1bbff93c-dabe-4576-8236-854fb06fd03a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', 'cdb054f3-66d7-4c54-834e-88add884b40a', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', 'f4f55fe0-b419-443a-89a2-f314b19e3ea1', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', '414f07da-98ef-45b7-9946-8d9fa74e157d', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', '8a233c71-b0f6-4f73-ba8c-c0b484c1eee5', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', '8cbb717e-adf2-406a-8c84-04585ee5d5be', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', 'f63f2166-b279-4593-b040-97baf37301fa', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', '4d838746-66f9-440c-ad5d-b0e38e5da52e', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', '7abbf519-288e-465d-b615-544704139acf', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', 'f8c7d876-6d7d-415d-bbdd-98769ad7468e', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', '6f316ec5-f916-4251-b675-6003987dc760', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', '4d53e118-6b9a-4fa7-9304-927554ed8096', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', '8c77414d-c7fe-4688-8ef6-04a71c0dd145', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', '0641f5f3-4dc8-4be1-84c0-4e599071ed96', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', 'e8ddfa46-4abc-4212-bc52-3256c4685c0d', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', 'e9fbb3a9-c245-457f-8658-635e9246438b', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', '5e3eb653-7fa4-4301-b62b-a43fc1c5d326', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', '9666acfe-ac07-469a-99bf-21259efabdcc', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', '50d0ca36-c62d-4684-a388-c3cbbb2acab8', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', 'bbdcab9d-27b6-4c79-86c2-02a3a8d76520', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', '1c89f88e-5770-4da1-9f64-4b9ccbf8e7d2', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.role_scope_mapping VALUES ('8e376c5a-493b-48e6-aec0-7d80ea7569a7', '08ce6b8d-7a53-461c-927b-50665561721a', '2026-05-31 11:21:58.085073+05:30');


--
-- Data for Name: subscription_plans; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.subscription_plans VALUES ('0f7150c6-23f0-46df-ab15-b70557405f46', 'Basic', 'basic', 'corporate', 'monthly', NULL, 'INR', 25, 1, 3, 5, 100, 90, 30, 1000, '["attendance", "reports"]', '[]', 'Corporate entry-level: attendance and reports', true, '2026-05-31 11:21:58.085073+05:30', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.subscription_plans VALUES ('0d7c2dbd-07e7-49ba-94c7-81b0aa7392e4', 'SMB', 'smb', 'corporate', 'monthly', NULL, 'INR', 100, 3, 10, 25, 500, 365, 90, 5000, '["attendance", "face_recognition", "devices", "reports", "alerts"]', '[]', 'Small/medium businesses: full core features', true, '2026-05-31 11:21:58.085073+05:30', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.subscription_plans VALUES ('90c56fa3-7888-4931-85b9-796893dc2b2b', 'Enterprise', 'enterprise', 'corporate', 'annual', NULL, 'INR', NULL, NULL, NULL, NULL, NULL, 1825, 365, 50000, '["attendance", "face_recognition", "devices", "reports", "alerts", "leave", "hrms_sync", "scheduled_reports", "analytics_export"]', '[]', 'Unlimited capacity with HRMS sync and scheduled exports', true, '2026-05-31 11:21:58.085073+05:30', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.subscription_plans VALUES ('3d2f89a2-38e3-41ab-911e-9b43635dd1ef', 'Internal', 'internal', 'corporate', 'perpetual', NULL, 'INR', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '["attendance", "face_recognition", "devices", "reports", "alerts", "leave", "hrms_sync", "scheduled_reports", "analytics_export", "system_admin", "tenant_admin", "platform_admin"]', '[]', 'Platform-operator self-use: unlimited everything (Motivity Labs)', true, '2026-05-31 11:21:58.085073+05:30', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.subscription_plans VALUES ('c9a9ba6a-df26-4bd4-ba43-13b301d4297f', 'Institute Basic', 'institute', 'education', 'monthly', NULL, 'INR', 500, 2, 20, 25, 2000, 365, 90, 5000, '["student_attendance", "face_recognition", "devices", "reports", "alerts"]', '[]', 'School/college: per-student face-rec attendance, basic reports. No class/period/parent yet.', true, '2026-05-31 11:21:58.085073+05:30', '2026-05-31 11:21:58.085073+05:30');
INSERT INTO public.subscription_plans VALUES ('5cd517ae-9669-40cf-b6fd-1ec7a845dde7', 'School', 'school', 'education', 'monthly', NULL, 'INR', 500, 10, 50, 50, 3000, 730, NULL, 3000, '["student_attendance", "face_recognition", "devices", "reports", "alerts", "parent_notifications", "analytics_export"]', '[]', NULL, true, '2026-05-31 15:26:02.71522+05:30', '2026-05-31 15:26:02.71522+05:30');
INSERT INTO public.subscription_plans VALUES ('14563094-f26a-439a-8ac9-c761b7266ed8', 'University', 'university', 'education', 'monthly', NULL, 'INR', 5000, 50, 200, 200, 30000, 1825, NULL, 10000, '["student_attendance", "face_recognition", "devices", "reports", "alerts", "parent_notifications", "analytics_export", "hrms_sync", "scheduled_reports"]', '[]', NULL, true, '2026-05-31 15:26:02.71522+05:30', '2026-05-31 15:26:02.71522+05:30');


--
-- Name: rbac_permission_pk_permission_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.rbac_permission_pk_permission_id_seq', 35, true);


--
-- Name: rbac_role_pk_role_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.rbac_role_pk_role_id_seq', 7, true);


--
-- PostgreSQL database dump complete
--


