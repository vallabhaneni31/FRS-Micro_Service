#!/usr/bin/env node
/**
 * audit_rbac_membership.js — FIX-014: Legacy RBAC membership audit
 *
 * Identifies users who:
 *   1. Have no user_role rows (not in the RBAC system at all)
 *   2. Have roles that grant excessive permissions (super_admin on wrong tenant)
 *   3. Have duplicate / conflicting role assignments
 *   4. Have roles assigned by an unknown/deleted admin
 *
 * Usage:
 *   node audit_rbac_membership.js [--fix]
 *
 *   --fix   Disable (soft-delete) orphaned user_role rows instead of just reporting them.
 *           Requires DRY_RUN=false environment variable as an additional safety gate.
 *
 * Output: JSON report to stdout + audit_rbac_report_<timestamp>.json
 */
import pg from 'pg';
import fs  from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN   = process.env.DRY_RUN !== 'false';
const FIX_MODE  = process.argv.includes('--fix') && !DRY_RUN;

const pool = new pg.Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME     || 'frs',
  user:     process.env.DB_USER     || 'frs_app_user',
  password: process.env.DB_PASSWORD,
  ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : false,
});

async function run() {
  const report = {
    generated_at: new Date().toISOString(),
    dry_run: DRY_RUN,
    fix_mode: FIX_MODE,
    findings: {
      users_without_roles: [],
      super_admin_cross_tenant: [],
      duplicate_role_assignments: [],
      orphaned_assignments: [],
      inactive_but_active_roles: [],
    },
    summary: {},
    actions_taken: [],
  };

  const client = await pool.connect();
  try {
    // ── 1. Users with no RBAC roles ─────────────────────────────────────────
    const { rows: noRole } = await client.query(`
      SELECT ku.pk_user_id, ku.email, ku.keycloak_id, ku.is_active
      FROM keycloak_user ku
      WHERE ku.is_active = true
        AND NOT EXISTS (
          SELECT 1 FROM user_role ur WHERE ur.fk_user_id = ku.pk_user_id AND ur.is_active = true
        )
      ORDER BY ku.email
    `);
    report.findings.users_without_roles = noRole.map(r => ({
      user_id: r.pk_user_id,
      email: r.email,
      keycloak_id: r.keycloak_id,
      risk: 'INFO — no RBAC role assigned; user has no permissions',
    }));

    // ── 2. super_admin roles on non-global tenant context ───────────────────
    const { rows: crossTenant } = await client.query(`
      SELECT ku.pk_user_id, ku.email, rr.role_name, ur.fk_tenant_id, ur.pk_user_role_id
      FROM user_role ur
      JOIN keycloak_user ku ON ku.pk_user_id = ur.fk_user_id
      JOIN rbac_role     rr ON rr.pk_role_id  = ur.fk_role_id
      WHERE rr.role_name = 'super_admin'
        AND ur.fk_tenant_id IS NOT NULL
        AND ur.is_active = true
      ORDER BY ku.email
    `);
    report.findings.super_admin_cross_tenant = crossTenant.map(r => ({
      user_role_id: r.pk_user_role_id,
      user_id: r.pk_user_id,
      email: r.email,
      tenant_id: r.fk_tenant_id,
      risk: 'HIGH — super_admin scoped to a tenant; super_admin should be tenant-agnostic',
    }));

    // ── 3. Duplicate role assignments (same user + role + tenant) ────────────
    const { rows: dupes } = await client.query(`
      SELECT fk_user_id, fk_role_id, fk_tenant_id, COUNT(*) AS cnt,
             array_agg(pk_user_role_id) AS ids
      FROM user_role
      WHERE is_active = true
      GROUP BY fk_user_id, fk_role_id, fk_tenant_id
      HAVING COUNT(*) > 1
    `);
    report.findings.duplicate_role_assignments = dupes.map(r => ({
      user_id: r.fk_user_id,
      role_id: r.fk_role_id,
      tenant_id: r.fk_tenant_id,
      count: Number(r.cnt),
      user_role_ids: r.ids,
      risk: 'MEDIUM — duplicate role assignment; keep only the most recent',
    }));

    // ── 4. Role assignments whose assignee no longer exists ─────────────────
    const { rows: orphans } = await client.query(`
      SELECT ur.pk_user_role_id, ur.fk_user_id, ur.fk_role_id, ur.created_at
      FROM user_role ur
      WHERE ur.is_active = true
        AND NOT EXISTS (SELECT 1 FROM keycloak_user ku WHERE ku.pk_user_id = ur.fk_user_id)
      ORDER BY ur.created_at
    `);
    report.findings.orphaned_assignments = orphans.map(r => ({
      user_role_id: r.pk_user_role_id,
      user_id: r.fk_user_id,
      role_id: r.fk_role_id,
      created_at: r.created_at,
      risk: 'HIGH — role assigned to a user that no longer exists in keycloak_user',
    }));

    // ── 5. Inactive users still holding active roles ─────────────────────────
    const { rows: inactiveUsers } = await client.query(`
      SELECT ku.pk_user_id, ku.email, ku.is_active,
             count(ur.pk_user_role_id) AS role_count,
             array_agg(rr.role_name) AS roles
      FROM keycloak_user ku
      JOIN user_role ur ON ur.fk_user_id = ku.pk_user_id AND ur.is_active = true
      JOIN rbac_role rr ON rr.pk_role_id = ur.fk_role_id
      WHERE ku.is_active = false
      GROUP BY ku.pk_user_id, ku.email, ku.is_active
      ORDER BY ku.email
    `);
    report.findings.inactive_but_active_roles = inactiveUsers.map(r => ({
      user_id: r.pk_user_id,
      email: r.email,
      roles: r.roles,
      risk: 'HIGH — disabled user still holds active RBAC roles',
    }));

    // ── Summary ──────────────────────────────────────────────────────────────
    report.summary = {
      users_without_roles_count:        report.findings.users_without_roles.length,
      super_admin_cross_tenant_count:   report.findings.super_admin_cross_tenant.length,
      duplicate_role_assignments_count: report.findings.duplicate_role_assignments.length,
      orphaned_assignments_count:       report.findings.orphaned_assignments.length,
      inactive_with_active_roles_count: report.findings.inactive_but_active_roles.length,
    };

    // ── Fix mode: disable orphaned + inactive user roles ────────────────────
    if (FIX_MODE) {
      // Disable orphaned
      for (const row of orphans) {
        await client.query(
          `UPDATE user_role SET is_active = false, updated_at = NOW()
           WHERE pk_user_role_id = $1`,
          [row.pk_user_role_id]
        );
        report.actions_taken.push({ action: 'disabled_orphan', user_role_id: row.pk_user_role_id });
      }
      // Disable inactive users' roles
      for (const row of inactiveUsers) {
        await client.query(
          `UPDATE user_role SET is_active = false, updated_at = NOW()
           WHERE fk_user_id = $1 AND is_active = true`,
          [row.pk_user_id]
        );
        report.actions_taken.push({ action: 'disabled_inactive_user_roles', user_id: row.pk_user_id });
      }
      console.warn(`[FIX-014] Applied ${report.actions_taken.length} automated fixes`);
    }

  } finally {
    client.release();
    await pool.end();
  }

  // ── Write report ─────────────────────────────────────────────────────────
  const ts       = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = path.join(__dirname, `../audit_rbac_report_${ts}.json`);
  fs.writeFileSync(filename, JSON.stringify(report, null, 2));

  console.log(JSON.stringify(report, null, 2));
  console.error(`\n[FIX-014] Report saved to: ${filename}`);

  // Exit non-zero if HIGH findings present
  const hasHigh = [
    ...report.findings.super_admin_cross_tenant,
    ...report.findings.orphaned_assignments,
    ...report.findings.inactive_but_active_roles,
  ].some(f => f.risk.startsWith('HIGH'));

  process.exit(hasHigh && !FIX_MODE ? 1 : 0);
}

run().catch(err => {
  console.error('[FIX-014] Fatal error:', err);
  process.exit(2);
});
