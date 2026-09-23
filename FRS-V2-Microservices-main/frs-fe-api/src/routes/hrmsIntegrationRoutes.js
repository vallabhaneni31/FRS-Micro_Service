import express from 'express';
import { requireAuth, requirePermission } from '../middleware/authz.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { pool } from '../db/pool.js';
import multer from 'multer';
import csv from 'csv-parser';
import { Readable } from 'stream';
import logger from '../utils/logger.js';
import { env } from '../config/env.js';
import { webhookEmployeeSchema, employeesSyncSchema } from '../validators/hrmsSchemas.js';

const router = express.Router();

// Helper to parse dates in different formats (e.g. DD-MM-YYYY, DD/MM/YYYY, YYYY/MM/DD) to standard ISO YYYY-MM-DD
function parseDateToISO(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (!s) return null;

  // YYYY-MM-DD (already standard)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s;
  }

  // DD-MM-YYYY or DD/MM/YYYY (e.g. 23-07-2026 or 23/07/2026)
  let match = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (match) {
    const day = match[1].padStart(2, '0');
    const month = match[2].padStart(2, '0');
    const year = match[3];
    return `${year}-${month}-${day}`;
  }

  // YYYY/MM/DD (e.g. 2026/07/23)
  match = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) {
    const year = match[1];
    const month = match[2].padStart(2, '0');
    const day = match[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // Fallback to standard JS Date parser
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return s; // Fallback to raw string so DB/Joi handles the error standard way if invalid
}

// Helper to resolve/create department
async function getOrCreateDepartment(client, deptName, tenantId) {
  if (!deptName) return null;
  const name = deptName.trim();
  const res = await client.query(
    'SELECT pk_department_id FROM hr_department WHERE LOWER(name) = LOWER($1) AND tenant_id = $2',
    [name, tenantId]
  );
  if (res.rows.length > 0) {
    return res.rows[0].pk_department_id;
  }
  // Generate a clean department code
  const code = ('DEPT_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '')).slice(0, 30);
  // Create a new department
  const ins = await client.query(
    'INSERT INTO hr_department (tenant_id, name, code) VALUES ($1, $2, $3) RETURNING pk_department_id',
    [tenantId, name, code]
  );
  return ins.rows[0].pk_department_id;
}

// Helper to validate site
async function validateSiteId(client, siteId, tenantId) {
  if (!siteId) return null;
  const res = await client.query(`
    SELECT s.pk_site_id, s.status, c.fk_tenant_id 
    FROM frs_site s
    JOIN frs_customer c ON s.fk_customer_id = c.pk_customer_id
    WHERE s.pk_site_id = $1
  `, [siteId]);

  if (res.rows.length === 0) {
    throw new Error(`Site ID ${siteId} does not exist`);
  }
  const site = res.rows[0];
  if (tenantId && site.fk_tenant_id !== tenantId) {
    throw new Error(`Site ID ${siteId} does not belong to your tenant`);
  }
  if (site.status === 'inactive') {
    throw new Error(`Cannot assign employee to an inactive site`);
  }
  return site.pk_site_id;
}

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv') {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

/**
 * POST /api/hrms/webhook/employee
 * Webhook receiver for HR system employee events
 * Expects: { event_type, employee_data }
 */
router.post('/webhook/employee', asyncHandler(async (req, res) => {
  const { event_type, employee_data, api_key } = req.body;

  // Validate API key (you should store this securely)
  const expectedApiKey = process.env.HRMS_WEBHOOK_API_KEY;
  if (!expectedApiKey) {
    throw new Error('HRMS_WEBHOOK_API_KEY environment variable is required');
  }
  if (api_key !== expectedApiKey) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  if (!event_type || !employee_data) {
    return res.status(400).json({ error: 'event_type and employee_data are required' });
  }

  // Auth passed and both fields are present — now validate their shape/types.
  // Kept after the api_key check (not as route-level middleware) so a wrong
  // key still reliably yields 401 rather than leaking a 400 to unauthenticated callers.
  const shapeCheck = webhookEmployeeSchema.safeParse({ event_type, employee_data, api_key });
  if (!shapeCheck.success) {
    return res.status(400).json({
      error: 'Invalid employee_data',
      details: shapeCheck.error.flatten().fieldErrors,
    });
  }

  const tenantId = employee_data.tenant_id || null;

  await pool.query('BEGIN');

  try {
    switch (event_type) {
      case 'employee.created':
      case 'employee.hired':
        await handleEmployeeCreated(employee_data, tenantId);
        break;
      
      case 'employee.updated':
        await handleEmployeeUpdated(employee_data, tenantId);
        break;
      
      case 'employee.terminated':
        await handleEmployeeTerminated(employee_data, tenantId);
        break;
      
      default:
        await pool.query('ROLLBACK');
        return res.status(400).json({ error: `Unknown event_type: ${event_type}` });
    }

    await pool.query('COMMIT');
    
    res.json({
      success: true,
      message: `Employee ${event_type} processed successfully`,
      employee_code: employee_data.employee_code
    });

  } catch (error) {
    await pool.query('ROLLBACK');
    logger.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Failed to process webhook', details: error.message });
  }
}));

/**
 * POST /api/hrms/employees/bulk-import
 * CSV bulk import for employee data
 */
router.post('/employees/bulk-import', requireAuth, requirePermission('employees.write'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'CSV file is required' });
  }

  const tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || null;
  const userId = req.auth?.user?.id;
  
  const employees = [];
  const errors = [];
  let lineNumber = 1;

  // Parse CSV
  const stream = Readable.from(req.file.buffer.toString());
  
  await new Promise((resolve, reject) => {
    stream
      .pipe(csv({
        mapHeaders: ({ header }) => header.trim().toLowerCase().replace(/^\ufeff/, '').replace(/\s+/g, '_')
      }))
      .on('data', (row) => {
        lineNumber++;
        try {
          // Validate required fields
          if (!row.employee_code || !row.first_name || !row.last_name) {
            errors.push({
              employee_code: row.employee_code || `Line ${lineNumber}`,
              error: `Missing required fields (employee_code, first_name, last_name)`
            });
            return;
          }

          employees.push({
            employee_code: row.employee_code.trim(),
            first_name: row.first_name.trim(),
            last_name: row.last_name.trim(),
            email: row.email?.trim() || null,
            phone: row.phone?.trim() || null,
            department: row.department?.trim() || null,
            designation: row.designation?.trim() || null,
            site_id: row.site_id ? parseInt(row.site_id) : null,
            status: row.status?.toLowerCase() || 'active',
            hire_date: parseDateToISO(row.hire_date)
          });
        } catch (err) {
          errors.push({
            employee_code: row.employee_code || `Line ${lineNumber}`,
            error: err.message
          });
        }
      })
      .on('end', resolve)
      .on('error', reject);
  });

  if (employees.length === 0 && errors.length === 0) {
    return res.status(400).json({ error: 'CSV file is empty or invalid format' });
  }

  // Insert employees
  await pool.query('BEGIN');
  const inserted = [];
  const updated = [];
  const failed = [];

  try {
    for (const emp of employees) {
      try {
        if (emp.site_id) {
          await validateSiteId(pool, emp.site_id, tenantId);
        }
        const deptId = await getOrCreateDepartment(pool, emp.department, tenantId);
        const fullName = `${emp.first_name} ${emp.last_name}`.trim();
        const joinDate = emp.hire_date || new Date().toISOString().slice(0, 10);
        const positionTitle = emp.designation || '';
        const sIds = emp.site_id ? [emp.site_id] : null;

        // Check if employee exists
        const existing = await pool.query(
          'SELECT pk_employee_id FROM hr_employee WHERE tenant_id = $1 AND employee_code = $2',
          [tenantId, emp.employee_code]
        );

        if (existing.rows.length > 0) {
          // Update existing
          await pool.query(`
            UPDATE hr_employee SET
              full_name = $1,
              email = $2,
              phone_number = $3,
              fk_department_id = $4,
              position_title = $5,
              status = $6,
              site_ids = COALESCE($7, site_ids)
            WHERE tenant_id = $8 AND employee_code = $9
          `, [fullName, emp.email, emp.phone, deptId, positionTitle, emp.status, sIds, tenantId, emp.employee_code]);
          
          updated.push(emp.employee_code);
        } else {
          // Insert new
          await pool.query(`
            INSERT INTO hr_employee (
              tenant_id, employee_code, full_name, email, phone_number,
              fk_department_id, position_title, status, join_date, site_ids
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `, [tenantId, emp.employee_code, fullName, emp.email, emp.phone, 
              deptId, positionTitle, emp.status, joinDate, sIds]);
          
          inserted.push(emp.employee_code);
        }
      } catch (err) {
        failed.push({ employee_code: emp.employee_code, error: err.message });
      }
    }

    await pool.query('COMMIT');

    const allFailed = [...failed, ...errors];

    res.json({
      success: true,
      summary: {
        total: employees.length + errors.length,
        inserted: inserted.length,
        updated: updated.length,
        failed: allFailed.length
      },
      inserted,
      updated,
      failed: allFailed,
      validation_errors: errors.map(e => e.error)
    });

  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}));

/**
 * POST /api/hrms/employees/sync
 * Programmatic employee sync API
 */
router.post('/employees/sync', requireAuth, requirePermission('employees.write'), asyncHandler(async (req, res) => {
  const { employees } = req.body;
  const tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || null;

  if (!Array.isArray(employees) || employees.length === 0) {
    return res.status(400).json({ error: 'employees array is required' });
  }

  const shapeCheck = employeesSyncSchema.safeParse({ employees });
  if (!shapeCheck.success) {
    return res.status(400).json({
      error: 'Invalid employees array',
      details: shapeCheck.error.flatten().fieldErrors,
    });
  }

  await pool.query('BEGIN');
  const results = { inserted: [], updated: [], failed: [] };

  try {
    for (const emp of employees) {
      if (!emp.employee_code || !emp.first_name || !emp.last_name) {
        results.failed.push({ 
          employee_code: emp.employee_code || 'unknown', 
          error: 'Missing required fields' 
        });
        continue;
      }

      try {
        if (emp.site_id) {
          await validateSiteId(pool, emp.site_id, tenantId);
        }
        const deptId = await getOrCreateDepartment(pool, emp.department, tenantId);
        const fullName = `${emp.first_name} ${emp.last_name}`.trim();
        const joinDate = parseDateToISO(emp.hire_date) || new Date().toISOString().slice(0, 10);
        const positionTitle = emp.designation || '';
        const sIds = emp.site_id ? [emp.site_id] : null;

        const existing = await pool.query(
          'SELECT pk_employee_id FROM hr_employee WHERE tenant_id = $1 AND employee_code = $2',
          [tenantId, emp.employee_code]
        );

        if (existing.rows.length > 0) {
          await pool.query(`
            UPDATE hr_employee SET
              full_name = $1, email = $2, phone_number = $3,
              fk_department_id = $4, position_title = $5, status = $6,
              site_ids = COALESCE($7, site_ids)
            WHERE tenant_id = $8 AND employee_code = $9
          `, [fullName, emp.email, emp.phone,
              deptId, positionTitle, emp.status || 'active',
              sIds,
              tenantId, emp.employee_code]);
          
          results.updated.push(emp.employee_code);
        } else {
          await pool.query(`
            INSERT INTO hr_employee (
              tenant_id, employee_code, full_name, email, phone_number,
              fk_department_id, position_title, status, join_date, site_ids
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `, [tenantId, emp.employee_code, fullName, emp.email, emp.phone,
              deptId, positionTitle, emp.status || 'active', joinDate, sIds]);
          
          results.inserted.push(emp.employee_code);
        }
      } catch (err) {
        results.failed.push({ employee_code: emp.employee_code, error: err.message });
      }
    }

    await pool.query('COMMIT');

    res.json({
      success: true,
      summary: {
        total: employees.length,
        inserted: results.inserted.length,
        updated: results.updated.length,
        failed: results.failed.length
      },
      ...results
    });

  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}));

/**
 * GET /api/hrms/enrollment-queue
 * Get employees pending face enrollment
 */
router.get('/enrollment-queue', requireAuth, requirePermission('employees.read'), asyncHandler(async (req, res) => {
  const tenantId = req.auth?.scope?.tenantId || req.headers['x-tenant-id'] || null;

  const result = await pool.query(`
    SELECT 
      e.pk_employee_id,
      e.employee_code,
      split_part(e.full_name, ' ', 1) as first_name,
      substr(e.full_name, strpos(e.full_name, ' ') + 1) as last_name,
      e.email,
      d.name as department,
      e.position_title as designation,
      e.join_date as hire_date,
      e.status,
      COUNT(ep.id) as photos_count,
      CASE WHEN COUNT(ep.id) >= 5 THEN true ELSE false END as enrollment_complete
    FROM hr_employee e
    LEFT JOIN employee_face_embeddings ep ON e.pk_employee_id = ep.employee_id
    LEFT JOIN hr_department d ON e.fk_department_id = d.pk_department_id
    WHERE e.tenant_id = $1 AND e.status = 'active'
    GROUP BY e.pk_employee_id, d.name
    HAVING COUNT(ep.id) < 5
    ORDER BY e.join_date DESC
  `, [tenantId]);

  res.json({
    success: true,
    pending_enrollment: result.rows.length,
    employees: result.rows
  });
}));

/**
 * GET /api/hrms/config
 * Get webhook URL and programmatic API key securely
 */
router.get('/config', requireAuth, requirePermission('employees.read'), asyncHandler(async (req, res) => {
  const webhookApiKey = env.hrmsWebhookApiKey;
  res.json({
    success: true,
    webhook_api_key: webhookApiKey
  });
}));

// Helper functions
async function handleEmployeeCreated(data, tenantId) {
  const { employee_code, first_name, last_name, email, phone, department, designation, hire_date } = data;
  const deptId = await getOrCreateDepartment(pool, department, tenantId);
  const fullName = `${first_name} ${last_name}`.trim();
  const joinDate = parseDateToISO(hire_date) || new Date().toISOString().slice(0, 10);
  const positionTitle = designation || '';

  await pool.query(`
    INSERT INTO hr_employee (
      tenant_id, employee_code, full_name, email, phone_number,
      fk_department_id, position_title, status, join_date
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
    ON CONFLICT (tenant_id, employee_code) DO NOTHING
  `, [tenantId, employee_code, fullName, email, phone, deptId, positionTitle, joinDate]);
}

async function handleEmployeeUpdated(data, tenantId) {
  const { employee_code, first_name, last_name, email, phone, department, designation } = data;
  const deptId = await getOrCreateDepartment(pool, department, tenantId);
  const fullName = `${first_name} ${last_name}`.trim();
  const positionTitle = designation || '';

  await pool.query(`
    UPDATE hr_employee SET
      full_name = $1, email = $2, phone_number = $3,
      fk_department_id = $4, position_title = $5
    WHERE tenant_id = $6 AND employee_code = $7
  `, [fullName, email, phone, deptId, positionTitle, tenantId, employee_code]);
}

async function handleEmployeeTerminated(data, tenantId) {
  const { employee_code } = data;

  await pool.query(`
    UPDATE hr_employee SET
      status = 'inactive'
    WHERE tenant_id = $1 AND employee_code = $2
  `, [tenantId, employee_code]);
}

export default router;
