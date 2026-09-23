#!/usr/bin/env node
/**
 * backfill-realm-security-policy.js — AB#2730
 *
 * "Account Is Not Locked After Exceeding Configured Maximum Failed Login
 * Attempts": realms provisioned before this fix (or via the
 * backfillOrganizations() call site that used to omit maxFailedLogins) may
 * exist in Keycloak with bruteForceProtected left OFF, even though
 * tenant_realm.max_failed_logins has a value in the DB.
 *
 * This is a ONE-OFF sync: for every tenant_realm row, push
 * { bruteForceProtected: true, failureFactor: max_failed_logins } to the
 * corresponding EXISTING Keycloak realm via applyRealmSecurityPolicy().
 * Idempotent / safe to re-run — a realm that's already in sync is just
 * overwritten with the same values.
 *
 * Run from backend/api with KEYCLOAK_URL + DB_* pointed at the target env:
 *   node scripts/backfill-realm-security-policy.js
 */
import { pool } from "../src/db/pool.js";
import { applyRealmSecurityPolicy } from "../src/services/keycloakProvisioner.js";

async function main() {
  const { rows: realms } = await pool.query(
    `SELECT tr.fk_tenant_id, tr.realm_slug, tr.max_failed_logins, t.tenant_name
     FROM tenant_realm tr
     JOIN frs_tenant t ON t.pk_tenant_id = tr.fk_tenant_id
     WHERE tr.realm_slug IS NOT NULL
     ORDER BY t.tenant_name`
  );

  console.log(`[backfill-realm-security-policy] Found ${realms.length} tenant realm(s).`);

  let synced = 0;
  let failed = 0;

  for (const realm of realms) {
    const maxFailedLogins = realm.max_failed_logins ?? 5;
    try {
      await applyRealmSecurityPolicy({ realmSlug: realm.realm_slug, maxFailedLogins });
      synced += 1;
      console.log(
        `[backfill-realm-security-policy] Synced ${realm.tenant_name} (${realm.realm_slug}): failureFactor=${maxFailedLogins}`
      );
    } catch (error) {
      failed += 1;
      console.warn(
        `[backfill-realm-security-policy] Failed ${realm.tenant_name} (${realm.realm_slug}): ${error.message}`
      );
    }
  }

  console.log(`[backfill-realm-security-policy] Done. synced=${synced} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("[backfill-realm-security-policy] Fatal error:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
