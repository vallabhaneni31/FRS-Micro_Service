/**
 * attendanceRoutes.js — edge-facing subset of the original attendanceRoutes.js
 * (frs-core-api backend/api). Split per docs/architecture/API_SPLIT_PLAN.md:
 * this file keeps only `POST /frame`, `POST /bulk-sync`, `POST /direction`
 * (all `authenticateDevice`, `deviceIngestLimiter`) — the Jetson-originated
 * attendance ingest paths. Everything else (mark/batch/today/employee/
 * date-range/current/stats/reports/correct/delete/dwell/export/correction/
 * photos) is `requireAuth`/`requirePermission`-gated human-facing surface and
 * lives in the frs-fe-api (frontend-facing) sibling instead.
 */
import { pool } from "../db/pool.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import express from "express";
import attendanceService from "../services/business/AttendanceService.js";
import authenticateDevice from "../middleware/authenticateDevice.js";
import { deviceIngestLimiter } from "../middleware/rateLimit.js";
import { shouldWriteAsync, publishAttendanceMark, publishFrameAttach } from "../services/business/attendanceIngestPublisher.js";
import { writeAudit } from "../middleware/auditLog.js";
import logger from '../utils/logger.js';
const router = express.Router();

// POST /api/attendance/frame — called by Jetson to store proof photo URL
router.post('/frame', authenticateDevice, deviceIngestLimiter, asyncHandler(async (req, res) => {
  const { frameUrl, employeeId, date, type } = req.body;
  if (!frameUrl || !employeeId) return res.status(400).json({ message: 'frameUrl and employeeId required' });

  const tenantId = req.device?.tenant_id;
  if (!tenantId) return res.status(400).json({ message: 'tenant_id required in device token claims' });

  // PERF-0001 (N2): when marks are written async, the row may not exist yet — route
  // the frame-URL attach through the same worker/topic (keyed by employeeId, applied
  // after the mark) so the URL is never lost to the write-behind race.
  if (shouldWriteAsync(tenantId)) {
    const eventId = await publishFrameAttach({
      tenantId, employeeId, type,
      date: date || new Date().toISOString().slice(0, 10),
      frameUrl,
    });
    return res.status(202).json({ accepted: true, eventId });
  }

  const col = type === 'checkout' ? 'checkout_frame_url' : 'checkin_frame_url';
  await pool.query(
    `UPDATE attendance_record
     SET ${col} = $1, frame_url = COALESCE(frame_url, $1)
     WHERE fk_employee_id = $2
       AND attendance_date = $3
       AND tenant_id = $4`,
    [frameUrl, Number(employeeId), date || new Date().toISOString().slice(0, 10), tenantId]
  );
  return res.json({ ok: true });
}));

// POST /api/attendance/bulk-sync — called by Jetson/edge device to sync offline attendance records
router.post('/bulk-sync', authenticateDevice, deviceIngestLimiter, asyncHandler(async (req, res) => {
  const events = req.body.events || req.body.records || [];
  if (!Array.isArray(events)) {
    return res.status(400).json({ message: 'events or records must be an array' });
  }

  const tenantId = req.device?.tenant_id;
  if (!tenantId) {
    return res.status(400).json({ message: 'tenant_id required in device token claims' });
  }

  // Set the tenant header temporarily for writeAudit to capture it correctly
  req.headers['x-tenant-id'] = tenantId;

  const scope = {
    tenantId: tenantId,
    customerId: req.headers['x-customer-id'] ? String(req.headers['x-customer-id']) : undefined,
    siteId: req.headers['x-site-id'] ? String(req.headers['x-site-id']) : undefined,
  };

  // PERF-0001: async mode — publish ONE event per element (each keyed by its own
  // employeeId), return 202. The worker applies each via markAttendance.
  if (shouldWriteAsync(tenantId)) {
    const results = [];
    let enqueued = 0;
    for (const event of events) {
      const { employeeId, direction, trackId, deviceId, timestamp, confidence } = event;
      if (!employeeId || !direction) {
        results.push({ employeeId, success: false, error: 'employeeId and direction required' });
        continue;
      }
      const eventId = await publishAttendanceMark({
        employeeId: String(employeeId),
        deviceId: deviceId || req.device.external_device_id,
        timestamp: timestamp || new Date().toISOString(),
        confidence: confidence || 0,
        direction,
        trackId,
        scope,
      });
      results.push({ employeeId, success: true, eventId });
      enqueued++;
    }
    await writeAudit({
      req,
      action: 'device.bulk_sync',
      details: `Edge node enqueued ${enqueued}/${events.length} attendance events for async ingest`,
      source: 'device'
    }).catch(() => { });
    return res.status(202).json({ accepted: true, processed: events.length, enqueued, results });
  }

  const results = [];
  for (const event of events) {
    const { employeeId, direction, trackId, deviceId, timestamp, confidence } = event;
    if (!employeeId || !direction) {
      results.push({ employeeId, success: false, error: 'employeeId and direction required' });
      continue;
    }
    try {
      const record = await attendanceService.markAttendance({
        employeeId: String(employeeId),
        deviceId: deviceId || req.device.external_device_id,
        timestamp: timestamp || new Date().toISOString(),
        confidence: confidence || 0,
        direction,
        trackId,
        scope,
      });
      results.push({ employeeId, success: true, recordId: record?.pk_attendance_id });
    } catch (err) {
      logger.error(`[BulkSync] Failed to sync event for employee ${employeeId}:`, err.message);
      results.push({ employeeId, success: false, error: err.message });
    }
  }

  await writeAudit({
    req,
    action: 'device.bulk_sync',
    details: `Edge node bulk synced ${events.filter(e => e.employeeId).length} attendance events (Success: ${results.filter(r => r.success).length}, Failed: ${results.filter(r => !r.success).length})`,
    source: 'device'
  }).catch(() => { });

  return res.json({
    success: true,
    processed: events.length,
    syncedCount: results.filter(r => r.success).length,
    failedCount: results.filter(r => !r.success).length,
    results
  });
}));

// POST /api/attendance/direction — called by Jetson after direction is determined
router.post('/direction', authenticateDevice, deviceIngestLimiter, asyncHandler(async (req, res) => {
  const { employeeId, direction, trackId, deviceId, timestamp } = req.body;
  if (!employeeId || !direction)
    return res.status(400).json({ message: 'employeeId and direction required' });

  const tenantId = req.device?.tenant_id;
  if (!tenantId) return res.status(400).json({ message: 'tenant_id required in device token claims' });

  const ts = timestamp || new Date().toISOString();
  const scope = {
    tenantId: tenantId,
    customerId: req.headers['x-customer-id'] ? String(req.headers['x-customer-id']) : undefined,
    siteId: req.headers['x-site-id'] ? String(req.headers['x-site-id']) : undefined,
  };

  logger.info(`[Direction] employee=${employeeId} direction=${direction} track=${trackId} tenant=${tenantId}`);

  const mark = {
    employeeId: String(employeeId),
    deviceId,
    timestamp: ts,
    confidence: 0,
    direction,
    trackId,
    scope,
  };

  // PERF-0001: async mode — publish and return 202 (worker writes the row).
  if (shouldWriteAsync(tenantId)) {
    const eventId = await publishAttendanceMark(mark);
    return res.status(202).json({ accepted: true, direction, eventId });
  }

  const record = await attendanceService.markAttendance(mark);
  return res.json({ ok: true, direction, record });
}));

export { router as attendanceRoutes };
