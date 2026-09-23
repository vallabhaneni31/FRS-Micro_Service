import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { pool } from "../src/db/pool.js";
import {
  provisionDedicatedRealm,
  applyRealmBranding,
  ensureRealmRoles,
  createKeycloakOrganization,
  addUserToOrganization,
  RealmConflictError,
} from "../src/services/keycloakProvisioner.js";
import { createOrUpdateKeycloakUser } from "../src/services/keycloakUserService.js";

// ───────────────────────────────────────────────────────────────────────────
// Seed configuration
//
// The seed provisions ONE tenant ("Motivity Global") exactly the way
// POST /api/app-admin/tenants does: a dedicated Keycloak realm, a tenant-level
// organization (alias = realm slug), a per-site organization, and tenant-admin
// + HR users provisioned INTO that realm and enrolled in the org. In Keycloak
// mode the frs_user rows are linked back via keycloak_sub so first-login
// auto-provisioning recognises them. In API mode the same DB rows are written
// (realm/org metadata included) but the Keycloak API calls are skipped.
// ───────────────────────────────────────────────────────────────────────────
const PLATFORM_ROOT_ID = "00000000-0000-0000-0000-000000000001";
const TENANT_NAME = "Motivity Global";
const REALM_SLUG = process.env.SEED_REALM_SLUG || "motivity-global";
const VERTICAL = "corporate";
const CUSTOMER_NAME = "North America Ops";
const SITE_NAME = "Dallas Campus";
const UNIT_NAME = "HR Operations";
const IS_KEYCLOAK = process.env.AUTH_MODE === "keycloak";

// Subscription plan the seed tenant is placed on. Drives the feature set written
// to tenant_ui_config / tenant_settings and the tenant_subscriptions row — the
// same way POST /tenants resolves features from the selected plan.
const SEED_PLAN_NAME = process.env.SEED_PLAN_NAME || "SMB";

// Realm security policy (mirrors the POST /tenants defaults)
const SESSION_TIMEOUT_MINUTES = 480;
const MAX_FAILED_LOGINS = 5;
const PASSWORD_MIN_LENGTH = 8;

const ADMIN_PERMISSIONS = [
  "users.read",
  "users.manage",
  "devices.read",
  "devices.write",
  "devices.manage",
  "attendance.read",
  "attendance.manage",
  "analytics.read",
  "audit.read",
  "system.audit.read",
  "facility.read",
  "facility.manage",
  "sites.read",
  "aiinsights.read",
];

const HR_PERMISSIONS = [
  "users.read",
  "attendance.read",
  "attendance.manage",
  "analytics.read",
  "devices.read",
  "devices.write",
  "facility.read",
  "sites.read",
  "aiinsights.read",
];

// Full management of a single site (no cross-site / provisioning / role mgmt).
const SITE_ADMIN_PERMISSIONS = [
  "users.read",
  "users.manage",
  "devices.read",
  "devices.write",
  "attendance.read",
  "attendance.manage",
  "analytics.read",
  "facility.read",
  "facility.manage",
  "sites.read",
  "aiinsights.read",
];

// Read-only access to attendance and analytics.
const VIEWER_PERMISSIONS = [
  "attendance.read",
  "analytics.read",
  "devices.read",
  "facility.read",
  "sites.read",
  "aiinsights.read",
];

// Device status and telemetry only.
const DEVICE_OPERATOR_PERMISSIONS = [
  "devices.read",
  "facility.read",
  "sites.read",
];

// Seed identities — one per RBAC role so every role can be exercised end-to-end.
// `realmRole` is the Keycloak realm role granted in the dedicated realm (must be
// one of the realm's seeded roles, see keycloakProvisioner defaultRoles);
// `rbacRole` is the role_name looked up in rbac_role for the modern user_role
// assignment; `frsRole` is the DB-constrained value stored in frs_user.role;
// `membershipRole` is the (more restrictive) value allowed by
// frs_user_membership.role for the legacy fallback; `siteScoped` controls
// whether the user_role / membership is bound to the seed site or tenant-wide.
const SEED_USERS = [
  {
    key: "admin",
    email: "admin@company.com",
    username: "Admin User",
    password: "admin123",
    userTypeId: 1,
    frsRole: "admin",
    membershipRole: "admin",
    rbacRole: "super_admin",
    realmRole: "tenant_admin",
    siteScoped: false,
    department: "IT",
    permissions: ADMIN_PERMISSIONS,
  },
  {
    key: "tenantadmin",
    email: "tenantadmin@company.com",
    username: "Tenant Admin",
    password: "tenant1234",
    userTypeId: 1,
    // frs_user.role / frs_user_membership.role both reject 'tenant_admin' in this
    // DB; 'admin' is the legacy equivalent. The precise role lives in user_role
    // via rbacRole ('tenant_admin'), which is what RBAC actually evaluates.
    frsRole: "admin",
    membershipRole: "admin",
    rbacRole: "tenant_admin",
    realmRole: "tenant_admin",
    siteScoped: false,
    department: "Administration",
    permissions: ADMIN_PERMISSIONS,
  },
  {
    key: "siteadmin",
    email: "siteadmin@company.com",
    username: "Site Admin",
    password: "siteadmin123",
    userTypeId: 3,
    frsRole: "site_admin",
    membershipRole: "site_admin",
    rbacRole: "site_admin",
    realmRole: "site_admin",
    // rbac_role.scope_type for site_admin is 'site' → must be site-scoped.
    siteScoped: true,
    department: "Operations",
    permissions: SITE_ADMIN_PERMISSIONS,
  },
  {
    key: "hr",
    email: "hr@company.com",
    username: "HR Manager",
    // Must satisfy the dedicated realm's password policy (length >= PASSWORD_MIN_LENGTH).
    password: "hr1234567",
    userTypeId: 2,
    frsRole: "hr",
    membershipRole: "hr",
    rbacRole: "hr_manager",
    realmRole: "hr_manager",
    siteScoped: true,
    department: "Human Resources",
    permissions: HR_PERMISSIONS,
  },
  {
    key: "viewer",
    email: "viewer@company.com",
    username: "Viewer User",
    password: "viewer1234",
    userTypeId: 4,
    frsRole: "viewer",
    membershipRole: "viewer",
    rbacRole: "viewer",
    realmRole: "viewer",
    siteScoped: false,
    department: "Analytics",
    permissions: VIEWER_PERMISSIONS,
  },
  {
    key: "operator",
    email: "operator@company.com",
    username: "Device Operator",
    password: "operator123",
    userTypeId: 5,
    frsRole: "device_operator",
    membershipRole: "device_operator",
    rbacRole: "device_operator",
    realmRole: "device_operator",
    // rbac_role.scope_type for device_operator is 'site' → must be site-scoped.
    siteScoped: true,
    department: "Facilities",
    permissions: DEVICE_OPERATOR_PERMISSIONS,
  },
];

function slugify(s) {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ───────────────────────────────────────────────────────────────────────────
// Keycloak provisioning — runs OUTSIDE the DB transaction (network side-effects
// must not hold a pooled connection open). Idempotent: a RealmConflictError on
// an existing realm is treated as success, organizations treat 409 as success,
// and createOrUpdateKeycloakUser upserts. Returns the per-user Keycloak subs and
// the site organization alias so the DB transaction can link them.
// ───────────────────────────────────────────────────────────────────────────
async function provisionKeycloak({ tenantId, users }) {
  const subs = {};
  const siteOrgAlias = slugify(SITE_NAME);

  // 1. Dedicated realm (client + 5 default roles + branding/SMTP)
  try {
    await provisionDedicatedRealm({
      realmSlug: REALM_SLUG,
      realmName: TENANT_NAME,
      sessionTimeoutMinutes: SESSION_TIMEOUT_MINUTES,
      maxFailedLogins: MAX_FAILED_LOGINS,
      passwordMinLength: PASSWORD_MIN_LENGTH,
    });
    console.log(`  ✓ realm '${REALM_SLUG}' provisioned`);
  } catch (err) {
    if (err instanceof RealmConflictError) {
      console.log(`  • realm '${REALM_SLUG}' already exists — re-applying branding + roles`);
      await applyRealmBranding({ realmSlug: REALM_SLUG });
      // Backfill any roles added to DEFAULT_REALM_ROLES since the realm was first
      // created (the create path is skipped on conflict), e.g. device_operator.
      await ensureRealmRoles({ realmSlug: REALM_SLUG });
    } else {
      throw err;
    }
  }

  // 2. Tenant-level organization (alias = realm slug)
  await createKeycloakOrganization({ realmSlug: REALM_SLUG, orgSlug: REALM_SLUG, orgName: TENANT_NAME });
  console.log(`  ✓ tenant organization '${REALM_SLUG}'`);

  // 3. Site-level organization (alias = slugified site name)
  await createKeycloakOrganization({ realmSlug: REALM_SLUG, orgSlug: siteOrgAlias, orgName: SITE_NAME });
  console.log(`  ✓ site organization '${siteOrgAlias}'`);

  // 4. Users → Keycloak, then enrol in the tenant organization
  for (const u of users) {
    const sub = await createOrUpdateKeycloakUser({
      email: u.email,
      username: u.username,
      password: u.password,
      realmRole: u.realmRole,
      tenantId,
      realmSlug: REALM_SLUG,
    });
    subs[u.email] = sub;
    if (sub) {
      await addUserToOrganization({ realmSlug: REALM_SLUG, orgSlug: REALM_SLUG, userId: sub });
    }
    console.log(`  ✓ user ${u.email} (${u.realmRole}) provisioned + enrolled in org`);
  }

  return { subs, siteOrgAlias };
}

// ───────────────────────────────────────────────────────────────────────────
// DB helpers (idempotent get-or-create for the legacy hierarchy)
// ───────────────────────────────────────────────────────────────────────────
async function resolveExistingTenantId(client) {
  const res = await client.query(
    "select pk_tenant_id from frs_tenant where tenant_name = $1 limit 1",
    [TENANT_NAME]
  );
  return res.rows[0]?.pk_tenant_id ?? null;
}

async function upsertTenant(client, tenantId) {
  const existing = await client.query(
    "select pk_tenant_id from frs_tenant where tenant_name = $1 limit 1",
    [TENANT_NAME]
  );
  if (existing.rows[0]) {
    await client.query("update frs_tenant set vertical = $2 where pk_tenant_id = $1", [
      existing.rows[0].pk_tenant_id,
      VERTICAL,
    ]);
    return existing.rows[0].pk_tenant_id;
  }
  const inserted = await client.query(
    `insert into frs_tenant(pk_tenant_id, tenant_name, vertical)
     values ($1, $2, $3)
     returning pk_tenant_id`,
    [tenantId, TENANT_NAME, VERTICAL]
  );
  return inserted.rows[0].pk_tenant_id;
}

// frs_customer/site/unit have no natural unique constraint, so SELECT-first to
// stay idempotent across re-runs (an insert-first pattern would duplicate rows).
async function getOrCreateCustomer(client, tenantId) {
  const existing = await client.query(
    "select pk_customer_id from frs_customer where customer_name = $1 and fk_tenant_id = $2 limit 1",
    [CUSTOMER_NAME, tenantId]
  );
  if (existing.rows[0]) return existing.rows[0].pk_customer_id;
  const inserted = await client.query(
    `insert into frs_customer(customer_name, fk_tenant_id) values ($1, $2) returning pk_customer_id`,
    [CUSTOMER_NAME, tenantId]
  );
  return inserted.rows[0].pk_customer_id;
}

async function getOrCreateSite(client, customerId) {
  const existing = await client.query(
    "select pk_site_id from frs_site where site_name = $1 and fk_customer_id = $2 limit 1",
    [SITE_NAME, customerId]
  );
  if (existing.rows[0]) return existing.rows[0].pk_site_id;
  const inserted = await client.query(
    `insert into frs_site(site_name, fk_customer_id) values ($1, $2) returning pk_site_id`,
    [SITE_NAME, customerId]
  );
  return inserted.rows[0].pk_site_id;
}

async function getOrCreateUnit(client, siteId) {
  const existing = await client.query(
    "select pk_unit_id from frs_unit where unit_name = $1 and fk_site_id = $2 limit 1",
    [UNIT_NAME, siteId]
  );
  if (existing.rows[0]) return existing.rows[0].pk_unit_id;
  const inserted = await client.query(
    `insert into frs_unit(unit_name, fk_site_id) values ($1, $2) returning pk_unit_id`,
    [UNIT_NAME, siteId]
  );
  return inserted.rows[0].pk_unit_id;
}

// ───────────────────────────────────────────────────────────────────────────
// New-model tenant rows (mirrors POST /tenants): tenants tree, tenant_realm,
// tenant_ui_config, tenant_settings, default frs_group + group_role_map.
// ───────────────────────────────────────────────────────────────────────────
// Resolve the seed tenant's subscription plan: prefer SEED_PLAN_NAME, then fall
// back to the cheapest plan for this vertical. Returns null if no plans exist
// (a bare DB without the 031 plan seeds) so subscription seeding stays optional.
async function resolvePlan(client) {
  const byName = await client.query(
    "select pk_plan_id, features from subscription_plans where lower(name) = lower($1) limit 1",
    [SEED_PLAN_NAME]
  );
  if (byName.rows[0]) return byName.rows[0];
  const byVertical = await client.query(
    `select pk_plan_id, features from subscription_plans
     where vertical = $1
     order by base_price asc nulls last
     limit 1`,
    [VERTICAL]
  );
  return byVertical.rows[0] ?? null;
}

async function seedNewModelTenant(client, { tenantId, adminUserId, siteId, plan }) {
  const features = plan?.features ?? [];
  const featuresJson = JSON.stringify(features);

  // Ensure the platform root exists so the customer row's parent FK resolves.
  await client.query(
    `insert into tenants (pk_tenant_id, parent_id, root_id, hierarchy_path, level, tenant_kind, name, slug, status)
     values ($1, null, $1, $2, 0, 'platform', 'Platform', 'platform', 'active')
     on conflict (pk_tenant_id) do nothing`,
    [PLATFORM_ROOT_ID, `/${PLATFORM_ROOT_ID}/`]
  );

  // Customer-level tenants row (level 1) keyed on the SAME id as frs_tenant.
  await client.query(
    `insert into tenants (
        pk_tenant_id, parent_id, root_id, hierarchy_path,
        level, tenant_kind, vertical, name, slug, status, settings
     ) values ($1, $2::uuid, $2::uuid, $3, 1, 'customer', $4, $5, $6, 'active', '{}'::jsonb)
     on conflict (pk_tenant_id) do update set vertical = excluded.vertical, name = excluded.name`,
    [tenantId, PLATFORM_ROOT_ID, `/${PLATFORM_ROOT_ID}/${tenantId}/`, VERTICAL, TENANT_NAME, REALM_SLUG]
  );

  // Feature flags (legacy UI config) — derived from the subscription plan.
  await client.query(
    `insert into tenant_ui_config (fk_tenant_id, enabled_features)
     values ($1, $2::jsonb)
     on conflict (fk_tenant_id) do update set enabled_features = excluded.enabled_features`,
    [tenantId, featuresJson]
  );

  // tenant_settings (branding defaults + plan feature set)
  await client.query(
    `insert into tenant_settings (fk_tenant_id, primary_color, custom_features, email_notifications)
     values ($1, '#6366f1', $2::jsonb, true)
     on conflict (fk_tenant_id) do update set custom_features = excluded.custom_features`,
    [tenantId, featuresJson]
  );

  // Active subscription (optional — only when a plan is available).
  if (plan?.pk_plan_id) {
    await client.query(
      `insert into tenant_subscriptions (fk_tenant_id, fk_plan_id, status, starts_at, auto_renew)
       select $1, $2, 'active', now(), true
       where not exists (
         select 1 from tenant_subscriptions
         where fk_tenant_id = $1 and status = 'active'
       )`,
      [tenantId, plan.pk_plan_id]
    );
  }

  // Dedicated realm metadata
  await client.query(
    `insert into tenant_realm
       (fk_tenant_id, realm_slug, realm_name, session_timeout_minutes, max_failed_logins, password_min_length)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (fk_tenant_id) do update set
       realm_slug = excluded.realm_slug,
       realm_name = excluded.realm_name`,
    [tenantId, REALM_SLUG, TENANT_NAME, SESSION_TIMEOUT_MINUTES, MAX_FAILED_LOGINS, PASSWORD_MIN_LENGTH]
  );

  // Default groups → roles (Tenant Admins / Site Managers / HR Team)
  const defaultGroups = [
    { name: "Tenant Admins", description: "Full tenant management access", role: "tenant_admin", siteScoped: false },
    { name: "Site Managers", description: "Site-level operations access", role: "site_admin", siteScoped: true },
    { name: "HR Team", description: "People and leave management", role: "hr_manager", siteScoped: true },
  ];
  for (const g of defaultGroups) {
    const { rows: [grp] } = await client.query(
      `insert into frs_group (fk_tenant_id, group_name, description, created_by)
       values ($1, $2, $3, $4)
       on conflict (fk_tenant_id, group_name) do update set description = excluded.description
       returning pk_group_id`,
      [tenantId, g.name, g.description, adminUserId]
    );
    const { rows: [role] } = await client.query(
      "select pk_role_id from rbac_role where role_name = $1",
      [g.role]
    );
    if (role) {
      const mapSite = g.siteScoped ? siteId : null;
      await client.query(
        `insert into group_role_map (fk_group_id, fk_role_id, fk_site_id, granted_by)
         select $1, $2, $3, $4
         where not exists (
           select 1 from group_role_map
           where fk_group_id = $1 and fk_role_id = $2
             and fk_site_id is not distinct from $3
         )`,
        [grp.pk_group_id, role.pk_role_id, mapSite, adminUserId]
      );
    }
  }
}

async function run() {
  // Resolve the tenant id (stamped into Keycloak users + DB rows; reuse the
  // existing id on a re-run) AND the set of rbac_role names that actually exist
  // in this database, up front and in one short-lived connection.
  const preClient = await pool.connect();
  let tenantId;
  let existingRoleNames;
  try {
    tenantId = (await resolveExistingTenantId(preClient)) || randomUUID();
    const roleRes = await preClient.query("select role_name from rbac_role");
    existingRoleNames = new Set(roleRes.rows.map((r) => r.role_name));
  } finally {
    preClient.release();
  }

  // Only seed users whose rbac_role is present in this DB. A role can be missing
  // when the database is on an older migration than the repo (e.g. tenant_admin).
  // Skipping here avoids half-provisioning a user that would get no RBAC role.
  const activeUsers = SEED_USERS.filter((u) => existingRoleNames.has(u.rbacRole));
  for (const u of SEED_USERS.filter((u) => !existingRoleNames.has(u.rbacRole))) {
    console.warn(`  ⚠ skipping ${u.email}: rbac_role '${u.rbacRole}' is not present in this database.`);
  }

  // Fail fast if a seed password would violate the realm's own password policy,
  // rather than discovering it mid-provision (Keycloak rejects with HTTP 400).
  if (IS_KEYCLOAK) {
    const tooShort = activeUsers.filter((u) => u.password.length < PASSWORD_MIN_LENGTH);
    if (tooShort.length > 0) {
      throw new Error(
        `Seed password(s) for [${tooShort.map((u) => u.email).join(", ")}] are shorter than the realm ` +
        `password policy (length ${PASSWORD_MIN_LENGTH}). Lengthen them or lower PASSWORD_MIN_LENGTH.`
      );
    }
  }

  // ── Phase A: Keycloak side-effects (outside the DB transaction) ──
  let kcSubs = {};
  let siteOrgAlias = slugify(SITE_NAME);
  if (IS_KEYCLOAK) {
    console.log(`Keycloak mode — provisioning dedicated realm '${REALM_SLUG}'...`);
    const result = await provisionKeycloak({ tenantId, users: activeUsers });
    kcSubs = result.subs;
    siteOrgAlias = result.siteOrgAlias;
  } else {
    console.log("API mode — skipping Keycloak provisioning (DB realm/org metadata still written).");
  }

  const passwordHashes = {};
  for (const u of activeUsers) {
    passwordHashes[u.key] = await bcrypt.hash(u.password, 10);
  }

  // ── Phase B: DB transaction ──
  const client = await pool.connect();
  try {
    await client.query("begin");

    tenantId = await upsertTenant(client, tenantId);
    const customerId = await getOrCreateCustomer(client, tenantId);
    const siteId = await getOrCreateSite(client, customerId);
    const unitId = await getOrCreateUnit(client, siteId);

    // Stamp the Keycloak org pointers onto the site (mirrors the backfill route).
    if (IS_KEYCLOAK) {
      await client.query(
        "update frs_site set keycloak_org_id = $1, keycloak_org_alias = $1 where pk_site_id = $2",
        [siteOrgAlias, siteId]
      );
    }

    // ── Users: upsert frs_user, linking keycloak_sub in Keycloak mode ──
    const userIds = {};
    for (const u of activeUsers) {
      const sub = kcSubs[u.email] || null;
      const inserted = await client.query(
        `insert into frs_user(email, username, fk_user_type_id, role, password_hash, department, keycloak_sub)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (email) do update set
           password_hash = excluded.password_hash,
           username = excluded.username,
           role = excluded.role,
           department = excluded.department,
           keycloak_sub = coalesce(excluded.keycloak_sub, frs_user.keycloak_sub)
         returning pk_user_id`,
        [u.email, u.username, u.userTypeId, u.frsRole, passwordHashes[u.key], u.department, sub]
      );
      userIds[u.key] = inserted.rows[0].pk_user_id;
    }

    const adminUserId = userIds.admin;
    const hrUserId = userIds.hr;
    const allUserIds = activeUsers.map((u) => userIds[u.key]);

    // Every seed user belongs to the seed tenant + customer.
    for (const u of activeUsers) {
      await client.query(
        `insert into frs_tenant_user_map(fk_user_id, fk_tenant_id)
         values ($1, $2) on conflict do nothing`,
        [userIds[u.key], tenantId]
      );
      await client.query(
        `insert into frs_customer_user_map(fk_user_id, fk_customer_id)
         values ($1, $2) on conflict do nothing`,
        [userIds[u.key], customerId]
      );
    }

    // 1. Legacy Fallback (frs_user_membership) — one row per user, scoped to the
    //    seed site/unit when the role is site-scoped, otherwise tenant-wide.
    await client.query(
      "delete from frs_user_membership where fk_user_id = any($1::bigint[])",
      [allUserIds]
    );

    for (const u of activeUsers) {
      const memberSite = u.siteScoped ? siteId : null;
      const memberUnit = u.siteScoped ? unitId : null;
      await client.query(
        `insert into frs_user_membership(fk_user_id, role, tenant_id, customer_id, site_id, unit_id, permissions)
         values ($1, $2, $3, $4, $5, $6, $7::text[])`,
        [userIds[u.key], u.membershipRole, tenantId, customerId, memberSite, memberUnit, u.permissions]
      );
    }

    // 2. Modern RBAC Assignments (user_role table) — deactivate any prior rows,
    //    then assign each user their rbac_role (site-scoped where required). The
    //    partial unique indexes only cover is_active = true, so the freshly
    //    inserted active row never collides with the now-inactive history rows.
    await client.query(
      "update user_role set is_active = false where fk_user_id = any($1::bigint[])",
      [allUserIds]
    );

    for (const u of activeUsers) {
      const roleSite = u.siteScoped ? siteId : null;
      await client.query(
        `insert into user_role (fk_user_id, fk_role_id, fk_site_id, granted_by, is_active)
         select $1, pk_role_id, $2, $3, true
         from rbac_role
         where role_name = $4
         on conflict do nothing`,
        [userIds[u.key], roleSite, adminUserId, u.rbacRole]
      );
    }

    // 3. New-model tenant rows: tenants tree, tenant_realm, settings, groups,
    //    subscription (features derived from the resolved plan).
    const plan = await resolvePlan(client);
    await seedNewModelTenant(client, { tenantId, adminUserId, siteId, plan });

    await client.query("delete from system_alert where tenant_id = $1", [tenantId]);
    await client.query("delete from attendance_record where tenant_id = $1", [tenantId]);
    // device_status_history has no tenant_id and FK-references facility_device,
    // so clear it (scoped to this tenant's devices) before deleting the devices.
    await client.query(
      `delete from device_status_history
       where device_id in (select pk_device_id from facility_device where tenant_id = $1)`,
      [tenantId]
    );
    await client.query("delete from facility_device where tenant_id = $1", [tenantId]);
    await client.query("delete from hr_employee where tenant_id = $1", [tenantId]);
    await client.query("delete from hr_shift where tenant_id = $1", [tenantId]);
    await client.query("delete from hr_department where tenant_id = $1", [tenantId]);
    // NOTE: audit_log is append-only (prevent_audit_modification trigger blocks
    // DELETE/UPDATE), so it is intentionally NOT reset here.

    const engineeringDept = await client.query(
      `insert into hr_department(tenant_id, name, code, color) values ($1, 'Engineering', 'ENG', '#3B82F6') returning pk_department_id`,
      [tenantId]
    );
    const hrDept = await client.query(
      `insert into hr_department(tenant_id, name, code, color) values ($1, 'Human Resources', 'HR', '#EC4899') returning pk_department_id`,
      [tenantId]
    );
    const salesDept = await client.query(
      `insert into hr_department(tenant_id, name, code, color) values ($1, 'Sales', 'SAL', '#10B981') returning pk_department_id`,
      [tenantId]
    );

    const morningShift = await client.query(
      `insert into hr_shift(tenant_id, name, shift_type, start_time, end_time, grace_period_minutes, is_flexible)
       values ($1, 'Morning Shift', 'morning', '08:00', '17:00', 10, false)
       returning pk_shift_id`,
      [tenantId]
    );
    const eveningShift = await client.query(
      `insert into hr_shift(tenant_id, name, shift_type, start_time, end_time, grace_period_minutes, is_flexible)
       values ($1, 'Evening Shift', 'evening', '14:00', '23:00', 15, false)
       returning pk_shift_id`,
      [tenantId]
    );
    const flexibleShift = await client.query(
      `insert into hr_shift(tenant_id, name, shift_type, start_time, end_time, grace_period_minutes, is_flexible)
       values ($1, 'Flexible Hours', 'flexible', null, null, 0, true)
       returning pk_shift_id`,
      [tenantId]
    );

    const employeesToInsert = [
      ["EMP001", "Sarah Johnson", "sarah.johnson@company.com", engineeringDept.rows[0].pk_department_id, morningShift.rows[0].pk_shift_id, "Senior Software Engineer", "Building A", "active", "2022-03-15", "+1 234-567-8901"],
      ["EMP002", "Michael Chen", "michael.chen@company.com", engineeringDept.rows[0].pk_department_id, morningShift.rows[0].pk_shift_id, "DevOps Engineer", "Building A", "active", "2021-07-20", "+1 234-567-8902"],
      ["EMP003", "Emily Rodriguez", "emily.rodriguez@company.com", salesDept.rows[0].pk_department_id, flexibleShift.rows[0].pk_shift_id, "Marketing Manager", "Building B", "active", "2020-11-10", "+1 234-567-8903"],
      ["EMP004", "Lisa Thompson", "lisa.thompson@company.com", hrDept.rows[0].pk_department_id, morningShift.rows[0].pk_shift_id, "HR Specialist", "Building C", "active", "2020-08-30", "+1 234-567-8904"],
      ["EMP005", "Christopher Lee", "christopher.lee@company.com", engineeringDept.rows[0].pk_department_id, eveningShift.rows[0].pk_shift_id, "Backend Developer", "Building A", "active", "2022-11-05", "+1 234-567-8905"],
    ];

    const employeeIds = [];
    for (const employee of employeesToInsert) {
      const inserted = await client.query(
        `insert into hr_employee(
          tenant_id, customer_id, site_id, unit_id, fk_department_id, fk_shift_id,
          employee_code, full_name, email, position_title, location_label, status, join_date, phone_number
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        returning pk_employee_id`,
        [
          tenantId,
          customerId,
          siteId,
          unitId,
          employee[3],
          employee[4],
          employee[0],
          employee[1],
          employee[2],
          employee[5],
          employee[6],
          employee[7],
          employee[8],
          employee[9],
        ]
      );
      employeeIds.push(inserted.rows[0].pk_employee_id);
    }

    const device1 = await client.query(
      `insert into facility_device(
        tenant_id, customer_id, site_id, unit_id, external_device_id, name, location_label, ip_address, status, recognition_accuracy, total_scans, error_rate, model, last_active
      ) values ($1,$2,$3,$4,'device-1','Main Entrance - Building A','Building A - Ground Floor','192.168.1.101','online',98.5,15234,1.5,'FaceVision Pro X1', now())
      returning pk_device_id`,
      [tenantId, customerId, siteId, unitId]
    );
    const device2 = await client.query(
      `insert into facility_device(
        tenant_id, customer_id, site_id, unit_id, external_device_id, name, location_label, ip_address, status, recognition_accuracy, total_scans, error_rate, model, last_active
      ) values ($1,$2,$3,$4,'device-2','Main Entrance - Building B','Building B - Ground Floor','192.168.1.102','offline',95.2,6745,4.8,'FaceVision Lite', now() - interval '2 hour')
      returning pk_device_id`,
      [tenantId, customerId, siteId, unitId]
    );

    for (let i = 0; i < employeeIds.length; i += 1) {
      for (let day = 0; day < 20; day += 1) {
        const status = day % 9 === 0 ? "absent" : day % 4 === 0 ? "late" : "present";
        const dateSql = `current_date - interval '${day} day'`;
        await client.query(
          `insert into attendance_record(
            tenant_id, customer_id, site_id, unit_id, fk_employee_id, attendance_date,
            check_in, check_out, break_start, break_end, status, working_hours, break_duration_minutes, overtime_hours, is_late, is_early_departure, device_id, location_label, recognition_accuracy
          ) values (
            $1,$2,$3,$4,$5, (${dateSql})::date,
            case when $6='absent' then null else (${dateSql} + time '09:00') end,
            case when $6='absent' then null else (${dateSql} + time '18:00') end,
            case when $6='absent' then null else (${dateSql} + time '12:30') end,
            case when $6='absent' then null else (${dateSql} + time '13:15') end,
            $6,
            case when $6='absent' then 0 else 8.25 end,
            case when $6='absent' then 0 else 45 end,
            case when $6='present' then 0.5 else 0 end,
            ($6='late'),
            false,
            $7,
            $8,
            $9
          ) on conflict (tenant_id, fk_employee_id, attendance_date) do nothing`,
          [
            tenantId,
            customerId,
            siteId,
            unitId,
            employeeIds[i],
            status,
            day % 2 === 0 ? "device-1" : "device-2",
            SITE_NAME,
            92 + (i % 6),
          ]
        );
      }
    }

    await client.query(
      `insert into system_alert(
        tenant_id, customer_id, site_id, unit_id, alert_type, severity, title, message, fk_device_id, is_read
      ) values
        ($1,$2,$3,$4,'device-offline','high','Device Offline','Main Entrance - Building B has been offline for 2 hours',$5,false),
        ($1,$2,$3,$4,'late-checkin','medium','Multiple Late Check-ins','5 employees checked in late today',null,false),
        ($1,$2,$3,$4,'recognition-failure','low','Recognition Drift','Accuracy dropped below threshold for one camera',$6,true)`,
      [tenantId, customerId, siteId, unitId, device2.rows[0].pk_device_id, device1.rows[0].pk_device_id]
    );

    // Demo audit rows — insert once (audit_log is append-only, so re-running the
    // seed must not duplicate these). Skip if this tenant already has audit rows.
    const existingAudit = await client.query(
      "select 1 from audit_log where tenant_id = $1 limit 1",
      [tenantId]
    );
    if (existingAudit.rows.length === 0) {
      await client.query(
        `insert into audit_log(
          tenant_id, customer_id, site_id, unit_id, fk_user_id, action, details, ip_address
        ) values
          ($1,$2,$3,$4,$5,'User Created','Created new HR user: hr@company.com','192.168.1.50'),
          ($1,$2,$3,$4,$5,'Device Registered','Registered device: Main Entrance - Building A','192.168.1.50'),
          ($1,$2,$3,$4,$6,'Report Exported','Exported attendance report for January 2026','192.168.1.75')`,
        [tenantId, customerId, siteId, unitId, adminUserId, hrUserId]
      );
    }

    await client.query("commit");
    console.log("Seed complete.");
    console.log(`  tenant:     ${TENANT_NAME} (${tenantId})`);
    console.log(`  realm:      ${REALM_SLUG}${IS_KEYCLOAK ? " (Keycloak)" : " (DB metadata only)"}`);
    console.log(`  org:        ${REALM_SLUG} (tenant) / ${siteOrgAlias} (site)`);
    console.log(`  plan:       ${plan ? SEED_PLAN_NAME : "none (no subscription_plans seeded)"}`);
    for (const u of activeUsers) {
      console.log(`  ${u.key.padEnd(10)} ${u.email} / ${u.password}`);
    }
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

run()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

export default run;
