import { pool } from '../db/pool.js';
import dns from 'dns';
import { writeAudit } from '../middleware/auditLog.js';
import logger from '../utils/logger.js';
import { env } from '../config/env.js';
import * as svc from '../services/business/TenantAdminService.js';
import { ConflictError, ValidationError, NotFoundError } from '../services/business/TenantAdminService.js';
import { validateDisplayName, validateEmailFormat, normalizeDisplayName } from '../utils/userValidation.js';

function getTenantId(req) {
  return req.auth?.scope?.tenantId ?? req.headers['x-tenant-id'] ?? req.query.tenantId ?? null;
}

function mapKnownError(err, res) {
  if (err instanceof ConflictError) return res.status(409).json({ error: err.message });
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
  return null;
}

const TenantAdminController = {
  // GET /overview
  async getOverview(req, res) {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'tenant scope required' });
    const stats = await svc.getOverviewStats(tenantId);
    res.json(stats);
  },

  // GET /sites
  async getSites(req, res) {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'tenant scope required' });
    const sites = await svc.listSites(tenantId);
    res.json({ sites });
  },

  // GET /users
  async getUsers(req, res) {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'tenant scope required' });
    const users = await svc.listUsers(tenantId);
    res.json({ users });
  },

  // POST /users
  async createUser(req, res) {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'tenant scope required' });

    const { email, roleName, siteId, siteIds, department } = req.body;
    let { username } = req.body;
    if (!email || !roleName) {
      return res.status(400).json({ error: 'email and roleName are required' });
    }

    const emailValidation = validateEmailFormat(email);
    if (!emailValidation.valid) {
      return res.status(400).json({ error: emailValidation.error });
    }

    const nameValidation = validateDisplayName(username);
    if (!nameValidation.valid) {
      return res.status(400).json({ error: nameValidation.error });
    }
    username = normalizeDisplayName(username);

    try {
      const domain = email.split('@')[1];
      const mxRecords = await dns.promises.resolveMx(domain);
      if (!mxRecords || mxRecords.length === 0) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
      }
    } catch (error) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const allowedRoles = ['site_admin', 'hr_manager'];
    if (!allowedRoles.includes(roleName)) {
      return res.status(400).json({ error: `roleName must be one of: ${allowedRoles.join(', ')}` });
    }

    const inviterName = req.auth?.user?.name ?? 'Tenant Admin';

    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await svc.createTenantUser(client, {
        tenantId, email, username, roleName, siteId, siteIds, department,
        actorId: req.auth.user.id,
        inviterName,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      const mapped = mapKnownError(err, res);
      if (mapped) return mapped;
      logger.error('[tenant-admin] create user error:', err);
      return res.status(500).json({ error: 'Failed to create user' });
    } finally {
      client.release();
    }

    const { newUser, roleLabel, tenantName, siteName, rawToken, expiresAt } = result;

    // Post-commit Keycloak sync (non-fatal)
    await svc.syncNewUserToKeycloak({
      tenantId, email, username, roleName, siteId, userId: newUser.pk_user_id,
    });

    // Fire-and-forget invite email
    svc.sendInviteEmail({
      email, username, inviterName, roleLabel, tenantName, siteName, rawToken, expiresAt,
    });

    await writeAudit({
      req,
      action: 'user.create',
      details: `${roleLabel} created: ${email}`,
      tenantId,
    });

    res.status(201).json({ user: newUser, roleName, siteId, inviteSent: true });
  },

  // POST /users/sync
  async syncUsers(req, res) {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'tenant scope required' });
    if (env.authMode !== 'keycloak') {
      return res.status(400).json({ error: 'User sync requires AUTH_MODE=keycloak' });
    }
    const dryRun = req.body?.dryRun === true;

    const outcome = await svc.syncTenantUsers(tenantId, dryRun);

    await writeAudit({
      req,
      action: 'users.keycloak_sync',
      details: `Tenant ${tenantId} user→Keycloak sync ${dryRun ? '(dry-run) ' : ''}realm=${outcome.realm}: ${outcome.summary.synced} synced, ${outcome.summary.skipped} skipped, ${outcome.summary.failed} failed`,
      tenantId,
    }).catch(() => {});

    res.json(outcome);
  },

  // GET /analytics
  async getAnalytics(req, res) {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'tenant scope required' });
    const { attendanceLast30, siteActivity } = await svc.getAnalytics(tenantId, req.query.from, req.query.to);
    res.json({ attendanceLast30, siteActivity });
  },

  // GET /ui-config
  async getUiConfig(req, res) {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'tenant scope required' });
    const config = await svc.getUiConfig(tenantId);
    res.json(config);
  },

  // PATCH /ui-config
  async updateUiConfig(req, res) {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'tenant scope required' });
    const { logoUrl, primaryColor, enabledFeatures, dashboardWidgets } = req.body;
    await svc.updateUiConfig(tenantId, { logoUrl, primaryColor, enabledFeatures, dashboardWidgets });

    await writeAudit({
      req,
      action: 'tenant.ui_config_updated',
      details: 'Tenant UI configuration updated',
      entityType: 'tenant',
      entityId: tenantId,
      source: 'api',
    }).catch(() => {});

    res.json({ success: true });
  },

  // GET /groups
  async getGroups(req, res) {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'tenant scope required' });
    const groups = await svc.listGroups(tenantId);
    res.json({ groups });
  },

  // POST /groups
  async createGroup(req, res) {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'tenant scope required' });
    const { name, description, roleIds = [], isDefault = false } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

    const client = await pool.connect();
    let group;
    try {
      await client.query('BEGIN');
      group = await svc.createGroup(client, {
        tenantId, name, description, roleIds, isDefault, actorId: req.auth.user.id,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      const mapped = mapKnownError(err, res);
      if (mapped) return mapped;
      throw err;
    } finally {
      client.release();
    }

    await writeAudit({
      req,
      action: 'group.created',
      details: `Group created: ${group.name} (ID: ${group.id})`,
      entityType: 'group',
      entityId: group.id,
      source: 'api',
    }).catch(() => {});

    res.status(201).json({ group });
  },

  // PATCH /groups/:id
  async updateGroup(req, res) {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'tenant scope required' });
    const { id } = req.params;
    const { name, description, roleIds, isDefault } = req.body;

    const client = await pool.connect();
    let group;
    try {
      await client.query('BEGIN');
      group = await svc.updateGroup(client, {
        tenantId, id, name, description, roleIds, isDefault, actorId: req.auth.user.id,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      const mapped = mapKnownError(err, res);
      if (mapped) return mapped;
      throw err;
    } finally {
      client.release();
    }

    await writeAudit({
      req,
      action: 'group.updated',
      details: `Group updated: ${group.name} (ID: ${id})`,
      entityType: 'group',
      entityId: id,
      source: 'api',
    }).catch(() => {});

    res.json({ group });
  },

  // DELETE /groups/:id
  async deleteGroup(req, res) {
    const tenantId = getTenantId(req);
    const { id } = req.params;
    try {
      await svc.deactivateGroup(id, tenantId);
    } catch (err) {
      const mapped = mapKnownError(err, res);
      if (mapped) return mapped;
      throw err;
    }

    await writeAudit({
      req,
      action: 'group.deleted',
      details: `Group deactivated/deleted (ID: ${id})`,
      entityType: 'group',
      entityId: id,
      source: 'api',
    }).catch(() => {});

    res.json({ success: true });
  },

  // GET /groups/:id/members
  async getGroupMembers(req, res) {
    const tenantId = getTenantId(req);
    const { id } = req.params;
    const members = await svc.listGroupMembers(id, tenantId);
    res.json({ members });
  },

  // POST /groups/:id/members
  async addGroupMember(req, res) {
    const tenantId = getTenantId(req);
    const { id } = req.params;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    try {
      await svc.addGroupMember({ groupId: id, tenantId, userId, actorId: req.auth.user.id });
    } catch (err) {
      const mapped = mapKnownError(err, res);
      if (mapped) return mapped;
      throw err;
    }

    await writeAudit({
      req,
      action: 'group.member_added',
      details: `Member added to group: user ${userId} to group ${id}`,
      entityType: 'group',
      entityId: id,
      source: 'api',
    }).catch(() => {});

    res.status(201).json({ success: true });
  },

  // DELETE /groups/:id/members/:userId
  async removeGroupMember(req, res) {
    const { id, userId } = req.params;
    await svc.removeGroupMember(id, userId);

    await writeAudit({
      req,
      action: 'group.member_removed',
      details: `Member removed from group: user ${userId} from group ${id}`,
      entityType: 'group',
      entityId: id,
      source: 'api',
    }).catch(() => {});

    res.json({ success: true });
  },
};

export default TenantAdminController;
