/**
 * faceRoutes.js — edge-facing subset of the original faceRoutes.js
 * (frs-core-api backend/api). Split per docs/architecture/API_SPLIT_PLAN.md:
 * this file keeps only `POST /recognize` (authenticateDevice — a device
 * submits a frame for recognition). All `requireAuth`-gated CRUD/verify/
 * search/groups/stats/visitors routes live in the frs-fe-api
 * (frontend-facing) sibling instead.
 */
import express from "express";
import FaceController from "../controllers/FaceController.js";
import { uploadSingle } from "../middleware/upload.js";
import authenticateDevice from '../middleware/authenticateDevice.js';
import { deviceIngestLimiter } from '../middleware/rateLimit.js';

import { asyncHandler } from "../middleware/asyncHandler.js";

const router = express.Router();

// POST /api/face/recognize — device submits a frame for recognition
router.post("/recognize", authenticateDevice, deviceIngestLimiter, uploadSingle("image"), asyncHandler(FaceController.recognizeAndMark));

export { router as faceRoutes };
