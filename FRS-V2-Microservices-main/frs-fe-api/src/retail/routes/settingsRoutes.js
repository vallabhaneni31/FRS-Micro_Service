import express from 'express';
import { randomBytes } from 'crypto';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticateUser, requireOwner, canAccessStore } from '../middleware/authenticateUser.js';

const router = express.Router();
router.use(authenticateUser);

// GET /settings/profile
//
// req.user.id is NOT always a retail_users.id (uuid) — authenticateUser.js
// resolves identity three ways: (1) a real retail_users row (id = uuid),
// (2) a fallback to the main FRS DB's frs_user for retail-vertical tenant
// members (id = frs_user.pk_user_id, a bigint), or (3) a tenant-realm JWT
// with no DB row at all (id = the Keycloak `sub`, also not a retail_users
// uuid). Querying `retail_users WHERE id = $1` for a (2)/(3) user throws
// "invalid input syntax for type uuid" — a 500, not a 404 — because a
// bigint/sub value is never valid uuid input. Look up by email instead
// (unique across retail_users regardless of how the id was resolved), and
// fall back to the already-verified req.user fields when there's no
// standalone retail_users row for this account at all.
//
// MUST also filter by tenant_id: the same email can have separate
// retail_users rows under different tenants (e.g. a test account used as a
// manager on one demo tenant and re-provisioned on another) — matching by
// email alone leaked another tenant's role/store into this session.
router.get('/profile', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, email, display_name, role, store_id, created_at FROM retail_users WHERE email = $1 AND tenant_id = $2`,
    [req.user.email, req.user.tenant_id]
  );
  if (rows.length) return res.json({ user: rows[0] });

  return res.json({
    user: {
      id: null,
      email: req.user.email,
      display_name: req.user.display_name,
      role: req.user.role,
      store_id: req.user.store_id,
      created_at: null,
    },
  });
}));

// PATCH /settings/profile — update email / display_name
router.patch('/profile', asyncHandler(async (req, res) => {
  const { email, display_name } = req.body;
  if (!email && !display_name) {
    return res.status(400).json({ error: 'provide email or display_name to update' });
  }

  const { rows } = await pool.query(
    `UPDATE retail_users
     SET email        = COALESCE($1, email),
         display_name = COALESCE($2, display_name),
         updated_at   = NOW()
     WHERE email = $3 AND tenant_id = $4
     RETURNING id, email, display_name, role, store_id`,
    [email ?? null, display_name ?? null, req.user.email, req.user.tenant_id]
  );
  if (!rows.length) {
    // No standalone retail_users row exists for this account (it's managed
    // via the main FRS admin instead) — nothing to update here. apiClient.ts
    // on the frontend prefers `body.error` over `body.message` when surfacing
    // failures as a toast, so the human-readable text belongs in `error`.
    return res.status(400).json({
      error: 'This account is managed through the main FRS admin and cannot be edited from the retail settings page.',
    });
  }
  return res.json({ user: rows[0] });
}));

// GET /settings/users — list active/inactive retail_users for this tenant (OWNER only)
router.get('/users', requireOwner, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ru.id, ru.email, ru.display_name, ru.role, ru.status, ru.store_id,
            s.name AS store_name, ru.created_at
     FROM retail_users ru
     JOIN stores s ON s.id = ru.store_id
     WHERE ru.tenant_id = $1
     ORDER BY ru.created_at DESC`,
    [req.user.tenant_id]
  );
  return res.json({ users: rows });
}));

const IS_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PATCH /settings/users/:id — reassign store/role or activate/deactivate (OWNER only)
router.patch('/users/:id', requireOwner, asyncHandler(async (req, res) => {
  const { role, store_id, status } = req.body;
  if (role === undefined && store_id === undefined && status === undefined) {
    return res.status(400).json({ error: 'provide role, store_id, or status to update' });
  }
  if (role !== undefined && !['OWNER', 'MANAGER'].includes(role)) {
    return res.status(400).json({ error: 'role must be OWNER or MANAGER' });
  }
  if (status !== undefined && !['active', 'inactive'].includes(status)) {
    return res.status(400).json({ error: 'status must be active or inactive' });
  }

  let targetUserId = req.params.id;
  if (!IS_UUID_REGEX.test(targetUserId)) {
    const { rows: userCheck } = await pool.query(
      `SELECT id FROM retail_users WHERE (email = $1 OR id::text = $1) AND tenant_id = $2 LIMIT 1`,
      [targetUserId, req.user.tenant_id]
    );
    if (!userCheck.length) return res.status(404).json({ error: 'user_not_found' });
    targetUserId = userCheck[0].id;
  }

  if (store_id !== undefined) {
    const { rows: storeRows } = await pool.query(
      `SELECT id FROM stores WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [store_id, req.user.tenant_id]
    );
    if (!storeRows.length) return res.status(404).json({ error: 'store_not_found' });
  }

  const { rows } = await pool.query(
    `UPDATE retail_users
     SET role      = COALESCE($1, role),
         store_id  = COALESCE($2, store_id),
         status    = COALESCE($3, status),
         updated_at = NOW()
     WHERE id = $4 AND tenant_id = $5
     RETURNING id, email, display_name, role, store_id, status`,
    [role ?? null, store_id ?? null, status ?? null, targetUserId, req.user.tenant_id]
  );
  if (!rows.length) return res.status(404).json({ error: 'user_not_found' });
  return res.json({ user: rows[0] });
}));

// GET /settings/invitations — list invitations for this tenant (OWNER only)
router.get('/invitations', requireOwner, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ri.id, ri.invitee_email, ri.role, ri.store_id, ri.status,
            ri.expires_at, ri.sent_at, s.name AS store_name
     FROM retail_invitations ri
     JOIN stores s ON s.id = ri.store_id
     WHERE s.tenant_id = $1
     ORDER BY ri.sent_at DESC`,
    [req.user.tenant_id]
  );
  return res.json({ invitations: rows });
}));

// POST /settings/invitations — invite a manager (OWNER only)
router.post('/invitations', requireOwner, asyncHandler(async (req, res) => {
  const { invitee_email, role = 'MANAGER', store_id } = req.body;
  if (!invitee_email || !store_id) {
    return res.status(400).json({ error: 'invitee_email and store_id are required' });
  }
  if (role !== 'MANAGER') {
    return res.status(400).json({ error: 'only MANAGER role can be invited' });
  }

  const { rows: storeRows } = await pool.query(
    `SELECT id, name FROM stores WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [store_id, req.user.tenant_id]
  );
  if (!storeRows.length) return res.status(404).json({ error: 'store_not_found' });

  const token     = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const inviterId = IS_UUID_REGEX.test(req.user.id) ? req.user.id : null;

  // Revoke any existing pending invitation for same email+store, then insert fresh
  await pool.query(
    `UPDATE retail_invitations SET status = 'revoked', updated_at = NOW()
     WHERE invitee_email = $1 AND store_id = $2 AND status = 'pending'`,
    [invitee_email, store_id]
  );

  const { rows } = await pool.query(
    `INSERT INTO retail_invitations
       (inviter_id, invitee_email, role, store_id, tenant_id, token, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, invitee_email, role, store_id, status, expires_at`,
    [inviterId, invitee_email, role, store_id, req.user.tenant_id, token, expiresAt]
  );

  const setupLink = `${process.env.RETAIL_APP_URL}/retail-invite/${token}`;
  let emailSent = false;
  try {
    const internalSecret = process.env.INTERNAL_SERVICE_SECRET;
    const internalApiUrl = process.env.INTERNAL_API_URL;
    if (internalSecret && internalApiUrl) {
      const emailRes = await fetch(`${internalApiUrl}/api/internal/email/send-user-invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': internalSecret },
        body: JSON.stringify({
          toEmail: invitee_email,
          toName: invitee_email,
          invitedByName: req.user.display_name || req.user.email,
          roleName: 'Manager',
          storeName: storeRows[0]?.name,
          setupLink,
          expiresAt,
        }),
      });
      emailSent = emailRes.ok;
    }
  } catch (err) {
    console.error('[retail-api] Failed to send invite email:', err.message);
  }

  return res.status(201).json({ invitation: rows[0], invite_token: token, setup_link: setupLink, email_sent: emailSent });
}));

// DELETE /settings/invitations/:id — revoke (OWNER only)
router.delete('/invitations/:id', requireOwner, asyncHandler(async (req, res) => {
  if (!IS_UUID_REGEX.test(req.params.id)) {
    return res.status(404).json({ error: 'invitation_not_found' });
  }
  const { rows } = await pool.query(
    `UPDATE retail_invitations ri
     SET status = 'revoked', updated_at = NOW()
     FROM stores s
     WHERE ri.id = $1 AND ri.store_id = s.id AND s.tenant_id = $2
     RETURNING ri.id`,
    [req.params.id, req.user.tenant_id]
  );
  if (!rows.length) return res.status(404).json({ error: 'invitation_not_found' });
  return res.json({ success: true });
}));

// GET /settings/store-hours/:storeId
router.get('/store-hours/:storeId', asyncHandler(async (req, res) => {
  if (!canAccessStore(req, req.params.storeId)) return res.status(404).json({ error: 'store_not_found' });
  const { rows } = await pool.query(
    `SELECT id, store_hours FROM stores WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [req.params.storeId, req.user.tenant_id]
  );
  if (!rows.length) return res.status(404).json({ error: 'store_not_found' });
  return res.json({ store_id: rows[0].id, hours: rows[0].store_hours ?? {} });
}));

// PATCH /settings/store-hours/:storeId (OWNER only)
router.patch('/store-hours/:storeId', requireOwner, asyncHandler(async (req, res) => {
  const { hours } = req.body;
  if (!hours || typeof hours !== 'object') {
    return res.status(400).json({ error: 'hours object is required' });
  }

  const { rows } = await pool.query(
    `UPDATE stores SET store_hours = $1, updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3
     RETURNING id, store_hours`,
    [JSON.stringify(hours), req.params.storeId, req.user.tenant_id]
  );
  if (!rows.length) return res.status(404).json({ error: 'store_not_found' });
  return res.json({ store_id: rows[0].id, hours: rows[0].store_hours });
}));

// GET /settings/uniform-detection/:storeId
router.get('/uniform-detection/:storeId', asyncHandler(async (req, res) => {
  if (!canAccessStore(req, req.params.storeId)) return res.status(404).json({ error: 'store_not_found' });
  const { rows } = await pool.query(
    `SELECT id, uniform_detection_enabled, uniform_config_json
     FROM stores WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [req.params.storeId, req.user.tenant_id]
  );
  if (!rows.length) return res.status(404).json({ error: 'store_not_found' });
  return res.json({
    store_id: rows[0].id,
    enabled: rows[0].uniform_detection_enabled,
    config: rows[0].uniform_config_json ?? {},
  });
}));

// PATCH /settings/uniform-detection/:storeId (OWNER only)
router.patch('/uniform-detection/:storeId', requireOwner, asyncHandler(async (req, res) => {
  const { enabled, config } = req.body;
  if (enabled === undefined) {
    return res.status(400).json({ error: 'enabled (boolean) is required' });
  }

  const { rows } = await pool.query(
    `UPDATE stores
     SET uniform_detection_enabled = $1,
         uniform_config_json = COALESCE($2::jsonb, uniform_config_json),
         updated_at = NOW()
     WHERE id = $3 AND tenant_id = $4
     RETURNING id, uniform_detection_enabled, uniform_config_json`,
    [enabled, config ? JSON.stringify(config) : null,
     req.params.storeId, req.user.tenant_id]
  );
  if (!rows.length) return res.status(404).json({ error: 'store_not_found' });
  return res.json({
    store_id: rows[0].id,
    enabled: rows[0].uniform_detection_enabled,
    config: rows[0].uniform_config_json ?? {},
  });
}));

export { router as settingsRoutes };
