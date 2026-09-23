/**
 * tenantAdminRoutes.js — Tenant Admin scoped APIs
 * All routes are scoped to the calling user's tenantId from their token.
 *
 * Business logic lives in services/business/TenantAdminService.js, backed by
 * repositories/tenantAdminRepository.js. This file only wires
 * routes -> middleware -> controller.
 */
import express from 'express';
import { requireAuth } from '../middleware/authz.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import logger from '../utils/logger.js';
import { env } from '../config/env.js';
import { isTenantAdmin } from '../repositories/tenantAdminRepository.js';
import TenantAdminController from '../controllers/TenantAdminController.js';

const router = express.Router();
const ac = (fn) => asyncHandler(fn);

// ── Guard: caller must be tenant_admin (or super_admin) ─────────────────────
async function requireTenantAdmin(req, res, next) {
  // ── DEV BYPASS ─────────────────────────────────────────────────────────────
  if (env.nodeEnv === 'development') {
    logger.warn('[tenant-admin] [DEV BYPASS] Skipping tenant admin check (NODE_ENV=development)');
    return next();
  }
  // ───────────────────────────────────────────────────────────────────────────
  const userId = req.auth?.user?.id;
  if (!userId) return res.status(401).json({ message: 'unauthorized' });
  try {
    // Recognize tenant admins across BOTH RBAC models (see authz.js notes):
    //  • legacy: user_role → rbac_role with role_name tenant_admin/super_admin
    //  • new multi-tenant model: the role lives in frs_user.role as the membership
    //    label 'admin' (alias of tenant_admin) or 'super_admin'.
    // Without the frs_user.role branch, tenant admins provisioned only in the new
    // model (no legacy user_role rows — e.g. Keycloak-provisioned users) are
    // wrongly rejected with 403, breaking every /tenant-admin/* page. Data access
    // stays tenant-scoped via the signed JWT tenant_id, so this does not widen
    // what a tenant admin can see beyond their own tenant.
    const ok = await isTenantAdmin(userId);
    if (!ok) {
      return res.status(403).json({ message: 'tenant_admin access required' });
    }
    next();
  } catch (err) {
    logger.error('[tenant-admin] guard error:', err);
    return res.status(500).json({ message: 'internal error' });
  }
}

router.get('/overview', requireAuth, requireTenantAdmin, ac(TenantAdminController.getOverview));
router.get('/sites', requireAuth, requireTenantAdmin, ac(TenantAdminController.getSites));
router.get('/users', requireAuth, requireTenantAdmin, ac(TenantAdminController.getUsers));
router.post('/users', requireAuth, requireTenantAdmin, ac(TenantAdminController.createUser));
router.post('/users/sync', requireAuth, requireTenantAdmin, ac(TenantAdminController.syncUsers));
router.get('/analytics', requireAuth, requireTenantAdmin, ac(TenantAdminController.getAnalytics));
router.get('/ui-config', requireAuth, requireTenantAdmin, ac(TenantAdminController.getUiConfig));
router.patch('/ui-config', requireAuth, requireTenantAdmin, ac(TenantAdminController.updateUiConfig));

router.get('/groups', requireAuth, requireTenantAdmin, ac(TenantAdminController.getGroups));
router.post('/groups', requireAuth, requireTenantAdmin, ac(TenantAdminController.createGroup));
router.patch('/groups/:id', requireAuth, requireTenantAdmin, ac(TenantAdminController.updateGroup));
router.delete('/groups/:id', requireAuth, requireTenantAdmin, ac(TenantAdminController.deleteGroup));

router.get('/groups/:id/members', requireAuth, requireTenantAdmin, ac(TenantAdminController.getGroupMembers));
router.post('/groups/:id/members', requireAuth, requireTenantAdmin, ac(TenantAdminController.addGroupMember));
router.delete('/groups/:id/members/:userId', requireAuth, requireTenantAdmin, ac(TenantAdminController.removeGroupMember));

export default router;
