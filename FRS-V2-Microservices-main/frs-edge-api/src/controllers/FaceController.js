import { z } from "zod";
import faceDB from "../core/db/FaceDB.js";
import { pool } from "../db/pool.js";
import { uploadEventPhoto } from "../services/business/eventPhotoService.js";

// pgvector-based face matching — searches ALL embeddings per employee
async function findBestMatchPgvector(embedding, threshold = 0.45, modelVersion = null) {
  const vectorStr = `[${embedding.join(",")}]`;
  let queryText = `
    SELECT 
      ef.employee_id,
      ef.id as face_id,
      1 - (ef.embedding <=> $1::vector) as similarity,
      e.full_name,
      e.employee_code,
      e.tenant_id
    FROM employee_face_embeddings ef
    JOIN hr_employee e ON e.pk_employee_id = ef.employee_id
    WHERE 1 - (ef.embedding <=> $1::vector) >= $2
  `;
  const params = [vectorStr, threshold];
  if (modelVersion) {
    queryText += ` AND ef.model_version = $3`;
    params.push(modelVersion);
  }
  queryText += `
    ORDER BY ef.embedding <=> $1::vector ASC
    LIMIT 1
  `;
  const { rows } = await pool.query(queryText, params);
  if (!rows.length) return null;
  return {
    faceId: rows[0].face_id,
    similarity: parseFloat(rows[0].similarity),
    metadata: {
      employeeId: String(rows[0].employee_id),
      fullName: rows[0].full_name,
      employeeCode: rows[0].employee_code,
    }
  };
}
import visitorDB from "../core/db/VisitorDB.js";
import attendanceService from "../services/business/AttendanceService.js";
import kafkaEventService from "../core/kafka/KafkaEventService.js";
import uploadSnapshotPushService from "../core/services/UploadSnapshotPushService.js";
import edgeAIClient from "../core/clients/EdgeAIClient.js";
import { writeAudit } from "../middleware/auditLog.js";
import logger from '../utils/logger.js';
import { resolveDeviceCodeAlias } from '../config/deviceCodeAliases.js';

async function getOrCreateDeviceUuid(deviceCode) {
  if (!deviceCode) return null;
  deviceCode = resolveDeviceCodeAlias(deviceCode);
  try {
    const { rows } = await pool.query(
      'SELECT pk_device_id FROM devices WHERE device_code = $1 LIMIT 1',
      [deviceCode]
    );
    if (rows.length) {
      return rows[0].pk_device_id;
    }
    const insertDev = await pool.query(
      `INSERT INTO devices (device_code, device_name, status)
       VALUES ($1, $1, 'online')
       RETURNING pk_device_id`,
      [deviceCode]
    );
    return insertDev.rows[0]?.pk_device_id || null;
  } catch (err) {
    logger.error({ err, deviceCode }, '[FaceController] Failed to get or create device UUID');
    return null;
  }
}

const FaceController = {
  async registerFace(req, res) {
    const parsed = z.object({ embedding: z.array(z.number()), metadata: z.any().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "invalid payload" });
    const id = await faceDB.addFace(parsed.data.embedding, parsed.data.metadata || {});
    return res.status(201).json({ id });
  },
  async batchRegisterFaces(req, res) {
    const parsed = z.object({ faces: z.array(z.object({ id: z.string().optional(), embedding: z.array(z.number()), metadata: z.any().optional() })) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "invalid payload" });
    await faceDB.batchUpsert(parsed.data.faces.map(f => ({ id: f.id, embedding: f.embedding, metadata: f.metadata })));
    return res.json({ count: parsed.data.faces.length });
  },
  async getEmployeeFaces(_req, res) {
    return res.json({ faces: [] });
  },
  async getFaceDetails(_req, res) {
    return res.json({ face: null });
  },
  async updateFace(_req, res) {
    return res.json({ ok: true });
  },
  async deleteFace(req, res) {
    const id = String(req.params.id);
    await faceDB.deleteFace(id);
    return res.json({ success: true });
  },
  async verifyFace(req, res) {
    const parsed = z.object({ embedding: z.array(z.number()) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "invalid payload" });
    const match = await faceDB.findBestMatch(parsed.data.embedding);
    return res.json({ match });
  },
  async recognizeAndMark(req, res) {
    // Inside recognizeAndMark(req, res)
    logger.debug('[FaceController] --- RECOGNITION START ---');
    logger.debug({ body: req.body }, '[FaceController] request body');
    logger.debug({ tenantId: req.auth?.scope?.tenantId }, '[FaceController] tenant from token');
    let embedding  = null;
    let confidence = 0;
    const deviceId  = req.body?.deviceId  || null;
    const timestamp = req.body?.timestamp || null;
    const deviceCode = deviceId || req.device?.code || req.device?.external_device_id || null;
    const deviceUuid = await getOrCreateDeviceUuid(deviceCode);

    // Decode crop frame if sent by Jetson client — kept in memory only. The
    // S3 key depends on the matched/new person's id, which isn't known yet,
    // so upload happens further down once that id is resolved (see the
    // personMatch / new-unknown-person branches below).
    let frameBuffer = null;
    if (req.body?.frame) {
      try {
        let base64Data = req.body.frame;
        if (base64Data.includes(',')) {
          base64Data = base64Data.split(',')[1];
        }
        frameBuffer = Buffer.from(base64Data, 'base64');
      } catch (err) {
        logger.error({ err }, '[FaceController] Failed to decode frame base64');
      }
    }

    // ── PATH A: Embedding already in JSON body (sent by Jetson runner.py)
    // FAST PATH — zero EdgeAI calls. Camera ran YOLO+ArcFace locally.
    if (Array.isArray(req.body?.embedding) && req.body.embedding.length === 512) {
      embedding  = req.body.embedding;
      confidence = Number(req.body.confidence || 0);

    // ── PATH B: Image URL (external webhooks, manual API tests)
    } else if (req.body?.imageUrl) {
      let ai;
      try {
        ai = await edgeAIClient.recognizeByUrl(req.body.imageUrl, { source: 'webhook' });
      } catch (e) {
        return res.status(503).json({ message: 'EdgeAI sidecar unavailable: ' + e.message });
      }
      if (!ai?.embedding?.length) return res.status(404).json({ message: 'No face detected in image URL' });
      embedding = ai.embedding; confidence = ai.confidence || 0;

    // ── PATH C: File upload (HR admin test UI only)
    // WARNING: camera service MUST NOT use this path — causes double inference.
    } else if (req.file?.buffer) {
      let ai;
      try {
        ai = await edgeAIClient.recognizeImageBuffer(req.file.buffer, { source: 'manual-upload' });
      } catch (e) {
        return res.status(503).json({ message: 'EdgeAI sidecar unavailable: ' + e.message });
      }
      if (!ai?.embedding?.length) return res.status(404).json({ message: 'No face detected in uploaded image' });
      embedding = ai.embedding; confidence = ai.confidence || 0;

    } else {
      return res.status(400).json({
        message: 'Provide embedding (512-element array), imageUrl (string), or image (multipart file)',
      });
    }

    // ── DB MATCH: embedding → employee (same for all 3 paths)
    // Use pgvector for matching (fast, multi-embedding, GPU-optimized)
    let modelVersion = null;
    if (deviceId) {
      const { rows: devRows } = await pool.query(
        `SELECT device_config FROM facility_device WHERE external_device_id = $1 LIMIT 1`,
        [deviceId]
      );
      if (devRows.length) {
        modelVersion = devRows[0].device_config?.embedding_model || null;
      }
    }
    const match = await findBestMatchPgvector(embedding, 0.42, modelVersion);
    
    // Resolve tenant ID
    const tenantId = req.device?.tenant_id || req.headers['x-tenant-id'] || req.auth?.scope?.tenantId || null;

    if (!match) {
      if (!tenantId) {
        return res.status(400).json({ message: "Tenant scope required for fallback unknown matching" });
      }

      // Query person_face_embeddings (pgvector search at stricter threshold 0.55)
      const vectorStr = `[${embedding.join(",")}]`;
      const personRes = await pool.query(
        `SELECT 
           p.person_id, 
           p.person_type, 
           p.full_name,
           1 - (pfe.embedding <=> $1::vector) AS similarity
         FROM person_face_embeddings pfe
         JOIN person p ON p.person_id = pfe.person_id
         WHERE p.tenant_id = $2::uuid AND 1 - (pfe.embedding <=> $1::vector) >= $3
         ORDER BY pfe.embedding <=> $1::vector ASC
         LIMIT 1`,
        [vectorStr, tenantId, 0.55]
      );

      const personMatch = personRes.rows[0] || null;

      if (personMatch) {
        const personId = personMatch.person_id;
        const personType = personMatch.person_type;

        // If unknown, increment visit count and update timestamps
        if (personType === 'unknown') {
          await pool.query(
            `UPDATE person
             SET visit_count = visit_count + 1, last_seen = NOW(), updated_at = NOW()
             WHERE person_id = $1`,
            [personId]
          );
        }

        // personId is known now — safe to upload the S3 key requires it
        let photoUrl = null;
        if (frameBuffer && tenantId) {
          try {
            photoUrl = await uploadEventPhoto({
              tenantId, eventType: 'face.recognized',
              payload: { event_time: timestamp, visitor_id: personId },
              buffer: frameBuffer, direction: 'in',
            });
          } catch (err) {
            logger.error({ err }, '[FaceController] Failed to upload recognition photo to S3');
          }
        }

        // Insert FACE_DETECTED event in device_events
        await pool.query(
          `INSERT INTO device_events (
            fk_device_id,
            event_type,
            occurred_at,
            payload_json,
            detected_face_embedding,
            confidence_score,
            tenant_id,
            fk_person_id,
            processing_status
          ) VALUES ($1, 'FACE_DETECTED', $2, $3, $4, $5, $6, $7, 'completed')`,
          [
            deviceUuid,
            timestamp || new Date().toISOString(),
            JSON.stringify({ person_type: personType, matched: true, similarity: personMatch.similarity, photo_url: photoUrl }),
            JSON.stringify(embedding),
            confidence,
            tenantId,
            personId
          ]
        );

        // Publish to Kafka (non-fatal)
        kafkaEventService.publishEvent({
          type: 'PERSON_RECOGNIZED',
          personId,
          personType,
          similarity: personMatch.similarity,
          confidence,
          deviceId,
          timestamp: timestamp || new Date().toISOString()
        }).catch(() => {});

        return res.json({
          result: {
            personId,
            fullName: personMatch.full_name,
            personType,
            similarity: personMatch.similarity,
            confidence,
            matched: true
          }
        });
      }

      // No match found — Register a new Unknown Person!
      const label = req.body.person_type === 'visitor' ? 'Visitor' : 'Unknown Person';
      const insertPersonSql = `
        INSERT INTO person (
          tenant_id, person_type, status, full_name, first_seen, last_seen, visit_count, risk_score
        ) VALUES ($1, 'unknown', 'active', $2, NOW(), NOW(), 1, 0.0)
        RETURNING person_id`;
      
      const newPersonRes = await pool.query(insertPersonSql, [tenantId, label]);
      const newPersonId = newPersonRes.rows[0].person_id;

      // newPersonId is known now — safe to upload the S3 key requires it
      let photoUrl = null;
      if (frameBuffer) {
        try {
          photoUrl = await uploadEventPhoto({
            tenantId, eventType: 'face.unknown',
            payload: { event_time: timestamp, visitor_id: newPersonId },
            buffer: frameBuffer, direction: 'in',
          });
        } catch (err) {
          logger.error({ err }, '[FaceController] Failed to upload unknown-face photo to S3');
        }
      }

      // Save new unknown face embedding with the photo_path
      await pool.query(
        `INSERT INTO person_face_embeddings (person_id, embedding, photo_path)
         VALUES ($1, $2::vector, $3)`,
        [newPersonId, vectorStr, photoUrl]
      );

      // Record detection event in device_events
      await pool.query(
        `INSERT INTO device_events (
          fk_device_id,
          event_type,
          occurred_at,
          payload_json,
          detected_face_embedding,
          confidence_score,
          tenant_id,
          fk_person_id,
          processing_status
        ) VALUES ($1, 'FACE_DETECTED', $2, $3, $4, $5, $6, $7, 'completed')`,
        [
          deviceUuid,
          timestamp || new Date().toISOString(),
          JSON.stringify({ person_type: 'unknown', matched: false, photo_url: photoUrl }),
          JSON.stringify(embedding),
          confidence,
          tenantId,
          newPersonId
        ]
      );

      // Publish to Kafka (non-fatal)
      kafkaEventService.publishEvent({
        type: 'UNKNOWN_FACE_DETECTED',
        deviceId,
        confidence,
        timestamp: timestamp || new Date().toISOString()
      }).catch(() => {});

      return res.json({
        result: {
          personId: newPersonId,
          fullName: label,
          personType: "unknown",
          similarity: 0.0,
          confidence,
          matched: false
        }
      });
    }


    const employeeId = match.metadata?.employeeId;
    if (!employeeId) {
      return res.status(404).json({ message: 'Face matched but employee mapping is missing — re-enroll this face' });
    }

    // ── MARK ATTENDANCE
    const direction = req.body?.direction || req.body?.trackDirection || '';
    const trackId   = req.body?.trackId    || req.body?.track_id       || '';
    logger.debug({ direction, trackId, employeeId }, '[FaceController] recognition result');

    const record = await attendanceService.markAttendance({
      employeeId: String(employeeId),
      deviceId,
      timestamp,
      confidence,
      direction,
      trackId,
      scope: {
        tenantId:   String(req.headers['x-tenant-id']   || req.auth?.scope?.tenantId   || '1'),
        customerId: req.headers['x-customer-id'] ? String(req.headers['x-customer-id']) : (req.auth?.scope?.customerId || undefined),
        siteId:     req.headers['x-site-id']     ? String(req.headers['x-site-id'])     : (req.auth?.scope?.siteId || undefined),
        unitId:     req.headers['x-unit-id']     ? String(req.headers['x-unit-id'])     : (req.auth?.scope?.unitId || undefined),
      },
    });

    // ── PUBLISH TO KAFKA (non-fatal)
    kafkaEventService.publishEvent({
      type: 'FACE_RECOGNIZED',
      employeeId,
      similarity:  match.similarity,
      confidence,
      deviceId,
      timestamp:   new Date().toISOString(),
    }).catch(() => {});

    await writeAudit({ req, action: 'attendance.mark',
      details: `Attendance marked: ${match.metadata?.fullName || employeeId} via device ${deviceId || 'unknown'} (sim=${match.similarity?.toFixed(3)})`,
      entityType: 'employee', entityId: employeeId, entityName: match.metadata?.fullName,
      after: { direction, confidence, similarity: match.similarity, deviceId },
      source: 'device'
    });
    return res.json({
      result: {
        employeeId,
        fullName:   match.metadata?.fullName,
        similarity: match.similarity,
        confidence,
        faceId:     match.faceId,
      },
      record,
    });
  },
  async verifyMultipleFaces(req, res) {
    const parsed = z.object({ embeddings: z.array(z.array(z.number())) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "invalid payload" });
    const out = [];
    for (const e of parsed.data.embeddings) {
      // eslint-disable-next-line no-await-in-loop
      const m = await faceDB.findBestMatch(e);
      out.push(m);
    }
    return res.json({ results: out });
  },
  async searchFaces(req, res) {
    const parsed = z.object({ embedding: z.array(z.number()) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "invalid payload" });
    const match = await faceDB.findBestMatch(parsed.data.embedding);
    return res.json({ match });
  },
  async searchByEmbedding(req, res) {
    const parsed = z.object({ embedding: z.array(z.number()) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "invalid payload" });
    const match = await faceDB.findBestMatch(parsed.data.embedding);
    return res.json({ match });
  },
  async uploadSnapshot(req, res) {
    if (!uploadSnapshotPushService.running) {
      await uploadSnapshotPushService.initialize();
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ message: "snapshot file required" });
    }
    const jobId = uploadSnapshotPushService.enqueue({
      data: req.file.buffer,
      metadata: {
        uploader: req.auth?.user?.email || "api",
      },
    });
    return res.status(202).json({ jobId });
  },
  async getFaceGroups(_req, res) {
    return res.json({ groups: [] });
  },
  async createFaceGroup(_req, res) {
    return res.status(201).json({ ok: true });
  },
  async updateFaceGroup(_req, res) {
    return res.json({ ok: true });
  },
  async deleteFaceGroup(_req, res) {
    return res.json({ ok: true });
  },
  async addFacesToGroup(_req, res) {
    return res.json({ ok: true });
  },
  async removeFacesFromGroup(_req, res) {
    return res.json({ ok: true });
  },
  async getFaceStats(_req, res) {
    const stats = await faceDB.getStats();
    return res.json(stats);
  },
  async getMatchStats(_req, res) {
    return res.json({ known: 0, unknown: 0 });
  },
  async getVisitors(_req, res) {
    const list = await visitorDB.getKnownVisitors();
    return res.json({ visitors: list });
  },
  async getVisitorDetails(_req, res) {
    return res.json({ visitor: null });
  },
  async blacklistVisitor(_req, res) {
    return res.json({ ok: true });
  },
};

export default FaceController;

