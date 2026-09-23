/**
 * jetsonRoutes.js — Remaining Jetson-adjacent routes on the frs-fe-api side
 *
 * NOTE (frs-fe-api split): the legacy `ALL /:camId/heartbeat` route
 * (`authenticateDevice`, device-JWT) now lives in frs-edge-api. Only the
 * human/`requireAuth` photo-serving route remains here — despite this
 * file's name, it serves photos to the UI, not to Jetson devices.
 *
 *   GET  /api/jetson/photos/:filename  — serve locally-stored attendance photos
 */
import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { requireAuth, requirePermission } from '../middleware/authz.js';
import { validateScopeAccess } from '../middleware/scopeExtractor.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { tenantOwnsPhoto } from '../middleware/photoAccess.js';
import { resolvePhotoByFilename } from '../services/photoResolverService.js';
import { getFileStream } from '../services/storageService.js';

const router = express.Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This file lives at frs-fe-api/src/routes/ — two levels under frs-fe-api/,
// not three (mirrors the original backend/api/src/routes/ layout — see the
// source repo's equivalent comment for the historical context).
const UPLOADS_DIR = path.resolve(__dirname, '../../uploads');

// Rate limiter for photo downloads (600 photos/min). Keyed by authenticated
// user, not IP — this route runs after requireAuth, and an IP-keyed limiter
// means every user behind the same NAT/office gateway (very much the normal
// case here) shares one counter, so real concurrent staff usage (each
// browser loading a page of thumbnails) exhausts the ceiling long before any
// single user actually abuses it. Falls back to IP only if auth info is
// somehow missing (shouldn't happen after requireAuth, but keeps this from
// ever silently no-op'ing the limiter).
const photoDownloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  message: { error: 'Too many photo requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.auth?.user?.id ? `user:${req.auth.user.id}` : ipKeyGenerator(req.ip),
});

// ── FIX-004: Photo endpoint now requires authentication ───────────────────────
// Previously unauthenticated — any user could enumerate/download employee photos.
// Now requires: valid JWT + attendance.read permission + tenant scope validation.
router.get(
  '/photos/:filename',
  requireAuth,
  validateScopeAccess,
  requirePermission('attendance.read'),
  photoDownloadLimiter,
  asyncHandler(async (req, res) => {
    const filename = path.basename(req.params.filename);

    if (!/^[\w\-]+\.(jpg|jpeg|png|gif|webp)$/i.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    // Verify the photo belongs to the requesting tenant (cross-tenant protection)
    const tenantId = req.auth?.scope?.tenantId;
    if (tenantId) {
      const owned = await tenantOwnsPhoto(tenantId, filename);
      if (!owned) {
        return res.status(404).json({ error: 'Photo not found' });
      }
    }

    res.set('X-Content-Type-Options', 'nosniff');

    const resolved = await resolvePhotoByFilename(filename, tenantId).catch(() => null);

    if (resolved?.key) {
      try {
        const { stream, contentType } = await getFileStream(resolved.bucket, resolved.key);
        if (contentType) res.set('Content-Type', contentType);
        // Only cache the response once we know it's actually the photo —
        // caching this on every request (including a not-yet-uploaded photo's
        // 404) meant a photo that landed in S3 seconds later stayed masked by
        // a browser-cached 404 for up to an hour.
        res.set('Cache-Control', 'private, max-age=3600');
        return stream.pipe(res);
      } catch (err) {
        res.set('Cache-Control', 'no-store');
        return res.status(404).json({ error: 'Photo not found' });
      }
    }

    // Legacy fallback: file still on local disk from before the S3 migration.
    const candidates = [
      path.join(UPLOADS_DIR, 'attendance-photos', filename),
      path.join(UPLOADS_DIR, 'enrollment-photos', filename),
    ];
    if (resolved?.legacyLocalPath) {
      const relPath = resolved.legacyLocalPath.replace(/^\/?uploads\//, '');
      candidates.unshift(path.join(UPLOADS_DIR, relPath));
      candidates.unshift(path.resolve(process.cwd(), resolved.legacyLocalPath));
    }

    for (const filePath of candidates) {
      if (fs.existsSync(filePath)) {
        res.set('Cache-Control', 'private, max-age=3600');
        return res.sendFile(filePath);
      }
    }

    res.set('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'Photo not found' });
  })
);

export { router as jetsonRoutes };
