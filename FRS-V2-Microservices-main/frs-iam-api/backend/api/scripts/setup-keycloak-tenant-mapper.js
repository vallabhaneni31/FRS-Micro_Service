#!/usr/bin/env node
/**
 * setup-keycloak-tenant-mapper.js
 *
 * Full Keycloak bootstrap for the FRS multi-tenant system.
 * Designed to run from inside the backend environment so it can reach
 * both the Keycloak admin API and the FRS database.
 *
 * What it does IN ORDER:
 *
 *  Phase 1  Create the "attendance" realm (idempotent — skips if exists)
 *  Phase 2  Create the "attendance-frontend" public PKCE client
 *  Phase 3  Create the "tenant-id-mapper" Protocol Mapper so every JWT
 *           carries a signed `tenant_id` claim
 *  Phase 4  Create Keycloak users for every frs_user that has no keycloak_sub,
 *           assign the correct realm role (super_admin / tenant_admin / hr_manager),
 *           set the `tenant_id` user attribute, and write keycloak_sub back to frs_user
 *  Phase 5  For users that already have keycloak_sub, sync their tenant_id attribute
 *  Phase 6  Print the ENV change needed to go live
 *
 * Run:
 *   node scripts/setup-keycloak-tenant-mapper.js
 *
 * Requires in .env:
 *   KEYCLOAK_URL, KEYCLOAK_REALM, KEYCLOAK_AUDIENCE (client id)
 *   KEYCLOAK_ADMIN_USER, KEYCLOAK_ADMIN_PASSWORD  (Keycloak admin creds)
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD  (same as backend)
 */

import "dotenv/config";
import pg from "pg";

// ── Config ─────────────────────────────────────────────────────────────────

const KC_URL         = process.env.KEYCLOAK_URL            || "http://localhost:9090";
const KC_REALM       = process.env.KEYCLOAK_REALM          || "attendance";
const KC_CLIENT_ID   = process.env.KEYCLOAK_AUDIENCE       || "attendance-frontend";
const KC_ADMIN_USER  = process.env.KEYCLOAK_ADMIN_USER     || "admin";
const KC_ADMIN_PASS  = process.env.KEYCLOAK_ADMIN_PASSWORD || "admin";

const DB = {
  host:     process.env.DB_HOST     || "localhost",
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME     || "attendance_intelligence",
  user:     process.env.DB_USER     || "postgres",
  password: process.env.DB_PASSWORD || "postgres123",
};

// ── Keycloak admin helpers ──────────────────────────────────────────────────

async function getAdminToken() {
  const res = await fetch(`${KC_URL}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id:  "admin-cli",
      username:   KC_ADMIN_USER,
      password:   KC_ADMIN_PASS,
    }),
  });
  if (!res.ok) throw new Error(`Admin login failed (${res.status}): ${await res.text().catch(()=>"")}`);
  return (await res.json()).access_token;
}

async function kcReq(method, path, body, token, baseRealm = KC_REALM) {
  const url = path.startsWith("/realms") || path.startsWith("/admin/realms")
    ? `${KC_URL}${path}`
    : `${KC_URL}/admin/realms/${baseRealm}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return res;
}

// ── Phase 1: Create realm ──────────────────────────────────────────────────

async function ensureRealm(token) {
  console.log(`\n[Phase 1] Ensuring realm "${KC_REALM}" exists...`);

  const check = await kcReq("GET", `/admin/realms/${KC_REALM}`, undefined, token, "");
  if (check.ok) {
    console.log(`  ✓  Realm "${KC_REALM}" already exists.`);
    return;
  }
  if (check.status !== 404) throw new Error(`Realm check failed (${check.status})`);

  const create = await kcReq("POST", `/admin/realms`, {
    realm:              KC_REALM,
    displayName:        "FRS Attendance System",
    enabled:            true,
    registrationAllowed: false,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    resetPasswordAllowed:   true,
    editUsernameAllowed:    false,
    bruteForceProtected:    true,
    failureFactor:          5,
    waitIncrementSeconds:   60,
    accessTokenLifespan:    1800,
    ssoSessionIdleTimeout:  86400,
  }, token, "");

  if (![201, 204].includes(create.status)) {
    throw new Error(`Realm creation failed (${create.status}): ${await create.text().catch(()=>"")}`);
  }
  console.log(`  ✅  Realm "${KC_REALM}" created.`);
}

// ── Phase 2: Create client ─────────────────────────────────────────────────

async function ensureClient(token) {
  console.log(`\n[Phase 2] Ensuring client "${KC_CLIENT_ID}"...`);

  const list = await kcReq("GET", `/clients?clientId=${encodeURIComponent(KC_CLIENT_ID)}&first=0&max=1`, undefined, token);
  if (!list.ok) throw new Error(`Client list failed (${list.status})`);
  const existing = await list.json();

  if (existing.length) {
    console.log(`  ✓  Client "${KC_CLIENT_ID}" already exists (id: ${existing[0].id}).`);
    return existing[0].id;
  }

  const createRes = await kcReq("POST", `/clients`, {
    clientId:                  KC_CLIENT_ID,
    name:                      "FRS Attendance Frontend",
    enabled:                   true,
    publicClient:              true,
    standardFlowEnabled:       true,
    implicitFlowEnabled:       false,
    directAccessGrantsEnabled: true,          // allows password grant for testing
    serviceAccountsEnabled:    false,
    protocol:                  "openid-connect",
    redirectUris:              ["https://*.qa-frs.motivitylabs.com/*", "https://*.motivitylabs.com/*", "https://frs.motivitylabs.com/*", "http://localhost:*/*", "*"],
    webOrigins:                ["*"],
    attributes: {
      "pkce.code.challenge.method": "S256",
      "access.token.lifespan":      "1800",
    },
  }, token);

  if (![201, 204].includes(createRes.status)) {
    throw new Error(`Client creation failed (${createRes.status}): ${await createRes.text().catch(()=>"")}`);
  }

  // Re-fetch to get the internal id
  const refetch = await kcReq("GET", `/clients?clientId=${encodeURIComponent(KC_CLIENT_ID)}&first=0&max=1`, undefined, token);
  const created = await refetch.json();
  console.log(`  ✅  Client "${KC_CLIENT_ID}" created (id: ${created[0].id}).`);
  return created[0].id;
}

// ── Phase 3: Protocol Mapper ────────────────────────────────────────────────

async function ensureProtocolMapper(token, clientInternalId) {
  console.log(`\n[Phase 3] Ensuring Protocol Mapper "tenant-id-mapper"...`);

  const mapperBody = {
    name:           "tenant-id-mapper",
    protocol:       "openid-connect",
    protocolMapper: "oidc-usermodel-attribute-mapper",
    consentRequired: false,
    config: {
      "user.attribute":       "tenant_id",
      "claim.name":           "tenant_id",
      "jsonType.label":       "String",
      "access.token.claim":   "true",
      "id.token.claim":       "true",
      "userinfo.token.claim": "true",
      "multivalued":          "false",
      "aggregate.attrs":      "false",
    },
  };

  const list = await kcReq("GET", `/clients/${clientInternalId}/protocol-mappers/models`, undefined, token);
  if (!list.ok) throw new Error(`Mapper list failed (${list.status})`);
  const mappers = await list.json();
  const existing = mappers.find(m => m.name === "tenant-id-mapper");

  if (existing) {
    const upRes = await kcReq("PUT", `/clients/${clientInternalId}/protocol-mappers/models/${existing.id}`, { ...mapperBody, id: existing.id }, token);
    if (!upRes.ok && upRes.status !== 204) throw new Error(`Mapper update failed (${upRes.status})`);
    console.log(`  ✓  Mapper already exists — config verified/updated.`);
  } else {
    const create = await kcReq("POST", `/clients/${clientInternalId}/protocol-mappers/models`, mapperBody, token);
    if (![201, 204].includes(create.status)) {
      throw new Error(`Mapper creation failed (${create.status}): ${await create.text().catch(()=>"")}`);
    }
    console.log(`  ✅  Protocol Mapper "tenant-id-mapper" created.`);
  }
  console.log(`       User attribute: tenant_id  →  JWT claim: tenant_id`);
}

// ── Phase 4 & 5: Sync users ─────────────────────────────────────────────────

async function ensureRealmRole(roleName, token) {
  const check = await kcReq("GET", `/roles/${encodeURIComponent(roleName)}`, undefined, token);
  if (check.ok) return await check.json();
  if (check.status !== 404) throw new Error(`Role lookup failed for ${roleName} (${check.status})`);

  const create = await kcReq("POST", `/roles`, { name: roleName }, token);
  if (![201, 204].includes(create.status)) {
    throw new Error(`Role creation failed for ${roleName} (${create.status}): ${await create.text().catch(()=>"")}`);
  }
  const refetch = await kcReq("GET", `/roles/${encodeURIComponent(roleName)}`, undefined, token);
  return await refetch.json();
}

async function syncUsers(token) {
  console.log(`\n[Phase 4 & 5] Syncing FRS users to Keycloak...`);

  const pool = new pg.Pool(DB);

  let users;
  try {
    const result = await pool.query(`
      SELECT
        u.pk_user_id,
        u.email,
        u.username,
        u.role,
        u.keycloak_sub,
        -- Resolve tenant_id for this user
        CASE
          WHEN EXISTS (
            SELECT 1 FROM user_role ur
            JOIN rbac_role r ON r.pk_role_id = ur.fk_role_id
            WHERE ur.fk_user_id = u.pk_user_id
              AND r.role_name = 'super_admin'
              AND ur.is_active = TRUE
          ) THEN NULL
          ELSE COALESCE(
            (SELECT fk_tenant_id::text FROM frs_tenant_user_map WHERE fk_user_id = u.pk_user_id LIMIT 1),
            (SELECT c.fk_tenant_id::text
             FROM user_role ur
             JOIN rbac_role r  ON r.pk_role_id      = ur.fk_role_id
             LEFT JOIN frs_site s     ON s.pk_site_id     = ur.fk_site_id
             LEFT JOIN frs_customer c ON c.pk_customer_id = s.fk_customer_id
             WHERE ur.fk_user_id = u.pk_user_id AND ur.is_active = TRUE AND c.fk_tenant_id IS NOT NULL
             ORDER BY ur.pk_user_role_id LIMIT 1)
          )
        END AS resolved_tenant_id,
        -- Resolve realm role for this user
        COALESCE(
          (SELECT r.role_name FROM user_role ur JOIN rbac_role r ON r.pk_role_id = ur.fk_role_id
           WHERE ur.fk_user_id = u.pk_user_id AND ur.is_active = TRUE
           ORDER BY CASE r.role_name WHEN 'super_admin' THEN 0 WHEN 'tenant_admin' THEN 1 ELSE 2 END LIMIT 1),
          u.role
        ) AS effective_role
      FROM frs_user u
      ORDER BY u.pk_user_id
    `);
    users = result.rows;
  } finally {
    await pool.end();
  }

  console.log(`  Found ${users.length} FRS users.`);

  // Pre-load realm roles
  const realmRoles = {};
  for (const roleName of ["super_admin", "tenant_admin", "hr_manager", "site_admin", "viewer"]) {
    realmRoles[roleName] = await ensureRealmRole(roleName, token);
  }

  let created = 0, updated = 0, failed = 0;
  const results = [];

  for (const user of users) {
    const { pk_user_id, email, username, keycloak_sub, resolved_tenant_id, effective_role } = user;
    const attrValue     = resolved_tenant_id ?? "";
    const kcRole        = realmRoles[effective_role] || realmRoles["hr_manager"];
    const displayName   = (username || email).trim();
    const nameParts     = displayName.split(/\s+/).filter(Boolean);
    const firstName     = nameParts[0] || "User";
    const lastName      = nameParts.slice(1).join(" ") || firstName;

    try {
      let kcUserId = keycloak_sub;

      if (!kcUserId) {
        // Phase 4: User does not exist in Keycloak yet — create them
        const byEmail = await kcReq("GET", `/users?email=${encodeURIComponent(email)}&exact=true`, undefined, token);
        const existing = byEmail.ok ? await byEmail.json() : [];

        if (existing.length) {
          kcUserId = existing[0].id;
        } else {
          const createRes = await kcReq("POST", `/users`, {
            username:       email,
            email,
            firstName,
            lastName,
            enabled:        true,
            emailVerified:  true,
            requiredActions: [],
            // Temporary password — user must reset on first login
            credentials: [{
              type:      "password",
              value:     `FRS_Reset_${Math.random().toString(36).slice(2, 10)}`,
              temporary: true,
            }],
            attributes: { tenant_id: attrValue ? [attrValue] : [] },
          }, token);

          if (![201, 204].includes(createRes.status)) {
            throw new Error(`Create failed (${createRes.status}): ${await createRes.text().catch(()=>"")}`);
          }

          // Fetch back to get id
          const refetch = await kcReq("GET", `/users?email=${encodeURIComponent(email)}&exact=true`, undefined, token);
          const created_ = refetch.ok ? await refetch.json() : [];
          if (!created_.length) throw new Error("Created user not found on refetch");
          kcUserId = created_[0].id;
          created++;
        }

        // Write keycloak_sub back to frs_user
        const pool2 = new pg.Pool(DB);
        try {
          await pool2.query(`UPDATE frs_user SET keycloak_sub = $1 WHERE pk_user_id = $2`, [kcUserId, pk_user_id]);
        } finally {
          await pool2.end();
        }
      }

      // Phase 5: Sync tenant_id attribute (update existing user)
      const kcUserRes = await kcReq("GET", `/users/${kcUserId}`, undefined, token);
      if (!kcUserRes.ok) throw new Error(`Fetch user failed (${kcUserRes.status})`);
      const kcUser = await kcUserRes.json();

      const currentAttr = kcUser.attributes?.tenant_id?.[0] ?? "__NOT_SET__";
      const attrNeedsUpdate = currentAttr !== String(attrValue);

      if (attrNeedsUpdate) {
        const putRes = await kcReq("PUT", `/users/${kcUserId}`, {
          ...kcUser,
          attributes: { ...(kcUser.attributes || {}), tenant_id: attrValue ? [attrValue] : [] },
        }, token);
        if (!putRes.ok && putRes.status !== 204) throw new Error(`Attribute update failed (${putRes.status})`);
        updated++;
      }

      // Assign realm role
      const roleMappingRes = await kcReq("POST", `/users/${kcUserId}/role-mappings/realm`, [kcRole], token);
      if (!roleMappingRes.ok && roleMappingRes.status !== 204) {
        // 409 = already assigned, that's fine
        if (roleMappingRes.status !== 409) {
          console.warn(`  ⚠️  Role assignment warning for ${email} (${roleMappingRes.status})`);
        }
      }

      const tenantLabel = attrValue || "(super_admin — global)";
      const marker = keycloak_sub ? "✓" : "✅";
      console.log(`  ${marker}  ${email.padEnd(45)} role=${effective_role.padEnd(14)} tenant=${tenantLabel}`);
      results.push({ email, kcUserId, ok: true });

    } catch (err) {
      console.error(`  ❌  ${email}: ${err.message}`);
      failed++;
      results.push({ email, ok: false, error: err.message });
    }
  }

  console.log(`\n  Result: ${created} created, ${updated} attribute-updated, ${failed} failed`);
  if (failed > 0) {
    console.error("  Fix the errors above before switching AUTH_MODE=keycloak");
    process.exitCode = 1;
  }

  return results;
}

// ── Phase 6: Instructions ──────────────────────────────────────────────────

function printInstructions(results) {
  const allOk = results.every(r => r.ok);
  console.log(`
═══════════════════════════════════════════════════════════════════

[Phase 6]  Next Steps

${allOk ? "✅  All users synced successfully." : "⚠️  Some users failed — fix before proceeding."}

━━━  1. Verify the JWT contains tenant_id  ━━━━━━━━━━━━━━━━━━━━━━
Get a token for a tenant user and decode it at https://jwt.io :

  curl -s -X POST \\
    ${process.env.KEYCLOAK_URL || "http://localhost:9090"}/realms/${process.env.KEYCLOAK_REALM || "attendance"}/protocol/openid-connect/token \\
    -d "grant_type=password&client_id=${process.env.KEYCLOAK_AUDIENCE || "attendance-frontend"}" \\
    -d "username=<user-email>&password=<temp-password>" \\
  | python3 -c "import sys,json,base64; t=json.load(sys.stdin)['access_token']; p=t.split('.')[1]+'=='; print(json.dumps(json.loads(base64.b64decode(p)),indent=2))"

  Expected output:
  {
    "tenant_id": "<uuid>",         ← must be present for tenant users
    "realm_access": { "roles": ["tenant_admin"] }
  }

  For super_admin:
  {
    "tenant_id": null or missing,  ← empty attribute = global access
    "realm_access": { "roles": ["super_admin"] }
  }

━━━  2. Switch AUTH_MODE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Edit  FRS--Main-App/backend/.env  and change:

  AUTH_MODE=api   →   AUTH_MODE=keycloak

Then restart the backend:
  pm2 restart all   (or npm run dev for development)

━━━  3. Users must reset their passwords  ━━━━━━━━━━━━━━━━━━━━━━━
New Keycloak accounts were created with a TEMPORARY password.
Each user will be prompted to set a new password on first login.
Send them to:  ${process.env.KEYCLOAK_URL || "http://localhost:9090"}/realms/${process.env.KEYCLOAK_REALM || "attendance"}/account/

Or admin-reset via:  Keycloak Admin → Users → [user] → Credentials → Reset Password

━━━  4. Frontend login redirect  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
In Keycloak mode the frontend must redirect to Keycloak for login
instead of using the backend's /api/auth/login endpoint.
The /api/auth/login endpoint still works in API mode — update the
frontend to use PKCE flow once AUTH_MODE=keycloak is live.

═══════════════════════════════════════════════════════════════════
`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("         FRS Keycloak Full Bootstrap Script");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  KC URL   : ${KC_URL}`);
  console.log(`  Realm    : ${KC_REALM}`);
  console.log(`  Client   : ${KC_CLIENT_ID}`);
  console.log(`  DB       : ${DB.database}@${DB.host}:${DB.port}\n`);

  let token;
  try {
    token = await getAdminToken();
    console.log("✅  Keycloak admin authenticated.\n");
  } catch (err) {
    console.error("❌  Keycloak unreachable:", err.message);
    console.error("    Check KEYCLOAK_URL, KEYCLOAK_ADMIN_USER, KEYCLOAK_ADMIN_PASSWORD");
    process.exit(1);
  }

  await ensureRealm(token);

  // Re-authenticate — some Keycloak builds invalidate master tokens after realm creation
  token = await getAdminToken();

  const clientId = await ensureClient(token);
  await ensureProtocolMapper(token, clientId);
  const results = await syncUsers(token);

  printInstructions(results);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
