import express from "express";
import jwt from "jsonwebtoken";
import { requireAuth, requirePermission } from "../middleware/authz.js";
import { requireTestAccess } from "../middleware/testAccessGuard.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import personService from "../services/business/PersonService.js";
import { writeAudit } from "../middleware/auditLog.js";
import { pool } from "../db/pool.js";
import { sendEnrollmentInvitation } from "../services/emailService.js";
import { validateBody } from "../validators/schemas.js";
import { createVisitorSchema } from "../validators/peopleSchemas.js";

function toIntOrNull(val) {
  if (val === null || val === undefined) return null;
  const n = Number(val);
  return Number.isInteger(n) ? n : null;
}

const router = express.Router();

// Mount authentication, private beta whitelist, and base authorization checks on all routes
router.use(requireAuth);
router.use(requireTestAccess);

/**
 * GET /api/people
 * List all visitors and unknown people scoped by tenant and filters
 */
router.get(
  "/",
  requirePermission("people.read"),
  asyncHandler(async (req, res) => {
    const scope = req.auth?.scope;
    const { limit, type, search, fromDate, toDate } = req.query;

    const parsedLimit = limit === 'all' ? null : (Number(limit) > 0 ? Number(limit) : 500);

    const people = await personService.getAllPeople({
      scope,
      limit: parsedLimit,
      type: type || "all",
      search: search || "",
      fromDate: fromDate || null,
      toDate: toDate || null
    });

    return res.json({
      success: true,
      data: people.map(p => {
        let name = p.full_name;
        if (name === 'Unknown Person' || name === 'Visitor') {
          name = p.person_type === 'visitor' || p.visitor_type === 'visitor' ? 'Visitor' : 'Unknown Person';
        }
        return {
          personId: p.person_id,
          name: name,
          type: p.person_type,
          status: p.status,
          phone: p.phone,
          email: p.email,
          organization: p.organization,
          visitorType: p.visitor_type,
          photoPath: p.photo_path ? (p.photo_path.startsWith("http") || p.photo_path.startsWith("/uploads") ? p.photo_path : `/api/jetson/photos/${p.photo_path.split("/").pop()}`) : null,
          firstSeen: p.first_seen || p.created_at,
          lastSeen: p.last_seen || p.updated_at,
          lastEventAt: p.last_event_at || p.last_seen || null,
          visitCount: p.visit_count ?? 1,
          riskScore: p.risk_score ?? 0.0
        };
      }),
      total: people.length
    });
  })
);

/**
 * GET /api/people/:id
 * Retrieve detail cards, face gallery, and timeline events for a single visitor/unknown person
 */
router.get(
  "/:id",
  requirePermission("people.read"),
  asyncHandler(async (req, res) => {
    const scope = req.auth?.scope;
    const { id } = req.params;

    const details = await personService.getPersonById({ personId: id, scope });
    if (!details) {
      return res.status(404).json({ success: false, message: "Person not found" });
    }

    // Write audit log for profile access
    await writeAudit({
      req,
      action: "person.view",
      details: `Viewed ${details.profile.type} profile: ${details.profile.name} (${id})`,
      entityType: "person",
      entityId: id,
      entityName: details.profile.name,
      source: "ui"
    }).catch(() => {});

    return res.json({
      success: true,
      ...details
    });
  })
);

/**
 * POST /api/people/visitors
 * Register a scheduled or walk-in visitor and save their enrollment biometrics
 */
router.post(
  "/visitors",
  requirePermission("visitors.write"),
  validateBody(createVisitorSchema),
  asyncHandler(async (req, res) => {
    const scope = req.auth?.scope;
    const data = req.validatedBody;

    if (data.sendInvite && !data.email) {
      return res.status(400).json({ success: false, message: "Email is required to send remote invitation" });
    }

    const newVisitor = await personService.createVisitor({ scope, data });

    if (data.sendInvite) {
      const tenantId = scope?.tenantId || req.headers['x-tenant-id'];
      const customerId = scope?.customerId;
      const siteId = scope?.siteId;

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      const token = jwt.sign(
        {
          personId: newVisitor.person_id,
          tenantId,
          customerId,
          siteId
        },
        process.env.ENROLLMENT_TOKEN_SECRET,
        { expiresIn: '7d' }
      );

      await pool.query(
        `INSERT INTO enrollment_invitations (
          fk_person_id,
          mt_tenant_id,
          customer_id,
          site_id,
          invitation_token,
          expires_at
        ) VALUES ($1, $2::uuid, $3, $4, $5, $6)`,
        [newVisitor.person_id, tenantId, toIntOrNull(customerId), toIntOrNull(siteId), token, expiresAt]
      );

      let hostName = null;
      if (newVisitor.host_employee_id) {
        const { rows: hostRows } = await pool.query(
          `SELECT full_name FROM hr_employee WHERE pk_employee_id = $1`,
          [newVisitor.host_employee_id]
        );
        if (hostRows.length > 0) {
          hostName = hostRows[0].full_name;
        }
      }

      const formatDate = (dateVal) => {
        if (!dateVal) return null;
        const d = new Date(dateVal);
        return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      };

      const formatTimeRange = (fromVal, toVal) => {
        if (!fromVal || !toVal) return null;
        const fromD = new Date(fromVal);
        const toD = new Date(toVal);
        const formatTime = (d) => d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        return `${formatTime(fromD)} - ${formatTime(toD)}`;
      };

      const visitDetails = {
        hostName,
        visitDate: formatDate(newVisitor.valid_from),
        visitTimeRange: formatTimeRange(newVisitor.valid_from, newVisitor.valid_to),
        visitPurpose: newVisitor.visit_purpose
      };

      const enrollmentLink = `${process.env.ENROLLMENT_PORTAL_URL}/${token}`;

      await sendEnrollmentInvitation({
        employeeName: newVisitor.full_name,
        employeeEmail: newVisitor.email,
        enrollmentLink,
        expiresAt,
        visitDetails
      });

      await writeAudit({
        req,
        action: "enrollment.invitation.sent",
        details: `Sent visitor remote enrollment invitation to ${newVisitor.full_name} (${newVisitor.email})`,
        entityType: "person",
        entityId: newVisitor.person_id,
        entityName: newVisitor.full_name,
        source: "ui"
      }).catch(() => {});
    }

    await writeAudit({
      req,
      action: "visitor.create",
      details: data.sendInvite 
        ? `Registered visitor profile & sent enrollment invitation: ${newVisitor.full_name}`
        : `Registered visitor profile: ${newVisitor.full_name}`,
      entityType: "person",
      entityId: newVisitor.person_id,
      entityName: newVisitor.full_name,
      source: "ui"
    }).catch(() => {});

    return res.status(201).json({
      success: true,
      data: {
        personId: newVisitor.person_id,
        name: newVisitor.full_name,
        type: newVisitor.person_type,
        status: newVisitor.status
      }
    });
  })
);

/**
 * PATCH /api/people/visitors/:id
 * Update visitor profile details
 */
router.patch(
  "/visitors/:id",
  requirePermission("visitors.write"),
  asyncHandler(async (req, res) => {
    const scope = req.auth?.scope;
    const { id } = req.params;
    const patch = req.body;

    const updated = await personService.updateVisitor({ personId: id, patch, scope });
    if (!updated) {
      return res.status(404).json({ success: false, message: "Visitor profile not found" });
    }

    await writeAudit({
      req,
      action: "visitor.update",
      details: `Updated visitor profile details: ${updated.full_name}`,
      entityType: "person",
      entityId: id,
      entityName: updated.full_name,
      source: "ui"
    }).catch(() => {});

    return res.json({
      success: true,
      data: updated
    });
  })
);

/**
 * POST /api/people/convert/:id
 * Upgrade an unrecognized person history crop directly into a Visitor profile
 */
router.post(
  "/convert/:id",
  requirePermission("visitors.convert"),
  asyncHandler(async (req, res) => {
    const scope = req.auth?.scope;
    const { id } = req.params;
    const data = req.body;

    const converted = await personService.convertUnknownToVisitor({ personId: id, data, scope });

    await writeAudit({
      req,
      action: "unknown.convert",
      details: `Converted unknown person UNK-${id.slice(0, 8)} to visitor: ${converted.full_name}`,
      entityType: "person",
      entityId: id,
      entityName: converted.full_name,
      source: "ui"
    }).catch(() => {});

    return res.json({
      success: true,
      data: converted
    });
  })
);

/**
 * DELETE /api/people/:id
 * Hard delete / purge a visitor or unknown person and cascade biometric records
 */
router.delete(
  "/:id",
  requirePermission("visitors.write"),
  asyncHandler(async (req, res) => {
    const scope = req.auth?.scope;
    const { id } = req.params;

    const result = await personService.deletePerson({ personId: id, scope });

    await writeAudit({
      req,
      action: "person.delete",
      details: `Deleted person and biometric mappings: (${id})`,
      entityType: "person",
      entityId: id,
      source: "ui"
    }).catch(() => {});

    return res.json({
      success: true,
      ...result
    });
  })
);

export default router;
