import { query, pool } from "../../db/pool.js";
import { buildScopeWhere } from "../../repositories/scopeSql.js";
import { writeAudit } from "../../middleware/auditLog.js";
import logger from "../../utils/logger.js";
import * as storage from "../storageService.js";
import { sanitizeForKey, eventDateTimeParts, buildEventPhotoKey, buildEventPhotoFilename } from "../../utils/s3KeyBuilder.js";

// Visitor photos live in the logs bucket, tenant-UUID-rooted, alongside
// check-in/out photos (same folder convention as eventPhotoService.js) —
// requires a real, already-inserted personId, not the tenant's display name.
async function saveBase64Image(photoUrl, tenantId, personId, direction = 'in') {
  if (photoUrl && photoUrl.startsWith("data:image/")) {
    try {
      let base64Data = photoUrl;
      if (base64Data.includes(",")) {
        base64Data = base64Data.split(",")[1];
      }
      const safeId = sanitizeForKey(String(personId));
      const { dateStr, timeStr } = eventDateTimeParts();
      const filename = buildEventPhotoFilename({ kind: 'visitor', id: personId, dateStr, timeStr });
      const key = buildEventPhotoKey({ tenantId, kind: 'visitor', safeId, dateStr, direction, filename });
      await storage.uploadFile(storage.LOGS_BUCKET, key, Buffer.from(base64Data, "base64"), "image/jpeg");
      return key;
    } catch (err) {
      logger.error({ err }, "[PersonService] Failed to decode/upload visitor photo to S3");
    }
  }
  return photoUrl;
}

class PersonService {
  /**
   * List visitors and unknowns with optional filters.
   */
  async getAllPeople({ scope, limit = null, type, search, fromDate, toDate }) {
    // person only has tenant_id (no customer_id/site_id columns) — passing the
    // full scope would make buildScopeWhere emit a customer/site clause against
    // columns that don't exist ("column p.customer_id does not exist").
    const { whereSql, values } = buildScopeWhere({ tenantId: scope?.tenantId ?? null }, "p");
    let idx = values.length + 1;
    const filters = [whereSql];

    // Filter by type: 'visitor' or 'unknown'
    if (type && type !== "all") {
      filters.push(`p.person_type = $${idx++}`);
      values.push(type);
    }

    // Filter by search query (name, phone, email, organization, or person_id prefix)
    if (search) {
      filters.push(
        `(p.full_name ILIKE $${idx} OR p.phone ILIKE $${idx} OR p.email ILIKE $${idx} OR p.organization ILIKE $${idx} OR p.person_id::text ILIKE $${idx} OR ('UNK-' || p.person_id::text) ILIKE $${idx})`
      );
      values.push(`%${search}%`);
      idx++;
    }

    // Filter by date range (depending on type)
    if (fromDate) {
      filters.push(`p.created_at >= $${idx++}`);
      values.push(fromDate);
    }
    if (toDate) {
      filters.push(`p.created_at <= $${idx++}`);
      values.push(`${toDate} 23:59:59`);
    }

    let limitClause = "";
    if (limit && Number(limit) > 0) {
      limitClause = ` LIMIT $${idx++}`;
      values.push(Number(limit));
    }

    const sql = `
      SELECT p.*,
             COALESCE(
               pfe.photo_path,
               p.photo_url,
               de.photo_url,
               de.photo_path
             ) as photo_path,
             de.occurred_at as last_event_at
      FROM person p
      LEFT JOIN LATERAL (
        SELECT photo_path FROM person_face_embeddings pfe 
        WHERE pfe.person_id = p.person_id 
        ORDER BY created_at DESC LIMIT 1
      ) pfe ON true
      LEFT JOIN LATERAL (
        SELECT 
          de.occurred_at,
          de.payload_json->>'photo_url' as photo_url,
          de.payload_json->>'photo_path' as photo_path
        FROM device_events de 
        WHERE de.fk_person_id = p.person_id 
        ORDER BY de.occurred_at DESC LIMIT 1
      ) de ON true
      WHERE ${filters.join(" AND ")}
      ORDER BY p.updated_at DESC${limitClause}`;
    
    const res = await query(sql, values);
    return res.rows;
  }

  /**
   * Get person profile details by ID, including metrics, face gallery, and timelines.
   */
  async getPersonById({ personId, scope }) {
    // person only has tenant_id — see getAllPeople's comment above.
    const { whereSql, values } = buildScopeWhere({ tenantId: scope?.tenantId ?? null }, "p");
    const idIdx = values.length + 1;
    values.push(personId);

    const profileRes = await query(
      `SELECT p.* 
       FROM person p
       WHERE p.person_id = $${idIdx} AND ${whereSql}`,
      values
    );

    const profile = profileRes.rows[0];
    if (!profile) return null;

    // Fetch associated face embeddings
    const facesRes = await query(
      `SELECT id, photo_path, created_at
       FROM person_face_embeddings
       WHERE person_id = $1
       ORDER BY created_at DESC`,
      [personId]
    );

    // Fetch movement timeline from device_events
    const timelineRes = await query(
      `SELECT de.pk_event_id as id, de.occurred_at as timestamp, de.event_type, de.payload_json,
              d.device_name as camera_name, d.location_description as location
       FROM device_events de
       LEFT JOIN public.devices d ON d.pk_device_id = de.fk_device_id
       WHERE de.fk_person_id = $1 AND de.tenant_id = $2
       ORDER BY de.occurred_at DESC
       LIMIT 100`,
      [personId, scope.tenantId]
    );

    const timeline = timelineRes.rows.map(row => {
      const confidence = row.payload_json?.confidence ?? 0.85;
      return {
        id: row.id,
        timestamp: row.timestamp,
        cameraName: row.camera_name || "Unknown Camera",
        location: row.location || "Default Location",
        confidence: Number(confidence),
        photoUrl: row.payload_json?.photo_url || row.payload_json?.photo_path || null
      };
    });

    // Resolve host employee name if visitor
    let hostEmployeeName = null;
    if (profile.host_employee_id) {
      const hostRes = await query(
        `SELECT full_name FROM hr_employee WHERE pk_employee_id = $1`,
        [profile.host_employee_id]
      );
      hostEmployeeName = hostRes.rows[0]?.full_name ?? null;
    }

    return {
      profile: {
        personId: profile.person_id,
        name: profile.full_name,
        type: profile.person_type,
        status: profile.status,
        phone: profile.phone,
        email: profile.email,
        organization: profile.organization,
        designation: profile.designation,
        photoUrl: profile.photo_url || (timeline.length > 0 ? timeline[0].photoUrl : null),
        visitorDetails: profile.person_type === "visitor" ? {
          hostEmployeeName,
          hostEmployeeId: profile.host_employee_id,
          visitPurpose: profile.visit_purpose,
          validFrom: profile.valid_from,
          validTo: profile.valid_to,
          visitorType: profile.visitor_type
        } : null
      },
      metrics: {
        firstSeen: profile.first_seen || profile.created_at,
        lastSeen: profile.last_seen || profile.updated_at,
        visitCount: profile.visit_count ?? 1,
        lastCamera: timeline[0]?.cameraName ?? "N/A",
        riskScore: profile.risk_score ?? 0.0
      },
      timeline,
      faces: facesRes.rows.map(f => ({
        id: f.id,
        photoPath: f.photo_path ? (f.photo_path.startsWith("http") || f.photo_path.startsWith("/uploads") ? f.photo_path : `/api/jetson/photos/${f.photo_path.split("/").pop()}`) : null,
        createdAt: f.created_at
      }))
    };
  }

  /**
   * Create a new Visitor profile
   */
  async createVisitor({ scope, data }) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // photo key depends on person_id, which doesn't exist until after the
      // INSERT — store the raw value first (null if it's a data: URI awaiting
      // upload), then upload + UPDATE once the id is known.
      const isDataUri = data.photoUrl && data.photoUrl.startsWith("data:image/");

      const insertPersonSql = `
        INSERT INTO person(
          tenant_id, person_type, status, full_name, phone, email, organization, designation, photo_url,
          visitor_type, host_employee_id, visit_purpose, valid_from, valid_to
        ) VALUES ($1, 'visitor', 'active', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *`;

      const values = [
        scope.tenantId,
        data.fullName,
        data.phone || null,
        data.email || null,
        data.organization,
        data.designation || null,
        isDataUri ? null : (data.photoUrl || null),
        data.visitorType || "guest",
        data.hostEmployeeId ? Number(data.hostEmployeeId) : null,
        data.visitPurpose || null,
        data.validFrom,
        data.validTo
      ];

      const res = await client.query(insertPersonSql, values);
      const newPerson = res.rows[0];

      let savedPhotoUrl = newPerson.photo_url;
      if (isDataUri) {
        savedPhotoUrl = await saveBase64Image(data.photoUrl, scope.tenantId, newPerson.person_id);
        await client.query(`UPDATE person SET photo_url = $1 WHERE person_id = $2`, [savedPhotoUrl, newPerson.person_id]);
        newPerson.photo_url = savedPhotoUrl;
      }

      // If face embedding vector is supplied, save it
      if (data.embedding && Array.isArray(data.embedding)) {
        await client.query(
          `INSERT INTO person_face_embeddings (person_id, embedding, photo_path)
           VALUES ($1, $2::vector, $3)`,
          [newPerson.person_id, JSON.stringify(data.embedding), data.photoPath || savedPhotoUrl || null]
        );
      }

      await client.query("COMMIT");
      return newPerson;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Update Visitor details
   */
  async updateVisitor({ personId, patch, scope }) {
    // person only has tenant_id — see getAllPeople's comment above.
    const { whereSql, values } = buildScopeWhere({ tenantId: scope?.tenantId ?? null }, "", true);
    const fields = [];
    let idx = values.length + 1;

    const mapping = {
      fullName: "full_name",
      phone: "phone",
      email: "email",
      organization: "organization",
      designation: "designation",
      photoUrl: "photo_url",
      visitorType: "visitor_type",
      hostEmployeeId: "host_employee_id",
      visitPurpose: "visit_purpose",
      validFrom: "valid_from",
      validTo: "valid_to",
      status: "status"
    };

    for (let [k, v] of Object.entries(patch || {})) {
      const dbCol = mapping[k];
      if (dbCol) {
        fields.push(`${dbCol} = $${idx++}`);
        if (k === "photoUrl" && v) {
          v = await saveBase64Image(v, scope.tenantId, personId);
        }
        values.push(k === "hostEmployeeId" && v ? Number(v) : v);
      }
    }

    if (fields.length === 0) {
      return this.getPersonById({ personId, scope });
    }

    fields.push(`updated_at = NOW()`);

    const idIdx = idx;
    values.push(personId);

    const res = await query(
      `UPDATE person SET ${fields.join(", ")}
       WHERE person_id = $${idIdx} AND ${whereSql} AND person_type = 'visitor'
       RETURNING *`,
      values
    );

    return res.rows[0] || null;
  }

  /**
   * Convert an existing Unknown Person profile into a Visitor profile.
   */
  async convertUnknownToVisitor({ personId, data, scope }) {
    // person only has tenant_id — see getAllPeople's comment above.
    const { whereSql, values } = buildScopeWhere({ tenantId: scope?.tenantId ?? null }, "", true);
    const idIdx = values.length + 1;
    values.push(personId);

    // Verify first if person exists and is an unknown type
    const checkRes = await query(
      `SELECT person_id FROM person WHERE person_id = $${idIdx} AND ${whereSql} AND person_type = 'unknown'`,
      values
    );
    if (!checkRes.rows.length) {
      const err = new Error("Unknown person not found");
      err.statusCode = 404;
      throw err;
    }

    const updateSql = `
      UPDATE person 
      SET 
        person_type = 'visitor',
        full_name = $1,
        phone = $2,
        email = $3,
        organization = $4,
        designation = $5,
        visitor_type = $6,
        host_employee_id = $7,
        visit_purpose = $8,
        valid_from = $9,
        valid_to = $10,
        updated_at = NOW()
      WHERE person_id = $11
      RETURNING *`;

    const updateValues = [
      data.fullName,
      data.phone || null,
      data.email || null,
      data.organization,
      data.designation || null,
      data.visitorType || "guest",
      data.hostEmployeeId ? Number(data.hostEmployeeId) : null,
      data.visitPurpose || null,
      data.validFrom,
      data.validTo,
      personId
    ];

    const res = await query(updateSql, updateValues);
    return res.rows[0] || null;
  }

  /**
   * Archive / Delete a person (both visitors & unknowns)
   */
  async deletePerson({ personId, scope }) {
    // person only has tenant_id — see getAllPeople's comment above.
    const { whereSql, values } = buildScopeWhere({ tenantId: scope?.tenantId ?? null }, "", true);
    const idIdx = values.length + 1;
    values.push(personId);

    const checkRes = await query(
      `SELECT person_id FROM person WHERE person_id = $${idIdx} AND ${whereSql}`,
      values
    );
    if (!checkRes.rows.length) {
      const err = new Error("Person not found");
      err.statusCode = 404;
      throw err;
    }

    // We do a hard delete which cascades to person_face_embeddings.
    // timeline events (device_events.fk_person_id) are set to NULL automatically by constraint.
    await query(
      `DELETE FROM person WHERE person_id = $${idIdx} AND ${whereSql}`,
      values
    );

    return { success: true };
  }
}

const personService = new PersonService();
export default personService;
