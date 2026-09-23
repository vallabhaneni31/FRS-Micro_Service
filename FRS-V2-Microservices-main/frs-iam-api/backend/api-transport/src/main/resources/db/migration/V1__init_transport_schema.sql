-- V1__init_transport_schema.sql
-- Transport vertical — full schema, isolated to this service's own
-- `transport_intelligence` database. No table here is shared with, or
-- references, the existing platform database (attendance_intelligence) —
-- tenant_id columns below are plain UUID values trusted from the caller's
-- JWT, never a cross-database foreign key (Postgres can't enforce those
-- across databases anyway). See buses.tenant_id comment for how isolation
-- is actually enforced (every query scoped by it).

CREATE TABLE routes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL,
    route_name  VARCHAR(150) NOT NULL,
    stops       JSONB NOT NULL DEFAULT '[]',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_routes_tenant_name UNIQUE (tenant_id, route_name)
);
CREATE INDEX idx_routes_tenant ON routes (tenant_id);

CREATE TABLE buses (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Every table in this schema carries tenant_id directly (not a join
    -- through some other table) so a single `WHERE tenant_id = ?` is the
    -- entire isolation boundary on every query — mirrors how the existing
    -- retail service scopes `stores.tenant_id` (see architecture plan §2).
    tenant_id        UUID NOT NULL,
    bus_code         VARCHAR(50) NOT NULL,
    registration_no  VARCHAR(50),
    route_id         UUID REFERENCES routes(id),
    capacity         INTEGER,
    status           VARCHAR(20) NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','maintenance','retired')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_buses_tenant_code UNIQUE (tenant_id, bus_code)
);
CREATE INDEX idx_buses_tenant ON buses (tenant_id);
CREATE INDEX idx_buses_route ON buses (route_id);

CREATE TABLE transport_devices (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID NOT NULL,
    bus_id             UUID NOT NULL REFERENCES buses(id),
    device_code        VARCHAR(80) NOT NULL,
    -- Per-device signing secret, mirroring api-retail's edge_devices.device_secret
    -- (confirmed decision — see architecture plan §7): each device is its own
    -- independently issued and independently revocable credential, not a
    -- single shared platform secret.
    device_secret      VARCHAR(255) NOT NULL,
    camera_position    VARCHAR(20) NOT NULL
                           CHECK (camera_position IN ('boarding','deboarding')),
    status             VARCHAR(20) NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','maintenance','offline')),
    last_heartbeat     TIMESTAMPTZ,
    decommissioned_at  TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_devices_tenant_code UNIQUE (tenant_id, device_code)
);
CREATE INDEX idx_devices_tenant ON transport_devices (tenant_id);
CREATE INDEX idx_devices_bus ON transport_devices (bus_id);

CREATE TABLE boarding_events (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Producer-supplied idempotency key (one per Jetson-generated event).
    -- Claimed via transport_event_dedup before this row is ever inserted —
    -- see that table's comment.
    event_uid     UUID NOT NULL UNIQUE,
    tenant_id     UUID NOT NULL,
    bus_id        UUID NOT NULL REFERENCES buses(id),
    device_id     UUID NOT NULL REFERENCES transport_devices(id),
    event_type    VARCHAR(12) NOT NULL CHECK (event_type IN ('BOARDING','DEBOARDING')),
    person_ref    VARCHAR(100),
    confidence    NUMERIC(5,4),
    photo_key     VARCHAR(500),
    event_time    TIMESTAMPTZ NOT NULL,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_boarding_events_tenant_bus_time ON boarding_events (tenant_id, bus_id, event_time);

CREATE TABLE occupancy_snapshots (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL,
    -- One current-state row per bus, upserted by the event worker — not a
    -- history table (boarding_events is the immutable log; this is just
    -- "what's the count right now").
    bus_id            UUID NOT NULL UNIQUE REFERENCES buses(id),
    occupancy_count   INTEGER NOT NULL DEFAULT 0 CHECK (occupancy_count >= 0),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_occupancy_tenant ON occupancy_snapshots (tenant_id);

-- Idempotency table for the Kafka transport-event consumer — same pattern as
-- the existing platform's event_dedup (backend/api/src/db/migrations/012_event_dedup.sql),
-- kept in this service's own database since only this service's worker ever
-- reads the topic it protects.
CREATE TABLE transport_event_dedup (
    event_uid   UUID PRIMARY KEY,
    claimed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_transport_event_dedup_claimed_at ON transport_event_dedup (claimed_at);

CREATE TABLE audit_log (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL,
    actor_user_id  VARCHAR(100),
    action         VARCHAR(100) NOT NULL,
    target         VARCHAR(200),
    details        JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_log_tenant_time ON audit_log (tenant_id, created_at);
