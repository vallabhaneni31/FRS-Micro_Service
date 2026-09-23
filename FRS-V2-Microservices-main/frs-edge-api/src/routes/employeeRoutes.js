/**
 * employeeRoutes.js — edge-facing employee enrollment
 * Split per docs/architecture/API_SPLIT_PLAN.md: this route was originally in
 * frs-fe-api/src/routes/employeeRoutes.js and moved here because the Jetson
 * edge box computes the face embedding itself and just needs to store the
 * result — it's a device-authenticated write, not a browser-facing one.
 * All requireAuth-gated employee CRUD stays in frs-fe-api.
 */
import express from "express";
import authenticateDevice from "../middleware/authenticateDevice.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { deviceIngestLimiter } from "../middleware/rateLimit.js";
import { pool } from "../db/pool.js";
import faceDB from "../core/db/FaceDB.js";
import { writeAudit } from "../middleware/auditLog.js";

const router = express.Router();

// ── POST /api/employees/:employeeId/enroll-face-direct
// Accepts a pre-computed 512-d ArcFace embedding from the C++ runner.
// No EdgeAI sidecar call needed — embedding was computed on Jetson hardware.
// Body: { "embedding": [0.12, -0.34, ...] (512 floats), "confidence": 0.92 }
router.post(
  "/:employeeId/enroll-face-direct",
  authenticateDevice,
  deviceIngestLimiter,
  asyncHandler(async (req, res) => {
    const { employeeId } = req.params;
    const { embedding, confidence, source } = req.body;

    if (!Array.isArray(embedding) || embedding.length !== 512) {
      return res.status(400).json({
        message: "embedding must be a 512-element float array (ArcFace output)",
      });
    }

    // Validate it looks like an L2-normalized vector
    const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
    if (norm < 0.9 || norm > 1.1) {
      return res.status(422).json({
        message: `Embedding must be L2-normalized (norm=${norm.toFixed(3)}). ` +
                 "Apply L2 normalization before sending.",
      });
    }

    // Accept model_version from request body (Jetson sends its own model tag)
    const modelVersion = req.body.model_version || "arcface-r50-fp16";

    // photo_path is trusted from the device — restrict it to a tenant-scoped
    // S3 key shape rather than accepting an arbitrary string that later gets
    // ILIKE-matched and streamed back via photoResolverService.
    if (req.body.photo_path && !String(req.body.photo_path).startsWith("tenant-")) {
      return res.status(400).json({ message: "photo_path must be a tenant-scoped S3 key" });
    }

    // Store in pgvector
    const vectorStr = `[${embedding.join(",")}]`;

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

    // Before inserting, check if we should set as primary
    const shouldBePrimary = (req.body.angle === "front" || req.body.angle?.toLowerCase() === "front") && (confidence || 0) > 0.65;

    // If this is a new primary, unmark old primaries
    if (shouldBePrimary) {
      await pool.query(
        "UPDATE employee_face_embeddings SET is_primary = FALSE WHERE employee_id = $1",
        [employeeId]
      );
    }

    await pool.query(
      `INSERT INTO employee_face_embeddings
         (employee_id, embedding, quality_score, is_primary, enrolled_by, model_version, angle, photo_path)
       VALUES ($1, $2::vector, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING`,
      [
        employeeId,
        vectorStr,
        confidence || null,
        shouldBePrimary,
        req.device?.pk_device_id || null,
        modelVersion,
        req.body.angle || null,
        req.body.photo_path || null,
      ],
    );

    // Sync to SQLite FaceDB fallback
    await faceDB.addFace(embedding, {
      id:         `emp_${employeeId}_${Date.now()}`,
      employeeId: String(employeeId),
      source:     source || "cpp-runner",
      enrolledAt: new Date().toISOString(),
    });

    await writeAudit({ req, action: "face.enroll",
      details: `Face enrolled for employee ${employeeId} (confidence: ${(Number(confidence) || 0).toFixed(3)})`,
      entityType: "employee", entityId: String(employeeId),
      after: { confidence: confidence || null, model: modelVersion },
      source: "device"
    }).catch(() => {});
    return res.status(201).json({
      success:    true,
      employeeId,
      confidence: confidence || null,
      source:     source || "cpp-runner",
      message:    "Face enrolled successfully via direct embedding. Employee will be recognised immediately.",
    });
  })
);

// ── GET /api/employees/:employeeId/enroll-face-direct
// Quick enrollment status check (same as /enroll-face but separate path for C++ runner)
router.get(
  "/:employeeId/enroll-face-direct",
  authenticateDevice,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT count(*)::int as c FROM employee_face_embeddings WHERE employee_id = $1`,
      [req.params.employeeId]
    );
    return res.json({ enrolled: rows[0].c > 0, count: rows[0].c });
  })
);

export { router as employeeRoutes };
