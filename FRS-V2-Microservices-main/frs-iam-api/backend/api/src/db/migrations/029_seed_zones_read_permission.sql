-- Migration 029: Seed the `zones.read` RBAC permission for the Zone Analytics
-- module (specs/0003-zone-analytics).
--
-- Zone Analytics is an HR-only module (requirements.md Revision 3 — every user
-- story is "As an HR manager", not a general operator tool). Per design.md §3
-- this permission must NOT be assigned to the broader `attendance.read`/
-- `analytics.read` role set (site_admin, viewer, tenant_admin, super_admin all
-- hold those already but are not in-scope HR roles) — it is assigned only to
-- the one HR role confirmed against this file's own seed data:
-- `rbac_role.role_name = 'hr_manager'` (pk_role_id = 3, see 001_init_schema.sql
-- line 6944, and scripts/seed.js's HR_PERMISSIONS/SEED_USERS 'hr' entry, which
-- maps rbacRole: 'hr_manager').
--
-- super_admin is intentionally NOT granted this row directly — super_admin
-- bypasses all requirePermission() checks via the role-name check in
-- authz.js's requirePermission (Keycloak mode) / is a superset role in
-- practice, matching how this migration file style (018_seed_transport_nav_items.sql)
-- already scopes seeds to only the roles that should see a feature, not every
-- role that technically could.
--
-- Not applied by scripts/migrate.js (see 017's header comment) — applied by hand,
-- consistent with every other seed-data migration in this directory.

INSERT INTO rbac_permission (permission_code, category, display_name, description, is_scope_aware)
VALUES ('zones.read', 'zones', 'View Zone Analytics', 'View Zone Analytics dashboards, deep-dive, compare, and employee movement views (frs-fe-api /api/zones/*)', true)
ON CONFLICT (permission_code) DO NOTHING;

INSERT INTO rbac_role_permission (fk_role_id, fk_permission_id)
SELECT r.pk_role_id, p.pk_permission_id
FROM rbac_role r, rbac_permission p
WHERE r.role_name = 'hr_manager'
  AND p.permission_code = 'zones.read'
ON CONFLICT DO NOTHING;
