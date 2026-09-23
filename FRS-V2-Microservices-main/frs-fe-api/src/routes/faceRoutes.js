import express from "express";
import { requireAuth, requirePermission } from "../middleware/authz.js";
import FaceController from "../controllers/FaceController.js";
import { uploadSingle } from "../middleware/upload.js";
import logger from '../utils/logger.js';

import { asyncHandler } from "../middleware/asyncHandler.js";
import { pool } from "../db/pool.js";

const router = express.Router();

// NOTE (frs-fe-api split): POST /recognize (device-JWT `authenticateDevice`,
// a device submitting a frame for recognition) now lives in frs-edge-api.
// Every remaining route here is `requireAuth`/human-facing.

router.use(requireAuth);

router.get("/", requirePermission("analytics.read"), asyncHandler(async (req, res) => {
  const tenantId = req.auth?.scope?.tenantId;
  const { rows } = await pool.query(`
    SELECT ef.id, ef.employee_id, ef.enrolled_at, ef.is_primary, ef.quality_score,
           ef.model_version, ef.angle, e.full_name, e.employee_code
    FROM employee_face_embeddings ef
    JOIN hr_employee e ON e.pk_employee_id = ef.employee_id
    WHERE e.tenant_id = $1::uuid
    ORDER BY ef.enrolled_at DESC
    LIMIT 200
  `, [tenantId]);
  return res.json({ data: rows, total: rows.length });
}));

router.post("/register", requirePermission("analytics.read"), asyncHandler(FaceController.registerFace));
router.post("/register/batch", requirePermission("analytics.read"), asyncHandler(FaceController.batchRegisterFaces));
router.get("/employee/:employeeId", requirePermission("analytics.read"), asyncHandler(FaceController.getEmployeeFaces));
router.get("/:id", requirePermission("analytics.read"), asyncHandler(FaceController.getFaceDetails));
router.put("/:id", requirePermission("analytics.read"), asyncHandler(FaceController.updateFace));
router.delete("/:id", requirePermission("analytics.read"), asyncHandler(FaceController.deleteFace));

router.post("/verify", requirePermission("analytics.read"), asyncHandler(FaceController.verifyFace));
router.post("/verify/multiple", requirePermission("analytics.read"), asyncHandler(FaceController.verifyMultipleFaces));
router.post("/search", requirePermission("analytics.read"), asyncHandler(FaceController.searchFaces));
router.post("/search/embedding", requirePermission("analytics.read"), asyncHandler(FaceController.searchByEmbedding));
router.post("/snapshot", requirePermission("analytics.read"), uploadSingle("snapshot"), asyncHandler(FaceController.uploadSnapshot));

router.get("/groups", requirePermission("analytics.read"), asyncHandler(FaceController.getFaceGroups));
router.post("/groups", requirePermission("analytics.read"), asyncHandler(FaceController.createFaceGroup));
router.put("/groups/:groupId", requirePermission("analytics.read"), asyncHandler(FaceController.updateFaceGroup));
router.delete("/groups/:groupId", requirePermission("analytics.read"), asyncHandler(FaceController.deleteFaceGroup));
router.post("/groups/:groupId/add-faces", requirePermission("analytics.read"), asyncHandler(FaceController.addFacesToGroup));
router.post("/groups/:groupId/remove-faces", requirePermission("analytics.read"), asyncHandler(FaceController.removeFacesFromGroup));

router.get("/stats", requirePermission("analytics.read"), asyncHandler(FaceController.getFaceStats));
router.get("/stats/matches", requirePermission("analytics.read"), asyncHandler(FaceController.getMatchStats));
router.get("/visitors", requirePermission("analytics.read"), asyncHandler(FaceController.getVisitors));
router.get("/visitors/:visitorId", requirePermission("analytics.read"), asyncHandler(FaceController.getVisitorDetails));
router.post("/visitors/blacklist", requirePermission("analytics.read"), asyncHandler(FaceController.blacklistVisitor));

export { router as faceRoutes };
