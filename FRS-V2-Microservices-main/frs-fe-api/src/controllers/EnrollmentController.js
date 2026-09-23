import path from 'path';
import fsSync from 'fs';
import * as svc from '../services/business/EnrollmentService.js';
import { resolvePhotoByFilename } from '../services/photoResolverService.js';
import { getFileStream } from '../services/storageService.js';

const { NotFoundError } = svc;

function isJwtError(err) {
  return err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError';
}

// NOTE: the original routes are NOT consistent about the JWT-invalid message
// text across endpoints (some say 'Invalid token', others 'Invalid or expired
// token') — preserved verbatim per route below rather than unified, since an
// external consumer (the enrollment portal frontend) may match on these exact
// strings.
function handleKnownError(err, res, jwtMessage = 'Invalid token') {
  if (err instanceof NotFoundError) {
    return res.status(404).json({ message: err.message });
  }
  if (isJwtError(err)) {
    return res.status(401).json({ message: jwtMessage });
  }
  if (err.statusCode) {
    return res.status(err.statusCode).json({ message: err.message });
  }
  return null;
}

const EnrollmentController = {
  // ── Authenticated HR-facing endpoints ────────────────────────────────────
  async listInvitations(req, res) {
    const tenantId = await svc.resolveTenantId(req);
    const rows = await svc.listInvitations(tenantId);
    res.json({ data: rows, total: rows.length });
  },

  async sendInvitations(req, res) {
    const { employeeIds } = req.body;
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
      return res.status(400).json({ message: 'employeeIds array is required' });
    }
    if (employeeIds.length > 100) {
      return res.status(400).json({ message: 'Maximum 100 employees at once' });
    }

    const tenantId = await svc.resolveTenantId(req);
    const customerId = req.auth?.scope?.customerId;
    const siteId = req.auth?.scope?.siteId;

    const result = await svc.sendInvitations({ employeeIds, tenantId, customerId, siteId }, req);
    res.json({ success: true, ...result });
  },

  async listInvitationsFiltered(req, res) {
    const { status, limit = 200 } = req.query;
    const tenantId = await svc.resolveTenantId(req);
    const result = await svc.listInvitationsFiltered({ tenantId, status, limit });
    res.json(result);
  },

  async listEnrollmentEmployees(req, res) {
    const tenantId = await svc.resolveTenantId(req);
    const customerId = req.auth?.scope?.customerId;
    const siteId = req.auth?.scope?.siteId;
    const unitId = req.auth?.scope?.unitId;
    const employees = await svc.listEnrollmentEmployees({ tenantId, customerId, siteId, unitId });
    res.json({ employees });
  },

  async getReminderSettings(req, res) {
    const tenantId = await svc.resolveTenantId(req);
    const settings = await svc.getReminderSettings(tenantId);
    res.json(settings);
  },

  async updateReminderSettings(req, res) {
    const { enabled, hour } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ message: 'enabled (boolean) is required' });
    }
    const tenantId = await svc.resolveTenantId(req);

    // hour is optional — a plain on/off toggle shouldn't reset a previously
    // configured send time back to the default.
    let parsedHour;
    if (hour === undefined) {
      parsedHour = (await svc.getReminderSettings(tenantId)).hour;
    } else {
      parsedHour = Number(hour);
      if (!Number.isInteger(parsedHour) || parsedHour < 0 || parsedHour > 23) {
        return res.status(400).json({ message: 'hour must be an integer between 0 and 23' });
      }
    }

    const settings = await svc.setReminderSettings(tenantId, enabled, parsedHour);
    res.json({ success: true, ...settings });
  },

  async sendManualReminders(req, res) {
    const { invitationIds } = req.body;
    if (!Array.isArray(invitationIds) || invitationIds.length === 0) {
      return res.status(400).json({ message: 'invitationIds array is required' });
    }
    if (invitationIds.length > 100) {
      return res.status(400).json({ message: 'Maximum 100 invitations at once' });
    }
    const tenantId = await svc.resolveTenantId(req);
    const result = await svc.sendManualReminders({ invitationIds, tenantId }, req);
    res.json({ success: true, ...result });
  },

  async resendInvitation(req, res) {
    const { id } = req.params;
    try {
      await svc.resendInvitation(id, req);
      res.json({ success: true, message: 'Invitation resent' });
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async getPendingApprovals(req, res) {
    const tenantId = await svc.resolveTenantId(req);
    const pendingApprovals = await svc.getPendingApprovals(tenantId);
    res.json({ pendingApprovals });
  },

  async approveEnrollment(req, res) {
    const { id } = req.params;
    const tenantId = await svc.resolveTenantId(req);
    try {
      await svc.approveEnrollment({ id, tenantId, approvedBy: req.user?.id || null }, req);
      res.json({ success: true, message: 'Enrollment approved. Embeddings creating in background.' });
    } catch (err) {
      if (err instanceof NotFoundError) return res.status(404).json({ message: err.message });
      if (err.statusCode === 400) return res.status(400).json({ message: err.message });
      return res.status(500).json({ message: 'Failed to approve enrollment', error: err.message });
    }
  },

  async getEnrollmentProgress(req, res) {
    const { id } = req.params;
    const tenantId = await svc.resolveTenantId(req);
    try {
      const progress = await svc.getEnrollmentProgress({ id, tenantId });
      res.json(progress);
    } catch (err) {
      if (err instanceof NotFoundError) return res.status(404).json({ message: err.message });
      return res.status(500).json({ message: 'Failed to load enrollment progress', error: err.message });
    }
  },

  async rejectEnrollment(req, res) {
    const { id } = req.params;
    const { reason } = req.body;
    const tenantId = await svc.resolveTenantId(req);
    const customerId = req.auth?.scope?.customerId;
    const siteId = req.auth?.scope?.siteId;
    try {
      await svc.rejectEnrollment({ id, reason, tenantId, customerId, siteId, rejectedBy: req.auth?.user?.id || null }, req);
      res.json({ success: true, message: 'Enrollment rejected and new invitation sent to employee' });
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async revokeInvitation(req, res) {
    const { id } = req.params;
    try {
      await svc.revokeInvitationById(id, req);
      res.json({ success: true, message: 'Invitation revoked successfully' });
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async servePhoto(req, res) {
    const { filename } = req.params;

    if (!/^[a-zA-Z0-9_-]+\.(jpg|jpeg|png)$/.test(filename)) {
      return res.status(400).json({ message: 'Invalid filename' });
    }

    const resolved = await resolvePhotoByFilename(filename).catch(() => null);

    try {
      if (resolved?.key) {
        const { stream } = await getFileStream(resolved.bucket, resolved.key);
        res.setHeader('Content-Type', 'image/jpeg');
        return stream.pipe(res);
      }

      // Legacy fallback: file still on local disk from before the S3 migration.
      const legacyPath = resolved?.legacyLocalPath
        || path.join(svc.getRemoteEnrollmentPhotoDir(), filename);
      if (!fsSync.existsSync(legacyPath)) {
        return res.status(404).json({ message: 'Photo not found' });
      }
      res.setHeader('Content-Type', 'image/jpeg');
      fsSync.createReadStream(legacyPath).pipe(res);
    } catch (err) {
      return res.status(404).json({ message: 'Photo not found' });
    }
  },

  // ── PUBLIC enrollment portal endpoints ───────────────────────────────────
  async checkBlacklist(req, res, next) {
    const { token } = req.params;
    if (!token) return next();
    const blacklisted = await svc.isTokenBlacklisted(token);
    if (blacklisted) {
      return res.status(401).json({ message: 'Invitation has been revoked or expired' });
    }
    next();
  },

  async getProgress(req, res) {
    const { token } = req.params;
    try {
      const result = await svc.getProgress(token);
      res.json(result);
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async getPublicInvitation(req, res) {
    const { token } = req.params;
    try {
      const result = await svc.getPublicInvitation(token);
      res.json(result);
    } catch (err) {
      if (handleKnownError(err, res, 'Invalid or expired token')) return;
      throw err;
    }
  },

  async recordConsent(req, res) {
    const { token } = req.params;
    const { method = 'web_form' } = req.body || {};
    try {
      await svc.recordConsent(token, method);
      res.json({ success: true, message: 'Consent successfully recorded.' });
    } catch (err) {
      // Original route returned 404 directly (not via throw) for "invitation not
      // found", so only that case is distinguished — every other error (bad/expired
      // JWT, a DB error while recording consent, etc.) falls through to 401,
      // matching the original's blanket catch.
      if (err instanceof NotFoundError) return res.status(404).json({ message: err.message });
      return res.status(401).json({ message: 'Invalid or expired token' });
    }
  },

  async uploadAngle(req, res) {
    const { token } = req.params;
    const { angle } = req.body;

    if (!req.file) {
      return res.status(400).json({ message: 'No photo provided' });
    }
    if (!angle || !['front', 'left', 'right', 'up', 'up_deep', 'left_up', 'right_up', 'down'].includes(angle)) {
      return res.status(400).json({ message: 'Invalid angle' });
    }

    try {
      const result = await svc.uploadAngle({ token, angle, fileBuffer: req.file.buffer });
      res.json(result);
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async checkPose(req, res) {
    const { token } = req.params;
    const { angle } = req.body;

    if (!req.file) {
      return res.status(400).json({ message: 'No photo provided' });
    }
    if (!angle || !['front', 'left', 'right', 'up', 'up_deep', 'left_up', 'right_up', 'down'].includes(angle)) {
      return res.status(400).json({ message: 'Invalid angle' });
    }

    try {
      const result = await svc.checkPose({ token, angle, fileBuffer: req.file.buffer });
      res.json(result);
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },

  async completeEnrollment(req, res) {
    const { token } = req.params;
    try {
      const result = await svc.completeEnrollment(token);
      res.json(result);
    } catch (err) {
      if (handleKnownError(err, res)) return;
      throw err;
    }
  },
};

export default EnrollmentController;
