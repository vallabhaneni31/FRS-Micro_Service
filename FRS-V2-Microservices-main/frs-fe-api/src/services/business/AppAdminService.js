/**
 * AppAdminService.js — business logic extracted from appAdminRoutes.js.
 * Tenant & Customer CRUD + cross-tenant overview stats + Keycloak provisioning
 * orchestration, kept behind repositories/tenantRepository.js,
 * repositories/customerRepository.js, repositories/tenantTypeRepository.js and
 * repositories/auditLogRepository.js.
 */
import bcrypt from 'bcrypt';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { pool } from '../../db/pool.js';
import { retailPool } from '../../db/retailPool.js';
import { sendUserInvite, sendAccountDeletionNotification } from '../emailService.js';
import { writeAudit } from '../../middleware/auditLog.js';
import logger from '../../utils/logger.js';
import {
  provisionDedicatedRealm, deleteDedicatedRealm,
  RealmConflictError, createKeycloakOrganization, addUserToOrganization,
  applyRealmSecurityPolicy,
} from '../keycloakProvisioner.js';
import { createOrUpdateKeycloakUser, mapRoleToKeycloakRealmRole } from '../keycloakUserService.js';
import * as tenantRepo from '../../repositories/tenantRepository.js';
import * as customerRepo from '../../repositories/customerRepository.js';
import * as tenantTypeRepo from '../../repositories/tenantTypeRepository.js';
import * as auditRepo from '../../repositories/auditLogRepository.js';
import * as userRepo from '../../repositories/userRepository.js';
import { deleteUser } from './UserService.js';

export { RealmConflictError };

export class ConflictError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ConflictError';
    this.statusCode = 409;
    this.field = field;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.statusCode = 404;
  }
}

// Slug derivation must match siteManagementRoutes.js so backfilled org slugs
// are identical to the ones written at site-creation time.
function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

function makeInviteToken() {
  const raw    = randomBytes(32).toString('hex');
  const hashed = createHash('sha256').update(raw).digest('hex');
  return { raw, hashed };
}

// ============================================================================
// OVERVIEW / ANALYTICS
// ============================================================================

export async function getOverview() {
  return tenantRepo.getOverviewStats();
}

export async function getAnalytics() {
  return tenantRepo.getAnalyticsStats();
}

// ============================================================================
// TENANT TYPES CRUD
// ============================================================================

export async function listTenantTypes() {
  return tenantTypeRepo.listActiveTenantTypes();
}

export async function createTenantType({ name, description, features = [], vertical }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dup = await tenantTypeRepo.findTenantTypeByName(client, name);
    if (dup) {
      if (dup.is_active) {
        await client.query('ROLLBACK');
        throw new ConflictError('Tenant type name already exists');
      }
      // If it exists but is inactive, reactivate and update it!
      const tt = await tenantTypeRepo.reactivateTenantType(client, dup.id, { name, description, features, vertical });
      await client.query('COMMIT');
      return tt;
    }
    const tt = await tenantTypeRepo.createTenantType(client, { name, description, features, vertical });
    await client.query('COMMIT');
    return tt;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function updateTenantType(id, { name, description, features, vertical }) {
  const tenantType = await tenantTypeRepo.updateTenantType(id, { name, description, features, vertical });
  if (!tenantType) throw new NotFoundError('Tenant type not found');
  return tenantType;
}

export async function deleteTenantType(id) {
  const inUseCount = await tenantTypeRepo.countActiveSubscriptionsForPlan(id);
  if (inUseCount > 0) {
    throw new ConflictError('Tenant type is assigned to one or more tenants.');
  }
  const deactivated = await tenantTypeRepo.deactivateTenantType(id);
  if (!deactivated) throw new NotFoundError('Tenant type not found');
}

// ============================================================================
// TENANTS CRUD
// ============================================================================

export async function listTenants() {
  const tenants = await tenantRepo.listTenants();
  logger.info(`[app-admin] GET /tenants returning ${tenants.length} tenants. First tenant type: ${tenants[0]?.tenantTypeId} / ${tenants[0]?.tenantTypeName}`);
  return tenants;
}

/**
 * Creates a tenant end-to-end: Keycloak realm/user/org provisioning (Phase A,
 * outside any DB transaction so a later DB failure can cleanly compensate by
 * hard-deleting the realm), then the full DB transaction (Phase B), then
 * fire-and-forget invite email + audit log. Preserves the exact ordering and
 * compensation semantics of the original inline route handler.
 */
export async function createTenant(fields, req) {
  const {
    name, tenantTypeId,
    realmSlug, realmName, domain,
    sessionTimeout, maxFailedLogins, passwordMinLength, lockoutDurationMinutes,
    adminName, adminEmail, vertical,
    city, country, locationAddress, latitude, longitude,
  } = fields;

  const dup = await tenantRepo.findTenantByName(name);
  if (dup) throw new ConflictError('Tenant name already exists');

  const slugTaken = await tenantRepo.isRealmSlugTaken(realmSlug);
  if (slugTaken) throw new ConflictError('Realm slug already taken');

  const emailDup = await tenantRepo.findUserByEmailForTenantCreate(adminEmail);
  if (emailDup) throw new ConflictError('Email address is already in use by another tenant', 'adminEmail');

  // ── Phase A: all Keycloak provisioning happens BEFORE the DB transaction ───
  const tenantId         = randomUUID();
  const isKeycloak       = process.env.AUTH_MODE === 'keycloak';
  const trimmedSlug      = realmSlug;
  const trimmedRealmName = realmName ?? name;
  let realmProvisioned   = false;
  let keycloakUserId     = null;

  if (isKeycloak) {
    try {
      await provisionDedicatedRealm({
        realmSlug: trimmedSlug,
        realmName: trimmedRealmName,
        sessionTimeoutMinutes: sessionTimeout ?? 480,
        maxFailedLogins: maxFailedLogins ?? 5,
        passwordMinLength: passwordMinLength ?? 8,
        lockoutDurationMinutes: lockoutDurationMinutes ?? 15,
      });
      realmProvisioned = true;

      keycloakUserId = await createOrUpdateKeycloakUser({
        email: adminEmail,
        username: adminName ?? adminEmail,
        realmRole: 'tenant_admin',
        tenantId,
        realmSlug: trimmedSlug,
      });

      try {
        await createKeycloakOrganization({ realmSlug: trimmedSlug, orgSlug: trimmedSlug, orgName: name });
        if (keycloakUserId) {
          await addUserToOrganization({ realmSlug: trimmedSlug, orgSlug: trimmedSlug, userId: keycloakUserId });
        }
      } catch (orgErr) {
        logger.warn(`[app-admin] tenant org auto-create failed for realm ${trimmedSlug}: ${orgErr.message}`);
      }
    } catch (kcErr) {
      if (realmProvisioned) {
        await deleteDedicatedRealm({ realmSlug: trimmedSlug }).catch(delErr =>
          logger.error(`[app-admin] compensation: failed to delete realm ${trimmedSlug}: ${delErr.message}`));
      }
      if (kcErr instanceof RealmConflictError) {
        throw new ConflictError(`The realm slug "${trimmedSlug}" is already in use. Please choose a different slug.`, 'realmSlug');
      }
      throw kcErr;
    }
  }

  const client = await pool.connect();
  let adminUser = null;
  try {
    await client.query('BEGIN');

    let features = [];
    let verticalVal = vertical || 'corporate';
    let legacyTenantTypeId = null;
    let planName = '';

    if (tenantTypeId) {
      const plan = await tenantTypeRepo.getPlanById(client, tenantTypeId);
      if (plan) {
        planName = plan.name || '';
        features = plan.features || [];
        verticalVal = plan.vertical || verticalVal;
      }
    }

    if (planName) {
      let lookupName = 'basic';
      if (planName.toLowerCase().includes('smb')) lookupName = 'smb';
      else if (planName.toLowerCase().includes('school')) lookupName = 'school';
      else if (planName.toLowerCase().includes('university')) lookupName = 'university';
      else if (planName.toLowerCase().includes('institute')) lookupName = 'institute basic';

      legacyTenantTypeId = await tenantTypeRepo.findLegacyTenantTypeIdByName(client, lookupName);
    }

    const tenantResult = await tenantRepo.insertTenant(client, { tenantId, name, legacyTenantTypeId, vertical: verticalVal });

    await tenantRepo.upsertTenantUiConfig(client, tenantId, features);
    await tenantRepo.retireOrphanedTenantSlug(client, realmSlug);
    await tenantRepo.upsertTenantTreeNode(client, {
      tenantId, hierarchyPath: `/00000000-0000-0000-0000-000000000001/${tenantId}/`, vertical: verticalVal, name, slug: realmSlug,
    });

    if (tenantTypeId) {
      await tenantRepo.insertTenantSubscription(client, { tenantId, tenantTypeId });
    }

    await tenantRepo.insertTenantSettings(client, tenantId, features);

    const realmResult = await tenantRepo.insertTenantRealm(client, {
      tenantId, realmSlug, realmName: realmName ?? name, domain: domain || null,
      sessionTimeout: sessionTimeout ?? 480, maxFailedLogins: maxFailedLogins ?? 5, passwordMinLength: passwordMinLength ?? 8,
      lockoutDurationMinutes: lockoutDurationMinutes ?? 15,
    });

    const defaultGroups = [
      { name: 'Tenant Admins',  description: 'Full tenant management access', role: 'tenant_admin' },
      { name: 'Site Managers',  description: 'Site-level operations access',  role: 'site_admin'   },
      { name: 'HR Team',        description: 'People and leave management',   role: 'hr_manager'   },
    ];
    for (const g of defaultGroups) {
      const grp = await tenantRepo.insertGroup(client, { tenantId, name: g.name, description: g.description });
      const role = await tenantRepo.findRoleByName(client, g.role);
      if (role) {
        await tenantRepo.insertGroupRoleMap(client, grp.pk_group_id, role.pk_role_id);
      }
    }

    const placeholderHash = await bcrypt.hash(randomBytes(32).toString('hex'), 10);
    adminUser = await tenantRepo.insertTenantAdminUser(client, {
      email: adminEmail, username: adminName ?? adminEmail, passwordHash: placeholderHash,
      keycloakSub: isKeycloak ? keycloakUserId : null,
    });

    await tenantRepo.insertTenantUserMap(client, adminUser.pk_user_id, tenantId);

    const tenantAdminRole = await tenantRepo.findRoleByName(client, 'tenant_admin');
    if (tenantAdminRole) {
      await tenantRepo.assignUserRole(client, { userId: adminUser.pk_user_id, roleId: tenantAdminRole.pk_role_id, grantedBy: req.auth.user.id });
    }

    // Auto-create customer and primary site/branch mapping
    const customerResult = await client.query(
      `INSERT INTO frs_customer (customer_name, fk_tenant_id)
       VALUES ($1, $2)
       RETURNING pk_customer_id`,
      [name, tenantId]
    );
    const customerId = customerResult.rows[0].pk_customer_id;

    if (locationAddress) {
      const siteConfig = {
        timezone: 'Asia/Kolkata',
        attendance_policy: {
          shift_type: "fixed",
          grace_period_minutes: 15,
          half_day_hours: 4,
          full_day_hours: 8,
          weekly_offs: [0, 6]
        },
        face_recognition_settings: {
          confidence_threshold: 0.85,
          anti_spoofing_enabled: true,
          min_face_size_pixels: 60,
          max_faces_per_frame: 3,
          liveness_checks: ["blink", "head_turn"]
        },
        edge_node_settings: {
          heartbeat_interval_seconds: 30,
          sync_schedule_cron: "0 */2 * * *",
          log_level: "info",
          max_local_storage_days: 7,
          network_mode: "hybrid"
        },
        camera_settings: {
          resolution: "1080p",
          fps: 15,
          bitrate_kbps: 2048,
          codec: "h264",
          motion_detection: {
            enabled: true,
            sensitivity: 70
          }
        },
        security_config: {
          encryption_enabled: true,
          secure_boot_verified: true,
          allowed_ip_ranges: ["*"],
          tamper_alerts_enabled: true
        },
        device_provisioning_rules: {
          auto_approve_replacement: false,
          require_model_verification: true,
          enforce_firmware_version: ">=v2.1.0"
        },
        matching_engine_params: {
          backend: "tensorrt",
          gpu_acceleration: true,
          max_batch_size: 8,
          precision: "fp16",
          similarity_metric: "cosine"
        },
        attendance_rules: {
          allow_remote_checkin: false,
          require_liveness_for_punch: true,
          geofencing: {
            enabled: true,
            radius_meters: 100
          },
          auto_checkout_time: "20:00"
        },
        alert_routing: {
          unauthorized_access: ["admin", "security_head"],
          hardware_failure: ["it_support", "site_admin"],
          connectivity_loss: ["it_support"],
          high_temperature: ["facilities_manager"]
        },
        edge_processing_pipeline: {
          detection_model: "yolov8_face",
          feature_extraction_model: "resnet50_arcface",
          post_processing: {
            nms_threshold: 0.4,
            min_score: 0.7
          }
        },
        data_retention_policy: {
          raw_video_hours: 24,
          detected_events_days: 90,
          attendance_logs_years: 5,
          audit_trail_years: 7
        },
        face_matching_rules: {
          max_candidates: 5,
          verification_threshold: 0.9,
          identification_threshold: 0.8,
          min_eye_distance_pixels: 40,
          max_pose_angle_degrees: 30
        },
        motion_analysis_config: {
          roi_polygons: [],
          direction_filters: [],
          speed_threshold_pixels_per_sec: 100
        },
        camera_stream_profiles: [
          {
            name: "main",
            width: 1920,
            height: 1080,
            fps: 15,
            bitrate: 2048
          },
          {
            name: "sub",
            width: 640,
            height: 480,
            fps: 10,
            bitrate: 512
          }
        ],
        unauthorized_access_policy: {
          action: "block_with_override",
          notify_employee: true,
          allow_override: true,
          flag_for_review: true,
          escalation_threshold: 3,
          escalation_recipients: ["admin@company.com"]
        }
      };

      const orgSlug = slugify(name);
      await client.query(`
        INSERT INTO frs_site (
          site_name, fk_customer_id, city, country, timezone_offset, timezone, timezone_label,
          latitude, longitude, location_address, site_config,
          status, created_by_user_id, keycloak_org_id, keycloak_org_alias
        ) VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `, [
        `${name} Headquarters`, customerId, city || null, country || null, 'Asia/Kolkata',
        'Asia/Kolkata',
        latitude ? parseFloat(latitude) : null,
        longitude ? parseFloat(longitude) : null,
        locationAddress,
        JSON.stringify(siteConfig), 'active', adminUser.pk_user_id, orgSlug, orgSlug
      ]);
    }

    const { raw: rawToken, hashed: hashedToken } = makeInviteToken();
    const inviterName = req.auth?.user?.name ?? 'Super Admin';
    const expiresAt = await tenantRepo.insertInvite(client, {
      userId: adminUser.pk_user_id,
      hashedToken,
      invitedById: req.auth?.user?.id ?? null,
      invitedByName: inviterName,
      roleLabel: 'Tenant Admin',
      tenantName: name,
      siteName: null,
      ttlHours: Number(process.env.INVITE_TOKEN_TTL_HOURS ?? 72),
    });

    await client.query('COMMIT');

    const appUrl    = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const setupLink = `${appUrl}/setup-password/${rawToken}`;
    sendUserInvite({
      toEmail: adminEmail,
      toName: adminName ?? adminEmail,
      invitedByName: inviterName,
      roleName: 'Tenant Admin',
      tenantName: name,
      setupLink,
      expiresAt,
    }).catch(err => logger.error('[app-admin] invite email failed:', err.message));

    await writeAudit({
      req,
      action: 'tenant.created',
      details: `Tenant created: ${name} (realm: ${realmSlug}, vertical: ${verticalVal})`,
      entityType: 'tenant',
      entityId: tenantId,
      tenantId: tenantId,
      source: 'api',
    }).catch(err => logger.error('[app-admin] tenant creation audit log failed:', err.message));

    return {
      tenant: tenantResult,
      realm: realmResult,
      adminUser: { email: adminUser.email, username: adminUser.username },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    if (realmProvisioned) {
      await deleteDedicatedRealm({ realmSlug: trimmedSlug }).catch(delErr =>
        logger.error(`[app-admin] compensation: failed to delete realm ${trimmedSlug}: ${delErr.message}`));
    }
    if (err.code === '23505' && (err.constraint === 'tenants_slug_unique_per_parent' || err.constraint === 'tenant_realm_realm_slug_key')) {
      throw new ConflictError(`The realm slug "${trimmedSlug}" is already in use. Please choose a different slug.`, 'realmSlug');
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Ensures EVERY tenant has a dedicated Keycloak realm + tenant-level org, and
 * one org per site. Idempotent / safe to re-run — see original route's doc
 * comment (preserved verbatim below) for the full rationale.
 *
 * Enforces the invariant: EVERY tenant has (1) a dedicated Keycloak realm and
 * (2) a tenant-level Keycloak Organization. It also ensures one org per site
 * and repairs drifted frs_site.keycloak_org_id pointers.
 */
export async function backfillOrganizations({ tenantId = null, dryRun = false, syncMembers = false }, req) {
  if (process.env.AUTH_MODE !== 'keycloak') {
    const err = new Error('Organizations require AUTH_MODE=keycloak');
    err.statusCode = 400;
    throw err;
  }

  const tenants = await tenantRepo.listTenantsForBackfill(tenantId);

  const results = [];
  let realmsCreated = 0, tenantOrgs = 0, siteOrgs = 0, membersAdded = 0, failed = 0;

  for (const tenant of tenants) {
    const entry = {
      tenantId:   tenant.pk_tenant_id,
      tenantName: tenant.tenant_name,
      realmSlug:  tenant.realm_slug || null,
      actions:    [],
    };

    try {
      const realmRowMissing = !tenant.realm_slug;
      let realmSlug = tenant.realm_slug;
      if (realmRowMissing) {
        const base = slugify(tenant.tenant_name) || `tenant-${String(tenant.pk_tenant_id).slice(0, 8)}`;
        const clash = await tenantRepo.checkRealmSlugClashForBackfill(base, tenant.pk_tenant_id);
        realmSlug = clash ? `${base}-${String(tenant.pk_tenant_id).slice(0, 8)}` : base;
      }
      entry.realmSlug = realmSlug;
      const realmName = tenant.realm_name || tenant.tenant_name;

      if (dryRun) {
        if (realmRowMissing) entry.actions.push('create_realm', 'insert_tenant_realm_row');
        entry.actions.push('ensure_tenant_org', 'ensure_site_orgs');
        results.push({ ...entry, status: 'would_change' });
        continue;
      }

      try {
        // AB#2730: this call site previously omitted maxFailedLogins,
        // sessionTimeoutMinutes and passwordMinLength entirely, so realms
        // provisioned through the backfill path never got Keycloak's
        // brute-force lockout, session-timeout or password-policy settings
        // applied. Defaults match the ?? convention used at the other
        // provisionDedicatedRealm() call sites in this file (provisionTenantRealm).
        await provisionDedicatedRealm({
          realmSlug,
          realmName,
          sessionTimeoutMinutes: tenant.session_timeout_minutes ?? 480,
          maxFailedLogins: tenant.max_failed_logins ?? 5,
          passwordMinLength: tenant.password_min_length ?? 8,
          lockoutDurationMinutes: tenant.lockout_duration_minutes ?? 15,
        });
        realmsCreated++;
        entry.actions.push('realm_created');
      } catch (realmErr) {
        if (realmErr instanceof RealmConflictError) {
          entry.actions.push('realm_exists');
        } else {
          throw realmErr;
        }
      }

      if (realmRowMissing) {
        await tenantRepo.insertTenantRealmRowForBackfill({ tenantId: tenant.pk_tenant_id, realmSlug, realmName });
        entry.actions.push('tenant_realm_row_inserted');
      }

      await createKeycloakOrganization({ realmSlug, orgSlug: realmSlug, orgName: tenant.tenant_name });
      tenantOrgs++;
      entry.actions.push('tenant_org_ensured');

      const tSites = await tenantRepo.listSitesForTenantBackfill(tenant.pk_tenant_id);
      let sitesEnsured = 0;
      for (const s of tSites) {
        const orgSlug = s.keycloak_org_id || slugify(s.site_name);
        await createKeycloakOrganization({ realmSlug, orgSlug, orgName: s.site_name });
        if (!s.keycloak_org_id) {
          await tenantRepo.updateSiteKeycloakOrg(s.pk_site_id, orgSlug);
        }
        sitesEnsured++;
        siteOrgs++;
      }
      entry.siteOrgs = sitesEnsured;

      if (syncMembers) {
        const members = await tenantRepo.listTenantMembersWithKeycloakSub(tenant.pk_tenant_id);
        let enrolled = 0;
        for (const m of members) {
          try {
            await addUserToOrganization({ realmSlug, orgSlug: realmSlug, userId: m.keycloak_sub });
            enrolled++;
          } catch (memberErr) {
            logger.warn(`[tenant-backfill] add member ${m.keycloak_sub} → ${realmSlug} failed: ${memberErr.message}`);
          }
        }
        membersAdded += enrolled;
        entry.membersAdded = enrolled;
      }

      results.push({ ...entry, status: 'ok' });
    } catch (err) {
      failed++;
      logger.error(`[tenant-backfill] tenant ${tenant.pk_tenant_id} (${tenant.tenant_name}) failed: ${err.message}`);
      results.push({ ...entry, status: 'failed', error: err.message });
    }
  }

  await writeAudit({
    req,
    action: 'tenants.backfill_keycloak',
    details: `Tenant KC backfill ${dryRun ? '(dry-run) ' : ''}scope=${tenantId || 'ALL'}: ${realmsCreated} realms, ${tenantOrgs} tenant-orgs, ${siteOrgs} site-orgs, ${membersAdded} members, ${failed} failed`,
    entityType: 'tenant',
    entityId: tenantId,
    source: 'api',
  }).catch(err => logger.error('[tenant-backfill] audit log failed:', err.message));

  return {
    dryRun,
    syncMembers,
    summary: { totalTenants: tenants.length, realmsCreated, tenantOrgs, siteOrgs, membersAdded, failed },
    results,
  };
}

export async function getTenantRealm(tenantId) {
  const realm = await tenantRepo.getRealmByTenantId(tenantId);
  if (!realm) throw new NotFoundError('Realm not found');
  return realm;
}

/**
 * Ensures a single existing tenant has its dedicated Keycloak realm, its
 * tenant-level organization, and (by default) its mapped users provisioned
 * into that realm. Idempotent: an existing realm is left in place.
 */
export async function provisionTenantRealm({ tenantId, provisionUsers = true }, req) {
  if (process.env.AUTH_MODE !== 'keycloak') {
    const err = new Error('Dedicated realms require AUTH_MODE=keycloak');
    err.statusCode = 400;
    throw err;
  }

  const tenant = await tenantRepo.getTenantWithRealm(tenantId);
  if (!tenant) throw new NotFoundError('Tenant not found');

  const realmRowMissing = !tenant.realm_slug;
  let realmSlug = tenant.realm_slug;
  if (realmRowMissing) {
    const base = slugify(tenant.tenant_name) || `tenant-${String(tenantId).slice(0, 8)}`;
    const clash = await tenantRepo.checkRealmSlugClash(base, tenantId);
    realmSlug = clash ? `${base}-${String(tenantId).slice(0, 8)}` : base;
  }
  const realmName = tenant.realm_name || tenant.tenant_name;

  const actions = [];
  let realmStatus;

  try {
    await provisionDedicatedRealm({
      realmSlug,
      realmName,
      sessionTimeoutMinutes: tenant.session_timeout_minutes ?? 480,
      maxFailedLogins: tenant.max_failed_logins ?? 5,
      passwordMinLength: tenant.password_min_length ?? 8,
    });
    realmStatus = 'created';
    actions.push('realm_created');
  } catch (realmErr) {
    if (realmErr instanceof RealmConflictError) {
      realmStatus = 'exists';
      actions.push('realm_exists');
    } else {
      throw realmErr;
    }
  }

  if (realmRowMissing) {
    await tenantRepo.insertTenantRealmRowIfMissing({ tenantId, realmSlug, realmName });
    actions.push('tenant_realm_row_inserted');
  }

  try {
    await createKeycloakOrganization({ realmSlug, orgSlug: realmSlug, orgName: tenant.tenant_name });
    actions.push('tenant_org_ensured');
  } catch (orgErr) {
    logger.warn(`[realm-provision] org ensure failed for ${realmSlug}: ${orgErr.message}`);
  }

  const users = [];
  if (provisionUsers) {
    const dbUsers = await tenantRepo.listTenantMappedUsers(tenantId);
    for (const u of dbUsers) {
      try {
        const realmRole = mapRoleToKeycloakRealmRole(u.role);
        const kcUserId = await createOrUpdateKeycloakUser({
          email: u.email,
          username: u.username || u.email,
          realmRole,
          tenantId,
          realmSlug,
        });
        await tenantRepo.updateUserKeycloakSub(u.pk_user_id, kcUserId);
        await addUserToOrganization({ realmSlug, orgSlug: realmSlug, userId: kcUserId }).catch(() => {});
        users.push({ email: u.email, status: 'ok', realmRole });
      } catch (uErr) {
        logger.warn(`[realm-provision] user ${u.email} failed: ${uErr.message}`);
        users.push({ email: u.email, status: 'failed', error: uErr.message });
      }
    }
  }

  await writeAudit({
    req,
    action: 'tenant.realm_provisioned',
    details: `Realm ${realmSlug} ${realmStatus} for tenant ${tenant.tenant_name} (${tenantId}); ${users.filter(u => u.status === 'ok').length}/${users.length} users provisioned`,
    entityType: 'tenant',
    entityId: tenantId,
    source: 'api',
  }).catch(err => logger.error('[realm-provision] audit log failed:', err.message));

  return {
    tenantId,
    tenantName: tenant.tenant_name,
    realmSlug,
    realmStatus,
    actions,
    users,
  };
}

export async function updateTenant({ id, name, tenantTypeId }, req) {
  logger.info(`[app-admin] PATCH /tenants id=${id}, name=${name}, tenantTypeId=${tenantTypeId}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let legacyTenantTypeId = null;
    let features = [];

    if (tenantTypeId) {
      const plan = await tenantTypeRepo.getPlanById(client, tenantTypeId);
      if (plan) {
        const planName = plan.name || '';
        features = plan.features || [];
        legacyTenantTypeId = await tenantTypeRepo.findLegacyTenantTypeIdByName(
          client, planName.toLowerCase().includes('smb') ? 'smb' : 'basic'
        );
      }
    }

    const tenant = await tenantRepo.updateTenantCore(client, { id, name, legacyTenantTypeId });
    if (!tenant) {
      await client.query('ROLLBACK');
      throw new NotFoundError('Tenant not found');
    }

    await tenantRepo.updateTenantTreeName(client, id, name);

    if (tenantTypeId) {
      const subExists = await tenantRepo.tenantSubscriptionExists(client, id);
      if (subExists) {
        await tenantRepo.updateTenantSubscriptionPlan(client, id, tenantTypeId);
      } else {
        await tenantRepo.insertTenantSubscriptionOnUpdate(client, id, tenantTypeId);
      }
      await tenantRepo.upsertTenantUiConfigOnUpdate(client, id, features);
      await tenantRepo.upsertTenantSettingsOnUpdate(client, id, features);
    }

    await client.query('COMMIT');
    logger.info(`[app-admin] PATCH /tenants save complete: ${JSON.stringify(tenant)}`);

    await writeAudit({
      req,
      action: 'tenant.updated',
      details: `Tenant updated: ${name} (ID: ${id})`,
      entityType: 'tenant',
      entityId: id,
      tenantId: id,
      source: 'api',
    }).catch(err => logger.error('[app-admin] tenant update audit log failed:', err.message));

    // AB#2730: this endpoint doesn't (yet) accept security-policy fields, but
    // re-push the tenant's current session timeout, max_failed_logins and
    // password policy to Keycloak whenever its dedicated realm already
    // exists, so any drift between the DB values and the realm's security
    // settings self-heals on every tenant save. Keycloak is best-effort here
    // — a failure must never fail the tenant update.
    try {
      const realm = await tenantRepo.getRealmByTenantId(id);
      if (realm?.slug) {
        await applyRealmSecurityPolicy({
          realmSlug: realm.slug,
          sessionTimeoutMinutes: realm.sessionTimeout ?? 480,
          maxFailedLogins: realm.maxFailedLogins ?? 5,
          passwordMinLength: realm.passwordMinLength ?? 8,
          lockoutDurationMinutes: realm.lockoutDurationMinutes ?? 15,
        });
      }
    } catch (syncErr) {
      logger.error(`[app-admin] tenant ${id} realm security policy sync failed: ${syncErr.message}`);
    }

    return tenant;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteTenant({ id, force }, req) {
  const customerCount = await tenantRepo.countCustomersForTenant(id);
  if (customerCount > 0 && !force) {
    throw new ConflictError('Cannot delete tenant with existing customers. Remove all customers first or force delete.');
  }

  const realmSlug = await tenantRepo.getRealmSlugForTenant(id);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deleted = await tenantRepo.deleteTenantCascade(client, id);

    if (!deleted) {
      await client.query('ROLLBACK');
      throw new NotFoundError('Tenant not found');
    }

    await client.query('COMMIT');

    // Hard-delete the dedicated realm from Keycloak AFTER the DB commit so the
    // realm slug is freed for reuse. A realm-delete failure only leaves an
    // orphaned realm to clean up — it must never fail the request or roll
    // back a successful tenant deletion.
    if (process.env.AUTH_MODE === 'keycloak' && realmSlug) {
      try {
        await deleteDedicatedRealm({ realmSlug });
        logger.info(`[tenant-delete] Keycloak realm ${realmSlug} deleted for tenant ${id}`);
      } catch (kcErr) {
        logger.error(`[tenant-delete] tenant ${id} deleted from DB, but Keycloak realm ${realmSlug} delete failed (orphan left): ${kcErr.message}`);
      }
    }

    await writeAudit({
      req,
      action: 'tenant.delete',
      details: `Successfully deleted tenant ${id} (force: ${force})`,
      entityType: 'tenant',
      entityId: id,
      tenantId: id,
      source: 'api',
    }).catch(() => {});
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof NotFoundError) throw err;
    logger.error('[tenant-delete] Error deleting tenant:', { message: err.message, code: err.code, detail: err.detail, table: err.table, constraint: err.constraint });
    const wrapped = new Error('Internal server error while deleting the tenant. See server logs for details.');
    wrapped.statusCode = 500;
    wrapped.detail = err.message;
    throw wrapped;
  } finally {
    client.release();
  }
}

// ============================================================================
// TENANT ADMIN ASSIGNMENT
// ============================================================================

export async function listTenantAdmins(tenantId) {
  return tenantRepo.listTenantAdmins(tenantId);
}

export async function assignTenantAdmin({ tenantId, email, username }, req) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await tenantRepo.findUserByEmailForAdminAssign(client, email);
    let userId;

    if (!existing) {
      const placeholderHash = await bcrypt.hash(randomBytes(32).toString('hex'), 10);
      userId = await tenantRepo.insertPlaceholderTenantAdmin(client, { email, username: username ?? email, passwordHash: placeholderHash });
    } else {
      userId = existing.pk_user_id;
      await tenantRepo.updateUserRoleToTenantAdmin(client, userId);
    }

    await tenantRepo.reassignTenantAdminRole(client, userId, req.auth.user.id);
    await tenantRepo.mapUserToTenant(client, userId, tenantId);

    // Ensure frs_user_membership has role = 'admin' (which maps to OWNER/Tenant Admin for authorization)
    const ADMIN_PERMS = [
      'users.read', 'users.manage', 'devices.read', 'devices.manage',
      'attendance.read', 'attendance.manage', 'analytics.read',
      'audit.read', 'facility.read', 'facility.manage', 'aiinsights.read',
    ];
    const existingMembership = await client.query(
      'SELECT pk_membership_id FROM frs_user_membership WHERE fk_user_id = $1 AND tenant_id = $2 LIMIT 1',
      [userId, tenantId]
    );
    if (existingMembership.rows.length) {
      await client.query(
        "UPDATE frs_user_membership SET role = 'admin', permissions = $3::text[] WHERE fk_user_id = $1 AND tenant_id = $2",
        [userId, tenantId, ADMIN_PERMS]
      );
    } else {
      await client.query(
        `INSERT INTO frs_user_membership (fk_user_id, role, tenant_id, permissions)
         VALUES ($1, 'admin', $2, $3::text[])`,
        [userId, tenantId, ADMIN_PERMS]
      );
    }

    if (retailPool) {
      try {
        const checkRes = await retailPool.query('SELECT id FROM retail_users WHERE email = $1 AND tenant_id = $2', [email, tenantId]);
        if (checkRes.rows.length) {
          await retailPool.query('UPDATE retail_users SET role = \'OWNER\', status = \'active\' WHERE email = $1 AND tenant_id = $2', [email, tenantId]);
        } else {
          await retailPool.query('INSERT INTO retail_users (tenant_id, email, display_name, role, status) VALUES ($1, $2, $3, \'OWNER\', \'active\')', [tenantId, email, username ?? email]);
        }
      } catch (rErr) {
        logger.warn('[assignTenantAdmin] retail_users upsert warning:', rErr.message);
      }
    }

    if (process.env.AUTH_MODE === 'keycloak') {
      const realmSlug = await tenantRepo.getRealmSlugForTenantTx(client, tenantId);
      if (realmSlug) {
        const keycloakUserId = await createOrUpdateKeycloakUser({
          email, username: username ?? email, realmRole: 'tenant_admin', tenantId, realmSlug,
        });
        await tenantRepo.updateUserKeycloakSubTx(client, userId, keycloakUserId);
      }
    }

    await client.query('COMMIT');

    // Notify the newly assigned admin. Previously this function created (or
    // updated) the account and, in keycloak mode, a Keycloak login with no
    // password — but never told the person, so there was no way for them to
    // discover the access or set a working credential. Reuses the same
    // invite-token + email mechanism UserService.js's sendNewUserInviteEmail
    // uses for regular new-user invites.
    try {
      const tenantRow = await pool.query('SELECT tenant_name FROM frs_tenant WHERE pk_tenant_id = $1', [tenantId]);
      const tenantName = tenantRow.rows[0]?.tenant_name ?? null;
      const inviterName = req.auth?.user?.name || req.auth?.user?.email || 'FRS Admin';

      const rawToken = randomBytes(32).toString('hex');
      const hashedToken = createHash('sha256').update(rawToken).digest('hex');
      const ttlHours = Number(process.env.INVITE_TOKEN_TTL_HOURS ?? 72);
      const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);

      await pool.query(
        `INSERT INTO user_invite
           (fk_user_id, invite_token, invited_by_id, invited_by_name, role_label, tenant_name, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [userId, hashedToken, req.auth?.user?.id ?? null, inviterName, 'Tenant Admin', tenantName, expiresAt]
      );

      const appUrl = process.env.APP_URL || 'https://frs.motivitylabs.com';
      const setupLink = `${appUrl}/setup-password/${rawToken}`;
      await sendUserInvite({
        toEmail: email,
        toName: username || email,
        invitedByName: inviterName,
        roleName: 'Tenant Admin',
        tenantName,
        setupLink,
        expiresAt,
      });
    } catch (emailErr) {
      logger.warn('[app-admin] Failed to send tenant admin invite email:', emailErr.message);
    }

    await writeAudit({
      req,
      action: 'tenant.admin_assigned',
      details: `Assigned user ${email} as tenant admin to tenant ${tenantId}`,
      entityType: 'tenant',
      entityId: tenantId,
      tenantId: tenantId,
      source: 'api',
    }).catch(() => {});

    return { userId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteTenantAdmin({ tenantId, userId }, req) {
  const existingUser = await userRepo.findUserById(userId);
  if (!existingUser) {
    throw new NotFoundError('Tenant admin not found');
  }

  // Check how many tenants this user is mapped to
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM frs_tenant_user_map WHERE fk_user_id = $1',
    [userId]
  );
  const tenantCount = rows[0]?.count ?? 0;

  if (tenantCount > 1 && tenantId) {
    // User belongs to multiple tenants — unmap from this tenant only so other tenant accounts remain active
    await pool.query('DELETE FROM frs_tenant_user_map WHERE fk_user_id = $1 AND fk_tenant_id = $2', [userId, tenantId]);
    await pool.query('DELETE FROM frs_user_membership WHERE fk_user_id = $1 AND tenant_id = $2', [userId, tenantId]);
    logger.info(`[AppAdminService] Unmapped tenant admin ${existingUser.email} (ID ${userId}) from tenant ${tenantId} (${tenantCount - 1} other tenant mapping(s) remain)`);

    if (existingUser.email) {
      try {
        await sendAccountDeletionNotification({
          toEmail: existingUser.email,
          toName: existingUser.username || existingUser.email,
          roleName: 'Tenant Admin',
          tenantName: existingUser.tenant_name,
        });
      } catch (emailErr) {
        logger.warn(`[AppAdminService] Failed to send deletion notification email to ${existingUser.email}:`, emailErr.message);
      }
    }
  } else {
    // Single tenant mapping — delete user account globally
    await deleteUser(userId);
  }

  await writeAudit({
    req,
    action: 'tenant.admin_deleted',
    details: `Deleted tenant admin user ${existingUser.email} (ID ${userId}) from tenant ${tenantId}`,
    entityType: 'tenant',
    entityId: tenantId,
    tenantId: tenantId,
    source: 'api',
  }).catch(() => {});
  return { success: true };
}

// ============================================================================
// CUSTOMERS CRUD
// ============================================================================

export async function listCustomers(tenantId) {
  return customerRepo.listCustomers(tenantId);
}

export async function createCustomer({ name, tenantId }, req) {
  const exists = await customerRepo.tenantExists(tenantId);
  if (!exists) throw new NotFoundError('Tenant not found');

  const customer = await customerRepo.createCustomer({ name, tenantId });

  await writeAudit({
    req,
    action: 'customer.created',
    details: `Customer created: ${name} (tenantId: ${tenantId})`,
    entityType: 'customer',
    entityId: customer.id,
    tenantId: tenantId,
    source: 'api',
  }).catch(err => logger.error('[app-admin] customer creation audit log failed:', err.message));

  return customer;
}

export async function updateCustomer({ id, name }, req) {
  const customer = await customerRepo.updateCustomer(id, name);
  if (!customer) throw new NotFoundError('Customer not found');

  await writeAudit({
    req,
    action: 'customer.updated',
    details: `Customer updated: ${name} (ID: ${id})`,
    entityType: 'customer',
    entityId: id,
    source: 'api',
  }).catch(err => logger.error('[app-admin] customer update audit log failed:', err.message));

  return customer;
}

export async function deleteCustomer(id, req) {
  const siteCount = await customerRepo.countSitesForCustomer(id);
  if (siteCount > 0) {
    throw new ConflictError('Cannot delete customer with existing sites. Remove all sites first.');
  }

  const deleted = await customerRepo.deleteCustomer(id);
  if (!deleted) throw new NotFoundError('Customer not found');

  await writeAudit({
    req,
    action: 'customer.deleted',
    details: `Customer deleted (ID: ${id})`,
    entityType: 'customer',
    entityId: id,
    source: 'api',
  }).catch(err => logger.error('[app-admin] customer delete audit log failed:', err.message));
}

// ============================================================================
// ACTIVITY LOG (cross-tenant audit)
// ============================================================================

export async function listAuditEntries(params) {
  return auditRepo.listAuditEntries(params);
}

export async function getAuditSummary(params) {
  return auditRepo.getAuditCategorySummary(params);
}
