/**
 * seed_platform.js — idempotent platform reference data seed
 *
 * Seeds all tables that must exist for the app to function but are NOT
 * captured by the schema migration (which only applies once):
 *
 *   nav_item             — sidebar menus per role
 *   tenant_type          — tenant tier definitions
 *   tenant_type_feature_map — features enabled per tier
 *   role_capability_grant — which roles can grant/manage which other roles
 *   device_type          — supported hardware types
 *
 * Safe to run on every deploy — all inserts use ON CONFLICT DO UPDATE or
 * DO NOTHING, so existing data is never destroyed.
 */

import { pool } from "../src/db/pool.js";

// ─────────────────────────────────────────────────────────────────────────────
// nav_item — sidebar navigation per role
// ─────────────────────────────────────────────────────────────────────────────
async function seedNavItems(client) {
  const rows = [
    // super_admin
    { role: "super_admin",  key: "overview",               label: "Overview",        icon: "LayoutDashboard", sort: 10,  active: true, vertical: null },
    { role: "super_admin",  key: "tenants",                label: "Tenants",         icon: "Building",        sort: 20,  active: true, vertical: null },
    { role: "super_admin",  key: "customers",              label: "Customers",       icon: "Users",           sort: 25,  active: true, vertical: null },
    // { role: "super_admin",  key: "analytics",              label: "Analytics",       icon: "BarChart3",       sort: 40,  active: true, vertical: null },
    { role: "super_admin",  key: "tenant_types",           label: "Tenant Types",    icon: "Sliders",         sort: 45,  active: true, vertical: null },
    { role: "super_admin",  key: "users",                  label: "All Users",       icon: "Users",           sort: 60,  active: true, vertical: null },
    { role: "super_admin",  key: "system",                 label: "System Health",   icon: "Activity",        sort: 80,  active: true, vertical: null },
    { role: "super_admin",  key: "activity_log",           label: "Activity Logs",   icon: "FileText",        sort: 85,  active: true, vertical: null },
    // tenant_admin
    { role: "tenant_admin", key: "dashboard",              label: "Dashboard",       icon: "LayoutDashboard", sort: 10,  active: true, vertical: null },
    { role: "tenant_admin", key: "visitors",               label: "People/Visitors", icon: "Users",           sort: 16,  active: true, vertical: "corporate" },
    { role: "tenant_admin", key: "branches",               label: "Branches",        icon: "Building2",       sort: 30,  active: true, vertical: null },
    { role: "tenant_admin", key: "tenant_admin/users",     label: "User Management", icon: "Users",           sort: 40,  active: true, vertical: null },
    { role: "tenant_admin", key: "groups",                 label: "Groups",          icon: "UsersRound",      sort: 45,  active: true, vertical: null },
    { role: "tenant_admin", key: "tenant_admin/analytics", label: "Analytics",       icon: "BarChart3",       sort: 50,  active: true, vertical: null },
    { role: "tenant_admin", key: "devices",                label: "Devices",         icon: "Server",          sort: 60,  active: true, vertical: null },
    { role: "tenant_admin", key: "settings",               label: "Settings",        icon: "Settings",        sort: 70,  active: true, vertical: null },
    // site_admin
    { role: "site_admin",   key: "overview",               label: "Overview",        icon: "LayoutDashboard", sort: 10,  active: true, vertical: null },
    { role: "site_admin",   key: "visitors",               label: "People/Visitors", icon: "Users",           sort: 16,  active: true, vertical: "corporate" },
    { role: "site_admin",   key: "devices",                label: "Devices",         icon: "Server",          sort: 20,  active: true, vertical: null },
    { role: "site_admin",   key: "workforce",              label: "Workforce",       icon: "Users",           sort: 30,  active: true, vertical: null },
    { role: "site_admin",   key: "attendance",             label: "Attendance",      icon: "Clock",           sort: 40,  active: true, vertical: null },
    { role: "site_admin",   key: "access",                 label: "Access Control",  icon: "Shield",          sort: 50,  active: true, vertical: null },
    { role: "site_admin",   key: "logs",                   label: "Activity Logs",   icon: "FileText",        sort: 60,  active: true, vertical: null },
    // hr_manager
    { role: "hr_manager",   key: "hr_manager/dashboard",   label: "Dashboard",       icon: "LayoutDashboard", sort: 5,   active: true, vertical: null },
    { role: "hr_manager",   key: "hr_manager/analytics",   label: "Analytics",       icon: "BarChart3",       sort: 8,   active: true, vertical: null },
    { role: "hr_manager",   key: "attendance",             label: "Attendance",      icon: "Clock",           sort: 10,  active: true, vertical: null },
    { role: "hr_manager",   key: "visitors",               label: "People/Visitors", icon: "Users",           sort: 16,  active: true, vertical: "corporate" },
    { role: "hr_manager",   key: "employees",              label: "Employees",       icon: "Users",           sort: 20,  active: true, vertical: null },
    { role: "hr_manager",   key: "enrollment",             label: "Enrollment",      icon: "UserPlus",        sort: 30,  active: true, vertical: null },
    { role: "hr_manager",   key: "reports",                label: "Reports",         icon: "FileText",        sort: 40,  active: true, vertical: null },
    { role: "hr_manager",   key: "configuration",          label: "Configuration",   icon: "Building2",       sort: 55,  active: true, vertical: null },
    { role: "hr_manager",   key: "configurations",         label: "Configurations",  icon: "Settings",        sort: 60,  active: true, vertical: null },
  ];

  const vals = rows
    .map(r => `('${r.role}','${r.key}','${r.label}','${r.icon}',${r.sort},${r.active},${r.vertical ? `'${r.vertical}'` : "NULL"})`)
    .join(",\n    ");

  await client.query(`
    INSERT INTO public.nav_item (role_name, item_key, label, icon, sort_order, is_active, vertical)
    VALUES
      ${vals}
    ON CONFLICT (role_name, item_key) DO UPDATE SET
      label      = EXCLUDED.label,
      icon       = EXCLUDED.icon,
      sort_order = EXCLUDED.sort_order,
      is_active  = EXCLUDED.is_active,
      vertical   = EXCLUDED.vertical
  `);
  console.log(`  nav_item: ${rows.length} rows`);
}

// ─────────────────────────────────────────────────────────────────────────────
// tenant_type — tier definitions (corporate + education)
// ─────────────────────────────────────────────────────────────────────────────
async function seedTenantTypes(client) {
  await client.query(`
    INSERT INTO public.tenant_type (pk_tenant_type_id, type_name, description)
    VALUES
      ('115f3e35-6a9e-43b3-b7cc-c0a2f607ba37', 'enterprise',      'Large organisations — all features enabled by default'),
      ('1437e622-bd61-4b0b-aadc-70ad6b9ae50d', 'basic',           'Entry-level — attendance and employees only'),
      ('4a8a1181-1b7d-4804-9eca-ef62483c819e', 'institute basic', 'Education tier — institutes and small colleges'),
      ('686328ac-2247-4174-af36-7b67bf1044c7', 'school',          'Education tier — schools with multi-campus support'),
      ('700e0c09-33bd-4b4c-a7aa-8aff5b273d39', 'university',      'Education tier — large universities with full feature set'),
      ('925ffc12-f0c7-44e6-a007-0a198195c60e', 'smb',             'Small/medium businesses — core features only')
    ON CONFLICT (pk_tenant_type_id) DO UPDATE SET
      type_name   = EXCLUDED.type_name,
      description = EXCLUDED.description
  `);
  console.log("  tenant_type: 6 rows");
}

// ─────────────────────────────────────────────────────────────────────────────
// tenant_type_feature_map — features enabled per tier
// ─────────────────────────────────────────────────────────────────────────────
async function seedTenantTypeFeatures(client) {
  await client.query(`
    INSERT INTO public.tenant_type_feature_map (fk_tenant_type_id, feature_key)
    VALUES
      -- enterprise: all features
      ('115f3e35-6a9e-43b3-b7cc-c0a2f607ba37', 'attendance'),
      ('115f3e35-6a9e-43b3-b7cc-c0a2f607ba37', 'devices'),
      ('115f3e35-6a9e-43b3-b7cc-c0a2f607ba37', 'face_recognition'),
      ('115f3e35-6a9e-43b3-b7cc-c0a2f607ba37', 'hrms_sync'),
      ('115f3e35-6a9e-43b3-b7cc-c0a2f607ba37', 'reports'),
      -- basic: attendance + reports only
      ('1437e622-bd61-4b0b-aadc-70ad6b9ae50d', 'attendance'),
      ('1437e622-bd61-4b0b-aadc-70ad6b9ae50d', 'reports'),
      -- smb: attendance, devices, face recognition, reports
      ('925ffc12-f0c7-44e6-a007-0a198195c60e', 'attendance'),
      ('925ffc12-f0c7-44e6-a007-0a198195c60e', 'devices'),
      ('925ffc12-f0c7-44e6-a007-0a198195c60e', 'face_recognition'),
      ('925ffc12-f0c7-44e6-a007-0a198195c60e', 'reports')
    ON CONFLICT DO NOTHING
  `);
  console.log("  tenant_type_feature_map: 11 rows");
}

// ─────────────────────────────────────────────────────────────────────────────
// role_capability_grant — which roles can assign/manage which other roles
// ─────────────────────────────────────────────────────────────────────────────
async function seedRoleCapabilityGrants(client) {
  await client.query(`
    INSERT INTO public.role_capability_grant (grantor_role, grantee_role, capability, is_active)
    VALUES
      ('super_admin',  'tenant_admin', 'manage.hr_manager',           true),
      ('super_admin',  'tenant_admin', 'manage.site_admin',           true),
      ('super_admin',  'tenant_admin', 'nav.analytics',               true),
      ('super_admin',  'tenant_admin', 'nav.branches',                true),
      ('super_admin',  'tenant_admin', 'nav.devices',                 true),
      ('super_admin',  'tenant_admin', 'nav.settings',                true),
      ('super_admin',  'tenant_admin', 'nav.sites',                   true),
      ('super_admin',  'tenant_admin', 'nav.users',                   true),
      ('tenant_admin', 'hr_manager',   'manage.hr_manager',           true),
      ('tenant_admin', 'hr_manager',   'manage.users',                true),
      ('tenant_admin', 'hr_manager',   'nav.attendance',              true),
      ('tenant_admin', 'hr_manager',   'nav.configuration',           true),
      ('tenant_admin', 'hr_manager',   'nav.employees',               true),
      ('tenant_admin', 'hr_manager',   'nav.enrollment',              true),
      ('tenant_admin', 'hr_manager',   'nav.hr_manager/dashboard',    true),
      ('tenant_admin', 'hr_manager',   'nav.reports',                 true),
      ('tenant_admin', 'site_admin',   'manage.devices',              true),
      ('tenant_admin', 'site_admin',   'manage.site_admin',           true),
      ('tenant_admin', 'site_admin',   'manage.sites',                true),
      ('tenant_admin', 'site_admin',   'manage.users',                true),
      ('tenant_admin', 'site_admin',   'nav.access',                  true),
      ('tenant_admin', 'site_admin',   'nav.attendance',              true),
      ('tenant_admin', 'site_admin',   'nav.devices',                 true),
      ('tenant_admin', 'site_admin',   'nav.logs',                    true),
      ('tenant_admin', 'site_admin',   'nav.workforce',               true)
    ON CONFLICT (grantor_role, grantee_role, capability) DO UPDATE SET
      is_active = EXCLUDED.is_active
  `);
  console.log("  role_capability_grant: 25 rows");
}

// ─────────────────────────────────────────────────────────────────────────────
// device_type — supported hardware types
// ─────────────────────────────────────────────────────────────────────────────
async function seedDeviceTypes(client) {
  await client.query(`
    INSERT INTO public.device_type (pk_device_type_id, type_code, type_name, category, manufacturer, model)
    OVERRIDING SYSTEM VALUE
    VALUES
      (1, 'jetson_orin_nx',   'Jetson Orin NX',    'edge_node', 'NVIDIA',    'Orin NX'),
      (2, 'hikvision_camera', 'Hikvision Camera',  'camera',    'Hikvision', 'Generic IP Cam'),
      (3, 'jetson_xavier_nx', 'Jetson Xavier NX',  'edge_node', 'NVIDIA',    'Xavier NX')
    ON CONFLICT (pk_device_type_id) DO UPDATE SET
      type_code    = EXCLUDED.type_code,
      type_name    = EXCLUDED.type_name,
      category     = EXCLUDED.category,
      manufacturer = EXCLUDED.manufacturer,
      model        = EXCLUDED.model
  `);
  // Advance the sequence past any hard-coded IDs so future inserts don't collide
  await client.query(`SELECT setval('device_type_pk_device_type_id_seq', (SELECT MAX(pk_device_type_id) FROM device_type))`);
  console.log("  device_type: 3 rows");
}

// ─────────────────────────────────────────────────────────────────────────────
// Patch bidirectional sync trigger functions to add recursion guard
// (schema.sql may have been applied before this guard was added)
// ─────────────────────────────────────────────────────────────────────────────
async function patchTriggerFunctions(client) {
  await client.query(`
    CREATE OR REPLACE FUNCTION public.sync_frs_tenant_to_tenants() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
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
    $$
  `);

  await client.query(`
    CREATE OR REPLACE FUNCTION public.sync_tenants_to_frs_tenant() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
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
    $$
  `);

  await client.query(`
    CREATE OR REPLACE FUNCTION public.sync_frs_group_to_groups() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
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
    $$
  `);

  await client.query(`
    CREATE OR REPLACE FUNCTION public.sync_groups_to_frs_group() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
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
    $$
  `);

  console.log("  trigger functions: recursion guards applied");
}

// ─────────────────────────────────────────────────────────────────────────────
// tenants — platform root (level 0)
// ─────────────────────────────────────────────────────────────────────────────
async function seedPlatformRoot(client) {
  const PLATFORM_ID = "00000000-0000-0000-0000-000000000001";
  // Two-step upsert: insert with root_id=NULL first to avoid the self-referencing
  // FK chicken-and-egg (tenants_root_id_fkey is NOT DEFERRABLE), then UPDATE.
  await client.query(`
    INSERT INTO tenants (
      pk_tenant_id, parent_id, root_id, hierarchy_path,
      level, tenant_kind, name, slug, status, settings, metadata
    ) VALUES (
      $1::uuid, NULL, NULL,
      '/' || $1 || '/',
      0, 'platform', 'FRS Platform', 'platform', 'active',
      '{}'::jsonb, '{}'::jsonb
    )
    ON CONFLICT (pk_tenant_id) DO NOTHING
  `, [PLATFORM_ID]);

  await client.query(`
    UPDATE tenants
       SET root_id = $1::uuid
     WHERE pk_tenant_id = $1::uuid
       AND root_id IS DISTINCT FROM $1::uuid
  `, [PLATFORM_ID]);

  console.log("  tenants: platform root ensured");
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────
async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    console.log("Seeding platform reference data...");
    await patchTriggerFunctions(client);
    await seedPlatformRoot(client);
    await seedNavItems(client);
    await seedTenantTypes(client);
    await seedTenantTypeFeatures(client);
    await seedRoleCapabilityGrants(client);
    await seedDeviceTypes(client);
    await client.query("COMMIT");
    console.log("Platform seed complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

run()
  .catch(err => { console.error("seed_platform failed:", err.message); process.exitCode = 1; })
  .finally(() => pool.end());
