#!/usr/bin/env node
/**
 * verify-dedicated-realm.js
 *
 * Proves the new-tenant code path works against a live Keycloak: it calls the
 * SAME functions POST /tenants calls — provisionDedicatedRealm +
 * createKeycloakOrganization — then checks via the admin API that the realm and
 * org actually exist, and cleans up with deleteDedicatedRealm.
 *
 * Run from backend/ with KEYCLOAK_URL pointed at the verify Keycloak:
 *   KEYCLOAK_URL=http://localhost:9090/auth node scripts/verify-dedicated-realm.js
 */
import {
  provisionDedicatedRealm,
  createKeycloakOrganization,
  deleteDedicatedRealm,
} from "../src/services/keycloakProvisioner.js";
import { env } from "../src/config/env.js";

const KC = env.keycloak.url;
const slug = `verify-${Date.now()}`;
const ok = (b) => (b ? "✅ PASS" : "❌ FAIL");

async function adminToken() {
  const res = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: process.env.KEYCLOAK_ADMIN_USER || "admin",
      password: process.env.KEYCLOAK_ADMIN_PASSWORD || "admin",
    }),
  });
  if (!res.ok) throw new Error(`admin token failed (${res.status})`);
  return (await res.json()).access_token;
}

async function main() {
  console.log(`KEYCLOAK_URL = ${KC}`);
  console.log(`test slug    = ${slug}\n`);

  // ── Replay exactly what Phase A of POST /tenants does ──
  console.log("→ provisionDedicatedRealm(...) [security policy: 60m / 3 fails / len 10]");
  await provisionDedicatedRealm({
    realmSlug: slug,
    realmName: `Verify ${slug}`,
    sessionTimeoutMinutes: 60,
    maxFailedLogins: 3,
    passwordMinLength: 10,
  });

  console.log("→ createKeycloakOrganization(...)  (tenant-level org)\n");
  await createKeycloakOrganization({ realmSlug: slug, orgSlug: slug, orgName: `Verify ${slug}` });

  // ── Verify via the admin API ──
  const token = await adminToken();
  const h = { Authorization: `Bearer ${token}` };

  const realmRes = await fetch(`${KC}/admin/realms/${slug}`, { headers: h });
  const realm = realmRes.ok ? await realmRes.json() : {};
  const orgRes = await fetch(`${KC}/admin/realms/${slug}/organizations`, { headers: h });
  const orgs = orgRes.ok ? await orgRes.json() : [];
  const clientRes = await fetch(`${KC}/admin/realms/${slug}/clients?clientId=attendance-frontend`, { headers: h });
  const clients = clientRes.ok ? await clientRes.json() : [];
  const rolesRes = await fetch(`${KC}/admin/realms/${slug}/roles`, { headers: h });
  const roles = rolesRes.ok ? (await rolesRes.json()).map((r) => r.name) : [];

  console.log("─ Results ───────────────────────────────────────────");
  console.log(`${ok(realmRes.status === 200)}  realm exists                (GET realm = ${realmRes.status})`);
  console.log(`${ok(clients.length === 1)}  attendance-frontend client  (found ${clients.length})`);
  console.log(`${ok(["super_admin","tenant_admin","site_admin","hr_manager","viewer"].every((r) => roles.includes(r)))}  5 default roles seeded      (${roles.filter((r)=>!r.startsWith("default")&&r!=="offline_access"&&r!=="uma_authorization").join(", ")})`);
  console.log(`${ok(orgs.some((o) => (o.alias || o.name) === slug))}  tenant org exists           (${orgs.map((o) => o.alias || o.name).join(", ") || "none"})`);
  console.log(`${ok(realm.ssoSessionMaxLifespan === 3600)}  session policy applied      (ssoSessionMaxLifespan = ${realm.ssoSessionMaxLifespan})`);
  console.log(`${ok(realm.bruteForceProtected === true && realm.failureFactor === 3)}  lockout policy applied      (bruteForce=${realm.bruteForceProtected}, failureFactor=${realm.failureFactor})`);
  console.log(`${ok(realm.passwordPolicy === "length(10)")}  password policy applied     (${realm.passwordPolicy})`);
  console.log(`${ok(realm.organizationsEnabled === true)}  organizations enabled       (${realm.organizationsEnabled})`);
  console.log("─────────────────────────────────────────────────────\n");

  // ── Clean up (proves deleteDedicatedRealm compensation works too) ──
  console.log("→ deleteDedicatedRealm(...) cleanup");
  await deleteDedicatedRealm({ realmSlug: slug });
  const gone = await fetch(`${KC}/admin/realms/${slug}`, { headers: h });
  console.log(`${ok(gone.status === 404)}  realm deleted               (GET realm = ${gone.status})`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("\n❌ verification error:", err.message);
  // best-effort cleanup
  deleteDedicatedRealm({ realmSlug: slug }).catch(() => {});
  process.exit(1);
});
