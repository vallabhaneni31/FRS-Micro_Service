import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// specs/0003-zone-analytics — Task 1: `zones.read` RBAC permission catalog test.
//
// This repo's other authz-adjacent tests (password.test.js, security.test.js)
// are pure unit tests against static source, not live-DB integration tests, so
// this follows the same pattern: assert against the migration SQL text and the
// ROLE_PERMISSIONS catalog in authz.js (the source `requirePermission` actually
// evaluates in Keycloak mode, and the map the file's own comment says is
// "Synced from rbac_role_permission table").

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(
  __dirname,
  "../db/migrations/029_seed_zones_read_permission.sql"
);
const authzPath = path.join(__dirname, "../middleware/authz.js");

test("029 migration seeds zones.read permission assigned only to hr_manager", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /INSERT INTO rbac_permission[\s\S]*'zones\.read'/);
  assert.match(
    sql,
    /WHERE r\.role_name = 'hr_manager'[\s\S]*p\.permission_code = 'zones\.read'/
  );

  // No other role_name literal is referenced as a grant target for zones.read
  // in this file (only hr_manager appears as a role_name filter).
  const roleNameMatches = [...sql.matchAll(/r\.role_name = '([a-z_]+)'/g)].map(
    (m) => m[1]
  );
  assert.deepStrictEqual(roleNameMatches, ["hr_manager"]);
});

test("authz.js ROLE_PERMISSIONS grants zones.read only to hr_manager", () => {
  const src = fs.readFileSync(authzPath, "utf8");
  const match = src.match(/const ROLE_PERMISSIONS = (\{[\s\S]*?\n\});/);
  assert.ok(match, "ROLE_PERMISSIONS map not found in authz.js");

  // eslint-disable-next-line no-eval -- static local-source map literal, test-only
  const ROLE_PERMISSIONS = eval(`(${match[1]})`);

  for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    if (role === "hr_manager") {
      assert.ok(
        permissions.includes("zones.read"),
        "hr_manager must hold zones.read"
      );
    } else {
      assert.ok(
        !permissions.includes("zones.read"),
        `${role} must NOT hold zones.read (Zone Analytics is HR-only, requirements.md Revision 3)`
      );
    }
  }
});
