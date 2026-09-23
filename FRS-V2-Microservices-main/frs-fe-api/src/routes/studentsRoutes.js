/**
 * studentsRoutes.js — Edu Tier 1 student CRUD
 *
 * GET    /api/students            list students (scoped to tenant subtree)
 * POST   /api/students            create student
 * GET    /api/students/:id        single student
 * PUT    /api/students/:id        update student
 * DELETE /api/students/:id        soft-delete student
 *
 * Auth: requireAuth + requireScope (uses Phase 3 menu-anchored scopes from req.auth.mt).
 * Scope filter: tenant subtree via tenant_descendants(jwt.tenant_id).
 */
import express from 'express';
import { requireAuth, requireScope } from '../middleware/authz.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { pool } from '../db/pool.js';
import logger from '../utils/logger.js';

const router = express.Router();
router.use(requireAuth);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return the list of tenant UUIDs the current request can access.
 * - super_admin → null (no filter, global)
 * - normal user → JWT tenant + all descendants (so a customer-level admin
 *                 sees students at sites and units beneath it)
 */
async function getScopedTenantIds(req) {
  const mt = req.auth?.mt;
  if (mt?.isSuperAdmin) return null;
  const root = req.auth?.jwtPayload?.tenant_id || mt?.homeTenantId;
  if (!root) return [];
  const { rows } = await pool.query(
    `SELECT t.pk_tenant_id
       FROM tenants t
      WHERE t.status = 'active'
        AND t.hierarchy_path LIKE (
          SELECT hierarchy_path FROM tenants WHERE pk_tenant_id = $1
        ) || '%'`,
    [root]
  );
  return rows.map(r => r.pk_tenant_id);
}

function pickTenantForCreate(req) {
  return req.auth?.jwtPayload?.tenant_id || req.auth?.mt?.homeTenantId || null;
}

/** Verify the row's tenant is reachable from the current user. Returns the row or null. */
async function getStudentInScope(id, tenantIds) {
  if (!id) return null;
  if (tenantIds === null) {
    const { rows } = await pool.query(
      `SELECT * FROM edu_student WHERE pk_student_id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return rows[0] || null;
  }
  if (tenantIds.length === 0) return null;
  const { rows } = await pool.query(
    `SELECT * FROM edu_student
      WHERE pk_student_id = $1
        AND fk_tenant_id = ANY($2::uuid[])
        AND deleted_at IS NULL`,
    [id, tenantIds]
  );
  return rows[0] || null;
}

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/students
 * Optional query: ?class_label=10A&section=A&grade=10&q=name-prefix
 */
router.get('/', requireScope('students.list.read'), asyncHandler(async (req, res) => {
  const tenantIds = await getScopedTenantIds(req);

  // Columns are qualified with the edu_student alias `s` because the query
  // joins `tenants t`, which shares column names (deleted_at, name, …) and
  // would otherwise make the references ambiguous.
  const clauses = [`s.is_active = true`, `s.deleted_at IS NULL`];
  const params = [];
  if (tenantIds !== null) {
    if (tenantIds.length === 0) return res.json({ students: [] });
    params.push(tenantIds);
    clauses.push(`s.fk_tenant_id = ANY($${params.length}::uuid[])`);
  }
  if (req.query.class_label) { params.push(String(req.query.class_label)); clauses.push(`s.class_label = $${params.length}`); }
  if (req.query.section)     { params.push(String(req.query.section));     clauses.push(`s.section     = $${params.length}`); }
  if (req.query.grade)       { params.push(String(req.query.grade));       clauses.push(`s.grade       = $${params.length}`); }
  if (req.query.q) {
    params.push(`${String(req.query.q).toLowerCase()}%`);
    clauses.push(`(LOWER(s.first_name) LIKE $${params.length} OR LOWER(s.last_name) LIKE $${params.length} OR LOWER(s.roll_number) LIKE $${params.length})`);
  }

  const { rows } = await pool.query(
    `SELECT s.pk_student_id, s.fk_tenant_id, s.roll_number, s.admission_number,
            s.first_name, s.last_name, s.email, s.phone,
            s.class_label, s.section, s.grade, s.dob, s.gender, s.admission_date,
            s.parent_name, s.parent_phone, s.parent_email, s.photo_path,
            s.is_active, s.created_at, s.updated_at,
            t.name AS tenant_name,
            EXISTS (SELECT 1 FROM edu_student_face_embedding e
                     WHERE e.fk_student_id = s.pk_student_id) AS face_enrolled
       FROM edu_student s
       JOIN tenants t ON t.pk_tenant_id = s.fk_tenant_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY s.created_at DESC
      LIMIT 500`,
    params
  );
  res.json({ students: rows });
}));

/**
 * GET /api/students/workspace-tree
 * Aggregated Class hierarchy for the Workspace tree: School -> Class (class_label + section) -> Students.
 * Grouped server-side (not client-side over the capped /students list, which truncates at LIMIT 500).
 * Must be registered before GET /:id so "workspace-tree" isn't swallowed as a student id.
 */
router.get('/workspace-tree', requireScope('students.list.read'), asyncHandler(async (req, res) => {
  const tenantIds = await getScopedTenantIds(req);

  const clauses = [`s.is_active = true`, `s.deleted_at IS NULL`];
  const params = [];
  if (tenantIds !== null) {
    if (tenantIds.length === 0) return res.json({ school: { studentCount: 0 }, classes: [] });
    params.push(tenantIds);
    clauses.push(`s.fk_tenant_id = ANY($${params.length}::uuid[])`);
  }

  const { rows } = await pool.query(
    `SELECT s.class_label, s.section, count(*)::int AS student_count
       FROM edu_student s
      WHERE ${clauses.join(' AND ')}
      GROUP BY s.class_label, s.section
      ORDER BY s.class_label, s.section`,
    params
  );
  const total = rows.reduce((sum, r) => sum + r.student_count, 0);
  res.json({ school: { studentCount: total }, classes: rows });
}));

/**
 * GET /api/students/:id
 */
router.get('/:id', requireScope('students.profile.read'), asyncHandler(async (req, res) => {
  const tenantIds = await getScopedTenantIds(req);
  const student = await getStudentInScope(req.params.id, tenantIds);
  if (!student) return res.status(404).json({ message: 'student not found' });
  res.json({ student });
}));

/**
 * POST /api/students
 */
router.post('/', requireScope('students.list.write'), asyncHandler(async (req, res) => {
  const {
    roll_number, admission_number,
    first_name, last_name, email, phone,
    class_label, section, grade,
    dob, gender, admission_date,
    parent_name, parent_phone, parent_email,
  } = req.body || {};

  if (!first_name || !String(first_name).trim()) {
    return res.status(400).json({ message: 'first_name is required' });
  }

  // Caller can optionally pass fk_tenant_id to assign the student to a sub-tenant
  // (e.g., a classroom). Default to the JWT tenant.
  const requestedTenant = req.body?.fk_tenant_id;
  const tenantId = requestedTenant || pickTenantForCreate(req);
  if (!tenantId) return res.status(400).json({ message: 'no tenant context' });

  // Verify the requested tenant is within the caller's subtree
  const tenantIds = await getScopedTenantIds(req);
  if (tenantIds !== null && !tenantIds.includes(tenantId)) {
    return res.status(403).json({ message: 'tenant not in your scope' });
  }

  // Confirm the tenant is education
  const { rows: vt } = await pool.query(
    `SELECT vertical FROM tenants WHERE pk_tenant_id = $1`,
    [tenantId]
  );
  if (!vt.length) return res.status(404).json({ message: 'tenant not found' });
  if (vt[0].vertical !== 'education') {
    return res.status(400).json({ message: 'students can only be created in an education tenant' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO edu_student (
          fk_tenant_id, roll_number, admission_number,
          first_name, last_name, email, phone,
          class_label, section, grade,
          dob, gender, admission_date,
          parent_name, parent_phone, parent_email
       ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
       )
       RETURNING *`,
      [
        tenantId,
        roll_number || null, admission_number || null,
        String(first_name).trim(), last_name || null, email || null, phone || null,
        class_label || null, section || null, grade || null,
        dob || null, gender || null, admission_date || null,
        parent_name || null, parent_phone || null, parent_email || null,
      ]
    );
    logger.info({ studentId: rows[0].pk_student_id, tenantId }, '[students] created');
    res.status(201).json({ student: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        message: 'duplicate roll_number or admission_number in this tenant',
        error: 'DUPLICATE',
      });
    }
    throw err;
  }
}));

/**
 * PUT /api/students/:id
 */
router.put('/:id', requireScope('students.profile.write'), asyncHandler(async (req, res) => {
  const tenantIds = await getScopedTenantIds(req);
  const existing = await getStudentInScope(req.params.id, tenantIds);
  if (!existing) return res.status(404).json({ message: 'student not found' });

  const editable = [
    'roll_number','admission_number','first_name','last_name','email','phone',
    'class_label','section','grade','dob','gender','admission_date',
    'parent_name','parent_phone','parent_email','photo_path','is_active',
  ];

  const sets = [];
  const params = [];
  for (const f of editable) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, f)) {
      params.push(req.body[f]);
      sets.push(`${f} = $${params.length}`);
    }
  }
  if (!sets.length) return res.json({ student: existing });
  params.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE edu_student SET ${sets.join(', ')}, updated_at = NOW()
      WHERE pk_student_id = $${params.length}
      RETURNING *`,
    params
  );
  res.json({ student: rows[0] });
}));

/**
 * POST /api/students/:id/face-embedding
 *
 * Body: {
 *   embedding:     number[512]   (required, pre-computed by the client)
 *   model_version: string?       (default 'arcface-r50-fp16')
 *   quality_score: number?       (0..1)
 *   is_primary:    boolean?      (default true if no other primary exists)
 *   angle:         'front'|'left'|'right'|'up'|'down'?
 *   photo_path:    string?       (optional reference to the captured image)
 * }
 *
 * When is_primary=true, any existing primary for the same student is demoted
 * inside a transaction so the unique-partial-index never conflicts.
 */
router.post('/:id/face-embedding', requireScope('students.profile.write'), asyncHandler(async (req, res) => {
  const tenantIds = await getScopedTenantIds(req);
  const student   = await getStudentInScope(req.params.id, tenantIds);
  if (!student) return res.status(404).json({ message: 'student not found' });

  const { embedding, model_version, quality_score, is_primary, angle, photo_path } = req.body || {};

  if (!Array.isArray(embedding) || embedding.length !== 512) {
    return res.status(400).json({ message: 'embedding must be a number[512]' });
  }
  for (const v of embedding) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return res.status(400).json({ message: 'embedding contains non-numeric values' });
    }
  }
  if (quality_score !== undefined && quality_score !== null) {
    if (typeof quality_score !== 'number' || quality_score < 0 || quality_score > 1) {
      return res.status(400).json({ message: 'quality_score must be a number between 0 and 1' });
    }
  }
  const allowedAngles = ['front','left','right','up','down'];
  if (angle && !allowedAngles.includes(angle)) {
    return res.status(400).json({ message: `angle must be one of: ${allowedAngles.join(', ')}` });
  }

  const enrolledBy = req.auth?.mt?.userId || null; // UUID in new users table
  const vectorLiteral = `[${embedding.join(',')}]`; // pgvector accepts text form

  // Decide primary flag: if caller didn't specify, default true only when this
  // is the student's first embedding.
  let makePrimary = is_primary;
  if (makePrimary === undefined) {
    const { rows: existing } = await pool.query(
      `SELECT 1 FROM edu_student_face_embedding WHERE fk_student_id = $1 LIMIT 1`,
      [req.params.id]
    );
    makePrimary = existing.length === 0;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (makePrimary) {
      await client.query(
        `UPDATE edu_student_face_embedding
            SET is_primary = false
          WHERE fk_student_id = $1 AND is_primary = true`,
        [req.params.id]
      );
    }

    const { rows } = await client.query(
      `INSERT INTO edu_student_face_embedding
          (fk_student_id, embedding, model_version, quality_score, is_primary, enrolled_by, angle, photo_path)
       VALUES ($1, $2::vector, $3, $4, $5, $6, $7, $8)
       RETURNING id, fk_student_id, model_version, quality_score, is_primary, angle, photo_path, enrolled_at`,
      [
        req.params.id,
        vectorLiteral,
        model_version || 'arcface-r50-fp16',
        quality_score ?? null,
        !!makePrimary,
        enrolledBy,
        angle || null,
        photo_path || null,
      ]
    );

    await client.query('COMMIT');
    logger.info({ studentId: req.params.id, primary: !!makePrimary }, '[students] face embedding enrolled');
    res.status(201).json({ embedding: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

/**
 * GET /api/students/:id/attendance
 * Returns the student's attendance rows, optionally filtered by date range.
 * Query params:
 *   ?from=YYYY-MM-DD   (default = 30 days ago)
 *   ?to=YYYY-MM-DD     (default = today)
 *   ?limit=<int>       (default = 100, max 365)
 */
router.get('/:id/attendance', requireScope('students.attendance.read'), asyncHandler(async (req, res) => {
  const tenantIds = await getScopedTenantIds(req);
  const student = await getStudentInScope(req.params.id, tenantIds);
  if (!student) return res.status(404).json({ message: 'student not found' });

  const from  = req.query.from  ? String(req.query.from)  : null;
  const to    = req.query.to    ? String(req.query.to)    : null;
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 365);

  const params = [req.params.id];
  const clauses = [`fk_student_id = $1`];
  if (from) { params.push(from); clauses.push(`attendance_date >= $${params.length}::date`); }
  if (to)   { params.push(to);   clauses.push(`attendance_date <= $${params.length}::date`); }
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT pk_attendance_id, attendance_date, status,
            check_in_at, check_out_at, marked_by_device,
            source, confidence, notes
       FROM student_attendance
      WHERE ${clauses.join(' AND ')}
      ORDER BY attendance_date DESC
      LIMIT $${params.length}`,
    params
  );

  // Aggregate summary (over the returned window)
  const summary = {
    days:    rows.length,
    present: rows.filter(r => r.status === 'present').length,
    late:    rows.filter(r => r.status === 'late').length,
    absent:  rows.filter(r => r.status === 'absent').length,
    excused: rows.filter(r => r.status === 'excused').length,
    half_day:rows.filter(r => r.status === 'half_day').length,
  };
  res.json({
    student: {
      pk_student_id: student.pk_student_id,
      first_name:    student.first_name,
      last_name:     student.last_name,
      roll_number:   student.roll_number,
      class_label:   student.class_label,
    },
    summary,
    records: rows,
  });
}));

/**
 * DELETE /api/students/:id — soft delete (sets deleted_at; CASCADE drops attendance/face)
 */
router.delete('/:id', requireScope('students.list.delete'), asyncHandler(async (req, res) => {
  const tenantIds = await getScopedTenantIds(req);
  const existing = await getStudentInScope(req.params.id, tenantIds);
  if (!existing) return res.status(404).json({ message: 'student not found' });
  await pool.query(
    `UPDATE edu_student SET deleted_at = NOW(), is_active = false WHERE pk_student_id = $1`,
    [req.params.id]
  );
  res.status(204).send();
}));

export default router;
