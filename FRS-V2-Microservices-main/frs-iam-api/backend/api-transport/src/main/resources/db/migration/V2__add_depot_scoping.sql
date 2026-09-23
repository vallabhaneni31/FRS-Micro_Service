-- V2__add_depot_scoping.sql
-- Depot (location) hierarchy for role-based scoping: Transport Admin sees
-- the whole tenant, Route Manager is scoped to one depot, Operations
-- Manager to one bus. Mirrors the existing platform's site/
-- frs_user_membership pattern in shape only — deliberately does NOT
-- reference frs_site or any table in attendance_intelligence, preserving
-- this service's isolation (no cross-database dependency, nothing here
-- touches or is touched by the shared platform database).

CREATE TABLE depots (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL,
    depot_name  VARCHAR(150) NOT NULL,
    address     VARCHAR(300),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_depots_tenant_name UNIQUE (tenant_id, depot_name)
);
CREATE INDEX idx_depots_tenant ON depots (tenant_id);

-- Additive only: existing rows get depot_id = NULL (unassigned). No NOT
-- NULL added retroactively — "a depot is required for a new bus/route" is
-- an application-layer rule (Phase enforcing it comes later), not a DB
-- constraint that would need every current row to already comply.
ALTER TABLE routes ADD COLUMN depot_id UUID REFERENCES depots(id);
CREATE INDEX idx_routes_depot ON routes (depot_id);

ALTER TABLE buses ADD COLUMN depot_id UUID REFERENCES depots(id);
CREATE INDEX idx_buses_depot ON buses (depot_id);

-- One row per (user, scope). A Route Manager gets a row with depot_id set
-- (everything under that depot is in scope); an Operations Manager gets a
-- row with bus_id set (exactly one bus — the finest granularity anywhere
-- in the platform, no existing precedent to reuse, built new here).
-- Multiple rows per user are allowed on purpose, even though the current
-- product spec only ever creates one — mirrors frs_user_membership's
-- shape so "one manager covers two depots" later doesn't need a schema
-- change. keycloak_subject is the JWT `sub` claim, already available via
-- UserPrincipal.subject on every request — no shared-DB lookup required.
CREATE TABLE transport_user_scope (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL,
    keycloak_subject  VARCHAR(100) NOT NULL,
    depot_id          UUID REFERENCES depots(id),
    bus_id            UUID REFERENCES buses(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_scope_has_target CHECK (depot_id IS NOT NULL OR bus_id IS NOT NULL)
);
CREATE INDEX idx_transport_user_scope_tenant_subject ON transport_user_scope (tenant_id, keycloak_subject);
