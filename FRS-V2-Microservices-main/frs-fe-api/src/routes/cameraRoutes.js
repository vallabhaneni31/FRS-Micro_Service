import express from 'express';
import { requireAuth, requirePermission } from '../middleware/authz.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { pool } from '../db/pool.js';
import { spawn } from 'child_process';
import fs from 'fs';
import { validateIp } from '../utils/validateIp.js';
import { validateBody } from '../validators/schemas.js';
import { registerCameraSchema, systemConfigSchema, cameraStatusSchema } from '../validators/cameraSchemas.js';

const router = express.Router();

// NOTE (frs-fe-api split): the device-facing routes formerly here —
// POST /:camId/heartbeat, GET / (authenticateDeviceOptional device-sync
// variant), POST /device-sync — were device-JWT (`authenticateDevice`)
// endpoints and now live in frs-edge-api. Only the human/`requireAuth`
// admin routes remain in this repo.

router.use((req, res, next) => {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
});

router.use(requireAuth);

/**
 * UNIFIED CAMERA & FACILITY DEVICE ROUTE
 * Queries 'facility_device' (with category check against 'camera')
 */

// 1. GET ALL CAMERAS (WITH LIVE TELEMETRY)
router.get('/', requirePermission('devices.read'), asyncHandler(async (req, res) => {
    const memberships = req.auth?.memberships || [];
    const isSuperAdmin = memberships.some(m => m.scope.tenantId === null);
    const tenantId = req.auth?.scope?.tenantId;

    let queryText = `
        SELECT
            fd.pk_device_id AS id,
            fd.external_device_id AS code,
            fd.name AS name,
            fd.ip_address::text AS "ipAddress",
            fd.status,
            fd.total_scans AS "total_scans",
            fd.recognition_accuracy AS "recognition_accuracy",
            fd.last_active AS "last_active",
            fd.device_config AS config,
            fd.location_label AS location
        FROM facility_device fd
        LEFT JOIN device_type dt ON fd.device_type_id = dt.pk_device_type_id
        WHERE dt.category = 'camera'
    `;
    const params = [];

    if (!isSuperAdmin) {
        if (!tenantId) {
            return res.status(400).json({ error: 'Tenant context required' });
        }
        queryText += ` AND fd.tenant_id = $1::uuid`;
        params.push(tenantId);
    }

    queryText += ` ORDER BY fd.name`;

    const { rows } = await pool.query(queryText, params);

    return res.json({ data: rows });
}));

// 2. REGISTER NEW ASSET (SYNCED TO BOTH TABLES)
router.post('/', requirePermission('devices.write'), validateBody(registerCameraSchema), asyncHandler(async (req, res) => {
    const { code, name, ipAddress, location, role } = req.validatedBody;

    // SECURITY FIX: Get tenant from auth token
    const tenantId = req.auth?.scope?.tenantId;
    if (!tenantId) {
        return res.status(401).json({ error: 'Tenant ID not found in token' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Resolve device type for camera
        const typeRes = await client.query(
            "SELECT pk_device_type_id FROM device_type WHERE category = 'camera' LIMIT 1"
        );
        const typeId = typeRes.rows[0]?.pk_device_type_id || null;

        // Insert into facility_device (Live Table)
        const devRes = await client.query(
            `INSERT INTO facility_device (
                tenant_id, external_device_id, name, location_label, ip_address,
                device_type_id, status, device_config
             ) VALUES ($1, $2, $3, $4, $5, $6, 'offline', $7) RETURNING pk_device_id`,
            [tenantId, code, name, location || 'Not set', ipAddress, typeId, JSON.stringify({ role: role || 'entry' })]
        );

        await client.query('COMMIT');
        res.status(201).json({ success: true, id: devRes.rows[0].pk_device_id });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(500).json({ message: e.message });
    } finally {
        client.release();
    }
}));

// 3. PING / TEST (FIXED ID RESOLUTION)
router.post('/:id/test', requirePermission('devices.read'), asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Check if ID is numeric or a code
    const query = isNaN(id)
        ? "SELECT ip_address, device_config AS config_json FROM facility_device WHERE external_device_id = $1"
        : "SELECT ip_address, device_config AS config_json FROM facility_device WHERE pk_device_id = $1";

    const { rows } = await pool.query(query, [id]);
    if (!rows.length) return res.status(404).json({ message: 'Device not found' });

    const ip = rows[0].ip_address;
    if (!ip) return res.status(422).json({ reachable: false, message: 'No IP configured' });

    if (!validateIp(ip)) {
        return res.status(422).json({ reachable: false, message: 'Invalid IP address format' });
    }

    // Actual Network Probe (ICMP Ping)
    const { execFile } = await import('child_process');
    execFile('ping', ['-c', '1', '-W', '2', ip], (err) => {
        res.json({ reachable: !err, message: !err ? 'Host Alive' : 'Host Unreachable' });
    });
}));

// 4. NEW: SAVE GLOBAL AI CONFIG (THRESHOLD & COOLDOWN)
router.post('/system-config', requirePermission('devices.write'), validateBody(systemConfigSchema), asyncHandler(async (req, res) => {
    const { threshold, cooldown } = req.validatedBody;

    // We update the device_config of all active cameras to propagate the setting
    await pool.query(`
        UPDATE facility_device fd
        SET device_config = device_config || jsonb_build_object('threshold', $1::numeric, 'cooldown', $2::int)
        FROM device_type dt
        WHERE fd.device_type_id = dt.pk_device_type_id AND dt.category = 'camera'
    `, [threshold, cooldown]);

    res.json({ success: true, message: 'Settings deployed to all edge nodes' });
}));

// 5. STATUS TOGGLE (FIXED TO SYNC BOTH TABLES)
router.patch('/:code/status', requirePermission('devices.write'), validateBody(cameraStatusSchema), asyncHandler(async (req, res) => {
    const { code } = req.params;
    const { status } = req.validatedBody;

    await pool.query("UPDATE facility_device SET status = $1 WHERE external_device_id = $2", [status, code]);

    res.json({ success: true });
}));

// 6. MJPEG LIVE STREAM (PROXY RTSP VIA FFMPEG)
router.get('/:id/stream', asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Tenant isolation verification
    const isSuperAdmin = req.auth?.memberships?.some(m => m.role === 'super_admin');
    if (!isSuperAdmin) {
        const tenantId = req.auth?.scope?.tenantId;
        if (!tenantId) {
            return res.status(403).json({ message: 'Forbidden: Tenant context missing' });
        }

        const ownershipCheck = await pool.query(`
            SELECT 1
            FROM frs_camera c
            LEFT JOIN frs_nug_box n ON n.pk_nug_id = c.fk_nug_id
            LEFT JOIN frs_floor f ON f.pk_floor_id = c.fk_floor_id
            LEFT JOIN frs_building b ON b.pk_building_id = f.fk_building_id
            JOIN frs_site s ON s.pk_site_id = COALESCE(n.fk_site_id, b.fk_site_id)
            JOIN frs_customer cu ON cu.pk_customer_id = s.fk_customer_id
            WHERE (c.pk_camera_id = $1 OR c.cam_id = $2) AND cu.fk_tenant_id = $3::uuid
        `, [isNaN(id) ? null : Number(id), isNaN(id) ? id : null, tenantId]);

        if (!ownershipCheck.rows.length) {
            return res.status(403).json({ message: 'Forbidden: Camera does not belong to your tenant' });
        }
    }
    const query = isNaN(id)
        ? "SELECT * FROM frs_camera WHERE cam_id = $1"
        : "SELECT * FROM frs_camera WHERE pk_camera_id = $1";

    const { rows } = await pool.query(query, [id]);
    if (!rows.length) return res.status(404).json({ message: 'Camera not found' });

    const camera = rows[0];
    if (!camera.rtsp_url) return res.status(400).json({ message: 'RTSP URL not configured' });

    // Stream Setup
    const boundary = 'mjpegboundary';
    res.writeHead(200, {
        'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const ffmpegProc = spawn('ffmpeg', [
        '-loglevel', 'error',
        '-rtsp_transport', 'tcp',
        '-i', camera.rtsp_url,
        '-f', 'mjpeg',
        '-q:v', '5',
        '-r', '10',
        '-vf', 'scale=1280:-1',
        'pipe:1'
    ]);

    let alive = true;
    ffmpegProc.stdout.on('data', (chunk) => {
        if (!alive) return;
        try {
            res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${chunk.length}\r\n\r\n`);
            res.write(chunk);
            res.write('\r\n');
        } catch (e) {
            alive = false;
            ffmpegProc.kill('SIGTERM');
        }
    });

    const cleanup = () => {
        alive = false;
        ffmpegProc.kill('SIGKILL');
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
    ffmpegProc.on('error', cleanup);
}));

// 7. CAPTURE TEST FRAME
router.post('/:id/capture-frame', requirePermission('devices.read'), asyncHandler(async (req, res) => {
    const { id } = req.params;
    const query = isNaN(id)
        ? "SELECT rtsp_url FROM frs_camera WHERE cam_id = $1"
        : "SELECT rtsp_url FROM frs_camera WHERE pk_camera_id = $1";

    const { rows } = await pool.query(query, [id]);
    if (!rows.length || !rows[0].rtsp_url) return res.status(404).json({ message: 'Camera or RTSP URL not found' });

    const tempFile = `/tmp/snap_${id}_${Date.now()}.jpg`;

    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    try {
        await execFileAsync('ffmpeg', [
            '-y', '-rtsp_transport', 'tcp',
            '-i', rows[0].rtsp_url,
            '-frames:v', '1',
            '-q:v', '2',
            tempFile
        ], { timeout: 10000 });

        const imageBuffer = fs.readFileSync(tempFile);
        const base64Image = imageBuffer.toString('base64');
        fs.unlinkSync(tempFile);

        res.json({ success: true, image: `data:image/jpeg;base64,${base64Image}` });
    } catch (e) {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        res.status(500).json({ error: 'Frame capture failed', details: e.message });
    }
}));

export { router as cameraRoutes };
