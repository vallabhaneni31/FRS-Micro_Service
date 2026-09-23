import { pool } from '../db/pool.js';
import { writeAudit } from '../middleware/auditLog.js';
import logger from '../utils/logger.js';
import * as svc from '../services/business/UserService.js';
import { ConflictError, ValidationError, NotFoundError, UpstreamError } from '../services/business/UserService.js';
import { validateDisplayName, validateEmailFormat, normalizeDisplayName } from '../utils/userValidation.js';

function getTenantId(req) {
  return req.auth?.scope?.tenantId ?? null;
}
function isSuperAdmin(req) {
  return req.auth?.memberships?.some((m) => m.role === 'super_admin');
}
function canAssignRole(req, targetRole) {
  const memberships = req.auth?.memberships || [];
  const isCallerSuperAdmin = memberships.some((m) => m.role === 'super_admin');
  if (isCallerSuperAdmin) return true;

  const isCallerTenantAdmin = memberships.some((m) => m.role === 'tenant_admin');
  if (isCallerTenantAdmin) {
    const allowed = ['site_admin', 'hr_manager', 'viewer', 'device_operator'];
    return allowed.includes(targetRole);
  }

  // Transport vertical only: a Route Manager (platform role site_admin)
  // creates Operations Managers, which reuse the platform's hr_manager role
  // (see UserManagement.tsx). Gated on mt.vertical, not just the caller's
  // role, so a Site Admin in any other vertical — who never had permission
  // to assign roles before — still can't.
  const isCallerSiteAdmin = memberships.some((m) => m.role === 'site_admin');
  if (isCallerSiteAdmin && req.auth?.mt?.vertical === 'transport') {
    return targetRole === 'hr_manager';
  }

  return false;
}

function mapKnownError(err, res) {
  if (err instanceof ConflictError) return res.status(409).json({ message: err.message });
  if (err instanceof ValidationError) return res.status(400).json({ message: err.message });
  if (err instanceof NotFoundError) return res.status(404).json({ message: err.message });
  if (err instanceof UpstreamError) return res.status(502).json({ message: err.message });
  return null;
}

const VALID_ROLES = ['admin', 'hr', 'hr_manager', 'tenant_admin', 'super_admin', 'site_admin', 'viewer', 'device_operator'];

const UserController = {
  // GET /api/users
  async listUsers(req, res) {
    const tenantId = getTenantId(req);
    const role = req.auth?.user?.role;
    const siteId = req.auth?.scope?.siteId ?? null;
    const users = await svc.listUsers({ tenantId, isSuperAdminFlag: isSuperAdmin(req), role, siteId });
    return res.json({ data: users });
  },

  // POST /api/users
  async createUser(req, res) {
    const { email, role, department, siteId: reqSiteId, siteIds: reqSiteIds } = req.body;
    let { username } = req.body;

    const emailValidation = validateEmailFormat(email);
    if (!emailValidation.valid) {
      return res.status(400).json({ message: emailValidation.error });
    }

    const nameValidation = validateDisplayName(username);
    if (!nameValidation.valid) {
      return res.status(400).json({ message: nameValidation.error });
    }
    username = normalizeDisplayName(username);
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ message: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }
    if (!canAssignRole(req, role)) {
      return res.status(403).json({ message: `Forbidden: You do not have permission to assign the role ${role}` });
    }

    const dup = await svc.emailAlreadyExists(email);
    if (dup) {
      return res.status(409).json({ message: 'A user with this email already exists' });
    }

    const callerTenantId = getTenantId(req);

    const client = await pool.connect();
    let user;
    try {
      await client.query('BEGIN');
      ({ user } = await svc.createUser(client, { email, username, role, department, reqSiteId, reqSiteIds, callerTenantId }));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Post-commit: Keycloak sync (non-fatal) + fire-and-forget invite email
    await svc.syncNewUserToKeycloak({ email, username, role, callerTenantId, reqSiteId, userId: user.pk_user_id });

    const inviterName = req.auth?.user?.name ?? 'Admin';
    const tenantName = await svc.resolveTenantNameForInvite(user.pk_user_id);
    svc.sendNewUserInviteEmail({
      userId: user.pk_user_id, email, username, inviterName, role, tenantName,
      invitedById: req.auth?.user?.id ?? null,
    });

    await writeAudit({ req, action: 'user.create', details: `User created: ${email} (${role})` });

    return res.status(201).json({
      pk_user_id: user.pk_user_id,
      id: String(user.pk_user_id),
      email: user.email,
      username: user.username,
      role: user.role,
      department: user.department,
      is_active: true,
      created_at: user.created_at,
    });
  },

  // PUT /api/users/:id
  async updateUser(req, res) {
    const id = Number(req.params.id);
    const { department, siteId, siteIds, role } = req.body;
    let { username } = req.body;
    if (!id) return res.status(400).json({ message: 'Invalid user ID' });

    if (username !== undefined) {
      const nameValidation = validateDisplayName(username);
      if (!nameValidation.valid) {
        return res.status(400).json({ message: nameValidation.error });
      }
      username = normalizeDisplayName(username);
    }

    if (role !== undefined) {
      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ message: `role must be one of: ${VALID_ROLES.join(', ')}` });
      }
      if (!canAssignRole(req, role)) {
        return res.status(403).json({ message: `Forbidden: You do not have permission to assign the role ${role}` });
      }
    }

    const tenantId = getTenantId(req);
    if (!isSuperAdmin(req)) {
      const inTenant = await svc.assertUserInTenant(id, tenantId);
      if (!inTenant) return res.status(404).json({ message: 'User not found' });
    }

    let user;
    try {
      user = await svc.updateUser({ id, username, department, siteId, siteIds, tenantId, role });
    } catch (err) {
      const mapped = mapKnownError(err, res);
      if (mapped) return mapped;
      throw err;
    }

    await writeAudit({ req, action: 'user.update', details: `User updated: ${user.email}` });
    return res.json({ success: true, data: user });
  },

  // PUT /api/users/:id/password
  // AB#3270: no longer accepts a password from the admin — it sends the
  // target user a self-service password-reset link instead (see
  // UserService.resetPassword).
  async resetPassword(req, res) {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ message: 'ID is required' });
    }

    const tenantId = getTenantId(req);
    if (!isSuperAdmin(req)) {
      const inTenant = await svc.assertUserInTenant(id, tenantId);
      if (!inTenant) return res.status(404).json({ message: 'User not found' });
    }

    let user;
    try {
      ({ user } = await svc.resetPassword({ id }));
    } catch (err) {
      const mapped = mapKnownError(err, res);
      if (mapped) return mapped;
      throw err;
    }

    await writeAudit({ req, action: 'user.password_reset', details: `Password reset link sent to: ${user.email}` });
    return res.json({ success: true });
  },

  // PUT /api/users/:id/deactivate
  async deactivateUser(req, res) {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: 'Invalid user ID' });

    const tenantId = getTenantId(req);
    if (!isSuperAdmin(req)) {
      const inTenant = await svc.assertUserInTenant(id, tenantId);
      if (!inTenant) return res.status(404).json({ message: 'User not found' });
    }

    let user;
    try {
      user = await svc.deactivateUser(id);
    } catch (err) {
      const mapped = mapKnownError(err, res);
      if (mapped) return mapped;
      throw err;
    }

    await writeAudit({ req, action: 'user.deactivate', details: `User deactivated: ${user.email}` });
    return res.json({ success: true, is_active: false });
  },

  // PUT /api/users/:id/activate
  async activateUser(req, res) {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: 'Invalid user ID' });

    const tenantId = getTenantId(req);
    if (!isSuperAdmin(req)) {
      const inTenant = await svc.assertUserInTenant(id, tenantId);
      if (!inTenant) return res.status(404).json({ message: 'User not found' });
    }

    let user;
    try {
      user = await svc.activateUser(id);
    } catch (err) {
      const mapped = mapKnownError(err, res);
      if (mapped) return mapped;
      throw err;
    }

    await writeAudit({ req, action: 'user.activate', details: `User activated: ${user.email}` });
    return res.json({ success: true, is_active: true });
  },

  // DELETE /api/users/:id
  async deleteUser(req, res) {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: 'Invalid user ID' });

    const tenantId = getTenantId(req);
    if (!isSuperAdmin(req)) {
      const inTenant = await svc.assertUserInTenant(id, tenantId);
      if (!inTenant) return res.status(404).json({ message: 'User not found' });
    }

    await svc.deleteUser(id, tenantId);

    await writeAudit({ req, action: 'user.delete', details: `User deleted: ID ${req.params.id}` });
    return res.json({ success: true });
  },

  // POST /api/users/sync-keycloak
  async syncKeycloak(req, res) {
    if (!isSuperAdmin(req)) {
      return res.status(403).json({ message: 'Only platform administrators can sync the identity provider' });
    }

    const prunedCount = await svc.syncKeycloakUsers();

    if (prunedCount > 0) {
      await writeAudit({ req, action: 'user.sync_idp', details: `Keycloak sync: Pruned ${prunedCount} orphaned user accounts across realms` });
    }

    return res.json({ success: true, prunedCount });
  },
};

export default UserController;
