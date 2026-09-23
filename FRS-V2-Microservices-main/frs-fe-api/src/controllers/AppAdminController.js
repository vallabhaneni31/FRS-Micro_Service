import * as svc from '../services/business/AppAdminService.js';

const { ConflictError, NotFoundError, RealmConflictError } = svc;

function handleKnownError(err, res) {
  if (err instanceof ConflictError) {
    return res.status(409).json({ error: err.message, ...(err.field ? { field: err.field } : {}) });
  }
  if (err instanceof NotFoundError) {
    return res.status(404).json({ error: err.message });
  }
  if (err instanceof RealmConflictError) {
    return res.status(409).json({ error: err.message, field: err.field });
  }
  if (err.statusCode) {
    return res.status(err.statusCode).json({ error: err.message, ...(err.detail ? { detail: err.detail } : {}) });
  }
  return null;
}

const AppAdminController = {
  // ── Overview / Analytics ────────────────────────────────────────────────
  async getOverview(req, res) {
    const data = await svc.getOverview();
    res.json(data);
  },

  async getAnalytics(req, res) {
    const data = await svc.getAnalytics();
    res.json(data);
  },

  // ── Tenant types ──────────────────────────────────────────────────────────
  async listTenantTypes(req, res) {
    const tenantTypes = await svc.listTenantTypes();
    res.json({ tenantTypes });
  },

  async createTenantType(req, res) {
    const { name, description, features = [], vertical } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    try {
      const tenantType = await svc.createTenantType({ name: name.trim(), description, features, vertical });
      res.status(201).json({ tenantType });
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async updateTenantType(req, res) {
    const { id } = req.params;
    const { name, description, features, vertical } = req.body;
    try {
      const tenantType = await svc.updateTenantType(id, { name, description, features, vertical });
      res.json({ tenantType });
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async deleteTenantType(req, res) {
    const { id } = req.params;
    try {
      await svc.deleteTenantType(id);
      res.json({ success: true });
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  // ── Tenants ───────────────────────────────────────────────────────────────
  async listTenants(req, res) {
    const tenants = await svc.listTenants();
    res.json({ tenants });
  },

  async createTenant(req, res) {
    const {
      name, tenantTypeId,
      realmSlug, realmName, domain,
      sessionTimeout, maxFailedLogins, passwordMinLength,
      adminName, adminEmail, vertical,
    } = req.body;
    if (!name?.trim())       return res.status(400).json({ error: 'name is required' });
    if (!realmSlug?.trim())  return res.status(400).json({ error: 'realmSlug is required' });
    if (!adminEmail?.trim()) return res.status(400).json({ error: 'adminEmail is required' });
    if (!adminName?.trim())  return res.status(400).json({ error: 'adminName is required' });
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminName.trim())) {
      return res.status(400).json({ error: 'Full Name cannot be an email address' });
    }

    try {
      const result = await svc.createTenant({
        name: name.trim(),
        tenantTypeId,
        realmSlug: realmSlug.trim(),
        realmName,
        domain,
        sessionTimeout,
        maxFailedLogins,
        passwordMinLength,
        adminName: adminName.trim(),
        adminEmail: adminEmail.trim(),
        vertical,
      }, req);
      res.status(201).json(result);
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async backfillOrganizations(req, res) {
    const { tenantId = null, dryRun = false, syncMembers = false } = req.body || {};
    try {
      const result = await svc.backfillOrganizations({ tenantId, dryRun, syncMembers }, req);
      res.json(result);
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async getTenantRealm(req, res) {
    try {
      const realm = await svc.getTenantRealm(req.params.id);
      res.json({ realm });
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async provisionTenantRealm(req, res) {
    const tenantId = req.params.id;
    const provisionUsers = req.body?.provisionUsers !== false;
    try {
      const result = await svc.provisionTenantRealm({ tenantId, provisionUsers }, req);
      res.status(result.realmStatus === 'created' ? 201 : 200).json(result);
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async updateTenant(req, res) {
    const { id } = req.params;
    const { name, tenantTypeId } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    try {
      const tenant = await svc.updateTenant({ id, name: name.trim(), tenantTypeId }, req);
      res.json({ tenant });
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async deleteTenant(req, res) {
    const { id } = req.params;
    const force = req.query.force === 'true';
    try {
      await svc.deleteTenant({ id, force }, req);
      res.json({ success: true });
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  // ── Tenant admin assignment ─────────────────────────────────────────────
  async listTenantAdmins(req, res) {
    const admins = await svc.listTenantAdmins(req.params.id);
    res.json({ admins });
  },

  async assignTenantAdmin(req, res) {
    const { id } = req.params;
    const { email, username } = req.body;
    if (!email?.trim()) return res.status(400).json({ error: 'email is required' });
    try {
      const result = await svc.assignTenantAdmin({ tenantId: id, email: email.trim(), username }, req);
      res.json({ success: true, userId: result.userId });
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async deleteTenantAdmin(req, res) {
    const { id, userId } = req.params;
    const numUserId = Number(userId);
    if (!numUserId) return res.status(400).json({ error: 'Invalid user ID' });
    try {
      await svc.deleteTenantAdmin({ tenantId: id, userId: numUserId }, req);
      res.json({ success: true, message: 'Tenant admin deleted successfully' });
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  // ── Customers ─────────────────────────────────────────────────────────────
  async listCustomers(req, res) {
    const customers = await svc.listCustomers(req.query.tenantId);
    res.json({ customers });
  },

  async createCustomer(req, res) {
    const { name, tenantId } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    if (!tenantId)      return res.status(400).json({ error: 'tenantId is required' });
    try {
      const customer = await svc.createCustomer({ name: name.trim(), tenantId }, req);
      res.status(201).json({ customer });
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async updateCustomer(req, res) {
    const { id } = req.params;
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    try {
      const customer = await svc.updateCustomer({ id, name: name.trim() }, req);
      res.json({ customer });
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async deleteCustomer(req, res) {
    const { id } = req.params;
    try {
      await svc.deleteCustomer(id, req);
      res.json({ success: true });
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  // ── Activity log ─────────────────────────────────────────────────────────
  async listAuditEntries(req, res) {
    const limit    = Math.min(Number(req.query.limit  || 50), 500);
    const offset   = Number(req.query.offset || 0);
    const search   = req.query.q || req.query.search || '';
    const category = req.query.category || '';
    const tenantId = req.query.tenant_id || null;
    const userId   = req.query.user_id || null;

    const { rows, total } = await svc.listAuditEntries({
      tenantId, userId, search, category, from: req.query.from, to: req.query.to, limit, offset,
    });
    res.json({ data: rows, total });
  },

  async getAuditSummary(req, res) {
    const tenantId = req.query.tenant_id || null;
    const rows = await svc.getAuditSummary({ tenantId, from: req.query.from, to: req.query.to });
    res.json({ data: rows });
  },
};

export default AppAdminController;
