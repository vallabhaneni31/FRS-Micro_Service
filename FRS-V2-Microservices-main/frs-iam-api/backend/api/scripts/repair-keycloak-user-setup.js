import { pool } from "../src/db/pool.js";
import {
  ensureKeycloakRealmRole,
  ensureKeycloakUserReady,
  findKeycloakUser,
  mapRoleToKeycloakRealmRole,
} from "../src/services/keycloakUserService.js";

async function main() {
  const { rows: users } = await pool.query(
    `SELECT pk_user_id, email, username, role, keycloak_sub
     FROM frs_user
     WHERE email IS NOT NULL
     ORDER BY pk_user_id`
  );

  let repaired = 0;
  let linked = 0;
  let skipped = 0;

  for (const user of users) {
    try {
      const found = await findKeycloakUser({
        keycloakSub: user.keycloak_sub,
        email: user.email,
      });

      if (!found.user?.id) {
        skipped += 1;
        console.warn(`[repair-keycloak-user-setup] Skipped ${user.email}: no Keycloak user found`);
        continue;
      }

      const ready = await ensureKeycloakUserReady({
        keycloakSub: found.user.id,
        email: user.email,
        username: user.username,
        adminToken: found.adminToken,
      });

      await ensureKeycloakRealmRole({
        keycloakUserId: ready.keycloakUserId,
        realmRole: mapRoleToKeycloakRealmRole(user.role),
        adminToken: ready.adminToken,
      });

      if (user.keycloak_sub !== ready.keycloakUserId) {
        await pool.query(
          `UPDATE frs_user
           SET keycloak_sub = $1
           WHERE pk_user_id = $2`,
          [ready.keycloakUserId, user.pk_user_id]
        );
        linked += 1;
      }

      repaired += 1;
      console.log(`[repair-keycloak-user-setup] Repaired ${user.email}`);
    } catch (error) {
      skipped += 1;
      console.warn(`[repair-keycloak-user-setup] Failed ${user.email}: ${error.message}`);
    }
  }

  console.log(
    `[repair-keycloak-user-setup] Done. repaired=${repaired} linked=${linked} skipped=${skipped}`
  );
}

main()
  .catch((error) => {
    console.error("[repair-keycloak-user-setup] Fatal error:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
