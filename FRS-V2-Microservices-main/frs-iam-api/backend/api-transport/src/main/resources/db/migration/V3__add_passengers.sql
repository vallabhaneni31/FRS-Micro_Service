-- V3__add_passengers.sql
-- Passenger/Rider records — the identity a boarding event can eventually
-- resolve to via face matching (Track B). Depot scoping is transitive
-- through bus_id, same as transport_devices — no depot_id column here.

CREATE TABLE passengers (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL,
    bus_id           UUID NOT NULL REFERENCES buses(id),
    passenger_code   VARCHAR(50) NOT NULL,
    full_name        VARCHAR(200) NOT NULL,
    phone            VARCHAR(20),
    email            VARCHAR(200),
    boarding_stop    VARCHAR(200),
    deboarding_stop  VARCHAR(200),
    status           VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_passengers_tenant_code UNIQUE (tenant_id, passenger_code)
);
CREATE INDEX idx_passengers_tenant_bus ON passengers (tenant_id, bus_id);
