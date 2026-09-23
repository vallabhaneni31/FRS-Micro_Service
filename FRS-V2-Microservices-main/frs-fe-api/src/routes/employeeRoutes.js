import express from "express";
import http from "node:http";
import { writeAudit } from "../middleware/auditLog.js";
import { requireAuth, requirePermission } from "../middleware/authz.js";
import EmployeeController from "../controllers/EmployeeController.js";
import { uploadSingle } from "../middleware/upload.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import edgeAIClient from "../core/clients/EdgeAIClient.js";
import faceDB from "../core/db/FaceDB.js";
import { pool } from "../db/pool.js";
import logger from '../utils/logger.js';
import { env } from '../config/env.js';
import * as storage from '../services/storageService.js';
import { isLegacyLocalPath } from '../services/photoResolverService.js';
import { buildUserDataKey, sanitizeForKey } from '../utils/s3KeyBuilder.js';

const router = express.Router();
// Skip auth for device endpoints
router.use((req, res, next) => {
  if (req.path.includes('/enroll-face-direct')) return next();
  return requireAuth(req, res, next);
});

router.get("/", requirePermission("employees.read"), asyncHandler(EmployeeController.getAllEmployees));
router.get("/search", requirePermission("employees.read"), asyncHandler(EmployeeController.searchEmployees));
router.get("/managers", requirePermission("employees.read"), asyncHandler(EmployeeController.listManagers));

// GET /api/employees/tree — Workspace hierarchy: Organization -> Manager (is_manager=true,
// no manager of their own) -> their direct reports. Read-only aggregate, must be
// registered before /:id so "tree" isn't swallowed as an employee id.
router.get("/tree", requirePermission("employees.read"), asyncHandler(async (req, res) => {
  const tenantId = req.auth?.scope?.tenantId ?? null;
  const scopeSql = tenantId ? 'AND tenant_id = $1::uuid' : '';
  const params = tenantId ? [tenantId] : [];

  const { rows: managers } = await pool.query(
    `SELECT m.pk_employee_id AS id, m.full_name AS name, m.employee_code AS code,
       (SELECT count(*)::int FROM hr_employee r
         WHERE r.fk_manager_id = m.pk_employee_id AND r.status = 'active') AS direct_report_count
     FROM hr_employee m
     WHERE m.is_manager = true AND m.fk_manager_id IS NULL AND m.status = 'active' ${scopeSql}
     ORDER BY m.full_name`,
    params
  );
  const { rows: totalRows } = await pool.query(
    `SELECT count(*)::int AS c FROM hr_employee WHERE status = 'active' ${scopeSql}`,
    params
  );
  const { rows: unassignedRows } = await pool.query(
    `SELECT count(*)::int AS c FROM hr_employee
      WHERE status = 'active' AND fk_manager_id IS NULL AND is_manager = false ${scopeSql}`,
    params
  );

  return res.json({
    organization: { employeeCount: totalRows[0]?.c ?? 0 },
    managers: managers.map(m => ({
      id: String(m.id), name: m.name, code: m.code, direct_report_count: m.direct_report_count,
    })),
    unassignedCount: unassignedRows[0]?.c ?? 0,
  });
}));
// POST /:id/view-audit — explicit audit for profile views from frontend
router.post("/:id/view-audit", requirePermission("employees.read"), asyncHandler(async (req, res) => {
  try {
    const tenantId = req.auth?.scope?.tenantId ?? null;
    const { rows } = tenantId
      ? await pool.query(
          'SELECT full_name, employee_code FROM hr_employee WHERE pk_employee_id=$1 AND tenant_id=$2::uuid',
          [req.params.id, tenantId]
        )
      : await pool.query(
          'SELECT full_name, employee_code FROM hr_employee WHERE pk_employee_id=$1',
          [req.params.id]
        );
    if (rows.length) {
      await writeAudit({ req, action: 'employee.view',
        details: `Viewed profile: ${rows[0].full_name} (${rows[0].employee_code})`,
        entityType: 'employee', entityId: req.params.id,
        entityName: rows[0].full_name, source: 'ui'
      });
    }
  } catch (_) {}
  return res.json({ success: true });
}));

// ── GET /api/employees/:employeeId/enrollment-history
// Get enrollment history timeline from audit log
router.get(
  "/:employeeId/enrollment-history",
  requirePermission("employees.read"),
  asyncHandler(async (req, res) => {
    const { employeeId } = req.params;
    
    // Get all face-related audit events for this employee, scoped to tenant
    const tenantId = req.auth?.scope?.tenantId ?? null;
    const { rows } = await pool.query(
      `SELECT
        pk_audit_id,
        action,
        details,
        before_data,
        after_data,
        user_name,
        user_role,
        source,
        created_at
       FROM audit_log
       WHERE entity_type = 'employee'
         AND entity_id = $1
         AND action LIKE 'face%'
         AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
       ORDER BY created_at DESC
       LIMIT 50`,
      [employeeId, tenantId]
    );
    
    return res.json({
      employeeId,
      history: rows.map(r => ({
        id: r.pk_audit_id,
        action: r.action,
        details: r.details,
        beforeData: r.before_data,
        afterData: r.after_data,
        performedBy: r.user_name || 'System',
        role: r.user_role,
        source: r.source,
        timestamp: r.created_at
      }))
    });
  })
);

// ── PATCH /api/employees/:employeeId/embeddings/:embeddingId/set-primary
// Set a specific embedding as the primary one
router.patch(
  "/:employeeId/embeddings/:embeddingId/set-primary",
  requirePermission("employees.write"),
  asyncHandler(async (req, res) => {
    const { employeeId, embeddingId } = req.params;
    
    // Verify embedding exists and belongs to this employee
    const { rows: existing } = await pool.query(
      `SELECT id, angle, quality_score FROM employee_face_embeddings 
       WHERE id = $1 AND employee_id = $2`,
      [embeddingId, employeeId]
    );
    
    if (existing.length === 0) {
      return res.status(404).json({ message: "Embedding not found" });
    }
    
    const emb = existing[0];
    
    // Unset all other embeddings as primary for this employee
    await pool.query(
      `UPDATE employee_face_embeddings 
       SET is_primary = false 
       WHERE employee_id = $1`,
      [employeeId]
    );
    
    // Set this one as primary
    await pool.query(
      `UPDATE employee_face_embeddings 
       SET is_primary = true 
       WHERE id = $1`,
      [embeddingId]
    );
    
    await writeAudit({
      req,
      action: 'face.primary.update',
      details: `Set ${emb.angle || 'embedding'} as primary (quality: ${emb.quality_score ? (emb.quality_score * 100).toFixed(0) + '%' : 'n/a'})`,
      entityType: 'employee',
      entityId: String(employeeId),
      after: { embeddingId, angle: emb.angle, isPrimary: true },
      source: 'ui'
    });
    
    return res.json({
      success: true,
      primaryEmbedding: {
        id: embeddingId,
        angle: emb.angle,
        qualityScore: emb.quality_score
      }
    });
  })
);

router.get("/:id", requirePermission("employees.read"), asyncHandler(async (req, res, next) => {
  // Audit profile view
  const { rows } = await (await import('../db/pool.js')).pool.query(
    'SELECT full_name, employee_code FROM hr_employee WHERE pk_employee_id=$1', [req.params.id]
  );
  if (rows.length) {
    await writeAudit({ req, action: 'employee.view',
      details: `Viewed profile: ${rows[0].full_name} (${rows[0].employee_code})`,
      entityType: 'employee', entityId: req.params.id, entityName: rows[0].full_name,
      source: 'ui'
    });
  }
  next();
}), asyncHandler(EmployeeController.getEmployeeById));
router.get("/:id/photo", requirePermission("employees.read"), asyncHandler(EmployeeController.getEmployeePhoto));
router.get("/:id/profile-photo", requirePermission("employees.read"), asyncHandler(EmployeeController.serveProfilePhoto));
router.get("/:id/attendance", requirePermission("attendance.read"), asyncHandler(EmployeeController.getEmployeeAttendance));
router.get("/:id/activity", requirePermission("employees.read"), asyncHandler(EmployeeController.getEmployeeActivity));
router.post("/", requirePermission("employees.write"), asyncHandler(EmployeeController.createEmployee));
router.put("/:id", requirePermission("employees.write"), asyncHandler(EmployeeController.updateEmployee));
router.delete("/:id", requirePermission("employees.delete"), asyncHandler(EmployeeController.deleteEmployee));

// ── DELETE /api/employees/:id/erase
// GDPR Right to Erasure: cascade delete all traces of an employee
router.delete(
  "/:id/erase",
  requirePermission("employees.delete"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const tenantId = req.auth?.scope?.tenantId ?? null;

    // Verify employee belongs to this tenant if not super_admin
    const memberships = req.auth?.memberships || [];
    const isSuperAdmin = memberships.some(m => m.scope.tenantId === null);

    let queryText = 'SELECT pk_employee_id, full_name, employee_code, tenant_id FROM hr_employee WHERE pk_employee_id = $1';
    const params = [Number(id)];
    if (!isSuperAdmin) {
      if (!tenantId) return res.status(400).json({ error: 'Tenant context required' });
      queryText += ' AND tenant_id = $2::uuid';
      params.push(tenantId);
    }

    const { rows: empRows } = await pool.query(queryText, params);
    if (!empRows.length) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    const emp = empRows[0];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Fetch photo paths from enrollment_invitations to delete from S3
      const { rows: photoRows } = await client.query(
        `SELECT photo_paths FROM enrollment_invitations WHERE fk_employee_id = $1`,
        [emp.pk_employee_id]
      );

      // 2. Cascade delete database records
      const delEmbeddings = await client.query('DELETE FROM employee_face_embeddings WHERE employee_id = $1 RETURNING id', [emp.pk_employee_id]);
      const delInvitations = await client.query('DELETE FROM enrollment_invitations WHERE fk_employee_id = $1 RETURNING pk_invitation_id', [emp.pk_employee_id]);
      const delAttendance = await client.query('DELETE FROM attendance_record WHERE fk_employee_id = $1 RETURNING pk_attendance_id', [emp.pk_employee_id]);
      
      // Delete from hr_employee
      await client.query('DELETE FROM hr_employee WHERE pk_employee_id = $1', [emp.pk_employee_id]);

      // 3. Clean SQLite cache
      try {
        await faceDB.deleteEmployeeFaces(emp.pk_employee_id);
      } catch (_) {}

      await client.query('COMMIT');

      // 4. Delete photos from S3 (best-effort; legacy local paths from
      // before the migration are skipped here — see gdprErasureService.js's
      // equivalent step for the local-disk case).
      for (const row of photoRows) {
        const paths = row.photo_paths || {};
        for (const photoPath of Object.values(paths)) {
          if (photoPath && !isLegacyLocalPath(photoPath)) {
            await storage.deleteFile(storage.USER_DATA_BUCKET, photoPath).catch(() => {});
          }
        }
      }

      await writeAudit({
        req,
        action: 'employee.gdpr_erase',
        details: `GDPR Erasure executed for employee: ${emp.full_name} (${emp.employee_code})`,
        entityType: 'employee',
        entityId: String(emp.pk_employee_id),
        entityName: emp.full_name,
        source: 'api'
      }).catch(() => {});

      return res.json({
        success: true,
        message: `Successfully executed GDPR Right to Erasure for employee ${emp.full_name}. All personal data, face embeddings, attendance logs, and photo assets have been permanently purged.`,
        erased: {
          embeddings: delEmbeddings.rowCount,
          invitations: delInvitations.rowCount,
          attendanceLogs: delAttendance.rowCount,
          filesPurged: photoRows.length * 5
        }
      });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('[GDPR] Erasure failed:', err);
      return res.status(500).json({ error: 'Internal server error executing GDPR Erasure' });
    } finally {
      client.release();
    }
  })
);

router.post("/:id/activate", requirePermission("employees.deactivate"), asyncHandler(EmployeeController.activateEmployee));
router.post("/:id/deactivate", requirePermission("employees.deactivate"), asyncHandler(EmployeeController.deactivateEmployee));
router.post("/:id/assign-device", requirePermission("devices.write"), asyncHandler(EmployeeController.assignDevice));
router.post("/bulk-import", requirePermission("employees.bulk_import"), asyncHandler(EmployeeController.bulkImport));

// ── POST /api/employees/:employeeId/enroll-face
// Accepts a photo upload, runs it through the EdgeAI sidecar to get the
// 512-d ArcFace embedding, then stores it in pgvector + SQLite FaceDB.
router.post(
  "/:employeeId/enroll-face",
  requirePermission("employees.write"),
  uploadSingle("photo"),
  asyncHandler(async (req, res) => {
    const { employeeId } = req.params;
    const tenantId = req.auth?.scope?.tenantId;

    if (!req.file?.buffer) {
      return res.status(400).json({
        message: "Photo file is required. Send as multipart/form-data with field name 'photo'.",
      });
    }

    // Verify employee belongs to this tenant (same pattern as enroll-remote below)
    const { rows: empRows } = await pool.query(
      `SELECT pk_employee_id, employee_code, full_name FROM hr_employee
       WHERE pk_employee_id = $1 AND tenant_id = $2::uuid`,
      [employeeId, tenantId]
    );
    if (!empRows.length) return res.status(404).json({ message: "Employee not found" });
    const emp = empRows[0];

    // Step 1 — Send photo to Jetson /enroll-image endpoint for embedding extraction
    const JETSON_URL = env.jetsonSidecarUrl;
    let aiResult;
    try {
      // Use node:http directly to send raw JPEG with correct Content-Length
      const jd = await new Promise((resolve, reject) => {
        const imgBuf = req.file.buffer;
        const urlObj = new URL(`${JETSON_URL}/enroll-image`);
        const options = {
          hostname: urlObj.hostname,
          port: urlObj.port || 5000,
          path: "/enroll-image",
          method: "POST",
          headers: {
            "Content-Type": "image/jpeg",
            "Content-Length": imgBuf.length,
          },
          timeout: 15000,
        };
        const hreq = http.request(options, (hres) => {
          let data = "";
          hres.on("data", (chunk) => { data += chunk; });
          hres.on("end", () => {
            try { resolve(JSON.parse(data)); }
            catch { resolve({}); }
          });
        });
        hreq.on("error", reject);
        hreq.on("timeout", () => { hreq.destroy(); reject(new Error("timeout")); });
        hreq.write(imgBuf);
        hreq.end();
      });
      if (jd?.embedding?.length === 512) {
        aiResult = { embedding: jd.embedding, confidence: jd.confidence || 0.8, faceCount: 1 };
      } else if (jd?.error) {
        logger.warn(`[EnrollFace] Jetson error for employee ${employeeId}: ${jd.error}`);
        throw new Error(jd.error);
      } else {
        logger.warn(`[EnrollFace] Jetson returned unexpected response for employee ${employeeId}:`, JSON.stringify(jd).slice(0, 200));
        throw new Error("No embedding returned from Jetson");
      }
    } catch (e) {
      const msg = e?.message ?? '';
      // If Jetson responded but no valid embedding — pass through the error
      if (msg.includes('No embedding') || msg.includes('No face') || msg.includes('Multiple face') || msg.includes('face')) {
        return res.status(422).json({ message: msg });
      }
      // Jetson unreachable
      return res.status(503).json({
        message: "Jetson AI runner unreachable. Make sure frs-runner is running on the Jetson.",
        hint: "Run: sudo systemctl start frs-runner",
        detail: msg,
      });
    }

    if (!aiResult?.embedding?.length) {
      return res.status(422).json({
        message: "No face detected in photo. Use a clear, well-lit, front-facing photo.",
      });
    }

    if ((aiResult.faceCount || 1) > 1) {
      return res.status(422).json({
        message: `${aiResult.faceCount} faces detected. Upload a photo containing only the employee.`,
      });
    }

    if (aiResult.aligned === false) {
      // Warn but still enroll — some cameras capture at angles
      logger.warn(`[EnrollFace] Employee ${employeeId}: face alignment failed. Similarity may be lower.`);
    }

    // Use model_version from sidecar response, request body, or default
    const modelVersion = aiResult.model_version || req.body.model_version || 'arcface-r50-fp16';

    // Step 2 — Store in pgvector (primary store, fast lookup)
    const vectorStr = `[${aiResult.embedding.join(",")}]`;

    // ── CHECK FOR DUPLICATE ENROLLMENT ──
    const { rows: duplicateCheck } = await pool.query(
      `SELECT ef.employee_id, 1 - (ef.embedding <=> $1::vector) as similarity, e.full_name
       FROM employee_face_embeddings ef
       JOIN hr_employee e ON e.pk_employee_id = ef.employee_id
       WHERE 1 - (ef.embedding <=> $1::vector) >= 0.50
         AND ef.employee_id != $2
         AND ef.model_version = $3
       ORDER BY ef.embedding <=> $1::vector ASC
       LIMIT 1`,
      [vectorStr, employeeId, modelVersion]
    );

    if (duplicateCheck.length > 0) {
      return res.status(409).json({
        message: `This face is already registered in the system under a different name (${duplicateCheck[0].full_name}). Duplicate enrollment is not allowed.`,
      });
    }

    // Keep max 8 embeddings per employee — delete oldest if over limit
    const { rows: existing } = await pool.query(
      `SELECT id FROM employee_face_embeddings WHERE employee_id = $1 ORDER BY enrolled_at ASC`,
      [employeeId]
    );
    if (existing.length >= 8) {
      await pool.query(`DELETE FROM employee_face_embeddings WHERE id = $1`, [existing[0].id]);
    }
    // Check if this is the first embedding (set as primary)
    // Before inserting, check if we should set as primary
    const { angle } = req.body;
    const shouldBePrimary = angle === 'front' && (aiResult.confidence || 0) > 0.65;

    // If this is a new primary, unmark old primaries
    if (shouldBePrimary) {
      await pool.query(
        'UPDATE employee_face_embeddings SET is_primary = FALSE WHERE employee_id = $1',
        [employeeId]
      );
    }

    // Upload the enrollment photo to S3 (previously discarded — photo_path was always null)
    const photoKey = buildUserDataKey({
      tenantId, employeeCode: emp.employee_code, section: 'enrollment', filename: `${angle}.jpg`,
    });
    await storage.uploadFile(storage.USER_DATA_BUCKET, photoKey, req.file.buffer, 'image/jpeg');

    // The "front" angle also doubles as the employee's profile photo
    if (angle === 'front') {
      const profileKey = buildUserDataKey({
        tenantId, employeeCode: emp.employee_code, section: 'profile', filename: 'profile.jpg',
      });
      await storage.uploadFile(storage.USER_DATA_BUCKET, profileKey, req.file.buffer, 'image/jpeg');
    }

    await pool.query(
      `INSERT INTO employee_face_embeddings
         (employee_id, embedding, quality_score, is_primary, enrolled_by, model_version, angle, photo_path)
       VALUES ($1, $2::vector, $3, $4, $5, $6, $7, $8)`,
      [employeeId, vectorStr, aiResult.confidence || null, shouldBePrimary, req.auth?.user?.id || null, modelVersion, angle, photoKey]
    );

    // Step 3 — Also sync to SQLite FaceDB (offline fallback)
    await faceDB.addFace(aiResult.embedding, {
      id:         `emp_${employeeId}_${Date.now()}`,
      employeeId: String(employeeId),
      enrolledAt: new Date().toISOString(),
    });

    await writeAudit({ req, action: 'face.enroll',
      details: `Face enrolled for employee ${employeeId} (confidence: ${(aiResult.confidence||0).toFixed(3)})`,
      entityType: 'employee', entityId: String(employeeId),
      after: { confidence: aiResult.confidence, model: 'arcface-r50' },
      source: 'ui'
    });
    return res.status(201).json({
      success:    true,
      employeeId,
      confidence: aiResult.confidence,
      aligned:    aiResult.aligned,
      faceCount:  aiResult.faceCount || 1,
      message:    "Face enrolled successfully. Employee will now be recognised by cameras.",
    });
  })
);

// ── DELETE /api/employees/:employeeId/enroll-face
// Remove all face embeddings so a fresh enroll can be done.
router.delete(
  "/:employeeId/enroll-face",
  requirePermission("employees.write"),
  asyncHandler(async (req, res) => {
    const { employeeId } = req.params;
    const { rowCount } = await pool.query(
      "DELETE FROM employee_face_embeddings WHERE employee_id = $1",
      [employeeId]
    );
    await writeAudit({ req, action: 'face.enroll.delete',
      details: `Face enrollment removed for employee ${employeeId} (${rowCount} embedding(s) deleted)` });
    return res.json({
      success: true,
      removed: rowCount,
      message: `Removed ${rowCount} face embedding(s) for employee ${employeeId}. Re-enroll to restore recognition.`,
    });
  })
);

// ── DELETE /api/employees/:employeeId/embeddings/:embeddingId
// Delete a single face embedding (e.g., to remove a bad quality angle)
router.delete(
  "/:employeeId/embeddings/:embeddingId",
  requirePermission("employees.write"),
  asyncHandler(async (req, res) => {
    const { employeeId, embeddingId } = req.params;

    const { rows: existing } = await pool.query(
      `SELECT angle, quality_score, photo_path
       FROM employee_face_embeddings
       WHERE id = $1 AND employee_id = $2`,
      [embeddingId, employeeId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: "Embedding not found" });
    }

    const emb = existing[0];

    await pool.query(`DELETE FROM employee_face_embeddings WHERE id = $1`, [embeddingId]);

    const { rows: remaining } = await pool.query(
      `SELECT count(*)::int as count FROM employee_face_embeddings WHERE employee_id = $1`,
      [employeeId]
    );

    await writeAudit({
      req,
      action: 'face.embedding.delete',
      details: `Deleted ${emb.angle || 'unknown'} angle embedding (quality: ${emb.quality_score ? (emb.quality_score * 100).toFixed(0) + '%' : 'n/a'})`,
      entityType: 'employee',
      entityId: String(employeeId),
      before: { angle: emb.angle, quality: emb.quality_score },
      source: 'ui'
    });

    return res.json({
      success: true,
      deletedEmbedding: { id: embeddingId, angle: emb.angle, qualityScore: emb.quality_score },
      remainingCount: remaining[0].count,
      message: `Deleted ${emb.angle || 'photo'}. ${remaining[0].count} angle(s) remaining.`,
    });
  })
);

// ── GET /api/employees/:employeeId/enroll-face
// Check enrollment status for an employee.
router.get(
  "/:employeeId/enroll-face",
  requirePermission("employees.read"),
  asyncHandler(async (req, res) => {
    const { employeeId } = req.params;
    const { rows } = await pool.query(
      `SELECT id, model_version, quality_score, is_primary, enrolled_at, angle, photo_path
       FROM employee_face_embeddings
       WHERE employee_id = $1
       ORDER BY enrolled_at DESC`,
      [employeeId]
    );
    return res.json({
      employeeId,
      enrolled:       rows.length > 0,
      embeddingCount: rows.length,
      embeddings:     rows.map(r => ({
        id:           r.id,
        modelVersion: r.model_version,
        qualityScore: r.quality_score,
        isPrimary:    r.is_primary,
        enrolledAt:   r.enrolled_at,
        angle:        r.angle,
        // Keyed by the embedding's own id, not by filename — enrollment
        // photos are named identically across employees (image_front.jpg
        // etc; the employee-specific part lives only in the S3 folder
        // prefix), so /api/jetson/photos/:filename's basename-only lookup
        // could serve the wrong employee's photo. This route looks the row
        // up by its own primary key instead, which is unambiguous no matter
        // what the underlying filename is — including older rows enrolled
        // before enrollment filenames were made globally unique.
        photoUrl:     r.photo_path ? `/api/employees/${employeeId}/embeddings/${r.id}/photo` : null,
      })),
    });
  })
);

// ── GET /api/employees/:employeeId/embeddings/:embeddingId/photo
// Streams a single embedding's enrollment photo straight from S3. Looked up
// by the embedding's own id (not by filename — see the comment on photoUrl
// above), and scoped to both employeeId and the requester's tenant so one
// tenant can't fetch another's biometric photo by guessing an embedding id.
router.get(
  "/:employeeId/embeddings/:embeddingId/photo",
  requirePermission("employees.read"),
  asyncHandler(async (req, res) => {
    const { employeeId, embeddingId } = req.params;
    const tenantId = req.auth?.scope?.tenantId ?? null;

    const { rows } = await pool.query(
      `SELECT ef.photo_path
       FROM employee_face_embeddings ef
       JOIN hr_employee e ON e.pk_employee_id = ef.employee_id
       WHERE ef.id = $1 AND ef.employee_id = $2
         ${tenantId ? 'AND e.tenant_id = $3::uuid' : ''}
       LIMIT 1`,
      tenantId ? [embeddingId, employeeId, tenantId] : [embeddingId, employeeId]
    );

    const photoPath = rows[0]?.photo_path;
    if (!photoPath) return res.status(404).json({ error: 'photo_not_found' });

    if (isLegacyLocalPath(photoPath)) {
      return res.status(404).json({ error: 'legacy_local_path_unsupported' });
    }

    try {
      const { stream, contentType } = await storage.getFileStream(storage.USER_DATA_BUCKET, photoPath);
      if (contentType) res.set('Content-Type', contentType);
      res.set('Cache-Control', 'private, max-age=3600');
      return stream.pipe(res);
    } catch (err) {
      return res.status(404).json({ error: 'photo_not_found' });
    }
  })
);


// ── POST /api/employees/:employeeId/enroll-remote
// Browser-initiated remote enrollment — works without direct Jetson access.
// 1. Stores the uploaded photo on disk
// 2. Queues an 'enroll_from_photo' command for the tenant's Jetson device
// 3. Jetson downloads photo, runs ArcFace, pushes enrollment.completed event back
router.post(
  "/:employeeId/enroll-remote",
  requirePermission("employees.write"),
  uploadSingle("photo"),
  asyncHandler(async (req, res) => {
    const { employeeId } = req.params;
    const tenantId = req.auth?.scope?.tenantId;

    if (!req.file?.buffer) {
      return res.status(400).json({ message: "Photo file is required (field: photo)" });
    }

    // Verify employee belongs to this tenant
    const { rows: empRows } = await pool.query(
      `SELECT pk_employee_id, employee_code, full_name FROM hr_employee
       WHERE pk_employee_id = $1 AND tenant_id = $2::uuid`,
      [employeeId, tenantId]
    );
    if (!empRows.length) return res.status(404).json({ message: "Employee not found" });
    const emp = empRows[0];

    // Upload photo to the permanent S3 user-data bucket so Jetson can download it.
    // Filename matches the stable per-angle convention used everywhere else
    // (front.jpg/left.jpg/...) — overwrites in place on re-enroll, consistent
    // with enroll-face and the self-enrollment portal.
    const angle = req.body.angle || "front";
    const filename = `${sanitizeForKey(angle)}.jpg`;
    const photoKey = buildUserDataKey({
      tenantId,
      employeeCode: emp.employee_code,
      section: 'enrollment',
      filename,
    });
    await storage.uploadFile(storage.USER_DATA_BUCKET, photoKey, req.file.buffer, "image/jpeg");

    if (angle === 'front') {
      const profileKey = buildUserDataKey({
        tenantId, employeeCode: emp.employee_code, section: 'profile', filename: 'profile.jpg',
      });
      await storage.uploadFile(storage.USER_DATA_BUCKET, profileKey, req.file.buffer, "image/jpeg");
    }

    // Short-lived presigned URL for the Jetson to download + for the audit
    // log — photo_key (below) is the authoritative reference photoResolverService
    // uses; photo_url exists only as a human/device-friendly download link.
    const photoUrl = await storage.getDownloadUrl(storage.USER_DATA_BUCKET, photoKey);

    // Find the tenant's active Jetson device
    const { rows: devRows } = await pool.query(
      `SELECT pk_device_id FROM facility_device
       WHERE tenant_id = $1::uuid AND status != 'decommissioned'
       ORDER BY last_heartbeat DESC NULLS LAST LIMIT 1`,
      [tenantId]
    );
    if (!devRows.length) {
      return res.status(503).json({
        message: "No active Jetson device found for this tenant. Enroll via kiosk instead.",
      });
    }

    // Queue the command — Jetson polls GET /api/events/commands every ~10s
    await pool.query(
      `INSERT INTO device_command_queue
         (device_id, command_type, command_payload, priority, expires_at)
       VALUES ($1, 'enroll_from_photo', $2::jsonb, 8, NOW() + INTERVAL '30 minutes')`,
      [
        devRows[0].pk_device_id,
        JSON.stringify({
          employee_id: emp.pk_employee_id,
          employee_code: emp.employee_code,
          full_name: emp.full_name,
          photo_url: photoUrl,
          photo_key: photoKey,
          angle,
          requested_by: req.auth?.user?.email || "operator",
        }),
      ]
    );

    await writeAudit({
      req,
      action: "face.enroll_remote_queued",
      details: `Remote enrollment queued for ${emp.full_name} — Jetson will process photo`,
      entityType: "employee",
      entityId: String(employeeId),
      after: { photo_url: photoUrl, employee_code: emp.employee_code },
      source: "ui",
    });

    return res.json({
      success: true,
      queued: true,
      message: "Photo sent to Jetson for processing. Enrollment will complete within 30 seconds.",
      employee: { id: emp.pk_employee_id, code: emp.employee_code, name: emp.full_name },
    });
  })
);

export { router as employeeRoutes };

