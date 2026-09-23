/**
 * manifestRoutes.js — Server-Driven UI Manifest Route
 * 
 * ============================================================================
 * SERVER-DRIVEN UI CONTRACT & SPECIFICATION
 * ============================================================================
 * 
 * 1. Overview:
 *    This router serves the system's dynamic manifest via `/api/me/manifest`.
 *    The manifest controls the navigation structure, dashboard widgets, and 
 *    feature flags in the React frontend based on the authenticated user's role 
 *    and their tenant's settings/vertical.
 * 
 * 2. API Contract (GET /api/me/manifest):
 *    - Method: GET
 *    - Auth: Required (Authorization Bearer Header or Session Cookie)
 *    - Response Code: 200 OK
 *    - Response Content-Type: application/json
 * 
 *    Response Shape:
 *    {
 *      "role": "super_admin" | "tenant_admin" | "site_admin" | "hr_manager",
 *      "userId": "string",
 *      "tenantId": "string" | null,
 *      "tenantName": "string" | null,
 *      "siteId": "string" | null,
 *      "navigation": [
 *        {
 *          "key": "string",          // Component or route identifier (e.g. 'users', 'overview')
 *          "label": "string",        // Human-readable menu title
 *          "icon": "string",         // Lucide-react icon identifier
 *          "sortOrder": number,      // Sequence order in sidebar
 *          "vertical": "corporate" | "education" | null
 *        }
 *      ],
 *      "widgets": [
 *        {
 *          "id": "string",           // Widget element key (e.g. 'total_users')
 *          "type": "stat" | "chart" | "table",
 *          "label": "string",
 *          "icon": "string",
 *          "span": number            // Grid column span
 *        }
 *      ],
 *      "features": ["string"],       // Enabled features from tenant's subscription plan
 *      "theme": {
 *        "primaryColor": "string",   // Hex color code (e.g. '#6366f1')
 *        "logoUrl": "string" | null  // URL to custom tenant logo
 *      },
 *      "canManageRoles": ["string"], // Array of role names this user is allowed to manage
 *      "preferences": {              // Per-user DB persisted preferences
 *        "theme": "light" | "dark"
 *      }
 *    }
 * 
 * 3. Versioning & Backward Compatibility:
 *    - Features are backward-compatible. Additions to the response shape are non-breaking.
 *    - Frontends must gracefully handle missing/unmapped widget or navigation keys.
 * ============================================================================
 */
import express from 'express';
import { requireAuth } from '../middleware/authz.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { pool } from '../db/pool.js';
import { env } from '../config/env.js';
import logger from '../utils/logger.js';

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve the primary RBAC role name for a user (highest-privilege first). */
const ROLE_PRIORITY = ['super_admin', 'tenant_admin', 'site_admin', 'hr_manager'];

// Map non-canonical role labels (the frs_user.role text column / membership
// values like 'admin', 'hr') to the canonical rbac_role.role_name that nav_item
// and the manifest contract are keyed by. Mirrors ROLE_TO_RBAC in userRoutes.js.
// Without this, a tenant admin stored as frs_user.role='admin' resolves to a role
// that has zero nav_item rows → empty sidebar → "Page not yet implemented".
const ROLE_TO_RBAC = {
  admin:           'tenant_admin',
  hr:              'hr_manager',
  hr_manager:      'hr_manager',
  super_admin:     'super_admin',
  tenant_admin:    'tenant_admin',
  site_admin:      'site_admin',
  viewer:          'viewer',
  device_operator: 'device_operator',
};
const toRbacRole = (role) => (role ? (ROLE_TO_RBAC[role] ?? role) : role);

async function getPrimaryRole(userId) {
  const result = await pool.query(
    `SELECT rr.role_name
     FROM user_role ur
     JOIN rbac_role rr ON rr.pk_role_id = ur.fk_role_id
     WHERE ur.fk_user_id = $1 AND ur.is_active = true`,
    [userId]
  );
  const names = result.rows.map(r => r.role_name);
  for (const priority of ROLE_PRIORITY) {
    if (names.includes(priority)) return priority;
  }
  // Fallback to the role column in frs_user table. This (and the legacy names[0])
  // can hold non-canonical labels, so normalize to the RBAC name before returning.
  const userRes = await pool.query('SELECT role FROM frs_user WHERE pk_user_id = $1', [userId]);
  const userRole = userRes.rows[0]?.role;
  if (userRole) return toRbacRole(userRole);

  return toRbacRole(names[0]) ?? 'hr_manager';
}

/** Get nav items for a role from DB. */
async function getNavItems(roleName, vertical) {
  const result = await pool.query(
    // NULL-vertical items are corporate/education shared pages — those two
    // verticals have no dedicated nav_item rows of their own and rely on
    // this fallback entirely. Verticals with their own dedicated page-key
    // namespace (retail, transport) must never also see the NULL/corporate
    // items — each gets only rows explicitly tagged with its own vertical.
    `SELECT item_key AS key, label, icon, sort_order AS "sortOrder", vertical
     FROM nav_item
     WHERE role_name = $1 AND is_active = true
       AND (
         vertical = $2
         OR ($2 NOT IN ('retail', 'transport') AND vertical IS NULL)
       )
     ORDER BY sort_order ASC`,
    [roleName, vertical || 'corporate']
  );
  return result.rows;
}

/** Get tenant UI config (theme + widgets + features). */
async function getTenantConfig(tenantId) {
  if (!tenantId) return null;
  const result = await pool.query(
    `SELECT logo_url AS "logoUrl", primary_color AS "primaryColor",
            enabled_features AS "enabledFeatures",
            dashboard_widgets AS "dashboardWidgets"
     FROM tenant_ui_config
     WHERE fk_tenant_id = $1`,
    [tenantId]
  );
  return result.rows[0] ?? null;
}

/** Roles the calling role can create/manage. */
async function getManageableRoles(callerRole) {
  const result = await pool.query(
    `SELECT DISTINCT grantee_role AS role
     FROM role_capability_grant
     WHERE grantor_role = $1 AND is_active = true
       AND capability LIKE 'manage.%'`,
    [callerRole]
  );
  return result.rows.map(r => r.role);
}

/** Tenant + site IDs from the calling user's active scope. */
function extractScopeIds(req) {
  return {
    tenantId: req.auth?.scope?.tenantId ?? null,
    siteId:   req.auth?.scope?.siteId   ?? null,
  };
}

// ============================================================================
// GET /api/me/manifest
// ============================================================================
router.get('/manifest', requireAuth, asyncHandler(async (req, res) => {
  const userId  = req.auth.user.id;
  const { tenantId, siteId } = extractScopeIds(req);

  const [roleName, tenantRow] = await Promise.all([
    getPrimaryRole(userId),
    tenantId
      ? pool.query('SELECT tenant_name, vertical FROM frs_tenant WHERE pk_tenant_id = $1', [tenantId])
      : Promise.resolve({ rows: [] }),
  ]);

  const tenantName = tenantRow.rows[0]?.tenant_name ?? null;
  const vertical = tenantRow.rows[0]?.vertical ?? 'corporate';

  const [navItems, tenantConfig, manageableRoles] = await Promise.all([
    getNavItems(roleName, vertical),
    getTenantConfig(tenantId),
    getManageableRoles(roleName),
  ]);

  logger.info(`[DEBUG - Manifest] User ${userId} requested manifest. Primary Role: ${roleName}, Tenant: ${tenantId}`);

  // Role-default dashboard layouts consumed by the frontend SmartDashboard
  // (widget registry maps each id → component). Tenant overrides in
  // tenant_ui_config.dashboard_widgets take precedence when present; the
  // frontend also carries an identical per-role fallback for graceful
  // degradation, so missing/unknown ids never blank the dashboard.
  const ROLE_DASHBOARD_WIDGETS = {
    super_admin: [
      { id: 'platform_overview', type: 'custom', span: 4 },
    ],
    tenant_admin: [
      { id: 'kpi_attendance', type: 'stat',   span: 4 },
      { id: 'device_status',  type: 'stat',   span: 2 },
      { id: 'calendar',       type: 'custom', span: 4 },
      { id: 'weekly_chart',   type: 'chart',  span: 4 },
    ],
    site_admin: [
      { id: 'kpi_attendance', type: 'stat',   span: 4 },
      { id: 'device_status',  type: 'stat',   span: 2 },
      { id: 'calendar',       type: 'custom', span: 4 },
      { id: 'weekly_chart',   type: 'chart',  span: 4 },
    ],
    hr_manager: [
      { id: 'kpi_attendance', type: 'stat',   span: 4 },
      { id: 'calendar',       type: 'custom', span: 4 },
      { id: 'monthly_trend',  type: 'chart',  span: 4 },
      { id: 'punch_heatmap',  type: 'chart',  span: 4 },
    ],
  };

  const userRes = await pool.query('SELECT preferences FROM frs_user WHERE pk_user_id = $1', [userId]);
  const preferences = userRes.rows[0]?.preferences ?? {};

  const userEmail = req.auth?.user?.email;
  const normalizedEmail = userEmail ? userEmail.toLowerCase().trim() : '';
  const isTester = env.betaTesterEmails.includes(normalizedEmail);
  const hasAccess = isTester || roleName === 'hr_manager';
  let manifestNavigation = navItems;
  if (!hasAccess) {
    manifestNavigation = navItems.filter(item => item.key !== 'visitors');
  }

  const manifest = {
    role:           roleName,
    userId:         String(userId),
    tenantId:       tenantId ? String(tenantId) : null,
    tenantName,
    siteId:         siteId ? String(siteId) : null,
    navigation:     manifestNavigation,
    // Tenant override (if customised) wins; otherwise the role default layout.
    widgets:        (Array.isArray(tenantConfig?.dashboardWidgets) && tenantConfig.dashboardWidgets.length > 0)
                      ? tenantConfig.dashboardWidgets
                      : (ROLE_DASHBOARD_WIDGETS[roleName] ?? []),
    features:       tenantConfig?.enabledFeatures ?? [],
    theme: {
      primaryColor: tenantConfig?.primaryColor ?? '#6366f1',
      logoUrl:      tenantConfig?.logoUrl       ?? null,
    },
    canManageRoles: manageableRoles,
    preferences:    preferences,
  };

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.json(manifest);
}));

// ============================================================================
// GET /api/me/manifest/page/:pageKey — page-level data hints
// ============================================================================
router.get('/manifest/page/:pageKey', requireAuth, asyncHandler(async (req, res) => {
  const { pageKey } = req.params;
  const userId = req.auth.user.id;
  const roleName = await getPrimaryRole(userId);

  // Confirm user's nav includes this page
  const navCheck = await pool.query(
    'SELECT 1 FROM nav_item WHERE role_name = $1 AND item_key = $2 AND is_active = true',
    [roleName, pageKey]
  );
  if (navCheck.rows.length === 0) {
    return res.status(403).json({ message: 'page not accessible for your role' });
  }

  if (pageKey === 'visitors') {
    const userEmail = req.auth?.user?.email;
    const normalizedEmail = userEmail ? userEmail.toLowerCase().trim() : '';
    const isTester = env.betaTesterEmails.includes(normalizedEmail);
    const hasAccess = isTester || roleName === 'hr_manager';
    if (!hasAccess) {
      return res.status(403).json({ message: 'page not accessible for your role' });
    }
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.json({ pageKey, role: roleName, accessible: true });
}));

// ============================================================================
// PATCH /api/me/preferences — save user preferences (e.g. theme)
// ============================================================================
router.patch('/preferences', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.auth.user.id;
  const { preferences } = req.body;
  if (!preferences || typeof preferences !== 'object') {
    return res.status(400).json({ error: 'preferences object required' });
  }

  const result = await pool.query(
    `UPDATE frs_user
     SET preferences = COALESCE(preferences, '{}'::jsonb) || $1::jsonb
     WHERE pk_user_id = $2
     RETURNING preferences`,
    [JSON.stringify(preferences), userId]
  );

  res.json({ success: true, preferences: result.rows[0]?.preferences });
}));

export default router;
