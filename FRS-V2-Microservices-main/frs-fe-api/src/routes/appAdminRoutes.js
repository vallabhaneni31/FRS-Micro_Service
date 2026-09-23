/**
 * appAdminRoutes.js — Application-level Admin APIs (super_admin only)
 * Tenant & Customer CRUD + cross-tenant overview stats
 *
 * Business logic lives in services/business/AppAdminService.js, backed by
 * repositories/{tenantRepository,customerRepository,tenantTypeRepository,auditLogRepository}.js.
 * This file only wires routes -> middleware -> controller.
 */
import express from 'express';
import { requireAuth } from '../middleware/authz.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { pool } from '../db/pool.js';
import logger from '../utils/logger.js';
import AppAdminController from '../controllers/AppAdminController.js';

const router = express.Router();
const ac = (fn) => asyncHandler(fn);

// ── Guard: only super_admin RBAC role may call these routes ─────────────────
async function requireSuperAdmin(req, res, next) {
  const userId = req.auth?.user?.id;
  if (!userId) return res.status(401).json({ message: 'unauthorized' });
  try {
    const result = await pool.query(
      `SELECT ur.pk_user_role_id
       FROM user_role ur
       JOIN rbac_role rr ON rr.pk_role_id = ur.fk_role_id
       WHERE ur.fk_user_id = $1::bigint
         AND rr.role_name = 'super_admin'
         AND ur.is_active = true
       LIMIT 1`,
      [userId]
    );

    const jwtRoles = req.auth?.jwtPayload?.realm_access?.roles || [];
    logger.info(`[app-admin] requireSuperAdmin check: userId=${userId}, dbRows=${result.rows.length}, jwtRoles=${JSON.stringify(jwtRoles)}`);

    if (result.rows.length === 0 && !jwtRoles.includes('super_admin')) {
      return res.status(403).json({ message: 'super_admin access required' });
    }
    next();
  } catch (err) {
    logger.error('[app-admin] requireSuperAdmin error:', err);
    return res.status(500).json({ message: 'internal error checking permissions' });
  }
}

router.use(requireAuth, requireSuperAdmin);

// ============================================================================
// GET /api/app-admin/overview — Cross-tenant summary stats
// GET /api/app-admin/analytics — Cross-tenant global analytics
// ============================================================================
router.get('/overview', ac(AppAdminController.getOverview));
router.get('/analytics', ac(AppAdminController.getAnalytics));

// ============================================================================
// TENANT TYPES CRUD
// ============================================================================
router.get('/tenant-types', ac(AppAdminController.listTenantTypes));
router.post('/tenant-types', ac(AppAdminController.createTenantType));
router.patch('/tenant-types/:id', ac(AppAdminController.updateTenantType));
router.delete('/tenant-types/:id', ac(AppAdminController.deleteTenantType));

// ============================================================================
// TENANTS CRUD
// ============================================================================
router.get('/tenants', ac(AppAdminController.listTenants));
router.post('/tenants', ac(AppAdminController.createTenant));

// ── Backfill: ensure a dedicated realm + organization for EVERY tenant ──────
/**
 * POST /api/app-admin/organizations/backfill
 *
 * Enforces the invariant: EVERY tenant has (1) a dedicated Keycloak realm and
 * (2) a tenant-level Keycloak Organization. It also ensures one org per site
 * and repairs drifted frs_site.keycloak_org_id pointers.
 *
 * Body:
 *   tenantId?    string  — limit to one tenant (omit = all tenants)
 *   dryRun?      boolean — report planned changes without any Keycloak/DB writes
 *   syncMembers? boolean — also enrol each tenant's mapped users into its org
 *
 * Super-admin only.
 */
router.post('/organizations/backfill', ac(AppAdminController.backfillOrganizations));

router.get('/tenants/:id/realm', ac(AppAdminController.getTenantRealm));

// ── Provision (or repair) the dedicated realm for ONE existing tenant ───────
/**
 * POST /api/app-admin/tenants/:id/realm/provision
 *
 * Ensures a single existing tenant has its dedicated Keycloak realm, its
 * tenant-level organization, and (by default) its mapped users provisioned into
 * that realm. Use when a tenant was created without a realm, or to repair a
 * half-provisioned one.
 *
 * Body:
 *   provisionUsers? boolean (default true) — also create the tenant's DB users
 *                                            in the realm + enrol them in the org
 *
 * Super-admin, Keycloak mode only.
 */
router.post('/tenants/:id/realm/provision', ac(AppAdminController.provisionTenantRealm));

router.patch('/tenants/:id', ac(AppAdminController.updateTenant));
router.delete('/tenants/:id', ac(AppAdminController.deleteTenant));

// ============================================================================
// TENANT ADMIN ASSIGNMENT
// ============================================================================
router.get('/tenants/:id/admins', ac(AppAdminController.listTenantAdmins));
router.post('/tenants/:id/admins', ac(AppAdminController.assignTenantAdmin));
router.delete('/tenants/:id/admins/:userId', ac(AppAdminController.deleteTenantAdmin));

// ============================================================================
// CUSTOMERS CRUD
// ============================================================================
router.get('/customers', ac(AppAdminController.listCustomers));
router.post('/customers', ac(AppAdminController.createCustomer));
router.patch('/customers/:id', ac(AppAdminController.updateCustomer));
router.delete('/customers/:id', ac(AppAdminController.deleteCustomer));

// ============================================================================
// ACTIVITY LOG (cross-tenant audit) — super_admin only
// ============================================================================

/**
 * GET /api/app-admin/audit
 * GET /api/app-admin/activity-log
 * GET /api/app-admin/activity-logs
 * GET /api/app-admin/activity_log
 * Query params: tenant_id?, q?, category?, from?, to?, limit?, offset?
 */
router.get('/audit', ac(AppAdminController.listAuditEntries));
router.get('/activity-log', ac(AppAdminController.listAuditEntries));
router.get('/activity-logs', ac(AppAdminController.listAuditEntries));
router.get('/activity_log', ac(AppAdminController.listAuditEntries));
router.get('/', ac(AppAdminController.listAuditEntries));

/**
 * GET /api/app-admin/audit/summary
 * GET /api/app-admin/activity-log/summary
 * GET /api/app-admin/activity-logs/summary
 * GET /api/app-admin/activity_log/summary
 * Query params: tenant_id?, from?, to?
 */
router.get('/audit/summary', ac(AppAdminController.getAuditSummary));
router.get('/activity-log/summary', ac(AppAdminController.getAuditSummary));
router.get('/activity-logs/summary', ac(AppAdminController.getAuditSummary));
router.get('/activity_log/summary', ac(AppAdminController.getAuditSummary));
router.get('/summary', ac(AppAdminController.getAuditSummary));

export default router;
