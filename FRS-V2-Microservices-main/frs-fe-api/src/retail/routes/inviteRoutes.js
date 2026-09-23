import express from 'express';
import { createHash } from 'crypto';
import { pool, frsPool } from '../db/pool.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = express.Router();

// Public routes — the invite token itself is the credential (no session/JWT
// required to view or accept an invite), matching the corporate flow's
// /api/auth/invite/:token pattern in backend/api.

async function loadInvite(token) {
  const { rows } = await pool.query(
    `SELECT ri.id, ri.invitee_email, ri.role, ri.store_id, ri.tenant_id,
            ri.status, ri.expires_at, s.name AS store_name
     FROM retail_invitations ri
     JOIN stores s ON s.id = ri.store_id
     WHERE ri.token = $1`,
    [token]
  );
  return rows[0] || null;
}

// GET /invite/:token — validate + describe an invitation for the accept page
router.get('/:token', asyncHandler(async (req, res) => {
  const invite = await loadInvite(req.params.token);
  if (!invite) return res.status(404).json({ valid: false, reason: 'invalid' });
  if (invite.status !== 'pending') return res.status(410).json({ valid: false, reason: 'already_used' });
  if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ valid: false, reason: 'expired' });

  return res.json({
    valid: true,
    email: invite.invitee_email,
    role: invite.role,
    storeName: invite.store_name,
  });
}));

// POST /invite/:token/accept — body: { password, display_name }
router.post('/:token/accept', asyncHandler(async (req, res) => {
  const { password, display_name } = req.body || {};
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }

  const invite = await loadInvite(req.params.token);
  if (!invite) return res.status(404).json({ error: 'invalid_invite' });
  if (invite.status !== 'pending') return res.status(410).json({ error: 'invite_already_used' });
  if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'invite_expired' });

  const { rows: realmRows } = await frsPool.query(
    `SELECT realm_slug FROM tenant_realm WHERE fk_tenant_id = $1 LIMIT 1`,
    [invite.tenant_id]
  );
  const realmSlug = realmRows[0]?.realm_slug;
  if (!realmSlug) {
    return res.status(500).json({ error: 'tenant_realm_not_configured' });
  }

  const internalSecret = process.env.INTERNAL_SERVICE_SECRET;
  const internalApiUrl = process.env.INTERNAL_API_URL;
  if (!internalSecret || !internalApiUrl) {
    return res.status(503).json({ error: 'provisioning_service_unconfigured' });
  }

  const provisionRes = await fetch(`${internalApiUrl}/api/internal/keycloak/provision-user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': internalSecret },
    body: JSON.stringify({
      email: invite.invitee_email,
      username: display_name || invite.invitee_email,
      password,
      realmRole: 'hr_manager', // FRS_ROLE_MAP maps hr_manager -> retail MANAGER
      tenantId: invite.tenant_id,
      realmSlug,
    }),
  });

  if (!provisionRes.ok) {
    const detail = await provisionRes.text().catch(() => '');
    return res.status(502).json({ error: 'keycloak_provisioning_failed', detail });
  }

  // retail_users has no unique constraint enforced in code beyond email lookup
  // elsewhere (settingsRoutes.js's /profile) — mirror that email-keyed upsert.
  const { rows: userRows } = await pool.query(
    `INSERT INTO retail_users (store_id, tenant_id, email, display_name, role, status)
     VALUES ($1,$2,$3,$4,$5,'active')
     ON CONFLICT (email) DO UPDATE
       SET store_id = EXCLUDED.store_id, tenant_id = EXCLUDED.tenant_id,
           display_name = EXCLUDED.display_name, role = EXCLUDED.role,
           status = 'active', updated_at = NOW()
     RETURNING id, email, display_name, role, store_id`,
    [invite.store_id, invite.tenant_id, invite.invitee_email,
     display_name || invite.invitee_email, invite.role]
  );

  await pool.query(
    `UPDATE retail_invitations SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [invite.id]
  );

  return res.json({ success: true, user: userRows[0] });
}));

export { router as inviteRoutes };
